// geom_mouth.js — find the mouth-open morph by GEOMETRY, never by name.
//
// Many rips ship dozens of UNNAMED morph targets (51dc: 76), so facial.js's name-based
// mouth picker finds nothing and lip-sync silently dies. The GENERAL fix (no per-model
// config, no asset editing): detect the mouth structurally — it's the morph that drops
// HEAD-region vertices DOWNWARD in world space (a jaw opening). Runs once at load on the
// live three.js geometry (which is already world-upright + skin-resolved, unlike the raw
// glTF) — same philosophy as the bone cascade: identify by structure, not by name.
//
// Returns { index, score, morphs } (drive that morph index from speech amplitude) or null
// when there's no confident jaw-drop signal (so it never forces a random morph).
//
// opts.headBone (#26): anchor the head-region cut on the HEAD BONE's world Y like geom_face,
// not the world-bbox top. On a full body the bbox heuristic cuts at top - 0.35*FULL-HEIGHT,
// which reaches deep into the torso; and tall hair/hats/ears inflate the top so the band misses
// the face entirely. Anchored, the region is everything from a little BELOW the head bone (the
// jaw/chin sits just under it) upward: cut = headY - 0.35*span (span = head bone -> topmost vertex
// along bodyUp). Hair above the skull just adds morph-free verts. No head bone -> legacy bbox top.
import * as THREE from "three";

export function detectMouthMorph(model, opts = {}) {
  if (!model) return null;
  model.updateWorldMatrix(true, true);

  const meshes = [];
  model.traverse((o) => {
    if (o.isMesh && o.morphTargetInfluences?.length && o.geometry?.morphAttributes?.position?.length) meshes.push(o);
  });
  if (!meshes.length) return null;

  // Head region cut along world-up. World is Y-up in three.js (the loader/node hierarchy already
  // rotated a Z-up source), so default up = +Y; honor a caller bodyUp only if it's a real vector.
  // ONE frame throughout: the cut, the head filter, and the jaw-drop score all project onto this
  // same axis (the cut used to be along `up` while the loop compared raw world Y — a latent
  // mismatch for any non-Y bodyUp).
  const up = opts.bodyUp && opts.bodyUp.isVector3 ? opts.bodyUp.clone().normalize() : new THREE.Vector3(0, 1, 0);
  const box = new THREE.Box3().setFromObject(model);
  let hiTop = -Infinity,
    hiBot = Infinity; // bbox extremes ALONG up (with the +Y default: exactly box.max.y / box.min.y)
  const _c = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    _c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    const h = _c.dot(up);
    if (h > hiTop) hiTop = h;
    if (h < hiBot) hiBot = h;
  }
  const head = opts.headBone && opts.headBone.isObject3D ? opts.headBone : null;
  let headCut;
  if (head) {
    // #26 head-anchored: span = head bone origin -> topmost vertex; region = above headY-0.35*span.
    const origin = head.getWorldPosition(new THREE.Vector3());
    const _w = new THREE.Vector3();
    let span = 0;
    model.traverse((o) => {
      const pos = o.isMesh ? o.geometry?.attributes?.position : null;
      if (!pos) return;
      const st = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += st) {
        const h = _w.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).sub(origin).dot(up);
        if (h > span) span = h;
      }
    });
    // span<=0 means nothing sits above the head bone (degenerate rig) -> fall back to bbox top.
    headCut = span > 1e-6 ? origin.dot(up) - 0.35 * span : hiTop - 0.35 * Math.max(1e-6, hiTop - hiBot);
  } else {
    // Legacy: top 35% of the world bounding box (no head bone to anchor on).
    headCut = hiTop - 0.35 * Math.max(1e-6, hiTop - hiBot);
  }

  const _v = new THREE.Vector3();
  const _lin = new THREE.Matrix3(); // upper-3x3 of matrixWorld → world-space delta direction
  const nMorph = Math.max(...meshes.map((m) => m.morphTargetInfluences.length));
  const allScores = []; // every (mesh,morph) downscore — for the noise gate
  let best = null,
    bestS = 0; // best = { mesh, index } — drive ONLY this mesh's morph (index i differs per mesh)

  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    const targets = mesh.geometry.morphAttributes.position;
    if (!pos || !targets) continue;
    _lin.setFromMatrix4(mesh.matrixWorld); // NOT the normal matrix — deltas are displacements
    const N = pos.count,
      stride = Math.max(1, Math.floor(N / 1500)); // sample for perf (load-time, one-shot)
    for (let mi = 0; mi < targets.length; mi++) {
      const d = targets[mi];
      if (!d) continue;
      let down = 0;
      for (let v = 0; v < N; v += stride) {
        _v.fromBufferAttribute(pos, v).applyMatrix4(mesh.matrixWorld); // world rest position
        if (_v.dot(up) < headCut) continue; // head only (same up-axis as the cut)
        _v.fromBufferAttribute(d, v).applyMatrix3(_lin); // world-space displacement
        const dn = -_v.dot(up);
        if (dn > 0) down += dn; // downward (along -up) → jaw drop
      }
      allScores.push(down);
      if (down > bestS) {
        bestS = down;
        best = { mesh, index: mi };
      }
    }
  }

  // Reject NOISE: the winner (plus any identical DUPLICATE clones — 51dc has 3) should stand
  // out as a FEW near-equal scores, not "everything moves about the same". A median gate
  // false-rejects on low-morph-count models, so count how many scores are within 50% of the
  // best instead — robust whether there are 2 morphs or 200.
  const near = allScores.filter((s) => s >= bestS * 0.5).length;
  if (!best || bestS < 1e-4 || near > Math.max(3, nMorph * 0.25)) {
    if (best)
      console.log(
        `[avatar] geom mouth: no confident jaw-drop (best=${bestS.toFixed(3)}, ${near} near-equal of ${allScores.length}) -> none`
      );
    return null;
  }
  console.log(
    `[avatar] geom mouth: morph #${best.index} on one mesh (downscore ${bestS.toFixed(3)}, ${near} near-equal of ${allScores.length})`
  );
  return { mesh: best.mesh, index: best.index, score: bestS, morphs: nMorph };
}
