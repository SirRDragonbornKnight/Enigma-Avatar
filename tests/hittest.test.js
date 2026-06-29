// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSilhouette, overSilhouette, fallbackGrabHandle } from "../src/interaction/hittest.js";

// Build an RGBA buffer (bottom-left origin) of size SW*SH with alpha set to `a`
// at every (x,y) for which inside(x,y) is true, else 0.
/**
 * @param {number} SW
 * @param {number} SH
 * @param {(x: number, y: number) => boolean} inside
 * @param {number} [a]
 */
function rgba(SW, SH, inside, a = 255) {
  const buf = new Uint8Array(SW * SH * 4);
  for (let i = 0, p = 3; i < SW * SH; i++, p += 4) {
    const x = i % SW,
      y = (i / SW) | 0;
    if (inside(x, y)) buf[p] = a;
  }
  return buf;
}

test("buildSilhouette: empty render -> ok:false (fail-open, no mask)", () => {
  const SW = 8,
    SH = 8;
  const buf = rgba(SW, SH, () => false);
  const out = new Uint8Array(SW * SH);
  const r = buildSilhouette(buf, SW, SH, out);
  assert.equal(r.ok, false);
  assert.equal(r.coverage, 0);
  assert.equal(r.bbox, null);
});

test("buildSilhouette: a shaped blob yields mask + inclusive bbox", () => {
  const SW = 10,
    SH = 10;
  // a 3x2 block: x in [2,4], y in [5,6]
  const buf = rgba(SW, SH, (x, y) => x >= 2 && x <= 4 && y >= 5 && y <= 6);
  const out = new Uint8Array(SW * SH);
  const r = buildSilhouette(buf, SW, SH, out);
  assert.equal(r.ok, true);
  assert.deepEqual(r.bbox, [2, 5, 4, 6]);
  assert.equal(out[5 * SW + 2], 1); // a marked cell
  assert.equal(out[0], 0); // an unmarked cell
  assert.ok(Math.abs(r.coverage - 6 / 100) < 1e-9);
});

test("buildSilhouette: over-coverage corrupted render -> ok:false (fail-open)", () => {
  const SW = 10,
    SH = 10;
  const buf = rgba(SW, SH, () => true); // 100% coverage
  const out = new Uint8Array(SW * SH);
  const r = buildSilhouette(buf, SW, SH, out);
  assert.equal(r.ok, false, "a screen-blanketing render must not produce a usable mask");
  assert.equal(r.coverage, 1);
});

test("buildSilhouette: respects maxCoverage and alphaThreshold", () => {
  const SW = 10,
    SH = 10;
  const halfFull = rgba(SW, SH, (x) => x < 5); // 50%
  const out = new Uint8Array(SW * SH);
  assert.equal(buildSilhouette(halfFull, SW, SH, out, { maxCoverage: 0.4 }).ok, false);
  assert.equal(buildSilhouette(halfFull, SW, SH, out, { maxCoverage: 0.6 }).ok, true);

  const faint = rgba(SW, SH, (x, y) => x === 0 && y === 0, 20); // alpha 20
  assert.equal(buildSilhouette(faint, SW, SH, out, { alphaThreshold: 24 }).ok, false);
  assert.equal(buildSilhouette(faint, SW, SH, out, { alphaThreshold: 10 }).ok, true);
});

test("buildSilhouette: reused outMask is fully cleared between passes (zero-alloc)", () => {
  const SW = 6,
    SH = 6;
  const out = new Uint8Array(SW * SH);
  buildSilhouette(rgba(SW, SH, () => true), SW, SH, out); // fill everything (ok:false but mask written)
  const r2 = buildSilhouette(rgba(SW, SH, (x, y) => x === 1 && y === 1), SW, SH, out);
  assert.equal(r2.ok, true);
  // only (1,1) should remain marked; stale bits from pass 1 must be gone
  let marked = 0;
  for (const v of out) marked += v;
  assert.equal(marked, 1);
  assert.equal(out[1 * SW + 1], 1);
});

