// The EnigmaAvatar control surface — the facade every driver talks to (blueprint sec 3/5/8).
//
// INTENT: createControlSurface wires a big facade over the engine. The carve's whole correctness rests
// on it reading LIVE state through getters (never frozen), WRITING the look primitives through setters,
// resolving its self-reference (perform -> lookAt) and the things defined later in avatar.js (ui /
// handleCommand / the ui* relays) at call time, and degrading honestly. These tests drive the REAL
// factory (the bus/query tests mock EnigmaAvatar, so only this file exercises surface.js) and BITE:
// freeze a getter or drop a setter and the matching assertion fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlSurface } from "../src/control/surface.js";

// surface.js reads window globals in state()/lookAt()/perform(); provide them for the Node test env.
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
    proc: { setLook: true, capabilities: () => ({ roles: 19 }), layerIds: () => ["a"], matched: ["hips"] },
    facial: { setMouth: spy(), mode: "jaw", info: { axis: "x" } },
    spring: { names: ["tail"] },
    model: null,
    vrm: null,
    sizeScale: 1,
    held: false,
    modelDims: { w: 2, h: 5 },
    springOn: true,
    facialOn: true,
    lookOn: true,
    locked: false,
    rotateMode: false,
    bonesShown: false,
    curKey: "model-A",
    weightMass: null,
    attachObjs: [],
    lookMode: "both",
    roleBones: {},
    ui: { isOpen: () => false, showSettings: spy(), hideSettings: spy() },
    handleCommand: spy({ ok: 1 }),
    uiLoadModel: spy(),
    uiAttach: spy(),
    uiDetach: spy(),
    uiClearAttachments: spy(),
    cursorIdle: 999,
    forceLookUntil: 0,
    ...over,
  };
  const fn = {};
  for (const name of [
    "glideTo,nudge,goTo,whereAmI,applySize,springTune,facialTune,throwBall,dropBall,setStatus",
    "tuneAttachment,showSkeleton,snapshot,allMaterialsInfo,recolor,hueShift,resetColors,profileFor",
    "allMeshesInfo,setMeshVisible,setMeshLabel,setBoneLabel,setRot,setYaw,setRotAxis,getRot,springRegions",
    "setRegionWeight,allMorphsInfo,setMorphValue,setRotateMode,posScreen,resolvePropName,parseControlTags",
    "parseTagArg,lookTarget,wake,setLookMode,hasEyes",
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

  const surface = createControlSurface({
    ...fn,
    physics,
    voice,
    conjurer,
    pos,
    cursor,
    LOOK: {},
    eyeCfg: {},
    CONJURE_ASSETS: { ball: "ball.glb" },
    getProc: () => live.proc,
    getFacial: () => live.facial,
    getSpring: () => live.spring,
    getModel: () => live.model,
    getVrm: () => live.vrm,
    getSizeScale: () => live.sizeScale,
    getHeld: () => live.held,
    getModelDims: () => live.modelDims,
    getSpringOn: () => live.springOn,
    getFacialOn: () => live.facialOn,
    getLookOn: () => live.lookOn,
    getLocked: () => live.locked,
    getRotateMode: () => live.rotateMode,
    getBonesShown: () => live.bonesShown,
    getCurKey: () => live.curKey,
    getWeightMass: () => live.weightMass,
    getAttachObjs: () => live.attachObjs,
    getLookMode: () => live.lookMode,
    getRoleBones: () => live.roleBones,
    getUi: () => live.ui,
    getHandleCommand: () => live.handleCommand,
    getUiLoadModel: () => live.uiLoadModel,
    getUiAttach: () => live.uiAttach,
    getUiDetach: () => live.uiDetach,
    getUiClearAttachments: () => live.uiClearAttachments,
    setCursorIdle: (v) => (live.cursorIdle = v),
    setForceLookUntil: (v) => (live.forceLookUntil = v),
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

test("lookAt WRITES through the setter thunks + cursor, and reports drove from the LIVE rig", () => {
  // BITE: drop setForceLookUntil/setCursorIdle (or freeze proc) and these fail.
  const { surface, live, cursor } = makeSurface();
  const r = surface.lookAt(300, 400);
  assert.deepEqual([cursor.x, cursor.y], [300, 400], "mutates the shared cursor in place");
  assert.equal(live.cursorIdle, 0, "reset the idle counter via setCursorIdle");
  assert.ok(live.forceLookUntil > 0, "opened the forced-look window via setForceLookUntil");
  assert.equal(r.drove, true, "a rig with setLook reports drove=true");
  live.proc = { setLook: undefined }; // a model with no gaze channel
  assert.equal(surface.lookAt(1, 1).drove, false, "no gaze channel -> honest drove=false, not a fake success");
  assert.equal(surface.lookAt(NaN, NaN).lookAt[0], 960, "NaN coords coerce to screen center (innerWidth/2)");
});

test("perform resolves its SELF-reference: a [look] tag calls EnigmaAvatar.lookAt", () => {
  const { surface, fn, cursor } = makeSurface();
  fn.parseControlTags.ret = { clean: "hi", tags: [{ type: "look", arg: "left" }] };
  fn.lookTarget.ret = { x: 50, y: 60, label: "left" };
  const r = surface.perform("hi [look:left]");
  assert.equal(r.say, "hi", "returns the clean line for TTS");
  assert.deepEqual(r.performed, ["look:left"]);
  assert.deepEqual([cursor.x, cursor.y], [50, 60], "the self-call to lookAt actually moved the gaze");
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
  assert.deepEqual(live.handleCommand.calls[0][0], { action: "ball", reqId: 5 }, "message routed to the LIVE handleCommand");
  assert.deepEqual(
    lastWs.sent[0],
    { type: "reply", reqId: 5, action: "ball", result: { pong: 1 } },
    "and its result is replied to the caller (reqId echoed)"
  );
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
  assert.deepEqual(fn.glideTo.calls[0], [7, 8], "moveTo -> glideTo");
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
