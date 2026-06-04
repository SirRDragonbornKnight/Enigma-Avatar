// Enigma Avatar — Electron desktop-overlay shell.
// A transparent, frameless, always-on-top window covering the whole screen, so
// the avatar roams your actual desktop. Clicks pass THROUGH to the desktop
// everywhere EXCEPT when the cursor is over the model (the renderer's hit-test
// tells us via IPC) — so you can grab/drag the avatar but still use your desktop.
//
// Hotkeys (global):
//   Ctrl+Alt+A    force full-interactive on/off (e.g. to reach the panel)
//   Ctrl+Alt+ + / -   resize the avatar
//   Ctrl+Alt+Q    quit
const { app, BrowserWindow, screen, globalShortcut, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

let win = null;
let forceInteractive = false;

const MODELS_DIR = path.join(__dirname, "models");
const MANIFEST = path.join(__dirname, "models.json");
const MESH_EXT = new Set([".glb", ".gltf", ".vrm", ".fbx", ".obj", ".dae"]);
const slug = (s) => ((s || "model").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[_.]+|[_.]+$/g, "").toLowerCase() || "model");
const title = (s) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function applyInteractive(overModel) {
  if (!win) return;
  const interactive = forceInteractive || overModel;
  // forward:true keeps delivering mouse-move so the hit-test still runs while click-through
  win.setIgnoreMouseEvents(!interactive, { forward: true });
}

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    transparent: true, frame: false, resizable: false, movable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, autoplayPolicy: "no-user-gesture-required" },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "index.html"));
  applyInteractive(false); // click-through until the cursor is over the avatar
}

// --- model import (native dialog → copy into models/ + register) ------------
function registerModel(id, label, url) {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch {}
  if (!m || typeof m !== "object") m = {};
  const models = Array.isArray(m.models) ? m.models : [];
  m.models = models.filter((x) => x && x.id !== id).concat([{ id, label, url }]);
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

function runPython(args) {
  for (const py of [process.env.PYTHON, "python", "py"].filter(Boolean)) {
    const r = spawnSync(py, args, { cwd: __dirname, encoding: "utf8" });
    if (!(r.error && r.error.code === "ENOENT")) return r;   // found an interpreter (may still have failed inside)
  }
  return { status: 1, stderr: "Python not found (needed to import .unitypackage)" };
}

async function importModel() {
  const res = await dialog.showOpenDialog(win, {
    title: "Add avatar model",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "3D avatars", extensions: ["glb", "gltf", "vrm", "fbx", "unitypackage"] },
      { name: "Model + assets together", extensions: ["glb", "gltf", "vrm", "fbx", "bin", "png", "jpg", "jpeg", "tga", "obj", "dae"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  const files = res.filePaths;

  // .unitypackage → hand off to the python importer (flattens GUID dirs, registers)
  const pkg = files.find((f) => f.toLowerCase().endsWith(".unitypackage"));
  if (pkg) {
    const name = slug(path.basename(pkg, path.extname(pkg)));
    const r = runPython([path.join(__dirname, "import_unitypackage.py"), pkg, "--name", name, "--register"]);
    if (r.status !== 0) return { error: "unitypackage import failed: " + (r.stderr || r.stdout || "").trim().split("\n").pop() };
    try { const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8")); const e = (m.models || []).find((x) => x.id === name); if (e) return e; } catch {}
    return { error: "imported, but not found in models.json" };
  }

  // plain files: copy the mesh + any sibling assets into models/<name>/
  const mesh = files.find((f) => MESH_EXT.has(path.extname(f).toLowerCase()));
  if (!mesh) return { error: "no .glb/.gltf/.vrm/.fbx among the selected files" };
  const name = slug(path.basename(mesh, path.extname(mesh)));
  const dest = path.join(MODELS_DIR, name);
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) fs.copyFileSync(f, path.join(dest, path.basename(f)));
  } catch (e) { return { error: "copy failed: " + (e && e.message) }; }
  const url = `./models/${name}/${path.basename(mesh)}`;
  registerModel(name, title(name), url);
  return { id: name, label: title(name), url };
}

// Like importModel, but for a prop/accessory: copy into props/<name>/ and return its
// URL (NOT registered as a model). The renderer attaches it to a bone.
async function importProp() {
  const res = await dialog.showOpenDialog(win, {
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
  const mesh = files.find((f) => MESH_EXT.has(path.extname(f).toLowerCase()));
  if (!mesh) return { error: "no .glb/.gltf/.vrm/.fbx among the selected files" };
  const name = slug(path.basename(mesh, path.extname(mesh)));
  const dest = path.join(__dirname, "props", name);
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) fs.copyFileSync(f, path.join(dest, path.basename(f)));
  } catch (e) { return { error: "copy failed: " + (e && e.message) }; }
  return { id: name, url: `./props/${name}/${path.basename(mesh)}` };
}

// Persist the per-avatar profiles (attachments + tuned physics) as a real file the
// renderer can read back with fetch — durable + portable, unlike localStorage.
function saveProfiles(json) {
  try { fs.writeFileSync(path.join(__dirname, "profiles.json"), typeof json === "string" ? json : JSON.stringify(json, null, 2)); return { ok: true }; }
  catch (e) { return { error: String((e && e.message) || e) }; }
}

function init() {
  createWindow();
  ipcMain.on("avatar:interactive", (_e, over) => applyInteractive(over));
  ipcMain.on("avatar:quit", () => app.quit());
  ipcMain.handle("avatar:importModel", importModel);
  ipcMain.handle("avatar:importProp", importProp);
  ipcMain.handle("avatar:saveProfiles", (_e, json) => saveProfiles(json));
  globalShortcut.register("CommandOrControl+Alt+A", () => { forceInteractive = !forceInteractive; applyInteractive(forceInteractive); });
  globalShortcut.register("CommandOrControl+Alt+Q", () => app.quit());
  globalShortcut.register("CommandOrControl+Alt+=", () => win?.webContents.executeJavaScript("EnigmaAvatar.setSize(EnigmaAvatar.size()*1.15)"));
  globalShortcut.register("CommandOrControl+Alt+-", () => win?.webContents.executeJavaScript("EnigmaAvatar.setSize(EnigmaAvatar.size()/1.15)"));
  // glide across the screen (works even while click-through — global)
  globalShortcut.register("CommandOrControl+Alt+Left", () => win?.webContents.executeJavaScript("EnigmaAvatar.nudge(-0.33,0)"));
  globalShortcut.register("CommandOrControl+Alt+Right", () => win?.webContents.executeJavaScript("EnigmaAvatar.nudge(0.33,0)"));
  globalShortcut.register("CommandOrControl+Alt+Up", () => win?.webContents.executeJavaScript("EnigmaAvatar.nudge(0,0.2)"));
  globalShortcut.register("CommandOrControl+Alt+Down", () => win?.webContents.executeJavaScript("EnigmaAvatar.nudge(0,-0.2)"));
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}

// Single-instance: a second launch must not stack a second overlay (or clash with
// the bus on :8765) — focus the existing one and quit (avatar audit #9).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(init);
}

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
