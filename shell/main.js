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
// Hotkeys (global) — Ctrl+SHIFT+Alt deliberately (2026-06-12): plain Ctrl+Alt IS AltGr on EU
// keyboard layouts, so e.g. typing "@" on QWERTZ used to QUIT her system-wide.
//   Ctrl+Shift+Alt+A    force full-interactive on/off (e.g. to reach the panel)
//   Ctrl+Shift+Alt+ + / -   resize the avatar
//   Ctrl+Shift+Alt+Q    quit
const { app, BrowserWindow, screen, globalShortcut, ipcMain, dialog, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

// Disable the HTTP/module cache so renderer edits always load fresh — this kills
// the manual `?v=NN` cache-busting ritual in index.html / the JS imports (the
// overlay is local, so reload cost is trivial). Must run before app is ready.
app.commandLine.appendSwitch("disable-http-cache");

// [BLANK-OVERLAY FIX] Chromium's native window-occlusion detection on Windows decides a
// transparent, click-through, always-on-top overlay is "occluded" and STOPS compositing it to
// save power — so the window shows only its native background (no DOM, no WebGL canvas) while
// capturePage() still works (it forces a paint). Symptom seen here: opaque test window showed
// its backgroundColor but never the content; HW-accel on/off made no difference. Disabling the
// occlusion calculation keeps the overlay painting whether or not Windows thinks it's covered.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

// --- window set (one per display) -------------------------------------------
let windows = []; // [{ displayId, win, bounds, isBrain }] — bounds in DIP
let tray = null;
let forceInteractive = false;
let _aiControlOn = true; // mirror of the brain's AI-control kill-switch, for the tray checkbox (brain reports it via "avatar:aiControlState"; the tray toggles it via "avatar:setAiControl")
let _forceThrough = false; // PANIC: force EVERY window click-through so the desktop is always reclaimable (Ctrl+Shift+Alt+C)
// STICKY view-only lock (set by env at launch): she renders but NEVER captures a click on ANY monitor.
// Unlike the _forceThrough panic latch, this is NOT cleared by bringToDisplay/monitor moves — so a
// safe over-a-fullscreen-game test stays click-through even as she's hopped between screens.
const LOCK_THROUGH = process.env.ENIGMA_AVATAR_CLICKTHROUGH === "1";
// YIELD-TO-FULLSCREEN: true while a real fullscreen app (game / video / presentation) owns the
// screen. While set, every window drops always-on-top AND passes all clicks through, so she never
// evicts an exclusive-fullscreen game from the foreground (the "avatar takes over / I get alt-tabbed
// out of my game" bug). Driven by foreground.watch() below; honest no-op if detection is unavailable.
let _fsActive = false;
let _stopFsWatch = null; // stop fn for the fullscreen-state poll (cleared on quit)
const foreground = require("./foreground");
// The avatar's single source-of-truth position, in virtual-desktop DIP. Every window
// renders her relative to its own display origin. Initialised onto the primary at launch.
let gPos = { x: 0, y: 0 };
// Drag is owned by main: while a grab is active we follow the OS cursor (which works across
// every monitor, unlike a per-window pointermove that dies at the window edge).
// SINGLE-OWNER drag (rewrite 2026-06-11, "stuck between monitors" round 3): the GRAB window keeps
// OS mouse capture for the WHOLE drag — interactivity is frozen on it, never handed across the
// bezel (flipping a captured window to click-through mid-drag is what killed the capture, and the
// release then reached either no window or the wrong one, racing a display-id filter). The grab
// window therefore sees every pointermove/pointerup on EVERY monitor. Belt + braces: a real
// pointerup from ANY window ends the drag (definitive: the button is up), and a dead-man watchdog
// drops her if the cursor keeps moving while the grab window has gone silent (capture lost to
// Win+L/UAC with the pointercancel swallowed) — so "glued to the cursor forever" can't happen.
let _drag = null; // { winId, grabX, grabY, beatAt, beatCur } | null  (grab offset in DIP)
let _dragTimer = null;
let _overByWin = new Map(); // winId -> bool (this window's silhouette hit-test result)
let _lastReportByWin = new Map(); // winId -> ms timestamp of its last hit-test report (liveness)
const REPORT_STALE_MS = 2500; // a window 'over' but silent longer than this is treated as a HUNG renderer -> forced click-through (fail-open). Healthy renderers heartbeat ~1x/s from their render loop, so an idle-but-legit hover stays fresh.
let currentModelUrl = null; // last model the brain loaded → peers mirror it

// main.js lives in shell/; the runtime data dirs (models/, props/, assets/), the JSON
// manifests, and index.html all stay at the REPO ROOT, so resolve them off ROOT, not __dirname.
const ROOT = path.resolve(__dirname, "..");
const MODELS_DIR = path.join(ROOT, "models");
const MANIFEST = path.join(ROOT, "models.json");
const { createLibrary } = require("../src/model/library.js");
// Try a python interpreter (only needed to import a .unitypackage) — injected into the library.
function runPython(args) {
  for (const py of [process.env.PYTHON, "python", "py"].filter(Boolean)) {
    const r = spawnSync(py, args, { cwd: ROOT, encoding: "utf8" });
    if (!(r.error && r.error.code === "ENOENT")) return r; // found an interpreter (may still have failed inside)
  }
  return { status: 1, stderr: "Python not found (needed to import .unitypackage)" };
}
// The model library — folder discovery / import / recoverable trash. Pure fs logic, UNIT-TESTED in
// tests/library.test.js; main.js just wires the real paths + the IPC surface. The python CLIs
// (import_unitypackage.py) live in python/.
const lib = createLibrary({
  modelsDir: MODELS_DIR,
  manifestPath: MANIFEST,
  runPython,
  scriptDir: path.join(ROOT, "python"),
});

// --- display + window helpers -----------------------------------------------
function displays() {
  return screen.getAllDisplays();
}
function primaryDisplay() {
  return screen.getPrimaryDisplay();
}
function brainEntry() {
  return windows.find((w) => w.isBrain && w.win && !w.win.isDestroyed()) || liveWindows()[0] || null;
} // never hand back a destroyed window (touching its webContents throws "Object has been destroyed" inside an IPC handler)
function brainWin() {
  const b = brainEntry();
  return b && b.win && !b.win.isDestroyed() ? b.win : null;
}
function entryByWinId(id) {
  return windows.find((w) => w.win && !w.win.isDestroyed() && w.win.webContents.id === id) || null;
}
function liveWindows() {
  return windows.filter((w) => w.win && !w.win.isDestroyed());
}

// DEV auto-reload (opt-in via ENIGMA_DEV=1): reload every live window when a RENDERER source file
// changes, so an edit takes effect without the manual tray "Reload avatar" (the running renderer
// otherwise keeps executing the JS it parsed at startup). Inert for normal users — the desktop
// launcher doesn't set the flag, so there's no fs.watch cost and no surprise reload. SCOPE: renderer
// code only (src/ tree + index.html). MAIN-process files (shell/*.js) can't be hot-swapped in a
// running Electron, so a relaunch is still needed there — we log that rather than pretend. We skip
// *.json on purpose: the app itself writes profiles.json / models.json at runtime, and watching them
// would reload-loop.
function startDevReload() {
  if (process.env.ENIGMA_DEV !== "1") return;
  let timer = null;
  const reloadAll = () => {
    const live = liveWindows();
    for (const w of live) {
      try {
        w.win.reload();
      } catch {}
    }
    console.error("[dev] renderer change -> reloaded " + live.length + " window(s)");
  };
  const onEvt = (_evt, file) => {
    if (!file) return;
    const f = String(file).replace(/\\/g, "/");
    if (/(^|\/)node_modules\//.test(f)) return;
    if (!/\.(js|css|html)$/i.test(f)) return; // renderer source only (json is runtime-written -> would loop)
    clearTimeout(timer);
    timer = setTimeout(reloadAll, 200); // debounce a burst of saves into one reload
  };
  const targets = [
    { dir: path.join(ROOT, "src"), opts: { recursive: true } }, // the renderer engine
    { dir: ROOT, opts: { recursive: false } }, // top-level index.html (non-recursive: don't descend into node_modules/shell)
  ];
  for (const t of targets) {
    try {
      fs.watch(t.dir, t.opts, onEvt);
    } catch (e) {
      console.error("[dev] auto-reload: cannot watch " + t.dir + " (" + (e && e.message) + ")");
    }
  }
  console.error("[dev] auto-reload ON (ENIGMA_DEV=1) - watching src/ + index.html; save a renderer file to reload");
}
// The display (and its overlay window) that currently contains the avatar's base position.
function displayForGlobalPos() {
  return screen.getDisplayNearestPoint({ x: Math.round(gPos.x), y: Math.round(gPos.y) });
}
function windowForGlobalPos() {
  const d = displayForGlobalPos();
  const e = windows.find((w) => w.displayId === d.id) || brainEntry();
  return e && e.win && !e.win.isDestroyed() ? e.win : brainWin();
}
// Clamp a global DIP point into the UNION of all displays (so a drag can't strand her in the void
// between non-aligned monitors, but CAN cross any shared edge). The old version clamped into the
// single NEAREST display, which pinned her base at the first monitor's inner edge -- she could not
// cross onto an adjacent screen ("sticks at the edge" dragging monitor-to-monitor, user 2026-06-25).
// FIX: a point already inside ANY display is accepted untouched, so the base travels freely across
// every shared bezel regardless of layout (side-by-side / stacked / mixed sizes / L-shapes / gaps).
// Only a point outside EVERY display is snapped back onto the nearest one (the raw can't-lose-her
// backstop). The renderer's glide clamp handles the body-aware limits.
function clampToUnion(x, y) {
  const ds = displays();
  for (const d of ds) {
    // inside ANY display (bottom PERMEABLE at 1.4x) -> valid as-is; never fight a cross-bezel drag
    const b = d.bounds;
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height * 1.4) return { x, y };
  }
  // Outside every display (the void between non-aligned monitors, or past the outer rim): snap to the
  // nearest point on the nearest display so a runaway drag is always recoverable. 1.4x bottom kept.
  const d = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  const b = d.bounds,
    m = 8;
  return {
    x: Math.max(b.x + m, Math.min(b.x + b.width - m, x)),
    y: Math.max(b.y + m, Math.min(b.y + b.height * 1.4, y)),
  };
}

function broadcast(channel, payload) {
  for (const w of liveWindows()) {
    try {
      w.win.webContents.send(channel, payload);
    } catch {}
  }
}
function toBrain(channel, payload) {
  const b = brainWin();
  if (b)
    try {
      b.webContents.send(channel, payload);
    } catch {}
}
function toPeers(channel, payload, exceptWinId) {
  for (const w of liveWindows()) {
    if (w.isBrain) continue;
    if (exceptWinId && w.win.webContents.id === exceptWinId) continue;
    try {
      w.win.webContents.send(channel, payload);
    } catch {}
  }
}

// Push the live global position (+ the display she's on) to every window. Each derives its own
// local render position from this. This is the ONE place her position is published.
function publishPos() {
  const d = displayForGlobalPos(),
    b = d.bounds,
    wa = d.workArea || b;
  // drag flag: the brain must SUSPEND any AI glide while main owns a drag (started from any
  // window) — otherwise the two write gPos in turn and she rubber-bands at 125Hz vs 60Hz.
  // wb = the WORK-AREA bottom (taskbar top): the visible desk surface. The overlay window itself
  // gets clamped to the work area by Windows (1392 on a 1440 display), so a floor at the DISPLAY
  // bottom buried her feet in a 48px strip no window can draw ("the walls" round, 2026-06-12).
  broadcast("avatar:pos", {
    gx: gPos.x,
    gy: gPos.y,
    drag: !!(_drag && !_drag.spin),
    disp: { x: b.x, y: b.y, width: b.width, height: b.height, wb: wa.y + wa.height },
  }); // a spin hold is NOT a carry — the grip/glide-suppression consumers must not react to it
}
function setGlobalPos(x, y, clamp) {
  const p = clamp === false ? { x, y } : clampToUnion(x, y);
  gPos.x = p.x;
  gPos.y = p.y;
  publishPos();
  savePosSoon(); // remember her monitor + spot across launches (drag / nudge / tray / bus / "monitor" all route here)
}

// --- click-through arbiter --------------------------------------------------
// At most ONE window is interactive at a time: the one the cursor is physically inside, and only
// when its silhouette hit-test (or forceInteractive) says so. Everything else passes clicks through
// to the desktop. While a drag is active the arbiter is FROZEN on the grab window: it must keep its
// OS mouse capture for the whole drag (capture delivers pointermove/pointerup system-wide, across
// every monitor), and flipping it to click-through is exactly what used to break the capture and
// strand her at the bezel. Nothing re-arbitrates until the drag ends.
function applyInteractive() {
  let cursorDisplayId = null;
  try {
    cursorDisplayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
  } catch {}
  for (const w of liveWindows()) {
    let interactive;
    if (_forceThrough || LOCK_THROUGH || _fsActive)
      interactive = false; // PANIC override / sticky view-only lock / fullscreen-app present: every window click-through, no matter what (reclaim the desktop / never touch a fullscreen game)
    else if (_drag)
      interactive = w.win.webContents.id === _drag.winId; // dragging → the GRAB window only, full-window, until release
    else {
      const id = w.win.webContents.id;
      let over = _overByWin.get(id) || false;
      // Self-heal: a renderer that latched 'over:true' then HUNG keeps capturing clicks over its
      // footprint forever. If its last report is stale, fail OPEN (let clicks through) until it revives.
      if (over && Date.now() - (_lastReportByWin.get(id) || 0) > REPORT_STALE_MS) over = false;
      interactive = (forceInteractive || over) && w.displayId === cursorDisplayId;
    }
    try {
      w.win.setIgnoreMouseEvents(!interactive, { forward: true });
    } catch {}
  }
}

// --- drag (main-owned, follows the OS cursor across every monitor) ----------
function startDrag(winId, grabX, grabY, spin) {
  let cur = { x: 0, y: 0 };
  try {
    cur = screen.getCursorScreenPoint();
  } catch {}
  // spin = an Alt+drag ROTATE hold: same single-owner freeze + watchdog (its capture must survive
  // bezels exactly like a move-drag — it used to stall mid-spin when the arbiter flipped it), but
  // main does NOT follow the cursor (rotation is renderer-local; her position stays put).
  _drag = { winId, grabX, grabY, spin: !!spin, beatAt: Date.now(), beatCur: cur };
  applyInteractive();
  if (_dragTimer) clearInterval(_dragTimer);
  _dragTimer = setInterval(() => {
    if (!_drag) return;
    try {
      const c = screen.getCursorScreenPoint();
      if (!_drag.spin) setGlobalPos(c.x - _drag.grabX, c.y - _drag.grabY);
      // Dead-man watchdog: while capture is alive the grab window heartbeats on every pointermove.
      // If the cursor has wandered far from where it was at the last heartbeat AND the heartbeats
      // have stopped, the capture is gone (Win+L/UAC/etc. with the pointercancel swallowed) — no
      // release event is ever coming. Drop her in place instead of gluing her to the cursor.
      // A motionless held cursor never trips this (distance stays 0, however long the hold).
      const dx = c.x - _drag.beatCur.x,
        dy = c.y - _drag.beatCur.y;
      if (dx * dx + dy * dy > 48 * 48 && Date.now() - _drag.beatAt > 1200) {
        console.error(
          "[main] drag watchdog: grab window went silent while the cursor kept moving -- capture lost, dropping her here"
        );
        endDrag();
      }
    } catch {}
  }, 8); // ~120 Hz cursor-follow; cheap, only while a grab is held
}
function endDrag() {
  if (_dragTimer) {
    clearInterval(_dragTimer);
    _dragTimer = null;
  }
  _drag = null;
  applyInteractive();
  publishPos(); // broadcast the drag=false edge (the brain releases her finger grip on drop)
}

// --- the overlay window set -------------------------------------------------
function makeWindow(display, isBrain, peerCount) {
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    show: false, // NEVER steal focus on launch (default show:true ACTIVATES the new window -> yanks the user out of a fullscreen game). Shown via showInactive() once loaded.
    focusable: isBrain, // the brain hosts the Settings UI (text inputs need focus); peers never steal focus
    // backgroundThrottling:false is ESSENTIAL for a transparent always-on-top overlay: without it
    // Chromium pauses requestAnimationFrame (our render loop / compositor heartbeat) whenever the
    // window isn't focused — so on a secondary monitor she'd stop drawing and a transparent frame
    // reads as "she vanished." Keep the loop alive on every screen regardless of focus.
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // OS-level renderer sandbox. The renderer parses UNTRUSTED model files (FBX/glTF) through
      // three.js loaders; the sandbox confines a renderer-side exploit (no fs / no process spawn).
      // Safe here because preload only uses contextBridge/ipcRenderer (no Node-only requires), which
      // work under the sandbox. Does NOT touch the main-process click-through/panic logic.
      sandbox: true,
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false,
    },
  });
  // "screen-saver" level (user 2026-06-11: "why is it not showing as the top window at all times" —
  // "floating" sits BELOW other topmost apps, and Windows demotes/reorders topmost z on focus
  // churn). A re-assert tick below bumps her back above late-created topmost windows.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Defense-in-depth: the renderer only ever loads the local index.html. Deny any navigation away
  // and any new-window/popup — a crafted model asset must not be able to drive the overlay off-page
  // or spawn a window. (No-op in normal use; closes a renderer-compromise escalation path.)
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(path.join(ROOT, "index.html"));
  // PERSISTENT listener (not .once): a reload (tray "Reload avatar" / the render-process-gone
  // self-heal) re-runs the renderer from scratch — it must receive init/pos/model again or it
  // sits blank forever, never knowing its role (the audited "reload bricks every window" bug).
  win.webContents.on("did-finish-load", () => {
    // A reload re-runs the renderer from scratch; drop any stale hit-test state for this (reused)
    // webContents id so a pre-reload 'over:true' can't keep capturing clicks before the first report.
    _overByWin.delete(win.webContents.id);
    _lastReportByWin.delete(win.webContents.id);
    try {
      if (!win.isVisible()) win.showInactive();
    } catch {} // reveal WITHOUT activating — keeps the user's game/app in the foreground (paired with show:false above)
    try {
      win.webContents.send("avatar:init", {
        isBrain,
        displayId: display.id,
        winId: win.webContents.id,
        origin: { x: b.x, y: b.y },
        bounds: { width: b.width, height: b.height },
        peerCount: peerCount || 0,
      });
      const dh = displayForGlobalPos(),
        dHere = dh.bounds,
        wah = dh.workArea || dHere; // her LIVE display, not this window's (a reload must not teach the window a stale "current display")
      win.webContents.send("avatar:pos", {
        gx: gPos.x,
        gy: gPos.y,
        disp: { x: dHere.x, y: dHere.y, width: dHere.width, height: dHere.height, wb: wah.y + wah.height },
      });
      if (!isBrain && currentModelUrl) win.webContents.send("avatar:model", currentModelUrl); // a late-created / reloaded peer catches up to the live model
    } catch {}
    if (isBrain)
      console.error(
        "[main] displays: " +
          JSON.stringify(
            displays().map((d, i) => ({
              i,
              x: d.bounds.x,
              y: d.bounds.y,
              w: d.bounds.width,
              h: d.bounds.height,
              primary: d.id === primaryDisplay().id,
            }))
          )
      );
  });
  win.webContents.on("unresponsive", () => {
    // Immediate fail-open: don't wait for the staleness watchdog — drop this window's capture NOW.
    console.error("[main] renderer unresponsive (win " + win.webContents.id + ") -> forcing click-through");
    _overByWin.delete(win.webContents.id);
    _lastReportByWin.delete(win.webContents.id);
    applyInteractive();
  });
  // An UNEXPECTED close (Alt+F4 on the focusable brain, or anything else) must not leave a
  // half-dead set (stale windows[] entry, frozen peers, dead bus) — rebuild cleanly. Expected
  // closes (rebuild's own destroys, app quit) are guarded out.
  win.on("closed", () => {
    if (_rebuilding || _quitting) return;
    console.error(
      "[main] window closed unexpectedly (display " +
        display.id +
        (isBrain ? ", BRAIN" : "") +
        ") → rebuilding the window set"
    );
    endDrag();
    rebuildWindowSet();
  });
  return win;
}
function createWindowSet() {
  const ds = displays();
  const primId = primaryDisplay().id;
  // Start her on the primary, centre-lower (feet on the deck) — unless a previous run saved a
  // position, in which case reopen on THAT monitor / spot (clamped into the current union so a
  // since-removed monitor can't strand her off-screen).
  const pb = primaryDisplay().bounds;
  gPos = { x: pb.x + pb.width / 2, y: pb.y + pb.height * 0.62 };
  const savedPos = loadSavedPos();
  if (savedPos) gPos = clampToUnion(savedPos.x, savedPos.y);
  windows = ds.map((d) => ({
    displayId: d.id,
    win: makeWindow(d, d.id === primId, ds.length - 1),
    isBrain: d.id === primId,
  }));
  console.error("[main] created " + windows.length + " overlay window(s), brain on display " + primId);
  applyInteractive();
}
function destroyWindowSet() {
  for (const w of windows) {
    try {
      if (w.win && !w.win.isDestroyed()) w.win.destroy();
    } catch {}
  }
  windows = [];
  _overByWin.clear();
}
// Rebuild on a layout change (monitor plugged/unplugged/rearranged), preserving the model + a sane
// position (clamped into the new union so she's never stranded on a screen that no longer exists).
let _rebuilding = false,
  _rebuildAgain = false,
  _quitting = false;
