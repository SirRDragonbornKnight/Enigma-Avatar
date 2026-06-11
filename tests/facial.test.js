// facial.test.js — locks buildFacial's lip-sync ladder + the index-override edge cases that
// the audit flagged (H2/H3): a bad mouthMorph override must NEVER report a working mouth.
// Pure three.js, no WebGL → runs headless under `node --test`.
import { test } from "node:test";
import assert from "node:assert";
import * as THREE from "three";
import { buildFacial } from "../facial.js";

function meshWithMorphs(dict, count) {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  if (dict) m.morphTargetDictionary = dict;
  m.morphTargetInfluences = new Array(count != null ? count : (dict ? Object.keys(dict).length : 0)).fill(0);
  return m;
}
const model = (...kids) => { const g = new THREE.Group(); for (const k of kids) g.add(k); return g; };
const bone = (name) => { const b = new THREE.Bone(); b.name = name; return b; };

test("named mouth morph -> mode 'morph'", () => {
  assert.strictEqual(buildFacial(model(meshWithMorphs({ jawOpen: 0 })), null).mode, "morph");
});

test("no mouth channel -> mode 'none' (acknowledged, not faked)", () => {
  assert.strictEqual(buildFacial(model(meshWithMorphs(null, 0)), null).mode, "none");
});

test("jaw bone -> mode 'bones'", () => {
  assert.strictEqual(buildFacial(model(meshWithMorphs(null, 0), bone("Bip_Jaw")), null).mode, "bones");
});

test("valid index override -> mode 'morph'", () => {
  assert.strictEqual(buildFacial(model(meshWithMorphs(null, 3)), null, { mouthMorph: 0 }).mode, "morph");
});

test("NEGATIVE index override does NOT claim a working mouth (H3)", () => {
  // -1 < length is true on a typed array but writes a no-op expando — must be rejected.
  assert.strictEqual(buildFacial(model(meshWithMorphs(null, 3)), null, { mouthMorph: -1 }).mode, "none");
});

test("OUT-OF-RANGE index override does NOT claim a working mouth (H2)", () => {
  assert.strictEqual(buildFacial(model(meshWithMorphs(null, 3)), null, { mouthMorph: 99 }).mode, "none");
});

test("FRACTIONAL index override is rejected (H3)", () => {
  assert.strictEqual(buildFacial(model(meshWithMorphs(null, 3)), null, { mouthMorph: 2.5 }).mode, "none");
});
