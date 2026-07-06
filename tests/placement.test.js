// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAnchor, nearestPlatformSurfaceY, sanitizePlatforms } from "../src/interaction/placement.js";

const DISP = { x: 100, y: 200, width: 1000, height: 800 };
const CURSOR = { x: 555, y: 666 };

test("resolveAnchor: center/middle sit low (feet-on-deck), within the display", () => {
  assert.deepEqual(resolveAnchor("center", DISP, CURSOR), [100 + 500, 200 + 800 * 0.62]);
  assert.deepEqual(resolveAnchor("middle", DISP, CURSOR), resolveAnchor("center", DISP, CURSOR));
});

test("resolveAnchor: corners use the edge margin", () => {
  assert.deepEqual(resolveAnchor("topleft", DISP, CURSOR), [100 + 1000 * 0.12, 200 + 800 * 0.12]);
  assert.deepEqual(resolveAnchor("bottomright", DISP, CURSOR), [100 + 1000 * 0.88, 200 + 800 * 0.88]);
});

test("resolveAnchor: name matching ignores case, spaces, underscores, hyphens", () => {
  const want = resolveAnchor("topright", DISP, CURSOR);
  assert.deepEqual(resolveAnchor("Top Right", DISP, CURSOR), want);
  assert.deepEqual(resolveAnchor("TOP_RIGHT", DISP, CURSOR), want);
  assert.deepEqual(resolveAnchor("top-right", DISP, CURSOR), want);
});

test("resolveAnchor: cursor anchor returns the cursor's global position", () => {
  assert.deepEqual(resolveAnchor("cursor", DISP, CURSOR), [CURSOR.x, CURSOR.y]);
});

test("resolveAnchor: unknown / empty name -> null", () => {
  assert.equal(resolveAnchor("nowhere", DISP, CURSOR), null);
  assert.equal(resolveAnchor("", DISP, CURSOR), null);
  // @ts-expect-error exercising a non-string guard
  assert.equal(resolveAnchor(undefined, DISP, CURSOR), null);
});

test("resolveAnchor: custom margin/low are honored", () => {
  const r = resolveAnchor("left", DISP, CURSOR, { margin: 0.2, low: 0.5 });
  assert.deepEqual(r, [100 + 1000 * 0.2, 200 + 800 * 0.5]);
});

const PLATS = [
  { gx: 500, gy: 600, w: 200 }, // spans x 400..600
  { gx: 500, gy: 640, w: 200 }, // a bit lower, same column
  { gx: 900, gy: 600, w: 100 }, // spans x 850..950
];

test("nearestPlatformSurfaceY: picks the closest spanning platform within the band", () => {
  // at gx 500, gy 605: both column platforms span; 600 (dy 5) beats 640 (dy 35)
  assert.equal(nearestPlatformSurfaceY(500, 605, PLATS, 100), 600);
  // closer to the lower one
  assert.equal(nearestPlatformSurfaceY(500, 638, PLATS, 100), 640);
});

test("nearestPlatformSurfaceY: ignores platforms that don't span gx", () => {
  assert.equal(nearestPlatformSurfaceY(700, 600, PLATS, 100), null); // gap between columns
  assert.equal(nearestPlatformSurfaceY(900, 605, PLATS, 100), 600); // the right column
});

test("nearestPlatformSurfaceY: outside the snap band -> null", () => {
  assert.equal(nearestPlatformSurfaceY(500, 800, PLATS, 50), null); // 200px away, band 50
});

test("sanitizePlatforms: coerces, floors width, drops non-finite, caps count", () => {
  const out = sanitizePlatforms([
    { gx: "10", gy: "20", w: "5" }, // width floored to 24
    { gx: 1, gy: 2 }, // no width -> default 220
    { gx: NaN, gy: 3, w: 50 }, // dropped
    { gx: 4, gy: "x", w: 50 }, // gy non-finite -> dropped
  ]);
  assert.deepEqual(out, [
    { gx: 10, gy: 20, w: 24 },
    { gx: 1, gy: 2, w: 220 },
  ]);
});

test("sanitizePlatforms: non-array -> empty; respects max", () => {
  assert.deepEqual(sanitizePlatforms(null), []);
  assert.deepEqual(sanitizePlatforms("nope"), []);
  const many = Array.from({ length: 40 }, (_, i) => ({ gx: i, gy: i, w: 100 }));
  assert.equal(sanitizePlatforms(many).length, 32);
  assert.equal(sanitizePlatforms(many, { max: 5 }).length, 5);
});
