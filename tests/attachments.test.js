// attachments.test.js — the bone-attached prop store (engine carve S1-d), headless.
// Asserts INTENT: the async swap-race drops late loads (dispose, no list entry, no save), role
// aliases beat name regexes, garbage numerics never reach a matrix or the profile, and every
// mutation persists through commit+save.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createAttachmentStore } from "../src/engine/attachments.js";

function makeRigWorld() {
  // A real THREE graph: rig root + a couple of named bones + a role map.
  const rig = new THREE.Group();
  const model = new THREE.Group();
  const hand = new THREE.Bone();
  hand.name = "Bip_R_Wrist_023"; // hostile name — only the ROLE map knows it's the right hand
  const decoy = new THREE.Bone();
  decoy.name = "righthand_decoration"; // name-regex bait
  const tail = new THREE.Bone();
  tail.name = "TailRoot";
  model.add(decoy, hand, tail);
  rig.add(model);
  return { rig, model, roleBones: { right_hand: hand }, hand, decoy, tail };
}

function propAsset(size = 2) {
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(size, size, size)));
  return { scene };
}

function harness({ world = makeRigWorld(), height = 6 } = {}) {
  const pending = []; // captured loadAsset calls: {url, onOk, onErr}
  const profiles = {};
  const calls = { commit: 0, save: 0, dispose: [], status: [] };
  let key = "modelA";
  const store = createAttachmentStore({
    loadAsset: (url, onOk, onErr) => pending.push({ url, onOk, onErr }),
    kindOf: () => "glb",
    baseName: (u) => String(u).split("/").pop(),
    getModel: () => world.model,
    getRig: () => world.rig,
    getRoleBones: () => world.roleBones,
    getKey: () => key,
    getAvatarWorldHeight: () => height,
    dispose: (root) => calls.dispose.push(root),
    profileFor: (k) => profiles[k] || (profiles[k] = {}),
    saveProfileSoon: () => calls.save++,
    commitAttachments: () => calls.commit++,
    setStatus: (m) => calls.status.push(m),
  });
  return { pending, profiles, calls, world, store, setKey: (k) => (key = k) };
}

test("attach lands on the ROLE-resolved bone even under hostile names; persists via commit+save", () => {
  const { pending, calls, world, store } = harness();
  const id = store.attachMesh("./props/sword.glb", { bone: "righthand" });
  assert.equal(typeof id, "string");
  pending[0].onOk(propAsset());
  const a = store.getAttachments()[0];
  assert.equal(a.attachedTo, "Bip_R_Wrist_023"); // the ROLE bone, not the "righthand_decoration" decoy
  assert.equal(a.obj.parent, world.hand);
  assert.equal(calls.commit, 1);
  assert.equal(calls.save, 1);
});

test("THE RACE: a model swap mid-load drops the late asset — disposed, unlisted, unsaved", () => {
  const { pending, calls, store, setKey } = harness();
  store.attachMesh("./props/hat.glb", { bone: "head" });
  setKey("modelB"); // swap BEFORE the load completes
  const asset = propAsset();
  pending[0].onOk(asset);
  assert.equal(store.getAttachments().length, 0);
  assert.deepEqual(calls.dispose, [asset.scene]); // GPU-honest teardown of the orphan
  assert.equal(calls.save, 0); // nothing written into the WRONG profile
  assert.match(calls.status.at(-1), /attach dropped: model changed/);
});

test("fresh prop AUTO-SIZES to a fraction of her height; explicit scale is respected", () => {
  const { pending, store } = harness({ height: 6 });
  store.attachMesh("./props/sword.glb", {}); // default prop category, no scale
  pending[0].onOk(propAsset(2)); // 2-unit box → s = 6*0.45/2 = 1.35
  assert.equal(store.getAttachments()[0].scale, 1.35);
  store.attachMesh("./props/cane.glb", { scale: 0.5 });
  pending[1].onOk(propAsset(2));
  assert.equal(store.getAttachments()[1].scale, 0.5); // given scale wins — no auto-size
});

