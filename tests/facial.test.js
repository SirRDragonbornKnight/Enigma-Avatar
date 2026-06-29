// facial.test.js — locks buildFacial's lip-sync ladder (named morph → jaw bone → geometric)
// and blink resolution: the engine must never claim a working mouth it can't actually drive.
// Pure three.js, no WebGL → runs headless under `node --test`.
import { test } from "node:test";
import assert from "node:assert";
import * as THREE from "three";
import { buildFacial } from "../src/face/facial.js";

function meshWithMorphs(dict, count) {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  if (dict) m.morphTargetDictionary = dict;
  m.morphTargetInfluences = new Array(count != null ? count : dict ? Object.keys(dict).length : 0).fill(0);
  return m;
}
const model = (...kids) => {
  const g = new THREE.Group();
  for (const k of kids) g.add(k);
  return g;
};
const bone = (name) => {
  const b = new THREE.Bone();
  b.name = name;
  return b;
};

test("named mouth morph -> mode 'morph'", () => {
  assert.strictEqual(buildFacial(model(meshWithMorphs({ jawOpen: 0 })), null).mode, "morph");
});

test("no mouth channel -> mode 'none' (acknowledged, not faked)", () => {
  assert.strictEqual(buildFacial(model(meshWithMorphs(null, 0)), null).mode, "none");
});

test("jaw bone -> mode 'bones'", () => {
  assert.strictEqual(buildFacial(model(meshWithMorphs(null, 0), bone("Bip_Jaw")), null).mode, "bones");
});

// ---- STRICT BLINK (#22): blink fires ONLY on a real drive; never autonomously ----

// A bone/morph facade with a real blink channel: a named blink morph + a lid bone is overkill,
// a blink morph alone resolves blinkMode 'morph'. We read back what update() writes to the morph.
function blinkMorphMesh() {
  const m = meshWithMorphs({ Blink: 0 }); // BLINK_RE matches "Blink"
  return m;
}

test("STRICT: blink does NOT fire across many frames with no drive (no autonomous blink)", () => {
  const mesh = blinkMorphMesh();
  const f = buildFacial(model(mesh), null);
  assert.strictEqual(f.blinkMode, "morph", "named blink morph resolves a blink channel");
  let peak = 0;
  for (let i = 0; i < 2000; i++) {
    f.update(1 / 60, true);
    peak = Math.max(peak, mesh.morphTargetInfluences[0]);
  }
  assert.strictEqual(peak, 0, `lids stay open with no drive over 2000 frames (peak ${peak})`);
});

test("STRICT: one blink() drives a single close-open envelope, then returns to open and stays", () => {
  const mesh = blinkMorphMesh();
  const f = buildFacial(model(mesh), null);
  f.blink();
  let peak = 0;
  for (let i = 0; i < 30; i++) {
    f.update(1 / 60, true);
    peak = Math.max(peak, mesh.morphTargetInfluences[0]);
  }
  assert.ok(peak > 0.8, `the queued blink actually closes the lids (peak ${peak})`);
  // run well past the ~0.22s envelope: lids must be open again and stay there (no re-fire)
  let after = 0;
  for (let i = 0; i < 600; i++) {
    f.update(1 / 60, true);
    after = Math.max(after, mesh.morphTargetInfluences[0]);
  }
  assert.strictEqual(after, 0, `after the one blink the lids stay open — never re-fires (peak ${after})`);
});

test("STRICT: setBlink holds the lids; <0 releases them back open", () => {
  const mesh = blinkMorphMesh();
  const f = buildFacial(model(mesh), null);
  f.setBlink(0.7);
  for (let i = 0; i < 10; i++) f.update(1 / 60, true);
  assert.ok(Math.abs(mesh.morphTargetInfluences[0] - 0.7) < 1e-6, "held lid value sticks");
  f.setBlink(-1);
  for (let i = 0; i < 10; i++) f.update(1 / 60, true);
  assert.strictEqual(mesh.morphTargetInfluences[0], 0, "released -> eyes open");
});

