// skinweights.js — TRUST THE WEIGHTS. Reads which bones ACTUALLY deform the mesh (vertex skin-
// weight mass per bone) and finds PARALLEL-TWIN bones: Rigify-class exports ship control/ORG/DEF
// copies of the same skeleton with their follow-constraints baked away, so the mesh blends a
// driven chain with a stranded one (the catgirl scissor-legs) or springs the same tail as three
// desynced chains. Names are deliberately ignored everywhere here (trust no names) — a twin is a
// twin because it sits at the SAME bind position pointing the SAME way, not because of "DEF-".
// Pure helpers, unit-tested in tests/skinweights.test.js; avatar.js wires them at model load
// (role-twin auto-adoption + spring twin dedup).
import * as THREE from "three";

// Total skin-weight mass per BONE → Map<Bone, number>. How much mesh each bone really moves;
// a bone absent from the map (or ~0) is a control/helper that deforms nothing.
export function computeWeightMass(model) {
  const mass = new Map();
  model.traverse((o) => {
    if (!o.isSkinnedMesh || !o.skeleton || !o.geometry) return;
    const idx = o.geometry.getAttribute("skinIndex"),
      w = o.geometry.getAttribute("skinWeight");
    if (!idx || !w || idx.count !== w.count) return;
    const bones = o.skeleton.bones;
    for (let i = 0; i < idx.count; i++) {
      for (let k = 0; k < 4; k++) {
        const wt = w.getComponent(i, k);
        if (wt <= 1e-4) continue;
        const b = bones[idx.getComponent(i, k)];
        if (b) mass.set(b, (mass.get(b) || 0) + wt);
      }
    }
  });
  return mass;
}

// A chain root's WHOLE influence: its own mass + every descendant bone's. Decides which of several
// coincident twin chains is "the real one" (the one the mesh listens to).
export function subtreeMass(root, mass) {
  let m = 0;
  root.traverse((o) => {
    if (o.isBone) m += mass.get(o) || 0;
  });
  return m;
}

const _pa = new THREE.Vector3(),
  _pb = new THREE.Vector3(),
  _da = new THREE.Vector3(),
  _db = new THREE.Vector3();
const _boneChild = (b) => {
  for (const c of b.children) if (c.isBone) return c;
  return null;
};

// Same anatomical joint in two parallel skeletons? Same bind HEAD position (within tol world
// units) AND same bone DIRECTION toward the first bone child (within ~14°). Leaf bones (no bone
// child on either side) fall back to position-only at half tolerance.
export function coincident(a, b, tol) {
  a.getWorldPosition(_pa);
  b.getWorldPosition(_pb);
  if (_pa.distanceTo(_pb) > tol) return false;
  const ca = _boneChild(a),
    cb = _boneChild(b);
  if (!ca || !cb) return _pa.distanceTo(_pb) <= tol * 0.5;
  ca.getWorldPosition(_da).sub(_pa);
  cb.getWorldPosition(_db).sub(_pb);
  if (_da.lengthSq() < 1e-10 || _db.lengthSq() < 1e-10) return true; // zero-length stubs: position already agreed
  return _da.normalize().dot(_db.normalize()) > 0.97;
}

// For each resolved ROLE bone, the DEFORMING bones that are coincident with it but live OUTSIDE
// its subtree (and aren't its ancestors) — stranded twins that must ride the driven chain.
// minMass keeps weightless control bones out (adopting those would be harmless but noisy).
export function findRoleTwins(roleBones, mass, modelHeight) {
  const out = [];
  const roles = Object.values(roleBones || {}).filter(Boolean);
  if (!roles.length) return out;
  const tol = Math.max(1e-4, (modelHeight || 2) * 0.03);
  let total = 0;
  for (const v of mass.values()) total += v;
  const minMass = Math.max(0.5, total * 5e-4);
  const related = (x, y) => {
    for (let p = x; p; p = p.parent) if (p === y) return true;
    for (let p = y; p; p = p.parent) if (p === x) return true;
    return false;
  };
  const root = roles[0]
    ? (() => {
        let r = roles[0];
        while (r.parent && r.parent.isBone) r = r.parent;
        return r;
      })()
    : null;
  const all = [];
  (root ? root.parent || root : null)?.traverse?.((o) => {
    if (o.isBone) all.push(o);
  });
  if (!all.length) for (const [b] of mass) all.push(b); // fallback: whatever the mass map saw
  for (const role in roleBones) {
    const R = roleBones[role];
    if (!R) continue;
    for (const B of all) {
      if (B === R || (mass.get(B) || 0) < minMass || related(B, R)) continue;
      if (coincident(R, B, tol)) out.push({ role, bone: R, twin: B });
    }
  }
  return out;
}

// Group coincident chain ROOTS (spring dedup): [[rootA, rootA2, ...], ...] — only groups of 2+
// are interesting (the same tail/ear sprung as several parallel chains).
export function groupCoincidentRoots(roots, modelHeight) {
  const tol = Math.max(1e-4, (modelHeight || 2) * 0.03);
  const groups = [];
  const taken = new Set();
  for (let i = 0; i < roots.length; i++) {
    if (taken.has(roots[i])) continue;
    const g = [roots[i]];
    for (let j = i + 1; j < roots.length; j++) {
      if (taken.has(roots[j])) continue;
      if (coincident(roots[i], roots[j], tol)) {
        g.push(roots[j]);
        taken.add(roots[j]);
      }
    }
    if (g.length > 1) groups.push(g);
  }
  return groups;
}
