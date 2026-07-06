// simhost.mjs — the SIM HOST utilityProcess (S2-b-i scaffold, 2026-07-06).
//
// The destination (TODO.md Restructure S2): this process hosts the headless simulation core —
// rig resolution + layer compositor + springs + rapier + facial — ticking without DOM/GPU and
// emitting the flat pose buffer every window mirrors. THIS sub-step is the scaffold that proves
// the ground it stands on, inside the real overlay:
//   1. a utilityProcess can import the ESM sim stack (engine/sim.js, three, the rig tiers),
//   2. the canonical tick (engine/sim.js) runs here at a paced rate with injected subsystems
//      (stubs for now — the real ones arrive in S2-b-ii),
//   3. main owns its lifecycle: spawn -> ping/pong -> shutdown/crash-restart.
// No window consumes anything from this process yet; the brain window keeps ticking its own sim
// (zero behavior change) until the pose-buffer switchover sub-step.
import fs from "node:fs";
import * as THREE from "three";
import { snapshotBones, resolveRig } from "../src/rig/rig.js";
import { createSimTick } from "../src/engine/sim.js";
import { gltfJsonFromBuffer, buildSkeleton } from "../src/engine/skeleton.js";

const t0 = Date.now();
let ticks = 0;

// PROOF the heavy sim deps work in-process: a tiny synthetic skeleton through the real snapshotter.
const probe = new THREE.Group();
const b0 = new THREE.Bone(),
  b1 = new THREE.Bone(),
  b2 = new THREE.Bone();
b0.name = "Hips";
b1.name = "Spine";
b2.name = "Head";
b0.add(b1);
b1.add(b2);
probe.add(b0);
const probeBones = snapshotBones(probe).snap.length; // 3 = three + the rig tier ran here

// The REAL canonical tick with stub subsystems — the order machinery is live in this process now;
// S2-b-ii swaps the stubs for the real compositor/springs/rapier driving a real skeleton.
const sim = createSimTick({
  stepPose: () => {},
  stepGrabServo: () => {},
  physics: { count: () => 0, setFloor: () => {}, setAvatar: () => {}, step: () => false },
  conjurer: { step: () => false },
  wake: () => {},
  isWorldReady: () => false,
  getFloorY: () => 0,
  getBody: () => ({ x: 0, y: 0, motionY: 0, w: 1, h: 1, size: 1, baseH: 6 }),
});

// Paced loop (~60Hz): a utilityProcess has no rAF; setTimeout pacing is plenty for the scaffold
// (the buffer-emitting host will pace off consumer demand instead of a fixed clock).
const STEP_MS = 1000 / 60;
let last = Date.now();
let _timer = null;
function loop() {
  const now = Date.now();
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  sim.tick(dt);
  ticks++;
  _timer = setTimeout(loop, STEP_MS);
}
loop();

// S2-b-ii: the REAL skeleton, built from the model's own bytes (no WebGL, no mesh decode) and
// run through the SAME rig cascade the renderer uses. Held for the next sub-step, where the
// compositor + springs drive it and the pose buffer flows out.
let _skel = null; // { root, bones, roles }

process.parentPort.on("message", (e) => {
  const m = e.data || {};
  if (m.type === "model") {
    try {
      const { root, bones } = buildSkeleton(gltfJsonFromBuffer(fs.readFileSync(m.path)));
      const resolved = resolveRig(root, null);
      const roles = Object.values(resolved.roles || {}).filter(Boolean).length;
      _skel = { root, bones, roles: resolved.roles };
      process.parentPort.postMessage({
        type: "skeleton",
        file: String(m.path).split(/[\\/]/).pop(),
        bones: bones.length,
        roles,
      });
    } catch (err) {
      _skel = null;
      process.parentPort.postMessage({
        type: "skeleton-error",
        file: String(m.path).split(/[\\/]/).pop(),
        error: String((err && err.message) || err),
      });
    }
  } else if (m.type === "ping") {
    process.parentPort.postMessage({
      type: "pong",
      ticks,
      uptimeMs: Date.now() - t0,
      probeBones, // 3 proves three + snapshotBones ran inside the utilityProcess
      threeRev: THREE.REVISION,
    });
  } else if (m.type === "shutdown") {
    clearTimeout(_timer);
    process.exit(0);
  }
});
