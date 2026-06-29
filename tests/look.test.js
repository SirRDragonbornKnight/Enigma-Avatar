// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { headLookTarget, eyeLookAngles, eyeSide } from "../src/interaction/look.js";

const LOOK = { gainX: 1.4, gainY: 1.0, flipX: 1, flipY: -1, maxX: 0.6, maxY: 0.35 };
const EYE = { gain: 1.15, flipX: 1, flipY: -1, maxX: 0.62, maxY: 0.42 };

test("headLookTarget: cursor on the head -> zero turn", () => {
  const [tx, ty] = headLookTarget(500, 300, 500, 300, 1000, 600, LOOK);
  assert.equal(tx, 0);
  assert.equal(Math.abs(ty), 0); // 0 * flipY produces -0; treat as zero
});

test("headLookTarget: horizontal offset gains + the vertical axis flips", () => {
  // cursor 200px right of head over a 1000px viewport: (0.2)*1.4*1 = 0.28
  const [tx, ty] = headLookTarget(700, 300, 500, 300, 1000, 600, LOOK);
  assert.ok(Math.abs(tx - 0.28) < 1e-9);
  assert.equal(Math.abs(ty), 0); // same y
  // cursor BELOW head: flipY:-1 makes ty negative (mouse-down maps to the rig's down sign)
  const [, ty2] = headLookTarget(500, 480, 500, 300, 1000, 600, LOOK);
  assert.ok(ty2 < 0);
});

test("headLookTarget: extreme offsets clamp to the max swing", () => {
  const [tx, ty] = headLookTarget(99999, 99999, 0, 0, 1000, 600, LOOK);
  assert.equal(tx, LOOK.maxX);
  assert.equal(ty, -LOOK.maxY); // flipY:-1 applied AFTER the clamp magnitude
});

test("eyeLookAngles: gain + clamp + flip + weight", () => {
  const { yaw, pitch } = eyeLookAngles(0.1, 0.1, EYE, 1);
  assert.ok(Math.abs(yaw - 0.1 * 1.15) < 1e-9);
  assert.ok(Math.abs(pitch - -(0.1 * 1.15)) < 1e-9); // flipY:-1
});

test("eyeLookAngles: weight scales the result; clamp caps the magnitude", () => {
  const z = eyeLookAngles(0.1, 0.1, EYE, 0);
  assert.equal(z.yaw, 0);
  assert.equal(Math.abs(z.pitch), 0); // weight 0 -> zero (avoid the +0/-0 deepEqual trap)
  const { yaw } = eyeLookAngles(99, 0, EYE, 1);
  assert.equal(yaw, EYE.maxX); // clamped before flip/weight
});

test("eyeSide: right/left tokens across rig naming conventions", () => {
  for (const n of ["eye_R", "R_Eye", "RightEye", "eye.R", "r_eye"]) assert.equal(eyeSide(n), "R", n);
  for (const n of ["eye_L", "L_Eye", "LeftEye", "eye.L", "l_eye"]) assert.equal(eyeSide(n), "L", n);
  for (const n of ["Eye", "Eyeball", "FaceEye"]) assert.equal(eyeSide(n), "C", n);
});
