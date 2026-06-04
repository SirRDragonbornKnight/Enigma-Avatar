// Procedural skeletal animator — moves a rigged model's OWN bones when it ships
// with no animation clips (e.g. Sketchfab rips). Matches bones to humanoid roles
// by name, then drives a LAYERED, DESYNCHRONISED idle — every bone reads its own
// smooth-noise phase (breath, weight-shift, torso turn, independent arm/hand/leg
// drift) so she reads as alive instead of a rigid block — clamped by the
// anatomical limits in bone_limits.json. `params.drift` is the master amount.
//
// It can't be mocap-realistic, but it reads as "alive + walking" on any rig with
// recognisable bone names. Amplitudes/cadence are tunable live via
// window.EnigmaAvatar.tune({...}) so we can dial it in (the swing AXIS assumption
// — rotate about local X for fore/aft — is the thing most likely to need flipping
// per-rig; tune({swingAxis:'z'}) if limbs swing sideways instead of forward).

import * as THREE from "three";

const DEG = Math.PI / 180;
// SKIP: fingers/toes/face/dangly bits, IK rig helpers, AND deformation aids —
// "helper"/"twist" bones (Mal0's Bip_*_Helper, lowerarm twists) must never win a
// primary role over the real joint (avatar audit #4).
const SKIP = /pinky|index|middle|ring|thumb|finger|toe|eye|lid|jaw|tongue|hair|tail|cloth|skirt|helper|twist|ik$|_ik|ik-|-ik|target|pole|root.?joint|bolt|piston|string|bits/i;

// Map a bone name -> "side_part" role (or center part), or null to ignore.
function roleOf(raw) {
  const n = raw.toLowerCase();
  if (SKIP.test(n)) return null;
  // Side: left/right word or _l_/.l boundary, PLUS Blender ".L"/".R" tags that
  // three.js de-dotted on import into a glued uppercase L/R (upper_arm.L → "upper_armL").
  // Without this, EVERY Blender/Rigify limb loses its side and stays in the bind T-pose
  // (this is exactly why Toy Chica was T-posed). The trailing (_ . digit | end) anchor
  // keeps it a real SUFFIX tag, so mid-word capitals (Armature:Root → "ArmatureRoot") don't false-trigger.
  let side = "";
  if (/(^|[^a-z])l(eft)?([^a-z]|$)|left/.test(n) || /[a-z]L([_.]|\d|$)/.test(raw)) side = "left";
  else if (/(^|[^a-z])r(ight)?([^a-z]|$)|right/.test(n) || /[a-z]R([_.]|\d|$)/.test(raw)) side = "right";
  const has = (re) => re.test(n);
  // Center bones are never side-tagged; a sided match (Bip_Pelvis_L/R) is an
  // auxiliary bone, not the real spine — reject it so the true center bone wins
  // regardless of traversal order (avatar audit #4).
  if (has(/hips?|pelvis/)) return side ? null : "hips";
  if (has(/upperchest|chest/)) return side ? null : "chest";
  if (has(/spine|lowerback|waist|spine2/)) return side ? null : "spine";
  if (has(/neck/)) return side ? null : "neck";
  if (has(/head/)) return side ? null : "head";
  let part = null;
  if (has(/shoulder|clavicle/)) part = "shoulder";
  else if (has(/forearm|elbow|lower[_ ]?arm/)) part = "forearm";
  else if (has(/hand|wrist/)) part = "hand";
  else if (has(/upper[_ ]?arm/) || (has(/arm/) && !has(/forearm/))) part = "arm";
  else if (has(/thigh|up[_ ]?leg|upper[_ ]?leg/)) part = "leg";
  else if (has(/calf|shin|knee|low(er)?[_ ]?leg/)) part = "shin";
  else if (has(/foot|ankle/)) part = "foot";
  else if (has(/leg/)) part = "leg";
  if (!part) return null;
  return side ? `${side}_${part}` : null;   // limbs need a side
}

