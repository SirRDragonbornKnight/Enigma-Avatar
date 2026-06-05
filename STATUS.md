# Enigma Avatar — Status & Launch

_Last updated 2026-06-05._

A rigged 3D model (human / animal / robot) that floats on a transparent, always-on-top,
click-through desktop overlay (Desktop-Mate-style). Loads any glTF/GLB/VRM/FBX, drives a
procedural idle + spring physics + facial lip-sync + emotes, and is drivable by Enigma /
Odysseus over a local bus.

## Architecture (modules)
The engine is split into focused modules; `avatar.js` is the orchestrator that wires them.
- **`rig.js`** — bone **identification** cascade (the heart): `resolveRig(model, vrm)` maps any
  rig's bones to the 19 canonical roles via four tiers, each filling only still-empty roles
  (override forces): **VRM humanoid → name regex → geometry/topology → per-model `rig_overrides.json`**.
  Geometry degrades gracefully — a non-biped (GLaDOS, a dragon) gets no false limbs. Pure
  functions over a bone snapshot → unit-tested with synthetic skeletons (no WebGL).
- **`procedural.js`** — layered, desynced humanoid idle + emotes; consumes `rig.js`'s role map.
- **`spring.js`** — spring-bone physics (hair/tail/ears); name + geometric fallback. Role-matched
  bones are passed as an `exclude` set so a humanoid's limbs never get sprung.
- **`facial.js`** — VRM expr → morph → jaw-bone → none; blink + lip-sync.
- **`loader.js`** — multi-format loading (glTF/GLB/VRM/FBX, spec-gloss compat, FBX material bind).
- **`voice.js`** — speech playback + RMS-driven mouth.
- **`ui.js`** — the right-click menu + Settings dialog (all DOM).
- **`main.js`/`preload.js`** — the Electron shell (transparent overlay, IPC, monitor hop, import dialogs).

## What works
- **Floats in place** (no gravity/walk); grab its actual **silhouette** (rendered shape), so empty
  space around limbs clicks through to the desktop. Degenerate rigs fall back to a body column.
- **Bone-ID cascade** identifies rigs robustly. Verified on the model zoo (see Per-avatar below);
  a future mis-identified rig is a 1-line `rig_overrides.json` edit, not a code/regex change.
- **Spring physics** — hair/tail/ears/wires sway; opaque rigs (Toothless) use the geometric fallback.
- **Procedural idle + emotes** — `happy talk wag nod alert sad shake`; layers additively over baked clips.
- **Facial** — idle blink + amplitude lip-sync (morphs/visemes or a jaw bone).
- **Voice** — Kokoro TTS speaks; mouth lip-syncs to the audio (no cloud, **no fallback**).
- **Right-click menu + Settings** — models, Add model…/clothing/prop/furniture, Express, Size,
  Move to monitor, and a Settings dialog (model, size, hair physics, per-part color/hue tint,
  toggles for spring/idle/look/idle-behavior/face/lock/skeleton/panel, attachment fitting).
- **Multi-monitor** — per-display window; right-click → Move to monitor, `Ctrl+Alt+M`, drag across an
  edge to hop. **Cache disabled** in the shell, so renderer edits load fresh (no `?v=` bumping).

## Run it on your desktop (NO admin)
**Double-click the `Enigma Avatar` desktop icon** (runs `Start-Avatar.ps1` hidden; also `Enigma Avatar.bat`,
or run `Start-Avatar.ps1` directly to see logs). It pops onto your desktop with **no UI** — **right-click it**
for everything. Portable **Node v24** (`%LOCALAPPDATA%\node-portable`) + Electron are installed locally; first
launch runs `npm install`. **Never use a winget MSI** (needs admin — see the `no_admin_constraint` memory).
- **left-drag** move · scroll or **+/-** resize (**0** resets) · **Ctrl+Alt+Q** quit · **Ctrl+Alt+A** force click-through · **H** info panel.
- Size is remembered per model (localStorage); per-avatar attachments / physics / colors persist in `profiles.json`.

## AI control (the bus)
- **`bus.py`** — relay hub on `ws://127.0.0.1:8765` (the launcher starts it; or run it standalone).
- **`avatar_express` / `avatar_say` / `avatar_command` MCP tools** (in `modkit_mcp.py`) — Enigma/Odysseus
  give body language, speak (Kokoro), or send any `handleCommand` action. Safe no-op if the overlay/bus is down.
