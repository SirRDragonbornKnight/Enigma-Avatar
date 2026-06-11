// Enigma Avatar — Electron desktop-overlay shell.
// MULTI-WINDOW overlay: ONE transparent, frameless, always-on-top window PER display,
// each covering exactly its own monitor and NEVER moved across displays. The avatar has
// a single GLOBAL position (virtual-desktop DIP) owned HERE in main; every window renders
// her at its own local offset, so she spans bezels and crosses monitors with zero repaint
// tricks. This escapes the unfixable Chromium bug where a transparent (layered) surface
// fails to recomposite on a cross-display setBounds (the old "she vanishes / shows nothing
// between monitors" bug — see git history / TODO #48). The PRIMARY display's window is the
// "brain" (runs the renderer animation, the Settings/menu UI, and the AI bus); the others
// are "peers" that mirror the brain's broadcast pose and only support grab.
//
// Hotkeys (global):
//   Ctrl+Alt+A    force full-interactive on/off (e.g. to reach the panel)
//   Ctrl+Alt+ + / -   resize the avatar
//   Ctrl+Alt+Q    quit
const { app, BrowserWindow, screen, globalShortcut, ipcMain, dialog, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

// Disable the HTTP/module cache so renderer edits always load fresh — this kills
// the manual `?v=NN` cache-busting ritual in index.html / the JS imports (the
// overlay is local, so reload cost is trivial). Must run before app is ready.
app.commandLine.appendSwitch("disable-http-cache");

// --- window set (one per display) -------------------------------------------
let windows = [];                 // [{ displayId, win, bounds, isBrain }] — bounds in DIP
let tray = null;
let forceInteractive = false;
// The avatar's single source-of-truth position, in virtual-desktop DIP. Every window
// renders her relative to its own display origin. Initialised onto the primary at launch.
let gPos = { x: 0, y: 0 };
// Drag is owned by main: while a grab is active we follow the OS cursor (which works across
// every monitor, unlike a per-window pointermove that dies at the window edge).
let _drag = null;                 // { grabX, grabY, winId } | null  (grab offset in DIP)
let _dragTimer = null;
let _overByWin = new Map();       // winId -> bool (this window's silhouette hit-test result)
let currentModelUrl = null;       // last model the brain loaded → peers mirror it

const MODELS_DIR = path.join(__dirname, "models");
const MANIFEST = path.join(__dirname, "models.json");
const { createLibrary } = require("./library.js");
// Try a python interpreter (only needed to import a .unitypackage) — injected into the library.
function runPython(args) {
  for (const py of [process.env.PYTHON, "python", "py"].filter(Boolean)) {
    const r = spawnSync(py, args, { cwd: __dirname, encoding: "utf8" });
    if (!(r.error && r.error.code === "ENOENT")) return r;   // found an interpreter (may still have failed inside)
  }
  return { status: 1, stderr: "Python not found (needed to import .unitypackage)" };
}
// The model library — folder discovery / import / recoverable trash. Pure fs logic, UNIT-TESTED in
// tests/library.test.js; main.js just wires the real paths + the IPC surface.
const lib = createLibrary({ modelsDir: MODELS_DIR, manifestPath: MANIFEST, runPython, scriptDir: __dirname });

// --- display + window helpers -----------------------------------------------
function displays() { return screen.getAllDisplays(); }
function primaryDisplay() { return screen.getPrimaryDisplay(); }
function brainEntry() { return windows.find((w) => w.isBrain && w.win && !w.win.isDestroyed()) || liveWindows()[0] || null; }   // never hand back a destroyed window (touching its webContents throws "Object has been destroyed" inside an IPC handler)
function brainWin() { const b = brainEntry(); return b && b.win && !b.win.isDestroyed() ? b.win : null; }
function entryByWinId(id) { return windows.find((w) => w.win && !w.win.isDestroyed() && w.win.webContents.id === id) || null; }
function liveWindows() { return windows.filter((w) => w.win && !w.win.isDestroyed()); }
// The display (and its overlay window) that currently contains the avatar's base position.
function displayForGlobalPos() { return screen.getDisplayNearestPoint({ x: Math.round(gPos.x), y: Math.round(gPos.y) }); }
function windowForGlobalPos() {
  const d = displayForGlobalPos();
  const e = windows.find((w) => w.displayId === d.id) || brainEntry();
  return e && e.win && !e.win.isDestroyed() ? e.win : brainWin();
}
// Clamp a global DIP point into the union of all displays (so a drag can't strand her in the void
// between non-aligned monitors, but CAN cross any shared edge).
function clampToUnion(x, y) {
  const ds = displays();
  // nearest display to the raw point, then clamp inside it with a small margin so she stays grabbable
  const d = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  const b = d.bounds, m = 24;
  return { x: Math.max(b.x + m, Math.min(b.x + b.width - m, x)), y: Math.max(b.y + m, Math.min(b.y + b.height - m, y)) };
}

function broadcast(channel, payload) { for (const w of liveWindows()) { try { w.win.webContents.send(channel, payload); } catch {} } }
function toBrain(channel, payload) { const b = brainWin(); if (b) try { b.webContents.send(channel, payload); } catch {} }
function toPeers(channel, payload, exceptWinId) {
  for (const w of liveWindows()) { if (w.isBrain) continue; if (exceptWinId && w.win.webContents.id === exceptWinId) continue; try { w.win.webContents.send(channel, payload); } catch {} }
}

// Push the live global position (+ the display she's on) to every window. Each derives its own
// local render position from this. This is the ONE place her position is published.
function publishPos() {
  const d = displayForGlobalPos(), b = d.bounds;
  // drag flag: the brain must SUSPEND any AI glide while main owns a drag (started from any
  // window) — otherwise the two write gPos in turn and she rubber-bands at 125Hz vs 60Hz.
  broadcast("avatar:pos", { gx: gPos.x, gy: gPos.y, drag: !!_drag, disp: { x: b.x, y: b.y, width: b.width, height: b.height } });
}
function setGlobalPos(x, y, clamp) {
  const p = clamp === false ? { x, y } : clampToUnion(x, y);
  gPos.x = p.x; gPos.y = p.y;
  publishPos();
}

// --- click-through arbiter --------------------------------------------------
// At most ONE window is interactive at a time: the one the cursor is physically inside, and only
// when its silhouette hit-test (or forceInteractive) says so. Everything else passes clicks through
// to the desktop. While a drag is active, the grabbing window stays interactive (it must keep OS
// mouse capture to receive the release) regardless of which monitor the cursor has wandered onto.
function applyInteractive() {
  let cursorDisplayId = null;
  try { cursorDisplayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id; } catch {}
  for (const w of liveWindows()) {
    let interactive;
    if (_drag) interactive = w.win.webContents.id === _drag.winId;       // dragging → only the grabber is live
    else {
      const over = _overByWin.get(w.win.webContents.id) || false;
      interactive = (forceInteractive || over) && (w.displayId === cursorDisplayId);
    }
    try { w.win.setIgnoreMouseEvents(!interactive, { forward: true }); } catch {}
  }
}

// --- drag (main-owned, follows the OS cursor across every monitor) ----------
function startDrag(winId, grabX, grabY) {
  _drag = { winId, grabX, grabY };
  applyInteractive();
  if (_dragTimer) clearInterval(_dragTimer);
  _dragTimer = setInterval(() => {
    if (!_drag) return;
    try { const c = screen.getCursorScreenPoint(); setGlobalPos(c.x - _drag.grabX, c.y - _drag.grabY); } catch {}
  }, 8);   // ~120 Hz cursor-follow; cheap, only while a grab is held
}
function endDrag() {
  if (_dragTimer) { clearInterval(_dragTimer); _dragTimer = null; }
  _drag = null;
  applyInteractive();
  publishPos();   // broadcast the drag=false edge (the brain releases her finger grip on drop)
}

// --- the overlay window set -------------------------------------------------
function makeWindow(display, isBrain, peerCount) {
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    transparent: true, frame: false, resizable: false, movable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, fullscreenable: false,
    focusable: isBrain,   // the brain hosts the Settings UI (text inputs need focus); peers never steal focus
    // backgroundThrottling:false is ESSENTIAL for a transparent always-on-top overlay: without it
    // Chromium pauses requestAnimationFrame (our render loop / compositor heartbeat) whenever the
    // window isn't focused — so on a secondary monitor she'd stop drawing and a transparent frame
    // reads as "she vanished." Keep the loop alive on every screen regardless of focus.
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, autoplayPolicy: "no-user-gesture-required", backgroundThrottling: false },
  });
  // Default always-on-top level (NOT "screen-saver": too aggressive for a set of windows, and it
  // fights the user's foreground work). Visible across virtual desktops / over fullscreen.
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "index.html"));
  // PERSISTENT listener (not .once): a reload (tray "Reload avatar" / the render-process-gone
  // self-heal) re-runs the renderer from scratch — it must receive init/pos/model again or it
  // sits blank forever, never knowing its role (the audited "reload bricks every window" bug).
  win.webContents.on("did-finish-load", () => {
    try {
      win.webContents.send("avatar:init", { isBrain, displayId: display.id, winId: win.webContents.id, origin: { x: b.x, y: b.y }, bounds: { width: b.width, height: b.height }, peerCount: peerCount || 0 });
      const dHere = displayForGlobalPos().bounds;   // her LIVE display, not this window's (a reload must not teach the window a stale "current display")
      win.webContents.send("avatar:pos", { gx: gPos.x, gy: gPos.y, disp: { x: dHere.x, y: dHere.y, width: dHere.width, height: dHere.height } });
      if (!isBrain && currentModelUrl) win.webContents.send("avatar:model", currentModelUrl);   // a late-created / reloaded peer catches up to the live model
    } catch {}
    if (isBrain) console.error("[main] displays: " + JSON.stringify(displays().map((d, i) => ({ i, x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height, primary: d.id === primaryDisplay().id }))));
  });
  win.webContents.on("unresponsive", () => console.error("[main] renderer unresponsive (win " + win.webContents.id + ")"));
  // An UNEXPECTED close (Alt+F4 on the focusable brain, or anything else) must not leave a
  // half-dead set (stale windows[] entry, frozen peers, dead bus) — rebuild cleanly. Expected
  // closes (rebuild's own destroys, app quit) are guarded out.
  win.on("closed", () => {
    if (_rebuilding || _quitting) return;
    console.error("[main] window closed unexpectedly (display " + display.id + (isBrain ? ", BRAIN" : "") + ") → rebuilding the window set");
    endDrag();
    rebuildWindowSet();
  });
  return win;
}
function createWindowSet() {
  const ds = displays();
  const primId = primaryDisplay().id;
  // Start her on the primary, centre-lower (feet on the deck).
  const pb = primaryDisplay().bounds;
  gPos = { x: pb.x + pb.width / 2, y: pb.y + pb.height * 0.62 };
  windows = ds.map((d) => ({ displayId: d.id, win: makeWindow(d, d.id === primId, ds.length - 1), isBrain: d.id === primId }));
  console.error("[main] created " + windows.length + " overlay window(s), brain on display " + primId);
  applyInteractive();
}
function destroyWindowSet() {
  for (const w of windows) { try { if (w.win && !w.win.isDestroyed()) w.win.destroy(); } catch {} }
  windows = [];
  _overByWin.clear();
}
// Rebuild on a layout change (monitor plugged/unplugged/rearranged), preserving the model + a sane
// position (clamped into the new union so she's never stranded on a screen that no longer exists).
let _rebuilding = false, _rebuildAgain = false, _quitting = false;
function rebuildWindowSet() {
  if (_rebuilding) { _rebuildAgain = true; return; }   // a display event mid-rebuild (Windows fires metrics changes in cascades) → run ONE trailing rebuild against the settled layout
  _rebuilding = true;
  endDrag();                                           // the grabbing window is about to die — a drag left active would chase the cursor forever with EVERY window click-through (unrescuable)
  const savedModel = currentModelUrl, saved = { x: gPos.x, y: gPos.y };
  destroyWindowSet();
  setTimeout(() => {
    try {
      createWindowSet();
      const c = clampToUnion(saved.x, saved.y); gPos = c;
      if (savedModel) currentModelUrl = savedModel;   // peers will pick it up via did-finish-load; the brain re-resolves on its own startup
      refreshTrayMenu();
    } catch (err) { console.error("[main] rebuild failed:", String(err)); }
    finally {
      _rebuilding = false;   // a throw must never wedge the guard — it would swallow every future display event AND window-all-closed (zombie app)
      if (_rebuildAgain) { _rebuildAgain = false; rebuildWindowSet(); }
    }
  }, 60);
}

