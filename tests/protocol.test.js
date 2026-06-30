// protocol.test.js — the typed bus contract (src/control/protocol.js) must match the IMPLEMENTATION.
// A types file that drifts from the real dispatch is worse than none. ACTIONS is the documented
// vocabulary; the registry's COMMANDS keys are what actually dispatches. These must be identical, so
// adding/removing a verb in one place without the other fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, QUERY_KINDS, isAction } from "../src/control/protocol.js";
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
  for (const k of ["capabilities", "model", "where", "joints", "bones"]) {
    assert.ok(QUERY_KINDS.includes(k), `query:"${k}" must be a declared kind`);
  }
  // "actions" is answered by the registry itself (Object.keys(COMMANDS)), not the query reporter, so
  // it is deliberately NOT a QueryKind.
  assert.equal(QUERY_KINDS.includes("actions"), false);
});
