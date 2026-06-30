// state.test.js — the engine state container reads LIVE and writes back. The whole correctness of
// routing the control modules through one `engine` object rests on engine.x always being current
// truth (never a frozen snapshot) and engine.x = v reaching the backing variable. These bite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngineView } from "../src/engine/state.js";

test("getters read the backing variable LIVE (not a frozen snapshot)", () => {
  let proc = { a: 1 };
  let n = 5;
  const engine = makeEngineView({ proc: () => proc, n: () => n });
  assert.equal(engine.proc.a, 1);
  assert.equal(engine.n, 5);
  proc = { a: 2 }; // reassign the backing var…
  n = 9;
  assert.equal(engine.proc.a, 2, "engine.proc must reflect the new value");
  assert.equal(engine.n, 9, "engine.n must reflect the new value");
});

test("setters write back to the backing variable", () => {
  let idle = 0;
  const engine = makeEngineView({ idle: () => idle }, { idle: (v) => (idle = v) });
  engine.idle = 42;
  assert.equal(idle, 42, "setting engine.idle must update the backing var");
  assert.equal(engine.idle, 42, "and the getter must read it back live");
});

test("statics are shared by reference (mutated in place)", () => {
  const pos = { x: 0, y: 0 };
  const engine = makeEngineView({}, {}, { pos });
  assert.equal(engine.pos, pos, "same object identity");
  engine.pos.x = 7;
  assert.equal(pos.x, 7, "mutation flows through to the shared object");
});

test("a read-only getter has no setter (assignment is a no-op / throws in strict, never corrupts)", () => {
  let model = "a";
  const engine = makeEngineView({ model: () => model });
  const desc = Object.getOwnPropertyDescriptor(engine, "model");
  assert.equal(typeof desc.get, "function");
  assert.equal(desc.set, undefined, "no setter on a getter-only field");
});
