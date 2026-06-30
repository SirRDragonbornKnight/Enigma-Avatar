// @ts-check
//
// protocol.js — the AI bus wire protocol as ONE typed contract (Stage 4, item 2).
//
// The bus is JSON {action, ...} over ws://127.0.0.1:8765. Until now the shape of each command lived
// implicitly in four places at once — the JS dispatch (control/bus.js), and the three Python drivers
// (say.py / avbus.py / brain.py) — with every handler hand-parsing its own args. This module is the
// single source of truth: the `BusCommand` union below documents+types every verb, `BusReply` is the
// request/reply envelope, and `Capabilities` is exactly what `query:"capabilities"` returns. The two
// runtime exports (`ACTIONS`, `QUERY_KINDS`) are cross-checked against the live registry/reporter by
// tests/protocol.test.js, so the contract can't silently drift from the implementation.
//
// Adopting it incrementally: bus.js types handleCommand's input as BusCommand; a future step can route
// every inbound message through a single validator built from this file (and code-gen a Python client),
// retiring the per-handler coercion. Types only here — no behavior change.

/** Every command may carry a reqId; a driver that sets one gets a {@link BusReply} back. */
/** @typedef {{ reqId?: number }} WithReqId */

// ── MOTION ───────────────────────────────────────────────────────────────────
/** @typedef {{ action: "pose", parts?: Record<string, number[]>, flex?: Record<string, number[]>, weight?: number, amp?: number, speed?: number, dur?: number, env?: number[], id?: string, clear?: string | boolean } & WithReqId} PoseCommand */
/** @typedef {{ action: "fingers", side?: "L" | "R" | "both", curl?: number | null, spec?: Record<string, number> } & WithReqId} FingersCommand */
/** @typedef {{ action: "look", mode?: "head" | "eyes" | "both", at?: [number, number], px?: number, py?: number, value?: string } & WithReqId} LookCommand */
/** @typedef {{ action: "impulse", region: string, dur?: number } & WithReqId} ImpulseCommand */
/** @typedef {{ action: "perform", text: string } & WithReqId} PerformCommand */

// ── VOICE ────────────────────────────────────────────────────────────────────
/** @typedef {{ action: "say", url: string } & WithReqId} SayCommand */
/** @typedef {{ action: "stop" } & WithReqId} StopCommand */
/** @typedef {{ action: "mouth", value: number } & WithReqId} MouthCommand */
/** @typedef {{ action: "blink", value?: number } & WithReqId} BlinkCommand */

// ── CONJURE + PHYSICS TOY ──────────────────────────────────────────────────────
/** @typedef {{ action: "conjure", url?: string, move?: string, to?: number[] | string, dismiss?: string, clear?: boolean, id?: string, size?: number, at?: number[], bone?: string, dur?: number, float?: number } & WithReqId} ConjureCommand */
/** @typedef {{ action: "ball", name?: string, value?: string } & WithReqId} BallCommand */

// ── PLACE / TRANSFORM ──────────────────────────────────────────────────────────
/** @typedef {{ action: "move", px?: number, py?: number, to?: string, anchor?: string } & WithReqId} MoveCommand */
/** @typedef {{ action: "size", value: number } & WithReqId} SizeCommand */
/** @typedef {{ action: "rotate", x?: number, y?: number, z?: number, axis?: string, deg?: number, value?: number } & WithReqId} RotateCommand */
/** @typedef {{ action: "rotateMode", on?: boolean, value?: boolean } & WithReqId} RotateModeCommand */
/** @typedef {{ action: "monitor", index?: number, value?: number | string } & WithReqId} MonitorCommand */
/** @typedef {{ action: "platform", px?: number, py?: number, w?: number, clear?: boolean } & WithReqId} PlatformCommand */

// ── APPEARANCE ─────────────────────────────────────────────────────────────────
/** @typedef {{ action: "load", url: string } & WithReqId} LoadCommand */
/** @typedef {{ action: "recolor", index?: number, name?: string, color?: string, hex?: string } & WithReqId} RecolorCommand */
/** @typedef {{ action: "resetColors" } & WithReqId} ResetColorsCommand */
/** @typedef {{ action: "hue", name: string, deg?: number, value?: number } & WithReqId} HueCommand */
/** @typedef {{ action: "mesh", index?: number, idx?: number, on?: boolean, value?: boolean } & WithReqId} MeshCommand */
/** @typedef {{ action: "morph", index?: number, idx?: number, value?: number, save?: boolean } & WithReqId} MorphCommand */
/** @typedef {{ action: "regionWeight", region: string, weight?: number, value?: number } & WithReqId} RegionWeightCommand */
/** @typedef {{ action: "outfit", name: string, delete?: boolean, save?: boolean } & WithReqId} OutfitCommand */
/** @typedef {{ action: "springTune", stiffness?: number, drag?: number, gravity?: number } & WithReqId} SpringTuneCommand */
/** @typedef {{ action: "facialTune", jawAxis?: string, jawOpen?: number } & WithReqId} FacialTuneCommand */