test("garbage pos/rot/scale never reach the matrix or the profile — sanitized to defaults", () => {
  const { pending, store } = harness();
  store.attachMesh("./props/x.glb", { pos: [1, "NaN-soup", 3], rot: "sideways", scale: "big" });
  pending[0].onOk(propAsset());
  const a = store.getAttachments()[0];
  assert.deepEqual(a.pos, [0, 0, 0]); // bad triplet → default, not NaN
  assert.deepEqual(a.rot, [0, 0, 0]);
  assert.equal(a.scale, 1);
  assert.equal(a.obj.position.length(), 0); // the matrix stayed finite
});

test("restore (_restore) attaches WITHOUT saving — a restore must not rewrite the profile", () => {
  const { pending, calls, store } = harness();
  store.attachMesh("./props/hat.glb", { bone: "head", _restore: true, scale: 1 });
  pending[0].onOk(propAsset());
  assert.equal(store.getAttachments().length, 1);
  assert.equal(calls.save, 0);
});

test("detach removes + disposes + saves; unknown id is an honest false", () => {
  const { pending, calls, store } = harness();
  const id = store.attachMesh("./props/sword.glb", {});
  pending[0].onOk(propAsset());
  const obj = store.getAttachments()[0].obj;
  assert.equal(store.detachAttachment("ghost"), false);
  assert.equal(store.detachAttachment(id), true);
  assert.equal(store.getAttachments().length, 0);
  assert.equal(obj.parent, null);
  assert.equal(calls.dispose.includes(obj), true);
});

test("clearAttachments empties the list and disposes every object", () => {
  const { pending, calls, store } = harness();
  store.attachMesh("./a.glb", {});
  store.attachMesh("./b.glb", {});
  pending[0].onOk(propAsset());
  pending[1].onOk(propAsset());
  store.clearAttachments();
  assert.equal(store.getAttachments().length, 0);
  assert.equal(calls.dispose.length, 2);
});

test("reapplyAttachments: rig-rooted furniture is explicitly removed (no ghost chair), then the profile re-attaches as restore", () => {
  const { pending, profiles, world, store } = harness();
  store.attachMesh("./chair.glb", { category: "furniture" }); // no bone → rides the rig root
  pending[0].onOk(propAsset());
  assert.equal(store.getAttachments()[0].obj.parent, world.rig);
  profiles.modelA = { attachments: [{ url: "./hat.glb", bone: "head", scale: 1 }] };
  store.reapplyAttachments();
  assert.equal(world.rig.children.includes(store.getAttachments()[0]?.obj), false); // ghost chair gone
  assert.equal(pending.length, 2); // the saved hat is loading again
  assert.equal(pending[1].url, "./hat.glb");
});

test("tuneAttachment re-parents on a bone change, sanitizes numerics, returns the truth snapshot", () => {
  const { pending, world, store } = harness();
  const id = store.attachMesh("./sword.glb", { bone: "righthand", scale: 1 });
  pending[0].onOk(propAsset());
  const r = store.tuneAttachment(id, { bone: "tail", pos: [0, 1, 0], rot: "junk", scale: "junk" });
  assert.equal(r.attachedTo, "TailRoot");
  assert.equal(store.getAttachments()[0].obj.parent, world.tail);
  assert.deepEqual(r.pos, [0, 1, 0]);
  assert.deepEqual(r.rot, [0, 0, 0]); // junk kept the OLD value
  assert.equal(r.scale, 1);
  assert.equal(store.tuneAttachment("ghost", {}), null);
});

test("a loader ERROR is an honest status, never a phantom list entry", () => {
  const { pending, calls, store } = harness();
  store.attachMesh("./broken.glb", {});
  pending[0].onErr(new Error("bad file"));
  assert.equal(store.getAttachments().length, 0);
  assert.match(calls.status.at(-1), /attach failed: bad file/);
});
