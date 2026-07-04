// softmesh.test.js — the soft-mesh stretch layer (grab/pull/spring-back/poke), pure three.js,
// headless. Locks the contract: falloff shape, the tanh rubber limit, the jelly spring, vertex
// claim exclusivity, and above all BIT-EXACT restore — a released grab must leave NO trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildSoftMesh, falloffW, saturate, springStep } from "../src/motion/softmesh.js";

test("falloffW: 1 at the grab point, 0 at the rim, monotone between", () => {
  assert.equal(falloffW(0, 1), 1);
  assert.equal(falloffW(1, 1), 0);
  assert.equal(falloffW(2, 1), 0);
  let prev = 1;
  for (let d = 0.1; d < 1; d += 0.1) {
    const w = falloffW(d, 1);
    assert.ok(w < prev && w > 0, `monotone decreasing (${d.toFixed(1)} -> ${w.toFixed(3)})`);
    prev = w;
  }
  assert.equal(falloffW(0.5, 0), 0, "degenerate radius -> 0, never NaN");
});

test("saturate: ~linear for small pulls, capped below max for huge ones (the rubber limit)", () => {
  assert.ok(Math.abs(saturate(0.01, 1) - 0.01) < 1e-4, "small pull passes ~unchanged");
  assert.ok(saturate(100, 1) <= 1, "a huge pull NEVER exceeds max (tanh rounds to exactly 1.0 in float64)");
  assert.ok(saturate(100, 1) > 0.99, "...and asymptotes to it");
  assert.ok(saturate(2, 1) < 1, "a finite over-pull stays strictly below max");
  assert.equal(saturate(1, 0), 0, "zero max -> zero, never NaN");
});

test("springStep: underdamped jelly — overshoots zero at least once, then converges to rest", () => {
  const s = { amp: 1, vel: 0 };
  let overshot = false;
  for (let i = 0; i < 600; i++) {
    springStep(s, 1 / 60);
    if (s.amp < 0) overshot = true;
  }
  assert.ok(overshot, "the spring overshoots (that IS the jelly wobble)");
  assert.ok(Math.abs(s.amp) < 1e-3 && Math.abs(s.vel) < 1e-2, `and settles (amp ${s.amp}, vel ${s.vel})`);
});

// ---- end-to-end on a real SkinnedMesh ----------------------------------------------------------
function skinnedBox() {
  const geo = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
  const n = geo.attributes.position.count;
  const si = [],
    sw = [];
  for (let i = 0; i < n; i++) {
    si.push(0, 0, 0, 0);
    sw.push(1, 0, 0, 0);
  }
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
  const bone = new THREE.Bone();
  bone.name = "grabme";
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  const g = new THREE.Group();
  g.add(mesh);
  g.updateMatrixWorld(true);
  return { g, mesh, bone };
}
const posCopy = (mesh) => Float32Array.from(mesh.geometry.attributes.position.array);

test("grab pulls the region, release springs back to BIT-EXACT rest and forgets the grab", () => {
  const { g, mesh, bone } = skinnedBox();
  const pristine = posCopy(mesh);
  const soft = buildSoftMesh(g);
  assert.equal(soft.meshCount, 1);
  const r = soft.grab(bone, { radius: 2, pull: [0.5, 0, 0] });
  assert.ok(!r.error && r.verts > 0, `grab claims vertices (${JSON.stringify(r)})`);
  assert.ok(r.applied <= r.pull + 1e-9, "applied never exceeds the asked pull (tanh limit)");
  for (let i = 0; i < 60; i++) soft.update(1 / 60);
  const held = posCopy(mesh);
  let moved = 0;
  for (let i = 0; i < held.length; i += 3) if (held[i] !== pristine[i]) moved++;
  assert.ok(moved > 0, `held grab displaces vertices (+x; ${moved} moved)`);
  soft.release(true);
  for (let i = 0; i < 900; i++) soft.update(1 / 60); // let the jelly settle fully
  assert.deepEqual(posCopy(mesh), pristine, "geometry restored BIT-EXACTLY after release");
  assert.equal(soft.list().length, 0, "settled grab is forgotten");
});

test("poke presses instantly, then wobbles back to pristine on its own (no release needed)", () => {
  const { g, mesh, bone } = skinnedBox();
  const pristine = posCopy(mesh);
  const soft = buildSoftMesh(g);
  const r = soft.poke(bone, { radius: 2, amount: -0.3 }); // dent IN
  assert.ok(!r.error && r.verts > 0, `poke lands (${JSON.stringify(r)})`);
  assert.notDeepEqual(posCopy(mesh), pristine, "the dent is visible immediately");
  for (let i = 0; i < 900; i++) soft.update(1 / 60);
  assert.deepEqual(posCopy(mesh), pristine, "poke self-restores bit-exactly");
});

test("claimed vertices are exclusive: an overlapping second grab gets an honest error, not chaos", () => {
  const { g, bone } = skinnedBox();
  const soft = buildSoftMesh(g);
  assert.ok(!soft.grab(bone, { radius: 2, pull: [0.2, 0, 0] }).error, "first grab lands");
  const second = soft.grab(bone, { radius: 2, pull: [0, 0.2, 0] });
  assert.ok(second.error, `overlapping grab is refused by claim exclusivity (${JSON.stringify(second)})`);
});

