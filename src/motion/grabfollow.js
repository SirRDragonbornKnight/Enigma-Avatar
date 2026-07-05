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
export function createGrabFollowFn(deps) {
  const { aimRole, aimState, cursorWorld, dragX, now } = deps;
  let px = null,
    pt = null,
    vx = 0,
    roll = 0;
  // ABSOLUTE aim servo: abd = sign * (angle from the GRAB-TIME rest direction to the target).
  // No error accumulation — an integrating servo railed at its cap on reversed-sign rigs, the
  // frozen error blinded the "error grows -> flip" detector, and the limb locked wrong-way.
  let restDir = null,
    sign = 1,
    bad = 0;
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
      if (rl > 1e-6 && tl > 1e-6) {
        const cx = st.dx / rl,
          cy = st.dy / rl; // current limb direction (unit)
        if (!restDir) restDir = { x: cx, y: cy }; // the grab-time reference — she was at (or near) rest
        const th = angle(restDir.x, restDir.y, tx / tl, ty / tl); // desired swing from rest, ABSOLUTE
        const m = angle(restDir.x, restDir.y, cx, cy); // the swing the rig actually performed
        // sign discovery, measured not guessed ("trust no axes"): once both the command and the
        // response are visible, a response swinging OPPOSITE the desired direction means the
        // rig's abduction sign is reversed — flip after 3 consistent frames (noise-proof, and
        // self-correcting if a later measurement proves the flip wrong).
        if (Math.abs(m) > 0.08 && Math.abs(th) > 0.08) {
          if (Math.sign(m) !== Math.sign(th)) {
            if (++bad >= 3) {
              sign = -sign;
              bad = 0;
            }
          } else bad = 0;
        }
        out.flex = { [aimRole]: [0, Math.max(-CAP, Math.min(CAP, sign * th))] };
      }
    }
    return out;
  };
}
