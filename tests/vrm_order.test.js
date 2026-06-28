// #24 — the VRM frame-ordering seam (guards #1).
//
// THE bug #1 fixes: a VRM's vrm.update() copies the rest-pose NORMALIZED humanoid bones back over
// the RAW bones every frame. The procedural compositor writes the AI pose to the raw bones, then
// vrm.update() runs LATER in the same frame — so with the humanoid auto-copy ON, the AI motion is
// instantly wiped and never reaches the screen. The fix (avatar.js onModelLoaded): set
//   vrm.humanoid.autoUpdateHumanBones = false
// right after `vrm = asset.vrm`, so vrm.update() keeps driving springs / look-at / expressions but
// no longer overwrites the posed bones.
//
// This test asserts the REAL seam: it imports stepProcVrmFrame (the exact proc->...->vrm ordering
// the animate loop runs) and drives it with a real proc on a real humanoid plus a stand-in `vrm`
// whose humanoid.update() mimics the normalized->raw copy-back. With the #1 fix applied
// (autoUpdateHumanBones=false) the head pose SURVIVES the frame; with it left ON (the unfixed
// state) the very same frame wipes the pose back to rest — so the test fails without #1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProceduralRig } from "../procedural.js";
import { fullBiped } from "./fixtures.js";
import { stepProcVrmFrame } from "../avatar.js";

// rotation angle (rad) between a bone's current orientation and a captured rest quaternion.
const angOff = (q, restQ) => 2 * Math.acos(Math.min(1, Math.abs(q.dot(restQ))));

// A stand-in VRM: vrm.update() -> humanoid.update(). humanoid.update() models the real
// @pixiv/three-vrm behavior — when autoUpdateHumanBones is true it copies the rest pose back over
// the tracked raw bones (here: forces the head + an arm bone to their captured rest). When false
// (the #1 fix) it leaves the posed bones alone (a real VRM still steps its springs/look-at here).
function makeStubVrm(model, trackedNames) {
  const tracked = [];
  model.traverse((o) => {
    if (o.isBone && trackedNames.includes(o.name)) tracked.push({ bone: o, rest: o.quaternion.clone() });
  });
  let copyBacks = 0;
  return {
    humanoid: {
      autoUpdateHumanBones: true, // the unfixed default — onModelLoaded flips this to false (#1)
      update() {
        if (!this.autoUpdateHumanBones) return; // #1 fix: do NOT copy rest-pose normalized bones back over the AI pose
        for (const t of tracked) t.bone.quaternion.copy(t.rest); // the copy-back that wipes the pose
        copyBacks++;
      },
    },
    update() {
      this.humanoid.update();
    }, // vrm.update(dt) drives the humanoid (+ springs/look-at on a real one)
    get copyBacks() {
      return copyBacks;
    },
  };
}

test("#1: with autoUpdateHumanBones OFF (the fix), the AI head/arm pose SURVIVES vrm.update()", () => {
  const model = fullBiped();
  const proc = buildProceduralRig(model, {});
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  const restArm = bones.left_arm.quaternion.clone();

  const vrm = makeStubVrm(model, [bones.head.name, bones.left_arm.name]);
  if (vrm?.humanoid) vrm.humanoid.autoUpdateHumanBones = false; // EXACTLY what avatar.js onModelLoaded does at load (#1)

  proc.setLayer("ai_pose", { parts: { head: [0.4, 0, 0] }, flex: { left_arm: [0.5, 0] } });
  // ONE animate-equivalent frame, in the real order (proc writes the pose, THEN vrm.update runs).
  stepProcVrmFrame(0.016, { proc, facial: null, facialOn: false, spring: null, springOn: false, rig: model, vrm });

  assert.equal(vrm.copyBacks, 0, "vrm.update() must NOT copy rest bones back when the flag is off");
  assert.ok(angOff(bones.head.quaternion, restHead) > 0.1, "head stays posed (NON-rest) after vrm.update()");
  assert.ok(angOff(bones.left_arm.quaternion, restArm) > 0.1, "arm stays posed (NON-rest) after vrm.update()");
});

test("#1 guard: WITHOUT the fix (flag left ON) the same frame wipes the pose — proves the test bites", () => {
  const model = fullBiped();
  const proc = buildProceduralRig(model, {});
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();

  const vrm = makeStubVrm(model, [bones.head.name]);
  // Deliberately DO NOT apply the #1 fix: autoUpdateHumanBones stays true.

  proc.setLayer("ai_pose", { parts: { head: [0.4, 0, 0] } });
  stepProcVrmFrame(0.016, { proc, facial: null, facialOn: false, spring: null, springOn: false, rig: model, vrm });

  assert.ok(vrm.copyBacks > 0, "the unfixed vrm.update() DID run its copy-back");
  assert.ok(angOff(bones.head.quaternion, restHead) < 1e-6, "without #1 the AI pose is wiped back to rest");
});
