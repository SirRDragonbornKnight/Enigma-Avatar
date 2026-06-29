// The AI bus command registry — the MOVE SET as a contract.
//
// INTENT (blueprint sec 5/8 + sec 3 "verify by numbers"): the bus is the AI control plane. A driver
// sends {action, ...} and the registry dispatches action -> handler. These tests assert what the move
// set MUST do for an AI to drive her, not how the table is built:
//   * the motion-core vocabulary is reachable by name (pose/layer/fingers/lookAt/conjure/perform)
//     plus the introspection verbs (capabilities/query) the spec's "verify by numbers" path needs;
//   * an unknown/garbage action is an HONEST no-op (undefined, never a throw) — never a false success;
//   * answer-handlers RETURN to the caller; void handlers reply undefined (the load-bearing split);
//   * handlers read LIVE engine state at call time, never a frozen snapshot (so a bus command always
//     acts on current truth even after the model/toggles change).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBusRegistry } from "../src/control/bus.js";

// A recording spy: remembers its calls, returns a settable value.
function spy(ret) {
  const f = (...a) => {
    f.calls.push(a);
    return f.ret;
  };
  f.calls = [];
  f.ret = ret;
  return f;
}

// Build a registry over fully-mocked deps. `live` holds the mutable engine state the handlers read
// through getters; mutate it between calls to prove live reads. Returns { handleCommand, COMMANDS, EA, ui, live, deps }.
function makeRegistry() {
  const EA = new Proxy({}, { get: (t, k) => (t[k] ||= spy()) }); // every EnigmaAvatar.method is a spy
  const ui = { showSettings: spy(), hideSettings: spy(), showGallery: spy(), hideGallery: spy() };
  const live = {
    facial: { setBlink: spy(), blink: spy() },
    spring: { impulse: spy() },
    springOn: true,
    bonesShown: false,
    rotateMode: false,
    platforms: [],
    curDisp: { x: 0, y: 0 },
  };
  const relayNames = [
    "uiAttach,uiDetach,uiClearAttachments,uiTuneAttachment,uiSpringTune,uiFacialTune,uiShowSkeleton",
    "uiRecolor,uiResetColors,uiSetMeshVisible,uiSetRot,uiSetRotAxis,uiSetRegionWeight,uiSetMorphValue",
    "uiSetRotateMode,uiSetLookMode,uiSetBoneLabel,uiHighlightBone,uiDeleteOutfit,uiSaveOutfit",
    "uiWearOutfit,uiSetPlatforms,uiHueShift",
  ]
    .join(",")
    .split(",");
  const deps = { EnigmaAvatar: EA, ui, wake: spy(), getRot: spy({ x: 0, y: 0, z: 0 }), answerQuery: spy("Q") };
  for (const n of relayNames) deps[n] = spy();
  deps.getFacial = () => live.facial;
  deps.getSpring = () => live.spring;
  deps.getSpringOn = () => live.springOn;
  deps.getBonesShown = () => live.bonesShown;
  deps.getRotateMode = () => live.rotateMode;
  deps.getPlatforms = () => live.platforms;
  deps.getCurDisp = () => live.curDisp;
  const reg = createBusRegistry(deps);
  return { ...reg, EA, ui, live, deps };
}

test("the motion-core move set is reachable by action name", () => {
  // An AI driving her must be able to address each motion primitive + the introspection verbs.
  // If a future edit drops one of these from the table, the brain loses that ability silently — bite.
  const { COMMANDS } = makeRegistry();
  for (const action of ["pose", "layer", "fingers", "lookAt", "conjure", "perform", "capabilities", "query"]) {
    assert.equal(typeof COMMANDS[action], "function", `move set must expose '${action}'`);
  }
});

test("unknown / garbage action is an HONEST no-op (undefined, never a throw)", () => {
  const { handleCommand } = makeRegistry();
  assert.equal(handleCommand({ action: "no_such_action" }), undefined);
  assert.equal(handleCommand({}), undefined);
  assert.equal(handleCommand(null), undefined);
  assert.equal(handleCommand({ action: 42 }), undefined, "non-string action is not dispatched");
});

