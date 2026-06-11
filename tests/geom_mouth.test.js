// geom_mouth.test.js — locks the GEOMETRIC mouth detector (geom_mouth.js) the same way
// realmodels.test.js locks the rig cascade. Pure three.js geometry, no WebGL — so it runs
// headless under `node --test`. Verifies: it picks the morph that drops HEAD-region verts
// downward (a jaw open), returns null (acknowledges "no mouth") when nothing does, and works
// at LOW morph counts (the case where a median gate false-rejected — see the near-equal gate).
import { test } from "node:test";
import assert from "node:assert";
import * as THREE from "three";
import { detectMouthMorph } from "../geom_mouth.js";

// model = Group → Mesh with morph targets over a vertical vertex column (y 0..1).
// detectMouthMorph's headCut = maxY - 0.35*H = 0.65, so verts with y >= ~0.67 are "head".
function makeModel(morphDeltas) {
  const n = 12;
  const base = [];
  for (let i = 0; i < n; i++) base.push(0, i / (n - 1), 0);   // y: 0 .. 1
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(base, 3));
  geom.morphAttributes.position = morphDeltas.map((d) => new THREE.Float32BufferAttribute(d, 3));
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
  mesh.morphTargetInfluences = morphDeltas.map(() => 0);
  const g = new THREE.Group(); g.add(mesh);
  return g;
}
const N = 12;
const moveY = (pred, dy) => { const a = []; for (let i = 0; i < N; i++) a.push(0, pred(i / (N - 1)) ? dy : 0, 0); return a; };

test("picks the morph that drops HEAD-region verts downward (a jaw drop)", () => {
  const head = moveY((y) => y >= 0.7, -0.1);   // morph 0: head verts move DOWN → the MOUTH
  const body = moveY((y) => y <= 0.3, -0.1);   // morph 1: body verts move down → below headCut, ignored
  const r = detectMouthMorph(makeModel([head, body]));
  assert.ok(r, "should detect a mouth morph");
  assert.strictEqual(r.index, 0, "morph 0 (head jaw-drop) is the mouth");
  assert.ok(r.mesh, "returns the winning mesh so the driver moves only that mesh");
});

test("returns null when no morph drops the head — acknowledge 'no mouth', never fake", () => {
  const headUp = moveY((y) => y >= 0.7, +0.1);   // head verts move UP — not a jaw drop
  assert.strictEqual(detectMouthMorph(makeModel([headUp])), null);
});

test("returns null for a model with no morph targets", () => {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0], 3));
  const g = new THREE.Group(); g.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial()));
  assert.strictEqual(detectMouthMorph(g), null);
});

test("works at LOW morph count (near-equal gate, not a median gate)", () => {
  // exactly 2 morphs: one head jaw-drop + one empty. A median-based gate false-rejected this.
  const head = moveY((y) => y >= 0.7, -0.1);
  const empty = new Array(N * 3).fill(0);
  const r = detectMouthMorph(makeModel([head, empty]));
  assert.ok(r && r.index === 0, "2-morph model still resolves morph 0");
});
