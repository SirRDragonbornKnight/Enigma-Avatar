// skinspace.js — vertex positions and morph deltas in TRUE world space for the load-time
// geometry passes (face/mouth classification).
//
// The classifiers used `position x mesh.matrixWorld`, which is correct for plain meshes but
// WRONG for skinned ones whose placement lives in the armature: Sketchfab rips routinely bind
// a centimeter-scale mesh to a meter-scale skeleton. Ryuri's raw verts sit BELOW her own head
// bone that way, so the head-anchored band classifier measured span<=0 and bailed while she
// rendered full-size on screen (2026-07-03 audit). Linear-blend skinning is AFFINE per vertex,
// so the exact world displacement of a morph is skin(base+delta) - skin(base) through the SAME
// vertex weights. applyBoneTransform reads the bones' matrixWorld directly (not the
// renderer-updated boneMatrices), so this is valid BEFORE the first frame — the load-time
// facial build depends on that; callers must have run model.updateWorldMatrix(true, true).
import * as THREE from "three";

const _b = new THREE.Vector3();

/** Is this mesh skinned AND carrying the attributes applyBoneTransform needs? */
export function isSkinnable(o) {
  return !!(o.isSkinnedMesh && o.skeleton && o.geometry?.attributes?.skinIndex && o.geometry?.attributes?.skinWeight);
}

/**
 * Refresh every attached skinned mesh's bindMatrixInverse from its CURRENT matrixWorld.
 * applyBoneTransform ends with x bindMatrixInverse, and for bindMode "attached" three only
 * re-syncs that inside updateMatrixWorld() — the RENDER LOOP's walk. Object3D.updateWorldMatrix()
 * (what a load-time pass calls) computes matrixWorld inline WITHOUT that hook, so before the
 * first frame bindMatrixInverse is stale and skinned positions come out garbage — the classifiers
 * worked at query time but returned zero records during the facial build (2026-07-03). Call this
 * after updateWorldMatrix and before any vertexWorld/morphDeltaWorld pass.
 */
export function syncSkinnedBind(model) {
  model.traverse((o) => {
    if (o.isSkinnedMesh && o.bindMode === "attached" && o.bindMatrixInverse) {
      o.bindMatrixInverse.copy(o.matrixWorld).invert();
    }
  });
}

/** World position of vertex i, skinning-aware. Writes into out; returns out. */
export function vertexWorld(o, i, out) {
  out.fromBufferAttribute(o.geometry.attributes.position, i);
  if (isSkinnable(o)) o.applyBoneTransform(i, out);
  return out.applyMatrix4(o.matrixWorld);
}

/**
 * World-space displacement of morph target `t` at vertex i, skinning-aware.
 * rel = geometry.morphTargetsRelative (GLTFLoader authors deltas; absolute targets get the
 * base subtracted). lin = precomputed Matrix3 of o.matrixWorld — the plain-mesh fast path.
 * Writes into out; returns out.
 */
export function morphDeltaWorld(o, t, i, rel, lin, out) {
  const pos = o.geometry.attributes.position;
  out.fromBufferAttribute(t, i);
  if (!rel) out.sub(_b.fromBufferAttribute(pos, i));
  if (!isSkinnable(o)) return out.applyMatrix3(lin);
  _b.fromBufferAttribute(pos, i);
  out.add(_b); // morphed position in bind space (morphs apply BEFORE skinning)
  o.applyBoneTransform(i, out).applyMatrix4(o.matrixWorld);
  o.applyBoneTransform(i, _b).applyMatrix4(o.matrixWorld);
  return out.sub(_b);
}
