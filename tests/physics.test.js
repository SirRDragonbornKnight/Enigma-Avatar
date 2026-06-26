// physics.test.js — the rapier rigid-body adoption (§E): prove the engine loads headless (its
// WASM is inlined — works offline under plain node) and behaves like physics: a dropped ball
// falls, BOUNCES on the floor (restitution), and comes to rest ON the floor line, in-plane.
import { test } from "node:test";
import assert from "node:assert/strict";
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { createPhysics } from "../physics.js";

test("rapier: a dropped ball falls, bounces, and settles on the floor", async () => {
  await RAPIER.init({});
  const world = new RAPIER.World({ x: 0, y: -14, z: 0 });
  const floorY = -3;
  const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, floorY - 0.5, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 50).setRestitution(0.4).setFriction(0.55), floor);
  const r = 0.17;
  const ball = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2, 0).setLinvel(3, 0, 0));
  ball.setEnabledTranslations(true, true, false, true);   // the overlay keeps toys in the 2D screen plane
  world.createCollider(RAPIER.ColliderDesc.ball(r).setRestitution(0.62).setFriction(0.45).setDensity(1.2), ball);

  world.timestep = 1 / 60;
  let minY = Infinity, bounced = false, wasFalling = false;
  for (let i = 0; i < 60 * 6; i++) {
    world.step();
    const v = ball.linvel(), t = ball.translation();
    minY = Math.min(minY, t.y);
    if (v.y < -1) wasFalling = true;
    if (wasFalling && v.y > 0.5) bounced = true;          // it hit the floor and came back UP
    assert.ok(Math.abs(t.z) < 1e-6, "stays in the screen plane (z locked)");
  }
  const t = ball.translation();
  assert.ok(bounced, "the ball bounced (restitution works)");
  assert.ok(minY > floorY - 0.05, `never tunneled through the floor (minY ${minY.toFixed(3)})`);
  assert.ok(Math.abs(t.y - (floorY + r)) < 0.05, `at rest ON the floor line (y ${t.y.toFixed(3)} ≈ ${(floorY + r).toFixed(3)})`);
  assert.ok(t.x > 0.5, "rolled/travelled with its throw velocity");
});

test("rapier: a ball dropped onto HER body capsule hits it and deflects off (she's a solid rounded body)", async () => {
  await RAPIER.init({});
  const world = new RAPIER.World({ x: 0, y: -14, z: 0 });
  const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -3.5, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 50).setRestitution(0.3), floor);
  // a kinematic capsule standing at the origin = her body (half-height 0.7, radius 0.25, top ≈ y 0.95)
  const her = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 0));
  world.createCollider(RAPIER.ColliderDesc.capsule(0.7, 0.25).setRestitution(0.45).setFriction(0.6), her);
  const startX = 0.06;
  const ball = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(startX, 2.2, 0));   // dropped just off-centre onto her
  ball.setEnabledTranslations(true, true, false, true);
  world.createCollider(RAPIER.ColliderDesc.ball(0.16).setRestitution(0.6).setDensity(1.2), ball);

  world.timestep = 1 / 120;
  let hitHer = false, falling = false, tunneled = false;
  for (let i = 0; i < 120 * 5; i++) {
    her.setNextKinematicTranslation({ x: 0, y: 0, z: 0 });   // ticked every step (as setAvatar does live) → stays an active obstacle
    world.step();
    const v = ball.linvel(), t = ball.translation();
    if (v.y < -1) falling = true;
    if (falling && v.y > 0.3) hitHer = true;                 // bounced UP after falling = a real contact with her body
    if (Math.abs(t.x) < 0.30 && t.y < -0.95 && t.y > -3.0) tunneled = true;   // passed straight DOWN through the capsule's volume
  }
  assert.ok(hitHer, "the ball made contact with her body (deflected up off the capsule)");
  assert.ok(!tunneled, "the ball never passed straight through her body volume");
  assert.ok(Math.abs(ball.translation().x) > 0.30, "the off-centre drop ROLLED OFF her body to the side (a rounded solid), didn't pass through");
});

// The multi-monitor fix: physics props live ONLY in the brain (primary) window's scene, so when she's
// parked on another monitor the ball spawned off-screen — "drop ball does not work." The brain now
// serializes each prop RELATIVE to her root and broadcasts it; peers render ghost copies hung off
// THEIR copy of her root. This proves the serialization is root-relative (hence portable to any peer).
test("physics: serializeProps packs each prop relative to her root (peers ghost the ball on her monitor)", async () => {
  const scene = new THREE.Scene();
  const loadAsset = (url, onOk) => { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))); onOk({ scene: g }); };
  const physics = createPhysics({ scene, loadAsset });
  await physics.throwProp("ball.glb", { x: 5, y: 3 }, { x: 0, y: 0 }, 0.4);
  physics.step(1 / 60);                                   // write the body→obj transform

  const buf = physics.serializeProps(5, 3);              // serialize relative to her root, placed at the spawn point
  assert.equal(buf.length, 1 + 7, "one prop → [count, dx,dy,qx,qy,qz,qw,scale]");
  assert.equal(buf[0], 1, "count = 1");
  assert.ok(Math.abs(buf[1]) < 0.2, `dx ≈ 0 (spawned at her root x) — got ${buf[1].toFixed(3)}`);
  assert.ok(buf[7] > 0, `prop scale is positive — got ${buf[7].toFixed(3)}`);

  const buf0 = physics.serializeProps(0, 0);             // a DIFFERENT root (another monitor) → the offset shifts by exactly the root delta
  assert.ok(Math.abs((buf0[1] - buf[1]) - 5) < 1e-4, "dx is root-relative → portable across displays of any size");

  physics.clearProps();
  assert.equal(physics.serializeProps(0, 0)[0], 0, "after clear → 0 props (peers drop their ghosts)");
});

