// Bridges the avatar renderer(s) to the Electron main process.
//
// MULTI-WINDOW model (monitor rewrite): there is ONE transparent overlay window
// PER display, all stationary (never moved across displays — that's the Chromium
// transparent-repaint bug we're escaping). The avatar has a single GLOBAL position
// (virtual-desktop DIP) owned by MAIN; every window renders her at its own local
// offset, so she spans bezels and crosses monitors seamlessly. The PRIMARY display's
// window is the "brain" (runs animation, UI, the AI bus); the others are "peers" that
// mirror the brain's broadcast pose and only support grab.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("avatarIPC", {
  // Per-window hit-test → click-through arbiter in main: {over, uiOpen}. Main keys
  // interactivity on the cursor's display, so only ONE window (the one the cursor is
  // physically in) is ever grabbable at a time — no double-grab at a bezel seam. uiOpen
  // additionally makes a PEER window focusable while its menu/Settings is open (text
  // inputs need keyboard focus; peers are otherwise non-focusable so they never steal it).
  setInteractive: (o) => ipcRenderer.send("avatar:interactive", typeof o === "object" && o ? { over: !!o.over, uiOpen: !!o.uiOpen } : { over: !!o, uiOpen: false }),
  quit: () => ipcRenderer.send("avatar:quit"),
  // Open a native file dialog and import the chosen model into models/ (also
  // handles .unitypackage via import_unitypackage.py). Resolves to {id,label,url},
  // null (cancelled), or {error}. See main.js.
  importModel: () => ipcRenderer.invoke("avatar:importModel"),
  importProp: () => ipcRenderer.invoke("avatar:importProp"),
  // Delete a user-added model (→ models/_trash/, recoverable). Built-ins are guarded in main + UI.
  removeModel: (id) => ipcRenderer.invoke("avatar:removeModel", id),
  // Rename a model (cosmetic manifest label; folder/files untouched). → {ok,id,label}|{error}.
  renameModel: (id, label) => ipcRenderer.invoke("avatar:renameModel", id, label),
  // Live scan of models/ (the source of truth) → [{id,label,url,builtin,thumb}]. No manifest drift.
  listModels: () => ipcRenderer.invoke("avatar:listModels"),
  // Model repair (in-Settings editor): inspect a model's bone names → {nodes,mojibake,recoverable,names},
  // or rewrite them into a repaired COPY → {ok,id,url,label,renamed,repaired}. Original untouched.
  diagnoseModel: (id) => ipcRenderer.invoke("avatar:diagnoseModel", id),
  repairModel: (opts) => ipcRenderer.invoke("avatar:repairModel", opts || {}),
  // Persist files dropped onto the overlay into models/ (drag-drop → permanent add).
  importDropped: (paths) => ipcRenderer.invoke("avatar:importDropped", paths),
  // Capture the current avatar → models/<id>/.thumb.png for the gallery.
  saveThumb: (opts) => ipcRenderer.invoke("avatar:saveThumb", opts || {}),
  saveProfiles: (json) => ipcRenderer.invoke("avatar:saveProfiles", json),
  // Capture the overlay canvas (avatar in isolation) to a PNG for inspection.
  capture: (opts) => ipcRenderer.invoke("avatar:capture", opts || {}),

  // --- multi-window wiring (monitor rewrite) --------------------------------
  // Main tells each window who it is on load: {isBrain, displayId, origin:{x,y}, bounds:{width,height}}
  // (origin/bounds in virtual-desktop DIP for this window's display).
  onInit: (cb) => ipcRenderer.on("avatar:init", (_e, info) => cb(info)),
  // Main broadcasts the avatar's global position (+ the display she's currently on) whenever it
  // changes: {gx,gy, disp:{x,y,width,height}}. Every window derives its local render position from this.
  onGlobalPos: (cb) => ipcRenderer.on("avatar:pos", (_e, p) => cb(p)),
  // Push a new global position to main (brain, when gliding/nudging/goTo) → main re-broadcasts.
  setGlobalPos: (gx, gy) => ipcRenderer.send("avatar:setGlobalPos", { gx, gy }),
  // Grab lifecycle: any window reports a grab (with the grab offset in GLOBAL DIP); main then drives
  // the global position from the OS cursor (works across every monitor) until dragEnd.
  dragStart: (grabX, grabY) => ipcRenderer.send("avatar:dragStart", { grabX, grabY }),
  dragEnd: () => ipcRenderer.send("avatar:dragEnd"),
  // Brain → main → peers: the live skeleton pose (one Float32Array buffer per frame). Transferred.
  sendPose: (buffer) => ipcRenderer.send("avatar:pose", buffer),
  onPose: (cb) => ipcRenderer.on("avatar:pose", (_e, buf) => cb(buf)),
  // Brain → main → peers: live rigid-body PROP transforms (the thrown/dropped ball), relative to her
  // root. Props live only in the brain's scene, so peers render ghost copies → balls show on the
  // monitor she's actually on, not just the primary. [count, per prop: dx,dy,qx,qy,qz,qw,scale].
  sendProps: (buffer) => ipcRenderer.send("avatar:props", buffer),
  onProps: (cb) => ipcRenderer.on("avatar:props", (_e, buf) => cb(buf)),
  // Main → peers: load this model (the brain resolved/switched it). url or "__default__".
  onModel: (cb) => ipcRenderer.on("avatar:model", (_e, url) => cb(url)),
  // Brain → main: the brain finished loading a model → main tells the peers to match.
  modelLoaded: (url) => ipcRenderer.send("avatar:modelLoaded", url),
  // Peer → main → brain: a tap/pet on a peer window (so she still reacts when grabbed on a 2nd monitor).
  poke: () => ipcRenderer.send("avatar:poke"),
  onPoke: (cb) => ipcRenderer.on("avatar:poke", () => cb()),
  // Peer → main → brain: live cursor position in GLOBAL DIP (throttled at the sender) — the
  // brain's cursor-look must see the cursor on EVERY monitor, not just its own display.
  cursorMoved: (gx, gy) => ipcRenderer.send("avatar:cursor", { gx, gy }),
  onCursor: (cb) => ipcRenderer.on("avatar:cursor", (_e, p) => cb(p)),
  // Main → brain: smooth-move intents resolved against the live display layout (anchors/nudge need the
  // global geometry main owns). The brain's bus/keys forward these; main answers by moving the global pos.
  nudge: (dxFrac, dyFrac) => ipcRenderer.send("avatar:nudge", { dxFrac, dyFrac }),
  // Bring her to a monitor (index, or "next"/"prev") — main owns the display layout.
  monitor: (v) => ipcRenderer.send("avatar:monitor", v),
  // UI command relay (menu/Settings on ANY monitor): any window sends a mutation
  // {fn, args}; main stamps the sender and re-broadcasts to EVERY window, where a scope
  // table decides who applies it (brain-only vs all copies). See UI_CMDS in avatar.js.
  uiCmd: (cmd) => ipcRenderer.send("avatar:uiCmd", cmd),
  onUiCmd: (cb) => ipcRenderer.on("avatar:uiCmd", (_e, cmd) => cb(cmd)),
  // Renderer → main stdout (renderer console.log doesn't reach the launcher; this does — for multi-window debug).
  log: (m) => ipcRenderer.send("avatar:log", String(m)),
});
