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
  // `live` IS the engine state container (handlers read engine.facial / engine.springOn / … off it);
  // mutate it between calls to prove live reads. `deps` is the stable services.
  const reg = createBusRegistry(live, deps);
  return { ...reg, EA, ui, live, deps };
}

test("the motion-core move set is reachable by action name", () => {
  // An AI driving her must be able to address each motion primitive + the introspection verbs.
  // If a future edit drops one of these from the table, the brain loses that ability silently — bite.
  const { COMMANDS } = makeRegistry();
  for (const action of ["pose", "fingers", "look", "move", "conjure", "perform", "capabilities", "query"]) {
    assert.equal(typeof COMMANDS[action], "function", `move set must expose '${action}'`);
  }
});

test("one name per concept: the retired verbs/aliases are GONE (not silently still routing)", () => {
  // 2026-06-29 redesign merged 4 duplicate pairs + renamed 2 + dropped 4 aliases. A driver that learns
  // the move set must not find two names for one thing. If any of these reappear, the merge regressed.
  const { COMMANDS, handleCommand } = makeRegistry();
  for (const dead of [
    "moveTo",
    "goTo",
    "lookAt",
    "lookMode",
    "setMorph",
    "layer",
    "setDisplay",
    "setMesh",
    "screenshot",
    "caps",
    "hand",
  ]) {
    assert.equal(COMMANDS[dead], undefined, `'${dead}' must be retired, not aliased`);
    assert.equal(handleCommand({ action: dead }), undefined, `'${dead}' dispatches to an honest no-op`);
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

test("move routes on its args: {px,py} = pixel-exact, {to} = by name (merged moveTo+goTo)", () => {
  const { handleCommand, EA } = makeRegistry();
  handleCommand({ action: "move", px: 700, py: 1100 });
  assert.deepEqual(EA.moveTo.calls[0], [700, 1100], "pixel coords -> moveTo(px,py)");
  handleCommand({ action: "move", to: "bottomright" });
  assert.deepEqual(EA.goTo.calls[0], ["bottomright"], "a named anchor -> goTo(name)");
  handleCommand({ action: "move" });
  assert.deepEqual(EA.goTo.calls[1], ["center"], "no args -> goTo('center')");
});

test("look routes on its args: {mode} sets the channel, {at}/{px,py} forces a gaze (merged lookMode+lookAt)", () => {
  const { handleCommand, EA, deps } = makeRegistry();
  handleCommand({ action: "look", mode: "eyes" });
  assert.deepEqual(deps.uiSetLookMode.calls[0], ["eyes"], "a mode -> uiSetLookMode");
  assert.equal(EA.lookAt.calls.length, 0, "setting the mode does NOT also force a gaze");
  handleCommand({ action: "look", at: [300, 400] });
  assert.deepEqual(EA.lookAt.calls[0], [300, 400], "{at:[x,y]} -> lookAt(x,y)");
  handleCommand({ action: "look", px: 5, py: 6 });
  assert.deepEqual(EA.lookAt.calls[1], [5, 6], "{px,py} also forces a gaze");
});

test("morph drives+SAVES by default; {save:false} is a transient probe (merged morph+setMorph)", () => {
  // BITE: the save split is the whole point of the merge — flip the default and one of these fails.
  const { handleCommand, EA, deps } = makeRegistry();
  handleCommand({ action: "morph", index: 2, value: 1 });
  assert.deepEqual(deps.uiSetMorphValue.calls[0], [2, 1], "default -> the saved/relayed path");
  assert.equal(EA.setMorph.calls.length, 0, "the saved path does NOT also poke the transient one");
  handleCommand({ action: "morph", index: 3, value: 0.5, save: false });
  assert.deepEqual(EA.setMorph.calls[0], [3, 0.5], "{save:false} -> the transient local probe");
});

test("pose folds in layer clearing: {clear:'id'} one layer, {clear:true} all (merged pose+layer)", () => {
  const { handleCommand, EA } = makeRegistry();
  handleCommand({ action: "pose", flex: { right_arm: [1, 0, 0] } });
  assert.equal(EA.poseLayer.calls.length, 1, "a normal pose still sets a layer via poseLayer");
  handleCommand({ action: "pose", clear: "wave" });
  assert.deepEqual(EA.poseLayer.calls[1][0], { id: "wave", clear: true }, "{clear:'id'} clears that one layer");
  handleCommand({ action: "pose", clear: true });
  assert.deepEqual(EA.layer.calls[0][0], { op: "clearAll" }, "{clear:true} clears ALL layers");
});

test("query('actions') self-reports the live move set (the 'what can I send?' verify-by-numbers hook)", () => {
  const { handleCommand, COMMANDS } = makeRegistry();
  const actions = handleCommand({ action: "query", what: "actions" });
  assert.ok(Array.isArray(actions), "query:actions returns a list");
  assert.deepEqual(actions, Object.keys(COMMANDS).sort(), "it reports exactly the live table, sorted");
  assert.ok(actions.includes("move") && actions.includes("look"), "the merged verbs are advertised");
  assert.ok(!actions.includes("moveTo"), "retired verbs are NOT advertised");
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
