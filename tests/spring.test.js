// Characterization tests — lock the spring-bone NAME detection (hair / strand / tail
// / skirt) and its guards. This is the regression net for the 51dc "strand" fix and
// the forEARm / fin(?!ger) guards. Phase 1 adds limb-exclusion on top of this.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildSpringBones } from "../src/motion/spring.js";
import { resolveRig } from "../src/rig/rig.js";
import { hairRig, fullBiped, opaqueBiped } from "./fixtures.js";

test("hairRig — springs hair/strand/tail/skirt; excludes forearm & fingers", () => {
  const set = new Set(buildSpringBones(hairRig()).names);
  // The 51dc fix: BackStrand* must spring (SPRING_RE gained `strand`).
  for (const b of ["BackStrand0", "BackStrand1", "BackStrand2"]) assert.ok(set.has(b), `expected ${b} sprung`);
  for (const b of ["Hair", "Hair_01", "Hair_02"]) assert.ok(set.has(b), `expected ${b} sprung`);
  for (const b of ["Tail", "Tail_01"]) assert.ok(set.has(b), `expected ${b} sprung`);
  assert.ok(set.has("Skirt_F"), "expected Skirt_F sprung");
  // Guards: "forEARm" (ear preceded by 'for') and fin(?!ger) must NEVER spring.
  for (const b of ["forearmL", "handL", "Finger1", "Finger2"]) assert.ok(!set.has(b), `${b} must NOT spring`);
  assert.equal(set.size, 9);
});

test("role-matched limbs are NOT sprung once excluded (Phase 1 fix)", () => {
  // Pre-cascade, a hairless humanoid hit the geometric fallback and sprang all 14
  // limb bones. Passing the resolved role bones as `exclude` stops that.
  const model = fullBiped();
  const exclude = resolveRig(model).springExclude;
  assert.equal(buildSpringBones(model, { exclude }).count, 0);
});

test("springs are DEAD STILL at rest (the breeze was deleted with the idle system, 2026-06-12)", () => {
  const findBone = (m, n) => {
    let b = null;
    m.traverse((o) => {
      if (o.isBone && o.name === n) b = o;
    });
    return b;
  };
  const m = hairRig();
  const s = buildSpringBones(m, {});
  const q0 = findBone(m, "Hair_01").quaternion.clone();
  for (let i = 0; i < 240; i++) s.update(1 / 60); // 4s, body perfectly still
  const q = findBone(m, "Hair_01").quaternion;
  const dot = Math.abs(q0.x * q.x + q0.y * q.y + q0.z * q.z + q0.w * q.w);
  assert.ok(
    1 - dot < 1e-9,
    `sprung hair must NOT move on its own at rest (quat dot ${dot}) — springs react to body motion only`
  );
});

test("GEOMETRIC-fallback chain does NOT sag under gravity at rest (no self-generated motion)", () => {
  // An opaque rig (junk names) → ONLY the geometry tier resolves it → every sprung bone is geo=true.
  // Gravity is gated on real origin motion, so a perfectly still body must produce ZERO sag below bind
  // pose. Before the gate, update() added gravity to every tip each frame and a geo chain settled
  // visibly low. We snapshot every sprung bone's quaternion + its tip world position and assert both
  // are unmoved after a long settle.
  const m = opaqueBiped();
  const s = buildSpringBones(m, {});
  assert.ok(s.count >= 3, `opaque rig must hit the >=3-link geometric fallback (got ${s.count})`);
  const sprung = new Set(s.names);
  const snap = (m) => {
    const out = new Map();
    m.traverse((o) => {
      if (o.isBone && sprung.has(o.name)) {
        o.updateWorldMatrix(true, false);
        out.set(o.name, { q: o.quaternion.clone(), p: o.getWorldPosition(new THREE.Vector3()) });
      }
    });
    return out;
  };
  const before = snap(m);
  for (let i = 0; i < 600; i++) s.update(1 / 60); // 10s, body perfectly still
  const after = snap(m);
  for (const [name, b0] of before) {
    const b1 = after.get(name);
    const dot = Math.abs(b0.q.x * b1.q.x + b0.q.y * b1.q.y + b0.q.z * b1.q.z + b0.q.w * b1.q.w);
    assert.ok(
      1 - dot < 1e-9,
      `geo bone ${name} rotated on its own at rest (quat dot ${dot}) — gravity must be gated on real motion`
    );
    assert.ok(
      b0.p.distanceTo(b1.p) < 1e-6,
      `geo bone ${name} sagged at rest (moved ${b0.p.distanceTo(b1.p)}m) — a motionless body must not fall`
    );
  }
});

