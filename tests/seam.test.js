// seam.test.js â€” the PUBLIC CONTRACT guard for the closure-decomposition refactor.
//
// The `EnigmaAvatar` facade (src/control/surface.js) and the bus move set (src/control/bus.js
// COMMANDS) are the stable seam every driver depends on: the AI bus, devtools/`window.EnigmaAvatar`,
// the CLIs (say.py / avbus.py), the UI, and the hotkeys. The whole point of decomposing
// the avatar.js closure behind this facade is that NONE of those observe a change.
//
// These two frozen lists lock that contract. A refactor that accidentally renames/drops/adds a verb
// fails here LOUDLY. A DELIBERATE vocabulary change is fine â€” it just has to update the fixture in
// the same commit, so the surface change is visible in review instead of silent. (Built with an empty
// deps object: the factories destructure their api lazily and don't invoke any handler at build, so
// the key set is exactly the public surface.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlSurface } from "../src/control/surface.js";
import { createBusRegistry } from "../src/control/bus.js";

// surface.js reads window globals in a couple of method bodies; provide them for the Node test env.
globalThis.innerWidth = globalThis.innerWidth ?? 1920;
globalThis.innerHeight = globalThis.innerHeight ?? 1080;

// The 56 public facade methods (sorted). Generated from the real factory, not hand-counted.
const SURFACE_METHODS = [
  "attach",
  "attachments",
  "ball",
  "bones",
  "bonesShown",
  "capabilities",
  "clearAttachments",
  "conjure",
  "connect",
  "detach",
  "expr",
  "facialTune",
  "fingers",
  "getRotateMode",
  "glideTo",
  "goTo",
  "hueShift",
  "layer",
  "layers",
  "load",
  "matched",
  "materials",
  "meshes",
  "morphCount",
  "morphs",
  "mouth",
  "moveTo",
  "nudge",
  "perform",
  "poke",
  "poseLayer",
  "recolor",
  "resetColors",
  "rotate",
  "rotateMode",
  "rotation",
  "say",
  "setBoneLabel",
  "setMeshLabel",
  "setMeshVisible",
  "setMorph",
  "setMorphValue",
  "setRegionWeight",
  "setRotAxis",
  "setSize",
  "settings",
  "showSkeleton",
  "size",
  "snap",
  "springRegions",
  "springTune",
  "state",
  "stopSpeak",
  "stretch",
  "tuneAttachment",
  "where",
];

// The 40 bus move-set verbs (sorted). One name per concept (no aliases).
const BUS_COMMANDS = [
  "attach",
  "ball",
  "blink",
  "capabilities",
  "conjure",
  "detach",
  "expr", // expression channels smile/brows
  "facialTune",
  "fingers",
  "gallery",
  "highlightBone",
  "hue",
  "impulse",
  "load",
  "mesh",
  "monitor",
  "morph",
  "mouth",
  "move",
  "nameBone",
  "outfit",
  "perform",
  "platform",
  "poke", // soft-mesh dent/bulge along normals
  "pose",
  "query",
  "recolor",
  "regionWeight",
  "resetColors",
  "rotate",
  "rotateMode",
  "say",
  "settings",
  "showBones",
  "size",
  "snap",
  "springTune",
  "stop",
  "stretch", // soft-mesh grab/pull/spring-back
  "tuneAttachment",
];

test("seam: the EnigmaAvatar facade surface is unchanged", () => {
  const ea = createControlSurface({}, {});
  assert.deepEqual(
    Object.keys(ea).sort(),
    SURFACE_METHODS,
    "EnigmaAvatar method set changed â€” if deliberate, update SURFACE_METHODS in the same commit"
  );
});

test("seam: the bus COMMANDS move set is unchanged", () => {
  const { COMMANDS } = createBusRegistry({}, {});
  assert.deepEqual(
    Object.keys(COMMANDS).sort(),
    BUS_COMMANDS,
    "bus move set changed â€” if deliberate, update BUS_COMMANDS in the same commit"
  );
});
