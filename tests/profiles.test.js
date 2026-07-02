// profiles.test.js — the per-avatar profile store (src/engine/profiles.js, carve S1-a).
// Intent-first: each test states the rule the store must keep, and would BITE if the rule
// were dropped in a refactor. Fully headless — every impure edge is injected.
import test from "node:test";
import assert from "node:assert/strict";
import { createProfileStore, PROFILE_KEY } from "../src/engine/profiles.js";

function makeStore(over = {}) {
  const calls = { saved: [], errors: [] };
  const mem = {};
  const deps = {
    readJson: async () => null,
    saveIpc: (data) => {
      calls.saved.push(data);
      return Promise.resolve({ ok: true });
    },
    isWriter: () => true,
    mirror: {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => {
        mem[k] = v;
      },
    },
    logError: (m) => calls.errors.push(m),
    getKey: () => "model-a",
    getAttachments: () => [],
    ...over,
  };
  return { store: createProfileStore(deps), calls, mem, deps };
}

const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

test("profileFor is the ONLY door: same key -> same live object, created on first touch", () => {
  const { store } = makeStore();
  const p = store.profileFor("m");
  p.colors = { 0: "#fff" };
  assert.equal(store.profileFor("m").colors[0], "#fff", "second read sees the first write");
  assert.notEqual(store.profileFor("m"), store.profileFor("other"), "keys are independent");
});

test("load precedence: the durable file WINS over the mirror; garbage blobs are rejected", async () => {
  const { store, mem } = makeStore({ readJson: async () => ({ m: { size: 2 } }) });
  mem[PROFILE_KEY] = JSON.stringify({ m: { size: 9 } }); // stale mirror must lose
  await store.loadProfiles();
  assert.equal(store.profileFor("m").size, 2, "profiles.json beat the localStorage mirror");

  const bad = makeStore({ readJson: async () => ["not", "an", "object"] }); // array = garbage
  bad.mem[PROFILE_KEY] = JSON.stringify({ m: { size: 5 } });
  await bad.store.loadProfiles();
  assert.equal(bad.store.profileFor("m").size, 5, "garbage file -> fall back to the mirror");

  const none = makeStore({ readJson: async () => null, mirror: null });
  await none.store.loadProfiles();
  assert.deepEqual(none.store.profileFor("m"), {}, "nothing anywhere -> clean empty store");
});

test("ONE-writer rule: a non-writer (peer) never persists, in ANY channel", async () => {
  const { store, calls, mem } = makeStore({ isWriter: () => false });
  store.profileFor("m").size = 3;
  store.saveProfileSoon();
  await settle();
  assert.equal(calls.saved.length, 0, "no IPC write");
  assert.equal(Object.keys(mem).length, 0, "no mirror write either");
});

test("saveProfileSoon debounces to ONE write and mirrors it", async () => {
  const { store, calls, mem } = makeStore();
  store.profileFor("m").size = 1;
  store.saveProfileSoon();
  store.profileFor("m").size = 2;
  store.saveProfileSoon(); // restarts the timer — only the LAST state lands
  await settle();
  assert.equal(calls.saved.length, 1, "two rapid saves collapse to one write");
  assert.equal(JSON.parse(calls.saved[0]).m.size, 2, "the write carries the final state");
  assert.equal(JSON.parse(mem[PROFILE_KEY]).m.size, 2, "mirror matches the durable write");
});

test("a FAILED persist is LOUD (the bone_limits lesson: silence hides for weeks)", async () => {
  const { store, calls } = makeStore({ saveIpc: () => Promise.resolve({ error: "disk full" }) });
  store.saveProfileSoon();
  await settle();
  assert.equal(calls.errors.length, 1);
  assert.match(calls.errors[0], /disk full/);
  const thrown = makeStore({
    saveIpc: () => Promise.reject(new Error("boom")),
  });
  thrown.store.saveProfileSoon();
  await settle();
  assert.match(thrown.calls.errors[0], /boom/);
});

test("commitAttachments snapshots the live list minus transient blobs (a restored blob: is a dead pointer)", () => {
  const { store } = makeStore({
    getKey: () => "model-x",
    getAttachments: () => [
      {
        id: "a1",
        category: "hat",
        url: "./props/hat.glb",
        bone: "head",
        pos: [0, 1, 0],
        rot: [0, 0, 0],
        scale: 1,
        obj: {},
      },
      { id: "a2", category: "held", url: "blob:app://enigma/dead", bone: "right_hand" },
    ],
  });
  store.commitAttachments();
  const saved = store.profileFor("model-x").attachments;
  assert.equal(saved.length, 1, "the blob attachment was NOT persisted");
  assert.deepEqual(saved[0], {
    id: "a1",
    category: "hat",
    url: "./props/hat.glb",
    bone: "head",
    pos: [0, 1, 0],
    rot: [0, 0, 0],
    scale: 1,
  });
  assert.equal("obj" in saved[0], false, "live three.js handles never leak into the profile");
});
