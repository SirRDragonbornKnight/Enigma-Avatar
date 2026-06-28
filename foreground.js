// foreground.js — "is a real fullscreen app (game / video / presentation) on screen right now?"
//
// WHY THIS EXISTS: the overlay is always-on-top at the "screen-saver" level and used to re-assert
// that every 4s. An always-on-top window forced above an EXCLUSIVE-fullscreen game evicts the game
// from exclusive mode -> Windows minimizes it -> the user gets yanked to the desktop and has to
// alt-tab back ("the avatar takes over"). The fix is to YIELD (drop always-on-top) whenever a
// fullscreen app owns the screen, and reclaim the top once it's gone. This module is the detector.
//
// THE SIGNAL: SHQueryUserNotificationState (shell32) — the exact API Windows itself uses to decide
// whether to suppress notification toasts during games / presentations. It is a STATE QUERY, not an
// event: there is no OS notification for "fullscreen changed" (the shell polls it too), and a
// foreground-change hook would MISS an in-place toggle (alt-enter while the game stays focused). So a
// light poll of this state is both simpler and MORE correct than a window-event hook. The query is a
// single syscall (~microseconds); polled at 1s it is effectively free, and we only act on the edge.
//
// FAIL-SAFE: on non-Windows, or if the FFI / DLL fails to load, this reports "not fullscreen" forever
// and logs once. The overlay then keeps its old always-on-top behavior (honest degrade, not a crash).

let _available = false;
let _SHQuery = null;

try {
  if (process.platform === "win32") {
    const koffi = require("koffi");
    const shell32 = koffi.load("shell32.dll");
    // HRESULT SHQueryUserNotificationState(QUERY_USER_NOTIFICATION_STATE *pquns);  (an int enum out-param)
    _SHQuery = shell32.func("int __stdcall SHQueryUserNotificationState(_Out_ int *pquns)");
    _available = true;
  } else {
    console.error("[foreground] not win32 - fullscreen yield disabled (overlay stays always-on-top)");
  }
} catch (e) {
  console.error("[foreground] fullscreen detection unavailable (" + (e && e.message) + ") - overlay will NOT yield to fullscreen apps");
}

// QUNS_* states that mean "a fullscreen / presentation app owns the screen" -> the overlay must yield:
//   2 QUNS_BUSY (full-screen app or presentation mode), 3 QUNS_RUNNING_D3D_FULL_SCREEN (exclusive game),
//   4 QUNS_PRESENTATION_MODE, 7 QUNS_APP (UWP store app full screen).
// Everything else (1 NOT_PRESENT, 5 ACCEPTS_NOTIFICATIONS = normal desktop, 6 QUIET_TIME) = don't yield.
const FULLSCREEN_STATES = new Set([2, 3, 4, 7]);

// Pure: does this QUNS_* enum value mean "yield to a fullscreen app"? (exported for tests)
function isFullscreenState(n) { return FULLSCREEN_STATES.has(n); }

function queryFullscreen() {
  if (!_available) return false;
  try {
    const out = [0];
    const hr = _SHQuery(out);           // S_OK (0) on success; out[0] = QUNS_* enum
    if (hr !== 0) return false;         // query failed -> assume normal so she stays visible/on-top
    return isFullscreenState(out[0]);
  } catch {
    return false;                       // any FFI hiccup -> treat as normal (never strand her hidden on a fluke)
  }
}

// Pure: wrap onChange so it fires only when the boolean flips (exported for tests). Primed to null,
// so the very first value always counts as an edge.
function makeEdgeDetector(onChange) {
  let last = null;
  return (v) => { if (v !== last) { last = v; try { onChange(v); } catch {} } };
}

// Poll the OS fullscreen state and call onChange(bool) only on the transition edge. Returns a stop fn.
// If detection is unavailable this is a no-op (onChange never fires; _fsActive stays false). `queryFn`
// is injectable for tests; production uses the real SHQueryUserNotificationState poll.
function watch(onChange, intervalMs = 1000, queryFn = queryFullscreen) {
  if (!_available) return () => {};
  const feed = makeEdgeDetector(onChange);
  const tick = () => feed(queryFn());
  tick();                               // prime immediately (handles "a game is already fullscreen at launch")
  const t = setInterval(tick, intervalMs);
  if (t.unref) t.unref();               // never keep the process alive just for this poll
  return () => { try { clearInterval(t); } catch {} };
}

module.exports = { watch, queryFullscreen, isFullscreenState, makeEdgeDetector, get available() { return _available; } };
