// handwave.test.js — proves the lean procedural compositor can author the requested motion
//   "hand moves up -> close to a fist -> hold up ONE finger -> wag it side-to-side ('no')"
// ENTIRELY from PRIMITIVES (pose/flex motion layers + the new per-finger setFingers), with NO
// canned gesture in sight. Headless: synthetic THREE skeleton, real bone math, no WebGL.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { makeBone } from "./fixtures.js";
import { buildProceduralRig } from "../src/motion/procedural.js";

// A biped whose RIGHT hand carries five named finger chains (thumb..pinky), each a 3-joint
// chain extending out of the palm with a little spread — enough for the curl-axis calibration.
function fiveFingerBiped() {
  const finger = (name, z) =>
    makeBone(name + "1", [0.06, 0, z], [makeBone(name + "2", [0.035, 0, 0], [makeBone(name + "3", [0.025, 0, 0])])]);
  const rHand = makeBone(
    "RightHand",
    [0.22, 0, 0],
    [
      makeBone("RightHand_end", [0.04, 0, 0]),
      finger("RightThumb", -0.05),
      finger("RightIndex", -0.025),
      finger("RightMiddle", 0.0),
      finger("RightRing", 0.025),
      finger("RightPinky", 0.05),
    ]
  );
  const lHand = makeBone("LeftHand", [-0.22, 0, 0], [makeBone("LeftHand_end", [-0.04, 0, 0])]);
  const armChain = (sx, hand, pfx) =>
    makeBone(
      pfx + "Shoulder",
      [sx * 0.05, 0.1, 0],
      [makeBone(pfx + "UpperArm", [sx * 0.13, 0, 0], [makeBone(pfx + "Forearm", [sx * 0.26, 0, 0], [hand])])]
    );
  const legChain = (sx, pfx) =>
    makeBone(
      pfx + "Thigh",
      [sx * 0.1, -0.05, 0],
      [
        makeBone(
          pfx + "Shin",
          [0, -0.42, 0],
          [makeBone(pfx + "Foot", [0, -0.42, 0], [makeBone(pfx + "Toe", [0, -0.05, 0.12])])]
        ),
      ]
    );
  return makeBone(
    "Hips",
    [0, 1.0, 0],
    [
      makeBone(
        "Spine",
        [0, 0.12, 0],
        [
          makeBone(
            "Chest",
            [0, 0.14, 0],
            [
              makeBone("Neck", [0, 0.18, 0], [makeBone("Head", [0, 0.08, 0], [makeBone("Head_end", [0, 0.1, 0])])]),
              armChain(1, rHand, "Right"),
              armChain(-1, lHand, "Left"),
            ]
          ),
        ]
      ),
      legChain(1, "Right"),
      legChain(-1, "Left"),
    ]
  );
}

const settle = (proc, model, secs, dt = 1 / 60) => {
  for (let t = 0; t < secs; t += dt) {
    proc.update(dt);
    model.updateWorldMatrix(true, true);
  }
};
// rotation angle (rad) between two quaternions
const angBetween = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
const boneByName = (model, name) => {
  let f = null;
  model.traverse((o) => {
    if (o.name === name) f = o;
  });
  return f;
};

test("fingers resolve into named per-finger chains on the right hand", () => {
  const model = fiveFingerBiped();
  const proc = buildProceduralRig(model, {});
  const names = proc.capabilities().channels.fingers.R;
  for (const want of ["thumb", "index", "middle", "ring", "pinky"]) {
    assert.ok(names.includes(want), `right hand exposes a '${want}' finger (got ${JSON.stringify(names)})`);
  }
});

test("hand-wave-'no' is fully authorable from primitives: raise -> fist -> one finger up -> wag", () => {
  const model = fiveFingerBiped();
  const proc = buildProceduralRig(model, {});
  const rHand = proc.roles().right_hand;
  assert.ok(rHand, "right_hand role resolved");

  // baseline: settle at rest (no layers, no curl) and snapshot
  settle(proc, model, 0.3);
  const handRestWorld = rHand.getWorldPosition(new THREE.Vector3());
  const handRestQuat = rHand.quaternion.clone();
  const idx2 = boneByName(model, "RightIndex2"),
    mid2 = boneByName(model, "RightMiddle2"),
    thumb2 = boneByName(model, "RightThumb2");
  const idxRest = idx2.quaternion.clone(),
    midRest = mid2.quaternion.clone(),
    thumbRest = thumb2.quaternion.clone();

  // ── Phase 1: HAND MOVES UP — raise the arm via a flex motion layer (a primitive, not a clip)
  proc.setLayer("raise", { flex: { right_arm: [1.1], right_forearm: [0.6] } });
  settle(proc, model, 0.5);
  const handRaisedWorld = rHand.getWorldPosition(new THREE.Vector3());
  assert.ok(
    handRaisedWorld.distanceTo(handRestWorld) > 0.08,
    `the raise layer moved the hand (moved ${handRaisedWorld.distanceTo(handRestWorld).toFixed(3)})`
  );

  // ── Phase 2: CLOSE HAND — full fist (every finger curls)
  proc.setFingers("R", 1);
  settle(proc, model, 0.5);
  for (const [b, rest, nm] of [
    [idx2, idxRest, "index"],
    [mid2, midRest, "middle"],
    [thumb2, thumbRest, "thumb"],
  ]) {
    assert.ok(
      angBetween(b.quaternion, rest) > 0.4,
      `${nm} curled into the fist (Δ=${angBetween(b.quaternion, rest).toFixed(2)} rad)`
    );
  }

  // ── Phase 3: HOLD UP ONE FINGER — index extends, the rest stay curled
  proc.setFingers("R", { default: 1, index: 0 });
  settle(proc, model, 0.6);
  assert.ok(
    angBetween(idx2.quaternion, idxRest) < 0.15,
    `index is EXTENDED (back near rest, Δ=${angBetween(idx2.quaternion, idxRest).toFixed(2)})`
  );
  assert.ok(
    angBetween(mid2.quaternion, midRest) > 0.4,
    `middle stays CURLED (Δ=${angBetween(mid2.quaternion, midRest).toFixed(2)})`
  );
  assert.ok(angBetween(thumb2.quaternion, thumbRest) > 0.4, "thumb stays curled");

  // ── Phase 4: WAG IT 'NO' — oscillate the wrist yaw with a time-varying layer fn
  proc.setLayer("wag", { fn: (t) => ({ parts: { right_hand: [0, Math.sin(t * 6) * 0.3, 0] } }) });
  let maxY = -Infinity,
    minY = Infinity;
  for (let t = 0; t < 1.6; t += 1 / 60) {
    proc.update(1 / 60);
    model.updateWorldMatrix(true, true);
    const rel = new THREE.Euler().setFromQuaternion(handRestQuat.clone().invert().multiply(rHand.quaternion), "XYZ").y;
    if (rel > maxY) maxY = rel;
    if (rel < minY) minY = rel;
  }
  assert.ok(
    maxY > 0.05 && minY < -0.05,
    `wrist wags both ways ('no' motion): yaw in [${minY.toFixed(2)}, ${maxY.toFixed(2)}]`
  );

  // index is STILL up during the wag (the finger pose composes with the wrist layer)
  assert.ok(angBetween(idx2.quaternion, idxRest) < 0.2, "index stays up while the wrist wags");

  // releasing per-finger control hands the fingers back to the reactive grip (no explicit target)
  proc.setFingers("R", null);
  settle(proc, model, 0.5);
  assert.ok(angBetween(idx2.quaternion, idxRest) < 0.15, "released: index relaxes back to rest");
});