// A tiny box prop loader (no GLB I/O) for the createPhysics-level tests below.
function boxLoader(url, onOk) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
  onOk({ scene: g });
}

// #30 TUNNELING: platform slabs are thin and there's no continuous collision detection, so a
// FAST thrown ball (vy up to ~5.8, dt clamped to 0.05) could pass straight through one in a single
// step. The fix enables CCD on thrown props (+ thicker slabs). It must REST on top, never below.
test("physics: a fast ball cannot tunnel a thin platform — CCD lands it on top", async () => {
  const scene = new THREE.Scene();
  const physics = createPhysics({ scene, loadAsset: boxLoader });

  const topY = 0, halfW = 5;
  physics.setPlatforms([{ x: 0, y: topY, halfW }]);
  await new Promise((r) => setTimeout(r, 0));               // setPlatforms is lazy → let the world build

  const r = 0.17;                                           // sizeWorld 0.34 → radius 0.17
  await physics.throwProp("ball.glb", { x: 0, y: 1.5 }, { x: 0, y: 5.8 }, 0.34);   // hurled UP fast, falls back onto the slab

  let minObjY = Infinity;
  for (let i = 0; i < 240; i++) {
    physics.step(0.05);                                     // worst-case big timestep (the clamp ceiling)
    minObjY = Math.min(minObjY, scene.children[scene.children.length - 1].position.y);
  }
  const restY = scene.children[scene.children.length - 1].position.y;
  assert.ok(minObjY > topY - r - 0.05, `never tunneled below the slab top (minY ${minObjY.toFixed(3)} > ${(topY - r).toFixed(3)})`);
  assert.ok(Math.abs(restY - (topY + r)) < 0.06, `rests ON the platform top (y ${restY.toFixed(3)} ~= ${(topY + r).toFixed(3)})`);
});

// #36 MULTI-PROP: two balls spawned overlapping must PUSH APART (solid bodies don't co-occupy),
// and clearProps must leave the world with zero dangling prop bodies.
test("physics: overlapping props separate, and clearProps leaves no dangling bodies", async () => {
  const scene = new THREE.Scene();
  const physics = createPhysics({ scene, loadAsset: boxLoader });

  const r = 0.2, floorY = -3;                               // sizeWorld 0.4 → radius 0.2
  physics.setFloor(floorY);
  await physics.throwProp("ball.glb", { x: 0.00, y: 0 }, { x: 0, y: 0 }, 0.4);
  await physics.throwProp("ball.glb", { x: 0.05, y: 0 }, { x: 0, y: 0 }, 0.4);   // overlapping the first (gap < 2r)
  assert.equal(physics.count(), 2, "two props spawned");

  for (let i = 0; i < 300; i++) physics.step(1 / 120);

  const a = scene.children[scene.children.length - 2].position;
  const b = scene.children[scene.children.length - 1].position;
  const sep = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(sep > 2 * r - 0.02, `centres separated to > 2r (sep ${sep.toFixed(3)} > ${(2 * r).toFixed(3)})`);

  physics.clearProps();
  assert.equal(physics.count(), 0, "clearProps removed every prop");
  assert.equal(physics.serializeProps(0, 0)[0], 0, "world consistent — no dangling prop bodies");
});

// #37 GRAVITY-vs-FLOOR CONTRACT: with a floor at yF, a thrown ball must come to rest at ~yF + r,
// and the by-numbers diagnostic must report the live gravity vector + floor line.
test("physics: gravity-vs-floor contract — ball rests at floorY + r; diag() reports the numbers", async () => {
  const scene = new THREE.Scene();
  const physics = createPhysics({ scene, loadAsset: boxLoader });

  const yF = -2.0, r = 0.17;
  physics.setFloor(yF);
  await physics.throwProp("ball.glb", { x: 0, y: 1.5 }, { x: 0, y: 0 }, 0.34);
  for (let i = 0; i < 360; i++) physics.step(1 / 120);

  const restY = scene.children[scene.children.length - 1].position.y;
  assert.ok(Math.abs(restY - (yF + r)) < 0.06, `rests at floorY + r (y ${restY.toFixed(3)} ~= ${(yF + r).toFixed(3)})`);

  const d = physics.diag();
  assert.equal(d.floorY, yF, "diag reports the live floor line");
  assert.ok(d.gravity.y < 0, `diag reports a downward gravity vector (y ${d.gravity.y})`);
});
