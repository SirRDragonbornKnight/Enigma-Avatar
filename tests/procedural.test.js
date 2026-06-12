// Characterization tests — lock the CURRENT bone-role mapping so the Phase 1
// cascade refactor (rig.js) can't silently regress a named rig. The name tier in
// rig.js is lifted byte-for-byte from procedural.js#roleOf, so these must stay green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProceduralRig } from "../procedural.js";
import { fullBiped, blenderBiped, hairRig } from "./fixtures.js";

const matched = (model) => buildProceduralRig(model, {}).matched;   // already sorted

// The 19 canonical roles (must match bone_limits.json / tests/test_avatar_bone_data.py).
const NINETEEN = [
  "chest", "head", "hips",
  "left_arm", "left_foot", "left_forearm", "left_hand", "left_leg", "left_shin", "left_shoulder",
  "neck",
  "right_arm", "right_foot", "right_forearm", "right_hand", "right_leg", "right_shin", "right_shoulder",
  "spine",
];

test("fullBiped — clear names map to all 19 canonical roles", () => {
  assert.deepEqual(matched(fullBiped()), NINETEEN);
});

test("blenderBiped — de-dotted .L/.R sides resolve; 'Armature' is never an arm", () => {
  // upper_arm.L → "upper_armL" (three.js strips the dot). Without raw-side detection
  // these limbs lose their side and stay T-posed (the Toy Chica bug). All 19 resolve,
  // and the `arm(?!ature)` guard keeps the Armature root out of an arm role.
  assert.deepEqual(matched(blenderBiped()), NINETEEN);
});

test("hairRig — only real body bones become roles; dangly bones do not", () => {
  // The forearmL/handL decoy ARE arm bones by name → left_forearm/left_hand. The
  // hair / BackStrand / tail / skirt bones must NOT be mistaken for body roles.
  assert.deepEqual(matched(hairRig()), ["head", "hips", "left_forearm", "left_hand"]);
});

// SQUAT-BOUND rig (anime_catgirl: the GLB binds knees at ~76 deg, femur horizontal) -
// buildProceduralRig must stand the legs up at build (the leg twin of the aimArm
// waving-bind fix) and must NOT touch a normal standing bind.
import * as THREE from "three";
test("squat-bound legs are normalized to standing at build; straight rigs untouched", () => {
  const ang = (model, names) => {
    model.updateWorldMatrix(true, true);
    const p = {};
    model.traverse((o) => { if (o.isBone && names.includes(o.name)) p[o.name] = o.getWorldPosition(new THREE.Vector3()); });
    const v1 = p[names[0]].clone().sub(p[names[1]]), v2 = p[names[2]].clone().sub(p[names[1]]);
    return v1.angleTo(v2) * 180 / Math.PI;
  };
  const NAMES = ["LeftThigh", "LeftShin", "LeftFoot"];
  const std = fullBiped();                      // 1) standing bind: untouched
  const before = ang(std, NAMES);
  buildProceduralRig(std, {});
  assert.ok(Math.abs(ang(std, NAMES) - before) < 3, "standing bind stays as authored");
  const sq = fullBiped();                       // 2) squat bind -> standing after build
  sq.traverse((o) => {
    if (!o.isBone) return;
    if (/^(Left|Right)Thigh$/.test(o.name)) o.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -1.2));
    if (/^(Left|Right)Shin$/.test(o.name)) o.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.9));
  });
  sq.updateWorldMatrix(true, true);
  const folded = ang(sq, NAMES);
  assert.ok(folded < 130, `fixture folds the knee (got ${folded.toFixed(0)} deg)`);
  buildProceduralRig(sq, {});
  const after = ang(sq, NAMES);
  assert.ok(after > 165, `legs stood up at build (knee ${folded.toFixed(0)} -> ${after.toFixed(0)} deg)`);
  // …and the thigh must end pointing DOWN — "knee straight" alone would pass a leg aimed forward (audit)
  let th = null, sh = null;
  sq.traverse((o) => { if (!o.isBone) return; if (o.name === "LeftThigh") th = o; if (o.name === "LeftShin") sh = o; });
  const a2 = new THREE.Vector3(), b2 = new THREE.Vector3();
  th.getWorldPosition(a2); sh.getWorldPosition(b2);
  const d = b2.sub(a2).normalize();
  assert.ok(d.y < -0.9, `thigh aims world-down on an unrotated rig (dir.y ${d.y.toFixed(2)})`);
});