test("answer-handlers RETURN to the caller; void handlers reply undefined (the load-bearing split)", () => {
  const { handleCommand, EA } = makeRegistry();
  EA.capabilities.ret = { roles: 19 };
  EA.perform.ret = "clean line";
  assert.deepEqual(handleCommand({ action: "capabilities" }), { roles: 19 }, "capabilities answers the caller");
  assert.equal(handleCommand({ action: "perform", text: "hi [wave]" }), "clean line", "perform returns the clean line");
  assert.equal(handleCommand({ action: "query", what: "state" }), "Q", "query answers via answerQuery");
  assert.equal(handleCommand({ action: "size", value: 0.8 }), undefined, "size is a void command");
});

test("pose / fingers / conjure forward the command to the control surface", () => {
  const { handleCommand, EA } = makeRegistry();
  const layer = { flex: { right_arm: [1, 0, 0] }, dur: 2 };
  handleCommand({ action: "pose", ...layer });
  assert.equal(EA.poseLayer.calls.length, 1, "pose -> EnigmaAvatar.poseLayer");
  handleCommand({ action: "fingers", side: "R", curl: 1 });
  assert.equal(EA.fingers.calls.length, 1, "fingers -> EnigmaAvatar.fingers");
  handleCommand({ action: "conjure", do: "spawn", name: "ball" });
  assert.equal(EA.conjure.calls.length, 1, "conjure -> EnigmaAvatar.conjure");
});

test("aliases route to the same behavior as their canonical action", () => {
  const { handleCommand, EA } = makeRegistry();
  handleCommand({ action: "screenshot" });
  assert.equal(EA.snap.calls.length, 1, "screenshot -> snap");
  handleCommand({ action: "caps" });
  assert.equal(EA.capabilities.calls.length, 1, "caps -> capabilities");
  handleCommand({ action: "hand", side: "L", curl: 0.5 });
  assert.equal(EA.fingers.calls.length, 1, "hand -> fingers");
});

test("handlers read LIVE state, not a frozen snapshot (showBones toggles with bonesShown)", () => {
  // BITE: the carve passes mutable state as getter thunks precisely so this holds. Freeze any of them
  // (pass a value instead of a getter) and this test fails.
  const { handleCommand, deps, live } = makeRegistry();
  live.bonesShown = false;
  handleCommand({ action: "showBones" }); // no explicit on -> defaults to !current
  live.bonesShown = true;
  handleCommand({ action: "showBones" });
  assert.deepEqual(
    [deps.uiShowSkeleton.calls[0][0], deps.uiShowSkeleton.calls[1][0]],
    [true, false],
    "showBones flips relative to the LIVE bonesShown each call"
  );
});

test("platform places a surface using LIVE curDisp (global = display origin + local px)", () => {
  const { handleCommand, deps, live } = makeRegistry();
  live.curDisp = { x: 1000, y: 2000 };
  live.platforms = [];
  handleCommand({ action: "platform", px: 5, py: 7, w: 50 });
  assert.deepEqual(
    deps.uiSetPlatforms.calls[0][0],
    [{ gx: 1005, gy: 2007, w: 50 }],
    "local (5,7) on display @ (1000,2000) -> global (1005,2007)"
  );
});

test("blink is null-safe when no facial rig is present (honest no-op, no crash)", () => {
  const { handleCommand, live } = makeRegistry();
  live.facial = { setBlink: spy(), blink: spy() };
  handleCommand({ action: "blink", value: 1 });
  assert.equal(live.facial.setBlink.calls[0][0], 1, "finite value holds the lids via setBlink");
  live.facial = null; // model with no face
  assert.doesNotThrow(() => handleCommand({ action: "blink" }), "blink with no facial rig must not throw");
});
