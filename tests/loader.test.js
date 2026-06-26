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

// BUS GATE (audit 2026-06-26): the bus is the driver; a {action:"load",url} must not make the overlay
// fetch an arbitrary REMOTE url. Local/file/blob/data must still load (the external Avatars dir). We
// assert the GATE decision synchronously (real loading is async) using an unsupported ext so no real
// loader is constructed — a LOCAL path reaches the 'unsupported format' check (proving it passed the gate).
test("bus gate: loadAsset BLOCKS remote http(s) urls", () => {
  for (const u of ["http://evil.test/x.glb", "https://evil.test/x.vrm"]) {
    let err = null, ok = false;
    loadAsset(u, () => { ok = true; }, (e) => { err = e; });
    assert.ok(err && /remote URL load blocked/i.test(String(err.message || err)), `blocked ${u}`);
    assert.ok(!ok, "onOk did not fire for a remote url");
  }
});

test("bus gate: a LOCAL path passes the gate (reaches format handling, not blocked)", () => {
  let blocked = false, reachedFormat = false;
  loadAsset("C:/Users/SirKn/3d Avatar/Avatars/x.obj", () => {}, (e) => {
    const m = String(e.message || e);
    if (/remote URL load blocked/i.test(m)) blocked = true;
    if (/unsupported format/i.test(m)) reachedFormat = true;   // got PAST the gate to kindOf
  });
  assert.ok(!blocked, "local path NOT blocked by the remote gate (external Avatars dir keeps loading)");
  assert.ok(reachedFormat, "local path reached format handling — proves it passed the gate");
});

test("bus gate: allowRemote:true is an explicit opt-in that bypasses the gate", () => {
  let blocked = false;
  loadAsset("http://ok.test/x.obj", () => {}, (e) => { if (/remote URL load blocked/i.test(String(e.message || e))) blocked = true; }, { allowRemote: true });
  assert.ok(!blocked, "allowRemote:true bypasses the remote gate");
});
