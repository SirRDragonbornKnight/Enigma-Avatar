// grabfollow.test.js — the ragdoll-grab layer factory (src/motion/grabfollow.js): the grabbed
// limb servos toward the cursor (discovering the rig's abduction sign on its own), the torso
// pendulums after the drag velocity, and everything stays bounded. Pure — a simulated limb
// stands in for the rig; the compositor integration is covered by layers.test.js's fn path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGrabFollowFn } from "../src/motion/grabfollow.js";

// A fake limb: hangs straight down at rest; the servo's flex[1] (abd) rotates it in the screen
// plane by trueSign * abd. Lets the test present a rig whose axis sign disagrees with the
// servo's initial guess.
function makeLimb(trueSign) {
  const state = { abd: 0 };
  return {
    state,
    aimState: () => {
      const a = -Math.PI / 2 + trueSign * state.abd; // rest = straight down (-90deg)
      return { sx: 0, sy: 0, dx: Math.cos(a), dy: Math.sin(a) };
    },
  };
}

function run(fn, limb, cursor, frames, clock) {
  let out = null;
  for (let i = 0; i < frames; i++) {
    clock.t += 16.7;
    out = fn();
    if (out.flex) {
      const abd = Object.values(out.flex)[0][1];
      limb.state.abd = abd;
    }
  }
  return out;
}

test("the grabbed limb servos onto the cursor — even when the rig's axis sign is REVERSED", () => {
  for (const trueSign of [1, -1]) {
    const clock = { t: 0 };
    const limb = makeLimb(trueSign);
    const fn = createGrabFollowFn({
      aimRole: "left_arm",
      aimState: limb.aimState,
      cursorWorld: () => ({ x: 1, y: 0 }), // cursor straight to her right — 90deg from the hanging rest
      dragX: () => 0,
      now: () => clock.t,
    });
    run(fn, limb, null, 120, clock); // 2 simulated seconds
    const st = limb.aimState();
    const err = Math.atan2(st.dx * 0 - st.dy * 1, st.dx * 1 + st.dy * 0); // signed angle limb->target
    assert.ok(
      Math.abs(err) < 0.06,
      `trueSign=${trueSign}: limb converges onto the cursor (residual ${err.toFixed(3)} rad) — the servo must discover a reversed axis`
    );
  }
});

test("pendulum: the torso trails the drag velocity, stays bounded, and settles when the drag stops", () => {
  const clock = { t: 0 };
  let x = 0,
    moving = true;
  const fn = createGrabFollowFn({
    aimRole: null,
    aimState: null,
    cursorWorld: () => null,
    dragX: () => x,
    now: () => clock.t,
  });
  let maxRoll = 0,
    out = null;
  for (let i = 0; i < 90; i++) {
    clock.t += 16.7;
    if (moving) x += 20; // ~1200 DIP/s drag
    out = fn();
    maxRoll = Math.max(maxRoll, Math.abs(out.parts.spine[2]));
  }
  assert.ok(maxRoll > 0.05, `dragging tilts the torso (max roll ${maxRoll.toFixed(3)})`);
  assert.ok(maxRoll <= 0.221, `tilt is bounded (${maxRoll.toFixed(3)} <= 0.22)`);
  assert.equal(out.parts.chest[2], out.parts.spine[2] * 0.6, "chest carries a fraction of the spine tilt");
  moving = false; // drag stops — she settles
  for (let i = 0; i < 240; i++) {
    clock.t += 16.7;
    out = fn();
  }
  assert.ok(
    Math.abs(out.parts.spine[2]) < 0.01,
    `settles upright after the drag stops (roll ${out.parts.spine[2].toFixed(4)})`
  );
});

test("guards: no aim state / no cursor / NaN dragX -> pendulum-only output, always finite", () => {
  const clock = { t: 0 };
  const fn = createGrabFollowFn({
    aimRole: "left_arm",
    aimState: () => null,
    cursorWorld: () => null,
    dragX: () => NaN,
    now: () => clock.t,
  });
  for (let i = 0; i < 30; i++) {
    clock.t += 16.7;
    const out = fn();
    assert.ok(!out.flex, "no aim without a limb reading");
    assert.ok(Number.isFinite(out.parts.spine[2]), "NaN dragX never poisons the tilt");
  }
});
