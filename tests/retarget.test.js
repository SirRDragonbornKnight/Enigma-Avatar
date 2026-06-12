// retarget.test.js — proves the rest-pose-compensated clip retarget (../retarget.js) on two synthetic
// skeletons whose RESTS deliberately DISAGREE (src twists about Z, dst about X, different names/heights):
// rest must map to rest EXACTLY, and a world-space swing must come out as the SAME world-space swing.
// Headless: plain THREE.Bone hierarchies, no meshes/renderer — Object3D matrix math runs fine in Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CANONICAL_ROLES, guessRoleMap, retargetClip } from "../retarget.js";

const DEG = Math.PI / 180;
const qAxis = (x, y, z, deg) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z).normalize(), deg * DEG);

function bone(name, pos, quat, parent) {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(pos[0], pos[1], pos[2]);
  if (quat) b.quaternion.copy(quat);
  if (parent) parent.add(b);
  return b;
}

// SRC: mini Mixamo-named chain. Spine rest Rz(30°), arm rest Rz(-30°) — every LOCAL rest differs from
// dst, but the arm's REST WORLD rotation is identity so both arms share a world direction at rest.
function buildSrc() {
  const root = new THREE.Group(); root.name = "SrcScene";
  const hips = bone("mixamorig:Hips", [0, 2, 0], null, root);
  const spine = bone("mixamorig:Spine", [0, 0.4, 0], qAxis(0, 0, 1, 30), hips);
  const arm = bone("mixamorig:LeftArm", [0.3, 0.4, 0], qAxis(0, 0, 1, -30), spine);
  root.updateWorldMatrix(true, true);
  return { root, hips, spine, arm };
}

// DST: differently NAMED + differently RESTED equivalent — chest Rx(45°), arm Rx(-45°) (a rotated rest
// on a different axis than src), hips at HALF the src rest height (drives the position-scale check).
function buildDst() {
  const root = new THREE.Group(); root.name = "DstScene";
  const hips = bone("Hips", [0, 1, 0], null, root);
  const chest = bone("Chest", [0, 0.25, 0], qAxis(1, 0, 0, 45), hips);
  const arm = bone("LeftUpperArm", [0.15, 0.2, 0], qAxis(1, 0, 0, -45), chest);
  root.updateWorldMatrix(true, true);
  return { root, hips, chest, arm };
}

const SRC_MAP = { hips: "mixamorig:Hips", spine: "mixamorig:Spine", left_arm: "mixamorig:LeftArm" };
const dstMap = (d) => ({ hips: d.hips, spine: d.chest, left_arm: d.arm });
const quatTrack = (name, times, quats) => new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, quats.flatMap((qq) => qq.toArray()));

test("identity clip (keys == src rest locals) retargets to EXACTLY the dst rest locals", () => {
  const s = buildSrc(); const d = buildDst();
  const clip = new THREE.AnimationClip("idle", 1, [
    quatTrack("mixamorig:Hips", [0, 1], [s.hips.quaternion, s.hips.quaternion]),
    quatTrack("mixamorig:Spine", [0, 1], [s.spine.quaternion, s.spine.quaternion]),
    quatTrack("mixamorig:LeftArm", [0, 1], [s.arm.quaternion, s.arm.quaternion]),
  ]);
  const out = retargetClip(clip, s.root, SRC_MAP, dstMap(d));
  assert.equal(out.tracks.length, 3);
  const expect = { "Hips.quaternion": d.hips.quaternion, "Chest.quaternion": d.chest.quaternion, "LeftUpperArm.quaternion": d.arm.quaternion };
  for (const t of out.tracks) {
    const want = expect[t.name].toArray();
    for (let k = 0; k < t.values.length; k += 4) {
      for (let c = 0; c < 4; c++) assert.ok(Math.abs(t.values[k + c] - want[c]) < 1e-6, `${t.name} key@${k} comp ${c}: got ${t.values[k + c]}, want ${want[c]}`);
    }
  }
});

