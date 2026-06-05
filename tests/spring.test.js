// Characterization tests — lock the spring-bone NAME detection (hair / strand / tail
// / skirt) and its guards. This is the regression net for the 51dc "strand" fix and
// the forEARm / fin(?!ger) guards. Phase 1 adds limb-exclusion on top of this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpringBones } from "../spring.js";
import { resolveRig } from "../rig.js";
import { hairRig, fullBiped } from "./fixtures.js";

test("hairRig — springs hair/strand/tail/skirt; excludes forearm & fingers", () => {
  const set = new Set(buildSpringBones(hairRig()).names);
  // The 51dc fix: BackStrand* must spring (SPRING_RE gained `strand`).
  for (const b of ["BackStrand0", "BackStrand1", "BackStrand2"]) assert.ok(set.has(b), `expected ${b} sprung`);
  for (const b of ["Hair", "Hair_01", "Hair_02"]) assert.ok(set.has(b), `expected ${b} sprung`);
  for (const b of ["Tail", "Tail_01"]) assert.ok(set.has(b), `expected ${b} sprung`);
  assert.ok(set.has("Skirt_F"), "expected Skirt_F sprung");
  // Guards: "forEARm" (ear preceded by 'for') and fin(?!ger) must NEVER spring.
  for (const b of ["forearmL", "handL", "Finger1", "Finger2"]) assert.ok(!set.has(b), `${b} must NOT spring`);
  assert.equal(set.size, 9);
});

test("role-matched limbs are NOT sprung once excluded (Phase 1 fix)", () => {
  // Pre-cascade, a hairless humanoid hit the geometric fallback and sprang all 14
  // limb bones. Passing the resolved role bones as `exclude` stops that.
  const model = fullBiped();
  const exclude = resolveRig(model).springExclude;
  assert.equal(buildSpringBones(model, { exclude }).count, 0);
});

test("spring override — extra force-springs, never suppresses", () => {
  const names = new Set(buildSpringBones(hairRig(), { override: { spring: { extra: ["Hips"], never: ["Tail"] } } }).names);
  assert.ok(names.has("Hips"), "extra should force-spring a non-dangly bone");
  assert.ok(!names.has("Tail"), "never should suppress a matched bone");
});