function rebuildWindowSet() {
  if (_rebuilding) {
    _rebuildAgain = true;
    return;
  } // a display event mid-rebuild (Windows fires metrics changes in cascades) → run ONE trailing rebuild against the settled layout
  _rebuilding = true;
  endDrag(); // the grabbing window is about to die — a drag left active would chase the cursor forever with EVERY window click-through (unrescuable)
  const savedModel = currentModelUrl,
    saved = { x: gPos.x, y: gPos.y };
  destroyWindowSet();
  setTimeout(() => {
    try {
      createWindowSet();
      const c = clampToUnion(saved.x, saved.y);
      gPos = c;
      if (savedModel) currentModelUrl = savedModel; // peers will pick it up via did-finish-load; the brain re-resolves on its own startup
      refreshTrayMenu();
    } catch (err) {
      console.error("[main] rebuild failed:", String(err));
    } finally {
      _rebuilding = false; // a throw must never wedge the guard — it would swallow every future display event AND window-all-closed (zombie app)
      if (_rebuildAgain) {
        _rebuildAgain = false;
        rebuildWindowSet();
      }
    }
  }, 60);
}
// A display-metrics-changed event (taskbar auto-hide, DPI/scale, rotation, resolution) with the SAME
// set of displays needs no destroy/recreate — just move every window onto its display's (possibly
// resized) bounds, re-clamp her base into the new union, and refresh the tray. A full rebuild here
// reloads every renderer (lost pose, off-screen flash) on routine events. Fall back to rebuild ONLY
// when the display id set actually differs from the live windows.
function onDisplayMetricsChanged() {
  if (_rebuilding) {
    rebuildWindowSet();
    return;
  } // mid-rebuild → let rebuild coalesce it (its trailing pass settles the layout)
  const live = liveWindows();
  const curIds = new Set(live.map((w) => w.displayId));
  const newIds = new Set(displays().map((d) => d.id));
  const same = curIds.size === newIds.size && [...curIds].every((id) => newIds.has(id));
  if (!same || live.length !== windows.length) {
    rebuildWindowSet();
    return;
  } // set changed (or a window died) → rebuild
  // Same set: resize each window to its display's current bounds in place (no reload).
  for (const w of live) {
    const d = displays().find((x) => x.id === w.displayId);
    if (!d) {
      rebuildWindowSet();
      return;
    } // a display vanished between the check and here → rebuild
    const b = d.bounds;
    try {
      w.win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    } catch {}
  }
  setGlobalPos(gPos.x, gPos.y); // re-clamp her base into the new union + publish the (possibly changed) work-area bottom
  refreshTrayMenu();
  applyInteractive(); // re-arbitrate click-through against the resized/moved bounds NOW — don't let a window capture on stale geometry until the next renderer tick (~0.16-0.5s)
}

