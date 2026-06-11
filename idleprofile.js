// idleprofile.js — PER-MODEL idle personalities (the 2026-06-11 pivot).
//
// The universal always-on idle is GONE: procedural.js ships every idle layer at ZERO —
// the engine is a toolbox, not a personality. A model's profiles.json `idle` block is the
// ONLY source of idle life. It is seeded ONCE from what that model actually HAS (legs →
// weight shifts, a tail → tail fidgets, a bare robot head → slow glances, no skeleton →
// nothing) and then tuned INDIVIDUALLY (Settings → Idle, bus `tune`). "Each avatar has
// different things they do" — the user's ruling; one idle fit no body plan.
//
// Reactive channels are NOT idle and stay live regardless of the profile: cursor-look,
// gestures/emotes, speech lip-sync, spring physics responding to motion, grab/grip.
//
// Pure data-in/data-out (no three.js) so it unit-tests headless.

// The reference "humanoid alive" numbers — the old universal defaults, kept as the seed
// BASIS for capable rigs (research-derived: breath 0.27 Hz, sway ~0.7°, shifts ~13 s).
export const LIVE = {
  breathe: 0.045, breatheRate: 1.7, look: 0.17, elbowFlex: 0.10, drift: 1.0,
  swayAmp: 0.012, wrist: 0.06, shiftEvery: 13, poseEvery: 38, ambient: 1.0,
  armLife: 1.0, fidgetEvery: 9,
};

// What an UNPROFILED model does: nothing. (drift/breatheRate are a multiplier and a rate —
// they shape other amplitudes and are harmless at their natural values.)
export const DEAD = {
  breathe: 0, breatheRate: 1.7, look: 0, elbowFlex: 0, drift: 1.0,
  swayAmp: 0, wrist: 0, shiftEvery: 0, poseEvery: 0, ambient: 0,
  armLife: 0, fidgetEvery: 0, fidgetRegions: [],
};

const FIDGETABLE = ["tail", "ear", "wing", "hair"];   // the safe-appendage set maybeFidget kicks (never NSFW)

// caps: { roles: string[], regions: string[], boneCount: number, facialMode?: string }
// Returns a DISTINCT personality per capability class — a wolf with a tail, a robot with
// only a head, and a statue each get their own (statue: stays perfectly still).
export function seedIdleProfile(caps = {}) {
  const roles = caps.roles || [];
  const regions = caps.regions || [];
  const has = (r) => roles.includes(r);
  const p = { ...DEAD, _seed: 1 };                    // _seed marks "this profile was generated" (and its recipe version)
  if (!(caps.boneCount > 0)) return p;                // no skeleton (valkyrie/bunny-robot are statues): nothing to animate

  const humanoid = roles.length >= 12;                // enough of a biped to read body language
  const torso = has("chest") || has("spine");
  const legs = has("left_leg") && has("right_leg");
  const arms = has("left_arm") && has("right_arm");
  const headish = has("head") || has("neck");

  if (torso) p.breathe = humanoid ? LIVE.breathe : 0.03;          // visible breath needs a torso
  if (headish) p.look = LIVE.look;                                // idle glances need a head
  if (humanoid) { p.swayAmp = LIVE.swayAmp; p.wrist = LIVE.wrist; p.armLife = LIVE.armLife; }
  if (legs && humanoid) p.shiftEvery = LIVE.shiftEvery;           // contrapposto needs legs
  if (arms && humanoid) { p.poseEvery = LIVE.poseEvery; p.elbowFlex = LIVE.elbowFlex; }
  // ambient micro-life scales with rig density: a 600-bone body hums, a sparse robot servo-idles
  p.ambient = caps.boneCount > 40 ? 1.0 : caps.boneCount > 8 ? 0.6 : 0.35;
  const fidgety = FIDGETABLE.filter((r) => regions.includes(r));
  if (fidgety.length) { p.fidgetEvery = LIVE.fidgetEvery; p.fidgetRegions = fidgety; }
  return p;
}
