// Characterization tests — lock the CURRENT bone-role mapping so the Phase 1
// cascade refactor (rig.js) can't silently regress a named rig. The name tier in
// rig.js is lifted byte-for-byte from procedural.js#roleOf, so these must stay green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProceduralRig } from "../procedural.js";
import { fullBiped, blenderBiped, hairRig } from "./fixtures.js";

const matched = (model) => buildProceduralRig(model, {}).matched;   // already sorted

// The 19 canonical roles (must match bone_limits.json / tests/test_avatar_bone_data.py).
const NINETEEN = [
  "chest", "head", "hips",
  "left_arm", "left_foot", "left_forearm", "left_hand", "left_leg", "left_shin", "left_shoulder",
  "neck",
  "right_arm", "right_foot", "right_forearm", "right_hand", "right_leg", "right_shin", "right_shoulder",
  "spine",
];

test("fullBiped — clear names map to all 19 canonical roles", () => {
  assert.deepEqual(matched(fullBiped()), NINETEEN);
});

test("blenderBiped — de-dotted .L/.R sides resolve; 'Armature' is never an arm", () => {
  // upper_arm.L → "upper_armL" (three.js strips the dot). Without raw-side detection
  // these limbs lose their side and stay T-posed (the Toy Chica bug). All 19 resolve,
  // and the `arm(?!ature)` guard keeps the Armature root out of an arm role.
  assert.deepEqual(matched(blenderBiped()), NINETEEN);
});

test("hairRig — only real body bones become roles; dangly bones do not", () => {
  // The forearmL/handL decoy ARE arm bones by name → left_forearm/left_hand. The
  // hair / BackStrand / tail / skirt bones must NOT be mistaken for body roles.
  assert.deepEqual(matched(hairRig()), ["head", "hips", "left_forearm", "left_hand"]);
});
