// The EnigmaAvatar control surface — the facade every driver talks to (blueprint sec 3/5/8).
//
// INTENT: createControlSurface wires a big facade over the engine. The carve's whole correctness rests
// on it reading LIVE state through getters (never frozen), resolving the things defined later in
// avatar.js (ui / handleCommand / the ui* relays) at call time, and degrading honestly. These tests drive the REAL
// factory (the bus/query tests mock EnigmaAvatar, so only this file exercises surface.js) and BITE:
// freeze a getter or drop a setter and the matching assertion fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlSurface } from "../src/control/surface.js";

// surface.js reads window globals in state()/perform(); provide them for the Node test env.
globalThis.innerWidth = 1920;
globalThis.innerHeight = 1080;

function spy(ret) {
  const f = (...a) => {
    f.calls.push(a);
    return typeof f.ret === "function" ? f.ret(...a) : f.ret;
  };
  f.calls = [];
  f.ret = ret;
  return f;
}

// Build the real surface over fully-mocked deps. `live` holds the mutable engine state read through
// getters; mutate it between calls to prove live reads. `fn` holds the delegate-function spies.
function makeSurface(over = {}) {
  const live = {
    proc: { capabilities: () => ({ roles: 19 }), layerIds: () => ["a"], matched: ["hips"] },
    facial: { setMouth: spy(), mode: "jaw", info: { axis: "x" } },
    spring: { names: ["tail"] },
    model: null,
    vrm: null,
    sizeScale: 1,
    held: false,
    modelDims: { w: 2, h: 5 },
    springOn: true,
    facialOn: true,
    locked: false,
    rotateMode: false,
    bonesShown: false,
    curKey: "model-A",
    weightMass: null,
    attachObjs: [],
    roleBones: {},
    ui: { isOpen: () => false, showSettings: spy(), hideSettings: spy() },
    handleCommand: spy({ ok: 1 }),
    aiPaused: false, // AI-control kill-switch state (read live by connect()'s gate)
    onAiCommand: spy(), // notified of each ACCEPTED command (the no-surprises activity flash)
    uiLoadModel: spy(),
    uiAttach: spy(),
    uiDetach: spy(),
    uiClearAttachments: spy(),
    ...over,
  };
  const fn = {};
  for (const name of [
    "glideTo,nudge,goTo,whereAmI,applySize,springTune,facialTune,throwBall,dropBall,setStatus",
    "tuneAttachment,showSkeleton,snapshot,allMaterialsInfo,recolor,hueShift,resetColors,profileFor",
    "allMeshesInfo,setMeshVisible,setMeshLabel,setBoneLabel,setRot,setYaw,setRotAxis,getRot,springRegions",
    "setRegionWeight,allMorphsInfo,setMorphValue,setRotateMode,posScreen,resolvePropName,parseControlTags",
    "parseTagArg,wake",
  ]
    .join(",")
    .split(","))
    fn[name] = spy();
  fn.profileFor.ret = () => ({}); // returns a profile object
  fn.posScreen.ret = [10, 20];
  const pos = { x: 1, y: 2 };
  const cursor = { x: 0, y: 0, over: false, seen: false };
  const physics = { clearProps: spy() };
  const voice = { speak: spy(), stop: spy() };
  const conjurer = { spawn: spy("cid"), clear: spy(), dismiss: spy(), moveTo: spy(), ids: spy([]) };

  // `engine` IS the live state object: the surface reads engine.proc / engine.model / … so mutating
  // `live` between calls proves the live reads. The stable in-place objects are assigned on so the
  // factory can destructure them at build.
  const engine = Object.assign(live, {
    pos,
    cursor,
    CONJURE_ASSETS: { ball: "ball.glb" },
  });
  const surface = createControlSurface(engine, {
    ...fn,
    physics,
    voice,
    conjurer,
    onAiCommand: (a) => live.onAiCommand(a),
  });
  return { surface, live, fn, pos, cursor, physics, voice, conjurer };
}

test("state() reads LIVE toggles + size, never a frozen snapshot", () => {
  // BITE: pass a value instead of a getter for any of these and the second read fails.
  const { surface, live } = makeSurface({ sizeScale: 0.5, springOn: true });
  assert.equal(surface.state().size, 0.5);
  assert.equal(surface.state().toggles.spring, true);
  live.sizeScale = 1.25;
  live.springOn = false;
  assert.equal(surface.state().size, 1.25, "a later resize is reflected");
  assert.equal(surface.state().toggles.spring, false, "a later spring toggle is reflected");
});

test("setMorph drives the LIVE model by index and coerces NaN away from the GPU", () => {
  const { surface, live } = makeSurface();
  const infl = [0, 0, 0];
  live.model = { traverse: (cb) => cb({ isMesh: true, morphTargetInfluences: infl }) };
  const n = surface.setMorph(1, 0.7);
  assert.equal(n, 1, "reports the mesh count it drove");
  assert.equal(infl[1], 0.7, "wrote the live model's influence");
  assert.equal(surface.setMorph(0, "not-a-number"), 0, "NaN is rejected (returns 0, no write)");
  assert.equal(infl[0], 0, "the bad value never reached the influences array");
});

