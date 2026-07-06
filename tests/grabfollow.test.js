// grabfollow.test.js — the ragdoll-grab layer factory (src/motion/grabfollow.js): the grabbed
// limb servos toward the cursor (discovering the rig's abduction sign on its own), the torso
// pendulums after the drag velocity, and everything stays bounded. Pure — a simulated limb
// stands in for the rig; the compositor integration is covered by layers.test.js's fn path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGrabFollowFn } from "../src/motion/grabfollow.js";

// A fake limb: hangs straight down at rest; the servo's flex[1] (abd) rotates it in the screen
// plane by trueSign * applied. CRITICALLY it does NOT teleport: the applied offset EASES toward
// the command at the compositor's real speed limit (90 deg/s — bone_limits.json), because a
// re-voting sign detector passed the teleporting harness and limit-cycled on the REAL, slow rig
// (audit 2026-07-05: mismatch frames accrue for the whole eased traverse, not just while wrong).
// And it models the real RELEASE path: a frame with no flex command eases applied back toward
// the other layers' sum, NOT a hold (the old holding harness masked the deadband sag — audit
// 2026-07-05 round 2, finding 3).
// opts:
//   other    a coexisting live layer's constant abd command on the same role (compositor SUMS)
//   pa       () => rad — the parent frame's screen angle (ancestor roll contamination); the
//            world limb angle includes it, and aimState reports it (unless reportPa: false,
//            which simulates the old world-blind measurement)
function makeLimb(trueSign, opts = {}) {
  const other = opts.other || 0;
  const paF = opts.pa || (() => 0);
  const state = { abd: 0, applied: 0, has: false };
  const MAX_STEP = (90 * Math.PI) / 180 / 60; // 90 deg/s at 60fps — the live per-frame clamp
  return {
    state,
    step() {
      const target = other + (state.has ? state.abd : 0);
      const d = target - state.applied;
      state.applied += Math.max(-MAX_STEP, Math.min(MAX_STEP, d));
    },
    aimState: () => {
      const pa = paF();
      const a = pa + -Math.PI / 2 + trueSign * state.applied; // rest = straight down (-90deg), riding the parent
      return { sx: 0, sy: 0, dx: Math.cos(a), dy: Math.sin(a), pa: opts.reportPa === false ? 0 : pa };
    },
  };
}

function run(fn, limb, frames, clock, onFrame) {
  let out = null;
  for (let i = 0; i < frames; i++) {
    clock.t += 16.7;
    out = fn();
    if (out.flex) {
      limb.state.abd = Object.values(out.flex)[0][1];
      limb.state.has = true;
    } else limb.state.has = false; // release: the compositor eases the role home, no hold
    limb.step(); // speed-limited application, like the live compositor
    if (onFrame) onFrame(out);
  }
  return out;
}

// signed world-plane angle from the target direction (world angle ta) to the limb's direction
function worldErr(limb, ta) {
  const st = limb.aimState();
  return Math.atan2(Math.cos(ta) * st.dy - Math.sin(ta) * st.dx, Math.cos(ta) * st.dx + Math.sin(ta) * st.dy);
}

test("the grabbed limb servos onto the cursor through the SPEED-LIMITED rig — even with a REVERSED axis, no flip limit-cycle", () => {
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
    // track commanded-sign changes: the sign must be decided ONCE, never oscillate
    let lastCmdSign = 0,
      flips = 0;
    run(fn, limb, 240, clock, (out) => {
      if (!out.flex) return;
      const cmd = Object.values(out.flex)[0][1];
      const s = Math.sign(cmd);
      if (s && lastCmdSign && s !== lastCmdSign) flips++;
      if (s) lastCmdSign = s;
    }); // 4 simulated seconds — a 90deg traverse needs ~1s at the speed limit
    const err = worldErr(limb, 0); // target = +x
    assert.ok(
      Math.abs(err) < 0.06,
      `trueSign=${trueSign}: limb converges onto the cursor (residual ${err.toFixed(3)} rad)`
    );
    assert.ok(
      flips <= 1,
      `trueSign=${trueSign}: at most ONE sign decision (saw ${flips} command-sign flips) — no limit cycle`
    );
  }
});

