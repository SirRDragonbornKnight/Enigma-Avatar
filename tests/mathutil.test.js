// mathutil.test.js — locks the pure logic the audit flagged as untested: rotation normalize/migrate/
// save, the spring weight→feel mapping, and the adaptive-FPS pick. These run headless (no three.js).
import { test } from "node:test";
import assert from "node:assert";
import {
  norm360,
  signed180,
  rotFromProfile,
  rotToSave,
  regionFeel,
  pickFps,
  dipToLocalPx,
  localPxToDip,
} from "../src/util/mathutil.js";

// (the ambientAmp + idle-v4 primitive tests died with the idle system, 2026-06-12)

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("multi-window coords: DIP↔local-px round-trips and respects per-window bounds", () => {
  // middle monitor in the dev rig: origin (2560,145), 1920×1080 DIP, window inner 1920×1080 (ratio 1)
  const origin = { x: 2560, y: 145 },
    bounds = { width: 1920, height: 1080 };
  // her base centred on this monitor (global 3520,815) → local px 960,670
  const [lx, ly] = dipToLocalPx(3520, 815, origin, bounds, 1920, 1080);
  assert.ok(close(lx, 960) && close(ly, 670), "global→local px centres her on this display");
  // round-trip back to global DIP
  const [gx, gy] = localPxToDip(lx, ly, origin, bounds, 1920, 1080);
  assert.ok(close(gx, 3520) && close(gy, 815), "local→global is the exact inverse");
  // a point on the PRIMARY (global 1280,893) maps far off THIS window's left edge (→ GPU-clipped, not on-screen)
  const [ox] = dipToLocalPx(1280, 893, origin, bounds, 1920, 1080);
  assert.ok(ox < 0, "an avatar on another monitor renders off this window's edge (the spanning/clip behaviour)");
});

test("multi-window coords: mixed-DPI ratio uses THIS window's own bounds (not 1:1)", () => {
  // a 125%-scaled monitor: 1536×864 DIP but the window reports 1920×1080 CSS px → ratio 1.25
  const origin = { x: 0, y: 0 },
    bounds = { width: 1536, height: 864 };
  const [lx, ly] = dipToLocalPx(768, 432, origin, bounds, 1920, 1080); // DIP centre → CSS centre
  assert.ok(close(lx, 960) && close(ly, 540), "DIP→CSS scales by inner/bounds, not 1:1");
  const [gx, gy] = localPxToDip(960, 540, origin, bounds, 1920, 1080);
  assert.ok(close(gx, 768) && close(gy, 432), "and inverts cleanly under mixed DPI");
});

test("multi-window coords: the .width/.height field name is load-bearing (regression)", () => {
  // The shipped bug: reading bounds.w/.h (undefined) collapsed the ratio to innerW/1 → ~1000× off-screen.
  // A {w,h}-shaped bounds must NOT silently divide by 1; only {width,height} is honoured.
  const origin = { x: 0, y: 0 };
  const right = dipToLocalPx(960, 540, origin, { width: 1920, height: 1080 }, 1920, 1080);
  assert.ok(close(right[0], 960), "correct {width,height} keeps her on-screen");
  const wrong = dipToLocalPx(960, 540, origin, { w: 1920, h: 1080 }, 1920, 1080); // missing width/height
  assert.ok(Math.abs(wrong[0]) > 100000, "a .w/.h-only bounds explodes off-screen — the bug the fields guard against");
});

test("norm360 wraps any angle into [0,360)", () => {
  assert.strictEqual(norm360(0), 0);
  assert.strictEqual(norm360(45), 45);
  assert.strictEqual(norm360(360), 0);
  assert.strictEqual(norm360(370), 10);
  assert.strictEqual(norm360(-10), 350); // negatives wrap
  assert.strictEqual(norm360(-370), 350);
  assert.strictEqual(norm360(undefined), 0); // junk → 0
  assert.strictEqual(norm360(NaN), 0);
  assert.strictEqual(norm360("90"), 90);
});

