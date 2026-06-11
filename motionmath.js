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

// --- idle v4 primitives (research-backed living-idle math) -------------------
// Exact critically-damped spring step (theorangeduck "spring-roll-call" formulation): chases `goal`,
// halving the remaining distance roughly every `halflife` seconds, PRESERVING velocity — retargeting
// mid-motion is seamless (a fixed-duration ease restarts with a velocity discontinuity = the visible
// POP). Closed-form, so stepping is exact and frame-rate independent. s = {x, v}, mutated + returned.
export function dampSpring(s, goal, halflife, dt) {
  const y = (2 * 0.6931472) / (halflife + 1e-5);     // 2·ln2/h — critical damping for that halflife
  const j0 = s.x - goal, j1 = s.v + j0 * y;
  const eydt = Math.exp(-y * dt);
  s.x = eydt * (j0 + j1 * dt) + goal;
  s.v = eydt * (s.v - j1 * y * dt);
  return s;
}

// Deterministic 1D gradient noise (Perlin-style: hashed lattice gradients + quintic fade), smooth,
// ≈[-1,1], zero-mean. Sines alone LOOP (reads repetitive); gradient noise never visibly repeats.
function _gh(i) { let h = (i | 0) * 374761393; h = (h ^ (h >>> 13)) * 1274126177; h ^= h >>> 16; return ((h & 0xffff) / 0x8000) - 1; }
export function noise1(t) {
  const i = Math.floor(t), f = t - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);       // quintic fade — C2-continuous at lattice points
  const g0 = _gh(i) * f, g1 = _gh(i + 1) * (f - 1);
  return (g0 + (g1 - g0) * u) * 2;
}

// 2-octave fractal noise with a NON-HARMONIC octave ratio (2.7) and a per-channel seed: joints driven
// from different seeds never sync (a shared clock is THE robotic tell) and the sum never loops.
export function fnoise(t, seed = 0) { return noise1(t + seed * 127.1) * 0.667 + noise1(t * 2.7 + seed * 311.7 + 17.3) * 0.333; }

// Jittered event interval — base ±frac (default ±50%): a fixed cadence (weight shift every N s sharp)
// itself reads as mechanical. `rnd` injectable for deterministic tests.
export function jitter(base, frac = 0.5, rnd = Math.random) { return base * (1 - frac + 2 * frac * rnd()); }
