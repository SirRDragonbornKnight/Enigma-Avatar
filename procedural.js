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
// bell / jumpElevation (gesture + clip shaping) were removed with the gesture/clip PURGE (2026-06-25);
// the AI composes ALL motion as additive layers via the compositor now — nothing here shapes a clip.
// (easeInOut survives in motionmath.js for conjure timing; it's just no longer imported here.)

const DEG = Math.PI / 180;

// Bone IDENTIFICATION lives in rig.js now (a VRM → name → geometry
// cascade). This module is the MOTION layer: given the resolved role→bone map it
// drives commanded gestures/emotes + reactive look/grip. Pass `resolved` from
// resolveRig(); if omitted (unit tests / standalone use), it resolves itself.
export function buildProceduralRig(model, boneLimits = {}, resolved = null) {
  const R = resolved || resolveRig(model, null);
  const bones = R.roles; // role -> live bone
  const rest = {};
  for (const role in bones) rest[role] = bones[role].quaternion.clone();

  // Natural arm rest — RIG-AGNOSTIC. Many rigs bind in a T-pose (arms straight out).
  // The old fixed local-X "armRest" drop only matched Mixamo-style bones, so Blender/
  // Rigify arms (Toy Chica) stayed T-posed. Instead, read each arm's REAL world
  // direction and aim it toward a natural down-and-slightly-out A-pose, then bake that
  // into rest[] so the idle layers its motion on a correct base. Arms that already hang
  // down (true A-pose bind) are left untouched, so nothing that worked regresses.
  model.updateWorldMatrix(true, true);
  const _aw = new THREE.Vector3(),
    _cw = new THREE.Vector3(),
    _dir = new THREE.Vector3(),
    _tgt = new THREE.Vector3(),
    _pq = new THREE.Quaternion(),
    _wq = new THREE.Quaternion();
  // BIND-NORMALIZATION FRAME (audit P1, 2026-06-11): every gate and target below is RIG-LOCAL,
  // not world. The user's saved per-model rotation is applied BEFORE this runs (applyRotation
  // precedes buildProceduralRig), so world-absolute math read a user-pitched upright model as
  // "slouch-bound" on the next load and folded her against her OWN rotation. In rig space the
  // saved rotation cancels. (FSIGN's toe probe below stays world-absolute on purpose — it wants
  // the DISPLAYED orientation.) Unparented models (tests) get the identity frame: world == rig.
  const _rigQ = new THREE.Quaternion(),
    _rigQI = new THREE.Quaternion();
  if (model.parent) model.parent.getWorldQuaternion(_rigQ);
  _rigQI.copy(_rigQ).invert();
  const _dl = new THREE.Vector3();
  const rigDir = (v) => _dl.copy(v).applyQuaternion(_rigQI); // world dir → rig dir (shared scratch)
  const worldRot = (wqL) => _rigQ.clone().multiply(wqL).multiply(_rigQI); // rig-space rotation → world rotation
  // Every WORLD rotation the bind normalization applies, per bone — so avatar.js can counter-rotate
  // gravity-authored DANGLY chains (hair/tail) back to their authored world hang. Rigid accessories
  // (ears, hats) correctly inherit the rotation; dangly rests must NOT (they're authored vs gravity).
  const restAdjust = {};
  const noteAdjust = (name, wq) => {
    restAdjust[name] = restAdjust[name] ? wq.clone().multiply(restAdjust[name]) : wq.clone();
  };

  // TRUNK lean (rig space) — also the LYING-BIND gate for every aim below: a lying/crawling bind
  // is a STYLE, not a defect (audit: aiming limbs "down" through a horizontal body folds them 90°
  // off the body axis). No trunk info → assume upright (simple rigs, statues).
  const _headRef = bones.head || bones.neck || bones.chest;
  const _trunkLean = () => {
    // current hips→head direction in RIG space, or null
    const lo = bones.hips || bones.spine;
    if (!lo || !_headRef || lo === _headRef) return null;
    lo.getWorldPosition(_aw);
    _headRef.getWorldPosition(_cw);
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
  const _upR = new THREE.Vector3(0, 1, 0); // rig-space up
  const _levelAt = (b, restKey, dirRigNow, frac) => {
    // rotate `b`'s rest by frac of (dirRigNow → rig-up)
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
  if (_lean && bones.hips?.parent && _lean.y > 0.3 && _lean.y < 0.978) {
    // upright-ish but >~12° off vertical → a baked slouch, not a style
    const was = (Math.acos(Math.min(1, _lean.y)) * 180) / Math.PI;
    _levelAt(bones.hips, "hips", _lean, 0.65);
    for (const [role, frac] of [
      ["chest", 0.5],
      ["neck", 0.5],
      ["head", 1],
    ]) {
      // unwind the REMAINING curl leaf-ward
      const b = bones[role];
      if (!b || !b.parent || b === bones.hips) continue;
      _lean = _trunkLean();
      if (!_lean || _lean.y >= 0.995) break;
      _levelAt(b, role, _lean, frac);
    }
    console.log(`[avatar] trunk rest leveled: hips→head was ${was.toFixed(0)}° off vertical (slouch-bound rig)`);
  }

  // Natural ARM rest — after the trunk; skipped entirely on lying binds.
  const aimArm = (armRole, childRole) => {
    const a = bones[armRole],
      c = bones[childRole];
    if (!a || !c || !a.parent) return;
    a.getWorldPosition(_aw);
    c.getWorldPosition(_cw);
    _dir.copy(_cw).sub(_aw);
    if (_dir.lengthSq() < 1e-8) return;
    const dR = rigDir(_dir.normalize()); // rig-space arm direction
    if (dR.y < -0.7) return; // already hanging steeply down → leave it (wide ~30° arms like 51dc still get normalized)
    const outSign = dR.x >= 0 ? 1 : -1;
    _tgt.set(outSign * 0.34, -0.94, 0).normalize(); // ~70° below horizontal, slightly out (rig space)
    const wq = worldRot(_wq.setFromUnitVectors(dR, _tgt));
    a.parent.getWorldQuaternion(_pq); // express it in the bone's LOCAL space: inv(P) * wq * P
    const adjust = _pq.clone().invert().multiply(wq).multiply(_pq);
    rest[armRole] = adjust.multiply(rest[armRole]);
    a.quaternion.copy(rest[armRole]); // apply immediately so frame 0 isn't a T-pose
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
    model.updateWorldMatrix(true, true); // the upper-arm aims moved the forearms — refresh before measuring them
    aimArm("left_forearm", "left_hand");
    aimArm("right_forearm", "right_hand");
  }

  // Natural LEG rest — the SAME disease, other limb (anime_catgirl BINDS in a ~76° SQUAT: femur
  // horizontal, knees folded). Thigh aimed straight down (rig space), shin straight, foot leveled —
  // gated on the BIND knee being clearly folded (<150°) AND the bind being upright (lying = style).
  const aimTo = (role, childRole, tgtRig) => {
    // aimArm's core with a caller-chosen RIG-space target, no skip heuristic
    const a = bones[role],
      c = bones[childRole];
    if (!a || !c || !a.parent) return;
    a.getWorldPosition(_aw);
    c.getWorldPosition(_cw);
    _dir.copy(_cw).sub(_aw);
    if (_dir.lengthSq() < 1e-8) return;
    const wq = worldRot(_wq.setFromUnitVectors(rigDir(_dir.normalize()), _tgt.copy(tgtRig).normalize()));
    a.parent.getWorldQuaternion(_pq);
    const adjust = _pq.clone().invert().multiply(wq).multiply(_pq);
    rest[role] = adjust.multiply(rest[role]);
    a.quaternion.copy(rest[role]);
    noteAdjust(a.name, wq);
  };
  const _downR = new THREE.Vector3(0, -1, 0); // rig-space down
  const _stance = {}; // per-side leg-normalization refs (kneecap in thigh-local + bind toe heading) → the stance() diagnostic
  if (_bindUpright)
    for (const side of ["left", "right"]) {
      const th = bones[side + "_leg"],
        sh = bones[side + "_shin"],
        ft = bones[side + "_foot"];
      if (!th || !sh || !ft) continue;
      const tp = new THREE.Vector3(),
        sp = new THREE.Vector3(),
        fp = new THREE.Vector3();
      th.getWorldPosition(tp);
      sh.getWorldPosition(sp);
      ft.getWorldPosition(fp);
      const v1 = tp.sub(sp),
        v2 = fp.sub(sp);
      if (v1.lengthSq() < 1e-8 || v2.lengthSq() < 1e-8) continue;
      const kneeDeg = (v1.angleTo(v2) * 180) / Math.PI; // 180 = straight (angle is frame-invariant)
      if (kneeDeg > 150) continue; // standing bind → never touch
      if (kneeDeg < 35) {
        // FULLY-FOLDED bind (aveline: 8.8°/20.4°) = a packaging/design pose, NOT a capture squat — the fold direction/kneecap math is ill-conditioned there and "standing it up" wrecked a folded robot (battery 2026-06-12: legs flung sideways, 15-unit-wide box). Leave it as authored.
        console.log(
          `[avatar] leg bind ${side} is fully folded (${kneeDeg.toFixed(0)}°) — packaging pose, left as authored (squat normalization covers ~35–150°)`
        );
        continue;
      }
      // BIND-POSE references, captured BEFORE any aim (the authored squat carries the intent): where
      // the KNEECAP faces (the fold opens away from it — well-defined while the knee is folded) and
      // where the TOES point (a squatter's feet stay planted facing forward). The straight-down aim
      // below is a MINIMAL rotation — it parks the leg's twist about the vertical wherever the fold
      // plane happened to be, which is "the bone issue": kneecaps rolled inward (knock-knee read)
      // and the feet inheriting that rolled heading (pigeon-toes). So: stand the leg up, then TWIST
      // it so the kneecap faces the bind's own toe heading, and re-aim the toes to the same heading.
      const kneeW = v1.normalize().add(v2.normalize()).multiplyScalar(-1); // kneecap dir (world); |·|≥0.5 for any knee <150°
      const kneeL = kneeW.normalize().clone().applyQuaternion(th.getWorldQuaternion(new THREE.Quaternion()).invert()); // → thigh-local, so it survives the aims
      const toe = ft.children && ft.children[0];
      let faceR = null,
        faceY = 0; // the bind's toe heading (rig-space, horizontal) + its modest bind pitch
      if (toe) {
        ft.getWorldPosition(_aw);
        toe.getWorldPosition(_cw);
        const f = rigDir(_dir.copy(_cw).sub(_aw)).clone();
        if (f.lengthSq() > 1e-8) {
          f.normalize();
          if (Math.abs(f.y) <= 0.45) faceY = f.y; // a MODEST bind pitch is the foot's own design (heels) — keep it; an extreme one belongs to the squat → level (audit #6: the old 27° rule, preserved through the heading fix)
          f.y = 0;
          if (f.lengthSq() > 1e-6) faceR = f.normalize();
        }
      }
      aimTo(side + "_leg", side + "_shin", _downR);
      model.updateWorldMatrix(true, true);
      let twistDeg = 0;
      if (faceR) {
        // TWIST the leg about rig-up: kneecap → the bind's toe heading
        const kNow = rigDir(kneeL.clone().applyQuaternion(th.getWorldQuaternion(_pq))).clone();
        kNow.y = 0; // clone — kneeL stays the pristine thigh-local reference (stance() re-derives from it)
        if (kNow.lengthSq() > 1e-4) {
          kNow.normalize();
          const ang = Math.atan2(kNow.clone().cross(faceR).y, kNow.dot(faceR)); // signed, about rig-up
          if (Math.abs(ang) > 0.06) {
            // >~3.5° of roll — worth correcting
            const wq = worldRot(_wq.setFromAxisAngle(_upR, ang));
            th.parent.getWorldQuaternion(_pq);
            const adjust = _pq.clone().invert().multiply(wq).multiply(_pq);
            rest[side + "_leg"] = adjust.multiply(rest[side + "_leg"]);
            th.quaternion.copy(rest[side + "_leg"]);
            noteAdjust(th.name, wq);
            model.updateWorldMatrix(true, true);
            twistDeg = +((ang * 180) / Math.PI).toFixed(1);
            console.log(
              `[avatar] leg twist corrected (${side}): kneecap was rolled ${twistDeg}° off the bind's toe heading`
            );
          }
        }
      }
      aimTo(side + "_shin", side + "_foot", _downR);
      model.updateWorldMatrix(true, true);
      if (toe) {
        // FOOT: aim the toes back to the bind's own heading, flat (not "whatever the aims left")
        ft.getWorldPosition(_aw);
        toe.getWorldPosition(_cw);
        _dir.copy(_cw).sub(_aw);
        if (_dir.lengthSq() > 1e-8) {
          const fR = rigDir(_dir.normalize()).clone(); // rig-space toe direction now
          _tgt.copy(faceR || fR);
          _tgt.y = 0; // target: the bind heading; fallback = its current heading flattened
          if (_tgt.lengthSq() < 1e-6) _tgt.set(0, 0, 1);
          _tgt.normalize();
          if (faceR && faceY) {
            _tgt.multiplyScalar(Math.sqrt(1 - faceY * faceY));
            _tgt.y = faceY;
          } // …re-tilted by the foot's own modest bind pitch (heel-safe; stays unit length)
          if (fR.angleTo(_tgt) > 0.1) {
            // pitched or rolled off the bind heading by >~6° → re-aim
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
      _stance[side] = {
        bindKnee: +kneeDeg.toFixed(1),
        kneeL: kneeL.clone(),
        faceR: faceR ? faceR.clone() : null,
        twistDeg,
      };
      console.log(
        `[avatar] leg rest normalized (${side}): bind knee ${kneeDeg.toFixed(0)}° → standing (squat-bound rig)`
      );
    }

  // LIMB FLEXION AXIS — a rig's per-bone local frame is unknowable: on this model the upper-arm's local-X
  // is ABDUCTION (arm spreads sideways), the forearm's local-X is the elbow, and legs vary again. So the
  // big motion poses must NOT assume "pitch = forward bend". Instead we rotate each limb about the BODY'S
  // left→right axis (the real hinge for forward/back FLEXION), expressed in that bone's LOCAL space — the
  // same trick that fixed the eyes. It's correct on ANY rig and auto-mirrors L/R (same world rotation on
  // both sides). Torso/neck/head keep local pitch (their flexion IS local-X — proven by the emote signs).
  model.updateWorldMatrix(true, true);
  const _lp = new THREE.Vector3(),
    _rp = new THREE.Vector3(),
    _bq = new THREE.Quaternion();
  const bodyRight = (() => {
    // a rotation-invariant "her right" vector (L→R shoulders / arms / legs)
    for (const [l, r] of [
      ["left_shoulder", "right_shoulder"],
      ["left_arm", "right_arm"],
      ["left_leg", "right_leg"],
    ]) {
      if (bones[l] && bones[r]) {
        bones[l].getWorldPosition(_lp);
        bones[r].getWorldPosition(_rp);
        const d = _rp.clone().sub(_lp);
        if (d.lengthSq() > 1e-6) return d.normalize();
      }
    }
    return new THREE.Vector3(1, 0, 0);
  })();
  // FSIGN — does a +flex about the hinge bend limbs FORWARD (belly side)? Auto-calibrated so motions are
  // correct even on a rig modelled facing the opposite way (else a crouch would bend BACKWARD). forward =
  // up×right, sign-fixed by the toes (feet point forward); then test which way +flex actually swings a leg.
  const bodyUp = (() => {
    const a = bones.head || bones.neck || bones.chest,
      b = bones.hips || bones.spine;
    if (a && b) {
      const pa = new THREE.Vector3(),
        pb = new THREE.Vector3();
      a.getWorldPosition(pa);
      b.getWorldPosition(pb);
      const d = pa.sub(pb);
      if (d.lengthSq() > 1e-6) return d.normalize();
    }
    return new THREE.Vector3(0, 1, 0);
  })();
  let _forward = new THREE.Vector3().crossVectors(bodyUp, bodyRight);
  if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, 1);
  else _forward.normalize();
  const _foot = bones.left_foot || bones.right_foot; // the toe (foot's child) points forward → fixes the sign
  if (_foot && _foot.children && _foot.children[0]) {
    const pa = new THREE.Vector3(),
      pb = new THREE.Vector3();
    _foot.getWorldPosition(pa);
    _foot.children[0].getWorldPosition(pb);
    const toe = pb.sub(pa);
    toe.y = 0;
    if (toe.lengthSq() > 1e-6 && _forward.dot(toe) < 0) _forward.negate();
  }
  let FSIGN = 1;
  if (bones.left_leg && bones.left_foot) {
    // does +ω about the hinge move the foot toward forward?
    const lp = new THREE.Vector3(),
      fp = new THREE.Vector3();
    bones.left_leg.getWorldPosition(lp);
    bones.left_foot.getWorldPosition(fp);
    const disp = new THREE.Vector3().crossVectors(bodyRight, fp.sub(lp));
    if (disp.dot(_forward) < 0) FSIGN = -1;
  }
  const flexAxis = {},
    abductAxis = {};
  for (const role of [
    "left_arm",
    "right_arm",
    "left_forearm",
    "right_forearm",
    "left_hand",
    "right_hand",
    "left_leg",
    "right_leg",
    "left_shin",
    "right_shin",
  ]) {
    const b = bones[role];
    if (!b) continue;
    b.getWorldQuaternion(_bq);
    const inv = _bq.invert();
    flexAxis[role] = bodyRight.clone().applyQuaternion(inv).normalize(); // world-right → bone-local: the forward/back FLEXION hinge
    abductAxis[role] = _forward.clone().applyQuaternion(inv).normalize(); // world-forward → bone-local: the sideways ABDUCTION axis (knee splay)
  }

  // ---- ARM REACH (diagnostic) — half the summed L+R arm-chain length, captured in WORLD units at
  // build. The twoBoneIK solver + the clap-anchor machinery that USED to live here were DEAD CODE
  // (zero call sites — the AI composes all motion via the layer stack now) and were DELETED (#10).
  // armReach survives because the diagnostics (gripState.reach, jointAngles.armReach) read it.
  model.updateWorldMatrix(true, true);
  const chestRef = bones.chest || bones.spine || bones.hips || null;
  let armReach = 0;
  if (
    chestRef &&
    bones.left_arm &&
    bones.left_forearm &&
    bones.left_hand &&
    bones.right_arm &&
    bones.right_forearm &&
    bones.right_hand
  ) {
    const wpos = (bb) => bb.getWorldPosition(new THREE.Vector3());
    armReach =
      (wpos(bones.left_arm).distanceTo(wpos(bones.left_forearm)) +
        wpos(bones.left_forearm).distanceTo(wpos(bones.left_hand)) +
        wpos(bones.right_arm).distanceTo(wpos(bones.right_forearm)) +
        wpos(bones.right_forearm).distanceTo(wpos(bones.right_hand))) /
      2;
  }
  // armReach was captured in WORLD units at build — after a live scroll-resize the diagnostic reach
  // would be off by the scale ratio, so report it scaled to the live world scale.
  const _wsV = new THREE.Vector3();
  const _buildScale = model.getWorldScale(new THREE.Vector3()).x || 1;
  const armReachLive = () => armReach * ((model.getWorldScale(_wsV).x || _buildScale) / _buildScale);

  // ---- FINGERS — full per-finger control. Joints are grouped into per-finger CHAINS (each direct
  // bone-child of the hand = one finger), named thumb/index/middle/ring/pinky where detectable.
  // TRUST NO AXES: each joint's curl axis+sign is CALIBRATED at build (try ±X/±Y/±Z, keep the
  // rotation that moves the chain TIP toward the wrist = flexion toward the palm) — rig-agnostic.
  // The AI drives any finger via setFingers(); the reactive carry-grip is the no-target default.
  const fingers = { L: [], R: [] }; // per hand: [{ name, joints:[{b,rest,ax(local),depth}], cur, tgt }] — tgt=null follows the reactive grip
  {
    const fq = new THREE.Quaternion(),
      fx = new THREE.Vector3(),
      ftip = new THREE.Vector3(),
      fw = new THREE.Vector3();
    const FINGER_RE = [
      ["thumb", /thumb/i],
      ["index", /index|fore|point/i],
      ["middle", /middle|mid/i],
      ["ring", /ring/i],
      ["pinky", /pinky|little|pink/i],
    ];
    const nameOf = (root) => {
      const n = root.name || "";
      for (const [lab, re] of FINGER_RE) if (re.test(n)) return lab;
      return null;
    };
    const axisFor = (o, q0) => {
      // the proven per-joint curl-axis calibration; null = leaf (caller inherits)
      let tip = o,
        bestDepth = -1;
      o.traverse((d) => {
        if (!d.isBone || d === o) return;
        let dd = 0;
        for (let p = d.parent; p && p !== o; p = p.parent) dd++;
        if (dd > bestDepth) {
          bestDepth = dd;
          tip = d;
        }
      });
      if (tip === o) return null;
      let bestAx = null,
        bestD = Infinity;
      for (const av of [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ])
        for (const s of [1, -1]) {
          o.quaternion.copy(q0).multiply(fq.setFromAxisAngle(fx.set(av[0] * s, av[1] * s, av[2] * s), 0.5));
          o.updateWorldMatrix(false, true);
          tip.getWorldPosition(ftip);
          const d = ftip.distanceTo(fw);
          if (d < bestD) {
            bestD = d;
            bestAx = new THREE.Vector3(av[0] * s, av[1] * s, av[2] * s);
          }
        }
      o.quaternion.copy(q0);
      o.updateWorldMatrix(false, true);
      return bestAx;
    };
    const calibrate = (handRole, key) => {
      const hand = bones[handRole];
      if (!hand) return;
      model.updateWorldMatrix(true, true);
      hand.getWorldPosition(fw);
      let auto = 0;
      for (const root of hand.children) {
        // each direct bone-child of the hand = ONE finger
        if (!root.isBone) continue;
        const joints = [];
        const walk = (o) => {
          if (!o.isBone) return;
          let depth = 1;
          for (let p = o.parent; p && p !== hand; p = p.parent) depth++;
          const q0 = o.quaternion.clone();
          let ax = axisFor(o, q0);
          if (!ax) {
            // leaf joint → inherit parent's axis, converted into this leaf's frame
            const pe = joints.find((e) => e.b === o.parent);
            if (pe) {
              const pw = new THREE.Quaternion();
              o.parent.getWorldQuaternion(pw);
              const lw = new THREE.Quaternion();
              o.getWorldQuaternion(lw);
              ax = pe.ax.clone().applyQuaternion(pw).applyQuaternion(lw.invert()).normalize();
            }
          }
          if (ax) joints.push({ b: o, rest: q0, ax, depth: Math.min(depth, 3) });
          for (const c of o.children) walk(c);
        };
        walk(root);
        if (joints.length) fingers[key].push({ name: nameOf(root) || "finger" + auto++, joints, cur: 0, tgt: null });
      }
    };
    calibrate("left_hand", "L");
    calibrate("right_hand", "R");
    const nj = (k) => fingers[k].reduce((n, f) => n + f.joints.length, 0);
    if (fingers.L.length + fingers.R.length)
      console.log(
        `[avatar] fingers: L[${fingers.L.map((f) => f.name).join(",")}] R[${fingers.R.map((f) => f.name).join(",")}] (${nj("L")}+${nj("R")} joints; curl axes calibrated toward the palm)`
      );
  }
  let gripL = 0,
    gripR = 0,
    gripTgtL = 0,
    gripTgtR = 0; // 0..1 smoothed grip (she "holds on" while grabbed/dragged)

  const limits = boneLimits.bones || {};
  const limitDefault = boneLimits.default || null;
  const clamp = (role, axis, v) => {
    const L = limits[role];
    if (!L) return v;
    return Math.max((L[axis + "_min"] ?? -180) * DEG, Math.min((L[axis + "_max"] ?? 180) * DEG, v));
  };
  // FLEX clamp — the flex channel rotates about a hinge, so it has no pitch/yaw/roll euler. Map the
  // signed FLEXION (forward/back about the hinge) onto the role's PITCH limit and ABDUCTION (sideways)
  // onto the wider of its yaw/roll limit; fall back to +-2.2 rad (the old safety net) for any role with
  // no limit entry. Returns the clamped value in radians. (#3)
  const FLEX_CAP = 2.2;
  const clampFlex = (role, ang) => {
    const L = limits[role];
    if (!L) return Math.max(-FLEX_CAP, Math.min(FLEX_CAP, ang || 0));
    const lo = (L.pitch_min ?? -126) * DEG,
      hi = (L.pitch_max ?? 126) * DEG;
    return Math.max(lo, Math.min(hi, ang || 0));
  };
  const clampAbd = (role, abd) => {
    const L = limits[role];
    if (!L) return Math.max(-FLEX_CAP, Math.min(FLEX_CAP, abd || 0));
    const lim =
      Math.max(
        Math.abs(L.yaw_min ?? 0),
        Math.abs(L.yaw_max ?? 0),
        Math.abs(L.roll_min ?? 0),
        Math.abs(L.roll_max ?? 0)
      ) * DEG || FLEX_CAP;
    return Math.max(-lim, Math.min(lim, abd || 0));
  };
  // Per-role angular SPEED limit (deg/s from bone_limits.json) -> radians/s. The velocity-continuous
  // "never janky" clamp (#28) reads this; a role with no entry inherits `default`. With NO limit table
  // at all (e.g. unit tests passing {}), there is no advertised speed to honor -> return Infinity so the
  // clamp is INERT (it is BUILT off bone_limits.json; absent the file it must not invent a cap).
  const speedLimit = (role) => {
    const L = limits[role] || limitDefault;
    const dps = L && L.speed_limit != null ? L.speed_limit : null;
    return dps == null || !(dps > 0) ? Infinity : dps * DEG; // absent OR <=0/NaN -> INERT (Infinity): a 0/negative bone_limits entry must not FREEZE or INVERT a whole role
  };

  // (The idle params/tune surface, ambient micro-motion layer, fidget scheduler, weight-shift
  // stance machine, arm-pose machinery, breath/sway oscillators and their damped-spring states
  // all lived here — DELETED OUTRIGHT, user order 2026-06-12. No tunables remain: there is
  // nothing to tune. The blocks below are the survivors: commanded gestures/emotes + reactive
  // look/grip, and the gesture-boundary anti-pop blends they need.)
  let _additive = false,
    lookX = 0,
    lookY = 0,
    lookW = 0;
  // AI MOTION LAYERS (P1 compositor) — the brain composes motion as independent additive offset
  // bundles; disjoint roles SUM for free, same-role layers SUM here (weight-scaled). A layer:
  //   { parts:{role:[p,y,r]}, flex:{role:[ang,abd]}, weight, amp, speed, fn(localT)->{parts,flex},
  //     dur, env:[in,out] } — persistent if dur<=0; timed + enveloped + self-deleting if dur>0.
  // This is "AI generates all motion" (sec 4: no canned presets); added/cleared over the bus.
  const layers = new Map();

  let extras = { sprungNames: [] }; // avatar.js hands over the sprung-bone names AFTER springs resolve (bindExtras) — the finger layer must not double-drive a sprung ribbon

  const _e = new THREE.Euler(),
    _q = new THREE.Quaternion();
  // Each frame a controlled bone is set from a base pose, then offset — never
  // accumulates. Base is the bone's REST pose normally; in additive mode it's the
  // bone's CURRENT pose (whatever the external base-pose owner set, e.g. co-speech),
  // so motion layers stack on top instead of fighting it. Swing is about local X (pitch).
  const pose = (role, rx, ry, rz) => {
    const b = bones[role];
    if (!b) return;
    _e.set(clamp(role, "pitch", rx), clamp(role, "yaw", ry), clamp(role, "roll", rz), "XYZ");
    b.quaternion.copy(_additive ? b.quaternion : rest[role]).multiply(_q.setFromEuler(_e));
  };
  // FLEX a limb forward(+)/back(−) about the body hinge axis (set above), relative to REST. This is how
  // the motion clips bend arms/legs correctly on any rig — NOT local pitch (which abducts here). Bones
  // without a hinge axis (torso) fall back to local pitch via pose().
  const _fq = new THREE.Quaternion(),
    _fq2 = new THREE.Quaternion();
  const flex = (role, ang, abd) => {
    // ang = forward(+)/back(−) flexion; abd = sideways abduction (optional, e.g. knee splay)
    const b = bones[role],
      ax = flexAxis[role];
    if (!b) return;
    ang = clampFlex(role, ang); // (#3) consult the joint-limit table (pitch limit); +-2.2 only when no entry
    if (!ax) {
      pose(role, ang, 0, 0);
      return;
    }
    b.quaternion.copy(rest[role]).multiply(_fq.setFromAxisAngle(ax, FSIGN * ang));
    if (abd && abductAxis[role]) b.quaternion.multiply(_fq2.setFromAxisAngle(abductAxis[role], clampAbd(role, abd)));
  };
  // ---- AI MOTION LAYER PASS — the P1 compositor (sum+cap, TWO passes). The base pose has already set
  // each role bone; here we SUM every active layer's weight-scaled offset per channel, clamp the SUMMED
  // value ONCE to the role's advertised joint limit, velocity-clamp the per-frame delta, then apply a
  // single quaternion per role. Pure offset math on resolved roles -> rig-agnostic.
  //   PASS 1: accumulate per-role SUMMED euler (pitch/yaw/roll) + flex (ang/abd) across ALL layers.
  //   PASS 2: clamp the SUM once (joint limit), rate-limit the delta (speed_limit), apply one quat/role.
  const _lq = new THREE.Quaternion(),
    _le = new THREE.Euler();
  const _acc = new Map(); // role -> { p, y, r, ang, abd, hasParts, hasFlex } scratch (cleared each frame)
  const _vstate = new Map(); // role -> { p, y, r, ang, abd } last-APPLIED channels (#28 velocity clamp)
  // velocity-continuous clamp: limit a channel's per-frame DELTA to speed_limit*dt so motion is never
  // janky. delta 0 -> no clamp (a still pose never deadlocks); a big target is approached over frames.
  const _vclamp = (prev, target, maxStep) => {
    if (!isFinite(target)) return isFinite(prev) ? prev : 0; // garbage target (stringly/NaN fn output, unlimited-role overflow) -> hold last good; NEVER persist NaN into _vstate (the compositor twin of bricking a bone)
    const d = target - prev;
    if (d > maxStep) return prev + maxStep;
    if (d < -maxStep) return prev - maxStep;
    return target;
  };
  function applyLayers(dt) {
    if (!layers.size) {
      if (_vstate.size) _vstate.clear(); // no layers -> nothing applied this frame; forget velocity history (next layer starts fresh from 0)
      return;
    }
    _acc.clear();
    const acc = (role) => {
      let e = _acc.get(role);
      if (!e) {
        e = { p: 0, y: 0, r: 0, ang: 0, abd: 0, hasParts: false, hasFlex: false };
        _acc.set(role, e);
      }
      return e;
    };
    // PASS 1 — accumulate weight-scaled offsets per role per channel (no clamping yet).
    for (const [id, L] of layers) {
      let w = (L.weight == null ? 1 : L.weight) * (L.amp == null ? 1 : L.amp);
      const localT = (L._t = (L._t || 0) + dt);
      const speed = L.speed == null ? 1 : L.speed; // (#27) layer speed scales the env ramp + the fn time-warp
      if (L.dur > 0) {
        if (localT >= L.dur) {
          layers.delete(id);
          continue;
        } // timed layer expired -> drop it
        // (#27) DATA-layer speed: scale the in/out env ramp rate by L.speed (was honored only on fn layers).
        const ein = L.env && L.env[0] ? Math.min(1, (localT * speed) / L.env[0]) : 1;
        const eout = L.env && L.env[1] ? Math.min(1, ((L.dur - localT) * speed) / L.env[1]) : 1;
        w *= Math.min(ein, eout);
      }
      if (!w) continue;
      let src;
      if (L.fn) {
        try {
          src = L.fn(localT * speed) || {};
        } catch {
          layers.delete(id);
          continue;
        }
      } // a THROWING fn layer must drop ITSELF, not kill the whole frame (which would freeze every bone)
      else src = L; // fn(t) layers compute offsets from ABSOLUTE local time (speed-warped); a non-finite output is caught by _vclamp's guard
      const parts = src.parts,
        flexes = src.flex;
      if (parts)
        for (const role in parts) {
          if (!bones[role]) continue;
          const o = parts[role],
            e = acc(role);
          e.p += (o[0] || 0) * w;
          e.y += (o[1] || 0) * w;
          e.r += (o[2] || 0) * w;
          e.hasParts = true;
        }
      if (flexes)
        for (const role in flexes) {
          if (!bones[role]) continue;
          const o = flexes[role],
            e = acc(role);
          e.ang += (o[0] || 0) * w;
          e.abd += (o[1] || 0) * w;
          e.hasFlex = true;
        }
    }
    // PASS 2 — clamp the SUMMED value once, velocity-clamp the delta, apply one quaternion per channel.
    for (const [role, e] of _acc) {
      const b = bones[role];
      if (!b) continue;
      const v0 = _vstate.get(role) || { p: 0, y: 0, r: 0, ang: 0, abd: 0 };
      const maxStep = speedLimit(role) * dt; // radians this frame
      if (e.hasParts) {
        // SAFETY CAP (#4): clamp the SUMMED pitch/yaw/roll ONCE to the advertised joint limit (degrees),
        // not per layer — two sub-limit same-role layers compose to ~the limit, not ~2x it. Roles with
        // no limit entry pass through (clamp() is identity there); +-PI is the implicit quaternion range.
        v0.p = _vclamp(v0.p, clamp(role, "pitch", e.p), maxStep);
        v0.y = _vclamp(v0.y, clamp(role, "yaw", e.y), maxStep);
        v0.r = _vclamp(v0.r, clamp(role, "roll", e.r), maxStep);
        _le.set(v0.p, v0.y, v0.r, "XYZ");
        b.quaternion.multiply(_lq.setFromEuler(_le));
      } else {
        v0.p = v0.y = v0.r = 0;
      }
      if (e.hasFlex) {
        const ax = flexAxis[role];
        if (ax) {
          // (#3) the SUMMED flex consults the joint table too (flexion->pitch limit, abduction->yaw/roll).
          v0.ang = _vclamp(v0.ang, clampFlex(role, e.ang), maxStep);
          b.quaternion.multiply(_lq.setFromAxisAngle(ax, FSIGN * v0.ang));
          if (e.abd && abductAxis[role]) {
            v0.abd = _vclamp(v0.abd, clampAbd(role, e.abd), maxStep);
            b.quaternion.multiply(_lq.setFromAxisAngle(abductAxis[role], v0.abd));
          } else v0.abd = 0;
        } else {
          v0.ang = _vclamp(v0.ang, clampFlex(role, e.ang), maxStep); // no hinge axis (torso) -> local pitch, like flex()
          _le.set(v0.ang, 0, 0, "XYZ");
          b.quaternion.multiply(_lq.setFromEuler(_le));
          v0.abd = 0;
        }
      } else {
        v0.ang = v0.abd = 0;
      }
      _vstate.set(role, v0);
    }
    // roles that had velocity history last frame but no layer this frame -> ease them back toward 0 at
    // the speed limit so a cleared layer doesn't snap (still velocity-continuous on release).
    for (const [role, v0] of _vstate) {
      if (_acc.has(role)) continue;
      const b = bones[role];
      if (!b) {
        _vstate.delete(role);
        continue;
      }
      const maxStep = speedLimit(role) * dt;
      v0.p = _vclamp(v0.p, 0, maxStep);
      v0.y = _vclamp(v0.y, 0, maxStep);
      v0.r = _vclamp(v0.r, 0, maxStep);
      v0.ang = _vclamp(v0.ang, 0, maxStep);
      v0.abd = _vclamp(v0.abd, 0, maxStep);
      if (!v0.p && !v0.y && !v0.r && !v0.ang && !v0.abd) {
        _vstate.delete(role);
        continue;
      }
      if (v0.p || v0.y || v0.r) {
        _le.set(v0.p, v0.y, v0.r, "XYZ");
        b.quaternion.multiply(_lq.setFromEuler(_le));
      }
      const ax = flexAxis[role];
      if (v0.ang) {
        if (ax) b.quaternion.multiply(_lq.setFromAxisAngle(ax, FSIGN * v0.ang));
        else {
          _le.set(v0.ang, 0, 0, "XYZ");
          b.quaternion.multiply(_lq.setFromEuler(_le));
        }
      }
      if (v0.abd && ax && abductAxis[role]) b.quaternion.multiply(_lq.setFromAxisAngle(abductAxis[role], v0.abd));
    }
  }

  // ===== THE FRAME LOOP. She stands bit-still at REST; the ONLY things that move her are reactive
  // cursor-look + the AI's own additive motion LAYERS (pose/flex over the bus, P1) + the reactive
  // finger grip while carried. No idle, no canned gestures/expressions, no clip playback — every
  // deliberate move is AI-authored through the compositor (the gesture catalog / root-motion / clip
  // playback / body expressions were PURGED 2026-06-25, user order "purge means purge"). =====
  function update(dt, _walk = false, opts = {}) {
    _additive = !!opts.additive;

    // Additive mode (something external owns the base pose): apply ONLY the AI motion layers on top.
    if (_additive) {
      applyLayers(dt);
      return;
    }

    // BASE POSE — the normalized rest stance + reactive cursor-look. A fixed pose, not motion.
    pose("hips", 0, 0, 0);
    pose("spine", 0, 0, 0);
    pose("chest", 0, 0, 0);
    pose("neck", lookY * lookW * 0.35, lookX * lookW * 0.35, 0);
    pose("head", lookY * lookW, lookX * lookW, 0);
    pose("left_shoulder", 0, 0, 0);
    pose("right_shoulder", 0, 0, 0);
    flex("left_leg", 0);
    flex("right_leg", 0);
    flex("left_shin", 0);
    flex("right_shin", 0);
    flex("left_arm", 0.035, 0.03);
    flex("right_arm", 0.035, 0.03); // the static A-pose hang — a fixed POSE, not motion
    flex("left_forearm", 0);
    flex("right_forearm", 0);
    pose("left_hand", 0, 0, 0);
    pose("right_hand", 0, 0, 0);
    pose("left_foot", 0, 0, 0);
    pose("right_foot", 0, 0, 0);

    applyLayers(dt); // the AI's motion layers compose on top of the base pose (P1) — disjoint roles SUM, shared roles SUM, each capped to its joint limit

    // FINGERS — per-finger curl. Each finger eases toward its explicit target (setFingers); a finger
    // with no explicit target follows the reactive GRIP (gentle hold while she's carried). 0 = the
    // bind (extended), 1 = a full fist. Deeper joints curl tighter (knuckle -> tip).
    const gk = Math.min(1, dt * 6);
    gripL += (gripTgtL - gripL) * gk;
    gripR += (gripTgtR - gripR) * gk;
    const driveHand = (arr, grip) => {
      for (const f of arr) {
        const target = f.tgt == null ? grip : f.tgt; // explicit per-finger overrides the reactive grip
        f.cur += (target - f.cur) * gk;
        for (const j of f.joints) {
          const amt = Math.max(-2.2, Math.min(2.2, f.cur * 1.5 * (0.55 + 0.22 * j.depth)));
          j.b.quaternion.copy(j.rest).multiply(_q.setFromAxisAngle(j.ax, amt));
        }
      }
    };
    if (fingers.L.length) driveHand(fingers.L, gripL);
    if (fingers.R.length) driveHand(fingers.R, gripR);
  }

  return {
    matched: R.matched,
    restAdjust, // boneName → net WORLD rotation the bind normalization applied there (for dangly-chain gravity preservation in avatar.js)
    update,
    setLook: (x, y, w) => {
      lookX = x || 0;
      lookY = y || 0;
      lookW = w == null ? 1 : Math.max(0, Math.min(1, w));
    },
    setLayer: (id, spec) => {
      // AI compositor: add/replace a motion layer (spec=null clears it)
      if (!id) return false;
      const k = String(id);
      if (!spec) {
        layers.delete(k);
        return true;
      }
      // SANITIZE at this single chokepoint: the bus is stringly-typed, and a NaN/Infinity/string in
      // weight/amp/speed/dur/parts/flex would propagate through the clamp and PERMANENTLY poison a
      // bone quaternion (blank her until reload) -- the compositor twin of the click-through lockout.
      const fin = (v, d) => {
        const n = +v;
        return isFinite(n) ? n : d;
      };
      const triples = (o) => {
        const r = {};
        for (const role in o) {
          const a = o[role];
          r[role] = Array.isArray(a) ? a.map((x) => fin(x, 0)) : [fin(a, 0), 0, 0];
        }
        return r;
      };
      const clean = { ...spec, _t: 0, weight: fin(spec.weight, 1), amp: fin(spec.amp, 1), speed: fin(spec.speed, 1) };
      if (spec.dur != null) clean.dur = fin(spec.dur, 0);
      if (Array.isArray(spec.env)) clean.env = spec.env.map((x) => fin(x, 0));
      if (spec.parts && typeof spec.parts === "object") clean.parts = triples(spec.parts);
      if (spec.flex && typeof spec.flex === "object") clean.flex = triples(spec.flex);
      layers.set(k, clean);
      return true;
    },
    clearLayer: (id) => layers.delete(String(id)),
    clearLayers: () => layers.clear(),
    layerIds: () => Array.from(layers.keys()),
    capabilities: () => ({
      // what the brain can drive on THIS resolved model
      roles: Object.keys(bones),
      flexRoles: Object.keys(flexAxis),
      channels: {
        pose: true,
        flex: Object.keys(flexAxis).length > 0,
        look: true,
        layers: true,
        fingers: { L: fingers.L.map((f) => f.name), R: fingers.R.map((f) => f.name) },
      },
      limits: limits,
      units: { offsets: "radians", flex: "radians", limits: "degrees" }, // pose/flex offsets are RADIANS; the limits table above is in DEGREES
      fsign: FSIGN,
    }),
    setGrip: (side, on) => {
      const v = on ? 0.4 : 0;
      if (side === "L" || side === "both") gripTgtL = v;
      if (side === "R" || side === "both") gripTgtR = v;
    }, // reactive carry grip — a GENTLE hold (fingers with no explicit setFingers target follow this)
    // PER-FINGER control (AI-authored hand poses). spec = number (curl ALL 0..1) | { name|index: curl, default? } | null (release to the reactive grip).
    // Names are thumb/index/middle/ring/pinky where detectable, else "finger0".."fingerN"; a numeric key targets by position. 0 = extended, 1 = full fist.
    setFingers: (side, spec) => {
      const ks = side === "both" ? ["L", "R"] : [side === "L" ? "L" : "R"];
      for (const k of ks) {
        const arr = fingers[k];
        if (spec == null) {
          for (const f of arr) f.tgt = null;
          continue;
        } // release -> reactive grip
        const num = typeof spec === "number";
        const def = num ? spec : spec && spec.default != null ? +spec.default : null;
        arr.forEach((f, i) => {
          let v = def;
          if (!num && spec && typeof spec === "object") {
            if (spec[f.name] != null) v = +spec[f.name];
            else if (spec[i] != null) v = +spec[i];
          }
          f.tgt = v == null || !isFinite(v) ? null : Math.max(0, Math.min(1, v));
        });
      }
      return true;
    },
    fingerNames: (side) => (fingers[side === "L" ? "L" : "R"] || []).map((f) => f.name),
    bindExtras: (x) => {
      // avatar.js hands over the sprung-bone names AFTER springs resolve
      Object.assign(extras, x || {});
      const sprung = new Set(extras.sprungNames || []); // a sprung hand descendant (e.g. "HandRibbon"→cloth) — the spring overwrites our curl, so drop those JOINTS from every finger; empty fingers are dropped (audit)
      for (const k of ["L", "R"]) {
        for (const f of fingers[k]) f.joints = f.joints.filter((j) => !sprung.has(j.b.name));
        fingers[k] = fingers[k].filter((f) => f.joints.length);
      }
    },
    roleBones: () => {
      const o = {};
      for (const r in bones) o[r] = (bones[r] && bones[r].name) || null;
      return o;
    }, // DIAGNOSTIC: which actual bone each humanoid role resolved to
    roles: () => ({ ...bones }), // role → live Bone object (avatar.js getBoneWorld + tests consume this)
    gripState: () => ({
      grip: [+gripL.toFixed(2), +gripR.toFixed(2)],
      fingers: {
        L: fingers.L.map((f) => ({ name: f.name, curl: +f.cur.toFixed(2), tgt: f.tgt })),
        R: fingers.R.map((f) => ({ name: f.name, curl: +f.cur.toFixed(2), tgt: f.tgt })),
      },
      reach: +armReachLive().toFixed(3),
    }), // DIAGNOSTIC: live per-finger curl + targets
    flexAxes: () => {
      const o = {};
      for (const r in flexAxis) {
        const v = flexAxis[r];
        o[r] = v ? [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)] : null;
      }
      return o;
    },
    jointAngles: () => {
      // DIAGNOSTIC: live joint angles from WORLD positions (180=straight, <180=bent) — unambiguous
      const ang = (A, B, C) => {
        const a = bones[A],
          b = bones[B],
          c = bones[C];
        if (!a || !b || !c) return null;
        const pa = new THREE.Vector3(),
          pb = new THREE.Vector3(),
          pc = new THREE.Vector3();
        a.getWorldPosition(pa);
        b.getWorldPosition(pb);
        c.getWorldPosition(pc);
        const v1 = pa.sub(pb).normalize(),
          v2 = pc.sub(pb).normalize();
        return +((Math.acos(Math.max(-1, Math.min(1, v1.dot(v2)))) * 180) / Math.PI).toFixed(1);
      };
      const gap =
        bones.left_hand && bones.right_hand
          ? +bones.left_hand
              .getWorldPosition(new THREE.Vector3())
              .distanceTo(bones.right_hand.getWorldPosition(new THREE.Vector3()))
              .toFixed(3)
          : null; // hand↔hand world distance — proves a clap MEETS (rest ≈ shoulder width; beat ≈ palm thickness)
      return {
        leftKnee: ang("left_leg", "left_shin", "left_foot"),
        leftElbow: ang("left_arm", "left_forearm", "left_hand"),
        handGap: gap,
        armReach: +armReach.toFixed(3),
        fsign: FSIGN,
        fwd: [+_forward.x.toFixed(2), +_forward.y.toFixed(2), +_forward.z.toFixed(2)],
        roles: Object.keys(bones).length,
      };
    },
    stance: () => {
      // DIAGNOSTIC: leg stance truth — knee angles, toe headings, and (squat-normalized rigs) how far the kneecap/toes drifted off the bind's heading. Rig-frame refs are from BUILD time (post-load checks; a later live Alt-drag skews them harmlessly).
      const out = { bindUpright: _bindUpright, sides: {} };
      for (const side of ["left", "right"]) {
        const th = bones[side + "_leg"],
          sh = bones[side + "_shin"],
          ft = bones[side + "_foot"];
        if (!th || !sh || !ft) continue;
        const t = th.getWorldPosition(new THREE.Vector3()),
          s = sh.getWorldPosition(new THREE.Vector3()),
          f = ft.getWorldPosition(new THREE.Vector3());
        const v3 = (p) => [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
        const e = {
          knee: +((t.clone().sub(s).angleTo(f.clone().sub(s)) * 180) / Math.PI).toFixed(1),
          hip: v3(t),
          kneePos: v3(s),
          foot: v3(f),
        };
        const toe = ft.children && ft.children[0];
        let toeR = null;
        if (toe) {
          toeR = rigDir(toe.getWorldPosition(new THREE.Vector3()).sub(f)).clone();
          toeR.y = 0;
          if (toeR.lengthSq() > 1e-6) {
            toeR.normalize();
            e.toeHeading = [+toeR.x.toFixed(2), +toeR.z.toFixed(2)];
          } else toeR = null;
        }
        const st = _stance[side];
        if (st) {
          e.bindKnee = st.bindKnee;
          e.twistDeg = st.twistDeg;
          const kw = rigDir(st.kneeL.clone().applyQuaternion(th.getWorldQuaternion(new THREE.Quaternion()))).clone();
          kw.y = 0;
          if (kw.lengthSq() > 1e-4 && st.faceR) {
            kw.normalize();
            e.kneecapOffToes = +((kw.angleTo(st.faceR) * 180) / Math.PI).toFixed(1); // ≈0 = kneecap faces where her bind's toes pointed
            if (toeR) e.toesOffBind = +((toeR.angleTo(st.faceR) * 180) / Math.PI).toFixed(1); // ≈0 = toes kept their authored heading
          }
        }
        out.sides[side] = e;
      }
      return out;
    },
  };
}
