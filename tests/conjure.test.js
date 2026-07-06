// P3 conjure — both the pure cartoon math (poof scale + hover) AND the conjure STATE MACHINE
// (createConjure: spawn / glide / follow-a-hand / dismiss / auto-expire / clear). The state-machine
// tests inject stub deps (scene / loadAsset / getBoneWorld) so they run headless, and assert WHAT
// WE WANT (an object appears, tracks the hand, poofs out on dismiss) — not the code's internals.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { popScale, floatBob } from "../src/motion/motionmath.js";
import { createConjure } from "../src/motion/conjure.js";

// ---- the cartoon FEEL math the conjure uses ----
test("popScale: 0 at p=0, 1 at p=1", () => {
  assert.ok(Math.abs(popScale(0) - 0) < 1e-9, "starts at 0 (invisible)");
  assert.ok(Math.abs(popScale(1) - 1) < 1e-9, "ends at full size");
});

test("popScale: overshoots past 1 for the cartoon pop", () => {
  let maxV = 0;
  for (let p = 0; p <= 1; p += 0.02) maxV = Math.max(maxV, popScale(p));
  assert.ok(maxV > 1.02, `pops past full size before settling (peak ${maxV.toFixed(3)})`);
});

test("popScale: clamps out-of-range input", () => {
  assert.ok(Math.abs(popScale(-1) - 0) < 1e-9, "below 0 clamps to 0");
  assert.ok(Math.abs(popScale(2) - 1) < 1e-9, "above 1 clamps to 1");
});

test("floatBob: oscillates around 0 within amplitude", () => {
  let mn = Infinity,
    mx = -Infinity;
  for (let t = 0; t < 6; t += 0.05) {
    const v = floatBob(t, 0.04);
    mn = Math.min(mn, v);
    mx = Math.max(mx, v);
  }
  assert.ok(mx <= 0.0401 && mn >= -0.0401, "stays within +/- amp");
  assert.ok(mx > 0.03 && mn < -0.03, "actually swings");
});

// ---- the conjure STATE MACHINE (the P3 behavior the AI drives) ----
// Stub harness: a scene that just tracks membership, a loadAsset whose completion we control
// (so we can test the load-race too), and a fixed "right_hand" world position.
function harness(opts = {}) {
  const members = new Set();
  const scene = { add: (o) => members.add(o), remove: (o) => members.delete(o) };
  const pending = [];
  const fakeAsset = () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    return { scene: root };
  };
  // queue BOTH outcomes; a url in opts.miss resolves through the error path when finishLoads() runs
  const miss = new Set(opts.miss || []);
  const loadAsset = (url, onLoad, onErr) => pending.push(() => (miss.has(url) ? onErr?.() : onLoad(fakeAsset())));
  const hand = new THREE.Vector3(1, 2, 3);
  const getBoneWorld = (name) => (name === "right_hand" ? hand.clone() : null);
  const missed = [];
  const conj = createConjure({ scene, loadAsset, getBoneWorld, onMiss: (u) => missed.push(u) });
  return {
    conj,
    members,
    finishLoads: () => {
      while (pending.length) pending.shift()();
    },
    hand,
    missed,
  };
}

test("spawn tracks the item immediately; it joins the scene only once the asset loads", () => {
  const { conj, members, finishLoads } = harness();
  conj.spawn("ball.glb");
  assert.equal(conj.count(), 1, "tracked the moment it is conjured");
  assert.equal(members.size, 0, "nothing in the scene until the GLB resolves");
  finishLoads();
  assert.equal(members.size, 1, "the loaded prop is added to the scene");
  assert.equal(conj.step(0.1), true, "step reports it alive");
});

test("dismiss poofs the prop OUT, then removes it from the scene", () => {
  const { conj, members, finishLoads } = harness();
  const id = conj.spawn("ball.glb");
  finishLoads();
  conj.dismiss(id);
  for (let i = 0; i < 12; i++) conj.step(0.05); // run past the poof (POP = 0.35s)
  assert.equal(conj.count(), 0, "gone after the poof completes");
  assert.equal(members.size, 0, "removed + disposed from the scene");
});

test("a timed conjure auto-dismisses after its dur", () => {
  const { conj, finishLoads } = harness();
  conj.spawn("ball.glb", { dur: 0.3 });
  finishLoads();
  for (let i = 0; i < 5; i++) conj.step(0.05); // t ~0.25 < dur -> still held
  assert.equal(conj.count(), 1, "present before dur elapses");
  for (let i = 0; i < 16; i++) conj.step(0.05); // past dur + the poof
  assert.equal(conj.count(), 0, "auto-dismissed after dur");
});