export function buildProceduralRig(model, boneLimits = {}) {
  const bones = {}, rest = {};
  model.traverse((o) => {
    if (!o.isBone) return;
    const role = roleOf(o.name);
    if (role && !bones[role]) { bones[role] = o; rest[role] = o.quaternion.clone(); }
  });

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
    if (_dir.y < -0.5) return;                          // already hanging down → leave it
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

  const limits = boneLimits.bones || {};
  const clamp = (role, axis, v) => {
    const L = limits[role]; if (!L) return v;
    return Math.max((L[axis + "_min"] ?? -180) * DEG, Math.min((L[axis + "_max"] ?? 180) * DEG, v));
  };

  const params = {
    breathe: 0.085,    // chest/spine rise — breathing depth (raised: idle read too stiff)
    breatheRate: 1.4,  // breathing cadence
    look: 0.16,        // idle head-glance amplitude
    armRest: 0,        // arm drop is now geometry-based (aimArm above); kept tunable for extra droop
    elbow: 0.45,       // elbow bend on ROLL (anatomically clamped small on real rigs ~±5°)
    elbowFlex: 0.10,   // relaxed forward elbow flex on PITCH (has room) so arms aren't ramrod-straight
    swingAxis: "x",
    // --- richer idle: per-bone DESYNCED motion so bones move individually, not as
    // a rigid block. `drift` is the master amount — tune({drift:0}) = old minimal
    // idle, tune({drift:1.6}) = livelier. Everything below scales with it. ---
    drift: 1.3,        // master liveliness (raised from 1.0 — idle read too stiff; tune({drift:1}) for the old feel)
    armSwing: 0.16,    // upper-arm pendulum (independent per side)
    armOut: 0.05,      // arm abduction variance
    elbowMove: 0.05,   // elbow flex breathing
    wrist: 0.06,       // hand/wrist micro-motion
    shoulder: 0.04,    // shoulder settle/rise
    twist: 0.05,       // gentle torso turn (yaw)
    sway: 0.085,       // slow lateral weight-shift
    legSway: 0.02,     // tiny thigh drift (she floats; kept from reading as walking)
  };

  let t = 0, ph = 0, blend = 0, expr = "", exprT = 0, exprDur = 2.5, _additive = false, lookX = 0, lookY = 0, lookW = 0;
  const _e = new THREE.Euler(), _q = new THREE.Quaternion();
  // Each frame a controlled bone is set from a base pose, then offset — never
  // accumulates. Base is the bone's REST pose normally; in additive mode it's the
  // bone's CURRENT pose (whatever a clip just set), so emotes layer on top of a
  // playing animation instead of fighting it. Swing is about local X (pitch).
  const pose = (role, rx, ry, rz) => {
    const b = bones[role]; if (!b) return;
    _e.set(clamp(role, "pitch", rx), clamp(role, "yaw", ry), clamp(role, "roll", rz), "XYZ");
    b.quaternion.copy(_additive ? b.quaternion : rest[role]).multiply(_q.setFromEuler(_e));
  };
  const swing = (role, v) => { const a = params.swingAxis; pose(role, a === "x" ? v : 0, a === "y" ? v : 0, a === "z" ? v : 0); };

  function update(dt, walk = false, opts = {}) {
    _additive = !!opts.additive;
    t += dt;
    const br = params.breathe, lk = params.look;

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
        pose("chest", exSpine * 0.5, 0, 0);
        pose("spine", exSpine, 0, 0);
        pose("neck", exHeadP * 0.3, 0, 0);
        pose("head", exHeadP, exHeadY, 0);
        pose("hips", exHipP, exHipY, 0);
        pose("left_arm", exArm, 0, 0);
        pose("right_arm", -exArm, 0, 0);
      }
      return;
    }

    // idle — layered, DESYNCHRONISED per-bone motion so she moves individually
    // instead of as a rigid block. Each bone reads its own smooth-noise phase; a
    // slow weight-shift + torso turn keep her from looking like a statue. Feet
    // don't translate (rotation only). `drift` (D) scales all the secondary motion.
    const D = params.drift;
    const nz = (seed, sp = 1) =>                            // smooth organic noise ~[-1,1] (layered incommensurate sines)
      Math.sin(t * 0.53 * sp + seed) * 0.55 + Math.sin(t * 0.91 * sp + seed * 1.7 + 1.3) * 0.30 + Math.sin(t * 1.73 * sp + seed * 2.3 + 2.1) * 0.15;
    const breath = Math.sin(t * params.breatheRate);
    const sway = nz(10.0, 0.32) * params.sway * D;         // slow lateral weight shift
    const turn = nz(11.0, 0.45) * params.twist * D;        // gentle torso turn (yaw)

    // torso: breath rises chest→spine (phase-delayed); weight-shift rolls/turns it
    pose("chest", breath * br + exSpine * 0.5, turn * 0.6, -sway * 0.5);
    pose("spine", Math.sin(t * params.breatheRate - 0.5) * br * 0.7 + exSpine, turn, -sway * 0.7);
    pose("hips", exHipP + nz(12.0) * 0.01 * D, exHipY + sway * 0.5, sway);

    // head/neck: organic glance (noise, not one sine) + cursor look + counter-roll to the sway
    const idleYaw = nz(20.0, 0.7) * lk, idlePitch = nz(21.0, 0.8) * 0.05;
    pose("neck", -breath * br * 0.5 + exHeadP * 0.3 + lookY * lookW * 0.35 - turn * 0.4, lookX * lookW * 0.35 - turn * 0.5, sway * 0.4);
    pose("head", idlePitch * (1 - lookW) + lookY * lookW + exHeadP, idleYaw * (1 - lookW) + lookX * lookW + exHeadY, sway * 0.6 * (1 - lookW));

    // shoulders: settle/rise subtly with the breath + own drift
    pose("left_shoulder",  nz(30.0) * params.shoulder * D, 0,  breath * br * 0.25 + nz(31.0) * 0.02 * D);
    pose("right_shoulder", nz(32.0) * params.shoulder * D, 0, -breath * br * 0.25 + nz(33.0) * 0.02 * D);

    // arms: independent pendulum sway (different noise per side) + slight abduction
    const ar = params.armRest;
    pose("left_arm",  -ar + nz(40.0, 0.8) * params.armSwing * D + exArm, nz(41.0) * params.armOut * D, nz(42.0) * 0.03 * D);
    pose("right_arm", -ar + nz(43.0, 0.8) * params.armSwing * D - exArm, nz(44.0) * params.armOut * D, nz(45.0) * 0.03 * D);

    // forearms: relaxed elbow flex on PITCH (roll is clamped tiny) that breathes a little
    pose("left_forearm",  params.elbowFlex + nz(50.0) * params.elbowMove * D, 0, -params.elbow);
    pose("right_forearm", params.elbowFlex + nz(51.0) * params.elbowMove * D, 0,  params.elbow);

    // hands/wrists: tiny individual life
    pose("left_hand",  nz(60.0) * params.wrist * D, nz(61.0) * params.wrist * 0.6 * D, 0);
    pose("right_hand", nz(62.0) * params.wrist * D, nz(63.0) * params.wrist * 0.6 * D, 0);

    // thighs + knees: micro-drift only (she floats; keep it from reading as walking)
    pose("left_leg",  nz(70.0) * params.legSway * D, 0, 0);
    pose("right_leg", nz(71.0) * params.legSway * D, 0, 0);
    pose("left_shin",  -0.05 + nz(72.0) * 0.015 * D, 0, 0);
    pose("right_shin", -0.05 + nz(73.0) * 0.015 * D, 0, 0);
  }

  return {
    matched: Object.keys(bones).sort(),
    update,
    params,
    setParams: (p) => Object.assign(params, p),
    setExpression: (type, dur = 2.5) => { expr = type; exprT = 0; exprDur = dur; },
    setLook: (x, y, w) => { lookX = x || 0; lookY = y || 0; lookW = w == null ? 1 : Math.max(0, Math.min(1, w)); },
  };
}
