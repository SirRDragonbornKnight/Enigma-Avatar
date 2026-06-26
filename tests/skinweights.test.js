// skinweights.test.js — the trust-the-WEIGHTS pass: per-bone skin-weight mass, parallel-twin
// detection (the Rigify control/ORG/DEF disease, generalized), and the adoption/dedup geometry.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { computeWeightMass, subtreeMass, coincident, findRoleTwins, groupCoincidentRoots } from "../skinweights.js";

const bone = (name, pos) => { const b = new THREE.Bone(); b.name = name; b.position.set(...pos); return b; };

// A skinned rig with TWO coincident parallel leg chains (A_* = the "driven" chain a role resolves
// to, B_* = the deforming twin rooted beside it — constraints baked away). Verts weight 0.6/0.4
// across each twin pair, like a real blended export.
function parallelLegRig() {
  const root = bone("Root", [0, 2, 0]);
  const oT = bone("A_thigh", [0.2, 0, 0]), oS = bone("A_shin", [0, -0.8, 0]), oF = bone("A_foot", [0, -0.8, 0]);
  oT.add(oS); oS.add(oF); root.add(oT);
  const dT = bone("B_thigh", [0.2, 0, 0]), dS = bone("B_shin", [0, -0.8, 0]), dF = bone("B_foot", [0, -0.8, 0]);
  dT.add(dS); dS.add(dF); root.add(dT);
  const bones = [root, oT, oS, oF, dT, dS, dF];
  const g = new THREE.BufferGeometry();
  const verts = 9;                                       // 3 verts per joint pair (thigh/shin/foot)
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  const si = new Uint16Array(verts * 4), sw = new Float32Array(verts * 4);
  for (let i = 0; i < verts; i++) {
    const pair = (i % 3) + 1;                            // 1=thigh 2=shin 3=foot (A side), +3 = B side
    si[i * 4] = pair; si[i * 4 + 1] = pair + 3;
    sw[i * 4] = 0.6; sw[i * 4 + 1] = 0.4;
  }
  g.setAttribute("skinIndex", new THREE.BufferAttribute(si, 4));
  g.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
  mesh.add(root);
  mesh.updateWorldMatrix(true, true);
  mesh.bind(new THREE.Skeleton(bones));
  const scene = new THREE.Group(); scene.add(mesh);
  scene.updateWorldMatrix(true, true);
  return { scene, root, oT, oS, oF, dT, dS, dF };
}

test("computeWeightMass reads real per-bone influence; control bones read zero", () => {
  const r = parallelLegRig();
  const mass = computeWeightMass(r.scene);
  assert.ok((mass.get(r.oT) || 0) > (mass.get(r.dT) || 0), "the 0.6 side outweighs the 0.4 side");
  assert.ok(Math.abs(mass.get(r.oT) - 1.8) < 1e-6 && Math.abs(mass.get(r.dT) - 1.2) < 1e-6, "exact masses (3 verts x weight)");
  assert.equal(mass.get(r.root) || 0, 0, "the unweighted root deforms nothing");
  assert.ok(Math.abs(subtreeMass(r.oT, mass) - 3 * 1.8) < 1e-6, "subtree mass sums the chain");
});

test("coincident: same head + same direction = twin; offset or rotated = not", () => {
  const r = parallelLegRig();
  assert.ok(coincident(r.oT, r.dT, 0.06), "parallel twins are coincident");
  assert.ok(!coincident(r.oT, r.oS, 0.06), "different joints are not");
  const rot = bone("Rotated", [0.2, 0, 0]); rot.add(bone("RotChild", [0.8, 0, 0]));   // same head, direction 90° off
  r.root.add(rot); r.scene.updateWorldMatrix(true, true);
  assert.ok(!coincident(r.oT, rot, 0.06), "same head but different direction is NOT a twin");
});

test("findRoleTwins finds every stranded deforming twin; adoption makes it idempotent", () => {
  const r = parallelLegRig();
  const mass = computeWeightMass(r.scene);
  const roles = { left_leg: r.oT, left_shin: r.oS, left_foot: r.oF };
  const twins = findRoleTwins(roles, mass, 2.4);
  assert.equal(twins.length, 3, "thigh+shin+foot twins all found");
  const before = r.dT.getWorldPosition(new THREE.Vector3());
  for (const { bone: R, twin } of twins) R.attach(twin);   // what avatar.js does
  r.scene.updateWorldMatrix(true, true);
  assert.equal(r.dT.parent, r.oT, "twin rides the role bone now");
  assert.ok(r.dT.getWorldPosition(new THREE.Vector3()).distanceTo(before) < 1e-6, "attach preserved the world position");
  assert.equal(findRoleTwins(roles, mass, 2.4).length, 0, "second pass finds nothing (twins now inside the subtrees)");
});

test("groupCoincidentRoots groups parallel sprung chains; lone chains stay alone", () => {
  const r = parallelLegRig();
  const lone = bone("Tail", [0, 0.5, 1]); r.root.add(lone); r.scene.updateWorldMatrix(true, true);
  const groups = groupCoincidentRoots([r.oT, r.dT, lone], 2.4);
  assert.equal(groups.length, 1, "one coincident group");
  assert.equal(groups[0].length, 2, "the twin pair grouped; the lone tail is not in any group");
});
