// @ts-check
//
// Pure cursor-look / eye-look math (no THREE, no DOM). avatar.js's updateLook/driveEyes/resolveEyes
// apply these to bones; the angle/target/classification decisions live here so they're unit-testable.
// Part of the avatar.js decomposition. See tests/look.test.js.

/**
 * @param {number} v
 * @param {number} a
 * @param {number} b
 */
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

/** @typedef {{ gainX: number, gainY: number, flipX: number, flipY: number, maxX: number, maxY: number }} HeadLookCfg */
/** @typedef {{ gain: number, flipX: number, flipY: number, maxX: number, maxY: number }} EyeLookCfg */

/**
 * Head/neck cursor-tracking target: how far to turn toward the cursor, as clamped, gained, flipped
 * fractions of the viewport. `headX/headY` is the head's on-screen position (px); the offset to the
 * cursor is normalized by the viewport, scaled by per-axis gain/flip, then clamped to the max swing.
 *
 * @param {number} cursorX
 * @param {number} cursorY
 * @param {number} headX
 * @param {number} headY
 * @param {number} vw  viewport width (px)
 * @param {number} vh  viewport height (px)
 * @param {HeadLookCfg} cfg
 * @returns {[number, number]}  [tx, ty]
 */
export function headLookTarget(cursorX, cursorY, headX, headY, vw, vh, cfg) {
  const tx = clampN(((cursorX - headX) / vw) * cfg.gainX * cfg.flipX, -cfg.maxX, cfg.maxX);
  const ty = clampN(((cursorY - headY) / vh) * cfg.gainY * cfg.flipY, -cfg.maxY, cfg.maxY);
  return [tx, ty];
}

/**
 * Eye-look angles (radians) from a normalized look vector (lx, ly) and a weight `w`. Gained, clamped
 * to the per-axis max, then flipped per the rig's eye sign convention.
 *
 * @param {number} lx
 * @param {number} ly
 * @param {EyeLookCfg} cfg
 * @param {number} w  weight 0..1
 * @returns {{ yaw: number, pitch: number }}
 */
export function eyeLookAngles(lx, ly, cfg, w) {
  const yaw = clampN(lx * cfg.gain, -cfg.maxX, cfg.maxX) * cfg.flipX * w;
  const pitch = clampN(ly * cfg.gain, -cfg.maxY, cfg.maxY) * cfg.flipY * w;
  return { yaw, pitch };
}

/**
 * Classify a bone name as the Right / Left / Center eye by the side tokens embedded in rig names.
 * (Trust no local axis, but the L/R tokens are reliable across the rigs tested.)
 *
 * @param {unknown} name
 * @returns {"R" | "L" | "C"}
 */
export function eyeSide(name) {
  const s = String(name).toLowerCase();
  if (/right|_r_|_r\b|\.r_|\.r\b|^r_|r_?eye/.test(s)) return "R";
  if (/left|_l_|_l\b|\.l_|\.l\b|^l_|l_?eye/.test(s)) return "L";
  return "C";
}
