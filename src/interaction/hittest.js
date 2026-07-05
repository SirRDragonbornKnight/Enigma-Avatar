// @ts-check
//
// Pure click-through hit-test math (no THREE, no DOM, no GPU).
//
// SAFETY-CRITICAL. These functions decide when the transparent overlay captures a
// click vs. lets it fall through to the desktop. The cardinal rule is FAIL-OPEN: any
// degenerate / unknown render state must resolve to "not over" (click passes through),
// never to "over" (overlay eats the click). The GPU readback and the world->screen
// projection live in avatar.js (the impure adapter); the *decisions* live here so they
// can be unit-tested headlessly. See tests/hittest.test.js.

/**
 * Derive the silhouette mask from an RGBA pixel readback of the model.
 *
 * Marks `outMask[i] = 1` wherever alpha > `alphaThreshold`. Returns `ok: false`
 * (caller must treat the mask as absent -> fail-open fallback) when the model covers
 * nothing, or covers MORE than `maxCoverage` of the buffer (a corrupted/degenerate
 * render that would otherwise blanket the screen and block every click).
 *
 * `outMask` is caller-owned and reused across passes (zero-alloc hot path); it is
 * fully overwritten here, so its prior contents do not matter.
 *
 * @param {Uint8Array|Uint8ClampedArray} buf  RGBA bytes, length >= SW*SH*4, bottom-left origin.
 * @param {number} SW  buffer width in pixels.
 * @param {number} SH  buffer height in pixels.
 * @param {Uint8Array} outMask  reusable mask buffer, length >= SW*SH.
 * @param {{ alphaThreshold?: number, maxCoverage?: number }} [opts]
 * @returns {{ ok: boolean, coverage: number, bbox: [number,number,number,number]|null }}
 *   bbox is [minX, minY, maxX, maxY] in mask cells (inclusive); null when !ok.
 */
export function buildSilhouette(buf, SW, SH, outMask, opts = {}) {
  const alphaThreshold = opts.alphaThreshold ?? 24;
  const maxCoverage = opts.maxCoverage ?? 0.85;
  const n = SW * SH;
  outMask.fill(0, 0, n); // reused buffer -> clear last pass's bits before re-marking
  let mnx = 1e9,
    mny = 1e9,
    mxx = -1,
    mxy = -1,
    count = 0;
  for (let i = 0, p = 3; i < n; i++, p += 4) {
    if (buf[p] > alphaThreshold) {
      outMask[i] = 1;
      count++;
      const x = i % SW,
        y = (i / SW) | 0;
      if (x < mnx) mnx = x;
      if (x > mxx) mxx = x;
      if (y < mny) mny = y;
      if (y > mxy) mxy = y;
    }
  }
  const coverage = count / n;
  // Empty, or near-fully opaque (corrupted render) -> fail-safe: no usable mask. A legit
  // large-but-SHAPED avatar keeps its precise mask, so the gaps around her still click through.
  if (!count || coverage > maxCoverage) return { ok: false, coverage, bbox: null };
  return { ok: true, coverage, bbox: [mnx, mny, mxx, mxy] };
}

/**
 * Is the cursor over the avatar's pixel silhouette (within a small grab tolerance)?
 *
 * @param {number} cx  cursor x in window px (top-left origin).
 * @param {number} cy  cursor y in window px (top-left origin).
 * @param {{
 *   mask: Uint8Array|null,
 *   maskW: number,
 *   maskH: number,
 *   innerWidth: number,
 *   innerHeight: number,
 *   tolerancePx?: number,
 * }} view
 * @returns {boolean}  false whenever the mask is absent (fail-open).
 */
export function overSilhouette(cx, cy, view) {
  const { mask, maskW, maskH, innerWidth, innerHeight } = view;
  if (!mask || maskW <= 0 || maskH <= 0 || innerWidth <= 0 || innerHeight <= 0) return false;
  const tolerancePx = view.tolerancePx ?? 8;
  const bx = Math.floor((cx / innerWidth) * maskW);
  const by = Math.floor((1 - cy / innerHeight) * maskH); // flip Y: mask is bottom-left origin
  const r = Math.max(1, Math.round((tolerancePx * maskW) / innerWidth)); // grab tolerance in mask cells
  for (let dy = -r; dy <= r; dy++) {
    const yy = by + dy;
    if (yy < 0 || yy >= maskH) continue;
    const row = yy * maskW;
    for (let dx = -r; dx <= r; dx++) {
      const xx = bx + dx;
      if (xx < 0 || xx >= maskW) continue;
      if (mask[row + xx]) return true;
    }
  }
  return false;
}

/**
 * Fail-safe fallback when no silhouette is available (empty / off-screen / corrupted
 * render). Exposes only a SMALL central grab handle around the body, hard-capped so it
 * can never eat the screen. If the avatar does not project onto this window at all,
 * nothing here is grabbable -> click-through (this is also what keeps PEER monitors
 * click-through while she lives on another screen).
 *
 * All coordinates are already projected to THIS window's screen px by the caller.
 *
 * @param {{
 *   cxp: number, cyp: number,   // avatar base, projected to screen px
 *   edgeX: number,              // projected x of (base + halfWidth) — width probe
 *   topY: number,               // projected y of the top of the body
 *   innerWidth: number, innerHeight: number,
 *   cursorX: number, cursorY: number,
 *   minHalfW?: number, maxHalfW?: number, marginPx?: number,
 * }} a
 * @returns {{ over: boolean, rect: [number,number,number,number] }}
 */
export function fallbackGrabHandle(a) {
  const margin = a.marginPx ?? 40;
  const iw = a.innerWidth,
    ih = a.innerHeight;
  if (a.cxp < -margin || a.cxp > iw + margin || a.cyp < -margin || a.cyp > ih + margin) {
    return { over: false, rect: [0, 0, 0, 0] };
  }
  const halfW = Math.min(a.maxHalfW ?? 80, Math.max(a.minHalfW ?? 28, Math.abs(a.edgeX - a.cxp)));
  let mny = Math.min(a.topY, a.cyp),
    mxy = Math.max(a.topY, a.cyp + 30);
  // never taller than 60% of the window — and keep the BASE-side segment: a giant avatar's top
  // projects far above the window, and capping from the top used to leave the whole handle
  // off-screen (over-coverage fail-safe -> no mask -> handle off-glass = totally unclickable)
  if (mxy - mny > ih * 0.6) mny = mxy - ih * 0.6;
  const mnx = a.cxp - halfW,
    mxx = a.cxp + halfW;
  const over = a.cursorX >= mnx && a.cursorX <= mxx && a.cursorY >= mny && a.cursorY <= mxy;
  return { over, rect: [mnx, mny, mxx, mxy] };
}