// --- model import (native dialog / drag-drop → the library) -----------------
async function importModel() {
  const res = await dialog.showOpenDialog(brainWin(), {
    title: "Add avatar model",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "3D avatars", extensions: ["glb", "gltf", "vrm", "fbx", "unitypackage"] },
      {
        name: "Model + assets together",
        extensions: ["glb", "gltf", "vrm", "fbx", "bin", "png", "jpg", "jpeg", "tga"],
      },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  return lib.importFiles(res.filePaths, { move: false }); // a DIALOG pick is deliberate → COPY (keep the original where it is)
}
// Persist files DROPPED on the overlay (Electron hands us real paths). A drop = "take this into the
// avatar" → MOVE (relocate into models/, no leftover duplicate).
function importDropped(paths) {
  return lib.importFiles(Array.isArray(paths) ? paths : [], { move: true });
}

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
  const propsDir = path.join(ROOT, "props");
  let name = lib.slug(path.basename(mesh, path.extname(mesh)));
  if (fs.existsSync(path.join(propsDir, name))) {
    for (let i = 2; i < 1000; i++) {
      if (!fs.existsSync(path.join(propsDir, `${name}_${i}`))) {
        name = `${name}_${i}`;
        break;
      }
    }
  } // don't clobber a DIFFERENT prop that slugged to the same name
  const dest = path.join(propsDir, name);
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) {
      try {
        fs.copyFileSync(f, path.join(dest, path.basename(f)));
      } catch {}
    }
  } catch (e) {
    return { error: "copy failed: " + (e && e.message) };
  }
  return { id: name, url: `./props/${name}/${path.basename(mesh)}` };
}

