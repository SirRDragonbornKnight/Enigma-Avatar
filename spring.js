// Spring-bone physics: dangly bones (hair, tail, ears, wires/cloth) AND soft-body
// bones (breast / butt / belly / genital jiggle) lag and sway from the body's motion
// instead of moving rigidly — so when the avatar is dragged, breathes, or emotes,
// those parts follow naturally. Verlet integration + pull-to-rest.
//
// Each sprung bone is tagged with a REGION (hair/tail/ear/breast/butt/genital/belly/
// cloth/wing/accessory/jiggle/other) so the UI can give each region its OWN weight —
// "how much it jiggles": 0 = pinned/rigid, 1 = default, >1 = bouncier (looser, longer
// wobble). NSFW rigs (e.g. Mal0: DEF-Breast / Butt / Pussy / AssHole / DE-Dick chains)
// are first-class regions so the user can tune or disable them per area.
//
// Detected by bone NAME first (the reliable path); a rig with only opaque names (a
// Sketchfab rip where every bone is "Bone037_016") falls back to a GEOMETRIC pass that
// springs the far-reaching dangly chains (tail / wings / fins).
import * as THREE from "three";
import { classifyBone, NSFW_REGIONS } from "./region.js";
import { regionFeel } from "./mathutil.js";   // pure weight→physics mapping (unit-tested)
export { classifyBone, NSFW_REGIONS } from "./region.js";   // re-export so existing importers keep working

// How much ambient BREEZE each region feels at rest (×P.breeze). Dangly stuff sways; soft-body /
// NSFW regions get 0 — wind-jiggled anatomy reads wrong; those move from body motion + weights only.
export const BREEZE_SCALE = { hair: 1, tail: 0.8, ear: 0.45, cloth: 1, wing: 0.8, accessory: 0.7, other: 0.6, breast: 0, butt: 0, genital: 0, dick: 0, anus: 0, belly: 0, jiggle: 0 };   // every NSFW_REGIONS entry MUST map to 0 (audit: dick/anus were split out of genital but missed here → ?? 0.6 fallback gave them wind); exported so the test can enforce that invariant

