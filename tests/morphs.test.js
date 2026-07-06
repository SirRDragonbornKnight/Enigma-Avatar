// morphs.test.js — the morph/blendshape store (engine carve S1-c), headless.
// Asserts INTENT: only the PRIMARY morph group is driven (divergent meshes stay pristine), garbage
// values never reach influences or the profile, zero means "don't persist".
import test from "node:test";
import assert from "node:assert/strict";
import { createMorphStore } from "../src/engine/morphs.js";

function morphMesh(count, dict = null) {
  return {
    isMesh: true,
    parent: {},
    morphTargetInfluences: new Array(count).fill(0),
    morphTargetDictionary: dict,
  };
}

function harness({ meshes = [], facial = null } = {}) {
  const model = {
    traverse(fn) {
      for (const m of meshes) fn(m);
    },
  };
  const profiles = {};
  const calls = { save: 0, status: [] };
  const store = createMorphStore({
    getModel: () => model,
    getFacial: () => facial,
    profileFor: (k) => profiles[k] || (profiles[k] = {}),
    saveProfileSoon: () => calls.save++,
    getKey: () => "m1",
    setStatus: (m) => calls.status.push(m),
  });
  return { meshes, profiles, calls, store };
}

test("primary group = the LARGEST shared morph count; divergent smaller meshes are excluded", () => {
  const big1 = morphMesh(19),
    big2 = morphMesh(19),
    small = morphMesh(3); // reuses indices for DIFFERENT shapes — must not be driven
  const { store } = harness({ meshes: [big1, small, big2] });
  const g = store.morphMeshes();
  assert.equal(g.n, 19);
  assert.deepEqual(g.meshes, [big1, big2]);
  store.setMorphValue(1, 0.7);
  assert.equal(big1.morphTargetInfluences[1], 0.7);
  assert.equal(big2.morphTargetInfluences[1], 0.7);
  assert.equal(small.morphTargetInfluences[1], 0); // pristine
});

test("setMorphValue clamps to 0..1, persists non-zero, DELETES at zero, reports meshes hit", () => {
  const { profiles, calls, store } = harness({ meshes: [morphMesh(5), morphMesh(5)] });
  assert.equal(store.setMorphValue(2, 3.5), 2); // clamped to 1, both meshes
  assert.equal(profiles.m1.morphs[2], 1);
  assert.equal(store.setMorphValue(2, 0), 2);
  assert.equal(2 in profiles.m1.morphs, false); // zero = default = not persisted
  assert.equal(calls.save, 2);
});

test("a garbage value is an honest 0: influences untouched, nothing persisted", () => {
  const m = morphMesh(5);
  const { profiles, calls, store } = harness({ meshes: [m] });
  assert.equal(store.setMorphValue(1, "garbage"), 0);
  assert.equal(m.morphTargetInfluences[1], 0);
  assert.equal(profiles.m1, undefined); // the profile was never even touched
  assert.equal(calls.save, 0);
});

test("null value means FULL ON (the bare bus 'morph 3' form)", () => {
  const m = morphMesh(5);
  const { store } = harness({ meshes: [m] });
  assert.equal(store.setMorphValue(3, null), 1);
  assert.equal(m.morphTargetInfluences[3], 1);
});

test("applyMorphs restores saved values, clamps, and SKIPS garbage/legacy profile entries", () => {
  const m = morphMesh(5);
  const { profiles, store } = harness({ meshes: [m] });
  profiles.m1 = { morphs: { 0: 0.4, 1: 9, 2: "NaN-soup", 4: -3 } };
  store.applyMorphs();
  assert.equal(m.morphTargetInfluences[0], 0.4);
  assert.equal(m.morphTargetInfluences[1], 1); // clamped high
  assert.equal(m.morphTargetInfluences[2], 0); // garbage never reaches the GPU
  assert.equal(m.morphTargetInfluences[4], 0); // clamped low
});

test("allMorphsInfo: value readback + auto flag from facial.ownedMorphs + region from the geo bands", () => {
  const m = morphMesh(3, { smile: 1 });
  m.morphTargetInfluences[1] = 0.5;
  const { store } = harness({ meshes: [m], facial: { ownedMorphs: [0] } });
  store.setMorphGeo({
    byIndex: new Map([
      [0, { mouthScore: 0.8, eyeScore: 0.1 }],
      [2, { mouthScore: 0.01, eyeScore: 0.6 }],
    ]),
  });
  const info = store.allMorphsInfo();
  assert.equal(info.length, 3);
  assert.deepEqual(
    info.map((e) => e.region),
    ["mouth", null, "eyes"] // unclassified index 1 is an honest null
  );
  assert.equal(info[0].auto, true); // lip-sync owns it — a manual set won't hold
  assert.equal(info[1].name, "smile"); // dictionary name surfaced
  assert.equal(info[1].value, 0.5);
});

test("morph geo holder: set -> read -> reset round-trip; empty model = honest empty info", () => {
  const { store } = harness({ meshes: [] });
  assert.deepEqual(store.allMorphsInfo(), []);
  assert.equal(store.morphGeoAnalysis(), null);
  const g = { byIndex: new Map() };
  store.setMorphGeo(g);
  assert.equal(store.morphGeoAnalysis(), g);
  store.resetMorphGeo();
  assert.equal(store.morphGeoAnalysis(), null);
});
