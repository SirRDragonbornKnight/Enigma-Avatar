// motionmath.js — pure, dependency-free motion math shared by the procedural clips (bell / ease) and
// the avatar root motion (jump elevation). Extracted so the SHAPE of a motion is unit-testable in node
// without three.js / a renderer. Imported by procedural.js and avatar.js; tested by motionmath.test.js.

// Smooth gaussian pulse, 1 at x===c, decaying with width w. Used to weight motion sub-phases (crouch,
// launch, air, land) so the clip blends instead of snapping between keys.
export const bell = (x, c, w) => Math.exp(-((x - c) * (x - c)) / (2 * w * w));

// Symmetric ease-in-out on [0,1] (0→0, 1→1, 0.5→0.5). Used for whole-body tweens (flip spin, lay-down tip).
export const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

// Jump root elevation (in pos-units, relative to the standing baseY) at phase p∈[0,1] for jump height h.
// A squash-and-stretch that READS FROM THE FRONT (a forward leg-crouch foreshortens head-on): the body
// SINKS during the coil (crouch dip), springs up after the launch to ~apex h, ABSORBS on landing (land
// dip), then settles back to 0. h itself is scaled by the model's visible height by the caller.
export function jumpElevation(p, h) {
  const crouchDip = Math.exp(-Math.pow((p - 0.15) / 0.1, 2)) * h * 0.30;          // sink on the coil
  const landDip   = Math.exp(-Math.pow((p - 0.83) / 0.08, 2)) * h * 0.17;         // absorb on landing
  const lift      = Math.max(0, Math.sin(Math.max(0, (p - 0.2) / 0.8) * Math.PI)) * h;   // rise only AFTER the launch
  return lift - crouchDip - landDip;
}

// (The idle-v4 primitives — dampSpring / gradient noise / jittered timers — lived here. DELETED
//  with the whole idle system, user order 2026-06-12: "delete the idle animation everywhere and
//  anything that has to do with it". bell / easeInOut / jumpElevation above are GESTURE math.)
