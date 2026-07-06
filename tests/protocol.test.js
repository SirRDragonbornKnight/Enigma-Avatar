// protocol.test.js — the typed bus contract (src/control/protocol.js) must match the IMPLEMENTATION.
// A types file that drifts from the real dispatch is worse than none. ACTIONS is the documented
// vocabulary; the registry's COMMANDS keys are what actually dispatches. These must be identical, so
// adding/removing a verb in one place without the other fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, QUERY_KINDS, isAction, validateCommand } from "../src/control/protocol.js";
import { createBusRegistry } from "../src/control/bus.js";

test("protocol ACTIONS == the live bus registry's dispatch table", () => {
  const { COMMANDS } = createBusRegistry({}, {});
  assert.deepEqual(
    [...ACTIONS].sort(),
    Object.keys(COMMANDS).sort(),
    "protocol.ACTIONS and bus.js COMMANDS drifted — update both (the contract must match the code)"
  );
});

test("isAction recognizes known verbs and rejects everything else", () => {
  assert.equal(isAction("pose"), true);
  assert.equal(isAction("perform"), true);
  assert.equal(isAction("nope"), false);
  assert.equal(isAction(""), false);
  assert.equal(isAction(null), false);
  assert.equal(isAction(42), false);
});

test("QUERY_KINDS covers the load-bearing reports and excludes the registry-handled 'actions'", () => {
  for (const k of ["capabilities", "model", "where", "pose", "joints", "bones"]) {
    assert.ok(QUERY_KINDS.includes(k), `query:"${k}" must be a declared kind`);
  }
  // "actions" is answered by the registry itself (Object.keys(COMMANDS)), not the query reporter, so
  // it is deliberately NOT a QueryKind.
  assert.equal(QUERY_KINDS.includes("actions"), false);
});

test("validateCommand accepts well-formed commands and names what's wrong otherwise", () => {
  assert.deepEqual(validateCommand({ action: "pose" }), { ok: true, command: { action: "pose" } }); // all-optional verb
  assert.equal(validateCommand({ action: "say", url: "file:///x.wav" }).ok, true);
  assert.equal(validateCommand({ action: "query", what: "model" }).ok, true);
  assert.equal(validateCommand({ action: "query" }).ok, true); // bare query = full state() (query.js fall-through) — the contract must not reject what the system answers

  // not an object / no action
  assert.deepEqual(validateCommand(null), { ok: false, reason: "not an object" });
  assert.deepEqual(validateCommand("pose"), { ok: false, reason: "not an object" });
  assert.equal(validateCommand({}).ok, false);

  // unknown verb
  const u = validateCommand({ action: "teleport" });
  assert.equal(u.ok, false);
  assert.match(u.reason, /unknown action 'teleport'/);

  // known verb missing its required field
  const m = validateCommand({ action: "say" });
  assert.equal(m.ok, false);
  assert.match(m.reason, /'say' requires 'url'/);
  assert.equal(validateCommand({ action: "tuneAttachment" }).ok, false);
});

test("validateCommand is STRUCTURAL only — it does NOT coerce or reject loose arg values", () => {
  // A non-numeric size is structurally valid (the field is present); coercing/clamping it is the
  // engine boundary's job (applySize), not the validator's. This locks the guard-at-the-boundary split.
  assert.equal(validateCommand({ action: "size", value: "huge" }).ok, true);
  assert.equal(validateCommand({ action: "mouth", value: NaN }).ok, true);
});

test("required-field presence means USABLE presence: null and empty-string are named errors, not silent dispatch", () => {
  // {action:"say", url:null} used to validate, dispatch, hit the handler's truthiness guard, and
  // answer a reqId caller with silent `undefined` — the exact non-answer the strict wire forbids.
  for (const bad of [null, "", "   "]) {
    const r = validateCommand({ action: "say", url: bad });
    assert.equal(r.ok, false, `say url=${JSON.stringify(bad)} must be rejected`);
    assert.match(r.reason, /'say' requires 'url'/);
  }
  assert.equal(validateCommand({ action: "load", url: "" }).ok, false);
  // a present-but-numeric value stays fine (mouth value 0 is legal)
  assert.equal(validateCommand({ action: "mouth", value: 0 }).ok, true);
});

test("recolor requires index OR name (one-of-two beyond the single-field map)", () => {
  const r = validateCommand({ action: "recolor" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /'recolor' requires 'index' or 'name'/);
  assert.equal(validateCommand({ action: "recolor", index: 0 }).ok, true);
  assert.equal(validateCommand({ action: "recolor", name: "Hair" }).ok, true);
});

test("a garbage query.what is a named error; missing what and the registry-handled 'actions' stay valid", () => {
  const g = validateCommand({ action: "query", what: "platfroms" }); // the typo class
  assert.equal(g.ok, false);
  assert.match(g.reason, /unknown query what 'platfroms'/);
  assert.equal(validateCommand({ action: "query" }).ok, true);
  assert.equal(validateCommand({ action: "query", what: "actions" }).ok, true);
});
