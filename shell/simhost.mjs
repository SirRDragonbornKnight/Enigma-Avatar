// simhost.mjs — the SIM HOST utilityProcess (S2-b).
//
// The destination (TODO.md Restructure S2): this process hosts the headless simulation core and
// every window becomes a dumb view of its pose buffer. Where it stands:
//   S2-b-i   : lifecycle scaffold (spawn -> ping/pong -> shutdown/crash-restart) — DONE.
//   S2-b-ii  : the REAL skeleton from the model's own bytes + the REAL rig cascade — DONE
//              (live parity: ryuri 907 bones, 12/19 roles == rig_report ground truth).
//   S2-b-iii : THE COMPOSITOR + SPRINGS drive that skeleton through the SAME per-frame seam the
//              renderer uses (stepProcVrmFrame — proc pose, then springs), and the flat pose
//              buffer flows to main at ~30Hz. No window consumes it yet; the brain keeps its own
//              sim (zero behavior change) until the switchover sub-step.
// Honest gaps until the switchover: no facial/morph section in the buffer yet, no per-avatar
// spring regionWeight (profile state reaches the host when state moves to main, S3), FBX/VRM
// models stay brain-hosted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { snapshotBones, resolveRig } from "../src/rig/rig.js";
import { createSimTick } from "../src/engine/sim.js";
import { gltfJsonFromBuffer, buildSkeleton } from "../src/engine/skeleton.js";
import { buildProceduralRig } from "../src/motion/procedural.js";
import { buildSpringBones } from "../src/motion/spring.js";
import { stepProcVrmFrame } from "../src/avatar.js"; // the module-top seam — imports WITHOUT the browser bootstrap (proven by tests/vrm_order.test.js)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const t0 = Date.now();
let ticks = 0;

// The same joint/speed-limit table the renderer loads; absent -> no caps, the renderer's own
// honest degrade.
let BONE_LIMITS = {};
try {
  BONE_LIMITS = JSON.parse(fs.readFileSync(path.join(ROOT, "bone_limits.json"), "utf8"));
} catch {
  console.error("[simhost] bone_limits.json unreadable -> no joint/speed caps");
}

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

// The LIVE simulation: skeleton + compositor + springs, built per model message. The tick below
// drives it through the real seam whenever it exists.
let _live = null; // { root, bones, proc, spring, buf }

function stepLive(dt) {
  if (!_live) return;
  stepProcVrmFrame(dt, {
    proc: _live.proc,
    facial: null,
    facialOn: false, // facial joins the buffer at the switchover sub-step
    spring: _live.spring,
    springOn: true,
    rig: _live.root,
    vrm: null,
    soft: null,
  });
}

// Flat pose buffer (renderer serializePose layout, minus the morph section for now):
// [tag, motionY, rootQuat x4, rootScale, boneQuat x4 per bone...]
// tag = the renderer's curKey hash (same rolling hash as avatar.js _poseTag) so a different
// model can never apply onto this layout — bone COUNT alone can coincide across models.
function poseTag(key) {
  let h = 0;
  const s = String(key);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 8) / 8388608;
}
function fillPoseBuf() {
  const { root, bones, buf } = _live;
  let k = 0;
  buf[k++] = _live.tag; // a different skeleton must never apply onto this layout
  buf[k++] = 0; // motionY (root-motion stays 0 — the AI authors motion via layers)
  buf[k++] = root.quaternion.x;
  buf[k++] = root.quaternion.y;
  buf[k++] = root.quaternion.z;
  buf[k++] = root.quaternion.w;
  buf[k++] = root.scale.x;
  for (let i = 0; i < bones.length; i++) {
    const q = bones[i].quaternion;
    buf[k++] = q.x;
    buf[k++] = q.y;
    buf[k++] = q.z;
    buf[k++] = q.w;
  }
  return buf;
}

