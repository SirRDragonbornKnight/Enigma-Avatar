// @ts-check
//
// Pure placement / movement math (no THREE, no DOM, no live state). The stateful wrappers in
// avatar.js (glide, persistence, rendering the platform bars) call into these; the decisions —
// where a named anchor lands, which platform a point snaps to, what a platform list sanitizes to —
// live here so they're unit-testable. First module of the avatar.js decomposition. See tests/placement.test.js.

/** @typedef {{ x: number, y: number, width: number, height: number }} DisplayRect */
/** @typedef {{ gx: number, gy: number, w: number }} Platform */

/**
 * Resolve a named anchor to a GLOBAL [gx, gy] within `disp`, or null if the name is unknown.
 * Anchors sit a bit low (`low`) so the feet rest near the deck; `margin` is the edge inset.
 * Name matching is case-insensitive and ignores spaces / underscores / hyphens.
 *
 * @param {string} name  e.g. "center" / "topLeft" / "bottom-right" / "cursor".
 * @param {DisplayRect} disp  the display the avatar currently lives on.
 * @param {{ x: number, y: number }} cursorGlobal  the cursor in GLOBAL coords (for the "cursor" anchor).
 * @param {{ margin?: number, low?: number }} [opts]
 * @returns {[number, number] | null}
 */
export function resolveAnchor(name, disp, cursorGlobal, opts = {}) {
  const m = opts.margin ?? 0.12;
  const lo = opts.low ?? 0.62;
  const d = disp;
  const A = {
    center: [d.x + d.width / 2, d.y + d.height * lo],
    middle: [d.x + d.width / 2, d.y + d.height * lo],
    cursor: [cursorGlobal.x, cursorGlobal.y],
    left: [d.x + d.width * m, d.y + d.height * lo],
    right: [d.x + d.width * (1 - m), d.y + d.height * lo],
    top: [d.x + d.width / 2, d.y + d.height * m],
    bottom: [d.x + d.width / 2, d.y + d.height * (1 - m)],
    topleft: [d.x + d.width * m, d.y + d.height * m],
    topright: [d.x + d.width * (1 - m), d.y + d.height * m],
    bottomleft: [d.x + d.width * m, d.y + d.height * (1 - m)],
    bottomright: [d.x + d.width * (1 - m), d.y + d.height * (1 - m)],
  };
  const key = String(name || "")
    .toLowerCase()
    .replace(/[ _-]/g, "");
  return /** @type {[number,number]|undefined} */ (A[/** @type {keyof typeof A} */ (key)]) || null;
}

/**
 * The top (gy) of the nearest AI-placed platform under `gx`, within the snap `band`, or null.
 * Only platforms horizontally spanning `gx` are candidates; among those the closest in y within
 * the band wins. (Platforms are the ONLY snap targets — no screen-bottom floor snap, by design.)
 *
 * @param {number} gx
 * @param {number} gy
 * @param {Platform[]} platforms
 * @param {number} band  max vertical distance to snap (e.g. display height * 0.05).
 * @returns {number | null}
 */
export function nearestPlatformSurfaceY(gx, gy, platforms, band) {
  let best = null,
    bestDy = band;
  for (const pf of platforms) {
    if (gx < pf.gx - pf.w / 2 || gx > pf.gx + pf.w / 2) continue;
    const dy = Math.abs(gy - pf.gy);
    if (dy <= bestDy) {
      best = pf.gy;
      bestDy = dy;
    }
  }
  return best;
}

/**
 * Coerce an untrusted platform list to clean, finite entries: numeric coords, width floored to
 * `minW` (default 24, default 220), at most `max` (default 32) of them. Non-finite entries dropped.
 *
 * @param {unknown} list
 * @param {{ minW?: number, defW?: number, max?: number }} [opts]
 * @returns {Platform[]}
 */
export function sanitizePlatforms(list, opts = {}) {
  const minW = opts.minW ?? 24;
  const defW = opts.defW ?? 220;
  const max = opts.max ?? 32;
  return (Array.isArray(list) ? list : [])
    .map((p) => ({ gx: +p.gx, gy: +p.gy, w: Math.max(minW, +p.w || defW) }))
    .filter((p) => isFinite(p.gx) && isFinite(p.gy))
    .slice(0, max);
}