// ── PROPS (attachments) ────────────────────────────────────────────────────────
/** @typedef {{ action: "attach", url: string, bone?: string, pos?: number[], rot?: number[], scale?: number | number[] } & WithReqId} AttachCommand */
/** @typedef {{ action: "detach", id?: string } & WithReqId} DetachCommand */
/** @typedef {{ action: "tuneAttachment", id: string, bone?: string, pos?: number[], rot?: number[], scale?: number | number[] } & WithReqId} TuneAttachmentCommand */

// ── SYSTEM / VERIFY-BY-NUMBERS ─────────────────────────────────────────────────
/** @typedef {{ action: "capabilities" } & WithReqId} CapabilitiesCommand */
/** @typedef {{ action: "query", what: QueryKind | "actions" } & WithReqId} QueryCommand */
/** @typedef {{ action: "snap", width?: number } & WithReqId} SnapCommand */
/** @typedef {{ action: "showBones", on?: boolean, value?: boolean } & WithReqId} ShowBonesCommand */
/** @typedef {{ action: "nameBone", bone: string, label?: string } & WithReqId} NameBoneCommand */
/** @typedef {{ action: "highlightBone", bone: string, dur?: number } & WithReqId} HighlightBoneCommand */
/** @typedef {{ action: "settings", open?: boolean } & WithReqId} SettingsCommand */
/** @typedef {{ action: "gallery", open?: boolean } & WithReqId} GalleryCommand */

/**
 * Any command a driver can send over the bus. The body's handleCommand dispatches on `action`;
 * an unknown/garbage action is an honest no-op (never a throw).
 * @typedef {PoseCommand | FingersCommand | LookCommand | ImpulseCommand | PerformCommand
 *   | SayCommand | StopCommand | MouthCommand | BlinkCommand
 *   | ConjureCommand | BallCommand
 *   | MoveCommand | SizeCommand | RotateCommand | RotateModeCommand | MonitorCommand | PlatformCommand
 *   | LoadCommand | RecolorCommand | ResetColorsCommand | HueCommand | MeshCommand | MorphCommand
 *   | RegionWeightCommand | OutfitCommand | SpringTuneCommand | FacialTuneCommand
 *   | AttachCommand | DetachCommand | TuneAttachmentCommand
 *   | CapabilitiesCommand | QueryCommand | SnapCommand | ShowBonesCommand | NameBoneCommand
 *   | HighlightBoneCommand | SettingsCommand | GalleryCommand} BusCommand
 */

/**
 * The overlay's answer to a reqId-bearing command (two-way bus). `result` is whatever the matching
 * handler returned (an answer object, or {error} on a paused/failed/invalid command).
 * @typedef {{ type: "reply", reqId: number, action: string, result: unknown }} BusReply
 */

/**
 * What `query:"capabilities"` reports — what the brain can drive on THIS resolved model. Authored by
 * procedural.js `capabilities()`; the driver grounds its tags against this before sending.
 * @typedef {{
 *   roles: string[],
 *   flexRoles: string[],
 *   channels: { pose: boolean, flex: boolean, look: boolean, layers: boolean, fingers: { L: string[], R: string[] } },
 *   limits: Record<string, unknown>,
 *   units: { offsets: "radians", flex: "radians", limits: "degrees" },
 *   fsign: number
 * }} Capabilities
 */

/**
 * The `what` values `query` understands (answered by control/query.js; "actions" is answered by the
 * registry itself, "state" is the default full-state report).
 * @typedef {"materials" | "meshes" | "regions" | "bones" | "morphs" | "rotation" | "facial" | "model"
 *   | "where" | "capabilities" | "caps" | "roles" | "joints" | "stance" | "iktest" | "grip" | "outfits"
 *   | "platforms" | "bounds" | "weights" | "eyegaze" | "state"} QueryKind
 */

/**
 * The bus move set — one verb per concept (the 2026-06-29 alias purge). This list is the typed
 * vocabulary; tests/protocol.test.js asserts it equals the live registry's COMMANDS keys, so the
 * contract and the implementation cannot drift.
 * @type {readonly string[]}
 */
export const ACTIONS = Object.freeze([
  "attach",
  "ball",
  "blink",
  "capabilities",
  "conjure",
  "detach",
  "facialTune",
  "fingers",
  "gallery",
  "highlightBone",
  "hue",
  "impulse",
  "load",
  "look",
  "mesh",
  "monitor",
  "morph",
  "mouth",
  "move",
  "nameBone",
  "outfit",
  "perform",
  "platform",
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
  "tuneAttachment",
]);

/**
 * The `what` values the `query` verb accepts (plus "actions", handled by the registry). Cross-checked
 * against what control/query.js actually branches on.
 * @type {readonly string[]}
 */
export const QUERY_KINDS = Object.freeze([
  "materials",
  "meshes",
  "regions",
  "bones",
  "morphs",
  "rotation",
  "facial",
  "model",
  "where",
  "capabilities",
  "caps",
  "roles",
  "joints",
  "stance",
  "iktest",
  "grip",
  "outfits",
  "platforms",
  "bounds",
  "weights",
  "eyegaze",
  "state",
]);

/**
 * Is `action` a known bus verb? (unknown -> the registry no-ops, so this is advisory.)
 * @param {unknown} action
 * @returns {boolean}
 */
export function isAction(action) {
  return typeof action === "string" && ACTIONS.includes(action);
}
