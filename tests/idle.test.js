// idle.test.js — PROPERTY tests for the v4 "living layers" idle (procedural.js). The four user
// symptoms become invariants: never dead-still (moving hold), no frame-to-frame pops (springs, not
// eases), distinct weight stances over time (alive, not static), bounded angles + no NaN (sane).
// Runs the REAL buildProceduralRig on the REAL fixture skeleton — headless, plain node.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildProceduralRig } from "../procedural.js";
import { LIVE } from "../idleprofile.js";            // the humanoid personality (the old universal defaults)
import { fullBiped } from "./fixtures.js";

// Deterministic runs: the idle schedules events via Math.random — pin it per test.
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function withRandom(seed, fn) {
  const real = Math.random;
  Math.random = seededRandom(seed);
  try { return fn(); } finally { Math.random = real; }
}

const FPS = 60, DT = 1 / FPS;
const roleQuat = (rig, model, role) => {
  let q = null;
  model.traverse((o) => { if (!q && o.isBone && o.name === rig.roleBones()[role]) q = o.quaternion; });
  return q;
};

function run(seconds, opts = {}) {
  const model = fullBiped();
  const rig = buildProceduralRig(model, {});
  rig.setParams(LIVE);                               // 2026-06-11 pivot: the engine defaults DEAD — these property tests assert the LIVE personality (what a humanoid's profile enables)
  const hips = roleQuat(rig, model, "hips"), chest = roleQuat(rig, model, "chest"), head = roleQuat(rig, model, "head");
  // The ARM CHAIN gets its own pop meter — the audit's three real pops (IK reach-margin entry snap,
  // unblended release→hang, gesture→gesture switch) all lived on the arms, where the trunk-only
  // measurement was blind: a 19°/frame elbow snap shipped green.
  const lArm = roleQuat(rig, model, "left_arm"), lFore = roleQuat(rig, model, "left_forearm");
  const rArm = roleQuat(rig, model, "right_arm"), rFore = roleQuat(rig, model, "right_forearm");
  const samples = [];
  const frames = Math.round(seconds * FPS);
  let maxStep = 0, maxArmStep = 0;
  const prev = { h: hips.clone(), c: chest.clone(), d: head.clone(), la: lArm.clone(), lf: lFore.clone(), ra: rArm.clone(), rf: rFore.clone() };
  for (let i = 0; i < frames; i++) {
    if (opts.midGesture && i === Math.round(frames / 2)) rig.setGesture("clap", 1.2);   // interrupt mid-run, then resume idle
    rig.update(DT, false);
    model.updateWorldMatrix(true, true);
    // largest per-frame quaternion step (radians via angleTo) — measured after a 1s warm-up
    // (frame 0 legitimately steps from the loaded rest pose into the living idle)
    if (i > FPS) {
      maxStep = Math.max(maxStep, prev.h.angleTo(hips), prev.c.angleTo(chest), prev.d.angleTo(head));
      maxArmStep = Math.max(maxArmStep, prev.la.angleTo(lArm), prev.lf.angleTo(lFore), prev.ra.angleTo(rArm), prev.rf.angleTo(rFore));
    }
    prev.h.copy(hips); prev.c.copy(chest); prev.d.copy(head);
    prev.la.copy(lArm); prev.lf.copy(lFore); prev.ra.copy(rArm); prev.rf.copy(rFore);
    if (i % 6 === 0) {
      const e = new THREE.Euler().setFromQuaternion(hips, "XYZ");
      samples.push({ t: i * DT, hipRoll: e.z, hipPitch: e.x, chestW: chest.w, joints: rig.jointAngles() });
    }
  }
  return { rig, model, samples, maxStep, maxArmStep, hips, chest, head };
}

test("idle v4 — never dead-still (moving hold): the chest is always breathing", () => {
  withRandom(7, () => {
    const { samples } = run(20);
    // in EVERY 2s window the chest quaternion w must vary (breath at ~0.27Hz means motion within any window)
    const win = Math.round(2 / (6 * DT));
    for (let i = 0; i + win < samples.length; i += win) {
      const seg = samples.slice(i, i + win).map((s) => s.chestW);
      assert.ok(Math.max(...seg) - Math.min(...seg) > 1e-5, `dead-still window at ~${samples[i].t.toFixed(1)}s`);
    }
  });
});

test("idle v4 — no pops: trunk under ~0.6°/frame AND the arm chain under ~4.3°/frame", () => {
  withRandom(11, () => {
    const { maxStep, maxArmStep } = run(120);   // long enough to cross several arm-pose entries + releases
    assert.ok(maxStep < 0.011, `max per-frame trunk step ${(maxStep * 180 / Math.PI).toFixed(3)}° — a spring-driven idle must never jump`);
    assert.ok(maxArmStep < 0.075, `max per-frame ARM step ${(maxArmStep * 180 / Math.PI).toFixed(2)}° — pose entry/release must stay seeded+blended (the audit measured 19°/frame from the absolute IK reach margin)`);
  });
});