test("squat normalization fixes the leg TWIST: kneecaps track the toes, toes keep the bind heading (knock-knee)", () => {
  // The straight-down aim is a MINIMAL rotation: it parks the leg's twist wherever the bind's fold
  // plane was. Fold the squat about a ROLLED hinge (kneecaps point ~30° off forward) while the feet
  // stay planted facing +Z — the knock-knee / pigeon-toe bind class ("the bone issue"). After the
  // build, the kneecaps must face where the bind's toes pointed, and the toes must still point there.
  const byName = (m, n) => { let b = null; m.traverse((o) => { if (o.isBone && o.name === n) b = o; }); return b; };
  const rot = (x, y, z, ang) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z).normalize(), ang);
  const sq = fullBiped();
  sq.traverse((o) => {
    if (!o.isBone) return;
    if (/^(Left|Right)Thigh$/.test(o.name)) o.quaternion.multiply(rot(1, 0, 0.6, -1.2));   // rolled fold axis → kneecap rolls off +Z
    if (/^(Left|Right)Shin$/.test(o.name)) o.quaternion.multiply(rot(1, 0, 0, 1.9));
  });
  sq.updateWorldMatrix(true, true);
  for (const side of ["Left", "Right"]) {              // re-plant the feet: toes flat, facing +Z (squatters' feet stay planted)
    const ft = byName(sq, side + "Foot"), toe = ft.children[0];
    const cur = toe.getWorldPosition(new THREE.Vector3()).sub(ft.getWorldPosition(new THREE.Vector3())).normalize();
    const fixW = new THREE.Quaternion().setFromUnitVectors(cur, new THREE.Vector3(0, 0, 1));
    const pq = ft.parent.getWorldQuaternion(new THREE.Quaternion());
    ft.quaternion.premultiply(pq.clone().invert().multiply(fixW).multiply(pq));
    sq.updateWorldMatrix(true, true);
  }
  const kneeLocal = {};                                // bind kneecap dir (thigh-local) — recomputed independently of the engine
  for (const side of ["Left", "Right"]) {
    const t = byName(sq, side + "Thigh").getWorldPosition(new THREE.Vector3());
    const s = byName(sq, side + "Shin").getWorldPosition(new THREE.Vector3());
    const f = byName(sq, side + "Foot").getWorldPosition(new THREE.Vector3());
    const k = t.sub(s).normalize().add(f.sub(s).normalize()).multiplyScalar(-1).normalize();
    kneeLocal[side] = k.applyQuaternion(byName(sq, side + "Thigh").getWorldQuaternion(new THREE.Quaternion()).invert());
  }
  buildProceduralRig(sq, {});
  sq.updateWorldMatrix(true, true);
  const FWD = new THREE.Vector3(0, 0, 1);
  for (const side of ["Left", "Right"]) {
    const th = byName(sq, side + "Thigh"), shB = byName(sq, side + "Shin"), ft = byName(sq, side + "Foot"), toe = ft.children[0];
    const t = th.getWorldPosition(new THREE.Vector3()), s = shB.getWorldPosition(new THREE.Vector3()), f = ft.getWorldPosition(new THREE.Vector3());
    const knee = t.clone().sub(s).angleTo(f.clone().sub(s)) * 180 / Math.PI;
    assert.ok(knee > 165, `${side}: leg stands up (knee ${knee.toFixed(0)} deg)`);
    const kneecap = kneeLocal[side].clone().applyQuaternion(th.getWorldQuaternion(new THREE.Quaternion()));
    kneecap.y = 0; kneecap.normalize();
    const toeDir = toe.getWorldPosition(new THREE.Vector3()).sub(f); toeDir.y = 0; toeDir.normalize();
    const offToes = kneecap.angleTo(toeDir) * 180 / Math.PI;
    assert.ok(offToes < 10, `${side}: kneecap faces the toes (off by ${offToes.toFixed(0)} deg)`);
    const offFwd = toeDir.angleTo(FWD) * 180 / Math.PI;
    assert.ok(offFwd < 10, `${side}: toes keep the bind's +Z heading (off by ${offFwd.toFixed(0)} deg)`);
  }
});

test("she is BIT-STILL by default — the idle machinery is DELETED (user order 2026-06-12)", () => {
  // Not "idle tuned to zero" — the breath/sway/shift/arm/ambient/fidget code no longer exists.
  // One update applies the static base pose; thereafter NOTHING may move any bone, ever, with no
  // input. Any future re-added self-motion fails this on frame two.
  const m = fullBiped();
  const proc = buildProceduralRig(m, {});
  proc.update(1 / 60);                                  // frame 1: the base pose lands (rest + static arm hang)
  m.updateWorldMatrix(true, true);
  const snap = {};
  m.traverse((o) => { if (o.isBone) snap[o.name] = o.quaternion.clone(); });
  for (let i = 0; i < 1200; i++) proc.update(1 / 60);   // 20 seconds of nothing
  m.traverse((o) => {
    if (!o.isBone) return;
    const dot = Math.abs(o.quaternion.dot(snap[o.name]));
    assert.ok(1 - dot < 1e-12, `${o.name} moved with no input (quat dot ${dot}) — self-generated motion is forbidden`);
  });
});

test("bind normalization is IMMUNE to the user's saved rotation (rig-local frame; audit P1)", () => {
  // applyRotation runs BEFORE buildProceduralRig: a saved ~40deg pitch (one Alt-drag away) made an
  // upright, correctly-authored model read as "slouch-bound" and fold at the hips on every reload.
  const model = fullBiped();
  const rig = new THREE.Group(); rig.rotation.x = 0.7; rig.add(model);
  rig.updateWorldMatrix(true, true);
  const proc = buildProceduralRig(model, {});
  assert.equal(Object.keys(proc.restAdjust).length, 0, "no trunk/leg normalization fires on an upright bind seen through a user rotation");
});

test("lying-bound rigs are left alone (a lying bind is a style, not a squat defect)", () => {
  const model = fullBiped();
  model.rotation.x = Math.PI / 2;                 // the bind itself lies on its back (its OWN space, no user rig group)
  model.traverse((o) => {
    if (!o.isBone) return;
    if (/^(Left|Right)Shin$/.test(o.name)) o.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.9));   // knees folded — would trip the squat gate
  });
  model.updateWorldMatrix(true, true);
  const proc = buildProceduralRig(model, {});
  assert.equal(Object.keys(proc.restAdjust).length, 0, "no normalization on a lying bind (legs would have folded 90deg off the body)");
});
