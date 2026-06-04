// Spring-bone physics: dangly bones (hair, tail, ears, wires/cables, cloth) lag
// and sway from the body's motion instead of moving rigidly — so when the avatar
// is dragged, breathes, or emotes, the hair/tail/wires follow naturally.
// Detected by bone NAME first; if a rig has only opaque names (e.g. a Sketchfab
// rip where every bone is "Bone037_016"), a geometric fallback springs the
// far-reaching dangly chains (tail / wings / fins) instead. Verlet integration +
// stiffness pull-to-rest.
import * as THREE from "three";

// NOTE the guards: `fin(?!ger)` so "Finger" bones aren't sprung (floppy hands),
// and `(?<!for)ear` so "forEARm" bones aren't sprung. Both bite real rigs (Mal0
// has 28 finger bones; many humanoids name the lower arm "forearm").
const SPRING_RE = /hair|tail|(?<!for)ear|skirt|cloth|ribbon|rope|chain|wire|cable|whisker|cape|scarf|fluff|frill|antenna|fin(?!ger)|string|tassel|braid/i;

export function buildSpringBones(model, opts = {}) {
  const P = { stiffness: 0.14, drag: 0.5, gravity: -3.0, breeze: 0.16, ...opts };
  const items = [];
  const seen = new Set();
  model.updateWorldMatrix(true, true);

  const boneKids = (o) => o.children.filter((c) => c.isBone);
  function addItem(o, geo) {
    if (seen.has(o)) return;
    const child = boneKids(o)[0] || o.children[0];
    if (!child) return;
    const len = child.position.length();
    if (len < 1e-5) return;
    seen.add(o);
    items.push({
      bone: o, len, geo: !!geo, phase: items.length * 0.9,   // per-bone offset so a breeze doesn't move them in lockstep
      restDir: child.position.clone().normalize(),    // bone-local rest direction toward child
      restQuat: o.quaternion.clone(),                 // bone-local rest rotation
      tip: o.localToWorld(child.position.clone()),     // child world position
      prev: o.localToWorld(child.position.clone()),
    });
  }

  // 1) name-based — the reliable path (hair / tail / ears / wires / cloth …).
  model.traverse((o) => { if (o.isBone && SPRING_RE.test(o.name)) addItem(o, false); });

  // 2) geometric fallback — ONLY when names matched nothing, so it never
  //    limp-ifies a humanoid whose limbs were correctly role-matched (those
  //    rigs always yield named springs). Walks each leaf bone up its chain
  //    while the parent has exactly one bone-child; a long, far-reaching chain
  //    is a tail/wing/fin → spring its links (gentle: low gravity, stiffer
  //    pull-to-rest, so at idle it sits at its modelled pose and only sways
  //    when the body moves — no drooping).
  if (items.length === 0) {
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
    // Keep the far-reaching chains (tail / wings / fins), drop the stubby ones
    // (toes / fingers). Threshold is relative to the model's OWN longest chain,
    // so it's scale-free — a dragon's tail reaches ~2 while its toes reach ~0.3,
    // and any model has the same proportional gap.
    const maxReach = cands.reduce((m, c) => Math.max(m, c.reach), 0);
    const floor = Math.max(maxReach * 0.4, size.length() * 0.04);
    let chains = 0;
    for (const c of cands) if (c.reach >= floor) { chains++; for (const b of c.chain) if (boneKids(b).length === 1) addItem(b, true); }
    if (items.length) console.log(`[avatar] spring: opaque rig — geometric fallback on ${items.length} bones across ${chains} chains`);
  }

  const origin = new THREE.Vector3(), restTip = new THREE.Vector3(), inertia = new THREE.Vector3(), d = new THREE.Vector3();
  const pq = new THREE.Quaternion(), pqi = new THREE.Quaternion(), R = new THREE.Quaternion(), restRot = new THREE.Quaternion();
  const restWDir = new THREE.Vector3(), wantWDir = new THREE.Vector3();

  let t = 0;
  function update(dt) {
    t += dt;
    for (const it of items) {
      const b = it.bone;
      const grav = (it.geo ? 0.08 : 1) * P.gravity * dt * dt;     // geo chains barely fall (wings shouldn't sag)
      const stiff = (it.geo ? 1.5 : 1) * P.stiffness;             // …and return to rest faster
      b.parent.getWorldQuaternion(pq);
      b.getWorldPosition(origin);
      restRot.copy(pq).multiply(it.restQuat);                          // bone's world rotation at rest
      restWDir.copy(it.restDir).applyQuaternion(restRot).normalize();   // rest direction in world
      restTip.copy(restWDir).multiplyScalar(it.len).add(origin);        // where the tip rests
      // verlet: keep momentum, add gravity, pull back toward rest
      inertia.copy(it.tip).sub(it.prev).multiplyScalar(1 - P.drag);
      it.prev.copy(it.tip);
      it.tip.add(inertia);
      it.tip.y += grav;
      // geo chains (opaque rigs with no procedural idle) get a gentle ambient
      // breeze so a floating companion's tail/wings drift instead of sitting dead.
      if (it.geo && P.breeze) { it.tip.x += Math.sin(t * 0.9 + it.phase) * P.breeze * dt; it.tip.z += Math.cos(t * 0.7 + it.phase * 1.3) * P.breeze * dt; }
      it.tip.addScaledVector(d.copy(restTip).sub(it.tip), stiff);
      // constrain to bone length
      d.copy(it.tip).sub(origin);
      if (d.lengthSq() < 1e-9) d.copy(restWDir).multiplyScalar(it.len);
      it.tip.copy(d.setLength(it.len)).add(origin);
      // orient the bone so it points origin -> tip
      wantWDir.copy(it.tip).sub(origin).normalize();
      R.setFromUnitVectors(restWDir, wantWDir);
      pqi.copy(pq).invert();
      b.quaternion.copy(pqi).multiply(R).multiply(pq).multiply(it.restQuat);
      if (Number.isNaN(b.quaternion.x)) b.quaternion.copy(it.restQuat);  // safety
      b.updateWorldMatrix(false, false);                                 // chain: children see the update
    }
  }
  return { count: items.length, names: items.map((i) => i.bone.name), update, setParams: (p) => Object.assign(P, p) };
}