test("connect() kill-switch: while AI control is paused, NO command dispatches and the caller gets an honest paused reply", () => {
  // BITE: remove the getAiPaused gate in surface.js and handleCommand fires anyway -> this fails.
  const { surface, live } = makeSurface({ aiPaused: true });
  let lastWs = null;
  class FakeWS {
    constructor() {
      lastWs = this;
      this.sent = [];
    }
    send(s) {
      this.sent.push(JSON.parse(s));
    }
  }
  globalThis.WebSocket = FakeWS;
  surface.connect("ws://x");
  lastWs.onmessage({ data: JSON.stringify({ action: "ball", reqId: 9 }) });
  assert.equal(live.handleCommand.calls.length, 0, "a paused avatar runs NOTHING the bus sends");
  assert.equal(live.onAiCommand.calls.length, 0, "and the activity flash never fires for a dropped command");
  assert.deepEqual(
    lastWs.sent[0],
    { type: "reply", reqId: 9, action: "ball", result: { error: "ai control paused" } },
    "a reqId driver still gets an honest 'paused' reply instead of hanging"
  );
  // Flip it back on: the SAME open socket resumes — the command now dispatches and flashes.
  live.aiPaused = false;
  lastWs.onmessage({ data: JSON.stringify({ action: "ball", reqId: 10 }) });
  assert.equal(live.handleCommand.calls.length, 1, "un-pausing resumes dispatch on the live connection");
  assert.deepEqual(
    live.onAiCommand.calls[0],
    ["ball"],
    "an accepted command notifies the activity flash with its action"
  );
});

test("connect() routes an incoming bus message through the LATER-defined handleCommand (live getter)", () => {
  // surface is built at ~2446 but handleCommand at ~3117; the getter must resolve it at message time.
  const { surface, live } = makeSurface();
  let lastWs = null;
  class FakeWS {
    constructor() {
      lastWs = this;
      this.sent = [];
    }
    send(s) {
      this.sent.push(JSON.parse(s));
    }
  }
  globalThis.WebSocket = FakeWS;
  surface.connect("ws://x");
  live.handleCommand.ret = { pong: 1 };
  lastWs.onmessage({ data: JSON.stringify({ action: "ball", reqId: 5 }) });
  assert.deepEqual(
    live.handleCommand.calls[0][0],
    { action: "ball", reqId: 5 },
    "message routed to the LIVE handleCommand"
  );
  assert.deepEqual(
    lastWs.sent[0],
    { type: "reply", reqId: 5, action: "ball", result: { pong: 1 } },
    "and its result is replied to the caller (reqId echoed)"
  );
});

test("connect() STRICT WIRE: an invalid command gets a NAMED error reply and never dispatches or flashes", () => {
  // BITE: remove the validateCommand gate in surface.js and the garbage dispatches silently -> this fails.
  const { surface, live } = makeSurface();
  let lastWs = null;
  class FakeWS {
    constructor() {
      lastWs = this;
      this.sent = [];
    }
    send(s) {
      this.sent.push(JSON.parse(s));
    }
  }
  globalThis.WebSocket = FakeWS;
  surface.connect("ws://x");
  // unknown verb -> named error, no dispatch, no activity flash
  lastWs.onmessage({ data: JSON.stringify({ action: "teleport", reqId: 3 }) });
  assert.equal(live.handleCommand.calls.length, 0, "an unknown action never reaches the registry");
  assert.equal(live.onAiCommand.calls.length, 0, "and never flashes as 'accepted'");
  assert.equal(lastWs.sent[0].result.error, "unknown action 'teleport'", "the driver is TOLD what was wrong");
  // known verb missing its required field -> same treatment
  lastWs.onmessage({ data: JSON.stringify({ action: "say", reqId: 4 }) });
  assert.equal(live.handleCommand.calls.length, 0);
  assert.match(lastWs.sent[1].result.error, /'say' requires 'url'/);
  // no reqId -> still dropped, just nothing to reply to
  lastWs.onmessage({ data: JSON.stringify({ action: "teleport" }) });
  assert.equal(live.handleCommand.calls.length, 0);
  assert.equal(lastWs.sent.length, 2, "no reply channel, no reply — but never a dispatch");
});

test("honest degradation: compositor verbs return {error} (not throw) when the model has no rig", () => {
  const { surface } = makeSurface({ proc: null });
  assert.deepEqual(surface.poseLayer({ flex: { a: [1] } }), { error: "no procedural rig on this model" });
  assert.deepEqual(surface.fingers({ side: "R" }), { error: "no procedural rig on this model" });
  assert.equal(surface.capabilities(), null, "capabilities -> null when no rig, never a fake answer");
});

test("delegation: the facade forwards to the right engine fn (sample of the contract)", () => {
  const { surface, fn, physics, voice } = makeSurface();
  surface.moveTo(7, 8);
  assert.deepEqual(fn.glideTo.calls[0], [7, 8, undefined], "moveTo -> glideTo (dur rides through)");
  surface.moveTo(7, 8, 2.5);
  assert.deepEqual(fn.glideTo.calls[1], [7, 8, 2.5], "moveTo(px,py,dur) -> glideTo timed");
  surface.ball("throwball");
  assert.equal(fn.throwBall.calls.length, 1, "ball throwball -> throwBall");
  surface.ball("clearballs");
  assert.equal(physics.clearProps.calls.length, 1, "ball clearballs -> physics.clearProps");
  surface.say("file:///x.wav", { gain: 1 });
  assert.deepEqual(voice.speak.calls[0], ["file:///x.wav", { gain: 1 }], "say -> voice.speak");
});

test("load/attach/detach route through the ui* relays that are defined AFTER the factory call", () => {
  const { surface, live } = makeSurface();
  surface.load("m.glb");
  assert.deepEqual(live.uiLoadModel.calls[0], ["m.glb", "m.glb"], "load -> uiLoadModel (live getter, defined later)");
  surface.attach("p.glb", { bone: "hand" });
  assert.deepEqual(live.uiAttach.calls[0], ["p.glb", { bone: "hand" }], "attach -> uiAttach");
  surface.clearAttachments();
  assert.equal(live.uiClearAttachments.calls.length, 1, "clearAttachments -> uiClearAttachments");
});