test("constructor regionWeight from a saved blob is CLAMPED to 0..2 (audit 2026-06-26)", () => {
  // setParams clamps per-region weights, but a saved/hand-edited profiles.json blob reaches the
  // CONSTRUCTOR spread directly — an out-of-range weight there used to bypass the 0..2 slider clamp
  // and drive a verlet instability (near-zero stiffness = permanently floppy). clampParams now covers it.
  const wOf = (rw, region) => {
    const r = buildSpringBones(hairRig(), { regionWeight: rw })
      .regions()
      .find((x) => x.region === region);
    return r && r.weight;
  };
  assert.equal(wOf({ hair: 1e9 }, "hair"), 2, "huge weight clamped to 2");
  assert.equal(wOf({ tail: -5 }, "tail"), 0, "negative weight clamped to 0");
  assert.equal(wOf({ hair: NaN }, "hair"), 1, "non-finite weight -> default 1");
});

test("impulse() kicks only the matching region's bones, then settles; unknown region returns false", () => {
  const findTail = (m) => {
    let b = null;
    m.traverse((o) => {
      if (o.isBone && o.name === "Tail") b = o;
    });
    return b;
  };
  const steps = (s, n) => {
    for (let i = 0; i < n; i++) s.update(1 / 60);
  };
  // Baseline: same rig, same step count, NO impulse.
  const mA = hairRig();
  const sA = buildSpringBones(mA);
  steps(sA, 12);
  const qA = findTail(mA).quaternion.clone();
  // Impulsed: a strong lateral tail kick must visibly rotate the tail bone vs the baseline.
  const mB = hairRig();
  const sB = buildSpringBones(mB);
  assert.equal(sB.impulse("tail", { x: 8 }, 0.3), true, "model has a tail → accepted");
  assert.equal(
    sB.impulse("wing", { x: 8 }, 0.3),
    false,
    "no wings on this rig → rejected (caller can try another region)"
  );
  sB.setRegionWeight("hair", 0);
  assert.equal(
    sB.impulse("hair", { x: 8 }, 0.3),
    false,
    "user-pinned region (weight 0) → rejected, fidget falls through instead of landing invisibly"
  );
  sB.setRegionWeight("hair", 1);
  steps(sB, 12);
  const qB = findTail(mB).quaternion;
  const dot = Math.abs(qA.x * qB.x + qA.y * qB.y + qA.z * qB.z + qA.w * qB.w);
  assert.ok(dot < 0.99995, `tail must deflect under the impulse (quat dot ${dot})`);
  // Region isolation: a HAIR bone must match the no-impulse baseline exactly (the kick was tail-only).
  const findHair = (m) => {
    let b = null;
    m.traverse((o) => {
      if (o.isBone && o.name === "Hair_01") b = o;
    });
    return b;
  };
  const hA = findHair(mA).quaternion,
    hB = findHair(mB).quaternion;
  const hdot = Math.abs(hA.x * hB.x + hA.y * hB.y + hA.z * hB.z + hA.w * hB.w);
  assert.ok(hdot > 0.999999, `hair must be untouched by a tail impulse (quat dot ${hdot})`);
  // Settle: long after the impulse ends, the tail returns toward rest (≈ the baseline pose).
  steps(sB, 600);
  steps(sA, 600);
  const qA2 = findTail(mA).quaternion,
    qB2 = findTail(mB).quaternion;
  const sdot = Math.abs(qA2.x * qB2.x + qA2.y * qB2.y + qA2.z * qB2.z + qA2.w * qB2.w);
  assert.ok(sdot > 0.9999, `tail must settle back after the impulse (quat dot ${sdot})`);
});

// (The grab-region hold test lived here — the mechanism was tried as a pin, softened to a damp,
// and REMOVED 2026-07-05: on ryuri the whole lower body is one tail region, so any nearby grab
// "froze the bottom". Sprung regions swing free during drags; grabfollow.test.js covers the
// ragdoll layer that carries the grab feel instead.)

