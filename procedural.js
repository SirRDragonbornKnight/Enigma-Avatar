// Procedural skeletal animator — moves a rigged model's OWN bones (no animation
// clips needed). The rig cascade resolves bones to humanoid ROLES; per-bone hinge
// axes are derived at build (a limb's local x/y/z is NOT anatomy — trust no axes).
//
// IDLE v4 — "LIVING LAYERS" (research-backed, 2026-06-10): a continuously-moving
// system, not pose blending. Always-on breath (0.27 Hz) + postural sway (~0.7°,
// inverted-pendulum bands) mean velocity NEVER reaches zero (the "moving hold");
// weight shifts are randomized DC offsets chased by critically-damped springs on
// a per-joint halflife LADDER (hips lead → chest → head → arms drag = follow-
// through); arms hang riding the sway or take occasional IK poses whose targets
// spring from wherever the hand IS (pop-free by construction) and wander while
// held; every channel has its own noise seed (no shared clock) and every event
// timer is jittered (no cadence). Gesture entry/exit slerp-blends ~0.25s.
// Tunables: window.EnigmaAvatar.tune({breathe, swayAmp, shiftEvery, drift, ...}).

import * as THREE from "three";
import { resolveRig } from "./rig.js";
import { bell, easeInOut as ez, dampSpring, fnoise, jitter } from "./motionmath.js";   // pure, unit-tested motion shaping + idle-v4 primitives (damper / gradient noise / jittered timers)
import { ambientAmp } from "./mathutil.js";                // pure depth→amplitude curve for the ambient layer (unit-tested)
import { classifyBone, NSFW_REGIONS } from "./region.js";  // ambient must skip NSFW bones (their LEAF bones are childless → never sprung → not in sprungNames)

const DEG = Math.PI / 180;