test("idle v4 — weight ACTUALLY shifts: distinct hip-roll stances over a minute, both directions", () => {
  withRandom(3, () => {
    const { samples } = run(60);
    const rolls = samples.map((s) => s.hipRoll);
    assert.ok(Math.max(...rolls) > 0.03, "shifts to one side (hip roll > ~1.7°)");
    assert.ok(Math.min(...rolls) < -0.03, "and to the other");
  });
});

test("idle v4 — bounded and finite: no flail, no NaN, knees stay anatomical", () => {
  withRandom(23, () => {
    const { samples, hips, chest, head } = run(60, { midGesture: true });
    for (const s of samples) {
      assert.ok(isFinite(s.hipRoll) && Math.abs(s.hipRoll) < 0.18, `hip roll sane (${s.hipRoll})`);
      assert.ok(isFinite(s.hipPitch) && Math.abs(s.hipPitch) < 0.12, `hip pitch sane (${s.hipPitch})`);
      if (s.joints.leftKnee != null) assert.ok(s.joints.leftKnee > 130 && s.joints.leftKnee <= 180.01, `knee ${s.joints.leftKnee}° stays a soft stand`);
    }
    for (const q of [hips, chest, head]) for (const k of ["x", "y", "z", "w"]) assert.ok(isFinite(q[k]), "no NaN quaternions after a mid-run gesture interrupt");
  });
});

test("finger grip — setGrip curls the finger joints and releases smoothly", () => {
  withRandom(9, () => {
    const model = fullBiped();
    const rig = buildProceduralRig(model, {});
    rig.setParams(LIVE);                             // pivot: engine defaults DEAD — give the test rig the live humanoid personality
    let finger = null;
    model.traverse((o) => { if (!finger && o.isBone && /finger/i.test(o.name)) finger = o; });
    if (!finger) return;                                              // fixture without finger bones → nothing to assert
    for (let i = 0; i < 120; i++) rig.update(DT, false);
    const rest = finger.quaternion.clone();
    rig.setGrip("both", true);
    for (let i = 0; i < 90; i++) rig.update(DT, false);               // grip eases in (~1/6s smoothing)
    const gripped = finger.quaternion.clone();
    assert.ok(rest.angleTo(gripped) > 0.05, `grip visibly curls the finger (${(rest.angleTo(gripped) * 180 / Math.PI).toFixed(1)}°)`);
    rig.setGrip("both", false);
    const prev = finger.quaternion.clone();
    let maxStep = 0;
    for (let i = 0; i < 120; i++) { rig.update(DT, false); maxStep = Math.max(maxStep, prev.angleTo(finger.quaternion)); prev.copy(finger.quaternion); }
    assert.ok(maxStep < 0.05, `grip release is smoothed (max step ${(maxStep * 180 / Math.PI).toFixed(2)}°/frame)`);
  });
});

test("idle v4 — gesture exit blends (no single-frame snap back to idle)", () => {
  withRandom(5, () => {
    const model = fullBiped();
    const rig = buildProceduralRig(model, {});
    rig.setParams(LIVE);                             // pivot: engine defaults DEAD — give the test rig the live humanoid personality
    const chest = roleQuat(rig, model, "chest");
    for (let i = 0; i < 120; i++) rig.update(DT, false);          // settle into idle
    rig.setGesture("clap", 0.8);
    for (let i = 0; i < 60; i++) rig.update(DT, false);           // run past the gesture end (0.8s < 1.0s)
    assert.equal(rig.gesturing(), false, "gesture auto-cleared");
    const prev = chest.clone();
    let maxStep = 0;
    for (let i = 0; i < 30; i++) { rig.update(DT, false); maxStep = Math.max(maxStep, prev.angleTo(chest)); prev.copy(chest); }
    assert.ok(maxStep < 0.02, `post-gesture re-entry is blended (max step ${(maxStep * 180 / Math.PI).toFixed(2)}°/frame)`);
  });
});

test("PER-MODEL PIVOT — the engine default (no profile) is perfectly still after settle", () => {
  withRandom(11, () => {
    const model = fullBiped();
    const rig = buildProceduralRig(model, {});        // NO setParams — the 2026-06-11 default: dead toolbox
    const chest = roleQuat(rig, model, "chest"), head = roleQuat(rig, model, "head");
    const lArm = roleQuat(rig, model, "left_arm"), lFore = roleQuat(rig, model, "left_forearm");
    for (let i = 0; i < 600; i++) rig.update(DT, false);   // 10s: the static stance targets damp in, then nothing
    const c0 = chest.clone(), h0 = head.clone(), a0 = lArm.clone(), f0 = lFore.clone();
    let maxDrift = 0;
    for (let i = 0; i < 300; i++) {                        // 5 further seconds: NOTHING may move
      rig.update(DT, false);
      maxDrift = Math.max(maxDrift, c0.angleTo(chest), h0.angleTo(head), a0.angleTo(lArm), f0.angleTo(lFore));
    }
    assert.ok(maxDrift < 1e-4, `no profile -> still (max drift ${(maxDrift * 180 / Math.PI).toFixed(5)} deg over 5s)`);
  });
});
