// geom_mouth.js — find the mouth-open morph by GEOMETRY, never by name.
//
// Many rips ship dozens of UNNAMED morph targets (51dc: 76), so facial.js's name-based
// mouth picker finds nothing and lip-sync silently dies. The GENERAL fix (no per-model
// config, no asset editing): detect the mouth structurally — it's the morph that drops
// HEAD-region vertices DOWNWARD in world space (a jaw opening). Runs once at load on the
// live three.js geometry (which is already world-upright + skin-resolved, unlike the raw
// glTF). A wrong pick is a one-line `rig_overrides.json` face.mouthMorph correction —
// same philosophy as the bone cascade: identify by structure, allow an override.
//
// Returns { index, score, morphs } (drive that morph index from speech amplitude) or null
// when there's no confident jaw-drop signal (so it never forces a random morph).
import * as THREE from "three";

export function detectMouthMorph(model) {
  if (!model) return null;
  model.updateWorldMatrix(true, true);

  const meshes = [];
  model.traverse((o) => {
    if (o.isMesh && o.morphTargetInfluences?.length && o.geometry?.morphAttributes?.position?.length) meshes.push(o);
  });
  if (!meshes.length) return null;

  // Head region = top 35% of the model's WORLD bounding box (world is Y-up in three.js,
  // even if the source asset was Z-up — the loader/node hierarchy already rotated it).
  const box = new THREE.Box3().setFromObject(model);
  const H = Math.max(1e-6, box.max.y - box.min.y);
  const headCut = box.max.y - 0.35 * H;

  const _v = new THREE.Vector3();
  const _lin = new THREE.Matrix3();                 // upper-3x3 of matrixWorld → world-space delta direction
  const nMorph = Math.max(...meshes.map((m) => m.morphTargetInfluences.length));
  const allScores = [];                             // every (mesh,morph) downscore — for the noise gate
  let best = null, bestS = 0;                       // best = { mesh, index } — drive ONLY this mesh's morph (index i differs per mesh)

  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    const targets = mesh.geometry.morphAttributes.position;
    if (!pos || !targets) continue;
    _lin.setFromMatrix4(mesh.matrixWorld);          // NOT the normal matrix — deltas are displacements
    const N = pos.count, stride = Math.max(1, Math.floor(N / 1500));   // sample for perf (load-time, one-shot)
    for (let mi = 0; mi < targets.length; mi++) {
      const d = targets[mi]; if (!d) continue;
      let down = 0;
      for (let v = 0; v < N; v += stride) {
        _v.fromBufferAttribute(pos, v).applyMatrix4(mesh.matrixWorld);   // world rest position
        if (_v.y < headCut) continue;                                    // head only
        _v.fromBufferAttribute(d, v).applyMatrix3(_lin);                 // world-space displacement
        if (_v.y < 0) down += -_v.y;                                     // downward → jaw drop
      }
      allScores.push(down);
      if (down > bestS) { bestS = down; best = { mesh, index: mi }; }
    }
  }

  // Reject NOISE: the winner (plus any identical DUPLICATE clones — 51dc has 3) should stand
  // out as a FEW near-equal scores, not "everything moves about the same". A median gate
  // false-rejects on low-morph-count models, so count how many scores are within 50% of the
  // best instead — robust whether there are 2 morphs or 200.
  const near = allScores.filter((s) => s >= bestS * 0.5).length;
  if (!best || bestS < 1e-4 || near > Math.max(3, nMorph * 0.25)) {
    if (best) console.log(`[avatar] geom mouth: no confident jaw-drop (best=${bestS.toFixed(3)}, ${near} near-equal of ${allScores.length}) → none`);
    return null;
  }
  console.log(`[avatar] geom mouth: morph #${best.index} on one mesh (downscore ${bestS.toFixed(3)}, ${near} near-equal of ${allScores.length})`);
  return { mesh: best.mesh, index: best.index, score: bestS, morphs: nMorph };
}
