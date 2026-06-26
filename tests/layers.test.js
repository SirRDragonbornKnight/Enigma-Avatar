// P1 motion compositor — the AI-driven LAYER STACK. Each layer is an independent additive
// offset bundle; disjoint roles SUM for free, same-role layers SUM, timed layers self-expire.
// Headless: build the synthetic fullBiped, drive update(), assert on the live role bones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProceduralRig } from "../procedural.js";
import { fullBiped } from "./fixtures.js";

// rotation angle (rad) between a bone's current orientation and a captured rest quaternion:
// for unit quats, theta = 2*acos(|q1 . q2|).
const angOff = (bone, restQ) => 2 * Math.acos(Math.min(1, Math.abs(bone.quaternion.dot(restQ))));

test("a layer drives its role; disjoint roles compose independently (SUM for free)", () => {
  const proc = buildProceduralRig(fullBiped(), {});
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  const restFoot = bones.left_foot.quaternion.clone();
  proc.update(0.016);                                   // baseline: no layers, head & foot at rest (no look/expr)
  assert.ok(angOff(bones.head, restHead) < 1e-6, "head at rest with no layer");
  assert.ok(angOff(bones.left_foot, restFoot) < 1e-6, "foot at rest with no layer");
  proc.setLayer("a", { parts: { head: [0.3, 0, 0] } });
  proc.setLayer("b", { parts: { left_foot: [0.2, 0, 0] } });
  proc.update(0.016);
  assert.ok(Math.abs(angOff(bones.head, restHead) - 0.3) < 0.02, "head pitched ~0.3 by layer a");
  assert.ok(Math.abs(angOff(bones.left_foot, restFoot) - 0.2) < 0.02, "foot pitched ~0.2 by layer b, independent of a");
});

// DECIDED 2026-06-25 (user): same-role layers SUM (they stack) — NOT blend-by-priority — so a
// co-speech nod adds ON TOP of a deliberate look instead of averaging it away. The summed result
// is bounded by the per-role joint limit (the safety-cap test below). Spec sec 5 updated to match.
test("two layers on the SAME role SUM (the chosen behavior)", () => {
  const proc = buildProceduralRig(fullBiped(), {});
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  proc.setLayer("a", { parts: { head: [0.2, 0, 0] } });
  proc.setLayer("b", { parts: { head: [0.2, 0, 0] } });
  proc.update(0.016);
  assert.ok(Math.abs(angOff(bones.head, restHead) - 0.4) < 0.03, "same-role layers sum to ~0.4 rad");
});

test("weight scales a layer's contribution", () => {
  const proc = buildProceduralRig(fullBiped(), {});
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  proc.setLayer("a", { parts: { head: [0.4, 0, 0] }, weight: 0.5 });
  proc.update(0.016);
  assert.ok(Math.abs(angOff(bones.head, restHead) - 0.2) < 0.02, "0.4 * weight 0.5 = ~0.2");
});

test("clearLayer removes a layer's contribution; the role returns to base", () => {
  const proc = buildProceduralRig(fullBiped(), {});
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  proc.setLayer("a", { parts: { head: [0.3, 0, 0] } });
  proc.update(0.016);
  assert.ok(angOff(bones.head, restHead) > 0.25, "active before clear");
  proc.clearLayer("a");
  proc.update(0.016);
  assert.ok(angOff(bones.head, restHead) < 1e-6, "head back to rest after clear");
  assert.deepEqual(proc.layerIds(), []);
});

test("a timed layer self-expires after dur", () => {
  const proc = buildProceduralRig(fullBiped(), {});
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  proc.setLayer("t", { parts: { head: [0.3, 0, 0] }, dur: 0.1 });   // no env -> full weight until expiry
  proc.update(0.05);
  assert.ok(angOff(bones.head, restHead) > 0.25, "active before dur");
  proc.update(0.06);                                   // local t = 0.11 > 0.1 -> expired & deleted
  assert.ok(angOff(bones.head, restHead) < 1e-6, "back to rest after expiry");
  assert.deepEqual(proc.layerIds(), [], "expired layer removed from the stack");
});

