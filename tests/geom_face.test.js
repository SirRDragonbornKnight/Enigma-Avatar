// geom_face.test.js — locks the geometric face classifier (geom_face.js) the way
// geom_mouth.test.js locks the mouth detector: pure three.js BufferGeometry, no WebGL, runs
// headless under `node --test`. Fixtures are a synthetic quad-grid "head" with a head Bone at
// a KNOWN position and hand-authored morph deltas, so every band/lobe/direction number in the
// classifier is pinned by construction rather than by a model file.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { analyzeMorphGeometry } from "../geom_face.js";

// Grid head plane: x −0.5..+0.5, y 1..2 in local space (head bone at y=1 → span = 1.0). With
// the default bands that puts EYES at y≈1.62 (band 1.44..1.80) and MOUTH at y≈1.25 (1.07..1.43).
const NX = 21, NY = 21, STEP = 0.05;
function gridBase() {
  const a = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) a.push(-0.5 + i * STEP, 1 + j * STEP, 0);
  return a;
}
function gridDelta(pred, dx, dy, dz) {
  const a = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const on = pred(-0.5 + i * STEP, 1 + j * STEP);
    a.push(on ? dx : 0, on ? dy : 0, on ? dz : 0);
  }
  return a;
}
function meshOf(name, verts, morphFlats) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  if (morphFlats) {
    g.morphAttributes.position = morphFlats.map((d) => new THREE.Float32BufferAttribute(d, 3));
    g.morphTargetsRelative = true;   // author DELTAS like GLTFLoader does — the engine's real input shape
  }
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  m.name = name;
  return m;
}
function makeModel(deltas, extraMeshes = []) {
  const head = new THREE.Bone();
  head.position.set(0, 1, 0);        // head bone at the grid's base row → head→top span = 1.0
  const root = new THREE.Group();
  root.add(meshOf("face", gridBase(), deltas), head, ...extraMeshes);
  root.position.set(3, 0.5, -2);     // whole rig OFF the world origin — proves head-ANCHORED math, not origin luck
  root.updateWorldMatrix(true, true);
  return { root, head };
}
const OPTS = (head) => ({ head, bodyUp: new THREE.Vector3(0, 1, 0), forward: new THREE.Vector3(0, 0, 1) });
const near = (v, want, eps, msg) => assert.ok(Math.abs(v - want) <= eps, `${msg}: ${v} !~ ${want}`);

// Canonical morphs; bounds carry ±0.001 slop so float grid coords select exact rows/columns.
const blink = () => gridDelta((x, y) => Math.abs(x) >= 0.149 && Math.abs(x) <= 0.351 && y >= 1.57 && y <= 1.67, 0, -0.05, 0);  // two lateral lobes at eye height, moving DOWN
const mouthOpen = () => gridDelta((x, y) => Math.abs(x) <= 0.07 && y >= 1.19 && y <= 1.31, 0, -0.06, 0);                       // midline blob in the lower band, moving DOWN
const noise = () => gridDelta(() => true, 0.02, 0, 0.02);                                                                      // whole head drifts sideways/forward uniformly

test("blink-like morph (mirrored lateral lobes at eye height, displacing down) tops `eyes`", () => {
  const { root, head } = makeModel([blink(), mouthOpen(), noise()]);
  const r = analyzeMorphGeometry(root, OPTS(head));
  assert.strictEqual(r.eyes[0], 0, "blink ranks first in eyes");
  assert.ok(r.byIndex.get(0).eyeScore > 0.5, "confident eye score");
  const e = r.morphs.find((m) => m.index === 0 && m.meshName === "face");
  assert.strictEqual(e.mirrored, true, "two mirrored lobes detected");
  assert.strictEqual(e.support, 20, "support = exactly the authored lobe verts");
  near(e.centroidLocal[1], 0.62, 0.05, "support centroid sits at eye height above the head bone");
  near(e.centroidLocal[0], 0, 0.02, "mirrored lobes cancel at the midline");
  assert.ok(e.dir[1] < -0.95, "mean displacement points DOWN (lid closing)");
  assert.ok(r.byIndex.get(0).mouthScore < 0.1, "a blink is not a mouth");
});

