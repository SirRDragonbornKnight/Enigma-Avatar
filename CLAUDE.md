# CLAUDE.md — Enigma Avatar

Guidance for Claude Code working in this repo. Keep it short.

## What this is

**Enigma Avatar** — an Electron + Three.js transparent, always-on-top, click-through desktop pet that
drives any `.glb`/`.gltf`/`.vrm`/`.fbx` with **pure procedural** motion (no canned animation),
composited from masked, weighted pose/flex layers fed over a local WebSocket bus. It is the **body**;
**Enigma Engine** (a from-scratch LLM, separate repo at `C:\Users\SirKn\Enigma Engine\`) is an optional
**brain** that can drive it. Split out of that monorepo 2026-06-28 (full history preserved). The two
meet ONLY at the bus (`ws://127.0.0.1:8765`).

## Setup / build / test — run these first

- Node tests: `node --test` (Node built-in runner; ~280 tests, some skip without the real model
  library). `node --check <file>.js` for a quick syntax pass.
- Python tests: `python -m pytest tests/ -q` (bus origin-gate + reply routing, protocol mirror,
  bone data, voice service).
- **Live smoke: `npm run smoke`** -- launches the REAL overlay, drives it over the bus, and asserts
  numeric receipts (boot / limits / strict wire / elbow bend / snap), then cleans up. Run it after
  any change a unit test can't see (shell, protocol handler, boot, bus). `--keep` leaves her up.
- Console output must be **ASCII** (the Windows cp1252 console can't print `→`, `—`, etc.).
- Launch the overlay: `Start-Avatar.ps1` (or `Enigma Avatar.bat`). Portable Node + Electron install on
  first run. No admin.

## Load-bearing rules (do not weaken)

- **Authoritative spec lives OUTSIDE the repo:** `C:\Users\SirKn\3d Avatar\The project is to make a 3d
model t.txt` (REV 6). Models live in `C:\Users\SirKn\3d Avatar\Avatars\`. Judge/recode against the
  SPEC's intent, NOT against what the code currently does — passing tests often just enshrine wrong
  behavior. Loading from that external dir MUST keep working (no path-restricting the loader).
- **Control plane = the local WebSocket bus** (`python/bus.py`), driven by `python/say.py` (fire-and-forget)
  and `tools/avbus.py` (request/reply): pose/conjure/say/capabilities, plus inline perform tags in
  speech (`[pose:role=p/y/r]`, `[conjure:x]`). It is **Origin-gated** (blocks browser
  drive-by / CSWSH); keep it so. The wire is STRICT (protocol.js validates at `connect()`; invalid
  commands get a named `{error}` reply) and replies are ROUTED to their asker via hub-rewritten reqIds.
- **The page is served from `app://enigma`, never `file://`** (shell/main.cjs protocol handler).
  `fetch()` works for bundle files; anything outside the repo (model libraries, TTS WAVs) must ride
  `app://enigma/@fs/<abs path>` — map it with `src/util/localurl.js#toAppUrl` at the boundary, do
  NOT hand a `file://` URL to the renderer. (The file:// era hid a dead limits system for weeks.)
- **SAFETY — fail-safe click-through is load-bearing.** The overlay is transparent and must pass clicks
  THROUGH to the desktop whenever it's unsure the cursor is over her mesh — it once **locked the user
  out of their own desktop**. Never weaken: the arbiter's cursor-display gate, the `_forceThrough`
  panic latch, or the panic key (`Ctrl+Shift+Alt+C` = force-through, `…+Q` = quit, tray = independent
  reclaim). Every hit-test failure mode must default to THROUGH, never CAPTURE.
- **Guard at the engine boundary, not the caller.** Validate inputs (finite numbers, well-formed
  shapes) where they ENTER an engine (setLayer, setMouth, throwProp, the loader), so a bad bus message
  degrades honestly instead of permanently bricking a bone/mouth/sim.
- **Generic-only:** no per-model rig overrides, no canned gestures/emotes. Fit rigs via the 19-role
  cascade (VRM → name → geometry → between); author motion via pose/flex/setFingers. Don't re-add the
  removed override mechanism.
- **TTS is vendored** (`voice/voice.py`, Kokoro, Apache-2.0) so this repo is self-contained —
  `python/speak.py` loads it locally. Don't reintroduce a dependency on the engine's `mods/voice`.

## The control plane (`src/control/`) — and why it's a "facade"

`EnigmaAvatar` (in `src/control/surface.js`) is the single control object every driver shares:
(1) the **AI bus** dispatches onto it (`bus.js`), (2) **devtools/console** drive it via
`window.EnigmaAvatar`, (3) **in-process** callers (UI, hotkeys, the `query.js` reporter) call it
directly. It has owned this role since the first avatar commit (`1f92ad0`).

It is a **facade** in the design-pattern sense — a flat set of stable verbs (`recolor`,
`poseLayer`, `conjure`, …) that **forward** to the engine internals, which live in the big
`avatar.js` closure with all their shared state (`model`, `proc`, `rig`, profiles). "Facade" means
_delegating front door_, NOT _broken/fake_ — these methods do the real thing. This is deliberate and
correct: it gives the AI **one object to learn** and a contract that stays stable while internals
change (the spec's "AI-extendability" thesis). Don't "fix" the delegation by inlining engine logic
into the surface or by duplicating state — that's the anti-goal.

The three control modules (`surface.js` + `bus.js` + `query.js`) were carved out of `avatar.js` into
factories (`createControlSurface`/`createBusRegistry`/`createQueryReporter`) that take a deps `api`.
Because they're built mid-closure, **mutable engine state is passed as live getter thunks** (never
frozen values) and a few render-loop primitives as setter thunks — so a handler always sees current
truth. Each has an intent-first, mutation-checked test (`tests/{surface,bus,query}.test.js`).

## Working style

- "Make a plan first" means present the plan and **stop for approval** — don't build it in the same pass.
- **Fix in place, don't compensate** — change the wrong code; don't bolt on shims/wrappers/fallbacks.
- Verify load-bearing numbers/line-refs with a direct tool call BEFORE relaying them.

## Repo layout (folderized 2026-06-29)

`shell/` = Electron main process · `src/` = renderer engine, grouped by concern
(`model/ rig/ motion/ face/ audio/ interaction/ control/ ui/ util/`, entry `src/avatar.js`)
· `python/` = bus + CLIs · `voice/` = vendored TTS · config/data (`*.json`, `index.html`) at
root. Full tree + per-file roles in `README.md`. `src/avatar.js` is still a ~3.6k-line
orchestrator closure pending decomposition — see `TODO.md` "Restructure".

## Project state

`STATUS.md` (what works + how to launch) · `TODO.md` (backlog / audit log).