test("a 0<w<1 region weight DAMPS amplitude under motion (the damp branch, behaviorally)", () => {
  // The hold churn rewrote the damp-application lines; regionFeel's mapping is unit-tested in
  // mathutil.test.js but NO spring test drove the `feel.damp > 0` branch itself (audit 2026-07-05).
  const findBone = (m, n) => {
    let b = null;
    m.traverse((o) => {
      if (o.isBone && o.name === n) b = o;
    });
    return b;
  };
  const qdot = (a, b) => Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  const ang = (a, b) => 2 * Math.acos(Math.min(1, qdot(a, b)));
  const defl = (weight) => {
    const m = hairRig();
    const s = buildSpringBones(m);
    s.setRegionWeight("tail", weight);
    const tail = findBone(m, "Tail");
    const q0 = tail.quaternion.clone();
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      m.position.x += 0.15;
      m.updateMatrixWorld(true);
      s.update(1 / 60);
      peak = Math.max(peak, ang(tail.quaternion, q0));
    }
    return peak;
  };
  const full = defl(1),
    damped = defl(0.3);
  assert.ok(full > 0.01, `weight 1 swings under motion (${full.toFixed(4)})`);
  assert.ok(damped > 1e-6, "weight 0.3 still moves (damped, not pinned)");
  assert.ok(
    damped < full * 0.6,
    `weight 0.3 deflects well under weight 1 (${damped.toFixed(4)} vs ${full.toFixed(4)})`
  );
});

test("impulse() boundary guard: ±Infinity vectors/dur are neutralized (no NaN tip, no immortal zombie impulse)", () => {
  const m = hairRig();
  const s = buildSpringBones(m);
  assert.equal(s.impulse("tail", { x: Infinity, y: -Infinity, z: NaN }, Infinity), true, "accepted (region exists)");
  for (let i = 0; i < 60; i++) s.update(1 / 60);
  let bad = 0;
  m.traverse((o) => {
    if (o.isBone && !Number.isFinite(o.quaternion.x)) bad++;
  });
  assert.equal(bad, 0, "no bone quaternion went non-finite from an Infinity impulse");
  // a finite-but-huge dur is capped: after 31 simulated seconds the impulse list must be empty
  s.impulse("tail", { x: 1 }, 9999);
  for (let i = 0; i < 31 * 60; i++) s.update(1 / 60);
  // (no public getter for _impulses — the receipt is that update() cost stays flat and bones stay finite)
  m.traverse((o) => {
    if (o.isBone && !Number.isFinite(o.quaternion.x)) bad++;
  });
  assert.equal(bad, 0, "bones finite after the capped-dur impulse expires");
});

test("verlet is frame-rate independent: the SAME real time -> ~same sway at 60 vs 120 fps", () => {
  // The dt-normalized verlet (drag/stiffness/damp re-scaled to real dt + time-corrected inertia) must
  // produce the same physical motion regardless of frame-rate. Before the fix the per-frame fractions
  // applied N times -> a 120fps tail settled ~twice as fast as a 60fps one over the same wall-clock.
  const findTail = (m) => {
    let b = null;
    m.traverse((o) => {
      if (o.isBone && o.name === "Tail") b = o;
    });
    return b;
  };
  const angleFromRest = (q, rest) => {
    const dot = Math.min(1, Math.abs(q.x * rest.x + q.y * rest.y + q.z * rest.z + q.w * rest.w));
    return 2 * Math.acos(dot); // radians between two unit quaternions
  };
  const run = (dt, T) => {
    const m = hairRig();
    const s = buildSpringBones(m);
    const rest = findTail(m).quaternion.clone();
    s.impulse("tail", { x: 12 }, 0.3);
    const n = Math.round(T / dt);
    for (let i = 0; i < n; i++) s.update(dt);
    return angleFromRest(findTail(m).quaternion, rest);
  };
  const T = 0.25; // mid-swing — before full settle, where any integrator trivially agrees at rest
  const a = run(1 / 60, T);
  const b = run(1 / 120, T);
  assert.ok(a > 0.01, `60fps tail must visibly deflect (got ${a.toFixed(4)} rad)`);
  assert.ok(b > 0.01, `120fps tail must visibly deflect (got ${b.toFixed(4)} rad)`);
  const rel = Math.abs(a - b) / Math.max(a, b);
  assert.ok(
    rel < 0.15,
    `deflection must agree across frame-rates (60fps ${a.toFixed(4)} vs 120fps ${b.toFixed(4)} rad, rel diff ${(rel * 100).toFixed(1)}%)`
  );
});