test("a flex-channel layer bends a limb about its hinge", () => {
  const proc = buildProceduralRig(fullBiped(), {});
  const bones = proc.roles();
  // capture the arm AFTER one base frame (it carries the static A-pose hang), then add a flex layer
  proc.update(0.016);
  const armBase = bones.left_arm.quaternion.clone();
  proc.setLayer("reach", { flex: { left_arm: [0.6, 0] } });
  proc.update(0.016);
  assert.ok(angOff(bones.left_arm, armBase) > 0.4, "flex layer rotated the upper arm about its hinge");
});

test("an fn(t) layer is sampled from absolute local time", () => {
  const proc = buildProceduralRig(fullBiped(), {});
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  // a constant fn -> deterministic; proves the fn path runs and feeds parts
  proc.setLayer("osc", { fn: () => ({ parts: { head: [0.25, 0, 0] } }) });
  proc.update(0.016);
  assert.ok(Math.abs(angOff(bones.head, restHead) - 0.25) < 0.02, "fn layer drove the head ~0.25");
});

test("capabilities reports this model's resolved roles + channels", () => {
  const cap = buildProceduralRig(fullBiped(), {}).capabilities();
  assert.ok(cap.roles.includes("head") && cap.roles.includes("left_arm"), "roles list the resolved bones");
  assert.ok(cap.flexRoles.includes("left_arm"), "arms are flex-able");
  assert.ok(cap.channels.pose && cap.channels.look && cap.channels.layers, "core channels present");
  assert.equal(cap.units && cap.units.offsets, "radians", "unit convention advertised: pose/flex offsets are radians (limits are degrees)");
});

// SAFETY CAP (2026-06-25): the advertised per-role limits are now ENFORCED on layers — an over-range
// command is clamped to the joint's range, not driven to it. Prevents the "AI cranked her head
// backwards" class of break. Roles WITHOUT a limit entry keep the +-PI sanity bound (unchanged).
test("a pose layer is capped at the role's advertised joint limit, not driven past it", () => {
  const LIMITS = { bones: { head: { pitch_min: -40, pitch_max: 40, yaw_min: -80, yaw_max: 80, roll_min: -30, roll_max: 30 } } };
  const proc = buildProceduralRig(fullBiped(), LIMITS);
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  proc.setLayer("crank", { parts: { head: [2.0, 0, 0] } });   // 2.0 rad ~= 114deg, far past the 40deg limit
  proc.update(0.016);
  const offDeg = angOff(bones.head, restHead) * 180 / Math.PI;
  assert.ok(offDeg <= 41, `head pitch CAPPED at its ~40deg limit, not 114deg (got ${offDeg.toFixed(1)}deg)`);
  assert.ok(offDeg > 38, `but still driven TO the limit, not zeroed (got ${offDeg.toFixed(1)}deg)`);
});

test("a role with NO limit entry keeps moving (cap only binds where a limit is advertised)", () => {
  const proc = buildProceduralRig(fullBiped(), {});   // empty limits -> nothing to enforce
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  proc.setLayer("free", { parts: { head: [0.5, 0, 0] } });
  proc.update(0.016);
  assert.ok(Math.abs(angOff(bones.head, restHead) - 0.5) < 0.02, "no limit -> the 0.5 offset passes through unclamped");
});

