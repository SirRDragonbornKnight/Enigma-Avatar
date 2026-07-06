// meshes.test.js — the mesh-visibility + outfit store (engine carve S1-b), headless.
// Asserts INTENT: index authority survives traversal reshuffles, the hidden set persists sorted,
// and wearing an outfit RESTORES parts the previous look had off (show-all-then-hide).
import test from "node:test";
import assert from "node:assert/strict";
import { createMeshStore } from "../src/engine/meshes.js";

function fakeMesh(name) {
  return { isMesh: true, name, visible: true, parent: {} };
}

// A minimal THREE-shaped root: traverse() walks the CURRENT order array, so a test can reshuffle
// it to simulate the skin-weight adoption reparent (the exact aveline regression).
function fakeModel(meshes) {
  return {
    meshes,
    traverse(fn) {
      for (const m of this.meshes) fn(m);
    },
  };
}

function harness(meshNames = ["body", "shirt", "shorts", "hair"]) {
  const meshes = meshNames.map(fakeMesh);
  const model = fakeModel(meshes);
  const profiles = {};
  const calls = { save: 0, silhouette: 0, status: [] };
  const store = createMeshStore({
    getModel: () => model,
    profileFor: (k) => profiles[k] || (profiles[k] = {}),
    saveProfileSoon: () => calls.save++,
    getKey: () => "m1",
    onSilhouetteChange: () => calls.silhouette++,
    setStatus: (m) => calls.status.push(m),
  });
  return { meshes, model, profiles, calls, store };
}

test("index authority: the pristine-order cache survives a traversal reshuffle", () => {
  const { meshes, model, store } = harness();
  store.cacheMeshList();
  model.meshes = [meshes[3], meshes[0], meshes[2], meshes[1]]; // adoption reshuffled live traversal
  const arr = store.allMeshesInfo();
  assert.deepEqual(
    arr.map((e) => e.name),
    ["body", "shirt", "shorts", "hair"] // still FILE order — saved indices keep meaning
  );
});

test("disposed strays drop out of the list but the surviving order holds", () => {
  const { meshes, store } = harness();
  store.cacheMeshList();
  meshes[1].parent = null; // disposed
  assert.deepEqual(
    store.allMeshesInfo().map((e) => e.name),
    ["body", "shorts", "hair"]
  );
});

test("no cache -> live traversal fallback; clearMeshList returns to fallback", () => {
  const { model, store } = harness();
  assert.equal(store.allMeshesInfo().length, 4); // pre-cache: live walk
  store.cacheMeshList();
  model.meshes = model.meshes.slice(0, 2);
  assert.equal(store.allMeshesInfo().length, 4); // cache still authoritative
  store.clearMeshList();
  assert.equal(store.allMeshesInfo().length, 2); // fallback follows the live model again
});

test("setMeshVisible hides, persists a SORTED hidden set, and reports the silhouette change", () => {
  const { meshes, profiles, calls, store } = harness();
  store.cacheMeshList();
  assert.equal(store.setMeshVisible(2, false), 1);
  assert.equal(store.setMeshVisible(1, false), 1);
  assert.equal(meshes[2].visible, false);
  assert.deepEqual(profiles.m1.hiddenMeshes, [1, 2]); // sorted, not insertion order
  assert.equal(calls.save, 2);
  assert.equal(calls.silhouette, 2); // hit mask/footprint/dims must re-measure on every toggle
  assert.equal(store.setMeshVisible(1, true), 1);
  assert.deepEqual(profiles.m1.hiddenMeshes, [2]); // re-show removes from the set
});

test("setMeshVisible on a bad index is an honest 0 — no save, no silhouette churn", () => {
  const { calls, store } = harness();
  store.cacheMeshList();
  assert.equal(store.setMeshVisible(99, false), 0);
  assert.equal(calls.save, 0);
  assert.equal(calls.silhouette, 0);
});

test("applyMeshVisibility hides exactly the saved set (and no-ops with nothing saved)", () => {
  const { meshes, profiles, store } = harness();
  store.cacheMeshList();
  store.applyMeshVisibility(); // nothing saved — must not throw or touch meshes
  assert.equal(
    meshes.every((m) => m.visible),
    true
  );
  profiles.m1 = { hiddenMeshes: [0, 3] };
  store.applyMeshVisibility();
  assert.deepEqual(
    meshes.map((m) => m.visible),
    [false, true, true, false]
  );
});

test("wearOutfit shows EVERYTHING first, then hides the preset — restoring the previous look's parts", () => {
  const { meshes, profiles, calls, store } = harness();
  store.cacheMeshList();
  store.setMeshVisible(1, false); // look A hides the shirt
  store.saveOutfit("casual"); // casual = [1]
  store.setMeshVisible(3, false); // now the hair is off too (a different look)
  assert.equal(store.wearOutfit("casual"), true);
  assert.deepEqual(
    meshes.map((m) => m.visible),
    [true, false, true, true] // hair came BACK; only the outfit's own set is hidden
  );
  assert.deepEqual(profiles.m1.hiddenMeshes, [1]);
  assert.equal(calls.silhouette >= 3, true);
});

test("wearOutfit on an unknown name is an honest false; garbage preset indices are filtered", () => {
  const { meshes, profiles, calls, store } = harness();
  store.cacheMeshList();
  assert.equal(store.wearOutfit("nope"), false);
  assert.equal(calls.status.at(-1), 'no outfit "nope"');
  profiles.m1 = { outfits: { junk: [1, -5, "x", 2.5] } }; // only 1 survives the integer>=0 filter
  assert.equal(store.wearOutfit("junk"), true);
  assert.deepEqual(profiles.m1.hiddenMeshes, [1]);
  assert.equal(meshes[1].visible, false);
});

test("saveOutfit snapshots the CURRENT hidden set under a trimmed name; blank names refuse", () => {
  const { profiles, store } = harness();
  store.cacheMeshList();
  assert.equal(store.saveOutfit("   "), null);
  store.setMeshVisible(0, false);
  assert.deepEqual(store.saveOutfit("  beach "), ["beach"]);
  assert.deepEqual(profiles.m1.outfits.beach, [0]);
});

test("deleteOutfit removes the preset and returns the remaining names", () => {
  const { store } = harness();
  store.cacheMeshList();
  store.saveOutfit("a");
  store.setMeshVisible(1, false);
  store.saveOutfit("b");
  assert.deepEqual(store.deleteOutfit("a"), ["b"]);
  assert.deepEqual(store.deleteOutfit("ghost"), ["b"]); // deleting a ghost is quietly fine
});
