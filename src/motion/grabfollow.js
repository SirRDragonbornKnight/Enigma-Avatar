// grabfollow.js — the RAGDOLL GRAB layer (user 2026-07-05: "if I grab from the arm it will
// move, then the body"): while the user drags her, the grabbed limb LEADS (a servo aims it
// at the cursor each frame) and the torso PENDULUMS after the drag velocity, trailing and
// settling like a carried body.
//
// Authored as a compositor fn() LAYER on purpose: the per-role joint limits and speed clamps
// shape everything (velocity-continuous, can never crank a joint past its table), and clearing
// the layer on release eases every offset back at the limits — no snap on either edge.
//
// Generic: no per-model data. The abduction axis SIGN differs per rig, so the servo discovers
// it: if the aim error grows while it corrects, it flips direction ("trust no axes" — the same
// philosophy as the finger-curl calibration). Pure factory (no THREE, no DOM): the caller
// supplies live readers, so tests drive it with a simulated limb.
//
// ALL aim geometry lives in the PARENT frame (st.pa de-rotates the world readings): the abd
// joint physically operates there, and the world frame is moved by things that are NOT the
// servo — the pendulum's own spine/chest roll easing back after a release rotates the limb's
// world direction faster than the servo can respond (0.052 vs 0.026 rad/frame, audit
// 2026-07-05 round 2), which poisoned the sign votes below and mis-referenced restDir.
//
// deps:
//   aimRole    string|null   the flex role to aim (left_arm/right_arm/left_leg/right_leg)
//   aimState   () => {sx,sy,dx,dy,pa}|null   limb base (sx,sy) + current limb direction (dx,dy),
//                                            screen plane, + pa = the PARENT bone's screen-plane
//                                            angle (rad) so ancestor motion cancels out of the math
//   cursorWorld() => {x,y}|null           the cursor in world coords (screen plane)
//   dragX      () => number               her global x — the pendulum reads drag velocity off it
//   now        () => ms                   clock (injectable for tests)
//   abd0       number                     the ORPHAN abd residual on aimRole at grab time:
//                                         compositor applied offset MINUS what live layers still
//                                         command there (appliedFlex - flexCommand, avatar.js).
//                                         A re-grab mid ease-back starts displaced, NOT at rest —
//                                         commanding sign*th from true rest made the rig's first
//                                         motion oppose the command, the sign discovery locked the
//                                         wrong sign, and the limb whipped to the cap (the
//                                         "re-grab launch", 2026-07-05). Commands are
//                                         abd0 + sign*th so the eased response always starts
//                                         toward the command. Full applied (not orphan) would
//                                         DOUBLE-count a coexisting live layer's hold (audit
//                                         2026-07-05 round 2, finding 4).
export function createGrabFollowFn(deps) {
  const { aimRole, aimState, cursorWorld, dragX, now } = deps;
  const abd0 = Number.isFinite(+deps.abd0) ? +deps.abd0 : 0;
  let px = null,
    pt = null,
    vx = 0,
    roll = 0;
  // ABSOLUTE aim servo: abd = sign * (angle from the GRAB-TIME rest direction to the target).
  // No error accumulation — an integrating servo railed at its cap on reversed-sign rigs, the
  // frozen error blinded the "error grows -> flip" detector, and the limb locked wrong-way.
  let restDir = null,
    sign = 1,
    signLocked = false,
    dmAgree = 0,
    prevM = null,
    lastCmd = null; // last emitted abd command — re-emitted whenever the aim can't be computed
  const CAP = 2.2; // command bound (the compositor's clampAbd still applies after)
  const ROLL_MAX = 0.22; // pendulum tilt bound (rad)
  const ROLL_K = 0.0005; // drag velocity (DIP/s) -> tilt
  const angle = (ux, uy, wx, wy) => Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy); // signed, u -> w
  return () => {
    const t = now();
    const dtw = pt == null ? 1 / 60 : Math.max(1e-3, Math.min(0.1, (t - pt) / 1000));
    pt = t;
    // --- pendulum: the torso trails the drag velocity, then settles ---
    const x = dragX();
    if (px == null) px = x;
    const nvx = Number.isFinite(x) ? (x - px) / dtw : 0;
    if (Number.isFinite(x)) px = x;
    vx += (nvx - vx) * Math.min(1, dtw * 8); // smoothed velocity estimate
    const rollTgt = Math.max(-ROLL_MAX, Math.min(ROLL_MAX, -vx * ROLL_K));
    roll += (rollTgt - roll) * Math.min(1, dtw * 6);
    const out = { parts: { spine: [0, 0, roll], chest: [0, 0, roll * 0.6] } };
    // --- the grabbed limb leads: servo the aim error toward the cursor ---
    const st = aimRole && aimState ? aimState() : null;
    const cw = st && cursorWorld ? cursorWorld() : null;
    if (st && cw) {
      // de-rotate everything by the parent's screen angle: limb direction AND target live in the
      // PARENT frame, so ancestor roll (pendulum ease-back) cancels instead of feeding the votes
      const pa = Number.isFinite(+st.pa) ? +st.pa : 0;
      const cpa = Math.cos(pa),
        spa = Math.sin(pa);
      const rl = Math.hypot(st.dx, st.dy),
        twx = cw.x - st.sx,
        twy = cw.y - st.sy, // toward the cursor (world)
        tl = Math.hypot(twx, twy);
      // near-base deadband: with the mouse-lock pinning the grabbed part under the cursor, a grab
      // near the limb BASE makes the target direction self-referential noise — hold the last aim
      // instead of jittering (lastCmd is re-emitted below; an ABSENT flex would make the
      // compositor EASE the role back to 0, not hold — audit 2026-07-05 round 2, finding 3).
      if (rl > 1e-6 && tl > rl * 0.25) {
        const cx = (st.dx * cpa + st.dy * spa) / rl,
          cy = (-st.dx * spa + st.dy * cpa) / rl; // current limb direction (unit, parent frame)
        const tx = (twx * cpa + twy * spa) / tl,
          ty = (-twx * spa + twy * cpa) / tl; // target direction (unit, parent frame)
        if (!restDir) restDir = { x: cx, y: cy }; // the grab-time reference, parent frame
        const th = angle(restDir.x, restDir.y, tx, ty); // desired swing from the reference, ABSOLUTE
        const m = angle(restDir.x, restDir.y, cx, cy); // the swing the rig actually performed
        // Sign discovery, measured not guessed ("trust no axes") — decided ONCE per grab, then
        // LOCKED. The live compositor eases at the role's speed limit (~90 deg/s), so a re-voting
        // detector limit-cycled on reversed rigs: mismatch frames accrue for the WHOLE slow
        // traverse, not just while wrong (audit 2026-07-05). Here: watch the response's initial
        // DIRECTION (dm) over consecutive frames; once it clearly moves and agrees/disagrees with
        // the command 3 frames running, set the sign and never revisit it this grab.
        if (!signLocked && Math.abs(th) > 0.08) {
          if (prevM != null) {
            const dm = m - prevM;
            if (Math.abs(dm) > 0.004) {
              // ~a quarter of one speed-limited frame — above numeric noise
              dmAgree += Math.sign(dm) === Math.sign(sign * th) ? 1 : -1;
              if (dmAgree <= -3) {
                sign = -sign;
                signLocked = true;
              } else if (dmAgree >= 3) signLocked = true;
            }
          }
          prevM = m;
        }
        lastCmd = Math.max(-CAP, Math.min(CAP, abd0 + sign * th));
      }
    }
    // HOLD when the aim can't be computed this frame (deadband / cursor-relay gap): keep emitting
    // the last command — the compositor treats a missing flex entry as a RELEASE and eases the
    // role home at the speed limit, sagging the held limb out of the user's hand.
    if (aimRole && lastCmd != null) out.flex = { [aimRole]: [0, lastCmd] };
    return out;
  };
}

