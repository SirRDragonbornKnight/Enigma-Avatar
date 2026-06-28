// Regression net for the fullscreen-yield safety behavior (foreground.js). The overlay must DROP
// always-on-top while a real fullscreen app (game / video / presentation) owns the screen, so it
// never evicts an exclusive-fullscreen game from the foreground ("the avatar takes over and I have
// to alt-tab back into my game"). These lock the pure decision pieces; the live
// SHQueryUserNotificationState poll itself is validated separately under Electron.
import { test } from "node:test";
import assert from "node:assert/strict";
import foreground from "../foreground.js";

const { isFullscreenState, makeEdgeDetector, queryFullscreen, watch } = foreground;

test("isFullscreenState — yields only on the fullscreen/presentation QUNS states", () => {
  // 2 BUSY (full-screen app/presentation), 3 D3D exclusive, 4 presentation, 7 UWP fullscreen -> YIELD
  for (const s of [2, 3, 4, 7]) assert.equal(isFullscreenState(s), true, `state ${s} should yield`);
  // 1 NOT_PRESENT, 5 ACCEPTS_NOTIFICATIONS (normal desktop), 6 QUIET_TIME -> stay on top
  for (const s of [1, 5, 6]) assert.equal(isFullscreenState(s), false, `state ${s} should NOT yield`);
  // garbage / unknown -> never yield (fail toward staying visible-on-top, honest)
  for (const s of [0, -1, 99, NaN]) assert.equal(isFullscreenState(s), false, `state ${s} should NOT yield`);
});

test("makeEdgeDetector — fires onChange only on the transition edge, with the new value", () => {
  const calls = [];
  const feed = makeEdgeDetector((v) => calls.push(v));
  feed(false); feed(false);   // primed to null -> first value is an edge, then a no-op
  feed(true);  feed(true);    // one edge
  feed(false);                // one edge
  assert.deepEqual(calls, [false, true, false]);
});

test("makeEdgeDetector — an onChange that throws never breaks the detector", () => {
  let n = 0;
  const feed = makeEdgeDetector(() => { n++; throw new Error("boom"); });
  assert.doesNotThrow(() => { feed(true); feed(false); });
  assert.equal(n, 2);   // still advanced past the throwing edge
});

test("queryFullscreen — returns a boolean and never throws", () => {
  assert.equal(typeof queryFullscreen(), "boolean");   // live OS query (or false if detection unavailable)
});

test("watch — edge-only delivery through the poll loop (injected query)",
  { skip: foreground.available ? false : "fullscreen detection unavailable on this platform" },
  async () => {
    const seq = [false, false, true, true, false];   // duplicates must collapse to 3 edges
    let i = 0;
    const fakeQuery = () => seq[Math.min(i++, seq.length - 1)];
    const calls = [];
    const stop = watch((v) => calls.push(v), 5, fakeQuery);
    await new Promise((r) => setTimeout(r, 80));       // let several 5ms ticks consume the sequence
    stop();
    assert.deepEqual(calls, [false, true, false]);
  });