test("conjure-at-hand: a bone-bound prop tracks the hand's world position", () => {
  const { conj, members, finishLoads, hand } = harness();
  conj.spawn("ball.glb", { bone: "right_hand" });
  finishLoads();
  conj.step(0.4); // past the pop, into the hover/follow branch
  const obj = [...members][0];
  assert.ok(Math.abs(obj.position.x - hand.x) < 1e-6, "tracks the hand in x");
  assert.ok(Math.abs(obj.position.z - hand.z) < 1e-6, "tracks the hand in z");
  assert.ok(Math.abs(obj.position.y - hand.y) < 0.1, "rides the hand in y (only a gentle hover offset)");
});

test("moveTo GLIDES the prop to a target (interpolates through the middle, not a teleport)", () => {
  const { conj, members, finishLoads } = harness();
  const id = conj.spawn("ball.glb");
  finishLoads();
  conj.step(0.4); // settle past the pop, sitting at home (~origin)
  assert.equal(conj.moveTo(id, { x: 6, y: 0, z: 0 }, { dur: 0.5 }), true, "accepts the move");
  const obj = [...members][0];
  conj.step(0.25); // ~halfway through the 0.5s glide
  const mid = obj.position.x;
  // the WHOLE point is a smooth glide: midway it must be PARTWAY there — not still at home (no glide)
  // and not already at the target (teleport). A broken lerp leaves it at ~0 and fails this.
  assert.ok(mid > 0.3 && mid < 5.7, `glides THROUGH the middle, not a teleport (x=${mid.toFixed(2)})`);
  for (let i = 0; i < 12; i++) conj.step(0.05); // finish the glide
  assert.ok(Math.abs(obj.position.x - 6) < 0.05, "and arrives at the target x");
});

test("clear removes every conjured prop at once", () => {
  const { conj, members, finishLoads } = harness();
  conj.spawn("a.glb");
  conj.spawn("b.glb");
  finishLoads();
  assert.equal(conj.count(), 2, "two props up");
  conj.clear();
  assert.equal(conj.count(), 0, "all cleared");
  assert.equal(members.size, 0, "scene emptied");
});

test("dismissing a still-loading prop just forgets it (no leak, no crash)", () => {
  const { conj, members, finishLoads } = harness();
  const id = conj.spawn("slow.glb"); // do NOT finish the load
  assert.equal(conj.dismiss(id), true, "dismiss accepted mid-load");
  assert.equal(conj.count(), 0, "dropped before it ever rendered");
  finishLoads(); // the late load must not resurrect it
  assert.equal(members.size, 0, "the lost-race load is discarded");
});

test("a load FAILURE surfaces via onMiss and leaves no orphan (no silent vanish)", () => {
  // drive the failure through the REAL deferred load queue (finishLoads), not a synchronous stub:
  // the miss must travel the async error path the renderer actually uses.
  const { conj, members, finishLoads, missed } = harness({ miss: ["./props/missing.glb"] });
  conj.spawn("./props/missing.glb", { id: "x" });
  assert.equal(conj.count(), 1, "tracked while the (doomed) load is still in flight");
  assert.deepEqual(missed, [], "nothing reported yet -- the load has not resolved");
  finishLoads(); // NOW the deferred load resolves -> error path
  assert.deepEqual(missed, ["./props/missing.glb"], "onMiss fired with the failed url once the async load failed");
  assert.equal(conj.count(), 0, "the failed item left no orphan");
  assert.equal(members.size, 0, "nothing was ever added to the scene");
});

test("moveTo with an omitted z keeps the prop's current depth (a 2D target must not teleport to z=0)", () => {
  const { conj, members, finishLoads } = harness();
  const id = conj.spawn("ball.glb", { at: { x: 0, y: 0, z: 4 } }); // conjured out at depth 4
  finishLoads();
  conj.step(0.4); // settle at home (z=4)
  const obj = [...members][0];
  assert.ok(Math.abs(obj.position.z - 4) < 1e-6, "starts at depth 4");
  // a typical brain target is 2D (x/y only) -> z omitted; the glide must PRESERVE depth, not snap to 0
  assert.equal(conj.moveTo(id, { x: 6, y: 1 }, { dur: 0.5 }), true, "accepts the 2D move");
  for (let i = 0; i < 14; i++) conj.step(0.05); // finish the glide
  assert.ok(Math.abs(obj.position.x - 6) < 0.05, "reaches the target x");
  assert.ok(Math.abs(obj.position.z - 4) < 1e-6, "kept its prior depth (omitted z != teleport to 0)");
});
