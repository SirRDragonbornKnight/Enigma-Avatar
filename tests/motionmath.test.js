// motionmath.test.js — unit tests for the SHAPE of the motion math (bell pulse, ease, jump elevation).
// This tests the REAL functions procedural.js + avatar.js import (not a copy), so the curve that drives
// the on-screen jump is the curve under test. Pure / no three.js / no renderer.
import { test } from "node:test";
import assert from "node:assert";
import { bell, easeInOut, jumpElevation } from "../motionmath.js";

test("bell: peak 1 at center, symmetric, narrower=faster falloff, ~0 far away", () => {
  assert.strictEqual(bell(5, 5, 1), 1);                              // peak at the center
  assert.ok(Math.abs(bell(4, 5, 1) - bell(6, 5, 1)) < 1e-12);       // symmetric about c
  assert.ok(bell(5.3, 5, 0.1) < bell(5.3, 5, 1));                   // narrower width → smaller off-center value
  assert.ok(bell(12, 5, 1) < 1e-6);                                 // far away (7σ) ≈ 0
  const mid = bell(5.5, 5, 1); assert.ok(mid > 0 && mid < 1);       // in-between is between
});

test("easeInOut: endpoints + midpoint, monotonic, slow-start/slow-end", () => {
  assert.strictEqual(easeInOut(0), 0);
  assert.strictEqual(easeInOut(1), 1);
  assert.ok(Math.abs(easeInOut(0.5) - 0.5) < 1e-12);
  let prev = -1;
  for (let p = 0; p <= 1.0001; p += 0.05) { const v = easeInOut(p); assert.ok(v >= prev - 1e-9, `monotonic at ${p.toFixed(2)}`); prev = v; }
  assert.ok(easeInOut(0.25) < 0.25, "eases IN (slow start)");
  assert.ok(easeInOut(0.75) > 0.75, "eases OUT (slow end)");
});

test("jumpElevation: sinks on the coil, peaks ~apex h, absorbs on landing, settles to ~0", () => {
  const h = 2.3;
  const e0 = jumpElevation(0, h), eDip = jumpElevation(0.15, h), eApex = jumpElevation(0.55, h), eLand = jumpElevation(0.83, h), eEnd = jumpElevation(1, h);
  assert.ok(eDip < 0, "sinks below standing during the coil (anticipation)");
  assert.ok(eDip < e0, "the coil dip is below the start position");
  assert.ok(eApex > 0.85 * h, `apex near full height (got ${eApex.toFixed(2)} of ${h})`);
  assert.ok(eApex > eDip, "springs up (apex is above the dip)");
  assert.ok(eLand < jumpElevation(0.7, h), "absorbs (dips) on landing vs just before touchdown");
  assert.ok(Math.abs(eEnd) < 0.06 * h, "settles back to ~standing by the end");
});

test("jumpElevation: the anticipation DIP comes BEFORE the apex", () => {
  const h = 2;
  let minP = 0, minV = Infinity, maxP = 0, maxV = -Infinity;
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const v = jumpElevation(p, h);
    if (p < 0.5 && v < minV) { minV = v; minP = p; }
    if (v > maxV) { maxV = v; maxP = p; }
  }
  assert.ok(minP < maxP, "dip precedes apex (squash before stretch)");
  assert.ok(minP > 0 && minP < 0.3, `dip is in the coil window (got ${minP.toFixed(2)})`);
  assert.ok(maxP > 0.4 && maxP < 0.7, `apex is mid-flight (got ${maxP.toFixed(2)})`);
});

test("jumpElevation scales linearly with the jump height h (model-relative)", () => {
  for (const p of [0.15, 0.55, 0.83]) {
    assert.ok(Math.abs(jumpElevation(p, 4) - 2 * jumpElevation(p, 2)) < 1e-9, `linear in h at p=${p}`);
  }
});
