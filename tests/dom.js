// dom.js — headless DOM harness for the renderer UI tests. Installs a jsdom
// document/window as globals so `ui.js` (which uses bare `document`/`innerWidth`/etc.)
// runs under `node --test`, plus a recording mock of the createUI `api` and a tiny
// THREE stub. This is what makes "do the Settings controls actually work?" TESTABLE
// without launching Electron.
import { JSDOM } from "jsdom";

const DEFAULT_HTML =
  "<!DOCTYPE html><html><body><div id='ui' class='hidden'><div id='status'></div></div></body></html>";

export function installDOM(html = DEFAULT_HTML) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const w = dom.window;
  const saved = {
    document: globalThis.document, Node: globalThis.Node,
    innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight,
    fetch: globalThis.fetch,
  };
  globalThis.document = w.document;
  globalThis.Node = w.Node;
  globalThis.innerWidth = w.innerWidth || 1024;
  globalThis.innerHeight = w.innerHeight || 768;
  globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  if (!w.URL.createObjectURL) w.URL.createObjectURL = () => "blob:mock";
  return {
    window: w, document: w.document,
    cleanup() {
      globalThis.document = saved.document; globalThis.Node = saved.Node;
      globalThis.innerWidth = saved.innerWidth; globalThis.innerHeight = saved.innerHeight;
      globalThis.fetch = saved.fetch;
      try { w.close(); } catch {}
    },
  };
}

// Dispatch a DOM event using the element's own window (avoids needing a global Event).
export function fire(el, type) {
  const W = el.ownerDocument.defaultView;
  el.dispatchEvent(new W.Event(type, { bubbles: true }));
}

// Minimal THREE stub — ui.js only touches SRGBColorSpace, Color (via materials' hex), Vector3.
export class StubColor {
  constructor(hex = "ffffff") { this.hex = String(hex).replace(/^#/, ""); }
  getHexString() { return this.hex; }
  set(h) { this.hex = String(h).replace(/^#/, ""); return this; }
  clone() { return new StubColor(this.hex); }
  copy(o) { this.hex = o.hex; return this; }
}
export const StubTHREE = { SRGBColorSpace: "srgb", Color: StubColor, Vector3: class { set() { return this; } } };

// Recording mock of the createUI `api`. `calls` collects [name, ...args]; `flags` is live so
// tests can assert a checkbox actually flipped the engine toggle. `materials()` deliberately
// includes an UNNAMED material — the case the old name-keyed color list silently dropped.
export function makeApi(over = {}) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const flags = { springOn: true, idleOn: true, lookOn: true, idleBehaviorOn: true, facialOn: true, locked: false };
  const profile = { colors: {}, hue: {}, spring: {} };
  const api = {
    THREE: StubTHREE, BASE_H: 6, rig: { scale: { x: 1 } },
    avatarIPC: {
      quit: rec("quit"),
      removeModel: async (id) => { calls.push(["removeModel", id]); return { ok: true, id, trashed: true }; },
      listModels: async () => { calls.push(["listModels"]); return [
        { id: "roxanne_wolf", label: "Roxanne Wolf", url: "./models/roxanne_wolf/scene.gltf", builtin: false, thumb: "./models/roxanne_wolf/.thumb.png" },
        { id: "c_za", label: "C za", url: "./models/c_za/c_za.glb", builtin: false, thumb: null },
      ]; },
      importModel: async () => { calls.push(["importModel"]); return null; },
      renameModel: async (id, label) => { calls.push(["renameModel", id, label]); return { ok: true, id, label }; },
    },
    setStatus: rec("setStatus"), baseName: (u) => String(u).split("/").pop(), kindOf: () => "prop",
    profileFor: () => profile, flags,
    builtinModels: [],   // no bundled built-ins (copyright) — list comes from listModels()
    getCurKey: () => "./models/roxanne_wolf/scene.gltf",
    getAttachObjs: () => [], getBonesShown: () => false,
    loadModel: rec("loadModel"), attachMesh: rec("attachMesh"),
    detachAttachment: rec("detachAttachment"), clearAttachments: rec("clearAttachments"),
    express: rec("express"), gesture: rec("gesture"), showSkeleton: rec("showSkeleton"),
    getShadowOn: () => true, setShadowOn: rec("setShadowOn"),
    recolor: rec("recolor"), hueShift: rec("hueShift"), springTune: rec("springTune"),
    tuneAttachment: rec("tuneAttachment"), resetColors: rec("resetColors"),
    materials: () => [
      { index: 0, name: "body", mesh: "Body", hex: "#112233" },
      { index: 1, name: null, mesh: "Mesh_1", hex: "#445566" },   // UNNAMED — old name-only list dropped this
    ],
    meshes: () => [
      { index: 0, name: "Body", label: null, visible: true },
      { index: 1, name: "Shirt_A", label: null, visible: true },
      { index: 2, name: null, label: null, visible: false },   // UNNAMED + hidden
    ],
    setMeshVisible: rec("setMeshVisible"), setMeshLabel: rec("setMeshLabel"),
    setYaw: rec("setYaw"), getYaw: () => 0,
    setRotAxis: rec("setRotAxis"), setRot: rec("setRot"), getRot: () => ({ x: 0, y: 0, z: 0 }),
    getRotateMode: () => false, setRotateMode: rec("setRotateMode"),
    hasEyes: () => true, getLookMode: () => "both", setLookMode: rec("setLookMode"),
    // soft-body jiggle areas present on the mock model: an NSFW one, a normal one, and CLOTH
    // (which the Settings panel must split into its own section).
    springRegions: () => [
      { region: "breast", count: 4, weight: 1, nsfw: true },
      { region: "hair", count: 6, weight: 1, nsfw: false },
      { region: "cloth", count: 2, weight: 1, nsfw: false },
    ],
    setRegionWeight: rec("setRegionWeight"),
    morphs: () => [
      { index: 0, name: null, value: 0 },        // unnamed shape key (addressed by index)
      { index: 1, name: "smile", value: 0.5 },
      { index: 2, name: "jawOpen", value: 0, auto: true },   // auto-driven by lip-sync → labeled, no slider
    ],
    setMorphValue: rec("setMorphValue"),
    renameModel: async (id, label) => { calls.push(["renameModel", id, label]); return { ok: true, id, label }; },
    syncInteractive: rec("syncInteractive"),
    ...over,
  };
  return { api, calls, flags, profile };
}
