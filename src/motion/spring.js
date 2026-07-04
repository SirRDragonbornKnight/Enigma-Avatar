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
import { classifyBone, NSFW_REGIONS } from "../rig/region.js";
import { regionFeel } from "../util/mathutil.js"; // pure weight→physics mapping (unit-tested)
export { classifyBone, NSFW_REGIONS } from "../rig/region.js"; // re-export so existing importers keep working

// (The ambient BREEZE — wind-at-rest swaying every dangly chain — was DELETED with the whole idle
// system, user order 2026-06-12: it was SELF-GENERATED motion. Springs react to real movement only.)

export function buildSpringBones(model, opts = {}) {
  // opts carries physics params (stiffness/drag/gravity), per-region weights, AND rig hooks:
  //   exclude     : Set<THREE.Bone> already claimed by a humanoid role — never spring these
  //   neverExtra  : bone NAMES to skip — the skin-weight twin-dedup exclusions (a coincident
  //                 non-deforming chain twin rides the deforming one instead of double-springing)
  //   regionWeight: { breast:1.5, cloth:0, ... } — per-region jiggle amount (0..~3)
  const { exclude = new Set(), regionWeight = {}, neverExtra = null, ...paramOpts } = opts;
  const P = { stiffness: 0.14, drag: 0.5, gravity: -3.0, regionWeight: { ...regionWeight }, ...paramOpts };
  if (!P.regionWeight) P.regionWeight = {};
  // The scalar knobs may arrive from a saved/hand-edited blob (via paramOpts here, or setParams later).
  // Clamp them to STABLE ranges: a too-stiff pull-to-rest overshoots and DIVERGES, and the per-bone NaN
  // reset only catches a full blow-up, not the visible jitter just below it. Non-finite -> safe default.
  // [lo, hi, default]; drag is re-clamped downstream in regionFeel too, this guards the input itself.
  const PLIM = { stiffness: [0, 1, 0.14], drag: [0, 1, 0.5], gravity: [-50, 50, -3.0] };
  const clampParams = () => {
    for (const k in PLIM) {
      const [lo, hi, def] = PLIM[k];
      const v = +P[k];
      P[k] = isFinite(v) ? (v < lo ? lo : v > hi ? hi : v) : def;
    }
    // regionWeight too: a saved/hand-edited profile blob reaches HERE (the constructor spread) without
    // passing through setParams, so clamp every per-region weight to the 0..2 slider range (non-finite -> 1).
    for (const k in P.regionWeight) {
      const w = +P.regionWeight[k];
      P.regionWeight[k] = isFinite(w) ? (w < 0 ? 0 : w > 2 ? 2 : w) : 1;
    }
  };
  clampParams();
  const springNever = new Set(neverExtra || []);
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
      bone: o,
      len,
      geo: !!geo,
      region: region || "other",
      phase: items.length * 0.9,
      restDir: child.position.clone().normalize(), // bone-local rest direction toward child
      restQuat: o.quaternion.clone(), // bone-local rest rotation
      tip: o.localToWorld(child.position.clone()), // child world position
      prev: o.localToWorld(child.position.clone()),
      originPrev: o.getWorldPosition(new THREE.Vector3()), // bone origin last frame — gravity only acts when it MOVES (no sag at rest)
    });
  }

  // 1) name-based — the reliable path. Skip any bone a humanoid role already claimed
  //    (exclude) or the twin-dedup opted out (neverExtra).
  model.traverse((o) => {
    if (!o.isBone || exclude.has(o) || springNever.has(o.name)) return;
    const region = classifyBone(o.name);
    if (region) addItem(o, false, region);
  });

  // 2) geometric fallback — ONLY when names matched nothing AND no humanoid roles were
  //    resolved (exclude empty). An opaque non-humanoid (Toothless: tail+wings) still gets
  //    its dangly chains; a role-matched humanoid never gets its limbs limp-ified.
  if (items.length === 0 && exclude.size === 0) {
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(model).getSize(size);
    const a = new THREE.Vector3(),
      z = new THREE.Vector3();
    const cands = [];
    model.traverse((leaf) => {
      if (!leaf.isBone || boneKids(leaf).length) return; // start only at leaves
      const chain = [leaf];
      let cur = leaf;
      while (cur.parent?.isBone && boneKids(cur.parent).length === 1) {
        chain.unshift(cur.parent);
        cur = cur.parent;
      }
      if (chain.length < 3) return; // need ≥3 links to sway nicely
      chain[0].getWorldPosition(a);
      leaf.getWorldPosition(z);
      cands.push({ chain, reach: a.distanceTo(z) });
    });
    const maxReach = cands.reduce((m, c) => Math.max(m, c.reach), 0);
    const floor = Math.max(maxReach * 0.4, size.length() * 0.04);
    let chains = 0;
    for (const c of cands)
      if (c.reach >= floor) {
        chains++;
        for (const b of c.chain) if (boneKids(b).length === 1) addItem(b, true, classifyBone(b.name) || "other");
      }
    if (items.length)
      console.log(`[avatar] spring: opaque rig — geometric fallback on ${items.length} bones across ${chains} chains`);
  }

  const origin = new THREE.Vector3(),
    restTip = new THREE.Vector3(),
    inertia = new THREE.Vector3(),
    d = new THREE.Vector3();
  const pq = new THREE.Quaternion(),
    pqi = new THREE.Quaternion(),
    R = new THREE.Quaternion(),
    restRot = new THREE.Quaternion();
  const restWDir = new THREE.Vector3(),
    wantWDir = new THREE.Vector3();
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // Commanded IMPULSES — the AI (bus 'impulse') KICKS a region's tips (tail swish, ear flick, wing
  // ruffle) and the verlet spring swings + settles naturally. Works WITH the physics instead of
  // fighting it (writing quaternions here would be overwritten next update). World-space kick, smooth
  // sine envelope over `dur`. Returns false if the model has no such region (caller can try another).
  const _impulses = [];
  function impulse(region, v = {}, dur = 0.4) {
    if (!items.some((it) => it.region === region)) return false;
    const w = region in P.regionWeight ? P.regionWeight[region] : (P.regionWeight._all ?? 1);
    if (!(w > 0.001)) return false; // region pinned rigid by the user → a kick would land invisibly; return false so the fidget scheduler tries another appendage
    // finiteness guard at the engine boundary: `+v.x || 0` let ±Infinity through (NaN tip after
    // setLength), and an Infinity dur made an immortal zombie impulse iterated every frame
    const fin = (n) => (Number.isFinite(+n) ? +n : 0);
    _impulses.push({
      region,
      x: fin(v.x),
      y: fin(v.y),
      z: fin(v.z),
      t: 0,
      dur: Math.max(0.05, Math.min(30, Number.isFinite(+dur) ? +dur : 0.4)),
    });
    return true;
  }

  // Frame-rate independence: the verlet's per-frame fractions (drag decay, stiffness pull, damp) and
  // the inertia carry were all tuned at REF_FPS. Each frame we re-scale them to the REAL dt so the sway
  // and settle feel the SAME at 30 / 60 / 144 fps. At exactly REF_FPS this is identity — nothing changes
  // (which is why every fixed-1/60 unit test still holds). Gravity is already dt*dt-scaled above.
  const REF_FPS = 60;
  let _prevDt = 1 / REF_FPS; // last frame's dt → time-corrected verlet inertia carry under variable dt

  function update(dt) {
    const kFrame = dt * REF_FPS; // exponent that maps a per-REF_FPS-frame fraction onto this real frame
    const tcv = clamp(_prevDt > 1e-4 ? dt / _prevDt : 1, 0, 4); // inertia time-correction (variable-dt verlet)
    for (let i = _impulses.length - 1; i >= 0; i--) {
      const im = _impulses[i];
      im.t += dt;
      if (im.t >= im.dur) _impulses.splice(i, 1);
    } // advance once per frame, not per bone
    for (const it of items) {
      const b = it.bone;
      // per-region weight = how much this part jiggles. Default 1; _all is a global multiplier.
      const w = it.region in P.regionWeight ? P.regionWeight[it.region] : (P.regionWeight._all ?? 1);
      b.parent.getWorldQuaternion(pq);
      b.getWorldPosition(origin);
      restRot.copy(pq).multiply(it.restQuat); // bone's world rotation at rest
      restWDir.copy(it.restDir).applyQuaternion(restRot).normalize(); // rest direction in world
      restTip.copy(restWDir).multiplyScalar(it.len).add(origin); // where the tip rests
      const feel = regionFeel(w, P.stiffness, P.drag, it.geo); // weight → physics knobs (pure; unit-tested)
      if (feel.pin) {
        // pinned: this region's jiggle is off
        it.tip.copy(restTip);
        it.prev.copy(restTip);
        b.quaternion.copy(it.restQuat);
        b.updateWorldMatrix(false, false);
        continue;
      }
      // Gravity acts ONLY when the bone's ORIGIN actually moved this frame (reactive sag/sway). A
      // motionless body settles ZERO gravity → no self-generated sag below bind pose (esp. on geo chains).
      const moved = origin.distanceToSquared(it.originPrev) > 1e-12;
      it.originPrev.copy(origin);
      const grav = moved ? (it.geo ? 0.08 : 1) * P.gravity * dt * dt : 0; // geo chains barely fall (wings shouldn't sag)
      // Per-frame fractions re-scaled to real dt (identity at REF_FPS): drag decays exponentially and the
      // stiffness pull likewise; the inertia carry is time-corrected by dt/prevDt so momentum is dt-stable.
      const stiffFrac = 1 - Math.pow(1 - feel.stiff, kFrame);
      const dragDecay = Math.pow(1 - feel.dragv, kFrame);
      // verlet: keep momentum (time-corrected + damped), add gravity, pull back toward rest
      inertia
        .copy(it.tip)
        .sub(it.prev)
        .multiplyScalar(tcv * dragDecay);
      it.prev.copy(it.tip);
      it.tip.add(inertia);
      it.tip.y += grav;
      for (const im of _impulses)
        if (im.region === it.region) {
          // commanded kick (AI bus 'impulse') — smooth envelope, slight per-bone phase so a tail whips, not shifts
          const e = Math.sin(Math.PI * Math.min(1, im.t / im.dur)) * (0.75 + 0.25 * Math.sin(it.phase));
          it.tip.x += im.x * e * dt;
          it.tip.y += im.y * e * dt;
          it.tip.z += im.z * e * dt;
        }
      it.tip.addScaledVector(d.copy(restTip).sub(it.tip), stiffFrac);
      // constrain to bone length
      d.copy(it.tip).sub(origin);
      if (d.lengthSq() < 1e-9) d.copy(restWDir).multiplyScalar(it.len);
      it.tip.copy(d.setLength(it.len)).add(origin);
      // w<1 → damp amplitude toward rest (less jiggle) and re-pin to bone length
      if (feel.damp > 0) {
        it.tip.lerp(restTip, 1 - Math.pow(1 - feel.damp, kFrame)); // dt-normalized amplitude damp (identity at REF_FPS)
        it.tip.copy(d.copy(it.tip).sub(origin).setLength(it.len)).add(origin);
      }
      // orient the bone so it points origin -> tip
      wantWDir.copy(it.tip).sub(origin).normalize();
      R.setFromUnitVectors(restWDir, wantWDir);
      pqi.copy(pq).invert();
      b.quaternion.copy(pqi).multiply(R).multiply(pq).multiply(it.restQuat);
      if (Number.isNaN(b.quaternion.x)) {
        b.quaternion.copy(it.restQuat);
        it.tip.copy(restTip);
        it.prev.copy(restTip);
      } // safety — reset the verlet state too, else inertia=tip−prev stays NaN and the bone is dead forever
      b.updateWorldMatrix(false, false); // chain: children see the update
    }
    _prevDt = dt; // remember this frame's dt for the next frame's inertia time-correction
  }

  // Regions actually present, with a representative bone count + the live weight — the UI builds
  // its per-region sliders from THIS (so it only shows sliders for parts the model really has).
  function regions() {
    const m = new Map();
    for (const it of items) m.set(it.region, (m.get(it.region) || 0) + 1);
    return [...m].map(([region, count]) => ({
      region,
      count,
      weight: region in P.regionWeight ? P.regionWeight[region] : 1,
      nsfw: NSFW_REGIONS.has(region),
    }));
  }
  function setRegionWeight(region, w) {
    const v = clamp(+w || 0, 0, 2); // 0..2 matches the Settings slider range (0=rigid, 1=default, 2=bouncy)
    P.regionWeight[region] = v;
    return v;
  }

  return {
    count: items.length,
    names: items.map((i) => i.bone.name),
    update,
    setParams: (p) => {
      if (!p) return;
      const { regionWeight, ...rest } = p;
      if (regionWeight)
        for (const k in regionWeight) {
          const w = +regionWeight[k];
          if (isFinite(w)) P.regionWeight[k] = w < 0 ? 0 : w > 2 ? 2 : w;
        }
      Object.assign(P, rest);
      clampParams();
    }, // merge, then CLAMP: region weights to the 0..2 slider range (never REPLACE the per-region map) AND the scalar knobs to stable ranges, so a saved/hand-edited blob can't bypass the sliders and drive a verlet instability
    regions,
    setRegionWeight,
    impulse, // commanded kick (AI bus 'impulse' action)
  };
}
