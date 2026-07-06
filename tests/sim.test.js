// sim.test.js — the simulation tick (carve S2-a), headless.
// Asserts INTENT: the canonical step ORDER holds (pose → grab servo → physics → conjure), the
// physics world is touched only when it has bodies AND the world is ready, the floor push is
// epsilon-gated, the capsule math tracks her live footprint, and conjured props advance
// UNCONDITIONALLY (the P3 regression: never nested under the physics guard).
import test from "node:test";
import assert from "node:assert/strict";
import { createSimTick } from "../src/engine/sim.js";

function harness({ propCount = 0, ready = true, floorY = -3, body, physStep = false, conjStep = false } = {}) {
  const calls = { order: [], setFloor: [], setAvatar: [], wake: [] };
  const sim = createSimTick({
    stepPose: () => calls.order.push("pose"),
    stepGrabServo: () => calls.order.push("grab"),
    physics: {
      count: () => propCount,
      setFloor: (y) => calls.setFloor.push(y),
      setAvatar: (c) => calls.setAvatar.push(c),
      step: () => {
        calls.order.push("physics");
        return physStep;
      },
    },
    conjurer: {
      step: () => {
        calls.order.push("conjure");
        return conjStep;
      },
    },
    wake: (s) => calls.wake.push(s),
    isWorldReady: () => ready,
    getFloorY: () => floorY,
    getBody: () => body || { x: 0, y: 0, motionY: 0, w: 2, h: 6, size: 0.5, baseH: 6 },
  });
  return { sim, calls };
}

test("the canonical order: pose -> grab servo -> physics -> conjure, every tick", () => {
  const { sim, calls } = harness({ propCount: 1 });
  sim.tick(1 / 60);
  assert.deepEqual(calls.order, ["pose", "grab", "physics", "conjure"]);
});

test("no bodies OR world not ready -> the rapier world is never touched (conjure still steps)", () => {
  const a = harness({ propCount: 0 });
  a.sim.tick(1 / 60);
  assert.deepEqual(a.calls.order, ["pose", "grab", "conjure"]); // physics skipped entirely
  const b = harness({ propCount: 2, ready: false });
  b.sim.tick(1 / 60);
  assert.deepEqual(b.calls.order, ["pose", "grab", "conjure"]);
  assert.equal(b.calls.setFloor.length, 0);
});

test("floor push is epsilon-gated: once for a steady floor, again only on a real move", () => {
  let floorY = -3;
  const calls = { setFloor: [] };
  const sim = createSimTick({
    stepPose: () => {},
    stepGrabServo: () => {},
    physics: { count: () => 1, setFloor: (y) => calls.setFloor.push(y), setAvatar: () => {}, step: () => false },
    conjurer: { step: () => false },
    wake: () => {},
    isWorldReady: () => true,
    getFloorY: () => floorY,
    getBody: () => ({ x: 0, y: 0, motionY: 0, w: 2, h: 6, size: 1, baseH: 6 }),
  });
  sim.tick(0.016);
  sim.tick(0.016);
  floorY = -3 + 5e-4; // sub-epsilon jitter — must NOT churn the world
  sim.tick(0.016);
  assert.deepEqual(calls.setFloor, [-3]);
  floorY = -5; // she hopped to another monitor — a real move
  sim.tick(0.016);
  assert.deepEqual(calls.setFloor, [-3, -5]);
});

test("the collision capsule tracks her live footprint: feet->head span, mid-body centre", () => {
  const { sim, calls } = harness({
    propCount: 1,
    body: { x: 10, y: 2, motionY: 0.5, w: 2, h: 6, size: 0.5, baseH: 6 },
  });
  sim.tick(0.016);
  // hW = 6*0.5 = 3; rr = max(0.1, 2*0.5*0.28) = 0.28; centre y = 2 + 1.5 + 0.5; halfH = 1.5 - 0.28
  assert.deepEqual(calls.setAvatar, [{ x: 10, y: 4, halfH: 1.22, r: 0.28 }]);
});

test("motion in flight holds the frame rate: physics/conjure activity each wake(0.5)", () => {
  const { sim, calls } = harness({ propCount: 1, physStep: true, conjStep: true });
  sim.tick(0.016);
  assert.deepEqual(calls.wake, [0.5, 0.5]);
  const idle = harness({ propCount: 1 });
  idle.sim.tick(0.016);
  assert.deepEqual(idle.calls.wake, []); // nothing moving -> nothing holds the rate
});
