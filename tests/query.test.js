// The AI self-report reporter — the "VERIFY BY NUMBERS FIRST" surface (blueprint sec 3).
//
// INTENT: answerQuery(what) is how a driving AI reads LIVE ground truth to verify its own actions
// (the spec's backbone: numbers before eyes). These tests assert it is read-only, reads live state,
// degrades honestly (null / {mode:"none"} rather than throwing), and reports the right shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueryReporter } from "../src/control/query.js";

function spy(ret) {
  const f = (...a) => {
    f.calls.push(a);
    return f.ret;
  };
  f.calls = [];
  f.ret = ret;
  return f;
}

function makeReporter(over = {}) {
  const EA = new Proxy({}, { get: (t, k) => (t[k] ||= spy()) });
  const live = {
    facial: null,
    proc: null,
    platforms: [],
    curDisp: { x: 0, y: 0 },
    curKey: "model-A",
    sizeScale: 1,
    weightMass: null,
    springNeverExtra: [],
    ...over,
  };
  // `live` IS the engine state container (the reporter reads engine.facial / engine.proc / … off it);
  // mutate it between calls to prove live reads. rig is a stable object on the container.
  const engine = Object.assign(live, { rig: { rotation: { x: 0, y: Math.PI, z: 0 } } });
  const bonePoints = spy(null); // avatar.js's world->monitor-px projector (null = no rig resolved)
  const aq = createQueryReporter(engine, {
    EnigmaAvatar: EA,
    _norm360: (v) => ((v % 360) + 360) % 360,
    getRot: () => ({ x: 10, y: 20, z: 30 }),
    outfitNames: () => ["casual"],
    profileFor: () => ({ hiddenMeshes: [] }),
    allMeshesInfo: () => [],
    bonePoints,
  });
  return { aq, EA, live, bonePoints };
}

test("query('model') reports the current model + size, and reads it LIVE", () => {
  // BITE: the reporter snapshots getters at call time; freeze curKey and the second assert fails.
  const { aq, live } = makeReporter({ curKey: "model-A", sizeScale: 0.5 });
  assert.deepEqual(aq("model"), { url: "model-A", size: 0.5 });
  live.curKey = "model-B";
  assert.equal(aq("model").url, "model-B", "a later model swap is reflected on the next query");
});

test("query('facial') is honest when there is no face rig — and always reports exprMode", () => {
  const NONE = { smile: "none", brows: "none" };
  const { aq, live } = makeReporter({ facial: null });
  assert.deepEqual(
    aq("facial"),
    { mode: "none", lipSync: false, exprMode: NONE },
    "no facial -> honest 'none', not a throw"
  );
  live.facial = { mode: "jaw", info: { axis: "x" }, exprMode: { smile: "bones", brows: "none" } };
  assert.deepEqual(
    aq("facial"),
    { mode: "jaw", info: { axis: "x" }, lipSync: true, exprMode: { smile: "bones", brows: "none" } },
    "a real mode reports lipSync=true and the live expression tiers (audit 2026-07-04: exprMode was dropped)"
  );
});

test("query('capabilities') returns the driver's capabilities + expression channels, or null when no rig resolved", () => {
  const caps = { roles: 19, flexRoles: 10 };
  const { aq, live } = makeReporter({ proc: { capabilities: () => caps } });
  // expr must be machine-DISCOVERABLE here: a driver grounding itself against capabilities
  // would otherwise conclude the model has no expressions and never send the verb.
  assert.deepEqual(aq("capabilities"), { ...caps, expressions: { smile: "none", brows: "none" } });
  live.facial = { exprMode: { smile: "morph", brows: "bones" } };
  assert.deepEqual(
    aq("caps").expressions,
    { smile: "morph", brows: "bones" },
    "the 'caps' alias reports the live tiers"
  );
  assert.equal(makeReporter({ proc: null }).aq("capabilities"), null, "no proc -> null, never a fake answer");
});

test("query('rotation') converts the LIVE rig radians to normalized degrees", () => {
  const { aq } = makeReporter();
  const r = aq("rotation"); // rig.rotation.y = PI
  assert.equal(Math.round(r.y), 180, "PI rad -> 180 deg");
  assert.deepEqual(r.saved, { x: 10, y: 20, z: 30 }, "also reports the saved profile rotation");
});

test("query('platforms') maps global platforms back into the current display's local px", () => {
  const { aq } = makeReporter({ curDisp: { x: 1000, y: 2000 }, platforms: [{ gx: 1005, gy: 2007, w: 50 }] });
  assert.deepEqual(aq("platforms"), { count: 1, platforms: [{ px: 5, py: 7, w: 50 }] });
});

test("query('pose') is the proprioception report — the projector's LIVE answer, honest null without a rig", () => {
  // INTENT: a driver must be able to verify where a pose LANDED by numbers (monitor px), not by
  // burning a snap+look round-trip. The reporter delegates to avatar.js's bonePoints projector.
  const { aq, bonePoints } = makeReporter();
  assert.equal(aq("pose"), null, "no rig resolved -> honest null, never a fake skeleton");
  bonePoints.ret = {
    screen: [2560, 1440],
    screenPos: [1200, 1380],
    bones: { head: [1210, 700], left_hand: [1120, 980] },
  };
  assert.deepEqual(aq("pose"), bonePoints.ret, "reports the projector's answer verbatim");
  assert.equal(bonePoints.calls.length, 2, "every query re-projects — positions are read LIVE, never cached");
});

test("an unknown 'what' falls back to full live state (default), never a throw", () => {
  const { aq, EA } = makeReporter();
  EA.state.ret = { size: 1, pos: [0, 0] };
  assert.deepEqual(aq("anything-else"), { size: 1, pos: [0, 0] }, "default branch -> EnigmaAvatar.state()");
});
