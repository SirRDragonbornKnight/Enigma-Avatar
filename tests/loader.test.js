// loader.test.js — honest format coverage + FBX bind surfacing for the asset loader.
// Locks two audit findings:
//   #6  an unsupported format (.obj/.dae) fails with an HONEST 'unsupported format' message,
//       NOT a misleading GLTFLoader 'not valid JSON' parse error (there is no OBJ/Collada loader).
//   #12 an FBX material-bind problem is SURFACED (a warning fires) instead of being swallowed by
//       'catch{}' while loadAsset still reports a clean success.
import { test } from "node:test";
import assert from "node:assert";
import { kindOf, loadAsset, applyFbxMaterials } from "../loader.js";

// a minimal three.js-ish node: only the .traverse() + isMesh/material shape applyFbxMaterials reads.
function meshRoot() {
  const mesh = { isMesh: true, material: { name: "body" }, needsUpdate: false };
  return { traverse(fn) { fn(this); fn(mesh); } };
}
function emptyRoot() {                                   // an untextured prop: no mesh-with-material
  return { traverse(fn) { fn(this); } };
}

test("kindOf classifies loadable formats and flags everything else as unsupported", () => {
  assert.strictEqual(kindOf("a/b/scene.glb"), "gltf");
  assert.strictEqual(kindOf("a/scene.gltf"), "gltf");
  assert.strictEqual(kindOf("a/avatar.vrm"), "vrm");
  assert.strictEqual(kindOf("a/avatar.fbx"), "fbx");
  assert.strictEqual(kindOf("a/thing.obj"), "unsupported");
  assert.strictEqual(kindOf("a/thing.dae"), "unsupported");
  assert.strictEqual(kindOf("a/thing.stl"), "unsupported");
});

test("#6 loadAsset fails HONESTLY on an unsupported format (no GLTFLoader 'not valid JSON')", () => {
  let err = null, ok = false;
  loadAsset("C:/x/model.obj", () => { ok = true; }, (e) => { err = e; });
  assert.ok(err, "onErr fired");
  assert.ok(!ok, "onOk did NOT fire");
  const msg = String(err.message || err);
  assert.match(msg, /unsupported format/i, "message names the real problem");
  assert.match(msg, /\.obj/i, "message names the offending extension");
  assert.doesNotMatch(msg, /JSON/i, "NOT a misleading JSON parse error");
});

test("#12 applyFbxMaterials SURFACES a missing-binding problem (textured FBX, no resource dir)", async () => {
  // a textured FBX (mesh with a material) but no dir → cannot bind; must report, not stay silent.
  const probs = await applyFbxMaterials(meshRoot(), "", null);
  assert.ok(Array.isArray(probs) && probs.length > 0, "a problem is returned, not swallowed");
  assert.match(String(probs[0].message), /no resource dir|cannot be bound|textures/i, "honest message");
});

test("#12 applyFbxMaterials stays CLEAN for an untextured prop (no false warning)", async () => {
  const probs = await applyFbxMaterials(emptyRoot(), "", null);
  assert.deepStrictEqual(probs, [], "no materials wanted -> no problem reported");
});

test("#12 loadAsset routes an FBX bind problem to onWarn (not black-holed)", async () => {
  // Drive loadAsset's fbx branch with an injected fake FBXLoader so we exercise the real
  // 'try{ applyFbxMaterials }; for(p of probs) onWarn(p)' surfacing path without a real file.
  const warned = [];
  await new Promise((resolve) => {
    loadAsset("C:/x/avatar.fbx", () => resolve(), () => resolve(), {
      kind: "fbx",
      resourceDir: "",                                  // forces applyFbxMaterials to report 'no resource dir' for a textured mesh
      onWarn: (e) => warned.push(e),
      _fbxLoaderFactory: () => ({
        load(_url, onOk) { onOk(meshRoot()); },         // hand back a textured mesh immediately
      }),
    });
  });
  assert.ok(warned.length > 0, "a binding warning was surfaced via onWarn");
  assert.match(String(warned[0].message || warned[0]), /textures|bind|resource dir/i, "honest warning text");
});
