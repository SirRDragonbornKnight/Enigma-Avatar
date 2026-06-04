// Procedural skeletal animator — moves a rigged model's OWN bones when it ships
// with no animation clips (e.g. Sketchfab rips). Matches bones to humanoid roles
// by name, then drives a breathing idle + a walk cycle (arms & legs swing in
// opposite phase), clamped by the anatomical limits in bone_limits.json.
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
const SKIP = /pinky|index|middle|ring|thumb|finger|toe|eye|lid|jaw|tongue|hair|tail|cloth|skirt|helper|twist|ik$|_ik|target|pole|root.?joint|bolt|piston|string|bits/i;

// Map a bone name -> "side_part" role (or center part), or null to ignore.
function roleOf(raw) {
  const n = raw.toLowerCase();
  if (SKIP.test(n)) return null;
  let side = "";
  if (/(^|[^a-z])l(eft)?([^a-z]|$)|left/.test(n)) side = "left";
  else if (/(^|[^a-z])r(ight)?([^a-z]|$)|right/.test(n)) side = "right";
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

  const limits = boneLimits.bones || {};
  const clamp = (role, axis, v) => {
    const L = limits[role]; if (!L) return v;
    return Math.max((L[axis + "_min"] ?? -180) * DEG, Math.min((L[axis + "_max"] ?? 180) * DEG, v));
  };

  const params = {
    breathe: 0.075,    // chest/spine rise — breathing (upper body only, so feet stay planted)
    look: 0.18,        // head turning to look around
    armRest: 1.15,     // drop the arms out of the bind T-pose (radians); 0 = leave as-is
    elbow: 0.45,       // slight forward elbow bend so the arms aren't ramrod-straight
    swingAxis: "x",
  };

  let t = 0, ph = 0, blend = 0, expr = "", exprT = 0, exprDur = 2.5, _additive = false;
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

    // idle — feet stay PLANTED: motion lives in the upper body + head, never the
    // hips/legs, so she breathes and glances around instead of sliding side to side.
    const breath = Math.sin(t * 1.5) * br;
    pose("chest", breath + exSpine * 0.5, 0, 0);
    pose("spine", breath * 0.7 + exSpine, 0, 0);
    pose("neck", -breath * 0.5 + exHeadP * 0.3, 0, 0);
    pose("head", Math.sin(t * 0.9) * 0.05 + exHeadP, Math.sin(t * 0.55) * lk + exHeadY, 0);
    pose("hips", exHipP, exHipY, 0);                       // hips rest in idle → legs & feet planted

    // arms: relaxed at the sides (dropped from the T-pose) + slight elbow bend + gentle sway
    const ar = params.armRest, al = Math.sin(t * 0.8) * 0.06;
    pose("left_arm", -ar + al + exArm, 0, 0);              // pitch DOWN out of the T-pose (this rig lowers on local X)
    pose("right_arm", -ar - al - exArm, 0, 0);
    pose("left_forearm", 0, 0, -params.elbow);             // bend elbows FORWARD (this rig: roll axis, mirrored L/R)
    pose("right_forearm", 0, 0, params.elbow);
    pose("left_shin", -0.05, 0, 0);                        // tiny STATIC knee bend (constant → feet don't move)
    pose("right_shin", -0.05, 0, 0);
  }

  return {
    matched: Object.keys(bones).sort(),
    update,
    params,
    setParams: (p) => Object.assign(params, p),
    setExpression: (type, dur = 2.5) => { expr = type; exprT = 0; exprDur = dur; },
  };
}