test("STRICT: lids open on the blinkOn falling edge mid-blink (no half-closed freeze)", () => {
  const mesh = blinkMorphMesh();
  const f = buildFacial(model(mesh), null);
  f.blink();
  f.update(1 / 60, true); // mid-envelope, lids partly closed
  assert.ok(mesh.morphTargetInfluences[0] > 0, "blink is in progress");
  f.update(1 / 60, false); // blinkOn falls -> snap open
  assert.strictEqual(mesh.morphTargetInfluences[0], 0, "falling edge snaps lids open, not frozen");
});

// ---- VRM facade parity (#8): same surface, strict blink, mouth opener probe ----

function fakeVrm(exprNames = ["aa", "blink"]) {
  const values = {};
  const em = {
    expressions: exprNames.map((n) => ({ expressionName: n })),
    setValue(n, v) {
      values[n] = v;
    },
  };
  return { vrm: { expressionManager: em }, values };
}

test("VRM facade exposes the same surface (setBlink/blinkMode/ownedMorphs/blink)", () => {
  const { vrm } = fakeVrm();
  const f = buildFacial(model(), vrm);
  assert.strictEqual(f.mode, "vrm");
  assert.strictEqual(f.blinkMode, "vrm");
  assert.deepStrictEqual(f.ownedMorphs, []);
  assert.strictEqual(typeof f.setBlink, "function");
  assert.strictEqual(typeof f.blink, "function");
});

test("VRM STRICT: no autonomous blink over many frames", () => {
  const { vrm, values } = fakeVrm();
  const f = buildFacial(model(), vrm);
  let peak = 0;
  for (let i = 0; i < 2000; i++) {
    f.update(1 / 60, true);
    peak = Math.max(peak, values.blink || 0);
  }
  assert.strictEqual(peak, 0, `VRM lids never blink without a drive (peak ${peak})`);
});

test("VRM STRICT: blink() fires once; lids open on blinkOn falling edge", () => {
  const { vrm, values } = fakeVrm();
  const f = buildFacial(model(), vrm);
  f.blink();
  f.update(1 / 60, true);
  assert.ok(values.blink > 0, "VRM blink in progress");
  f.update(1 / 60, false); // falling edge mid-blink
  assert.strictEqual(values.blink, 0, "VRM lids snap open on falling edge");
});

test("VRM #31: prefers a dedicated opener over 'aa', else falls back to 'aa'", () => {
  const a = fakeVrm(["mouthOpen", "blink"]);
  const fa = buildFacial(model(), a.vrm);
  fa.setMouth(1);
  fa.update(1, true);
  assert.ok((a.values.mouthOpen || 0) > 0.5, "drives mouthOpen when present");
  assert.strictEqual(a.values.aa, undefined, "...and not 'aa'");
  const b = fakeVrm(["aa", "blink"]); // no dedicated opener -> 'aa'
  const fb = buildFacial(model(), b.vrm);
  fb.setMouth(1);
  fb.update(1, true);
  assert.ok((b.values.aa || 0) > 0.5, "falls back to the 'aa' viseme");
});

// BOUNDARY GUARD (audit 2026-06-26): a NaN amplitude (garbage off the bus / a bad RMS) must not
// permanently freeze the mouth open — before the fix, mouthTgt=NaN stuck forever (mouth += (NaN-x)*k).
test("GUARD: setMouth(NaN) is ignored; the mouth stays drivable (no permanent freeze)", () => {
  const mesh = meshWithMorphs({ jawOpen: 0 });
  const f = buildFacial(model(mesh), null);
  assert.strictEqual(f.mode, "morph", "morph-mode mouth");
  f.setMouth(NaN); // garbage amplitude
  for (let i = 0; i < 10; i++) f.update(1 / 60, false);
  assert.ok(Number.isFinite(mesh.morphTargetInfluences[0]), "morph influence finite after a NaN setMouth");
  f.setMouth(0.8); // a real drive must still reopen the mouth
  for (let i = 0; i < 60; i++) f.update(1 / 60, false);
  assert.ok(
    mesh.morphTargetInfluences[0] > 0.3,
    `mouth RECOVERS after the NaN (influence ${mesh.morphTargetInfluences[0].toFixed(2)}; before the fix it stuck at NaN forever)`
  );
});
