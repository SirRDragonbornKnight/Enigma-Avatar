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
- Node tests: `node --test` (Node built-in runner; ~217 tests, some skip without the real model
  library). `node --check <file>.js` for a quick syntax pass.
- Python tests: `python -m pytest tests/test_avatar_*.py -q` (the bus CSWSH origin-gate + bone data).
- Console output must be **ASCII** (the Windows cp1252 console can't print `→`, `—`, etc.).
- Launch the overlay: `Start-Avatar.ps1` (or `Enigma Avatar.bat`). Portable Node + Electron install on
  first run. No admin.

## Load-bearing rules (do not weaken)
- **Authoritative spec lives OUTSIDE the repo:** `C:\Users\SirKn\3d Avatar\The project is to make a 3d
  model t.txt` (REV 6). Models live in `C:\Users\SirKn\3d Avatar\Avatars\`. Judge/recode against the
  SPEC's intent, NOT against what the code currently does — passing tests often just enshrine wrong
  behavior. Loading from that external dir MUST keep working (no path-restricting the loader).
- **Control plane = the local WebSocket bus** (`bus.py`), driven by `say.py` (fire-and-forget) and
  `tools/avbus.py` (request/reply): pose/look/conjure/say/capabilities, plus inline perform tags in
  speech (`[pose:role=p/y/r]`, `[look:dir]`, `[conjure:x]`). It is **Origin-gated** (blocks browser
  drive-by / CSWSH); keep it so.
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
- **TTS is vendored** (`voice/voice.py`, Kokoro, Apache-2.0) so this repo is self-contained — `speak.py`
  loads it locally. Don't reintroduce a dependency on the engine's `mods/voice`.

## Working style
- "Make a plan first" means present the plan and **stop for approval** — don't build it in the same pass.
- **Fix in place, don't compensate** — change the wrong code; don't bolt on shims/wrappers/fallbacks.
- Verify load-bearing numbers/line-refs with a direct tool call BEFORE relaying them.

## Project state
`STATUS.md` (what works + how to launch) · `TODO.md` (backlog / audit log).
