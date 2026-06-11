// physics.test.js — the rapier rigid-body adoption (§E): prove the engine loads headless (its
// WASM is inlined — works offline under plain node) and behaves like physics: a dropped ball
// falls, BOUNCES on the floor (restitution), and comes to rest ON the floor line, in-plane.
import { test } from "node:test";
import assert from "node:assert/strict";
import RAPIER from "@dimforge/rapier3d-compat";

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
