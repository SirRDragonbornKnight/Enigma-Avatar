// Procedural skeletal animator — moves a rigged model's OWN bones (no animation
// clips needed). The rig cascade resolves bones to humanoid ROLES; per-bone hinge
// axes are derived at build (a limb's local x/y/z is NOT anatomy — trust no axes).
//
// THERE IS NO IDLE ANIMATION. The whole idle system (breath, postural sway, weight
// shifts, arm poses, glances, ambient micro-motion, fidgets, the per-model tuning
// surface) was DELETED OUTRIGHT on user order (2026-06-12: "delete the idle
// animation everywhere and anything that has to do with it"). She stands bit-still
// until something REAL drives her: cursor-look (reactive), commanded gestures /
// emotes / speech, springs reacting to actual movement, finger grip while carried.
// Do not re-add self-generated motion here — not even as a "sensible default".

import * as THREE from "three";
import { resolveRig } from "./rig.js";
import { bell, easeInOut as ez } from "./motionmath.js";   // pure, unit-tested motion shaping (gesture envelopes / blends)

const DEG = Math.PI / 180;

// Bone IDENTIFICATION lives in rig.js now (a VRM → name → geometry → override
// cascade). This module is the MOTION layer: given the resolved role→bone map it
// drives commanded gestures/emotes + reactive look/grip. Pass `resolved` from
// resolveRig(); if omitted (unit tests / standalone use), it resolves itself.
export function buildProceduralRig(model, boneLimits = {}, resolved = null) {
  const R = resolved || resolveRig(model, null);
  const bones = R.roles;                 // role -> live bone
  const rest = {};
  for (const role in bones) rest[role] = bones[role].quaternion.clone();

  // Natural arm rest — RIG-AGNOSTIC. Many rigs bind in a T-pose (arms straight out).
  // The old fixed local-X "armRest" drop only matched Mixamo-style bones, so Blender/
  // Rigify arms (Toy Chica) stayed T-posed. Instead, read each arm's REAL world
  // direction and aim it toward a natural down-and-slightly-out A-pose, then bake that
  // into rest[] so the idle layers its motion on a correct base. Arms that already hang
  // down (true A-pose bind) are left untouched, so nothing that worked regresses.
  model.updateWorldMatrix(true, true);
  const _aw = new THREE.Vector3(), _cw = new THREE.Vector3(), _dir = new THREE.Vector3(), _tgt = new THREE.Vector3(), _pq = new THREE.Quaternion(), _wq = new THREE.Quaternion();
  // BIND-NORMALIZATION FRAME (audit P1, 2026-06-11): every gate and target below is RIG-LOCAL,
  // not world. The user's saved per-model rotation is applied BEFORE this runs (applyRotation
  // precedes buildProceduralRig), so world-absolute math read a user-pitched upright model as
  // "slouch-bound" on the next load and folded her against her OWN rotation. In rig space the
  // saved rotation cancels. (FSIGN's toe probe below stays world-absolute on purpose — it wants
  // the DISPLAYED orientation.) Unparented models (tests) get the identity frame: world == rig.
  const _rigQ = new THREE.Quaternion(), _rigQI = new THREE.Quaternion();
  if (model.parent) model.parent.getWorldQuaternion(_rigQ);
  _rigQI.copy(_rigQ).invert();
  const _dl = new THREE.Vector3();
  const rigDir = (v) => _dl.copy(v).applyQuaternion(_rigQI);                       // world dir → rig dir (shared scratch)
  const worldRot = (wqL) => _rigQ.clone().multiply(wqL).multiply(_rigQI);          // rig-space rotation → world rotation
  // Every WORLD rotation the bind normalization applies, per bone — so avatar.js can counter-rotate
  // gravity-authored DANGLY chains (hair/tail) back to their authored world hang. Rigid accessories
  // (ears, hats) correctly inherit the rotation; dangly rests must NOT (they're authored vs gravity).
  const restAdjust = {};
  const noteAdjust = (name, wq) => { restAdjust[name] = restAdjust[name] ? wq.clone().multiply(restAdjust[name]) : wq.clone(); };

  // TRUNK lean (rig space) — also the LYING-BIND gate for every aim below: a lying/crawling bind
  // is a STYLE, not a defect (audit: aiming limbs "down" through a horizontal body folds them 90°
  // off the body axis). No trunk info → assume upright (simple rigs, statues).
  const _headRef = bones.head || bones.neck || bones.chest;
  const _trunkLean = () => {                            // current hips→head direction in RIG space, or null
    const lo = bones.hips || bones.spine; if (!lo || !_headRef || lo === _headRef) return null;
    lo.getWorldPosition(_aw); _headRef.getWorldPosition(_cw);
    _dir.copy(_cw).sub(_aw);
    return _dir.lengthSq() > 1e-8 ? rigDir(_dir.normalize()).clone() : null;
  };
  const _lean0 = _trunkLean();
  const _bindUpright = !_lean0 || _lean0.y > 0.5;

  // TRUNK rest FIRST (audit: arms were aimed before the trunk leveled — the leveling then un-aimed
  // them by the slouch angle, ~15° forward on the catgirl; trunk → arms → legs is the only order
  // where each pass builds on a settled parent). Hips take a PARTIAL fraction so the leaf-ward
  // unwind below actually executes (frac 1 made the position line vertical → the loop was dead
  // code and the head-down orientation curl shipped unfixed).
  const _upR = new THREE.Vector3(0, 1, 0);              // rig-space up
  const _levelAt = (b, restKey, dirRigNow, frac) => {   // rotate `b`'s rest by frac of (dirRigNow → rig-up)
    const wqL = new THREE.Quaternion().setFromUnitVectors(dirRigNow, _upR);
    if (frac < 1) wqL.slerp(new THREE.Quaternion(), 1 - frac);
    const wq = worldRot(wqL);
    b.parent.getWorldQuaternion(_pq);
    const adjust = _pq.clone().invert().multiply(wq).multiply(_pq);
    rest[restKey] = adjust.multiply(rest[restKey]);
    b.quaternion.copy(rest[restKey]);
    noteAdjust(b.name, wq);
    model.updateWorldMatrix(true, true);
  };
  let _lean = _lean0;
  if (_lean && bones.hips?.parent && _lean.y > 0.3 && _lean.y < 0.978) {   // upright-ish but >~12° off vertical → a baked slouch, not a style
    const was = Math.acos(Math.min(1, _lean.y)) * 180 / Math.PI;
    _levelAt(bones.hips, "hips", _lean, 0.65);
    for (const [role, frac] of [["chest", 0.5], ["neck", 0.5], ["head", 1]]) {   // unwind the REMAINING curl leaf-ward
      const b = bones[role]; if (!b || !b.parent || b === bones.hips) continue;
      _lean = _trunkLean();
      if (!_lean || _lean.y >= 0.995) break;
      _levelAt(b, role, _lean, frac);
    }
    console.log(`[avatar] trunk rest leveled: hips→head was ${was.toFixed(0)}° off vertical (slouch-bound rig)`);
  }

  // Natural ARM rest — after the trunk; skipped entirely on lying binds.
  const aimArm = (armRole, childRole) => {
    const a = bones[armRole], c = bones[childRole]; if (!a || !c || !a.parent) return;
    a.getWorldPosition(_aw); c.getWorldPosition(_cw);
    _dir.copy(_cw).sub(_aw); if (_dir.lengthSq() < 1e-8) return;
    const dR = rigDir(_dir.normalize());                // rig-space arm direction
    if (dR.y < -0.7) return;                            // already hanging steeply down → leave it (wide ~30° arms like 51dc still get normalized)
    const outSign = dR.x >= 0 ? 1 : -1;
    _tgt.set(outSign * 0.34, -0.94, 0).normalize();     // ~70° below horizontal, slightly out (rig space)
    const wq = worldRot(_wq.setFromUnitVectors(dR, _tgt));
    a.parent.getWorldQuaternion(_pq);                   // express it in the bone's LOCAL space: inv(P) * wq * P
    const adjust = _pq.clone().invert().multiply(wq).multiply(_pq);
    rest[armRole] = adjust.multiply(rest[armRole]);
    a.quaternion.copy(rest[armRole]);                   // apply immediately so frame 0 isn't a T-pose
    // NO noteAdjust here (audit 2026-06-11): arm aims fire on MOST T-pose rigs — counter-rotating
    // sprung sleeve/ribbon chains against them regressed previously-good models AND mixed arm+trunk
    // ancestry breaks the composition order. Gravity preservation is for TRUNK/HEAD/LEG normalization
    // (the squat-bind case) only; under-arm chains keep inheriting the arm drop as they always did.
  };
  if (_bindUpright) {
    aimArm("left_arm", "left_forearm");
    aimArm("right_arm", "right_forearm");
    // …and the FOREARMS — a rig that binds with a BENT ELBOW (Mal0's "waving" pose: forearm flexed
    // ~97° in the GLB) keeps that bend baked into rest[] otherwise; already-hanging forearms skip.
    model.updateWorldMatrix(true, true);                // the upper-arm aims moved the forearms — refresh before measuring them
    aimArm("left_forearm", "left_hand");
    aimArm("right_forearm", "right_hand");
  }

  // Natural LEG rest — the SAME disease, other limb (anime_catgirl BINDS in a ~76° SQUAT: femur
  // horizontal, knees folded). Thigh aimed straight down (rig space), shin straight, foot leveled —
  // gated on the BIND knee being clearly folded (<150°) AND the bind being upright (lying = style).
  const aimTo = (role, childRole, tgtRig) => {          // aimArm's core with a caller-chosen RIG-space target, no skip heuristic
    const a = bones[role], c = bones[childRole]; if (!a || !c || !a.parent) return;
    a.getWorldPosition(_aw); c.getWorldPosition(_cw);
    _dir.copy(_cw).sub(_aw); if (_dir.lengthSq() < 1e-8) return;
    const wq = worldRot(_wq.setFromUnitVectors(rigDir(_dir.normalize()), _tgt.copy(tgtRig).normalize()));
    a.parent.getWorldQuaternion(_pq);
    const adjust = _pq.clone().invert().multiply(wq).multiply(_pq);
    rest[role] = adjust.multiply(rest[role]);
    a.quaternion.copy(rest[role]);
    noteAdjust(a.name, wq);
  };
  const _downR = new THREE.Vector3(0, -1, 0);           // rig-space down
  const _stance = {};                                   // per-side leg-normalization refs (kneecap in thigh-local + bind toe heading) → the stance() diagnostic
  if (_bindUpright) for (const side of ["left", "right"]) {
    const th = bones[side + "_leg"], sh = bones[side + "_shin"], ft = bones[side + "_foot"];
    if (!th || !sh || !ft) continue;
    const tp = new THREE.Vector3(), sp = new THREE.Vector3(), fp = new THREE.Vector3();
    th.getWorldPosition(tp); sh.getWorldPosition(sp); ft.getWorldPosition(fp);
    const v1 = tp.sub(sp), v2 = fp.sub(sp);
    if (v1.lengthSq() < 1e-8 || v2.lengthSq() < 1e-8) continue;
    const kneeDeg = v1.angleTo(v2) * 180 / Math.PI;     // 180 = straight (angle is frame-invariant)
    if (kneeDeg > 150) continue;                        // standing bind → never touch
    // BIND-POSE references, captured BEFORE any aim (the authored squat carries the intent): where
    // the KNEECAP faces (the fold opens away from it — well-defined while the knee is folded) and
    // where the TOES point (a squatter's feet stay planted facing forward). The straight-down aim
    // below is a MINIMAL rotation — it parks the leg's twist about the vertical wherever the fold
    // plane happened to be, which is "the bone issue": kneecaps rolled inward (knock-knee read)
    // and the feet inheriting that rolled heading (pigeon-toes). So: stand the leg up, then TWIST
    // it so the kneecap faces the bind's own toe heading, and re-aim the toes to the same heading.
    const kneeW = v1.normalize().add(v2.normalize()).multiplyScalar(-1);                 // kneecap dir (world); |·|≥0.5 for any knee <150°
    const kneeL = kneeW.normalize().clone().applyQuaternion(th.getWorldQuaternion(new THREE.Quaternion()).invert());   // → thigh-local, so it survives the aims
    const toe = ft.children && ft.children[0];
    let faceR = null, faceY = 0;                        // the bind's toe heading (rig-space, horizontal) + its modest bind pitch
    if (toe) {
      ft.getWorldPosition(_aw); toe.getWorldPosition(_cw);
      const f = rigDir(_dir.copy(_cw).sub(_aw)).clone();
      if (f.lengthSq() > 1e-8) {
        f.normalize();
        if (Math.abs(f.y) <= 0.45) faceY = f.y;         // a MODEST bind pitch is the foot's own design (heels) — keep it; an extreme one belongs to the squat → level (audit #6: the old 27° rule, preserved through the heading fix)
        f.y = 0;
        if (f.lengthSq() > 1e-6) faceR = f.normalize();
      }
    }
    aimTo(side + "_leg", side + "_shin", _downR);
    model.updateWorldMatrix(true, true);
    let twistDeg = 0;
    if (faceR) {                                        // TWIST the leg about rig-up: kneecap → the bind's toe heading
      const kNow = rigDir(kneeL.clone().applyQuaternion(th.getWorldQuaternion(_pq))).clone(); kNow.y = 0;   // clone — kneeL stays the pristine thigh-local reference (stance() re-derives from it)
      if (kNow.lengthSq() > 1e-4) {
        kNow.normalize();
        const ang = Math.atan2(kNow.clone().cross(faceR).y, kNow.dot(faceR));   // signed, about rig-up
        if (Math.abs(ang) > 0.06) {                     // >~3.5° of roll — worth correcting
          const wq = worldRot(_wq.setFromAxisAngle(_upR, ang));
          th.parent.getWorldQuaternion(_pq);
          const adjust = _pq.clone().invert().multiply(wq).multiply(_pq);
          rest[side + "_leg"] = adjust.multiply(rest[side + "_leg"]);
          th.quaternion.copy(rest[side + "_leg"]);
          noteAdjust(th.name, wq);
          model.updateWorldMatrix(true, true);
          twistDeg = +(ang * 180 / Math.PI).toFixed(1);
          console.log(`[avatar] leg twist corrected (${side}): kneecap was rolled ${twistDeg}° off the bind's toe heading`);
        }
      }
    }
    aimTo(side + "_shin", side + "_foot", _downR);
    model.updateWorldMatrix(true, true);
    if (toe) {                                          // FOOT: aim the toes back to the bind's own heading, flat (not "whatever the aims left")
      ft.getWorldPosition(_aw); toe.getWorldPosition(_cw);
      _dir.copy(_cw).sub(_aw);
      if (_dir.lengthSq() > 1e-8) {
        const fR = rigDir(_dir.normalize()).clone();    // rig-space toe direction now
        _tgt.copy(faceR || fR); _tgt.y = 0;             // target: the bind heading; fallback = its current heading flattened
        if (_tgt.lengthSq() < 1e-6) _tgt.set(0, 0, 1);
        _tgt.normalize();
        if (faceR && faceY) { _tgt.multiplyScalar(Math.sqrt(1 - faceY * faceY)); _tgt.y = faceY; }   // …re-tilted by the foot's own modest bind pitch (heel-safe; stays unit length)
        if (fR.angleTo(_tgt) > 0.10) {                  // pitched or rolled off the bind heading by >~6° → re-aim
          const wq = worldRot(_wq.setFromUnitVectors(fR, _tgt));
          ft.parent.getWorldQuaternion(_pq);
          const adjust = _pq.clone().invert().multiply(wq).multiply(_pq);
          rest[side + "_foot"] = adjust.multiply(rest[side + "_foot"]);
          ft.quaternion.copy(rest[side + "_foot"]);
          noteAdjust(ft.name, wq);
          model.updateWorldMatrix(true, true);
        }
      }
    }
    _stance[side] = { bindKnee: +kneeDeg.toFixed(1), kneeL: kneeL.clone(), faceR: faceR ? faceR.clone() : null, twistDeg };
    console.log(`[avatar] leg rest normalized (${side}): bind knee ${kneeDeg.toFixed(0)}° → standing (squat-bound rig)`);
  }

  // LIMB FLEXION AXIS — a rig's per-bone local frame is unknowable: on this model the upper-arm's local-X
  // is ABDUCTION (arm spreads sideways), the forearm's local-X is the elbow, and legs vary again. So the
  // big motion poses must NOT assume "pitch = forward bend". Instead we rotate each limb about the BODY'S
  // left→right axis (the real hinge for forward/back FLEXION), expressed in that bone's LOCAL space — the
  // same trick that fixed the eyes. It's correct on ANY rig and auto-mirrors L/R (same world rotation on
  // both sides). Torso/neck/head keep local pitch (their flexion IS local-X — proven by the emote signs).
  model.updateWorldMatrix(true, true);
  const _lp = new THREE.Vector3(), _rp = new THREE.Vector3(), _bq = new THREE.Quaternion();
  const bodyRight = (() => {                              // a rotation-invariant "her right" vector (L→R shoulders / arms / legs)
    for (const [l, r] of [["left_shoulder", "right_shoulder"], ["left_arm", "right_arm"], ["left_leg", "right_leg"]]) {
      if (bones[l] && bones[r]) { bones[l].getWorldPosition(_lp); bones[r].getWorldPosition(_rp); const d = _rp.clone().sub(_lp); if (d.lengthSq() > 1e-6) return d.normalize(); }
    }
    return new THREE.Vector3(1, 0, 0);
  })();
  // FSIGN — does a +flex about the hinge bend limbs FORWARD (belly side)? Auto-calibrated so motions are
  // correct even on a rig modelled facing the opposite way (else a crouch would bend BACKWARD). forward =
  // up×right, sign-fixed by the toes (feet point forward); then test which way +flex actually swings a leg.
  const bodyUp = (() => {
    const a = bones.head || bones.neck || bones.chest, b = bones.hips || bones.spine;
    if (a && b) { const pa = new THREE.Vector3(), pb = new THREE.Vector3(); a.getWorldPosition(pa); b.getWorldPosition(pb); const d = pa.sub(pb); if (d.lengthSq() > 1e-6) return d.normalize(); }
    return new THREE.Vector3(0, 1, 0);
  })();
  let _forward = new THREE.Vector3().crossVectors(bodyUp, bodyRight);
  if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, 1); else _forward.normalize();
  const _foot = bones.left_foot || bones.right_foot;     // the toe (foot's child) points forward → fixes the sign
  if (_foot && _foot.children && _foot.children[0]) {
    const pa = new THREE.Vector3(), pb = new THREE.Vector3(); _foot.getWorldPosition(pa); _foot.children[0].getWorldPosition(pb);
    const toe = pb.sub(pa); toe.y = 0;
    if (toe.lengthSq() > 1e-6 && _forward.dot(toe) < 0) _forward.negate();
  }
  let FSIGN = 1;
  if (bones.left_leg && bones.left_foot) {               // does +ω about the hinge move the foot toward forward?
    const lp = new THREE.Vector3(), fp = new THREE.Vector3(); bones.left_leg.getWorldPosition(lp); bones.left_foot.getWorldPosition(fp);
    const disp = new THREE.Vector3().crossVectors(bodyRight, fp.sub(lp));
    if (disp.dot(_forward) < 0) FSIGN = -1;
  }
  const flexAxis = {}, abductAxis = {};
  for (const role of ["left_arm", "right_arm", "left_forearm", "right_forearm", "left_hand", "right_hand", "left_leg", "right_leg", "left_shin", "right_shin"]) {
    const b = bones[role]; if (!b) continue;
    b.getWorldQuaternion(_bq);
    const inv = _bq.invert();
    flexAxis[role] = bodyRight.clone().applyQuaternion(inv).normalize();    // world-right → bone-local: the forward/back FLEXION hinge
    abductAxis[role] = _forward.clone().applyQuaternion(inv).normalize();   // world-forward → bone-local: the sideways ABDUCTION axis (knee splay)
  }

  // ---- TWO-BONE IK (analytic "simple two joint": law of cosines + aim, pole = bend hint) ----------
  // THE "just move the parts" enabler: place a HAND at a world-space target (clap / point / reach /
  // touch) instead of guessing per-rig euler angles. All axes are computed LIVE in world space and
  // converted into each bone's local frame, so it works on any rig the resolver mapped.
  const _ik = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), t: new THREE.Vector3(), v1: new THREE.Vector3(), v2: new THREE.Vector3(), ax: new THREE.Vector3(), bx: new THREE.Vector3(), px: new THREE.Vector3() };
  const _ikq = new THREE.Quaternion(), _ikwq = new THREE.Quaternion();
  const _angV = (u, v) => Math.acos(Math.max(-1, Math.min(1, u.dot(v) / ((u.length() * v.length()) || 1e-9))));
  const _cos = (x) => Math.max(-1, Math.min(1, x));
  const _rotWorldAxis = (bone, axisW, ang) => {                    // rotate a bone about a WORLD axis (converted to its local frame)
    if (!isFinite(ang) || Math.abs(ang) < 1e-4) return;
    bone.getWorldQuaternion(_ikwq).invert();
    bone.quaternion.multiply(_ikq.setFromAxisAngle(_ik.ax.copy(axisW).applyQuaternion(_ikwq).normalize(), ang));
    bone.updateWorldMatrix(false, false);
  };
  function twoBoneIK(aR, bR, cR, target, pole) {
    const a = bones[aR], b = bones[bR], c = bones[cR];
    if (!a || !b || !c) return false;
    a.getWorldPosition(_ik.a); b.getWorldPosition(_ik.b); c.getWorldPosition(_ik.c);
    const lab = _ik.a.distanceTo(_ik.b), lcb = _ik.b.distanceTo(_ik.c);
    if (lab < 1e-6 || lcb < 1e-6) return false;
    // SCALE-RELATIVE reach window (audit P1): the old absolute ±0.01 margin made the relaxed-hang
    // hand — which rests at ~99.9% of full reach — UNREACHABLE on every real model, so the clamp
    // bent the elbow 10–19° in ONE frame at every arm-pose entry and held the whole release phase
    // ~17° over-bent. All epsilons here scale with the chain, so a shrunk avatar solves the same.
    const span = lab + lcb, eps2 = span * span * 1e-8;
    _ik.t.copy(target);
    const lat = Math.max(span * 0.02, Math.min(span * 0.9995, _ik.a.distanceTo(_ik.t)));
    _ik.v1.copy(_ik.c).sub(_ik.a); _ik.v2.copy(_ik.b).sub(_ik.a);
    const ac_ab_0 = _angV(_ik.v1, _ik.v2);
    _ik.bx.copy(_ik.v1).cross(_ik.v2);                             // bend-plane normal (preallocated — this runs every idle frame in arm-pose mode)
    if (_ik.bx.lengthSq() < eps2 && pole) _ik.bx.copy(_ik.v1).cross(pole);   // exactly-straight chain → use the pole hint to pick a plane
    if (_ik.bx.lengthSq() < eps2) return false;
    _ik.bx.normalize();
    const ac_ab_1 = Math.acos(_cos((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat)));
    _ik.v1.copy(_ik.a).sub(_ik.b); _ik.v2.copy(_ik.c).sub(_ik.b);
    const ba_bc_0 = _angV(_ik.v1, _ik.v2);
    const ba_bc_1 = Math.acos(_cos((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb)));
    _rotWorldAxis(a, _ik.bx, ac_ab_1 - ac_ab_0);                   // open/close the elbow to match the target distance…
    _rotWorldAxis(b, _ik.bx, ba_bc_1 - ba_bc_0);
    c.getWorldPosition(_ik.c); a.getWorldPosition(_ik.a);          // …then AIM the (now correctly-extended) chain at the target
    _ik.v1.copy(_ik.c).sub(_ik.a); _ik.v2.copy(_ik.t).sub(_ik.a);
    _ik.bx.copy(_ik.v1).cross(_ik.v2);
    if (_ik.bx.lengthSq() > eps2) _rotWorldAxis(a, _ik.bx.normalize(), _angV(_ik.v1, _ik.v2));
    if (pole) {
      // POLE TWIST (audit: the poles were inert — only consulted on an exactly-straight chain,
      // i.e. never): swing the bend plane about the shoulder→hand axis toward the pole DIRECTION,
      // rate-limited per call so the plane EASES over (~0.2–0.5s at 60fps) instead of snapping.
      // This is what actually points the elbows out+forward (the v4.1 anti-clipping intent).
      a.getWorldPosition(_ik.a); b.getWorldPosition(_ik.b); c.getWorldPosition(_ik.c);
      _ik.bx.copy(_ik.c).sub(_ik.a);
      if (_ik.bx.lengthSq() > eps2) {
        _ik.bx.normalize();
        _ik.v1.copy(_ik.b).sub(_ik.a); _ik.v1.addScaledVector(_ik.bx, -_ik.v1.dot(_ik.bx));   // current elbow direction ⊥ chain axis
        _ik.px.copy(pole);             _ik.px.addScaledVector(_ik.bx, -_ik.px.dot(_ik.bx));   // wanted elbow direction ⊥ chain axis
        if (_ik.v1.lengthSq() > eps2 * 0.01 && _ik.px.lengthSq() > eps2 * 0.01) {
          let tw = _angV(_ik.v1, _ik.px);
          if (_ik.v2.copy(_ik.v1).cross(_ik.px).dot(_ik.bx) < 0) tw = -tw;
          _rotWorldAxis(a, _ik.bx, Math.max(-0.05, Math.min(0.05, tw)));
        }
      }
    }
    return true;
  }

  // CLAP anchors — captured in CHEST-LOCAL space at build (pose/rotation invariant): where the hands
  // meet (center-front at ~half reach), the rest hand positions (so the raise eases in, not snaps),
  // and the body right/up axes for separation + elbow poles.
  model.updateWorldMatrix(true, true);
  const chestRef = bones.chest || bones.spine || bones.hips || null;
  let clapLocal = null, clapRightL = null, clapUpL = null, clapFwdL = null, armReach = 0, handRestL = null, handRestR = null;
  if (chestRef && bones.left_arm && bones.left_forearm && bones.left_hand && bones.right_arm && bones.right_forearm && bones.right_hand) {
    const wpos = (bb) => bb.getWorldPosition(new THREE.Vector3());
    armReach = (wpos(bones.left_arm).distanceTo(wpos(bones.left_forearm)) + wpos(bones.left_forearm).distanceTo(wpos(bones.left_hand))
              + wpos(bones.right_arm).distanceTo(wpos(bones.right_forearm)) + wpos(bones.right_forearm).distanceTo(wpos(bones.right_hand))) / 2;
    const center = wpos(chestRef).addScaledVector(_forward, armReach * 0.48).addScaledVector(bodyUp, armReach * 0.06);   // meet slightly ABOVE the chest origin — a clap at chest height, not the waist
    clapLocal = chestRef.worldToLocal(center.clone());
    const cq = chestRef.getWorldQuaternion(new THREE.Quaternion()).invert();
    clapRightL = bodyRight.clone().applyQuaternion(cq).normalize();
    clapUpL = bodyUp.clone().applyQuaternion(cq).normalize();
    clapFwdL = _forward.clone().applyQuaternion(cq).normalize();   // body FORWARD in chest space — the anti-clipping axis (push targets/paths/elbows out in front)
    handRestL = chestRef.worldToLocal(wpos(bones.left_hand));
    handRestR = chestRef.worldToLocal(wpos(bones.right_hand));
  }
  const _cp = { c: new THREE.Vector3(), r: new THREE.Vector3(), u: new THREE.Vector3(), f: new THREE.Vector3(), tl: new THREE.Vector3(), tr: new THREE.Vector3(), m: new THREE.Vector3(), pl: new THREE.Vector3(), pr: new THREE.Vector3(), q: new THREE.Quaternion() };
  // armReach was captured in WORLD units at build — after a live scroll-resize every IK magnitude
  // derived from it (clap separation, target drift) would be off by the scale ratio. Scale it live.
  const _wsV = new THREE.Vector3();
  const _buildScale = model.getWorldScale(new THREE.Vector3()).x || 1;
  const armReachLive = () => armReach * ((model.getWorldScale(_wsV).x || _buildScale) / _buildScale);

  // ---- FINGERS — visible hand life. The ambient layer's per-bone wiggle is deliberately tiny and
  // UNcoordinated (it reads as nothing — "why do the fingers not move?"). Fingers need a slow
  // COORDINATED curl. TRUST NO AXES: each finger joint's curl axis+sign is CALIBRATED at build —
  // try ±X/±Y/±Z and keep the rotation that moves the chain TIP toward the wrist (= flexion toward
  // the palm); the FSIGN trick applied per joint, so it works on any rig the resolver mapped.
  const fingers = { L: [], R: [] };                     // [{b, rest, ax(local), depth, seed}]
  {
    const fq = new THREE.Quaternion(), fx = new THREE.Vector3(), ftip = new THREE.Vector3(), fw = new THREE.Vector3();
    const calibrate = (handRole, key) => {
      const hand = bones[handRole]; if (!hand) return;
      model.updateWorldMatrix(true, true);
      hand.getWorldPosition(fw);
      const list = fingers[key];
      hand.traverse((o) => {
        if (!o.isBone || o === hand) return;
        let tip = o; o.traverse((d) => { if (d.isBone) tip = d; });   // deepest descendant (pre-order: last visited)
        let depth = 1; for (let p = o.parent; p && p !== hand; p = p.parent) depth++;
        const q0 = o.quaternion.clone();
        let bestAx = null, bestD = Infinity;
        // deepest descendant = the MAIN chain end (last-visited pre-order picked a fork's nail stub; audit)
        if (tip !== o) {
          let bestDepth = -1;
          o.traverse((d) => { if (!d.isBone || d === o) return; let dd = 0; for (let p = d.parent; p && p !== o; p = p.parent) dd++; if (dd > bestDepth) { bestDepth = dd; tip = d; } });
        }
        if (tip !== o) {                                 // a joint with length below it → calibrate geometrically
          for (const av of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) for (const s of [1, -1]) {
            o.quaternion.copy(q0).multiply(fq.setFromAxisAngle(fx.set(av[0] * s, av[1] * s, av[2] * s), 0.5));
            o.updateWorldMatrix(false, true);
            tip.getWorldPosition(ftip);
            const d = ftip.distanceTo(fw);
            if (d < bestD) { bestD = d; bestAx = new THREE.Vector3(av[0] * s, av[1] * s, av[2] * s); }
          }
          o.quaternion.copy(q0); o.updateWorldMatrix(false, true);
        } else {                                         // leaf joint (still skins the last segment) → inherit the parent's curl axis, CONVERTED into this leaf's frame (copying the local vector verbatim was 90° wrong on twisted leaf binds; audit)
          const pe = list.find((e) => e.b === o.parent);
          if (pe) {
            const pw = new THREE.Quaternion(); o.parent.getWorldQuaternion(pw);
            const lw = new THREE.Quaternion(); o.getWorldQuaternion(lw);
            bestAx = pe.ax.clone().applyQuaternion(pw).applyQuaternion(lw.invert()).normalize();
          }
        }
        if (bestAx) list.push({ b: o, rest: q0, ax: bestAx, depth: Math.min(depth, 3), seed: 70 + (list.length + (key === "R" ? 40 : 0)) * 3.1 });
      });
    };
    calibrate("left_hand", "L"); calibrate("right_hand", "R");
    if (fingers.L.length + fingers.R.length) console.log(`[avatar] grip: finger curl on ${fingers.L.length}+${fingers.R.length} joints (axes calibrated toward the palm; reactive only — curls while carried)`);
  }
  let gripL = 0, gripR = 0, gripTgtL = 0, gripTgtR = 0;   // 0..1 smoothed grip (she "holds on" while grabbed/dragged)

  const limits = boneLimits.bones || {};
  const clamp = (role, axis, v) => {
    const L = limits[role]; if (!L) return v;
    return Math.max((L[axis + "_min"] ?? -180) * DEG, Math.min((L[axis + "_max"] ?? 180) * DEG, v));
  };

  // (The idle params/tune surface, ambient micro-motion layer, fidget scheduler, weight-shift
  // stance machine, arm-pose machinery, breath/sway oscillators and their damped-spring states
  // all lived here — DELETED OUTRIGHT, user order 2026-06-12. No tunables remain: there is
  // nothing to tune. The blocks below are the survivors: commanded gestures/emotes + reactive
  // look/grip, and the gesture-boundary anti-pop blends they need.)
  let t = 0, expr = "", exprT = 0, exprDur = 2.5, _additive = false, lookX = 0, lookY = 0, lookW = 0;
  let gesture = "", gestureT = 0, gestureDur = 1.6, gestureHold = false;   // AI-driven animated action (clap/jump/flip/laydown …); hold=stay posed (laydown) until cleared

  let extras = { sprungNames: [] };                     // avatar.js hands over the sprung-bone names AFTER springs resolve (bindExtras) — the finger layer must not double-drive a sprung ribbon

  // gesture-boundary anti-pop: capture the role quats when a gesture starts/ends and slerp across
  const _fromQ = {}, _scratchQ = {};
  for (const role in bones) { _fromQ[role] = new THREE.Quaternion(); _scratchQ[role] = new THREE.Quaternion(); }
  let gestureIn = 1, baseIn = 1, baseInDur = 0.3;       // 0→1 blend clocks (gesture entry / base-pose re-entry); the re-entry SPEED is per-path
  const captureFrom = () => { for (const role in bones) _fromQ[role].copy(bones[role].quaternion); };
  const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _aq = new THREE.Quaternion();
  // Each frame a controlled bone is set from a base pose, then offset — never
  // accumulates. Base is the bone's REST pose normally; in additive mode it's the
  // bone's CURRENT pose (whatever a clip just set), so emotes layer on top of a
  // playing animation instead of fighting it. Swing is about local X (pitch).
  const pose = (role, rx, ry, rz) => {
    const b = bones[role]; if (!b) return;
    _e.set(clamp(role, "pitch", rx), clamp(role, "yaw", ry), clamp(role, "roll", rz), "XYZ");
    b.quaternion.copy(_additive ? b.quaternion : rest[role]).multiply(_q.setFromEuler(_e));
  };
  // FLEX a limb forward(+)/back(−) about the body hinge axis (set above), relative to REST. This is how
  // the motion clips bend arms/legs correctly on any rig — NOT local pitch (which abducts here). Bones
  // without a hinge axis (torso) fall back to local pitch via pose().
  const _fq = new THREE.Quaternion(), _fq2 = new THREE.Quaternion();
  const flex = (role, ang, abd) => {       // ang = forward(+)/back(−) flexion; abd = sideways abduction (optional, e.g. knee splay)
    const b = bones[role], ax = flexAxis[role];
    if (!b) return;
    ang = Math.max(-2.2, Math.min(2.2, ang || 0));   // ±126° safety net — a clip typo (16.0 for 1.6) must not render garbage
    if (!ax) { pose(role, ang, 0, 0); return; }
    b.quaternion.copy(rest[role]).multiply(_fq.setFromAxisAngle(ax, FSIGN * ang));
    if (abd && abductAxis[role]) b.quaternion.multiply(_fq2.setFromAxisAngle(abductAxis[role], abd));
  };
  // --- AI GESTURE poses — animated through the RESOLVED bones on their correct local axes (NOT raw
  // whole-body transforms). Each takes p∈[0,1] over the gesture. pose() applies relative to the
  // arm-corrected REST pose, so these read as real motion on any rig with the humanoid roles. ---
  // CLAP: A-pose arms (hands out at the waist) swing FORWARD + IN so the palms meet at center-front,
  // forearms flex up, with a rhythmic in-out. Tuned live on makiro's A-pose.
  // CLAP v2 — IK-DRIVEN. The euler version never brought the hands together (verified mid-clap: the
  // arm's local axes ≠ "forward+in" on these rigs). Now each hand is PLACED at a meeting point in
  // front of the chest via twoBoneIK; the gap closes to ~palm thickness on every beat. The gesture
  // branch resets the arms to rest each frame first, so the solve starts from a clean baseline.
  function clapPose(p) {
    if (!clapLocal) return;                                        // no resolved arm chains / chest → acknowledge absence, don't fake
    const ready = Math.min(1, p * 4) * Math.min(1, (1 - p) * 5);   // ease in (first 25%) + out (last 20%)
    const beat = Math.abs(Math.sin(p * Math.PI * 5));              // ~2–3 claps
    const closeK = ready * (0.2 + 0.8 * beat);                     // closest on the beat
    chestRef.updateWorldMatrix(true, false);
    chestRef.getWorldQuaternion(_cp.q);
    _cp.c.copy(clapLocal); chestRef.localToWorld(_cp.c);           // meeting point, center-front (pose-invariant)
    _cp.r.copy(clapRightL).applyQuaternion(_cp.q).normalize();     // live body right
    _cp.u.copy(clapUpL).applyQuaternion(_cp.q).normalize();        // live body up
    const sepHalf = armReachLive() * (0.42 * (1 - closeK) + 0.03);   // → ~6% of reach apart at the beat = palms touch (scaled live — a resized model claps correctly)
    _cp.tl.copy(handRestL); chestRef.localToWorld(_cp.tl);         // raise FROM the rest hand position (ease, no snap)
    _cp.tr.copy(handRestR); chestRef.localToWorld(_cp.tr);
    _cp.tl.lerp(_cp.m.copy(_cp.c).addScaledVector(_cp.r, -sepHalf), ready);
    _cp.tr.lerp(_cp.m.copy(_cp.c).addScaledVector(_cp.r, +sepHalf), ready);
    _cp.pl.copy(_cp.u).multiplyScalar(-1).addScaledVector(_cp.r, -0.6);   // elbows bend down-and-out
    _cp.pr.copy(_cp.u).multiplyScalar(-1).addScaledVector(_cp.r, +0.6);
    twoBoneIK("left_arm", "left_forearm", "left_hand", _cp.tl, _cp.pl);
    twoBoneIK("right_arm", "right_forearm", "right_hand", _cp.tr, _cp.pr);
    pose("head", 0.06 * ready, 0, 0);                              // slight nod into it
  }

  // --- whole-body MOTION clips — ARTICULATE legs/hips/spine/arms so jump/flip/lay-down read as real body
  // motion. avatar.js drives the synced ROOT arc + whole-rig rotation; these add the limb action in sync.
  // LIMBS use flex() (forward+ / back−, about the body hinge — the ONLY way to bend correctly on this rig
  // where local pitch abducts). TORSO/head use pose() local pitch (forward+, proven by the emote signs).
  // Flexion anatomy: thigh forward = +, knee fold = −, shoulder forward-raise = +, elbow bend = +. p∈[0,1].

  // JUMP: anticipate (crouch) → launch (extend) → tuck (air) → absorb (land) → recover. The root arc is
  // avatar.js; this is the COIL-and-spring of the body that makes it read as a jump, not a float-up.
  function jumpPose(p) {
    const crouch = bell(p, 0.14, 0.085), launch = bell(p, 0.30, 0.06), air = bell(p, 0.53, 0.16), land = bell(p, 0.82, 0.075), settle = bell(p, 0.95, 0.05);
    const thigh =  0.85 * crouch + 0.45 * air + 0.7 * land - 0.2 * launch;        // knees come forward/up while coiled & airborne
    const knee  = -(1.25 * crouch + 1.55 * land + 0.5 * air) + 0.3 * launch;      // deep knee FOLD; a touch deeper on landing = squash absorb
    const arm   = -0.6 * crouch + 1.3 * launch + 1.0 * air - 0.35 * land - 0.12 * settle;   // wind back → throw up → settle with a small overshoot (follow-through)
    const fore  =  0.25 + 0.7 * crouch + 0.5 * land;                              // elbows tuck on the coil + the landing
    const splay =  0.22 * crouch + 0.14 * land;                                   // knees PART on the coil/land → the (foreshortened) crouch reads FROM THE FRONT
    pose("hips",  0.14 * crouch + 0.12 * land, 0, 0);
    pose("spine", 0.14 * crouch - 0.08 * launch, 0, 0);
    pose("chest", 0.08 * crouch - 0.05 * launch, 0, 0);
    pose("head", -0.18 * launch + 0.12 * crouch, 0, 0);   // chin up on launch, slight down on the coil
    flex("left_leg",  thigh, -splay); flex("right_leg",  thigh, splay);
    flex("left_shin", knee);          flex("right_shin", knee);
    flex("left_arm",  arm);           flex("right_arm",  arm);
    flex("left_forearm", fore);       flex("right_forearm", fore);
  }

  // FLIP: tuck into a cannonball at the apex (avatar.js spins the whole rig 360°), then extend to land.
  function flipPose(p) {
    const tuck = bell(p, 0.5, 0.19), out = bell(p, 0.9, 0.07), wind = bell(p, 0.13, 0.08);
    pose("hips",  0.18 * tuck + 0.1 * wind, 0, 0);
    pose("spine", 0.4 * tuck + 0.12 * wind, 0, 0); pose("chest", 0.25 * tuck, 0, 0);
    pose("head", 0.4 * tuck, 0, 0);   // chin to chest (spotting the tuck)
    flex("left_leg",  1.6 * tuck - 0.35 * out + 0.4 * wind); flex("right_leg",  1.6 * tuck - 0.35 * out + 0.4 * wind);
    flex("left_shin", -1.7 * tuck + 0.45 * out);             flex("right_shin", -1.7 * tuck + 0.45 * out);
    flex("left_arm",  1.0 * tuck);    flex("right_arm",  1.0 * tuck);
    flex("left_forearm", 1.5 * tuck); flex("right_forearm", 1.5 * tuck);
  }

  // The lying CURL (knees up, spine + hips folded, arms relaxed) — shared by lay-down (ramp in + hold)
  // and get-up (unfold out). `s` is the amount (0 = stand, 1 = fully curled); `breath` adds life.
  function lyingCurl(s, breath) {
    pose("hips",  0.18 * s, 0, 0);
    pose("spine", 0.16 * s + breath, 0, 0); pose("chest", 0.1 * s + breath * 0.5, 0, 0);
    pose("head", 0.12 * s, 0, 0);
    flex("left_leg",  0.95 * s); flex("right_leg",  0.78 * s);    // knees drawn up, slightly staggered (relaxed, not symmetric)
    flex("left_shin", -1.05 * s); flex("right_shin", -0.82 * s);
    flex("left_arm",  0.18 * s); flex("right_arm",  0.18 * s);
    flex("left_forearm", 0.55 * s); flex("right_forearm", 0.45 * s);
  }
  // LAY DOWN: ease into the curl and HOLD it (gestureHold), with a faint breath so she isn't a statue.
  function laydownPose(p) { lyingCurl(ez(Math.min(1, p)), Math.sin(t * 1.05) * 0.02 * ez(Math.min(1, p))); }
  // GET UP: unfold the same curl back to a neutral stand (avatar.js un-tips the body in sync).
  function getupPose(p) { lyingCurl(1 - ez(p), 0); }

  // SIT (floor sit, v1 — no chair asset needed): thighs come forward flat, heels tuck under, trunk
  // upright with a relaxed lean, hands toward the lap. avatar.js drops the root in sync (the hip
  // height change) and HOLDS until getup. p∈[0,1] ramps in; held at s=1.
  function sitPose(p) {
    const s = ez(Math.min(1, p));
    pose("hips", 0.10 * s, 0, 0);
    pose("spine", 0.06 * s, 0, 0); pose("chest", 0.04 * s, 0, 0);
    pose("head", -0.06 * s, 0, 0);                       // chin level — sitting, not slumping
    flex("left_leg", 1.5 * s, -0.16 * s); flex("right_leg", 1.5 * s, 0.16 * s);   // thighs forward + a comfortable splay
    flex("left_shin", -1.45 * s); flex("right_shin", -1.45 * s);                  // heels tucked under
    flex("left_arm", 0.55 * s, 0.05); flex("right_arm", 0.55 * s, 0.05);          // hands toward the lap
    flex("left_forearm", 0.5 * s); flex("right_forearm", 0.5 * s);
  }

  const GESTURES = { clap: clapPose, jump: jumpPose, flip: flipPose, laydown: laydownPose, getup: getupPose, sit: sitPose };

  function update(dt, walk = false, opts = {}) {
    _additive = !!opts.additive;
    t += dt;
    // AI GESTURE — drive a controlled animated action and SUSPEND the idle (+ look) so it isn't fought.
    if (gesture) {
      const wasAdd = _additive; _additive = false;   // a gesture/motion REPLACES the pose from rest — never ADD onto a playing clip ("Take 01") or it would double up
      gestureT += dt;
      const gp = gestureDur > 0 ? Math.min(1, gestureT / gestureDur) : 1;
      for (const role in bones) pose(role, 0, 0, 0);   // neutral, still stand — the clip articulates on top (no idle drift)
      (GESTURES[gesture] || (() => {}))(gp);
      if (gestureIn < 1) {                             // GESTURE-ENTRY anti-pop: blend from the pre-gesture pose (captured in setGesture) into the clip
        gestureIn = Math.min(1, gestureIn + dt / 0.22);
        const kg = ez(gestureIn);
        for (const role in bones) { const b = bones[role]; _scratchQ[role].copy(b.quaternion); b.quaternion.copy(_fromQ[role]).slerp(_scratchQ[role], kg); }
      }
      _additive = wasAdd;
      if (!gestureHold && gestureT >= gestureDur) { gesture = ""; captureFrom(); baseIn = 0; baseInDur = 0.3; }   // hold-clips (laydown) stay posed until cleared; on exit the base pose blends back in (no snap)
      return;
    }

    // AI expression: emotes drive the body bones; spring bones (tail/hair/ears)
    // then react via physics — e.g. "wag" swishes the hips so the tail whips.
    let exHipP = 0, exHipY = 0, exSpine = 0, exHeadP = 0, exHeadY = 0, exArm = 0;
    if (expr) {
      exprT += dt;
      if (exprT >= exprDur) expr = "";
      else {
        const k = Math.min(1, exprT * 3) * Math.min(1, (exprDur - exprT) * 3), p = exprT;
        if (expr === "happy" || expr === "excited") { const b = Math.sin(p * 9) * 0.3 * k; exHipP = -Math.abs(b); exSpine = b; exHeadP = -0.2 * k; exArm = Math.sin(p * 9) * 0.45 * k; }
        else if (expr === "talk") { exHeadP = Math.sin(p * 8) * 0.13 * k; exHeadY = Math.sin(p * 3.5) * 0.1 * k; }
        else if (expr === "sad") { exSpine = 0.32 * k; exHeadP = 0.42 * k; exArm = -0.18 * k; }
        else if (expr === "alert" || expr === "surprised") { exSpine = -0.16 * k; exHeadP = -0.24 * k; exArm = 0.5 * k; }
        else if (expr === "wag") { exHipY = Math.sin(p * 11) * 0.45 * k; }
        else if (expr === "nod") { exHeadP = Math.sin(p * 6) * 0.22 * k; }
        else if (expr === "shake") { exHeadY = Math.sin(p * 8) * 0.26 * k; }
      }
    }

    // Additive mode (a clip owns the idle): apply ONLY the expression offsets, on
    // top of the clip pose — no breathing / arm-drop, and a no-op when not emoting.
    if (_additive) {
      if (expr) {
        pose("chest", exSpine * 0.5 + exHipP * 0.5, 0, 0);
        pose("spine", exSpine + exHipP * 0.7, 0, 0);
        pose("neck", exHeadP * 0.3, 0, 0);
        pose("head", exHeadP, exHeadY, 0);
        pose("hips", 0, exHipY, 0);                      // emote pitch rides the SPINE/CHEST, never the root (see the sway note below)
        pose("left_arm", exArm, 0, 0);
        pose("right_arm", -exArm, 0, 0);
      }
      return;
    }

    // ===== BASE POSE — rest + commanded offsets ONLY. (The idle layers that lived here — breath,
    // sway, weight shifts, arm hang/poses, glances, wrist noise, ambient micro-motion, fidgets —
    // were DELETED OUTRIGHT, user order 2026-06-12. She stands bit-still; what remains below is
    // reactive cursor-look + commanded emote offsets on a fixed rest stance.)
    pose("hips", 0, exHipY, 0);                          // NO pitch on the root, EVER — emote pitch rides the spine/chest (pitching the root swings the whole model, feet included; audit)
    pose("spine", exSpine + exHipP * 0.7, 0, 0);
    pose("chest", exSpine * 0.5 + exHipP * 0.5, 0, 0);
    pose("neck", exHeadP * 0.3 + lookY * lookW * 0.35, lookX * lookW * 0.35, 0);
    pose("head", lookY * lookW + exHeadP, lookX * lookW + exHeadY, 0);
    pose("left_shoulder", 0, 0, 0);
    pose("right_shoulder", 0, 0, 0);
    flex("left_leg", 0); flex("right_leg", 0);
    flex("left_shin", 0); flex("right_shin", 0);
    flex("left_arm", 0.035, 0.03); flex("right_arm", 0.035, 0.03);   // the static A-pose hang — a fixed POSE, not motion (same base the old hang layer stood on)
    flex("left_forearm", 0); flex("right_forearm", 0);
    pose("left_hand", 0, 0, 0); pose("right_hand", 0, 0, 0);
    pose("left_foot", 0, 0, 0); pose("right_foot", 0, 0, 0);
    if (exArm) {                                         // emote arm swings layer ADDITIVELY about the real flex hinge
      if (flexAxis.left_arm && bones.left_arm) bones.left_arm.quaternion.multiply(_q.setFromAxisAngle(flexAxis.left_arm, FSIGN * exArm));
      if (flexAxis.right_arm && bones.right_arm) bones.right_arm.quaternion.multiply(_q.setFromAxisAngle(flexAxis.right_arm, FSIGN * -exArm));
    }

    // GESTURE-EXIT anti-pop: for a beat after a gesture/motion ends, slerp every role bone from the
    // gesture's final pose into the base pose — she flows out of a clap instead of teleporting.
    if (baseIn < 1) {
      baseIn = Math.min(1, baseIn + dt / baseInDur);
      const kb = ez(baseIn);
      for (const role in bones) { const b = bones[role]; _scratchQ[role].copy(b.quaternion); b.quaternion.copy(_fromQ[role]).slerp(_scratchQ[role], kb); }
    }

    // FINGERS — reactive GRIP only: while she's grabbed/dragged the fingers curl (she holds on);
    // released, they ease back to the bind. Deeper joints curl more. Outside the role-bone blend
    // → eased through gesture exits with the same clock.
    const kB = ez(baseIn);
    const gk = Math.min(1, dt * 6);
    gripL += (gripTgtL - gripL) * gk; gripR += (gripTgtR - gripR) * gk;
    if (fingers.L.length || fingers.R.length) {
      const curl = (list, grip) => {
        for (const f of list) {
          const amt = grip * 0.4 * (0.5 + 0.32 * f.depth);
          _aq.copy(f.rest).multiply(_q.setFromAxisAngle(f.ax, amt));
          if (kB >= 1) f.b.quaternion.copy(_aq); else f.b.quaternion.slerp(_aq, kB);
        }
      };
      curl(fingers.L, gripL); curl(fingers.R, gripR);
    }
  }

  return {
    matched: R.matched,
    restAdjust,                          // boneName → net WORLD rotation the bind normalization applied there (for dangly-chain gravity preservation in avatar.js)
    update,
    setExpression: (type, dur = 2.5) => { expr = type; exprT = 0; exprDur = dur; },
    setLook: (x, y, w) => { lookX = x || 0; lookY = y || 0; lookW = w == null ? 1 : Math.max(0, Math.min(1, w)); },
    setGesture: (name, dur, opts) => {
      const next = String(name || "").toLowerCase();
      captureFrom();                                     // anti-pop: blend FROM the current pose, whichever way we're switching
      if (next) gestureIn = 0;                           // EVERY entry blends — incl. gesture→gesture (108°/frame) AND same-gesture re-trigger (a re-sent "clap"/"laydown" restarted the clip at p=0 from mid-pose: 69-83°/frame measured; audit)
      if (!next && gesture) { baseIn = 0; baseInDur = 0.3; }   // gesture cleared (cancel / getup finish): blend the base pose back in
      gesture = next; gestureT = 0; gestureDur = dur || 1.6; gestureHold = !!(opts && opts.hold);
    },
    gesturing: () => !!gesture,
    setGrip: (side, on) => { const v = on ? 1 : 0; if (side === "L" || side === "both") gripTgtL = v; if (side === "R" || side === "both") gripTgtR = v; },   // fingers curl while she's carried
    hasGesture: (n) => Object.prototype.hasOwnProperty.call(GESTURES, String(n || "").toLowerCase()),   // validate a dispatch BEFORE suspending the idle (unknown names must error, not freeze)
    bindExtras: (x) => {                                 // avatar.js hands over the sprung-bone names AFTER springs resolve
      Object.assign(extras, x || {});
      const sprung = new Set(extras.sprungNames || []);  // a name-classified hand descendant (e.g. "HandRibbon"→cloth) is SPRUNG — the spring overwrites our curl every frame, so drop it from the finger layer (audit)
      for (const k of ["L", "R"]) fingers[k] = fingers[k].filter((f) => !sprung.has(f.b.name));
    },
    ikTest: () => {                                   // DIAGNOSTIC: solve each arm to the clap center and report the residual miss (model units) — isolates a failing side
      if (!clapLocal) return { error: "no clap anchors (chest/arm chains unresolved)" };
      chestRef.updateWorldMatrix(true, false);
      const tgt = _cp.c.copy(clapLocal); chestRef.localToWorld(tgt);
      chestRef.getWorldQuaternion(_cp.q);
      _cp.r.copy(clapRightL).applyQuaternion(_cp.q).normalize();
      _cp.u.copy(clapUpL).applyQuaternion(_cp.q).normalize();
      const out = { reach: +armReach.toFixed(3) };
      for (const side of ["left", "right"]) {
        for (const r of [side + "_arm", side + "_forearm", side + "_hand"]) pose(r, 0, 0, 0);   // clean rest baseline
        const sh = bones[side + "_arm"], hd = bones[side + "_hand"];
        out[side + "Dist"] = sh ? +sh.getWorldPosition(new THREE.Vector3()).distanceTo(tgt).toFixed(3) : null;   // shoulder→target (vs reach = clamp check)
        // same elbow pole the clap uses — with pole=null a PERFECTLY straight bind (180° elbow, the
        // catgirl's left arm) has no bend plane and reported "solve-failed" while real gestures worked
        const pole = _cp.pl.copy(_cp.u).multiplyScalar(-1).addScaledVector(_cp.r, side === "left" ? -0.6 : 0.6);
        const ok = twoBoneIK(side + "_arm", side + "_forearm", side + "_hand", tgt, pole);
        out[side + "Err"] = ok && hd ? +hd.getWorldPosition(new THREE.Vector3()).distanceTo(tgt).toFixed(3) : "solve-failed";
        for (const r of [side + "_arm", side + "_forearm", side + "_hand"]) if (bones[r]) bones[r].quaternion.copy(rest[r]);   // restore — with the idle toggled OFF nothing would re-pose them (the probe froze the arms at the clap centre)
      }
      return out;
    },
    roleBones: () => { const o = {}; for (const r in bones) o[r] = (bones[r] && bones[r].name) || null; return o; },   // DIAGNOSTIC: which actual bone each humanoid role resolved to
    restPose: () => { for (const role in bones) bones[role].quaternion.copy(rest[role]); model.updateWorldMatrix(true, true); },   // snap role bones to the (normalized) rest — clip retargeting must read CLEAN dst rests, not a mid-gesture pose
    roles: () => ({ ...bones }),                       // role → live Bone object (the retarget engine consumes this)
    gripState: () => ({ grip: [+gripL.toFixed(2), +gripR.toFixed(2)], fingers: fingers.L.length + fingers.R.length, reach: +armReachLive().toFixed(3) }),   // DIAGNOSTIC: the reactive grip (idleState died with the idle machinery, 2026-06-12)
    flexAxes: () => { const o = {}; for (const r in flexAxis) { const v = flexAxis[r]; o[r] = v ? [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)] : null; } return o; },
    jointAngles: () => {   // DIAGNOSTIC: live joint angles from WORLD positions (180=straight, <180=bent) — unambiguous
      const ang = (A, B, C) => { const a = bones[A], b = bones[B], c = bones[C]; if (!a || !b || !c) return null;
        const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
        a.getWorldPosition(pa); b.getWorldPosition(pb); c.getWorldPosition(pc);
        const v1 = pa.sub(pb).normalize(), v2 = pc.sub(pb).normalize();
        return +(Math.acos(Math.max(-1, Math.min(1, v1.dot(v2)))) * 180 / Math.PI).toFixed(1); };
      const gap = (bones.left_hand && bones.right_hand)
        ? +bones.left_hand.getWorldPosition(new THREE.Vector3()).distanceTo(bones.right_hand.getWorldPosition(new THREE.Vector3())).toFixed(3)
        : null;                                       // hand↔hand world distance — proves a clap MEETS (rest ≈ shoulder width; beat ≈ palm thickness)
      return { leftKnee: ang("left_leg", "left_shin", "left_foot"), leftElbow: ang("left_arm", "left_forearm", "left_hand"), handGap: gap, armReach: +armReach.toFixed(3), fsign: FSIGN, fwd: [+_forward.x.toFixed(2), +_forward.y.toFixed(2), +_forward.z.toFixed(2)], roles: Object.keys(bones).length, gesture, gesturing: !!gesture, gestureHold };
    },
    stance: () => {   // DIAGNOSTIC: leg stance truth — knee angles, toe headings, and (squat-normalized rigs) how far the kneecap/toes drifted off the bind's heading. Rig-frame refs are from BUILD time (post-load checks; a later live Alt-drag skews them harmlessly).
      const out = { bindUpright: _bindUpright, sides: {} };
      for (const side of ["left", "right"]) {
        const th = bones[side + "_leg"], sh = bones[side + "_shin"], ft = bones[side + "_foot"];
        if (!th || !sh || !ft) continue;
        const t = th.getWorldPosition(new THREE.Vector3()), s = sh.getWorldPosition(new THREE.Vector3()), f = ft.getWorldPosition(new THREE.Vector3());
        const v3 = (p) => [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
        const e = { knee: +(t.clone().sub(s).angleTo(f.clone().sub(s)) * 180 / Math.PI).toFixed(1), hip: v3(t), kneePos: v3(s), foot: v3(f) };
        const toe = ft.children && ft.children[0];
        let toeR = null;
        if (toe) {
          toeR = rigDir(toe.getWorldPosition(new THREE.Vector3()).sub(f)).clone(); toeR.y = 0;
          if (toeR.lengthSq() > 1e-6) { toeR.normalize(); e.toeHeading = [+toeR.x.toFixed(2), +toeR.z.toFixed(2)]; } else toeR = null;
        }
        const st = _stance[side];
        if (st) {
          e.bindKnee = st.bindKnee; e.twistDeg = st.twistDeg;
          const kw = rigDir(st.kneeL.clone().applyQuaternion(th.getWorldQuaternion(new THREE.Quaternion()))).clone(); kw.y = 0;
          if (kw.lengthSq() > 1e-4 && st.faceR) {
            kw.normalize();
            e.kneecapOffToes = +(kw.angleTo(st.faceR) * 180 / Math.PI).toFixed(1);          // ≈0 = kneecap faces where her bind's toes pointed
            if (toeR) e.toesOffBind = +(toeR.angleTo(st.faceR) * 180 / Math.PI).toFixed(1); // ≈0 = toes kept their authored heading
          }
        }
        out.sides[side] = e;
      }
      return out;
    },
  };
}
