// retarget.js — play authored humanoid animation clips (Mixamo-style GLB) on ANY resolved rig.
// The engine resolves every rig into 19 canonical ROLES; a clip authored for one skeleton is
// transferred to another by mapping src bones → roles → dst bones with REST-POSE COMPENSATION
// (the pixiv/three-vrm loadMixamoAnimation pattern, generalized to non-identity dst rests).
// Pure module: three.js math only — no DOM, no engine imports, runs headless under node:test.
import * as THREE from "three";

// The 19 canonical humanoid roles (arm = UPPER arm, leg = THIGH — engine-wide convention).
export const CANONICAL_ROLES = [
  "hips", "spine", "chest", "neck", "head",
  "left_shoulder", "right_shoulder", "left_arm", "right_arm",
  "left_forearm", "right_forearm", "left_hand", "right_hand",
  "left_leg", "right_leg", "left_shin", "right_shin", "left_foot", "right_foot",
];

// Exact Mixamo bone name per role (chest = Spine2: Mixamo splits the spine into Spine/Spine1/Spine2;
// Mixamo "LeftLeg" is the SHIN — its thigh is "LeftUpLeg").
const MIXAMO_NAME_BY_ROLE = {
  hips: "Hips", spine: "Spine", chest: "Spine2", neck: "Neck", head: "Head",
  left_shoulder: "LeftShoulder", right_shoulder: "RightShoulder",
  left_arm: "LeftArm", right_arm: "RightArm",
  left_forearm: "LeftForeArm", right_forearm: "RightForeArm",
  left_hand: "LeftHand", right_hand: "RightHand",
  left_leg: "LeftUpLeg", right_leg: "RightUpLeg",
  left_shin: "LeftLeg", right_shin: "RightLeg",
  left_foot: "LeftFoot", right_foot: "RightFoot",
};

// Lowercase + strip the optional "mixamorig" prefix with ":" or "" separator, so
// "mixamorig:LeftArm" / "mixamorigLeftArm" / "LEFTARM" all normalize to "leftarm".
function normalizeMixamoName(name) {
  return String(name || "").toLowerCase().replace(/^mixamorig:?/, "");
}

// Best-effort { role: srcBoneName } for Mixamo-convention skeletons. EXACT per-role names only —
// a prefix/substring match would let "Spine1"/"LeftHandIndex1" shadow "Spine"/"LeftHand".
// Returns only the roles actually found so callers can diff against CANONICAL_ROLES for coverage.
export function guessRoleMap(srcRoot) {
  const roleByMixamo = new Map();
  for (const role of CANONICAL_ROLES) roleByMixamo.set(MIXAMO_NAME_BY_ROLE[role].toLowerCase(), role);
  const map = {};
  const wonByBone = {};
  srcRoot.traverse((node) => {
    const role = roleByMixamo.get(normalizeMixamoName(node.name));
    if (!role) return;
    if (map[role] !== undefined && (wonByBone[role] || !node.isBone)) return; // first hit wins, but a real Bone outranks a same-named mesh/group
    map[role] = node.name;
    wonByBone[role] = !!node.isBone;
  });
  return map;
}

// Parent rest WORLD quaternion (identity for a parentless root) — getWorldQuaternion refreshes
// the ancestor matrixWorld chain itself, so call order can never hand us a stale rest.
function parentWorldQuat(bone) {
  return bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
}

// ── REST-POSE COMPENSATION ALGEBRA (per mapped bone pair; unit quats; products read right-to-left) ──
// At rest:  P_s = src parent rest WORLD rot, R_s = src rest LOCAL rot  ⇒  src rest world  W_s = P_s · R_s;
//           P_d = dst parent rest WORLD rot, R_d = dst rest LOCAL rot  ⇒  dst rest world  W_d = P_d · R_d.
// The clip keys src LOCALS q(t). Treating ancestors as at-rest PER BONE (each bone has its own track, so
// per-bone deltas compose down the chain the same way on both rigs — the loadMixamoAnimation assumption),
// the posed src world is  W(t) = P_s · q(t).
// The bone's WORLD-space delta vs its OWN rest:   D(t) = W(t) · inv(W_s) = P_s · q(t) · inv(R_s) · inv(P_s).
// Transferring that same world delta onto dst:    want  P_d · dstLocal(t) = D(t) · W_d,  hence
//   dstLocal(t) = inv(P_d) · D(t) · P_d · R_d = [inv(P_d)·P_s] · q(t) · [inv(R_s)·inv(P_s)·P_d·R_d] = A · q(t) · B.
// Identity check: q = R_s ⇒ D = 1 ⇒ dstLocal = R_d exactly (rest maps to rest; quat signs cancel pairwise).
// A and B are constants per bone pair — precomputed once; each keyframe costs two quat multiplies.