test("signed180 maps angles into (-180,180] so the rotate fields can go the OTHER way", () => {
  assert.strictEqual(signed180(0), 0);
  assert.strictEqual(signed180(15), 15);
  assert.strictEqual(signed180(180), 180); // boundary stays positive
  assert.strictEqual(signed180(181), -179);
  assert.strictEqual(signed180(345), -15); // a left turn reads as negative, not 345
  assert.strictEqual(signed180(360), 0);
  assert.strictEqual(signed180(-15), -15); // already-negative input round-trips
  assert.strictEqual(signed180(undefined), 0); // junk → 0
  assert.strictEqual(signed180(NaN), 0);
});

test("rotFromProfile reads {x,y,z} and migrates legacy yaw → Y", () => {
  assert.deepStrictEqual(rotFromProfile({ rot: { x: 10, y: 20, z: 30 } }), { x: 10, y: 20, z: 30 });
  assert.deepStrictEqual(rotFromProfile({ yaw: 90 }), { x: 0, y: 90, z: 0 }); // legacy single-axis
  assert.deepStrictEqual(rotFromProfile({}), { x: 0, y: 0, z: 0 }); // nothing saved
  assert.deepStrictEqual(rotFromProfile(null), { x: 0, y: 0, z: 0 });
  assert.deepStrictEqual(rotFromProfile({ rot: { x: -10, y: 370, z: 0 } }), { x: 350, y: 10, z: 0 }); // normalized
  // a present rot object WINS over a stale legacy yaw
  assert.deepStrictEqual(rotFromProfile({ rot: { x: 0, y: 45, z: 0 }, yaw: 999 }), { x: 0, y: 45, z: 0 });
});

test("rotToSave returns null for all-zero (so the key is dropped), normalized otherwise", () => {
  assert.strictEqual(rotToSave({ x: 0, y: 0, z: 0 }), null);
  assert.strictEqual(rotToSave({ x: 360, y: 0, z: -360 }), null); // all wrap to 0
  assert.deepStrictEqual(rotToSave({ x: 0, y: 45, z: 0 }), { x: 0, y: 45, z: 0 });
  assert.deepStrictEqual(rotToSave({ x: -10, y: 0, z: 370 }), { x: 350, y: 0, z: 10 });
});

test("regionFeel: w≤0.001 pins; w=1 is the default feel; w<1 damps; w>1 is bouncier", () => {
  assert.deepStrictEqual(regionFeel(0, 0.14, 0.5, false), { pin: true });
  assert.deepStrictEqual(regionFeel(0.001, 0.14, 0.5, false), { pin: true }); // boundary pins
  const def = regionFeel(1, 0.14, 0.5, false);
  assert.strictEqual(def.pin, false);
  assert.ok(close(def.stiff, 0.14), "w=1 stiff == base");
  assert.ok(close(def.dragv, 0.5), "w=1 dragv == base");
  assert.strictEqual(def.damp, 0);
  const soft = regionFeel(0.5, 0.14, 0.5, false);
  assert.ok(close(soft.stiff, 0.14) && close(soft.dragv, 0.5), "w<1 keeps base stiff/drag");
  assert.ok(close(soft.damp, 0.5), "w=0.5 → damp 0.5 (toward rest)");
  const bouncy = regionFeel(2, 0.14, 0.5, false);
  assert.ok(bouncy.stiff < def.stiff, "w>1 → looser stiffness (longer wobble)");
  assert.ok(bouncy.dragv < def.dragv, "w>1 → less drag (more bounce)");
  assert.strictEqual(bouncy.damp, 0);
});

test("regionFeel: geo chains are stiffer; dragv is clamped to a floor", () => {
  assert.ok(regionFeel(1, 0.14, 0.5, true).stiff > regionFeel(1, 0.14, 0.5, false).stiff, "geo = 1.5× stiffer");
  assert.ok(close(regionFeel(2, 0.14, 0.05, false).dragv, 0.05), "dragv floor 0.05 (0.05/2 would underflow)");
});

test("pickFps: full rate when active; idle → IDLE; deep-rest → REST", () => {
  assert.strictEqual(pickFps(true, 999, 60, 30, 15, 6), 60);
  assert.strictEqual(pickFps(false, 3, 60, 30, 15, 6), 30); // recently active
  assert.strictEqual(pickFps(false, 6, 60, 30, 15, 6), 30); // exactly at threshold → still IDLE
  assert.strictEqual(pickFps(false, 7, 60, 30, 15, 6), 15); // past threshold → REST
});