// Bone IDENTIFICATION lives in rig.js now (a VRM → name → geometry → override
// cascade). This module is the MOTION layer: given the resolved role→bone map it
// drives the layered idle + emotes. Pass `resolved` from resolveRig(); if omitted
// (e.g. unit tests / standalone use), it resolves names+geometry itself.
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
  const aimArm = (armRole, childRole) => {
    const a = bones[armRole], c = bones[childRole]; if (!a || !c || !a.parent) return;
    a.getWorldPosition(_aw); c.getWorldPosition(_cw);
    _dir.copy(_cw).sub(_aw); if (_dir.lengthSq() < 1e-8) return;
    _dir.normalize();
    if (_dir.y < -0.7) return;                          // already hanging steeply down → leave it (wide ~30° arms like 51dc still get normalized)
    const outSign = _dir.x >= 0 ? 1 : -1;
    _tgt.set(outSign * 0.34, -0.94, 0).normalize();     // ~70° below horizontal, slightly out
    _wq.setFromUnitVectors(_dir, _tgt);                 // world rotation that aims the arm down
    a.parent.getWorldQuaternion(_pq);                   // express it in the bone's LOCAL space: inv(P) * wq * P
    const adjust = _pq.clone().invert().multiply(_wq).multiply(_pq);
    rest[armRole] = adjust.multiply(rest[armRole]);
    a.quaternion.copy(rest[armRole]);                   // apply immediately so frame 0 isn't a T-pose
  };
  aimArm("left_arm", "left_forearm");
  aimArm("right_arm", "right_forearm");
  // …and the FOREARMS. A T-pose needs only the upper-arm aim (children inherit it), but a rig that
  // binds with a BENT ELBOW (Mal0's SCP-1471 "waving" pose: forearm flexed ~97° in the GLB) keeps that
  // bend baked into rest[] — her hand then "rests" at chest height and every rest-relative idle/hang
  // holds the arm half-raised. Aim the forearm down the same way; an already-hanging forearm
  // (dir.y < −0.7, incl. any T/A-pose after the upper-arm aim) is skipped, so straight rigs are untouched.
  model.updateWorldMatrix(true, true);                  // the upper-arm aims moved the forearms — refresh before measuring them
  aimArm("left_forearm", "left_hand");
  aimArm("right_forearm", "right_hand");

  // Natural LEG rest — the SAME disease, other limb (Mal0 bound waving; anime_catgirl BINDS in a
  // ~76° SQUAT: femur horizontal, knees folded — Sketchfab bakes whatever pose the rip was captured
  // in). Every rest-relative layer (stance, gestures, IK anchors, axis/FSIGN derivation, model
  // height) was building on that crouch. Stand the leg up at build: thigh straight down, shin
  // straight down, foot leveled — gated on the BIND knee being clearly folded (<150°), so normal
  // standing/A-pose rigs are never touched. (Runs BEFORE the flex-axis/FSIGN derivation on purpose.)
  const aimTo = (role, childRole, tgtDir) => {          // aimArm's core with a caller-chosen target, no skip heuristic
    const a = bones[role], c = bones[childRole]; if (!a || !c || !a.parent) return;
    a.getWorldPosition(_aw); c.getWorldPosition(_cw);
    _dir.copy(_cw).sub(_aw); if (_dir.lengthSq() < 1e-8) return;
    _dir.normalize();
    _wq.setFromUnitVectors(_dir, _tgt.copy(tgtDir).normalize());
    a.parent.getWorldQuaternion(_pq);
    const adjust = _pq.clone().invert().multiply(_wq).multiply(_pq);
    rest[role] = adjust.multiply(rest[role]);
    a.quaternion.copy(rest[role]);
  };
  // TRUNK rest — a squat-bound rig CURLS forward too (her hips→head line leaned well off
  // vertical, head down, hair over her face). Two passes, both gated so upright binds are
  // never touched: (1) level the whole trunk rigidly at the HIPS (the legs are re-aimed just
  // below, so this can't tilt them); (2) any remaining forward curl is unwound through
  // chest→neck→head, each taking a fraction of what's left (a distributed un-slouch reads
  // natural; dumping it all on one joint reads broken).
  const _headRef = bones.head || bones.neck || bones.chest;
  const _trunkLean = () => {                            // current hips→head direction (unit), or null
    const lo = bones.hips || bones.spine; if (!lo || !_headRef || lo === _headRef) return null;
    lo.getWorldPosition(_aw); _headRef.getWorldPosition(_cw);
    _dir.copy(_cw).sub(_aw);
    return _dir.lengthSq() > 1e-8 ? _dir.normalize() : null;
  };
  const _up = new THREE.Vector3(0, 1, 0);
  const _levelAt = (b, restKey, dirNow, frac) => {      // rotate `b`'s rest by frac of (dirNow → up), in ITS parent space
    _wq.setFromUnitVectors(dirNow, _up);
    if (frac < 1) _wq.slerp(new THREE.Quaternion(), 1 - frac);
    b.parent.getWorldQuaternion(_pq);
    const adjust = _pq.clone().invert().multiply(_wq).multiply(_pq);
    rest[restKey] = adjust.multiply(rest[restKey]);
    b.quaternion.copy(rest[restKey]);
    model.updateWorldMatrix(true, true);
  };
  let _lean = _trunkLean();
  if (_lean && bones.hips?.parent && _lean.y > 0.3 && _lean.y < 0.978) {   // upright-ish but >~12° off vertical → a baked slouch, not a style
    const was = Math.acos(Math.min(1, _lean.y)) * 180 / Math.PI;
    _levelAt(bones.hips, "hips", _lean, 1);
    for (const [role, frac] of [["chest", 0.5], ["neck", 0.5], ["head", 1]]) {   // unwind the REMAINING internal curl leaf-ward
      const b = bones[role]; if (!b || !b.parent || b === bones.hips) continue;
      _lean = _trunkLean();
      if (!_lean || _lean.y >= 0.995) break;
      _levelAt(b, role, _lean, frac);
    }
    console.log(`[avatar] trunk rest leveled: hips→head was ${was.toFixed(0)}° off vertical (slouch-bound rig)`);
  }

  const _down = new THREE.Vector3(0, -1, 0);
  for (const side of ["left", "right"]) {
    const th = bones[side + "_leg"], sh = bones[side + "_shin"], ft = bones[side + "_foot"];
    if (!th || !sh || !ft) continue;
    const tp = new THREE.Vector3(), sp = new THREE.Vector3(), fp = new THREE.Vector3();
    th.getWorldPosition(tp); sh.getWorldPosition(sp); ft.getWorldPosition(fp);
    const v1 = tp.sub(sp), v2 = fp.sub(sp);
    if (v1.lengthSq() < 1e-8 || v2.lengthSq() < 1e-8) continue;
    const kneeDeg = v1.angleTo(v2) * 180 / Math.PI;     // 180 = straight
    if (kneeDeg > 150) continue;                        // standing bind → never touch
    aimTo(side + "_leg", side + "_shin", _down);
    model.updateWorldMatrix(true, true);
    aimTo(side + "_shin", side + "_foot", _down);
    model.updateWorldMatrix(true, true);
    const toe = ft.children && ft.children[0];          // level the foot (its bind pitch belonged to the squat)
    if (toe) {
      ft.getWorldPosition(_aw); toe.getWorldPosition(_cw);
      _dir.copy(_cw).sub(_aw);
      if (_dir.lengthSq() > 1e-8) {
        _dir.normalize();
        if (Math.abs(_dir.y) > 0.45) {                  // clearly pitched → flatten, keeping its own heading
          _tgt.copy(_dir); _tgt.y = 0;
          if (_tgt.lengthSq() < 1e-6) _tgt.set(0, 0, 1);
          _wq.setFromUnitVectors(_dir, _tgt.normalize());
          ft.parent.getWorldQuaternion(_pq);
          const adjust = _pq.clone().invert().multiply(_wq).multiply(_pq);
          rest[side + "_foot"] = adjust.multiply(rest[side + "_foot"]);
          ft.quaternion.copy(rest[side + "_foot"]);
          model.updateWorldMatrix(true, true);
        }
      }
    }
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
  let stanceAnchors = null, stanceHips = null;
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
    // STANCE hand anchors (HIPS-local, pose-invariant) — the idle PLACES hands here via IK (user
    // ruling: drive the PARTS, not local x/y/z): on-hip (elbow out — a huge silhouette cue) and
    // clasped-low-front. hw = half shoulder width sizes them to the body.
    const hipsA = bones.hips || chestRef;
    const hw = wpos(bones.left_arm).distanceTo(wpos(bones.right_arm)) / 2;
    // TRUE hip half-width from the LEG ROOTS (shoulder width was a wrong proxy on wide-hipped builds —
    // the "hand on hip" landed floating outside the hip). Fall back to shoulders when legless.
    const lw = (bones.left_leg && bones.right_leg) ? Math.max(hw * 0.4, wpos(bones.left_leg).distanceTo(wpos(bones.right_leg)) / 2) : hw * 0.8;
    const hp = wpos(hipsA);
    const mkA = (v) => hipsA.worldToLocal(v.clone());
    stanceHips = hipsA;
    stanceAnchors = {
      hipL: mkA(hp.clone().addScaledVector(bodyRight, -(lw + hw * 0.10)).addScaledVector(bodyUp, hw * 0.40).addScaledVector(_forward, hw * 0.16)),   // ON the hip's side, knuckles just forward
      hipR: mkA(hp.clone().addScaledVector(bodyRight, (lw + hw * 0.10)).addScaledVector(bodyUp, hw * 0.40).addScaledVector(_forward, hw * 0.16)),
      frontL: mkA(hp.clone().addScaledVector(_forward, Math.max(hw * 1.35, lw * 1.3)).addScaledVector(bodyUp, hw * 0.3).addScaledVector(bodyRight, -hw * 0.22)),   // clear of the body FRONT — sized by hips too (deep/wide builds: hw alone put the clasp inside the torso → forearms clipped through)
      frontR: mkA(hp.clone().addScaledVector(_forward, Math.max(hw * 1.35, lw * 1.3)).addScaledVector(bodyUp, hw * 0.3).addScaledVector(bodyRight, hw * 0.22)),
    };
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
    if (fingers.L.length + fingers.R.length) console.log(`[avatar] idle: finger curl on ${fingers.L.length}+${fingers.R.length} joints (axes calibrated toward the palm)`);
  }
  let gripL = 0, gripR = 0, gripTgtL = 0, gripTgtR = 0;   // 0..1 smoothed grip (she "holds on" while grabbed/dragged)

  const limits = boneLimits.bones || {};
  const clamp = (role, axis, v) => {
    const L = limits[role]; if (!L) return v;
    return Math.max((L[axis + "_min"] ?? -180) * DEG, Math.min((L[axis + "_max"] ?? 180) * DEG, v));
  };

  // PER-MODEL IDLE (2026-06-11 pivot): every idle layer ships at ZERO — the engine carries no
  // universal personality (the one-size idle read wrong on every body plan; user ruling). The
  // life comes from THIS model's profiles.json `idle` block (seeded by idleprofile.js from its
  // real capabilities, then individually tuned). Reactive channels — cursor-look, gestures,
  // emotes, lip-sync, springs, grip — are NOT idle and run regardless of these numbers.
  // (Amplitude/cadence reference values live in idleprofile.js LIVE: breath 0.27 Hz, sway ~0.7°.)
  const params = {
    breathe: 0,        // chest breath amplitude (rad) — the single biggest "alive" signal
    breatheRate: 1.7,  // breath angular rate (rad/s) ≈ 0.27 Hz ≈ 16 breaths/min (a rate, not an amplitude)
    look: 0,           // idle head-glance amplitude (cursor-look is separate and stays live)
    elbowFlex: 0,      // relaxed elbow bend while the arms hang
    drift: 1.0,        // master liveliness multiplier (a profile can calm/excite everything at once)
    swayAmp: 0,        // postural sway amplitude (rad)
    wrist: 0,          // hand/wrist micro-motion
    shiftEvery: 0,     // mean seconds between weight shifts (0 = never)
    poseEvery: 0,      // mean seconds between arm poses (clasp/on-hip; 0 = never)
    ambient: 0,        // ambient micro-motion master for unresolved bones (0 = off)
    armLife: 0,        // arm-hang + finger noise scale (0 = arms/fingers rest still; grip still works)
    fidgetEvery: 0,    // mean seconds between appendage fidgets (0 = never)
    fidgetRegions: [], // which spring regions may fidget (empty = any safe appendage)
  };

  let t = 0, expr = "", exprT = 0, exprDur = 2.5, _additive = false, lookX = 0, lookY = 0, lookW = 0;
  let gesture = "", gestureT = 0, gestureDur = 1.6, gestureHold = false;   // AI-driven animated action (clap/jump/flip/laydown …) — SUSPENDS the idle; hold=stay posed (laydown) until cleared

  // ---- AMBIENT layer + FIDGETS — the "any body plan" idle. The role idle above only animates the
  // ~19 resolved humanoid roles; on a spider/dragon/robot (or a humanoid's fingers) every other bone
  // sat DEAD. The ambient layer gives EVERY unresolved, unsprung bone a tiny desynced micro-motion
  // (depth-scaled — chain tips breathe, trunks barely move), and the fidget scheduler occasionally
  // KICKS a sprung appendage (tail swish / ear flick / wing ruffle) through the spring physics.
  // avatar.js binds the exclusions + the spring impulse hook AFTER springs/eyes resolve (bindExtras).
  let extras = { sprungNames: [], excludeNames: [], impulse: null };
  let ambient = null;                                 // [{b, rest, s1, s2, amp}] — built lazily (after bindExtras)
  let fidgetT = 0, fidgetNext = 6;

  // ---- IDLE v4 — LIVING LAYERS (research 2026-06-10; replaces the v3 stance machine, which was the
  // robotic architecture itself: discrete pose → fixed-duration ease → hold POPS on retarget, reads
  // repetitive on a regular cadence, and is dead-still between shifts). v4 is a continuously-moving
  // system: always-on oscillators (breath + postural sway — velocity NEVER reaches zero: "moving
  // hold") summed onto neutral, weight shifts as DC offsets chased by critically-damped springs with
  // a per-joint halflife LADDER (hips lead, chest follows, head trails, arms drag = follow-through),
  // every channel on its own noise seed (no shared clock), every event timer jittered. Limbs still
  // move in BODY space (flex/IK — user ruling) and torso pitch/roll stays on the proven local axes.
  const SPR = {};                                       // damped-spring state per channel {x,v}
  const spr = (k) => (SPR[k] || (SPR[k] = { x: 0, v: 0 }));
  let wSide = 0;                                        // weight: -1 = on LEFT leg, +1 = on RIGHT, 0 = square
  let wPose = null;                                     // randomized targets of the current weight stance
  let wT = 0, wNext = 4 + Math.random() * 4;            // first shift comes early
  let armMode = "hang";                                 // "hang" | "clasp" | "hipL" | "hipR" | "release"
  let armT = 0, armNext = jitter(20);                   // first pose chance comes sooner than steady-state
  let sighT = 0, sighNext = jitter(70), sighK = 0;      // sigh = one deep slow breath (envelope 0..1)
  let energySeed = Math.random() * 100;
  let breathPh = 0;                                     // breath phase accumulator (rate changes never jump the wave); starts at exhale-rest so frame 0 ramps FROM the rest pose instead of teleporting mid-breath
  const armTgtL = { s: [null, null, null], cur: new THREE.Vector3() };   // per-hand IK target springs (world, per component)
  const armTgtR = { s: [null, null, null], cur: new THREE.Vector3() };
  for (const a of [armTgtL, armTgtR]) a.s = [{ x: 0, v: 0 }, { x: 0, v: 0 }, { x: 0, v: 0 }];
  let armTgtLive = false;                               // springs initialized from the live hand positions yet?
  // gesture-boundary anti-pop: capture the role quats when a gesture starts/ends and slerp across
  const _fromQ = {}, _scratchQ = {};
  for (const role in bones) { _fromQ[role] = new THREE.Quaternion(); _scratchQ[role] = new THREE.Quaternion(); }
  let gestureIn = 1, idleIn = 1, idleInDur = 0.3;       // 0→1 blend clocks (gesture entry / idle re-entry); the re-entry SPEED is per-path
  const captureFrom = () => { for (const role in bones) _fromQ[role].copy(bones[role].quaternion); };
  function buildAmbient() {
    const excl = new Set([...extras.sprungNames, ...extras.excludeNames]);
    const roleSet = new Set(Object.values(bones));
    const fingerSet = new Set([...fingers.L, ...fingers.R].map((f) => f.b));   // the finger-curl layer owns these now (double-driving = shake)
    const handDesc = new Set();                       // FINGERS — descendants of the hands get a much livelier curl drift (visible micro-life)
    for (const h of [bones.left_hand, bones.right_hand]) h?.traverse?.((o) => { if (o.isBone && o !== h) handDesc.add(o); });
    const list = [];
    model.traverse((o) => {
      if (!o.isBone || roleSet.has(o) || excl.has(o.name) || fingerSet.has(o)) return;
      if (!o.parent || !o.parent.isBone) return;      // skeleton roots: noise there wobbles the whole model
      // NSFW invariant: walk to the NEAREST CLASSIFIED ANCESTOR — chain tips are childless (spring
      // skips them → they fall through to ambient) and a chain named only at its root
      // (Breast → Bone042 → Bone043) must still be skipped all the way down (audit).
      let reg = null;
      for (let p = o; p && p.isBone && !reg; p = p.parent) reg = classifyBone(p.name);
      if (reg && NSFW_REGIONS.has(reg)) return;
      let depth = 0; for (let p = o.parent; p && p.isBone; p = p.parent) depth++;
      list.push({ b: o, rest: o.quaternion.clone(), s1: 7.3 + list.length * 1.7, s2: 13.9 + list.length * 2.3, amp: ambientAmp(depth) * (handDesc.has(o) ? 2.6 : 1) });
    });
    ambient = list;
    if (list.length) console.log(`[avatar] idle: ambient micro-motion on ${list.length} unresolved bones (+ ${Object.keys(bones).length} role bones, ${handDesc.size} finger bones boosted)`);
  }
  function maybeFidget(dt) {
    if (!(params.fidgetEvery > 0) || !extras.impulse) return;   // per-model: a profile with no fidgets never kicks
    fidgetT += dt;
    if (fidgetT < fidgetNext) return;
    fidgetT = 0; fidgetNext = jitter(params.fidgetEvery);
    const side = Math.random() < 0.5 ? -1 : 1;
    let tries = [                                      // safe appendages only (never NSFW regions); first one this model HAS wins
      ["tail", { x: side * (0.9 + Math.random() * 0.7), y: 0.25, z: 0 }, 0.45],
      ["ear", { x: side * 0.5, y: 0.4, z: 0 }, 0.16],
      ["wing", { x: 0, y: 0.6, z: side * 0.5 }, 0.4],
      ["hair", { x: side * 0.3, y: 0.12, z: 0 }, 0.3],
    ];
    if (Array.isArray(params.fidgetRegions) && params.fidgetRegions.length)
      tries = tries.filter(([r]) => params.fidgetRegions.includes(r));   // the profile names which appendages are HERS to fidget
    for (let i = tries.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [tries[i], tries[j]] = [tries[j], tries[i]]; }
    for (const [region, v, dur] of tries) if (extras.impulse(region, v, dur)) return;
  }
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

  const GESTURES = { clap: clapPose, jump: jumpPose, flip: flipPose, laydown: laydownPose, getup: getupPose };

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
      if (!gestureHold && gestureT >= gestureDur) { gesture = ""; captureFrom(); idleIn = 0; idleInDur = 0.3; }   // hold-clips (laydown) stay posed until cleared; on exit the idle blends back in (no snap)
      return;
    }
    const lk = params.look;

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

    // ===== IDLE v4 — LIVING LAYERS (no pose-blend states; see the state block for the architecture).
    const D = params.drift;
    const nz = (seed, sp = 1) =>                            // legacy smooth sin-sum (AMBIENT layer only — per-bone seeded there)
      Math.sin(t * 0.38 * sp + seed) * 0.62 + Math.sin(t * 0.62 * sp + seed * 1.7 + 1.3) * 0.30 + Math.sin(t * 1.05 * sp + seed * 2.3 + 2.1) * 0.08;

    // ENERGY — minutes-scale restlessness (≈0.65..1.35): calm spells and fidgety spells, never uniform.
    const energy = 1 + 0.35 * fnoise(t * 0.045, energySeed);

    // BREATH — always on ("moving hold": a pose with zero velocity reads DEAD). ONE-SIGNED raised
    // cosine (sin²), per the field survey: a raw sine's negative half reads as exhaling BELOW rest
    // (TalkingHead/VMagicMirror both use envelope/sin² waveforms). Sigh = one deep, slower breath
    // whose envelope is itself a smooth bell (an instant amplitude jump was a visible 2.9° pop).
    sighT += dt;
    if (sighT >= sighNext && sighK <= 0) { sighT = 0; sighNext = jitter(70); sighK = 1e-6; }
    if (sighK > 0) { sighK = Math.min(1, sighK + dt / 4.5); if (sighK >= 1) sighK = 0; }
    const sighE = sighK > 0 ? Math.sin(Math.PI * sighK) : 0;                  // smooth in AND out over ~4.5s
    const bAmp = params.breathe * (1 + 1.3 * sighE) * (0.85 + 0.3 * energy);
    breathPh += params.breatheRate * (1 - 0.35 * sighE) * dt;
    const breath = Math.sin(breathPh * 0.5) ** 2;                              // 0..1 at the SAME cadence (sin² halves the period)

    // POSTURAL SWAY — always on, but NOISE-dominated (the sine-dominated v4.0 mix read as a metronomic
    // "she's rocking back and forth"; gradient noise wanders without rhythm). And it stays OUT of the
    // hips pitch: the hips are the rig root, so pitching them swings the ENTIRE avatar (feet included)
    // — that read as the whole model floating/rocking in space rather than a body balancing on feet.
    const swayP = (Math.sin(t * 1.88 + 0.7) * 0.2 + Math.sin(t * 5.07 + 2.1) * 0.1 + fnoise(t * 0.16, 3) * 0.9) * params.swayAmp * energy * D;
    const swayR = (Math.sin(t * 1.55 + 4.2) * 0.12 + fnoise(t * 0.13, 7) * 0.95) * params.swayAmp * 0.6 * energy * D;   // noise-dominated like the pitch channel (0.3 sine left this 62% metronome — on the ROOT roll of all places; audit)

    // WEIGHT SHIFT — a new randomized contrapposto every shiftEvery±50% s (restless → more often).
    // Targets are DC offsets the damped springs CHASE (velocity preserved → re-shift mid-shift can't pop).
    wT += dt;
    if (params.shiftEvery > 0 && wT >= wNext) {        // 0 = this model never shifts weight (wPose stays the neutral stance)
      wT = 0; wNext = jitter(params.shiftEvery) / Math.max(0.6, energy);
      wSide = wSide === 0 ? (Math.random() < 0.5 ? -1 : 1) : (Math.random() < 0.25 ? 0 : -wSide);   // mostly alternate, sometimes square
      const m = 0.75 + Math.random() * 0.55, s = wSide;                                             // never the exact same stance twice
      wPose = s === 0
        ? { hipR: 0, spineR: 0, spineY: 0, chestR: 0, headR: 0, headY: 0, lF: 0.025, lA: -0.01, rF: 0.025, rA: 0.01, sL: -0.06, sR: -0.06 }
        : {
            hipR: -s * 0.105 * m, spineR: s * 0.066 * m, spineY: -s * 0.05 * m, chestR: s * 0.03 * m,   // hip drops over the support leg; spine counter-rolls (the S-curve)
            headR: -s * 0.02 * m, headY: -s * 0.065 * m,
            lF: s < 0 ? 0.015 : 0.05 + 0.05 * m, lA: s < 0 ? -0.018 : -(0.04 + 0.03 * m),               // support leg ~straight; free knee soft + splayed out
            rF: s > 0 ? 0.015 : 0.05 + 0.05 * m, rA: s > 0 ? 0.018 : (0.04 + 0.03 * m),
            sL: s < 0 ? -0.035 : -(0.13 + 0.09 * m), sR: s > 0 ? -0.035 : -(0.13 + 0.09 * m),
          };
    }
    const W = wPose || { hipR: 0, spineR: 0, spineY: 0, chestR: 0, headR: 0, headY: 0, lF: 0.02, lA: 0, rF: 0.02, rA: 0, sL: -0.05, sR: -0.05 };
    // halflife LADDER — hips lead, chest follows, head trails, legs roll through late (follow-through;
    // research: staggered joint timing is what separates a body from a mannequin)
    dampSpring(spr("hipR"), W.hipR, 0.4, dt);
    dampSpring(spr("spineR"), W.spineR, 0.55, dt); dampSpring(spr("spineY"), W.spineY, 0.55, dt);
    dampSpring(spr("chestR"), W.chestR, 0.68, dt);
    dampSpring(spr("headR"), W.headR, 0.85, dt); dampSpring(spr("headY"), W.headY, 0.85, dt);
    dampSpring(spr("lF"), W.lF, 0.5, dt); dampSpring(spr("lA"), W.lA, 0.5, dt);
    dampSpring(spr("rF"), W.rF, 0.5, dt); dampSpring(spr("rA"), W.rA, 0.5, dt);
    dampSpring(spr("sL"), W.sL, 0.62, dt); dampSpring(spr("sR"), W.sR, 0.62, dt);

    // torso: breath + sway + spring-chased stance offsets (local pitch/roll on the TORSO is proven).
    // Breath travels UP the chain with a phase lag; the spine counter-rolls part of the sway (S-curve).
    pose("hips", 0, exHipY, spr("hipR").x + swayR * 0.5);                       // NO pitch on the root, EVER — sway OR emote (the happy bounce put ±17° of pitch here ~once a minute, rocking the whole model feet-included; audit): it all rides the spine/chest instead
    pose("spine", Math.sin((breathPh - 0.55) * 0.5) ** 2 * bAmp * 0.5 + swayP * 0.45 + exSpine + exHipP * 0.7, spr("spineY").x, spr("spineR").x - swayR * 0.45);
    pose("chest", breath * bAmp + swayP * 0.3 + exSpine * 0.5 + exHipP * 0.5, 0, spr("chestR").x);

    // head/neck: glance wander (own noise seeds) + cursor look + trailing stance + breath bob
    const glY = fnoise(t * 0.11, 20) * lk, glP = fnoise(t * 0.13, 21) * params.look * 0.3;   // pitch glance rides params.look like yaw (was a bare 0.05 — moved even when idle glances were OFF)
    pose("neck", -breath * bAmp * 0.45 + exHeadP * 0.3 + lookY * lookW * 0.35, lookX * lookW * 0.35, spr("hipR").x * -0.3);
    pose("head", glP * (1 - lookW) + lookY * lookW + exHeadP, (glY + spr("headY").x) * (1 - lookW) + lookX * lookW + exHeadY, spr("headR").x);

    // shoulders: breath rise — deliberately ASYMMETRIC (the right lags and lifts slightly less)
    pose("left_shoulder", 0, 0, breath * bAmp * 0.25);
    pose("right_shoulder", 0, 0, -(Math.sin((breathPh - 0.4) * 0.5) ** 2) * bAmp * 0.21);

    // LEGS — flex() about the real body hinges; spring-chased so a weight shift rolls through the
    // knees a beat after the hips. Sway stays out of the legs: feet planted.
    flex("left_leg", spr("lF").x, spr("lA").x);
    flex("right_leg", spr("rF").x, spr("rA").x);
    flex("left_shin", spr("sL").x);
    flex("right_shin", spr("sR").x);

    // ARMS — two modes. HANG (the default): the arms ride the torso sway with per-side LAG (follow-
    // through) + per-side noise seeds (asymmetry — mirrored arms read as a mannequin). POSE (occasional,
    // jittered): the hands are PLACED via IK at a body anchor (clasp-front / hand-on-true-hip), with the
    // TARGET spring-chased from wherever the hand IS — entry, exit ("release"), and retargets are
    // pop-free by construction — and the held target itself WANDERS a little (moving hold).
    armT += dt;
    if (params.poseEvery > 0) {
      if (armT >= armNext) {
        armT = 0;
        if (armMode === "hang") {
          if (clapLocal && stanceAnchors && Math.random() < 0.75) {
            const r = Math.random();
            armMode = r < 0.5 ? "clasp" : (r < 0.75 ? "hipL" : "hipR");
            armTgtLive = false;                            // seed the target springs from the LIVE hand positions on entry
            armNext = jitter(13);                          // hold the pose ~6.5–19.5s
          } else armNext = jitter(params.poseEvery * 0.4); // declined → another chance sooner
        } else if (armMode !== "release") { armMode = "release"; armNext = jitter(params.poseEvery); }   // let go: chase the rest position, then resume the hang math (springs stay live — no snap)
      }
    } else if (armMode !== "hang" && armMode !== "release") {
      armMode = "release"; armT = 0; armNext = Infinity;   // poses tuned OFF mid-hold → let go cleanly, never re-enter
    }
    const armSwayL = spr("armL"), armSwayR = spr("armR");
    dampSpring(armSwayL, swayP, 0.9, dt); dampSpring(armSwayR, swayP, 1.05, dt);   // arms DRAG behind the torso, each with its own lag
    const aL = params.armLife;                          // per-model: 0 = the hang noise is gone, arms rest still (static base flex stays — it's a pose, not motion)
    if (armMode === "hang" || !clapLocal) {
      flex("left_arm", 0.035 + armSwayL.x * 0.9 + fnoise(t * 0.16, 31) * 0.022 * energy * aL, 0.03 + fnoise(t * 0.12, 32) * 0.016 * aL);
      flex("right_arm", 0.035 + armSwayR.x * 0.9 + fnoise(t * 0.16, 33) * 0.022 * energy * aL, 0.03 + fnoise(t * 0.12, 34) * 0.016 * aL);
      flex("left_forearm", params.elbowFlex + fnoise(t * 0.19, 35) * 0.03 * energy * aL);
      flex("right_forearm", params.elbowFlex + fnoise(t * 0.19, 36) * 0.03 * energy * aL);
    } else {
      chestRef.updateWorldMatrix(true, false);
      if (stanceHips) stanceHips.updateWorldMatrix(true, false);
      chestRef.getWorldQuaternion(_cp.q);
      _cp.r.copy(clapRightL).applyQuaternion(_cp.q).normalize();
      _cp.u.copy(clapUpL).applyQuaternion(_cp.q).normalize();
      _cp.f.copy(clapFwdL).applyQuaternion(_cp.q).normalize();   // live body forward
      if (!armTgtLive) {                                 // entry: springs start AT the hands (zero velocity) — no snap possible
        bones.left_hand.getWorldPosition(armTgtL.cur); bones.right_hand.getWorldPosition(armTgtR.cur);
        for (let i = 0; i < 3; i++) { armTgtL.s[i].x = armTgtL.cur.getComponent(i); armTgtL.s[i].v = 0; armTgtR.s[i].x = armTgtR.cur.getComponent(i); armTgtR.s[i].v = 0; }
        armTgtLive = true;
      }
      const reach = armReachLive();
      const anchorFor = (hand) => {                      // → world target in _cp.m ("release" → the rest hand position = a smooth let-go)
        const spec = armMode === "clasp" ? (hand === "L" ? "frontL" : "frontR")
          : (armMode === "hipL" && hand === "L") ? "hipL" : (armMode === "hipR" && hand === "R") ? "hipR" : null;
        if (spec) { _cp.m.copy(stanceAnchors[spec]); stanceHips.localToWorld(_cp.m); }
        else { _cp.m.copy(hand === "L" ? handRestL : handRestR); chestRef.localToWorld(_cp.m); }
        return _cp.m;
      };
      const chase = (tgt, hand, seed) => {
        anchorFor(hand).addScaledVector(_cp.u, fnoise(t * 0.14, seed) * reach * 0.018).addScaledVector(_cp.r, fnoise(t * 0.1, seed + 1) * reach * 0.018);   // moving hold: the held target wanders ~2% of reach
        _cp.m.addScaledVector(_cp.f, Math.min(reach * 0.22, tgt.cur.distanceTo(_cp.m) * 0.45));   // BOW the travel path out in FRONT while the hand is far — the straight-line shortcut cut through the torso
        for (let i = 0; i < 3; i++) dampSpring(tgt.s[i], _cp.m.getComponent(i), 0.5, dt);
        return tgt.cur.set(tgt.s[0].x, tgt.s[1].x, tgt.s[2].x);
      };
      const tl = chase(armTgtL, "L", 41), tr = chase(armTgtR, "R", 45);
      _cp.pl.copy(_cp.u).multiplyScalar(-0.35).addScaledVector(_cp.r, armMode === "hipL" ? -1.2 : -0.8).addScaledVector(_cp.f, 0.35);   // elbows OUT + slightly forward — forearms wrap AROUND the body, not through it
      _cp.pr.copy(_cp.u).multiplyScalar(-0.35).addScaledVector(_cp.r, armMode === "hipR" ? 1.2 : 0.8).addScaledVector(_cp.f, 0.35);
      twoBoneIK("left_arm", "left_forearm", "left_hand", tl, _cp.pl);
      twoBoneIK("right_arm", "right_forearm", "right_hand", tr, _cp.pr);
      if (armMode === "release") {                       // hands back near rest → resume the pure hang math
        _cp.c.copy(handRestL); chestRef.localToWorld(_cp.c);
        const dl = tl.distanceTo(_cp.c);
        _cp.c.copy(handRestR); chestRef.localToWorld(_cp.c);
        // BLEND the handoff, SLOWLY (1s): the hand is already home, but the IK pose can differ from
        // the hang pose by ~115° of internal arm TWIST (IK doesn't control twist; the pole planes
        // differ) — at the gesture-exit rate (0.3s) that read as an arm twitch (probe: 12.5°/frame).
        // At 1s it reads as the arm relaxing. (Unblended it was a single-frame snap; audit.)
        // idleIn<1 = a gesture-exit blend is ALREADY in flight: switching modes under it is fine,
        // but re-capturing here would grab the RAW (pre-slerp) pose and cancel that blend mid-air —
        // a measured 9.8–13°/frame arm pop (audit). Let the running blend carry the handoff instead.
        if (dl < reach * 0.08 && tr.distanceTo(_cp.c) < reach * 0.08) {
          armMode = "hang";
          if (idleIn >= 1) { captureFrom(); idleIn = 0; idleInDur = 1.0; }
        }
      }
    }
    if (exArm) {                                         // emote arm swings layer ADDITIVELY about the real flex hinge — pose()/flex() would clobber the IK
      if (flexAxis.left_arm && bones.left_arm) bones.left_arm.quaternion.multiply(_q.setFromAxisAngle(flexAxis.left_arm, FSIGN * exArm));
      if (flexAxis.right_arm && bones.right_arm) bones.right_arm.quaternion.multiply(_q.setFromAxisAngle(flexAxis.right_arm, FSIGN * -exArm));
    }

    // hands/wrists: tiny individual life (rotates the hand bone itself — IK doesn't own its rotation)
    pose("left_hand",  fnoise(t * 0.23, 60) * params.wrist * D, fnoise(t * 0.2, 61) * params.wrist * 0.6 * D, 0);
    pose("right_hand", fnoise(t * 0.23, 62) * params.wrist * D, fnoise(t * 0.2, 63) * params.wrist * 0.6 * D, 0);

    // GESTURE-EXIT anti-pop: for ~0.3s after a gesture/motion ends, slerp every role bone from the
    // gesture's final pose into the live idle — the idle is already moving, so she flows out of a clap
    // instead of teleporting to the stance (the v3 single-frame snap the audit flagged).
    if (idleIn < 1) {
      idleIn = Math.min(1, idleIn + dt / idleInDur);
      const kb = ez(idleIn);
      for (const role in bones) { const b = bones[role]; _scratchQ[role].copy(b.quaternion); b.quaternion.copy(_fromQ[role]).slerp(_scratchQ[role], kb); }
    }

    // AMBIENT — every unresolved, unsprung bone gets tiny desynced life (fingers, a spider's legs,
    // a dragon's wing joints, a robot's segments). Built lazily so bindExtras (spring/eye exclusions)
    // has landed; gesture/motion/additive branches return before this, so controlled stillness is preserved.
    if (!ambient) buildAmbient();
    const A = params.ambient * D * (0.7 + 0.3 * energy);   // ambient breathes with the energy phases too
    const kAmb = ez(idleIn);                               // ambient bones FROZE during a gesture and sit outside the role-bone blend — slerp them back in too (after a minutes-long hold the noise phase decorrelates → fingertip snap on getup; audit)
    // FINGERS — coordinated slow curl (visible, unlike the ambient micro-wiggle) + GRIP: while she's
    // grabbed/dragged the fingers curl — she holds on. Deeper joints curl more; each joint rides its
    // own slow phase so the hands breathe rather than pump. Outside the role-bone blend → kAmb-eased.
    const gk = Math.min(1, dt * 6);
    gripL += (gripTgtL - gripL) * gk; gripR += (gripTgtR - gripR) * gk;
    if (fingers.L.length || fingers.R.length) {
      const curl = (list, grip) => {
        for (const f of list) {
          // drift rides armLife (per-model; 0 = fingers rest at bind) — GRIP is reactive and always works
          const amt = ((0.05 + 0.05 * fnoise(t * 0.19, f.seed)) * (0.6 + 0.4 * energy) * D * params.armLife + grip * 0.4) * (0.5 + 0.32 * f.depth);
          _aq.copy(f.rest).multiply(_q.setFromAxisAngle(f.ax, amt));
          if (kAmb >= 1) f.b.quaternion.copy(_aq); else f.b.quaternion.slerp(_aq, kAmb);
        }
      };
      curl(fingers.L, gripL); curl(fingers.R, gripR);
    }
    if (A > 0) for (const a of ambient) {
      // two bands: a micro tremor + a SLOW, larger posture drift (~8s) — the drift is what reads as
      // alive from across the room; the frequencies stay low so more amplitude never becomes shake.
      _e.set((nz(a.s1, 0.5) + nz(a.s1 + 47, 0.13) * 1.8) * a.amp * A, (nz(a.s2, 0.4) + nz(a.s2 + 31, 0.11) * 1.8) * a.amp * A, 0, "XYZ");
      _aq.copy(a.rest).multiply(_q.setFromEuler(_e));
      if (kAmb >= 1) a.b.quaternion.copy(_aq); else a.b.quaternion.slerp(_aq, kAmb);
    }
    maybeFidget(dt);                                   // occasional tail swish / ear flick / wing ruffle (through the spring physics)
  }

  return {
    matched: R.matched,
    update,
    params,
    setParams: (p) => Object.assign(params, p),
    setExpression: (type, dur = 2.5) => { expr = type; exprT = 0; exprDur = dur; },
    setLook: (x, y, w) => { lookX = x || 0; lookY = y || 0; lookW = w == null ? 1 : Math.max(0, Math.min(1, w)); },
    setGesture: (name, dur, opts) => {
      const next = String(name || "").toLowerCase();
      captureFrom();                                     // anti-pop: blend FROM the current pose, whichever way we're switching
      if (next) gestureIn = 0;                           // EVERY entry blends — incl. gesture→gesture (108°/frame) AND same-gesture re-trigger (a re-sent "clap"/"laydown" restarted the clip at p=0 from mid-pose: 69-83°/frame measured; audit)
      if (!next && gesture) { idleIn = 0; idleInDur = 0.3; }   // gesture cleared (cancel / getup finish): blend the idle back in
      gesture = next; gestureT = 0; gestureDur = dur || 1.6; gestureHold = !!(opts && opts.hold);
    },
    gesturing: () => !!gesture,
    setGrip: (side, on) => { const v = on ? 1 : 0; if (side === "L" || side === "both") gripTgtL = v; if (side === "R" || side === "both") gripTgtR = v; },   // fingers curl while she's carried
    hasGesture: (n) => Object.prototype.hasOwnProperty.call(GESTURES, String(n || "").toLowerCase()),   // validate a dispatch BEFORE suspending the idle (unknown names must error, not freeze)
    bindExtras: (x) => {                                 // avatar.js hands over spring/eye exclusions + the impulse hook AFTER those exist; ambient rebuilds with them
      Object.assign(extras, x || {});
      ambient = null;
      const sprung = new Set(extras.sprungNames || []);  // a name-classified hand descendant (e.g. "HandRibbon"→cloth) is SPRUNG — the spring overwrites our curl every frame, so drop it from the finger layer (audit)
      for (const k of ["L", "R"]) fingers[k] = fingers[k].filter((f) => !sprung.has(f.b.name));
    },
    ikTest: () => {                                   // DIAGNOSTIC: solve each arm to the clap center and report the residual miss (model units) — isolates a failing side
      if (!clapLocal) return { error: "no clap anchors (chest/arm chains unresolved)" };
      chestRef.updateWorldMatrix(true, false);
      const tgt = _cp.c.copy(clapLocal); chestRef.localToWorld(tgt);
      const out = { reach: +armReach.toFixed(3) };
      for (const side of ["left", "right"]) {
        for (const r of [side + "_arm", side + "_forearm", side + "_hand"]) pose(r, 0, 0, 0);   // clean rest baseline
        const sh = bones[side + "_arm"], hd = bones[side + "_hand"];
        out[side + "Dist"] = sh ? +sh.getWorldPosition(new THREE.Vector3()).distanceTo(tgt).toFixed(3) : null;   // shoulder→target (vs reach = clamp check)
        const ok = twoBoneIK(side + "_arm", side + "_forearm", side + "_hand", tgt, null);
        out[side + "Err"] = ok && hd ? +hd.getWorldPosition(new THREE.Vector3()).distanceTo(tgt).toFixed(3) : "solve-failed";
        for (const r of [side + "_arm", side + "_forearm", side + "_hand"]) if (bones[r]) bones[r].quaternion.copy(rest[r]);   // restore — with the idle toggled OFF nothing would re-pose them (the probe froze the arms at the clap centre)
      }
      return out;
    },
    roleBones: () => { const o = {}; for (const r in bones) o[r] = (bones[r] && bones[r].name) || null; return o; },   // DIAGNOSTIC: which actual bone each humanoid role resolved to
    idleState: () => {                                 // DIAGNOSTIC: live idle-v4 internals — arm mode, weight side, anchor + hand-target world positions (drive blind, verify with numbers)
      const v = (x) => (x ? [+x.x.toFixed(3), +x.y.toFixed(3), +x.z.toFixed(3)] : null);
      const aw = {};
      if (stanceAnchors && stanceHips) { stanceHips.updateWorldMatrix(true, false); for (const k in stanceAnchors) { const p = stanceAnchors[k].clone(); stanceHips.localToWorld(p); aw[k] = v(p); } }
      const hl = bones.left_hand ? v(bones.left_hand.getWorldPosition(new THREE.Vector3())) : null;
      const hr = bones.right_hand ? v(bones.right_hand.getWorldPosition(new THREE.Vector3())) : null;
      const restL = handRestL && chestRef ? (() => { const p = handRestL.clone(); chestRef.updateWorldMatrix(true, false); chestRef.localToWorld(p); return v(p); })() : null;
      return { armMode, wSide, anchors: aw, handL: hl, handR: hr, tgtL: armTgtLive ? v(armTgtL.cur) : null, tgtR: armTgtLive ? v(armTgtR.cur) : null, restWorldL: restL, reach: +armReachLive().toFixed(3), grip: [+gripL.toFixed(2), +gripR.toFixed(2)], fingers: fingers.L.length + fingers.R.length };
    },
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
      return { leftKnee: ang("left_leg", "left_shin", "left_foot"), leftElbow: ang("left_arm", "left_forearm", "left_hand"), handGap: gap, armReach: +armReach.toFixed(3), fsign: FSIGN, fwd: [+_forward.x.toFixed(2), +_forward.y.toFixed(2), +_forward.z.toFixed(2)], ambient: ambient ? ambient.length : 0, roles: Object.keys(bones).length, gesture, gesturing: !!gesture, gestureHold };
    },
  };
}
