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

test("ambient breeze sways NAME-matched chains at rest (was geo-fallback-only → sprung hair sat dead)", () => {
  const findBone = (m, n) => { let b = null; m.traverse((o) => { if (o.isBone && o.name === n) b = o; }); return b; };
  const steps = (s, n) => { for (let i = 0; i < n; i++) s.update(1 / 60); };
  const mA = hairRig(); const sA = buildSpringBones(mA, { breeze: 0 }); steps(sA, 90);     // no wind
  const mB = hairRig(); const sB = buildSpringBones(mB, { breeze: 0.4 }); steps(sB, 90);   // wind
  const qA = findBone(mA, "Hair_01").quaternion, qB = findBone(mB, "Hair_01").quaternion;
  const dot = Math.abs(qA.x * qB.x + qA.y * qB.y + qA.z * qB.z + qA.w * qB.w);
  assert.ok(dot < 0.999999, `name-matched hair must sway under breeze at rest (quat dot ${dot})`);
});

test("impulse() kicks only the matching region's bones, then settles; unknown region returns false", () => {
  const findTail = (m) => { let b = null; m.traverse((o) => { if (o.isBone && o.name === "Tail") b = o; }); return b; };
  const steps = (s, n) => { for (let i = 0; i < n; i++) s.update(1 / 60); };
  // Baseline: same rig, same step count, NO impulse.
  const mA = hairRig(); const sA = buildSpringBones(mA); steps(sA, 12);
  const qA = findTail(mA).quaternion.clone();
  // Impulsed: a strong lateral tail kick must visibly rotate the tail bone vs the baseline.
  const mB = hairRig(); const sB = buildSpringBones(mB);
  assert.equal(sB.impulse("tail", { x: 8 }, 0.3), true, "model has a tail → accepted");
  assert.equal(sB.impulse("wing", { x: 8 }, 0.3), false, "no wings on this rig → rejected (caller can try another region)");
  sB.setRegionWeight("hair", 0);
  assert.equal(sB.impulse("hair", { x: 8 }, 0.3), false, "user-pinned region (weight 0) → rejected, fidget falls through instead of landing invisibly");
  sB.setRegionWeight("hair", 1);
  steps(sB, 12);
  const qB = findTail(mB).quaternion;
  const dot = Math.abs(qA.x * qB.x + qA.y * qB.y + qA.z * qB.z + qA.w * qB.w);
  assert.ok(dot < 0.99995, `tail must deflect under the impulse (quat dot ${dot})`);
  // Region isolation: a HAIR bone must match the no-impulse baseline exactly (the kick was tail-only).
  const findHair = (m) => { let b = null; m.traverse((o) => { if (o.isBone && o.name === "Hair_01") b = o; }); return b; };
  const hA = findHair(mA).quaternion, hB = findHair(mB).quaternion;
  const hdot = Math.abs(hA.x * hB.x + hA.y * hB.y + hA.z * hB.z + hA.w * hB.w);
  assert.ok(hdot > 0.999999, `hair must be untouched by a tail impulse (quat dot ${hdot})`);
  // Settle: long after the impulse ends, the tail returns toward rest (≈ the baseline pose).
  steps(sB, 600); steps(sA, 600);
  const qA2 = findTail(mA).quaternion, qB2 = findTail(mB).quaternion;
  const sdot = Math.abs(qA2.x * qB2.x + qA2.y * qB2.y + qA2.z * qB2.z + qA2.w * qB2.w);
  assert.ok(sdot > 0.9999, `tail must settle back after the impulse (quat dot ${sdot})`);
});