test("a 90° WORLD swing of the src arm lands as the SAME world direction on the dst arm (≤1°)", () => {
  const s = buildSrc(); const d = buildDst();
  // Author a src LOCAL key that swings the arm 90° in WORLD space: q = inv(P_s) · Rz90 · W_s.
  const Ps = s.spine.getWorldQuaternion(new THREE.Quaternion());
  const Ws = s.arm.getWorldQuaternion(new THREE.Quaternion());
  const key = Ps.clone().invert().multiply(qAxis(0, 0, 1, 90)).multiply(Ws);
  const clip = new THREE.AnimationClip("swing", 0, [quatTrack("mixamorig:LeftArm", [0], [key])]);
  const out = retargetClip(clip, s.root, SRC_MAP, dstMap(d)); // retarget FIRST — both rigs must be at rest here
  // Pose the SRC with the key and read the arm's world X direction.
  s.arm.quaternion.copy(key);
  s.root.updateWorldMatrix(true, true);
  const srcDir = new THREE.Vector3(1, 0, 0).applyQuaternion(s.arm.getWorldQuaternion(new THREE.Quaternion()));
  // Apply the retargeted key to the DST arm and read its world X direction.
  assert.equal(out.tracks.length, 1);
  assert.equal(out.tracks[0].name, "LeftUpperArm.quaternion");
  d.arm.quaternion.fromArray(out.tracks[0].values, 0);
  d.root.updateWorldMatrix(true, true);
  const dstDir = new THREE.Vector3(1, 0, 0).applyQuaternion(d.arm.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(srcDir.angleTo(dstDir) / DEG < 1, `world directions diverge ${(srcDir.angleTo(dstDir) / DEG).toFixed(3)}°`);
  const swung = dstDir.angleTo(new THREE.Vector3(1, 0, 0)) / DEG; // sanity: it actually moved ~90° off rest, not stayed put
  assert.ok(Math.abs(swung - 90) < 1, `expected ~90° swing from rest, got ${swung.toFixed(3)}°`);
});

test("hips position: +1 src unit up → +0.5 on the half-height dst, rebased to the dst rest", () => {
  const s = buildSrc(); const d = buildDst();
  const clip = new THREE.AnimationClip("walk", 1, [new THREE.VectorKeyframeTrack("mixamorig:Hips.position", [0, 1], [0, 2, 0, 0, 3, 0])]);
  const out = retargetClip(clip, s.root, SRC_MAP, dstMap(d));
  assert.equal(out.tracks.length, 1);
  assert.equal(out.tracks[0].name, "Hips.position");
  const want = [0, 1, 0, 0, 1.5, 0]; // key0 = src rest → dst rest (0,1,0); key1 = +1 up × scale (1/2) → (0,1.5,0)
  for (let i = 0; i < 6; i++) assert.ok(Math.abs(out.tracks[0].values[i] - want[i]) < 1e-6, `values[${i}] = ${out.tracks[0].values[i]}, want ${want[i]}`);
});

const MIXAMO_19 = ["Hips", "Spine", "Spine2", "Neck", "Head", "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "RightShoulder", "RightArm", "RightForeArm", "RightHand", "LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot"];

function fullSkeleton(prefix) {
  const root = new THREE.Group(); root.name = "Scene";
  let parent = root;
  for (const n of MIXAMO_19) parent = bone(prefix + n, [0, 0.1, 0], null, parent); // chain shape is irrelevant — guessRoleMap matches names only
  return root;
}

test("guessRoleMap finds all 19 roles with AND without the mixamorig prefix", () => {
  for (const prefix of ["mixamorig:", ""]) {
    const map = guessRoleMap(fullSkeleton(prefix));
    assert.equal(Object.keys(map).length, 19, `prefix "${prefix}"`);
    for (const role of CANONICAL_ROLES) assert.ok(typeof map[role] === "string" && map[role].length > 0, `${role} missing (prefix "${prefix}")`);
    assert.equal(map.chest, prefix + "Spine2");       // chest is Spine2 — "Spine" must NOT shadow it
    assert.equal(map.left_leg, prefix + "LeftUpLeg"); // leg = THIGH = Mixamo LeftUpLeg
    assert.equal(map.left_shin, prefix + "LeftLeg");  // Mixamo "LeftLeg" is the SHIN
    assert.equal(map.hips, prefix + "Hips");
  }
  assert.equal(guessRoleMap(fullSkeleton("MIXAMORIG")).hips, "MIXAMORIGHips"); // separator-less prefix + case-insensitive
});

test("unmapped/scale/morph/non-hips-position tracks drop; name/duration/times preserved; original untouched", () => {
  const s = buildSrc(); const d = buildDst();
  const times = [0, 0.5, 1.25];
  const clip = new THREE.AnimationClip("emote_wave", 1.25, [
    quatTrack("mixamorig:LeftArm", times, [s.arm.quaternion, qAxis(0, 0, 1, 20), s.arm.quaternion]), // the one survivor
    new THREE.VectorKeyframeTrack("mixamorig:Spine.scale", [0, 1], [1, 1, 1, 2, 2, 2]),              // scale → drop
    new THREE.NumberKeyframeTrack("Face.morphTargetInfluences[smile]", [0, 1], [0, 1]),              // morph → drop
    quatTrack("mixamorig:RightHand", [0], [new THREE.Quaternion()]),                                 // src bone bound to no role → drop
    quatTrack("mixamorig:Head", [0], [new THREE.Quaternion()]),                                      // role mapped on src but missing on dst → drop
    quatTrack("mixamorig:LeftHand", [0], [new THREE.Quaternion()]),                                  // role on both sides but NO such src bone → drop
    new THREE.VectorKeyframeTrack("mixamorig:Spine.position", [0, 1], [0, 0, 0, 0, 1, 0]),           // position on a non-hips role → drop
  ]);
  const srcMap = { ...SRC_MAP, head: "mixamorig:Head", left_hand: "mixamorig:LeftHand" };
  const beforeNames = clip.tracks.map((t) => t.name);
  const out = retargetClip(clip, s.root, srcMap, { ...dstMap(d), left_hand: d.arm });
  assert.equal(out.tracks.length, 1);
  assert.equal(out.tracks[0].name, "LeftUpperArm.quaternion");
  assert.deepEqual(Array.from(out.tracks[0].times), times);             // key times preserved exactly
  assert.notEqual(out.tracks[0].times, clip.tracks[0].times);           // ...but on a fresh buffer, not shared
  assert.equal(out.name, "emote_wave");
  assert.equal(out.duration, 1.25);
  assert.notEqual(out, clip);
  assert.deepEqual(clip.tracks.map((t) => t.name), beforeNames);        // original clip structure untouched
  assert.equal(clip.tracks.length, 7);
});