// SUM+CAP (#4, the compositor's core): two SUB-limit same-role layers must SUM and the SUMMED offset is
// clamped ONCE to the joint limit — NOT clamped per layer (which would let the pair reach ~2x the cap).
// Head pitch limit = 40deg (~0.698rad); two layers of 0.6rad each sum to 1.2rad and must cap at ~0.698,
// proving the cap binds on the SUM, not on each layer (per-layer caps would each pass 0.6 -> compose ~1.2).
test("two SUB-limit same-role layers SUM then cap ONCE at the joint limit (not 2x, not per-layer)", () => {
  const LIMITS = { bones: { head: { pitch_min: -40, pitch_max: 40, yaw_min: -80, yaw_max: 80, roll_min: -30, roll_max: 30 } } };
  const proc = buildProceduralRig(fullBiped(), LIMITS);
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  proc.setLayer("a", { parts: { head: [0.6, 0, 0] } });   // each 0.6rad ~= 34deg, individually UNDER the 40deg cap
  proc.setLayer("b", { parts: { head: [0.6, 0, 0] } });
  proc.update(0.016);
  const offDeg = angOff(bones.head, restHead) * 180 / Math.PI;
  assert.ok(offDeg <= 41, `SUMMED 1.2rad capped to ~40deg, NOT ~69deg (got ${offDeg.toFixed(1)}deg)`);
  assert.ok(offDeg > 38, `but driven TO the cap (the sum exceeds it), not to one layer's 34deg (got ${offDeg.toFixed(1)}deg)`);
});

// FLEX-CHANNEL CAP (#3): the flex channel must consult the joint-limit table too (flexion -> the role's
// PITCH limit), not just the +-2.2rad safety net. left_shin's range is -140..0 deg; a +0.5rad (forward,
// out of [-140,0]) flex must clamp to ~0, and a -3.0rad (past -140) flex must clamp to ~-140deg.
test("a flex-channel layer is capped at the role's joint range, not just +-2.2rad", () => {
  const LIMITS = { bones: { left_shin: { pitch_min: -140, pitch_max: 0, yaw_min: -5, yaw_max: 5, roll_min: -5, roll_max: 5 } } };
  const proc = buildProceduralRig(fullBiped(), LIMITS);
  const bones = proc.roles();
  proc.update(0.016);                                   // base frame: shin at rest
  const shinBase = bones.left_shin.quaternion.clone();
  proc.setLayer("overbend", { flex: { left_shin: [-3.0, 0] } });   // 3.0rad ~= 172deg, far past the 140deg range
  proc.update(0.016);
  const offDeg = angOff(bones.left_shin, shinBase) * 180 / Math.PI;
  assert.ok(offDeg <= 141, `shin flex CAPPED at its 140deg range, not 172deg (got ${offDeg.toFixed(1)}deg)`);
  assert.ok(offDeg > 130, `but driven to the range edge, not zeroed (got ${offDeg.toFixed(1)}deg)`);
  // and a flex INTO the forbidden direction (positive, outside [-140,0]) clamps toward 0
  proc.setLayer("overbend", { flex: { left_shin: [0.5, 0] } });
  proc.update(0.016);
  const fwdDeg = angOff(bones.left_shin, shinBase) * 180 / Math.PI;
  assert.ok(fwdDeg < 5, `a +0.5rad flex (outside the -140..0 range) clamps to ~0 (got ${fwdDeg.toFixed(1)}deg)`);
});

// VELOCITY CLAMP (#28, user decision): a large one-frame target DELTA is rate-limited to ~speed_limit*dt
// (deg/s from bone_limits.json), and the target is REACHED after enough frames (velocity-continuous, not
// a deadlock). head speed_limit = 90 deg/s; over a 1/60s frame the step is ~1.5deg (~0.026rad).
test("a large per-frame delta is rate-limited to speed_limit*dt, then reached over frames", () => {
  const SPEED = 90;   // deg/s for head (matches bone_limits.json)
  const LIMITS = { default: { speed_limit: SPEED }, bones: { head: { pitch_min: -180, pitch_max: 180, yaw_min: -180, yaw_max: 180, roll_min: -180, roll_max: 180, speed_limit: SPEED } } };
  const proc = buildProceduralRig(fullBiped(), LIMITS);
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  const dt = 1 / 60;
  const stepRad = SPEED * (Math.PI / 180) * dt;          // ~0.0262 rad/frame
  proc.setLayer("snap", { parts: { head: [0.6, 0, 0] } });   // target 0.6rad in ONE command
  proc.update(dt);
  const f1 = angOff(bones.head, restHead);
  assert.ok(Math.abs(f1 - stepRad) < stepRad * 0.25, `frame 1 advanced ONE speed-limited step (~${stepRad.toFixed(4)}rad, got ${f1.toFixed(4)})`);
  for (let i = 0; i < 60; i++) proc.update(dt);          // give it ~1s to ease the rest of the way
  const settled = angOff(bones.head, restHead);
  assert.ok(Math.abs(settled - 0.6) < 0.02, `target reached after enough frames (got ${settled.toFixed(3)}rad, want 0.6)`);
  // a STILL pose (delta 0) must not be re-clamped/deadlocked — it holds at 0.6 frame after frame
  proc.update(dt);
  assert.ok(Math.abs(angOff(bones.head, restHead) - 0.6) < 0.02, "a still target holds (delta 0 -> no clamp, no drift)");
});