// Remember WHERE she was (which monitor + spot on it) across launches, so "I moved her to my second
// screen" sticks instead of snapping back to the primary every start. Stored as virtual-desktop DIP
// in a tiny state file; RESTORED clamped into the CURRENT display union at launch, so a monitor that
// was unplugged / rearranged since last run can never strand her off-screen (clampToUnion snaps her
// back onto a real display). Debounced because gPos changes at drag frame-rate.
const STATE_PATH = path.join(ROOT, "window-state.json");
let _stateTimer = null;
function loadSavedPos() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (j && j.pos && isFinite(j.pos.x) && isFinite(j.pos.y)) return { x: j.pos.x, y: j.pos.y };
  } catch {} // no file yet / unreadable -> fall back to the primary-centre default
  return null;
}
function savePosSoon() {
  clearTimeout(_stateTimer);
  _stateTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify({ pos: { x: gPos.x, y: gPos.y } }, null, 2));
    } catch {}
  }, 800);
}

// Persist the per-avatar profiles (attachments + tuned physics) as a real file the
// renderer can read back with fetch — durable + portable, unlike localStorage.
function saveProfiles(json) {
  try {
    fs.writeFileSync(path.join(ROOT, "profiles.json"), typeof json === "string" ? json : JSON.stringify(json, null, 2));
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// --- system tray ------------------------------------------------------------
// The overlay is frameless + skipTaskbar, so it has NO taskbar button. The tray is the always-present
// handle: bring her to a chosen monitor, recenter, reload, or quit.
function bringToDisplay(displayId) {
  const d = displays().find((x) => x.id === displayId) || primaryDisplay();
  const b = d.bounds;
  endDrag();
  _forceThrough = false; // an explicit "bring her here" is the discoverable recovery from a latched panic click-through
  setGlobalPos(b.x + b.width / 2, b.y + b.height * 0.62);
  for (const w of liveWindows()) {
    try {
      if (w.win.isMinimized()) w.win.restore();
    } catch {}
  }
  applyTopmost(); // re-assert top — but respects _fsActive, so this never re-evicts a fullscreen game
  refreshTrayMenu();
}
function recoverToPrimary() {
  bringToDisplay(primaryDisplay().id);
}
// TOPMOST POLICY — two opposite jobs, both handled here:
//  - NORMAL desktop: keep every overlay window on top. Windows orders topmost windows by recency, so
//    a topmost window created AFTER her (overlays, OSDs, some apps) sits above her, and focus churn can
//    silently demote the level ("why is it not showing as the top window at all times", 2026-06-11), so
//    we re-assert. moveTop() reorders without stealing focus.
//  - FULLSCREEN app present (_fsActive): DROP always-on-top so we don't evict an exclusive-fullscreen
//    game from the foreground. This is the fix for "the avatar takes over and I have to alt-tab back".
// Called on every fullscreen-state edge (foreground.watch) and on a gentle tick while NOT yielding.
function applyTopmost() {
  for (const w of liveWindows()) {
    try {
      if (_fsActive) {
        if (w.win.isAlwaysOnTop()) w.win.setAlwaysOnTop(false); // yield: let the fullscreen app keep the screen
      } else {
        if (!w.win.isAlwaysOnTop()) w.win.setAlwaysOnTop(true, "screen-saver");
        w.win.moveTop();
      }
    } catch {}
  }
}
// Gentle re-assert tick — only runs the work while NOT yielding to a fullscreen app (no point fighting
// the z-order of a game we're deliberately sitting behind). Edges are handled instantly by the watcher.
let _topmostTimer = setInterval(() => {
  if (!_fsActive) applyTopmost();
}, 4000);
// Self-heal watchdog: re-arbitrate click-through ~1x/s even when no IPC event fires, so a HUNG
// renderer that latched 'over:true' is forced through within ~REPORT_STALE_MS (see applyInteractive).
// Cheap (a few setIgnoreMouseEvents calls); the latch can never outlive a wedged renderer.
let _healTimer = setInterval(applyInteractive, 1000);
function buildTrayMenu() {
  const prim = primaryDisplay().id;
  const list = displays()
    .map((d, index) => ({
      id: d.id,
      index,
      primary: d.id === prim,
      x: d.bounds.x,
      w: d.bounds.width,
      h: d.bounds.height,
    }))
    .sort((a, b) => a.x - b.x);
  const here = displayForGlobalPos().id;
  const monitorItems = list.length
    ? list.map((d, n) => ({
        label: "Monitor " + (n + 1) + " · " + d.w + "×" + d.h + (d.primary ? " (primary)" : ""),
        type: "radio",
        checked: d.id === here,
        click: () => bringToDisplay(d.id),
      }))
    : [{ label: "(no monitors found)", enabled: false }];
  return Menu.buildFromTemplate([
    { label: "Bring to primary monitor", click: recoverToPrimary },
    { label: "Bring to monitor", enabled: list.length > 1, submenu: monitorItems },
    { label: "Drop her (unstick from cursor)", click: endDrag }, // escape hatch: force-release a drag that got stuck to the cursor, without closing her
    {
      label: "Accept AI control (bus)",
      type: "checkbox",
      checked: _aiControlOn,
      click: () => toBrain("avatar:setAiControl", !_aiControlOn), // brain applies + persists, then reports back -> menu re-checks
    }, // kill-switch: untick to make the avatar ignore EVERY command from the AI bus (no surprises)
    { type: "separator" },
    {
      label: "Open Settings",
      click: () => {
        const w = windowForGlobalPos();
        if (w)
          try {
            w.webContents
              .executeJavaScript("window.EnigmaAvatar && EnigmaAvatar.settings && EnigmaAvatar.settings()")
              .catch(() => {});
          } catch {}
      },
    }, // reach Settings on her current monitor even when she can't be clicked
    {
      label: "Reload avatar",
      click: () => {
        for (const w of liveWindows()) {
          try {
            w.win.reload();
          } catch {}
        }
      },
    }, // ALL windows — peers must pick up reloaded code/model too (each re-receives init/pos/model on did-finish-load)
    { type: "separator" },
    {
      label: "Quit Enigma Avatar",
      accelerator: "Ctrl+Shift+Alt+Q",
      click: () => {
        console.error("[main] quit via tray");
        app.quit();
      },
    },
  ]);
}
function refreshTrayMenu() {
  try {
    if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
  } catch {}
}
function createTray() {
  if (tray) return;
  let icon = nativeImage.createFromPath(path.join(ROOT, "assets", "tray.png"));
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty(); // tray still works iconless (Windows shows a default)
  tray = new Tray(icon);
  tray.setToolTip("Enigma Avatar — click to bring to primary, right-click to move / quit");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", recoverToPrimary); // left-click = yank her back onto the primary screen
  tray.on("double-click", recoverToPrimary);
  try {
    tray.displayBalloon({
      title: "Enigma Avatar is running",
      content: "It lives in the system tray. Right-click here to move it between monitors or quit it.",
      iconType: "info",
    });
  } catch {}
}

function init() {
  try {
    app.setAppUserModelId("com.enigma.avatar");
  } catch {} // stable identity → tray balloons + correct grouping
  createWindowSet();
  createTray();

  // Yield to fullscreen apps: drop always-on-top + force click-through whenever a game/video/presentation
  // owns the screen, and reclaim the top the moment it's gone. Fires only on the state edge; no-op (and
  // already logged) if detection is unavailable, in which case she keeps the old always-on-top behavior.
  if (foreground.available) {
    _stopFsWatch = foreground.watch((fs) => {
      _fsActive = fs;
      console.error(
        "[main] fullscreen app " +
          (fs
            ? "detected - overlay yielding (drop always-on-top, pass clicks through)"
            : "gone - overlay reclaiming top")
      );
      applyTopmost();
      applyInteractive();
    });
  } else {
    console.error(
      "[main] fullscreen-yield disabled - overlay may sit over fullscreen games (Ctrl+Shift+Alt+C still force-reclaims the desktop)"
    );
  }

  startDevReload(); // dev-only (ENIGMA_DEV=1): reload renderer windows on a source-file save

  // Click-through hit reports (per window) → arbiter. {over, uiOpen} — uiOpen counts as "over"
  // (an open menu/Settings must keep receiving clicks even off the silhouette) AND makes a PEER
  // window focusable while a panel is open there (text inputs need keyboard focus; peers are
  // otherwise non-focusable so grabbing her on a side monitor never steals the user's focus).
  ipcMain.on("avatar:interactive", (e, p) => {
    const over = p && typeof p === "object" ? !!p.over || !!p.uiOpen : !!p;
    _overByWin.set(e.sender.id, over);
    _lastReportByWin.set(e.sender.id, Date.now()); // liveness beat — keeps a legit idle hover fresh
    const ent = entryByWinId(e.sender.id);
    if (ent && !ent.isBrain) {
      const f = !!(p && typeof p === "object" && p.uiOpen);
      if (ent.uiFocusable !== f) {
        ent.uiFocusable = f;
        try {
          ent.win.setFocusable(f);
        } catch {}
      }
    }
    applyInteractive();
  });
  ipcMain.on("avatar:quit", () => app.quit());
  // The brain reports its AI-control kill-switch state (on launch + on every toggle) so the tray
  // checkbox reflects the truth — including a state the brain restored from a previous session.
  ipcMain.on("avatar:aiControlState", (_e, on) => {
    _aiControlOn = !!on;
    refreshTrayMenu();
  });

  // Global position: the brain pushes glide/nudge/goTo steps here; main re-broadcasts to all windows.
  // Ignored while a DRAG owns the position — a glide step racing the 8ms cursor-follow is a visible blip.
  ipcMain.on("avatar:setGlobalPos", (_e, p) => {
    if (_drag) return;
    if (p && isFinite(p.gx) && isFinite(p.gy)) setGlobalPos(p.gx, p.gy);
  });
  // Grab lifecycle (any window) — main then follows the OS cursor across every monitor.
  // A dragStart while a drag is live OVERWRITES it (latest grab wins) — deliberate (audit #6):
  // after a capture-loss drop the old window's `held` can linger until its next pointerup, and
  // gating new grabs on that stale state would make her ungrabbable. The replaced drag's window
  // can still end the new one only via a real pointerup ("up" is honored from any window).
  ipcMain.on("avatar:dragStart", (e, p) => {
    if (p && isFinite(p.grabX) && isFinite(p.grabY)) startDrag(e.sender.id, p.grabX, p.grabY, !!p.spin);
  });
  // Heartbeat from the GRAB window's pointermove stream — proof its capture is still alive. Feeds
  // the dead-man watchdog in the follow timer (see startDrag).
  ipcMain.on("avatar:dragBeat", (e) => {
    if (!_drag || e.sender.id !== _drag.winId) return;
    _drag.beatAt = Date.now();
    try {
      _drag.beatCur = screen.getCursorScreenPoint();
    } catch {}
  });
  ipcMain.on("avatar:dragEnd", (e, p) => {
    // Release policy (single-owner drag): a real POINTERUP from ANY window ends the drag — it is
    // definitive evidence the button is up, wherever it surfaced. A CANCEL (pointercancel/blur
    // safety nets) is honored only from the GRAB window: with the arbiter frozen nothing should
    // yank the grab window's capture, so a cancel arriving from any OTHER window is the old
    // spurious bezel-handoff class and must not kill a live drag.
    if (_drag && p && p.why === "cancel" && e.sender.id !== _drag.winId) return;
    endDrag();
  });
  // Nudge by a fraction of her CURRENT display (arrow keys / AI) — resolved against the live layout.
  ipcMain.on("avatar:nudge", (_e, p) => {
    if (!p) return;
    const d = displayForGlobalPos().bounds;
    setGlobalPos(gPos.x + (+p.dxFrac || 0) * d.width, gPos.y - (+p.dyFrac || 0) * d.height); // dyFrac +up → screen y decreases
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
  ipcMain.on("avatar:pose", (e, buf) => {
    const b = brainEntry();
    if (b && b.win.webContents.id === e.sender.id) toPeers("avatar:pose", buf);
  });
  // Brain → peers: live physics-prop transforms (the ball), so it renders on whatever monitor she's on.
  ipcMain.on("avatar:props", (e, buf) => {
    const b = brainEntry();
    if (b && b.win.webContents.id === e.sender.id) toPeers("avatar:props", buf);
  });
  // Brain → peers: mirror the model the brain just loaded/switched to.
  ipcMain.on("avatar:modelLoaded", (e, url) => {
    const b = brainEntry();
    if (b && b.win.webContents.id === e.sender.id && url) {
      currentModelUrl = url;
      endDrag();
      console.error("[main] brain loaded " + url + " -> relaying to " + (liveWindows().length - 1) + " peer(s)");
      toPeers("avatar:model", url);
    }
  }); // endDrag: a model switch must never leave her glued to the cursor (a switch mid-grab left _drag chasing the OS cursor forever)
  // Peer cursor → brain (throttled at the sender): the brain runs cursor-look but only its own
  // display delivers pointermove — without this she only watches the cursor on the primary monitor.
  ipcMain.on("avatar:cursor", (e, p) => {
    if (!p || !isFinite(p.gx) || !isFinite(p.gy)) return;
    const b = brainEntry();
    if (b && b.win.webContents.id !== e.sender.id) toBrain("avatar:cursor", { gx: p.gx, gy: p.gy });
  });
  ipcMain.on("avatar:log", (e, m) => console.error("[renderer " + e.sender.id + "] " + m)); // renderer → stdout (multi-window debug)
  // Bus/UI "monitor" command → bring her to a monitor (index, or "next"/"prev"), left→right order.
  ipcMain.on("avatar:monitor", (_e, v) => {
    const list = displays()
      .slice()
      .sort((a, b) => a.bounds.x - b.bounds.x);
    if (!list.length) return;
    const here = Math.max(
      0,
      list.findIndex((d) => d.id === displayForGlobalPos().id)
    );
    let i;
    if (v === "next") i = (here + 1) % list.length;
    else if (v === "prev") i = (here - 1 + list.length) % list.length;
    else {
      const n = parseInt(v, 10);
      i = Number.isInteger(n) && list[n] ? n : here;
    }
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
  const fixModelMod = () => import(require("url").pathToFileURL(path.join(ROOT, "tools", "fix_model.mjs")).href);
  ipcMain.handle("avatar:diagnoseModel", async (_e, id) => {
    try {
      if (!lib.safeId(id)) return { error: "bad model id" };
      const file = meshInModelDir(id);
      if (!file) return { error: "no model file" };
      if (path.extname(file).toLowerCase() === ".fbx") return { error: "FBX repair not supported (re-export as glTF)" };
      const { diagnoseModel } = await fixModelMod();
      return diagnoseModel(file);
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("avatar:repairModel", async (_e, opts = {}) => {
    try {
      const { id, ops } = opts;
      if (!lib.safeId(id)) return { error: "bad model id" };
      const file = meshInModelDir(id);
      if (!file) return { error: "no model file" };
      const newId = lib.freeSlug(id.replace(/_fixed(_\d+)?$/, "") + "_fixed"); // <id>_fixed (disambiguated), never clobbers
      const outDir = path.join(MODELS_DIR, newId);
      const { repairModel } = await fixModelMod();
      const res = repairModel(file, outDir, ops || {});
      const meshName = path.basename(res.out);
      return {
        ok: true,
        id: newId,
        url: `./models/${newId}/${meshName}`,
        label: lib.title(newId),
        renamed: res.renamed,
        repaired: res.repaired,
      };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle("avatar:importModel", importModel);
  ipcMain.handle("avatar:importProp", importProp);
  ipcMain.handle("avatar:removeModel", (_e, id) => lib.removeModel(id));
  ipcMain.handle("avatar:renameModel", (_e, id, label) => lib.renameModel(id, label)); // cosmetic label only (folder = id stays)
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
        const cb = win.getContentBounds(); // clamp the renderer-supplied rect inside the window
        const x = Math.max(0, Math.min(Math.floor(rect.x), cb.width - 1));
        const y = Math.max(0, Math.min(Math.floor(rect.y), cb.height - 1));
        const width = Math.max(1, Math.min(Math.floor(rect.width), cb.width - x));
        const height = Math.max(1, Math.min(Math.floor(rect.height), cb.height - y));
        cap = await win.webContents.capturePage({ x, y, width, height });
      } else cap = await win.webContents.capturePage();
      if (cap.isEmpty()) return { error: "empty capture" }; // never overwrite a good thumbnail with nothing
      const s = cap.getSize();
      const max = Math.max(s.width, s.height);
      if (max > 256)
        cap = cap.resize({
          width: Math.max(1, Math.round((s.width * 256) / max)),
          height: Math.max(1, Math.round((s.height * 256) / max)),
        });
      fs.writeFileSync(path.join(dir, ".thumb.png"), cap.toPNG());
      return { ok: true, thumb: lib.thumbUrl(id) };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });
  // Capture the overlay's OWN web contents (avatar on transparency) to a PNG for inspection. Captures
  // whichever window is currently showing her base, so `snap` works on any monitor.
  ipcMain.handle("avatar:capture", async (_e, opts = {}) => {
    const win = windowForGlobalPos();
    if (!win) return { error: "no window" };
    try {
      const r = opts && opts.rect;
      const image =
        r && r.width > 0 && r.height > 0 ? await win.webContents.capturePage(r) : await win.webContents.capturePage();
      const out = path.join(os.tmpdir(), path.basename((opts && opts.name) || "enigma_snap.png")); // basename → a renderer name can't escape tmp
      fs.writeFileSync(out, image.toPNG());
      const s = image.getSize();
      return { ok: true, path: out, width: s.width, height: s.height };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });

  // Keep the window set correct if the monitor layout changes (plug / unplug / rearrange / DPI).
  // A display ADD/REMOVE changes the window SET → full rebuild (a window must appear/disappear).
  // A metrics change (taskbar auto-hide, scale, rotation, resolution) usually keeps the SAME set of
  // displays → don't destroy+recreate every window (that reloads every renderer, dropping her pose
  // and flashing her off-screen). Instead resize each window in place; only fall back to a full
  // rebuild when the display id set actually differs.
  screen.on("display-added", rebuildWindowSet);
  screen.on("display-removed", rebuildWindowSet);
  screen.on("display-metrics-changed", onDisplayMetricsChanged);

  // All hotkey→renderer calls go through the brain. A pre-load / mid-reload keypress must not raise an
  // unhandled rejection (the brain simply isn't there to act yet).
  const runJS = (code) => {
    const b = brainWin();
    if (b)
      try {
        b.webContents.executeJavaScript(code)?.catch?.(() => {});
      } catch {}
  };
  // register + WARN if the OS rejects a combo (another app owns it) — a silently-dead panic key is the
  // failure we must never ship blind. The C (force click-through) and Q (quit) keys are load-bearing.
  const reg = (accel, cb) => {
    if (!globalShortcut.register(accel, cb))
      console.error(
        `[main] hotkey ${accel} FAILED to register (already taken by another app) -- that shortcut is DEAD`
      );
  };
  reg("CommandOrControl+Shift+Alt+A", () => {
    forceInteractive = !forceInteractive;
    applyInteractive();
  });
  reg("CommandOrControl+Shift+Alt+C", () => {
    _forceThrough = !_forceThrough;
    if (_forceThrough) endDrag();
    console.error(
      "[main] force click-through " +
        (_forceThrough
          ? "ON - desktop reclaimed (drag dropped, avatar ignores all clicks)"
          : "OFF - avatar grabbable again")
    );
    applyInteractive();
  });
  reg("CommandOrControl+Shift+Alt+Q", () => {
    console.error("[main] quit via Ctrl+Alt+Q");
    app.quit();
  });
  reg("CommandOrControl+Shift+Alt+=", () => runJS("EnigmaAvatar.setSize(EnigmaAvatar.size()*1.15)"));
  reg("CommandOrControl+Shift+Alt+-", () => runJS("EnigmaAvatar.setSize(EnigmaAvatar.size()/1.15)"));
  // glide across the screen (works even while click-through — global). Routed through main (it owns position).
  reg("CommandOrControl+Shift+Alt+Left", () => {
    const d = displayForGlobalPos().bounds;
    setGlobalPos(gPos.x - 0.33 * d.width, gPos.y);
  });
  reg("CommandOrControl+Shift+Alt+Right", () => {
    const d = displayForGlobalPos().bounds;
    setGlobalPos(gPos.x + 0.33 * d.width, gPos.y);
  });
  reg("CommandOrControl+Shift+Alt+Up", () => {
    const d = displayForGlobalPos().bounds;
    setGlobalPos(gPos.x, gPos.y - 0.2 * d.height);
  });
  reg("CommandOrControl+Shift+Alt+Down", () => {
    const d = displayForGlobalPos().bounds;
    setGlobalPos(gPos.x, gPos.y + 0.2 * d.height);
  });
  // Hop her to the next monitor (left→right order).
  reg("CommandOrControl+Shift+Alt+M", () => {
    const list = displays()
      .slice()
      .sort((a, b) => a.bounds.x - b.bounds.x);
    if (list.length < 2) return;
    const here = displayForGlobalPos().id;
    const at = Math.max(
      0,
      list.findIndex((d) => d.id === here)
    );
    bringToDisplay(list[(at + 1) % list.length].id);
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindowSet();
  });

  // Crash diagnostics + self-heal — a renderer/GPU *process* death leaves no JS trace; capture the
  // real reason and reload that window instead of dying silently.
  app.on("child-process-gone", (_e, d) => console.error("[main] child-process-gone:", JSON.stringify(d)));
  app.on("render-process-gone", (_e, wc, d) => {
    console.error("[main] render-process-gone:", JSON.stringify(d));
    endDrag(); // a crash mid-drag loses the renderer's pointerup → without this she stays glued to the cursor
    _overByWin.delete(wc.id); // a dead renderer must not leave a stale 'over:true' capturing clicks
    _lastReportByWin.delete(wc.id);
    applyInteractive();
    const e = entryByWinId(wc.id);
    if (e) {
      try {
        e.win.reload();
      } catch (err) {
        console.error("[main] reload failed:", String(err));
      }
    }
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
app.on("before-quit", () => {
  _quitting = true;
  // Flush a pending position write NOW — a move in the last debounce window (0.8s) must still persist.
  if (_stateTimer) {
    clearTimeout(_stateTimer);
    _stateTimer = null;
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify({ pos: { x: gPos.x, y: gPos.y } }, null, 2));
    } catch {}
  }
  console.error("[main] before-quit (uptime " + (process.uptime() | 0) + "s)");
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (_dragTimer) clearInterval(_dragTimer);
  if (_topmostTimer) {
    clearInterval(_topmostTimer);
    _topmostTimer = null;
  }
  if (_healTimer) {
    clearInterval(_healTimer);
    _healTimer = null;
  }
  if (_stopFsWatch) {
    try {
      _stopFsWatch();
    } catch {}
    _stopFsWatch = null;
  }
  try {
    if (tray && !tray.isDestroyed()) tray.destroy();
  } catch {}
  tray = null;
});
app.on("window-all-closed", () => {
  // CRITICAL guard: rebuildWindowSet passes through a zero-window state for ~60ms on EVERY
  // display add/remove/metrics change (monitor sleep, DPI change, resolution switch). Without
  // this check that fired window-all-closed → quit — the app silently killed ITSELF on any
  // display event (the long-unexplained "died cleanly unattended, exit 0" mystery).
  if (_rebuilding) {
    console.error("[main] window-all-closed during rebuild — continuing");
    return;
  }
  console.error("[main] window-all-closed -> quit");
  app.quit();
});
