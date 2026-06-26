// P4 control channel — the pure parser that turns tagged LLM speech into motion intent + clean text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseControlTags, parseTagArg, resolvePropName } from "../control.js";

test("extracts tags in order and returns clean spoken text", () => {
  const { clean, tags } = parseControlTags("Sure! [happy] let me show you. [conjure:sword] Here it is.");
  assert.equal(clean, "Sure! let me show you. Here it is.");
  assert.deepEqual(tags, [{ type: "happy", arg: null }, { type: "conjure", arg: "sword" }]);
});

test("no tags => text unchanged, empty tag list", () => {
  const { clean, tags } = parseControlTags("Just talking, nothing to do here.");
  assert.equal(clean, "Just talking, nothing to do here.");
  assert.deepEqual(tags, []);
});

test("a tag-only line yields empty speech", () => {
  const { clean, tags } = parseControlTags("[wave]");
  assert.equal(clean, "");
  assert.deepEqual(tags, [{ type: "wave", arg: null }]);
});

test("numeric brackets are NOT treated as tags", () => {
  const { clean, tags } = parseControlTags("Step [1] then step [2].");
  assert.equal(clean, "Step [1] then step [2].");
  assert.deepEqual(tags, []);
});

test("tidies the space a mid-sentence tag leaves before punctuation", () => {
  const { clean } = parseControlTags("I will do it [nod] .");
  assert.equal(clean, "I will do it.");
});

test("null/empty input is safe", () => {
  assert.deepEqual(parseControlTags(null), { clean: "", tags: [] });
  assert.deepEqual(parseControlTags(""), { clean: "", tags: [] });
});

test("parseTagArg: bare token vs key=value pose fields", () => {
  assert.equal(parseTagArg("sword"), "sword");
  // A lone scalar is pitch-only: yaw/roll default to 0 so the spec's no-implicit-motion holds.
  assert.deepEqual(parseTagArg("left_arm=0.8,head=0.2"), { left_arm: [0.8, 0, 0], head: [0.2, 0, 0] });
  assert.equal(parseTagArg(null), null);
});

test("parseTagArg: a triple drives pitch, yaw AND roll", () => {
  // The grammar accepts "role=pitch/yaw/roll" so authored speech can drive all three rotation axes,
  // not just pitch. This is the #16 fix: yaw/roll are no longer hard-zeroed.
  assert.deepEqual(parseTagArg("left_arm=0.8/0.2/-0.3"), { left_arm: [0.8, 0.2, -0.3] });
  assert.deepEqual(
    parseTagArg("left_arm=0.8/0.2/0,head=0/0.5/0"),
    { left_arm: [0.8, 0.2, 0], head: [0, 0.5, 0] },
    "yaw-only and roll-bearing triples both parse per-axis",
  );
});

test("parseTagArg: partial/blank triple slots fall back to 0, extra slots ignored", () => {
  assert.deepEqual(parseTagArg("left_arm=0.8/0.2"), { left_arm: [0.8, 0.2, 0] }, "missing roll -> 0");
  assert.deepEqual(parseTagArg("left_arm=//0.4"), { left_arm: [0, 0, 0.4] }, "blank pitch/yaw -> 0");
  assert.deepEqual(parseTagArg("left_arm=0.1/0.2/0.3/0.9"), { left_arm: [0.1, 0.2, 0.3] }, "4th slot dropped");
});

test("parseTagArg: a non-numeric role value stays a string", () => {
  assert.deepEqual(parseTagArg("target=center"), { target: "center" });
});

test("resolvePropName: bare names map to assets; paths pass through; unknown -> null", () => {
  const assets = { ball: "./props/ball.glb" };
  assert.equal(resolvePropName("ball", assets), "./props/ball.glb", "known bare name -> mapped url");
  assert.equal(resolvePropName("BALL", assets), "./props/ball.glb", "case-insensitive");
  assert.equal(resolvePropName("sword", assets), null, "unknown bare name -> null (never guess an asset)");
  assert.equal(resolvePropName("./props/x.glb", assets), "./props/x.glb", "a path passes through unchanged");
  assert.equal(resolvePropName("", assets), null, "empty -> null");
  assert.equal(resolvePropName(null, assets), null, "null -> null");
});