// Retarget `clip` (authored for srcRoot's skeleton; BOTH rigs at rest when passed — caller's contract)
// onto the live rig's resolved bones. Returns a NEW AnimationClip whose tracks target dst bones BY NAME;
// the input clip is never mutated. Dropped by design: tracks of src bones bound to no role, roles absent
// from dstRolesToBones, scale tracks, morphTargetInfluences tracks, and position tracks on anything but
// the hips (roles carry rotation; only hips root motion travels through position, height-scaled + rebased).
export function retargetClip(clip, srcRoot, srcRoleMap, dstRolesToBones) {
  srcRoot.updateWorldMatrix(true, true); // bake the src REST world transforms once up front
  const roleBySrcName = {};
  for (const role of Object.keys(srcRoleMap)) roleBySrcName[srcRoleMap[role]] = role;
  const cache = new Map(); // srcName → { srcBone, A, B } | null — a bone with quaternion+position tracks pays setup once
  const pairFor = (srcName, dstBone) => {
    if (cache.has(srcName)) return cache.get(srcName);
    const srcBone = srcRoot.getObjectByName(srcName);
    let pre = null;
    if (srcBone) {
      const Ps = parentWorldQuat(srcBone);
      const Pd = parentWorldQuat(dstBone);
      const A = Pd.clone().invert().multiply(Ps); // A = inv(P_d) · P_s
      const B = srcBone.quaternion.clone().invert().multiply(Ps.clone().invert()).multiply(Pd).multiply(dstBone.quaternion); // B = inv(R_s)·inv(P_s)·P_d·R_d
      pre = { srcBone, A, B };
    }
    cache.set(srcName, pre); // negative-cache misses too, so a bad name costs one lookup not one per track
    return pre;
  };
  const outTracks = [];
  const q = new THREE.Quaternion();
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf(".");
    if (dot <= 0) continue; // unbindable track name — nothing to retarget
    const srcName = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    const role = roleBySrcName[srcName];
    const dstBone = role ? dstRolesToBones[role] : null;
    if (!role || !dstBone) continue; // src bone bound to no role, or role missing on the live rig — drop
    const pre = pairFor(srcName, dstBone);
    if (!pre) continue; // mapped name absent under srcRoot — its rest is unreadable, drop
    if (prop === "quaternion") {
      const values = new Float32Array(track.values.length);
      for (let i = 0; i < track.values.length; i += 4) {
        q.fromArray(track.values, i).premultiply(pre.A).multiply(pre.B).normalize(); // dstLocal = A·q·B; normalize sands off float drift on long clips
        q.toArray(values, i);
      }
      const out = new THREE.QuaternionKeyframeTrack(`${dstBone.name}.quaternion`, track.times.slice(), values);
      out.setInterpolation(track.getInterpolation()); // keep authored stepping (discrete vs slerp)
      outTracks.push(out);
    } else if (prop === "position" && role === "hips") {
      const srcRest = pre.srcBone.position; // hips rest LOCAL position — the rebase origin on the src side
      const dstRest = dstBone.position;
      const srcH = pre.srcBone.getWorldPosition(new THREE.Vector3()).y; // rest hips height ≈ leg length — the proportion proxy
      const dstH = dstBone.getWorldPosition(new THREE.Vector3()).y;
      const scale = Math.abs(srcH) > 1e-9 ? dstH / srcH : 1; // height ratio sizes root motion to the dst rig; degenerate rig (hips at origin) passes through
      const values = new Float32Array(track.values.length);
      for (let i = 0; i < track.values.length; i += 3) {
        values[i] = dstRest.x + (track.values[i] - srcRest.x) * scale; // dstPos = dstRest + (srcPos − srcRest)·scale — delta-rebase, never absolute copy
        values[i + 1] = dstRest.y + (track.values[i + 1] - srcRest.y) * scale;
        values[i + 2] = dstRest.z + (track.values[i + 2] - srcRest.z) * scale;
      }
      const out = new THREE.VectorKeyframeTrack(`${dstBone.name}.position`, track.times.slice(), values);
      out.setInterpolation(track.getInterpolation());
      outTracks.push(out);
    } // scale / morphTargetInfluences / non-hips position fall through — dropped by design (see contract above)
  }
  return new THREE.AnimationClip(clip.name, clip.duration, outTracks, clip.blendMode); // same name/duration/blend — only the targets changed
}
