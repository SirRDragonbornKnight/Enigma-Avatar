// skeleton.test.js — headless skeleton from glTF/GLB bytes (S2-b-ii), the sim host's model path.
// Asserts INTENT: joints become THREE.Bone (everything else stays plain), transforms flow through
// non-joint gaps, baked matrices decompose, GLB is sniffed by magic — and on a REAL model the
// cascade through THIS path resolves the same roles the renderer's path locks (ryuri 12/19).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { gltfJsonFromBuffer, buildSkeleton } from "../src/engine/skeleton.js";
import { resolveRig } from "../src/rig/rig.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RYURI = path.join(HERE, "..", "models", "ryuri", "ryuri.glb");

// A tiny rig: armature (NOT a joint) -> Hips -> Spine -> Head, plus a loose camera node.
// Hips carries a translation; Spine a baked matrix (translation y=+1); Head a translation.
const SYNTH = {
  scene: 0,
  scenes: [{ nodes: [0, 4] }],
  nodes: [
    { name: "Armature", children: [1], translation: [10, 0, 0] },
    { name: "Hips", children: [2], translation: [0, 1, 0] },
    { name: "Spine", children: [3], matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1] },
    { name: "Head", translation: [0, 1, 0] },
    { name: "Camera" },
  ],
  skins: [{ joints: [1, 2, 3] }],
};

test("joints become Bones, the rest stay plain nodes; DFS order holds", () => {
  const { root, bones } = buildSkeleton(SYNTH);
  assert.deepEqual(
    bones.map((b) => b.name),
    ["Hips", "Spine", "Head"]
  );
  assert.equal(
    bones.every((b) => b.isBone),
    true
  );
  let armature = null;
  root.traverse((o) => {
    if (o.name === "Armature") armature = o;
  });
  assert.equal(armature.isBone, undefined); // not a joint -> plain Object3D
  assert.equal(bones[0].parent, armature); // hierarchy preserved through the non-joint parent
});

test("world transforms flow through non-joint gaps; baked matrices decompose", () => {
  const { bones } = buildSkeleton(SYNTH);
  const w = bones[2].getWorldPosition(new THREE.Vector3());
  // Armature x+10, Hips y+1, Spine (matrix) y+1, Head y+1 -> world (10, 3, 0)
  assert.deepEqual([w.x, w.y, w.z], [10, 3, 0]);
});

test("a static mesh (no skins) is honestly un-rigged: zero bones, no throw", () => {
  const { bones } = buildSkeleton({ nodes: [{ name: "Statue" }], scenes: [{ nodes: [0] }] });
  assert.equal(bones.length, 0);
});

test("GLB bytes are sniffed by MAGIC and the JSON chunk parses (padding honored)", () => {
  const json = Buffer.from(JSON.stringify(SYNTH), "utf8");
  const pad = json.length % 4 ? 4 - (json.length % 4) : 0;
  const chunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]); // spec: JSON chunks pad with spaces
  const glb = Buffer.alloc(12 + 8 + chunk.length);
  glb.writeUInt32LE(0x46546c67, 0); // 'glTF'
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(chunk.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
  chunk.copy(glb, 20);
  const parsed = gltfJsonFromBuffer(glb);
  assert.equal(parsed.nodes.length, 5);
  const bare = gltfJsonFromBuffer(Buffer.from(JSON.stringify(SYNTH), "utf8"));
  assert.equal(bare.skins[0].joints.length, 3); // non-GLB bytes -> bare .gltf JSON
});

test(
  "REAL-MODEL PARITY: ryuri through the host path resolves the locked 12/19 roles",
  { skip: !fs.existsSync(RYURI) ? "models/ not staged on this checkout" : false },
  () => {
    const { root, bones } = buildSkeleton(gltfJsonFromBuffer(fs.readFileSync(RYURI)));
    assert.equal(bones.length > 100, true); // the lamia tail alone is ~112 bones
    const resolved = resolveRig(root, null);
    const n = Object.values(resolved.roles || {}).filter(Boolean).length;
    assert.equal(n, 12); // the same count tests/realmodels.test.js locks via the renderer path
  }
);