const sim = createSimTick({
  stepPose: stepLive,
  stepGrabServo: () => {}, // grab is a window-input concern; it reaches the host at the switchover
  physics: { count: () => 0, setFloor: () => {}, setAvatar: () => {}, step: () => false }, // rapier moves in with the switchover
  conjurer: { step: () => false },
  wake: () => {},
  isWorldReady: () => false,
  getFloorY: () => 0,
  getBody: () => ({ x: 0, y: 0, motionY: 0, w: 1, h: 1, size: 1, baseH: 6 }),
});

// Paced loop (~60Hz): a utilityProcess has no rAF; the pose buffer ships every 2nd tick (~30Hz).
// DRIFT-CORRECTED pacing: the next tick is scheduled against a target clock, not "STEP_MS after
// the work finished" — the naive form quietly ran ~30Hz once a real skeleton made ticks cost
// milliseconds (measured: pose rate 16/s instead of 30/s on ryuri's 907 bones).
const STEP_MS = 1000 / 60;
let last = Date.now();
let _timer = null;
let _poseSkip = 0;
let _nextAt = Date.now() + STEP_MS;
function loop() {
  const now = Date.now();
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  sim.tick(dt);
  ticks++;
  if (_live && ++_poseSkip >= 2) {
    _poseSkip = 0;
    process.parentPort.postMessage({ type: "pose", buf: fillPoseBuf() });
  }
  const after = Date.now();
  _nextAt += STEP_MS;
  if (_nextAt < after) _nextAt = after + STEP_MS; // fell behind — skip forward, never spiral
  _timer = setTimeout(loop, _nextAt - after);
}
loop();

// Build the live sim for a model: skeleton from bytes -> rig cascade -> compositor + springs,
// then a DRIVE CHECK through the real seam (bend a forearm under the real speed clamps, measure
// the world moved, ease back) so the receipt proves the compositor DRIVES this skeleton — not
// just that it exists.
function buildLive(modelPath, url) {
  const { root, bones } = buildSkeleton(gltfJsonFromBuffer(fs.readFileSync(modelPath)));
  const resolved = resolveRig(root, null);
  const roleCount = Object.values(resolved.roles || {}).filter(Boolean).length;
  const proc = buildProceduralRig(root, BONE_LIMITS, resolved);
  const spring = buildSpringBones(root, { exclude: resolved.springExclude }); // regionWeight arrives with profile state (S3)
  // tag: the renderer hashes its curKey (the model URL); an older main that sends no url gets the
  // bone count — still a tag, just the weaker one
  const tag = url != null ? poseTag(url) : bones.length;
  _live = { root, bones, proc, spring, tag, buf: new Float32Array(2 + 5 + bones.length * 4) };
  let driveDeg = 0;
  const fbRole = resolved.roles?.left_forearm ? "left_forearm" : resolved.roles?.right_forearm ? "right_forearm" : null;
  if (fbRole) {
    const fb = resolved.roles[fbRole];
    const rest = fb.quaternion.clone();
    proc.setLayer("hostcheck", { flex: { [fbRole]: 1 }, weight: 1 });
    for (let i = 0; i < 90; i++) stepLive(1 / 60); // 1.5s under the real deg/s clamps
    driveDeg = (rest.angleTo(fb.quaternion) * 180) / Math.PI;
    proc.setLayer("hostcheck", null);
    for (let i = 0; i < 120; i++) stepLive(1 / 60); // ease back to rest before buffers ship
  }
  return { bones: bones.length, roles: roleCount, driveDeg: +driveDeg.toFixed(1) };
}

process.parentPort.on("message", (e) => {
  const m = e.data || {};
  if (m.type === "model") {
    if (!m.path) {
      // model DROP: the current model is one this host can't sim (unsupported format / none
      // loaded) — a stale skeleton must not keep shipping the previous model's poses
      _live = null;
      return;
    }
    try {
      const r = buildLive(m.path, m.url);
      process.parentPort.postMessage({ type: "skeleton", file: String(m.path).split(/[\\/]/).pop(), ...r });
    } catch (err) {
      _live = null;
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