export function buildSpringBones(model, opts = {}) {
  // opts carries physics params (stiffness/drag/gravity/breeze), per-region weights, AND rig hooks:
  //   exclude     : Set<THREE.Bone> already claimed by a humanoid role — never spring these
  //   override    : the per-model rig_overrides entry; override.spring = { extra, never }
  //   regionWeight: { breast:1.5, cloth:0, ... } — per-region jiggle amount (0..~3)
  const { exclude = new Set(), override = null, regionWeight = {}, ...paramOpts } = opts;
  const P = { stiffness: 0.14, drag: 0.5, gravity: -3.0, breeze: 0, regionWeight: { ...regionWeight }, ...paramOpts };   // breeze defaults OFF (user ruling 2026-06-11: no idle animation — ambient wind is SELF-GENERATED motion; springs still react to real body movement). Per-model opt-in: saved spring profile / Settings breeze slider.
  if (!P.regionWeight) P.regionWeight = {};
  const springExtra = new Set(override?.spring?.extra || []);
  const springNever = new Set(override?.spring?.never || []);
  const items = [];
  const seen = new Set();
  model.updateWorldMatrix(true, true);

  const boneKids = (o) => o.children.filter((c) => c.isBone);
  function addItem(o, geo, region) {
    if (seen.has(o)) return;
    const child = boneKids(o)[0] || o.children[0];
    if (!child) return;
    const len = child.position.length();
    if (len < 1e-5) return;
    seen.add(o);
    items.push({
      bone: o, len, geo: !!geo, region: region || "other", phase: items.length * 0.9,
      restDir: child.position.clone().normalize(),    // bone-local rest direction toward child
      restQuat: o.quaternion.clone(),                 // bone-local rest rotation
      tip: o.localToWorld(child.position.clone()),     // child world position
      prev: o.localToWorld(child.position.clone()),
    });
  }

  // 1) name-based — the reliable path. Skip any bone a humanoid role already claimed
  //    (exclude) or the override opted out (never); force-spring any bone in `extra`.
  model.traverse((o) => {
    if (!o.isBone || exclude.has(o) || springNever.has(o.name)) return;
    const region = classifyBone(o.name);
    if (region) addItem(o, false, region);
    else if (springExtra.has(o.name)) addItem(o, false, "other");
  });

  // 2) geometric fallback — ONLY when names matched nothing AND no humanoid roles were
  //    resolved (exclude empty). An opaque non-humanoid (Toothless: tail+wings) still gets
  //    its dangly chains; a role-matched humanoid never gets its limbs limp-ified.
  if (items.length === 0 && exclude.size === 0) {
    const size = new THREE.Vector3(); new THREE.Box3().setFromObject(model).getSize(size);
    const a = new THREE.Vector3(), z = new THREE.Vector3();
    const cands = [];
    model.traverse((leaf) => {
      if (!leaf.isBone || boneKids(leaf).length) return;          // start only at leaves
      const chain = [leaf];
      let cur = leaf;
      while (cur.parent?.isBone && boneKids(cur.parent).length === 1) { chain.unshift(cur.parent); cur = cur.parent; }
      if (chain.length < 3) return;                               // need ≥3 links to sway nicely
      chain[0].getWorldPosition(a); leaf.getWorldPosition(z);
      cands.push({ chain, reach: a.distanceTo(z) });
    });
    const maxReach = cands.reduce((m, c) => Math.max(m, c.reach), 0);
    const floor = Math.max(maxReach * 0.4, size.length() * 0.04);
    let chains = 0;
    for (const c of cands) if (c.reach >= floor) { chains++; for (const b of c.chain) if (boneKids(b).length === 1) addItem(b, true, classifyBone(b.name) || "other"); }
    if (items.length) console.log(`[avatar] spring: opaque rig — geometric fallback on ${items.length} bones across ${chains} chains`);
  }

  const origin = new THREE.Vector3(), restTip = new THREE.Vector3(), inertia = new THREE.Vector3(), d = new THREE.Vector3();
  const pq = new THREE.Quaternion(), pqi = new THREE.Quaternion(), R = new THREE.Quaternion(), restRot = new THREE.Quaternion();
  const restWDir = new THREE.Vector3(), wantWDir = new THREE.Vector3();
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // Active fidget IMPULSES — the idle (or the AI) KICKS a region's tips (tail swish, ear flick, wing
  // ruffle) and the verlet spring swings + settles naturally. Works WITH the physics instead of
  // fighting it (writing quaternions here would be overwritten next update). World-space kick, smooth
  // sine envelope over `dur`. Returns false if the model has no such region (caller can try another).
  const _impulses = [];
  function impulse(region, v = {}, dur = 0.4) {
    if (!items.some((it) => it.region === region)) return false;
    const w = (region in P.regionWeight) ? P.regionWeight[region] : (P.regionWeight._all ?? 1);
    if (!(w > 0.001)) return false;               // region pinned rigid by the user → a kick would land invisibly; return false so the fidget scheduler tries another appendage
    _impulses.push({ region, x: +v.x || 0, y: +v.y || 0, z: +v.z || 0, t: 0, dur: Math.max(0.05, +dur || 0.4) });
    return true;
  }

  let t = 0;
  function update(dt) {
    t += dt;
    for (let i = _impulses.length - 1; i >= 0; i--) { const im = _impulses[i]; im.t += dt; if (im.t >= im.dur) _impulses.splice(i, 1); }   // advance once per frame, not per bone
    for (const it of items) {
      const b = it.bone;
      // per-region weight = how much this part jiggles. Default 1; _all is a global multiplier.
      const w = (it.region in P.regionWeight) ? P.regionWeight[it.region] : (P.regionWeight._all ?? 1);
      b.parent.getWorldQuaternion(pq);
      b.getWorldPosition(origin);
      restRot.copy(pq).multiply(it.restQuat);                          // bone's world rotation at rest
      restWDir.copy(it.restDir).applyQuaternion(restRot).normalize();   // rest direction in world
      restTip.copy(restWDir).multiplyScalar(it.len).add(origin);        // where the tip rests
      const feel = regionFeel(w, P.stiffness, P.drag, it.geo);          // weight → physics knobs (pure; unit-tested)
      if (feel.pin) {                                                    // pinned: this region's jiggle is off
        it.tip.copy(restTip); it.prev.copy(restTip);
        b.quaternion.copy(it.restQuat); b.updateWorldMatrix(false, false);
        continue;
      }
      const grav = (it.geo ? 0.08 : 1) * P.gravity * dt * dt;            // geo chains barely fall (wings shouldn't sag)
      const stiff = feel.stiff, dragv = feel.dragv;
      // verlet: keep momentum, add gravity, pull back toward rest
      inertia.copy(it.tip).sub(it.prev).multiplyScalar(1 - dragv);
      it.prev.copy(it.tip);
      it.tip.add(inertia);
      it.tip.y += grav;
      // Ambient breeze — ALL dangly chains sway gently at rest, not just geometric-fallback ones (the
      // sprung hair/tail/ears used to sit DEAD when the body was still — the single biggest "statue"
      // tell). Per-region scale; NSFW/soft-body regions get NO wind (they move from body motion only).
      const bz = it.geo ? 1 : (BREEZE_SCALE[it.region] ?? 0.6);
      if (P.breeze && bz) {
        it.tip.x += Math.sin(t * 0.9 + it.phase) * P.breeze * bz * dt;
        it.tip.z += Math.cos(t * 0.7 + it.phase * 1.3) * P.breeze * bz * dt;
      }
      for (const im of _impulses) if (im.region === it.region) {            // fidget kick — smooth envelope, slight per-bone phase so a tail whips, not shifts
        const e = Math.sin(Math.PI * Math.min(1, im.t / im.dur)) * (0.75 + 0.25 * Math.sin(it.phase));
        it.tip.x += im.x * e * dt; it.tip.y += im.y * e * dt; it.tip.z += im.z * e * dt;
      }
      it.tip.addScaledVector(d.copy(restTip).sub(it.tip), stiff);
      // constrain to bone length
      d.copy(it.tip).sub(origin);
      if (d.lengthSq() < 1e-9) d.copy(restWDir).multiplyScalar(it.len);
      it.tip.copy(d.setLength(it.len)).add(origin);
      // w<1 → damp amplitude toward rest (less jiggle) and re-pin to bone length
      if (feel.damp > 0) { it.tip.lerp(restTip, feel.damp); it.tip.copy(d.copy(it.tip).sub(origin).setLength(it.len)).add(origin); }
      // orient the bone so it points origin -> tip
      wantWDir.copy(it.tip).sub(origin).normalize();
      R.setFromUnitVectors(restWDir, wantWDir);
      pqi.copy(pq).invert();
      b.quaternion.copy(pqi).multiply(R).multiply(pq).multiply(it.restQuat);
      if (Number.isNaN(b.quaternion.x)) { b.quaternion.copy(it.restQuat); it.tip.copy(restTip); it.prev.copy(restTip); }  // safety — reset the verlet state too, else inertia=tip−prev stays NaN and the bone is dead forever
      b.updateWorldMatrix(false, false);                                 // chain: children see the update
    }
  }

  // Regions actually present, with a representative bone count + the live weight — the UI builds
  // its per-region sliders from THIS (so it only shows sliders for parts the model really has).
  function regions() {
    const m = new Map();
    for (const it of items) m.set(it.region, (m.get(it.region) || 0) + 1);
    return [...m].map(([region, count]) => ({
      region, count,
      weight: (region in P.regionWeight) ? P.regionWeight[region] : 1,
      nsfw: NSFW_REGIONS.has(region),
    }));
  }
  function setRegionWeight(region, w) {
    const v = clamp(+w || 0, 0, 2);   // 0..2 matches the Settings slider range (0=rigid, 1=default, 2=bouncy)
    P.regionWeight[region] = v;
    return v;
  }

  return {
    count: items.length,
    names: items.map((i) => i.bone.name),
    update,
    setParams: (p) => { if (p && p.regionWeight) { Object.assign(P.regionWeight, p.regionWeight); const { regionWeight, ...rest } = p; Object.assign(P, rest); } else Object.assign(P, p); },   // merge regionWeight (a saved spring blob must never REPLACE the per-region map)
    regions, setRegionWeight,
    setRegionWeights: (map) => { for (const k in (map || {})) P.regionWeight[k] = clamp(+map[k] || 0, 0, 2); },
    impulse,                                          // fidget kick (idle scheduler + AI bus 'impulse' action)
  };
}
