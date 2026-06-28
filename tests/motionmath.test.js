// motionmath.test.js — unit tests for the SHAPE of the motion math (the ease curve). This tests the REAL
// function avatar.js / conjure.js import (not a copy). Pure / no three.js / no renderer.
// (bell + jumpElevation were removed with the gesture/clip purge, 2026-06-25, and their tests with them.)
import { test } from "node:test";
import assert from "node:assert";
import { easeInOut } from "../motionmath.js";

test("easeInOut: endpoints + midpoint, monotonic, slow-start/slow-end", () => {
  assert.strictEqual(easeInOut(0), 0);
  assert.strictEqual(easeInOut(1), 1);
  assert.ok(Math.abs(easeInOut(0.5) - 0.5) < 1e-12);
  let prev = -1;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const v = easeInOut(p);
    assert.ok(v >= prev - 1e-9, `monotonic at ${p.toFixed(2)}`);
    prev = v;
  }
  assert.ok(easeInOut(0.25) < 0.25, "eases IN (slow start)");
  assert.ok(easeInOut(0.75) > 0.75, "eases OUT (slow end)");
});
