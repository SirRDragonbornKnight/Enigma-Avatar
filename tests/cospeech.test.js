// P2 co-speech motion — the pure, speech-driven body emphasis used by the "cospeech" layer.
// coSpeechPose(t, rms) returns additive role offsets scaled by live loudness. Headless + deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coSpeechPose } from "../src/motion/motionmath.js";

test("silence => stillness (no offsets at all)", () => {
  const o = coSpeechPose(1.0, 0);
  assert.deepEqual(o.parts, {});
  assert.deepEqual(o.flex, {});
});

// INTENT, not an implementation snapshot: co-speech is a SUBTLE beat-emphasis layer — the body
// keeps time while talking; the big, Filian-exaggerated motion comes from DELIBERATE pose layers,
// not from chatter. So at full volume it must (a) actually move, yet (b) stay under a gentle cap.
// The cap is a tunable FEEL choice (raise it for a more animated talker), not a frozen constant.
test("loud speech => actually moves, but stays a gentle beat-emphasis (tunable cap)", () => {
  const HEAD_CHEST_CAP = 0.12,
    ARM_CAP = 0.13; // ~7deg at peak loudness — deliberate; dial up for a livelier talker
  for (let t = 0; t < 4; t += 0.13) {
    const o = coSpeechPose(t, 1);
    for (const r of ["head", "chest"])
      if (o.parts[r])
        for (const v of o.parts[r]) assert.ok(Math.abs(v) <= HEAD_CHEST_CAP, `${r} stays a beat-emphasis, not a flail`);
    for (const r of ["left_arm", "right_arm"])
      assert.ok(Math.abs(o.flex[r][0]) <= ARM_CAP, `${r} stays a beat-emphasis, not a flail`);
  }
  const peakNod = Math.max(...Array.from({ length: 40 }, (_, i) => Math.abs(coSpeechPose(i * 0.05, 1).parts.head[0])));
  assert.ok(peakNod > 0.03, "the head ACTUALLY nods at full volume (not a dead bound)");
});

test("amplitude scales linearly with rms", () => {
  const t = 0.4;
  const full = coSpeechPose(t, 1).parts.head[0];
  const half = coSpeechPose(t, 0.5).parts.head[0];
  assert.ok(Math.abs(half - full * 0.5) < 1e-9, "half the loudness => half the motion");
});

test("L/R arms are phase-offset, never mirrored", () => {
  let maxDiff = 0;
  for (let t = 0; t < 3; t += 0.07) {
    const o = coSpeechPose(t, 1);
    maxDiff = Math.max(maxDiff, Math.abs(o.flex.left_arm[0] - o.flex.right_arm[0]));
  }
  assert.ok(maxDiff > 0.05, "the two arms diverge (staggered, not a mirror)");
});

test("it oscillates over time", () => {
  const a = coSpeechPose(0.0, 1).parts.head[0];
  const b = coSpeechPose(0.2, 1).parts.head[0];
  assert.ok(Math.abs(a - b) > 1e-3, "head offset changes with t");
});