test("near-base grabs HOLD the last aim by re-commanding it (an absent flex is a compositor RELEASE — the limb would sag out of the hand)", () => {
  const clock = { t: 0 };
  const limb = makeLimb(1);
  let cursor = { x: 1, y: 0 };
  const fn = createGrabFollowFn({
    aimRole: "left_arm",
    aimState: limb.aimState,
    cursorWorld: () => cursor,
    dragX: () => 0,
    now: () => clock.t,
  });
  run(fn, limb, 120, clock); // converge onto the side target
  const heldApplied = limb.state.applied;
  cursor = { x: 0.05, y: 0.05 }; // cursor lands ~at the limb BASE (inside the 0.25*limb-length deadband)
  const out = run(fn, limb, 60, clock);
  assert.ok(out.flex, "inside the deadband the last command KEEPS FLOWING (missing flex = release, not hold)");
  assert.ok(
    Math.abs(limb.state.applied - heldApplied) < 1e-9,
    `the limb stays where it was held (applied ${limb.state.applied.toFixed(3)} vs ${heldApplied.toFixed(3)})`
  );
});

test("RE-GRAB mid ease-back: a limb still displaced from the LAST grab converges onto the cursor — no wrong-sign lock, no wrong-way whip", () => {
  // The launch bug (user 2026-07-05 "move her, re-grab a part -> spaz + launched"): after a release
  // the compositor eases the old applied offset back over ~1s. A re-grab in that window used to
  // capture restDir mid-displacement and command sign*th FROM TRUE REST — so the rig's first motion
  // (easing DOWN toward the smaller absolute command) opposed the command, the one-shot sign
  // discovery voted "reversed rig" 3 frames running, locked the wrong sign, and drove the limb to
  // the ±2.2 cap — the mouse-lock then dragged the whole body after the runaway part. The layer now
  // takes abd0 (the ORPHAN residual at grab time) and commands abd0 + sign*th.
  for (const trueSign of [1, -1]) {
    const clock = { t: 0 };
    const limb = makeLimb(trueSign);
    limb.state.applied = 1.0; // residual from the previous grab, mid ease-back (abd=0 until the servo speaks)
    const fn = createGrabFollowFn({
      aimRole: "left_arm",
      aimState: limb.aimState,
      // target BEYOND the residual: desired applied = 1.5, further in the same direction
      cursorWorld: () => ({ x: Math.cos(-Math.PI / 2 + trueSign * 1.5), y: Math.sin(-Math.PI / 2 + trueSign * 1.5) }),
      dragX: () => 0,
      now: () => clock.t,
      abd0: 1.0, // orphan residual: applied 1.0, no other layer commands the role
    });
    let minApplied = limb.state.applied;
    run(fn, limb, 240, clock, () => {
      minApplied = Math.min(minApplied, limb.state.applied);
    });
    const err = worldErr(limb, -Math.PI / 2 + trueSign * 1.5);
    assert.ok(
      Math.abs(err) < 0.06,
      `trueSign=${trueSign}: re-grabbed limb converges onto the cursor (residual ${err.toFixed(3)} rad)`
    );
    assert.ok(
      minApplied > 0.5,
      `trueSign=${trueSign}: no wrong-way whip through rest toward the cap (min applied ${minApplied.toFixed(3)})`
    );
  }
});