test("guards: garbage pull / unknown bone / no skinned meshes all answer with named errors", () => {
  const { g, bone } = skinnedBox();
  const soft = buildSoftMesh(g);
  assert.ok(soft.grab(bone, { pull: [NaN, 0, 0] }).error, "non-finite pull refused");
  assert.ok(soft.grab(null, { pull: [1, 0, 0] }).error, "missing bone refused");
  assert.ok(soft.poke(bone, { amount: 0 }).error, "zero poke refused");
  const empty = buildSoftMesh(new THREE.Group());
  assert.ok(empty.grab(bone, { pull: [1, 0, 0] }).error, "no soft meshes -> honest error");
});

// ---- audit 2026-07-04 regressions ---------------------------------------------------------------

test("a short pull array is REFUSED, never NaN into the mesh (audit: hypot(undefined))", () => {
  const { g, mesh, bone } = skinnedBox();
  const pristine = posCopy(mesh);
  const soft = buildSoftMesh(g);
  for (const bad of [[0.3], [0.3, 0.1], [1, 2, 3, 4], "0.3,0,0"]) {
    const r = soft.grab(bone, { radius: 2, pull: bad });
    assert.ok(r.error, `pull ${JSON.stringify(bad)} -> named error (${JSON.stringify(r)})`);
  }
  for (let i = 0; i < 30; i++) soft.update(1 / 60);
  assert.deepEqual(posCopy(mesh), pristine, "refused pulls left the geometry untouched");
});

test("radius is calibrated in BIND units — normalization scale must not change what a grab selects", () => {
  // Same mesh, but the model root is display-normalized 4x (what avatar.js always does).
  // The default radius must stay a fraction of the BIND-frame body, not the world box.
  const { g, bone } = skinnedBox();
  g.scale.setScalar(4);
  g.updateMatrixWorld(true);
  const soft = buildSoftMesh(g);
  const r = soft.grab(bone, {}); // default radius; box verts sit >=0.5 from the bone in bind units
  assert.ok(
    r.error && /0\.080/.test(r.error),
    `default radius = 8% of the BIND body (~0.080), not of the scaled world box (0.320): ${JSON.stringify(r)}`
  );
  const ok = soft.grab(bone, { radius: 2, pull: [0.2, 0, 0] });
  assert.ok(!ok.error && ok.verts > 0, "an explicit bind-unit radius selects normally under any display scale");
});

function skinnedStrip(nBones, spacing = 10) {
  // nBones clusters of vertices, each skinned to its own bone at x = i*spacing -> disjoint grab regions
  const pos = [],
    si = [],
    sw = [];
  for (let b = 0; b < nBones; b++)
    for (const [dx, dy, dz] of [
      [0.1, 0, 0],
      [-0.1, 0, 0],
      [0, 0.1, 0],
    ]) {
      pos.push(b * spacing + dx, dy, dz);
      si.push(b, 0, 0, 0);
      sw.push(1, 0, 0, 0);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
  const bones = [];
  for (let b = 0; b < nBones; b++) {
    const bn = new THREE.Bone();
    bn.name = "b" + b;
    bn.position.set(b * spacing, 0, 0);
    bones.push(bn);
  }
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  mesh.add(bones[0]);
  for (let b = 1; b < nBones; b++) bones[0].add(bones[b]); // flat-ish chain; world = local offsets
  const g = new THREE.Group();
  g.add(mesh);
  g.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones)); // bind AFTER world update -> boneInverses carry each bone's true position
  return { g, mesh, bones };
}

test("the max-8 cap fires for EVERY new grab — a fresh driver id cannot bypass it (audit)", () => {
  const { g, bones } = skinnedStrip(10);
  const soft = buildSoftMesh(g);
  for (let i = 0; i < 8; i++)
    assert.ok(!soft.grab(bones[i], { radius: 1, pull: [0.05, 0, 0], id: "drv" + i }).error, `grab ${i} lands`);
  const ninth = soft.grab(bones[8], { radius: 1, pull: [0.05, 0, 0], id: "drv8" });
  assert.ok(/max 8/.test(ninth.error || ""), `9th NEW grab refused even with a fresh id (${JSON.stringify(ninth)})`);
  const reAim = soft.grab(bones[3], { id: "drv3", pull: [0, 0.05, 0] });
  assert.ok(!reAim.error, "re-aiming an EXISTING id still works at the cap");
});

test("auto ids never collide with driver-chosen ids (audit: 'g1' collision orphaned the old grab)", () => {
  const { g, mesh, bones } = skinnedStrip(3);
  const pristine = posCopy(mesh);
  const soft = buildSoftMesh(g);
  assert.ok(!soft.grab(bones[0], { radius: 1, pull: [0.08, 0, 0], id: "g1" }).error, "driver grab 'g1' lands");
  const auto = soft.grab(bones[1], { radius: 1, pull: [0.08, 0, 0] });
  assert.ok(!auto.error && auto.grabbed !== "g1", `auto id skipped the taken name (${auto.grabbed})`);
  assert.equal(soft.list().length, 2, "both grabs tracked — nothing overwritten");
  soft.release(true);
  for (let i = 0; i < 900; i++) soft.update(1 / 60);
  assert.deepEqual(posCopy(mesh), pristine, "both restore bit-exactly (no orphaned displacement)");
});

test("poke on a mesh without vertex normals is an honest error, not a +Z shove (audit)", () => {
  const { g, mesh, bones } = skinnedStrip(1);
  mesh.geometry.deleteAttribute("normal"); // legal glTF: normals are optional
  const pristine = posCopy(mesh);
  const soft = buildSoftMesh(g);
  const r = soft.poke(bones[0], { radius: 1, amount: -0.2 });
  assert.ok(/normals/.test(r.error || ""), `named error (${JSON.stringify(r)})`);
  assert.deepEqual(posCopy(mesh), pristine, "geometry untouched");
});
