// idleprofile.test.js — per-model idle SEEDS (the 2026-06-11 pivot): each avatar gets its OWN
// personality generated from what it actually has; no skeleton → no life. (The engine itself
// defaulting to dead is pinned in idle.test.js "PER-MODEL PIVOT" stillness test.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { seedIdleProfile, LIVE } from "../idleprofile.js";

const HUMANOID_ROLES = [
  "hips", "spine", "chest", "neck", "head",
  "left_shoulder", "left_arm", "left_forearm", "left_hand",
  "right_shoulder", "right_arm", "right_forearm", "right_hand",
  "left_leg", "left_shin", "left_foot", "right_leg", "right_shin", "right_foot",
];

test("statue (no skeleton) seeds dead — nothing will ever move", () => {
  const p = seedIdleProfile({ roles: [], regions: [], boneCount: 0 });
  for (const k of ["breathe", "look", "swayAmp", "wrist", "shiftEvery", "poseEvery", "ambient", "armLife", "fidgetEvery"])
    assert.equal(p[k], 0, `${k} must be 0 on a statue`);
  assert.equal(p._seed, 1, "seed provenance marker present");
});

test("full humanoid with tail+hair seeds the works, fidgeting ONLY its own appendages", () => {
  const p = seedIdleProfile({ roles: HUMANOID_ROLES, regions: ["hair", "tail", "breast"], boneCount: 175 });
  assert.equal(p.breathe, LIVE.breathe, "breath");
  assert.equal(p.swayAmp, LIVE.swayAmp, "sway");
  assert.equal(p.shiftEvery, LIVE.shiftEvery, "weight shifts (has legs)");
  assert.equal(p.poseEvery, LIVE.poseEvery, "arm poses (has arms)");
  assert.equal(p.armLife, 1, "arm-hang life");
  assert.ok(p.fidgetEvery > 0, "fidgets on");
  assert.deepEqual(p.fidgetRegions, ["tail", "hair"], "only HER safe appendages (FIDGETABLE order)");
});

test("head-only robot seeds servo-calm: glances + segment micro, no biped layers", () => {
  const p = seedIdleProfile({ roles: ["head"], regions: [], boneCount: 44 });
  assert.ok(p.look > 0, "glances (has a head)");
  assert.ok(p.ambient > 0, "segments get micro-life");
  assert.equal(p.breathe, 0, "no torso → no breath");
  assert.equal(p.swayAmp, 0, "not a biped → no postural sway");
  assert.equal(p.shiftEvery, 0, "no weight shifts");
  assert.equal(p.poseEvery, 0, "no arm poses");
  assert.equal(p.armLife, 0, "no arm-hang noise");
});

test("NSFW-only regions never become fidget targets", () => {
  const p = seedIdleProfile({ roles: HUMANOID_ROLES, regions: ["breast", "genital", "butt"], boneCount: 99 });
  assert.equal(p.fidgetEvery, 0, "nothing safe to fidget → fidgets off");
  assert.deepEqual(p.fidgetRegions, [], "no NSFW region ever seeds a fidget");
});

test("different capability classes produce DIFFERENT personalities (the point of the pivot)", () => {
  const wolf = seedIdleProfile({ roles: HUMANOID_ROLES, regions: ["tail", "ear"], boneCount: 600 });
  const robot = seedIdleProfile({ roles: ["head"], regions: [], boneCount: 44 });
  const statue = seedIdleProfile({ roles: [], regions: [], boneCount: 0 });
  assert.notDeepEqual(wolf, robot, "wolf ≠ robot");
  assert.notDeepEqual(robot, statue, "robot ≠ statue");
  assert.ok(wolf.fidgetRegions.includes("tail") && !robot.fidgetEvery, "the wolf swishes; the robot doesn't pretend to");
});