test("re-grab during the PENDULUM's roll ease-back: ancestor motion can't poison the sign or the aim (parent-frame measurement)", () => {
  // Audit 2026-07-05 round 2, findings 1+2: the spine+chest roll residual eases back at up to
  // 0.052 rad/frame — twice the limb servo's own 0.026 — so a world-measured dm voted the wrong
  // sign and restDir was captured in a frame that then rotated away (~20deg permanent miss).
  // aimState now reports pa (the parent's screen angle) and the servo measures in that frame.
  for (const trueSign of [1, -1]) {
    const clock = { t: 0 };
    let baseRoll = 0.35 * trueSign; // spine 0.22 + chest 0.13, both still unwinding
    const decay = () => {
      baseRoll = Math.sign(baseRoll) * Math.max(0, Math.abs(baseRoll) - 0.052);
    };
    const limb = makeLimb(trueSign, { pa: () => baseRoll });
    const ta = -Math.PI / 2 + trueSign * 0.9;
    const fn = createGrabFollowFn({
      aimRole: "left_arm",
      aimState: limb.aimState,
      cursorWorld: () => ({ x: Math.cos(ta), y: Math.sin(ta) }),
      dragX: () => 0,
      now: () => clock.t,
      abd0: 0,
    });
    run(fn, limb, 300, clock, decay);
    const err = worldErr(limb, ta);
    assert.ok(
      Math.abs(err) < 0.06,
      `trueSign=${trueSign}: converges despite the ancestor roll ease-back (residual ${err.toFixed(3)} rad)`
    );
  }
});

test("#guard: the SAME pendulum scenario with a world-blind aimState (pa unreported) DOES mislock — proves the parent-frame test bites", () => {
  const clock = { t: 0 };
  let baseRoll = 0.35;
  const limb = makeLimb(1, { pa: () => baseRoll, reportPa: false }); // contamination present, invisible to the layer
  const ta = -Math.PI / 2 + 0.9;
  const fn = createGrabFollowFn({
    aimRole: "left_arm",
    aimState: limb.aimState,
    cursorWorld: () => ({ x: Math.cos(ta), y: Math.sin(ta) }),
    dragX: () => 0,
    now: () => clock.t,
    abd0: 0,
  });
  run(fn, limb, 300, clock, () => {
    baseRoll = Math.max(0, baseRoll - 0.052);
  });
  assert.ok(
    Math.abs(worldErr(limb, ta)) > 0.5,
    "world-blind measurement locks the wrong sign under ancestor contamination (the failure the fix removes)"
  );
});

test("a coexisting live layer's hold is NOT double-counted: abd0 carries only the ORPHAN residual", () => {
  // Audit 2026-07-05 round 2, finding 4: appliedFlex is the eased SUM of all layers. Folding the
  // full applied value into the grab command while an AI pose layer still holds the arm at A made
  // the compositor sum 2A + sign*th — moving the limb OPPOSITE the command for near-side targets
  // (wrong-sign lock, launch phenotype) and overshooting by A otherwise. The wiring passes
  // applied - flexCommand(role, "grab_follow") instead; here that orphan residual is 0.
  const clock = { t: 0 };
  const A = 0.6; // a persistent AI pose layer holding the arm out
  const limb = makeLimb(1, { other: A });
  limb.state.applied = A; // settled on the hold
  const ta = -Math.PI / 2 + 0.35; // target on the NEAR side of the hold (|th| < A, opposite direction)
  const fn = createGrabFollowFn({
    aimRole: "left_arm",
    aimState: limb.aimState,
    cursorWorld: () => ({ x: Math.cos(ta), y: Math.sin(ta) }),
    dragX: () => 0,
    now: () => clock.t,
    abd0: 0, // orphan residual: applied (0.6) - the live layer's command (0.6)
  });
  run(fn, limb, 300, clock);
  const err = worldErr(limb, ta);
  assert.ok(
    Math.abs(err) < 0.06,
    `converges onto the near-side target without double-counting the hold (residual ${err.toFixed(3)} rad)`
  );
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
    assert.ok(!out.flex, "no aim without a limb reading (and nothing to hold yet)");
    assert.ok(Number.isFinite(out.parts.spine[2]), "NaN dragX never poisons the tilt");
  }
});