- **`say.py`** — CLI: `say.py wag` · `talk 4` · `model chica` · `size 0.8` · `snap` · `demo` (paced greeting).
- Verified end-to-end (MCP / CLI → bus → live `EnigmaAvatar`), incl. `test_avatar_bus.py` at the repo root.

## Tests
- **`npm test`** (in `mods/avatar/`) runs the Node unit tests in `tests/`: the rig cascade (name / geometry /
  override / VRM tiers, with negative assertions for graceful degradation) + spring detection.
- **`node tools/rig_report.mjs`** — headless cascade inspector: extracts each model's REAL bone snapshot from
  its glTF JSON (names + world positions + hierarchy, no WebGL / no mesh decode) and runs the SAME tiers the
  engine uses, printing which of the 19 roles resolve and by which tier. `--bones` dumps every bone (height% /
  side); pass a path for one model, or no args for all. `tests/realmodels.test.js` turns this into a regression
  guard that LOCKS the per-model counts in "Per-avatar reality" below — so a cascade change that quietly breaks
  a real rig fails the suite. (Skips cleanly on a fresh clone, where `models/` is gitignored-absent.)
- Also wired into the project's pytest suite via **`tests/test_avatar_rig.py`** (alongside `tests/test_avatar_bone_data.py`,
  which locks the 19 role names in `bone_limits.json`). Verification of *rendering/feel* still needs real eyes
  (software-WebGL can't render skinned meshes) — drive the live overlay + `EnigmaAvatar.snap()` to inspect.

## Per-avatar reality (cascade results)
_All counts below are now ASSERTED by `tests/realmodels.test.js` (verified 2026-06-05 via `tools/rig_report.mjs`)._
- **Roxanne · 51dc** — 19 roles by name; full idle + hair/tail physics.
- **Mal0 · Toy Chica · Fexa** — 19 roles (name + geometry filling torso/limb gaps; Chica's Blender `.L/.R` sides resolve — the old T-pose is fixed).
- **Lolbit** — 17: its arms are a 3-joint `Shoulder→Elbow→Wrist` chain with **no separate upper-arm bone**, so `left/right_arm` stay empty (Shoulder→`shoulder`, Elbow→`forearm`, Wrist→`hand`). **Mangle** — 15: no `hips` bone, chest is named `Spine1` (loses to `Spine` for the `spine` slot), and decorative `ShoulderPad` + a duplicated skeleton confuse the right side. Both are *override-able* (force the missing roles), but because it means mapping a role onto a joint it wasn't named for, the resulting arm-swing **feel needs a live look** — measure any candidate with `node tools/rig_report.mjs <model>` first.
- **GLaDOS** — head/neck only (no body); her wires spring. Correct.
- **Night Fury (Toothless)** — non-biped: geometry declines it (wings aren't arms), so it stays a spring creature (tail + wings sway), no bogus limb idle.
- **grace_howard** — MMD export whose Japanese bone names were **already corrupted to `U+FFFD` at export time and baked into the (valid-UTF-8) glTF as literal replacement chars** (~2.6k of them; the original Shift-JIS is gone, not recoverable from this file). three.js and the `rig_report` tool both read the same `U+FFFD` soup, and many bones collapse to identical names — so the name tier *and* any `rig_overrides.json` keyed by name can't even address them uniquely. NOT a 1-line override: it needs a **UTF-8 re-export from the source MMD model** (or new geometry-tier coverage), not a name map. **Spyro** — no skin/joints (static), correct.

## Next
1. **Stragglers** (measure each with `node tools/rig_report.mjs <model>`, confirm the swing live):
   lolbit/mangle arm (+mangle hips/chest) via `rig_overrides.json`; grace_howard needs a **UTF-8 bone-name
   re-export** before any name/override can bite (its names are baked-in `U+FFFD` mojibake — see Per-avatar above).
2. **Visual pass** on the real overlay: per-rig limb-swing axis (`tune({swingAxis})`), jaw axis/sign (`facialTune`), lip-sync gain.
3. **Enigma** (still pretraining): once it serves, Odysseus calls `avatar_express`/`avatar_say` as it talks — the bus path is built & tested.
