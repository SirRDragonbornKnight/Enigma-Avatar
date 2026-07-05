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
// deps:
//   aimRole    string|null   the flex role to aim (left_arm/right_arm/left_leg/right_leg)
//   aimState   () => {sx,sy,dx,dy}|null   limb base (sx,sy) + current limb direction (dx,dy), screen plane
//   cursorWorld() => {x,y}|null           the cursor in world coords (screen plane)
//   dragX      () => number               her global x — the pendulum reads drag velocity off it
//   now        () => ms                   clock (injectable for tests)
//   abd0       number                     the compositor's APPLIED abd offset on aimRole at grab
//                                         time (procedural appliedFlex). A re-grab mid ease-back
//                                         starts displaced, NOT at rest — commanding sign*th from
//                                         true rest made the rig's first motion oppose the command,
//                                         the sign discovery locked the wrong sign, and the limb
//                                         whipped to the cap (the "re-grab launch", 2026-07-05).
//                                         Commands are abd0 + sign*th so the eased response always
//                                         starts toward the command.
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
    prevM = null;
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
      const rl = Math.hypot(st.dx, st.dy),
        tx = cw.x - st.sx,
        ty = cw.y - st.sy, // toward the cursor
        tl = Math.hypot(tx, ty);
      // near-base deadband: with the mouse-lock pinning the grabbed part under the cursor, a grab
      // near the limb BASE makes the target direction self-referential noise — hold the last aim
      // instead of jittering (out.flex simply isn't updated this frame; the compositor holds).
      if (rl > 1e-6 && tl > rl * 0.25) {
        const cx = st.dx / rl,
          cy = st.dy / rl; // current limb direction (unit)
        if (!restDir) restDir = { x: cx, y: cy }; // the grab-time reference — she was at (or near) rest
        const th = angle(restDir.x, restDir.y, tx / tl, ty / tl); // desired swing from rest, ABSOLUTE
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
        out.flex = { [aimRole]: [0, Math.max(-CAP, Math.min(CAP, abd0 + sign * th))] };
      }
    }
    return out;
  };
}