// --- model import (native dialog / drag-drop → the library) -----------------
async function importModel() {
  const res = await dialog.showOpenDialog(brainWin(), {
    title: "Add avatar model",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "3D avatars", extensions: ["glb", "gltf", "vrm", "fbx", "unitypackage"] },
      { name: "Model + assets together", extensions: ["glb", "gltf", "vrm", "fbx", "bin", "png", "jpg", "jpeg", "tga", "obj", "dae"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  return lib.importFiles(res.filePaths, { move: false });   // a DIALOG pick is deliberate → COPY (keep the original where it is)
}
// Persist files DROPPED on the overlay (Electron hands us real paths). A drop = "take this into the
// avatar" → MOVE (relocate into models/, no leftover duplicate).
function importDropped(paths) { return lib.importFiles(Array.isArray(paths) ? paths : [], { move: true }); }

// Like importModel, but for a prop/accessory: copy into props/<name>/ and return its
// URL (NOT registered as a model). The renderer attaches it to a bone.
async function importProp() {
  const res = await dialog.showOpenDialog(brainWin(), {
    title: "Attach prop / accessory",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Props / accessories", extensions: ["glb", "gltf", "vrm", "fbx"] },
      { name: "Mesh + assets together", extensions: ["glb", "gltf", "vrm", "fbx", "bin", "png", "jpg", "jpeg", "tga"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  const files = res.filePaths;
  const mesh = files.find((f) => lib.MESH_EXT.has(path.extname(f).toLowerCase()));
  if (!mesh) return { error: "no .glb/.gltf/.vrm/.fbx among the selected files" };
  const propsDir = path.join(__dirname, "props");
  let name = lib.slug(path.basename(mesh, path.extname(mesh)));
  if (fs.existsSync(path.join(propsDir, name))) { for (let i = 2; i < 1000; i++) { if (!fs.existsSync(path.join(propsDir, `${name}_${i}`))) { name = `${name}_${i}`; break; } } }   // don't clobber a DIFFERENT prop that slugged to the same name
  const dest = path.join(propsDir, name);
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) { try { fs.copyFileSync(f, path.join(dest, path.basename(f))); } catch {} }
  } catch (e) { return { error: "copy failed: " + (e && e.message) }; }
  return { id: name, url: `./props/${name}/${path.basename(mesh)}` };
}

// Persist the per-avatar profiles (attachments + tuned physics) as a real file the
// renderer can read back with fetch — durable + portable, unlike localStorage.
function saveProfiles(json) {
  try { fs.writeFileSync(path.join(__dirname, "profiles.json"), typeof json === "string" ? json : JSON.stringify(json, null, 2)); return { ok: true }; }
  catch (e) { return { error: String((e && e.message) || e) }; }
}

// --- system tray ------------------------------------------------------------
// The overlay is frameless + skipTaskbar, so it has NO taskbar button. The tray is the always-present
// handle: bring her to a chosen monitor, recenter, reload, or quit.
function bringToDisplay(displayId) {
  const d = displays().find((x) => x.id === displayId) || primaryDisplay();
  const b = d.bounds;
  endDrag();
  setGlobalPos(b.x + b.width / 2, b.y + b.height * 0.62);
  for (const w of liveWindows()) { try { if (w.win.isMinimized()) w.win.restore(); w.win.setAlwaysOnTop(true, "floating"); } catch {} }
  refreshTrayMenu();
}
function recoverToPrimary() { bringToDisplay(primaryDisplay().id); }
function buildTrayMenu() {
  const prim = primaryDisplay().id;
  const list = displays()
    .map((d, index) => ({ id: d.id, index, primary: d.id === prim, x: d.bounds.x, w: d.bounds.width, h: d.bounds.height }))
    .sort((a, b) => a.x - b.x);
  const here = displayForGlobalPos().id;
  const monitorItems = list.length
    ? list.map((d, n) => ({ label: "Monitor " + (n + 1) + " · " + d.w + "×" + d.h + (d.primary ? " (primary)" : ""), type: "radio", checked: d.id === here, click: () => bringToDisplay(d.id) }))
    : [{ label: "(no monitors found)", enabled: false }];
  return Menu.buildFromTemplate([
    { label: "Bring to primary monitor", click: recoverToPrimary },
    { label: "Bring to monitor", enabled: list.length > 1, submenu: monitorItems },
    { type: "separator" },
    { label: "Reload avatar", click: () => { for (const w of liveWindows()) { try { w.win.reload(); } catch {} } } },   // ALL windows — peers must pick up reloaded code/model too (each re-receives init/pos/model on did-finish-load)
    { type: "separator" },
    { label: "Quit Enigma Avatar", accelerator: "Ctrl+Alt+Q", click: () => { console.error("[main] quit via tray"); app.quit(); } },
  ]);
}
function refreshTrayMenu() { try { if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu()); } catch {} }
function createTray() {
  if (tray) return;
  let icon = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty();   // tray still works iconless (Windows shows a default)
  tray = new Tray(icon);
  tray.setToolTip("Enigma Avatar — click to bring to primary, right-click to move / quit");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", recoverToPrimary);          // left-click = yank her back onto the primary screen
  tray.on("double-click", recoverToPrimary);
  try { tray.displayBalloon({ title: "Enigma Avatar is running", content: "It lives in the system tray. Right-click here to move it between monitors or quit it.", iconType: "info" }); } catch {}
}

function init() {
  try { app.setAppUserModelId("com.enigma.avatar"); } catch {}   // stable identity → tray balloons + correct grouping
  createWindowSet();
  createTray();

  // Click-through hit reports (per window) → arbiter. {over, uiOpen} — uiOpen counts as "over"
  // (an open menu/Settings must keep receiving clicks even off the silhouette) AND makes a PEER
  // window focusable while a panel is open there (text inputs need keyboard focus; peers are
  // otherwise non-focusable so grabbing her on a side monitor never steals the user's focus).
  ipcMain.on("avatar:interactive", (e, p) => {
    const over = p && typeof p === "object" ? !!p.over || !!p.uiOpen : !!p;
    _overByWin.set(e.sender.id, over);
    const ent = entryByWinId(e.sender.id);
    if (ent && !ent.isBrain) {
      const f = !!(p && typeof p === "object" && p.uiOpen);
      if (ent.uiFocusable !== f) { ent.uiFocusable = f; try { ent.win.setFocusable(f); } catch {} }
    }
    applyInteractive();
  });
  ipcMain.on("avatar:quit", () => app.quit());

  // Global position: the brain pushes glide/nudge/goTo steps here; main re-broadcasts to all windows.
  // Ignored while a DRAG owns the position — a glide step racing the 8ms cursor-follow is a visible blip.
  ipcMain.on("avatar:setGlobalPos", (_e, p) => { if (_drag) return; if (p && isFinite(p.gx) && isFinite(p.gy)) setGlobalPos(p.gx, p.gy); });
  // Grab lifecycle (any window) — main then follows the OS cursor across every monitor.
  ipcMain.on("avatar:dragStart", (e, p) => { if (p && isFinite(p.grabX) && isFinite(p.grabY)) startDrag(e.sender.id, p.grabX, p.grabY); });
  ipcMain.on("avatar:dragEnd", () => endDrag());
  // Nudge by a fraction of her CURRENT display (arrow keys / AI) — resolved against the live layout.
  ipcMain.on("avatar:nudge", (_e, p) => {
    if (!p) return; const d = displayForGlobalPos().bounds;
    setGlobalPos(gPos.x + (+p.dxFrac || 0) * d.width, gPos.y - (+p.dyFrac || 0) * d.height);   // dyFrac +up → screen y decreases
  });

  // UI command relay (menu/Settings on ANY monitor): any window sends a mutation {fn,args};
  // main stamps WHO sent it and re-broadcasts to every window. The sender already applied it
  // locally (instant feedback) and skips its own echo; a scope table in avatar.js decides
  // whether the others apply it too (visual state on every copy) or only the brain (animation).
  ipcMain.on("avatar:uiCmd", (e, cmd) => {
    if (!cmd || typeof cmd.fn !== "string" || !Array.isArray(cmd.args)) return;
    broadcast("avatar:uiCmd", { fn: cmd.fn, args: cmd.args, src: e.sender.id });
  });

  // Brain → peers: live skeleton pose, once per brain frame.
  ipcMain.on("avatar:pose", (e, buf) => { const b = brainEntry(); if (b && b.win.webContents.id === e.sender.id) toPeers("avatar:pose", buf); });
  // Brain → peers: live physics-prop transforms (the ball), so it renders on whatever monitor she's on.
  ipcMain.on("avatar:props", (e, buf) => { const b = brainEntry(); if (b && b.win.webContents.id === e.sender.id) toPeers("avatar:props", buf); });
  // Brain → peers: mirror the model the brain just loaded/switched to.
  ipcMain.on("avatar:modelLoaded", (e, url) => { const b = brainEntry(); if (b && b.win.webContents.id === e.sender.id && url) { currentModelUrl = url; console.error("[main] brain loaded " + url + " → relaying to " + (liveWindows().length - 1) + " peer(s)"); toPeers("avatar:model", url); } });
  // Peer → brain: a tap/pet on a peer window → the brain plays a happy reaction.
  ipcMain.on("avatar:poke", () => toBrain("avatar:poke"));
  // Peer cursor → brain (throttled at the sender): the brain runs cursor-look but only its own
  // display delivers pointermove — without this she only watches the cursor on the primary monitor.
  ipcMain.on("avatar:cursor", (e, p) => {
    if (!p || !isFinite(p.gx) || !isFinite(p.gy)) return;
    const b = brainEntry();
    if (b && b.win.webContents.id !== e.sender.id) toBrain("avatar:cursor", { gx: p.gx, gy: p.gy });
  });
  ipcMain.on("avatar:log", (e, m) => console.error("[renderer " + e.sender.id + "] " + m));   // renderer → stdout (multi-window debug)
  // Bus/UI "monitor" command → bring her to a monitor (index, or "next"/"prev"), left→right order.
  ipcMain.on("avatar:monitor", (_e, v) => {
    const list = displays().slice().sort((a, b) => a.bounds.x - b.bounds.x);
    if (!list.length) return;
    const here = Math.max(0, list.findIndex((d) => d.id === displayForGlobalPos().id));
    let i;
    if (v === "next") i = (here + 1) % list.length;
    else if (v === "prev") i = (here - 1 + list.length) % list.length;
    else { const n = parseInt(v, 10); i = Number.isInteger(n) && list[n] ? n : here; }
    bringToDisplay(list[i].id);
  });

  // --- MODEL REPAIR (the in-Settings editor backend) — diagnose + rewrite bone names into a
  // repaired COPY (the original is never touched). Pure-Node GLB patcher in tools/fix_model.mjs.
  const meshInModelDir = (id) => {
    const dir = path.join(MODELS_DIR, id);
    if (!fs.existsSync(dir)) return null;
    const f = fs.readdirSync(dir).find((n) => lib.MESH_EXT.has(path.extname(n).toLowerCase()));
    return f ? path.join(dir, f) : null;
  };
  const fixModelMod = () => import(require("url").pathToFileURL(path.join(__dirname, "tools", "fix_model.mjs")).href);
  ipcMain.handle("avatar:diagnoseModel", async (_e, id) => {
    try {
      if (!lib.safeId(id)) return { error: "bad model id" };
      const file = meshInModelDir(id); if (!file) return { error: "no model file" };
      if (path.extname(file).toLowerCase() === ".fbx") return { error: "FBX repair not supported (re-export as glTF)" };
      const { diagnoseModel } = await fixModelMod();
      return diagnoseModel(file);
    } catch (e) { return { error: String((e && e.message) || e) }; }
  });
  ipcMain.handle("avatar:repairModel", async (_e, opts = {}) => {
    try {
      const { id, ops } = opts;
      if (!lib.safeId(id)) return { error: "bad model id" };
      const file = meshInModelDir(id); if (!file) return { error: "no model file" };
      const newId = lib.freeSlug(id.replace(/_fixed(_\d+)?$/, "") + "_fixed");   // <id>_fixed (disambiguated), never clobbers
      const outDir = path.join(MODELS_DIR, newId);
      const { repairModel } = await fixModelMod();
      const res = repairModel(file, outDir, ops || {});
      const meshName = path.basename(res.out);
      return { ok: true, id: newId, url: `./models/${newId}/${meshName}`, label: lib.title(newId), renamed: res.renamed, repaired: res.repaired };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  });

  ipcMain.handle("avatar:importModel", importModel);
  ipcMain.handle("avatar:importProp", importProp);
  ipcMain.handle("avatar:removeModel", (_e, id) => lib.removeModel(id));
  ipcMain.handle("avatar:renameModel", (_e, id, label) => lib.renameModel(id, label));   // cosmetic label only (folder = id stays)
  ipcMain.handle("avatar:saveProfiles", (_e, json) => saveProfiles(json));
  ipcMain.handle("avatar:listModels", () => lib.discoverModels());
  ipcMain.handle("avatar:importDropped", (_e, paths) => importDropped(paths));
  // Save a model thumbnail to models/<id>/.thumb.png, captured from whichever window is showing her.
  ipcMain.handle("avatar:saveThumb", async (_e, opts = {}) => {
    const { id, rect } = opts;
    const win = windowForGlobalPos();
    if (!win || !lib.safeId(id)) return { error: "bad model id" };
    const dir = path.join(MODELS_DIR, id);
    if (!fs.existsSync(dir)) return { error: "unknown model dir" };
    try {
      let cap;
      if (rect && rect.width > 0 && rect.height > 0) {
        const cb = win.getContentBounds();   // clamp the renderer-supplied rect inside the window
        const x = Math.max(0, Math.min(Math.floor(rect.x), cb.width - 1));
        const y = Math.max(0, Math.min(Math.floor(rect.y), cb.height - 1));
        const width = Math.max(1, Math.min(Math.floor(rect.width), cb.width - x));
        const height = Math.max(1, Math.min(Math.floor(rect.height), cb.height - y));
        cap = await win.webContents.capturePage({ x, y, width, height });
      } else cap = await win.webContents.capturePage();
      if (cap.isEmpty()) return { error: "empty capture" };   // never overwrite a good thumbnail with nothing
      const s = cap.getSize(); const max = Math.max(s.width, s.height);
      if (max > 256) cap = cap.resize({ width: Math.max(1, Math.round(s.width * 256 / max)), height: Math.max(1, Math.round(s.height * 256 / max)) });
      fs.writeFileSync(path.join(dir, ".thumb.png"), cap.toPNG());
      return { ok: true, thumb: lib.thumbUrl(id) };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  });
  // Capture the overlay's OWN web contents (avatar on transparency) to a PNG for inspection. Captures
  // whichever window is currently showing her base, so `snap` works on any monitor.
  ipcMain.handle("avatar:capture", async (_e, opts = {}) => {
    const win = windowForGlobalPos();
    if (!win) return { error: "no window" };
    try {
      const r = opts && opts.rect;
      const image = (r && r.width > 0 && r.height > 0) ? await win.webContents.capturePage(r) : await win.webContents.capturePage();
      const out = path.join(os.tmpdir(), path.basename((opts && opts.name) || "enigma_snap.png"));   // basename → a renderer name can't escape tmp
      fs.writeFileSync(out, image.toPNG());
      const s = image.getSize();
      return { ok: true, path: out, width: s.width, height: s.height };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  });

  // Keep the window set correct if the monitor layout changes (plug / unplug / rearrange / DPI).
  screen.on("display-added", rebuildWindowSet);
  screen.on("display-removed", rebuildWindowSet);
  screen.on("display-metrics-changed", rebuildWindowSet);

  // All hotkey→renderer calls go through the brain. A pre-load / mid-reload keypress must not raise an
  // unhandled rejection (the brain simply isn't there to act yet).
  const runJS = (code) => { const b = brainWin(); if (b) try { b.webContents.executeJavaScript(code)?.catch?.(() => {}); } catch {} };
  globalShortcut.register("CommandOrControl+Alt+A", () => { forceInteractive = !forceInteractive; applyInteractive(); });
  globalShortcut.register("CommandOrControl+Alt+Q", () => { console.error("[main] quit via Ctrl+Alt+Q"); app.quit(); });
  globalShortcut.register("CommandOrControl+Alt+=", () => runJS("EnigmaAvatar.setSize(EnigmaAvatar.size()*1.15)"));
  globalShortcut.register("CommandOrControl+Alt+-", () => runJS("EnigmaAvatar.setSize(EnigmaAvatar.size()/1.15)"));
  // glide across the screen (works even while click-through — global). Routed through main (it owns position).
  globalShortcut.register("CommandOrControl+Alt+Left", () => { const d = displayForGlobalPos().bounds; setGlobalPos(gPos.x - 0.33 * d.width, gPos.y); });
  globalShortcut.register("CommandOrControl+Alt+Right", () => { const d = displayForGlobalPos().bounds; setGlobalPos(gPos.x + 0.33 * d.width, gPos.y); });
  globalShortcut.register("CommandOrControl+Alt+Up", () => { const d = displayForGlobalPos().bounds; setGlobalPos(gPos.x, gPos.y - 0.2 * d.height); });
  globalShortcut.register("CommandOrControl+Alt+Down", () => { const d = displayForGlobalPos().bounds; setGlobalPos(gPos.x, gPos.y + 0.2 * d.height); });
  // Hop her to the next monitor (left→right order).
  globalShortcut.register("CommandOrControl+Alt+M", () => {
    const list = displays().slice().sort((a, b) => a.bounds.x - b.bounds.x);
    if (list.length < 2) return;
    const here = displayForGlobalPos().id;
    const at = Math.max(0, list.findIndex((d) => d.id === here));
    bringToDisplay(list[(at + 1) % list.length].id);
  });
  // Quick motion triggers (work even while click-through). Full set is in the right-click "Move" menu.
  globalShortcut.register("CommandOrControl+Alt+J", () => runJS('EnigmaAvatar.gesture("jump")'));
  globalShortcut.register("CommandOrControl+Alt+F", () => runJS('EnigmaAvatar.gesture("flip")'));
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindowSet(); });

  // Crash diagnostics + self-heal — a renderer/GPU *process* death leaves no JS trace; capture the
  // real reason and reload that window instead of dying silently.
  app.on("child-process-gone", (_e, d) => console.error("[main] child-process-gone:", JSON.stringify(d)));
  app.on("render-process-gone", (_e, wc, d) => {
    console.error("[main] render-process-gone:", JSON.stringify(d));
    endDrag();   // a crash mid-drag loses the renderer's pointerup → without this she stays glued to the cursor
    const e = entryByWinId(wc.id); if (e) { try { e.win.reload(); } catch (err) { console.error("[main] reload failed:", String(err)); } }
  });
}

// Single-instance: a second launch must not stack a second overlay set (or clash with the bus on
// :8765) — surface the existing one and quit.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => recoverToPrimary());
  app.whenReady().then(init);
}

// Quit-reason log — the overlay has died "cleanly" (exit 0, no crash trace) several times unattended;
// these one-liners tell the NEXT investigation whether it was the hotkey/tray/a window closing, or
// something else entirely (a bare exit with none of these logged = external kill / OS shutdown).
app.on("before-quit", () => { _quitting = true; console.error("[main] before-quit (uptime " + (process.uptime() | 0) + "s)"); });
app.on("will-quit", () => { globalShortcut.unregisterAll(); if (_dragTimer) clearInterval(_dragTimer); try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch {} tray = null; });
app.on("window-all-closed", () => {
  // CRITICAL guard: rebuildWindowSet passes through a zero-window state for ~60ms on EVERY
  // display add/remove/metrics change (monitor sleep, DPI change, resolution switch). Without
  // this check that fired window-all-closed → quit — the app silently killed ITSELF on any
  // display event (the long-unexplained "died cleanly unattended, exit 0" mystery).
  if (_rebuilding) { console.error("[main] window-all-closed during rebuild — continuing"); return; }
  console.error("[main] window-all-closed → quit");
  app.quit();
});