// The mouse-lock's bone picker: the nearest RIGID bone to the click, never a sprung one.
// The lock is a per-frame servo (measure the part -> steer main's grab offset), and a servo
// through a freely-swinging SPRUNG bone is a RESONANT loop: each correction pumps the swing,
// the swing moves the next measurement, and the sway GROWS until release dumps the stored
// spring energy as a launch (user repro 2026-07-06: grab near a sprung region -> she sways
// faster and faster -> goes flying). The per-step blend/rate caps bound step SIZE, not loop
// gain — so the spring must simply never be the plant. Locking the nearest rigid carrier
// keeps the exact grabbed spot tracking (the click is captured in the carrier's local frame)
// while the sprung chain swings free around it ("sprung regions swing FREE during drags").
// All sprung -> null: the drag falls open to a plain offset-follow, never a servo.
// tmp: a caller-supplied Vector3 scratch (this module stays THREE-import-free).
export function pickLockBone(root, wx, wy, maxR, exclude, tmp) {
  if (!root || !tmp) return null;
  let best = null,
    bd = maxR * maxR;
  root.traverse((o) => {
    if (!o.isBone || (exclude && exclude.has(o.name))) return;
    const p = o.getWorldPosition(tmp);
    const dx = p.x - wx,
      dy = p.y - wy,
      d2 = dx * dx + dy * dy;
    if (d2 < bd) {
      bd = d2;
      best = o;
    }
  });
  return best;
}