// LAYER SPEED for DATA layers (#27): `speed` must be meaningful for a non-fn (data) layer too — it scales
// the env in-ramp rate. speed 2 reaches a given env fraction in HALF the time of speed 1.
test("layer 'speed' scales a DATA layer's env ramp (not just fn-layer time)", () => {
  const mk = (speed) => {
    const proc = buildProceduralRig(fullBiped(), {});
    const bones = proc.roles();
    const restHead = bones.head.quaternion.clone();
    proc.setLayer("ramp", { parts: { head: [0.4, 0, 0] }, dur: 10, env: [1.0, 1.0], speed });   // 1s in-ramp at speed 1
    proc.update(0.10);                                   // sample early in the ramp
    return angOff(bones.head, restHead);
  };
  const slow = mk(1), fast = mk(2);
  assert.ok(fast > slow + 0.02, `speed 2 ramps the env in faster than speed 1 (fast ${fast.toFixed(3)} > slow ${slow.toFixed(3)})`);
});

// ===== BOUNDARY GUARDS (audit 2026-06-26): a bad layer off the bus must degrade honestly, never
// kill the frame or permanently brick a bone. These lock the fixes proven by probe. =====
const qFinite = (b) => [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w].every(Number.isFinite);

test("GUARD: a THROWING fn layer drops ITSELF and the frame survives (siblings keep driving)", () => {
  const proc = buildProceduralRig(fullBiped(), {});
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  proc.setLayer("bad", { fn: () => { throw new Error("boom"); } });
  proc.setLayer("good", { parts: { head: [0.3, 0, 0] } });
  assert.doesNotThrow(() => proc.update(0.016), "a throwing fn must not throw out of update() (which would freeze every bone)");
  assert.ok(angOff(bones.head, restHead) > 0.2, "the sibling 'good' layer still drove the head");
  assert.ok(!proc.layerIds().includes("bad"), "the throwing layer removed itself");
});

test("GUARD: an fn returning a stringly/NaN part never bricks a bone (additive mode included)", () => {
  const proc = buildProceduralRig(fullBiped(), {});
  const bones = proc.roles();
  proc.setLayer("poison", { fn: () => ({ parts: { head: ["x", NaN, 0] } }) });
  for (let i = 0; i < 5; i++) proc.update(0.016, false, { additive: true });   // additive = the unrecoverable path the audit found
  assert.ok(qFinite(bones.head), "head quaternion stays finite through a stringly/NaN fn output");
  proc.setLayer("poison", null);
  for (let i = 0; i < 5; i++) proc.update(0.016, false, { additive: true });
  assert.ok(qFinite(bones.head), "head still finite after clearing the bad layer (no NaN persisted in _vstate)");
});

test("GUARD: speed_limit:0 is INERT (Infinity), it does not FREEZE the role", () => {
  const proc = buildProceduralRig(fullBiped(), { head: { speed_limit: 0, pitch: 120, yaw: 120, roll: 120 } });
  const bones = proc.roles();
  const restHead = bones.head.quaternion.clone();
  proc.setLayer("a", { parts: { head: [0.3, 0, 0] } });
  for (let i = 0; i < 30; i++) proc.update(0.016);
  assert.ok(angOff(bones.head, restHead) > 0.2, "head reached its target despite a 0 speed_limit (was frozen at 0 before the fix)");
});
