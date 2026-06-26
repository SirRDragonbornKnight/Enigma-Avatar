// motionmath.js — pure, dependency-free motion math. Extracted so the SHAPE of a motion is unit-testable
// in node without three.js / a renderer. Imported by avatar.js (coSpeechPose) and conjure.js (popScale,
// floatBob, easeInOut); tested by motionmath.test.js.

// Symmetric ease-in-out on [0,1] (0→0, 1→1, 0.5→0.5). Used for conjure glide / poof timing.
export const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

// coSpeechPose (P2): gentle, speech-driven body emphasis layered WHILE talking. Returns additive role
// offsets scaled by the live speech loudness `rms` (0 = silent -> STILL, per the no-idle rule; louder ->
// bigger emphasis). t = absolute layer time (s). L/R arms are phase-offset so the two never mirror.
// Pure (no three.js) so the SHAPE is unit-testable headless; avatar.js feeds it a smoothed envelope.
export function coSpeechPose(t, rms) {
  const a = Math.max(0, Math.min(1, rms || 0));
  if (a < 1e-3) return { parts: {}, flex: {} };       // silent -> emit nothing (deliberate stillness)
  return {
    parts: {
      head:  [Math.sin(t * 7.5) * 0.07 * a, Math.sin(t * 3.1) * 0.05 * a, 0],   // beat nod + slower yaw sway
      chest: [Math.sin(t * 7.5) * 0.035 * a, 0, 0],                             // subtle chest pitch with the nod
    },
    flex: {
      left_arm:  [Math.sin(t * 5.0) * 0.11 * a, 0],          // alternating arm emphasis...
      right_arm: [Math.sin(t * 5.0 + 2.3) * 0.10 * a, 0],    // ...phase-offset, never mirrored
    },
  };
}

// popScale (P3 conjure): cartoon "poof in" scale on [0,1] — 0 -> 1 with a slight overshoot past 1
// (easeOutBack) so a conjured object pops into being. Use popScale(1-p) for the "poof out" dismiss.
export function popScale(p) {
  const x = Math.max(0, Math.min(1, p));
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

// floatBob (P3 conjure): gentle vertical hover offset for a conjured object idling in the air.
export function floatBob(t, amp = 0.04) { return Math.sin(t * 2.0) * amp; }

// (The idle-v4 primitives — dampSpring / gradient noise / jittered timers — lived here, along with the
//  gesture/clip shaping math (bell, jumpElevation). ALL deleted with the idle + gesture/clip purges.)