test("mouth-open morph (midline lower-band support, displacing down) tops `mouth`", () => {
  const { root, head } = makeModel([blink(), mouthOpen(), noise()]);
  const r = analyzeMorphGeometry(root, OPTS(head));
  assert.strictEqual(r.mouth[0], 1, "mouth-open ranks first in mouth");
  assert.ok(r.byIndex.get(1).mouthScore > 0.5, "confident mouth score");
  const e = r.morphs.find((m) => m.index === 1 && m.meshName === "face");
  near(e.centroidLocal[1], 0.25, 0.05, "support centroid sits at mouth height");
  assert.strictEqual(e.mirrored, false, "a centered blob is NOT two lobes");
  assert.ok(r.byIndex.get(1).eyeScore < 0.1, "a jaw drop is not a blink");
});

test("uniform whole-head noise morph scores low on BOTH channels", () => {
  const { root, head } = makeModel([blink(), mouthOpen(), noise()]);
  const r = analyzeMorphGeometry(root, OPTS(head));
  const s = r.byIndex.get(2);
  assert.ok(s.eyeScore < 0.3, `noise eyeScore stays low (${s.eyeScore})`);
  assert.ok(s.mouthScore < 0.3, `noise mouthScore stays low (${s.mouthScore})`);
  assert.notStrictEqual(r.eyes[0], 2, "...and never outranks the real blink");
  assert.notStrictEqual(r.mouth[0], 2, "...or the real mouth");
});

test("one-sided wink pair earns `mirrored` through TWIN detection; a lone half does not", () => {
  const winkL = gridDelta((x, y) => x <= -0.149 && x >= -0.351 && y >= 1.57 && y <= 1.67, 0, -0.05, 0);
  const winkR = gridDelta((x, y) => x >= 0.149 && x <= 0.351 && y >= 1.57 && y <= 1.67, 0, -0.05, 0);
  const pair = makeModel([winkL, winkR]);
  const rp = analyzeMorphGeometry(pair.root, OPTS(pair.head));
  assert.ok(rp.morphs.every((m) => m.mirrored), "both wink halves marked mirrored via the twin");
  assert.ok(rp.byIndex.get(0).eyeScore > 0.5 && rp.byIndex.get(1).eyeScore > 0.5, "both rank as blink candidates");
  assert.deepEqual([...rp.eyes].sort(), [0, 1], "both halves land in the eyes ranking");
  const lone = makeModel([winkL]);   // same lobe with NO twin → still a candidate, just penalized + unmirrored
  const rl = analyzeMorphGeometry(lone.root, OPTS(lone.head));
  assert.strictEqual(rl.morphs[0].mirrored, false, "no twin, no second lobe → not mirrored");
  assert.ok(rl.byIndex.get(0).eyeScore < rp.byIndex.get(0).eyeScore, "lone half ranks under the twinned pair");
});

test("no head bone → empty rankings, never a throw", () => {
  const { root } = makeModel([blink()]);
  const r = analyzeMorphGeometry(root, { head: null, bodyUp: new THREE.Vector3(0, 1, 0), forward: new THREE.Vector3(0, 0, 1) });
  assert.deepEqual(r.eyes, []);
  assert.deepEqual(r.mouth, []);
  assert.deepEqual(r.morphs, []);
  assert.strictEqual(r.byIndex.size, 0);
});

test("byIndex merges same-index morphs across meshes by MAX; bad/zero meshes are skipped", () => {
  // lash strip: same morph index 0 as the face mesh but ZERO deltas (the zero-support edge).
  const lash = meshOf("lash", [-0.25, 1.62, 0, 0, 1.62, 0, 0.25, 1.62, 0], [new Array(9).fill(0)]);
  // broken: morph vert count ≠ position vert count → the whole mesh is skipped, never crashes.
  const broken = meshOf("broken", [0, 1, 0, 0.1, 1, 0, 0, 1.1, 0, 0.1, 1.1, 0], [new Array(9).fill(0.5)]);
  const bare = meshOf("bare", [0, 0.2, 0, 0, 1.9, 0], null);   // morphless mesh: span donor only
  const { root, head } = makeModel([blink()], [lash, broken, bare]);
  const r = analyzeMorphGeometry(root, OPTS(head));
  assert.deepEqual(r.morphs.map((m) => m.meshName).sort(), ["face", "lash"], "broken + bare meshes contribute no entries");
  const zero = r.morphs.find((m) => m.meshName === "lash");
  assert.strictEqual(zero.support, 0, "zero-delta morph reports zero support");
  assert.strictEqual(zero.eyeScore, 0, "...and scores nothing");
  assert.ok(r.byIndex.size === 1 && r.byIndex.get(0).eyeScore > 0.5, "merged logical morph keeps the face mesh's MAX score");
  assert.deepEqual(r.eyes, [0], "one logical candidate, not one per mesh");
});