test("overSilhouette: absent mask -> false (fail-open)", () => {
  const v = { mask: null, maskW: 0, maskH: 0, innerWidth: 100, innerHeight: 100 };
  assert.equal(overSilhouette(50, 50, v), false);
});

test("overSilhouette: hit vs miss with Y-flip", () => {
  const SW = 10,
    SH = 10;
  const mask = new Uint8Array(SW * SH);
  // mark a single cell at mask (x=5, y=8) (bottom-left origin)
  mask[8 * SW + 5] = 1;
  const v = { mask, maskW: SW, maskH: SH, innerWidth: 100, innerHeight: 100, tolerancePx: 0 };
  // mask y=8 (from bottom) maps to screen-top y ~ (1 - 8.x/10)*100. cell center y=8 -> by floor((1-cy/100)*10)=8 => cy in [10,20)
  assert.equal(overSilhouette(55, 15, v), true); // over the marked cell
  assert.equal(overSilhouette(55, 85, v), false); // bottom of screen -> empty
  assert.equal(overSilhouette(5, 15, v), false); // wrong column
});

test("overSilhouette: grab tolerance pulls a near pixel into range", () => {
  const SW = 100,
    SH = 100;
  const mask = new Uint8Array(SW * SH);
  mask[50 * SW + 50] = 1;
  // cursor a few px off the lone pixel; with an 8px tolerance it should still register
  const v = { mask, maskW: SW, maskH: SH, innerWidth: 100, innerHeight: 100, tolerancePx: 8 };
  assert.equal(overSilhouette(50, 49, v), true);
  const tight = { ...v, tolerancePx: 0 };
  assert.equal(overSilhouette(53, 46, tight), false); // no tolerance, a few cells away -> miss
});

test("fallbackGrabHandle: avatar off this window -> click-through", () => {
  const r = fallbackGrabHandle({
    cxp: -500, cyp: 50, edgeX: -450, topY: 0,
    innerWidth: 800, innerHeight: 600, cursorX: 10, cursorY: 10,
  });
  assert.equal(r.over, false);
  assert.deepEqual(r.rect, [0, 0, 0, 0]);
});

test("fallbackGrabHandle: width clamped to maxHalfW, cursor at center is over", () => {
  // huge width probe -> clamped to maxHalfW (80); realistic head-above-feet topY
  const r = fallbackGrabHandle({
    cxp: 400, cyp: 500, edgeX: 4000, topY: 200,
    innerWidth: 800, innerHeight: 600, cursorX: 400, cursorY: 500,
  });
  const [mnx, , mxx] = r.rect;
  assert.equal(mxx - mnx, 160, "width capped at 2*maxHalfW");
  assert.equal(r.over, true, "cursor at the center is over the handle");
});

test("fallbackGrabHandle: handle height is capped at 60% of the window", () => {
  const ih = 600;
  // topY far above the base would make a 480px-tall handle; must clamp to 360 (60%)
  const r = fallbackGrabHandle({
    cxp: 400, cyp: 500, edgeX: 450, topY: 50,
    innerWidth: 800, innerHeight: ih, cursorX: 400, cursorY: 500,
  });
  const [, mny, , mxy] = r.rect;
  assert.equal(mxy - mny, ih * 0.6, "height capped at exactly 60% of window");
  assert.equal(mny, 50, "handle anchors to the top (mny), so the cap trims the bottom");
});

test("fallbackGrabHandle: tiny width probe is floored to minHalfW", () => {
  const r = fallbackGrabHandle({
    cxp: 400, cyp: 300, edgeX: 401, topY: 280,
    innerWidth: 800, innerHeight: 600, cursorX: 800, cursorY: 300,
  });
  assert.equal(r.rect[2] - r.rect[0], 56, "width floored at 2*minHalfW (28)");
  assert.equal(r.over, false, "cursor far to the right is outside the small handle");
});
