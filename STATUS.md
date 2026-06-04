# Enigma Avatar — Status & Launch

_Last updated 2026-06-03._

## What works (verified in logic)
- **Floats in place** — no gravity / fall / bounce. Stays where you drop it.
- **Grab the avatar's shape (not a box)** — the hit region is the avatar's actual on-screen **silhouette**: the model is rendered to a tiny offscreen buffer ~6×/s and its alpha kept as a shape mask, tested with a small (~8px) grab tolerance. Clicks only land where there's a real avatar pixel, so the empty space *inside* its bounding box (gaps around limbs, the box corners) clicks straight through to the desktop. Bounding boxes proved unreliable for skinned rigs anyway — Roxanne's collapsed to her feet, GLaDOS's blew up to ±1000s. A rig that renders degenerate (footprint fills the screen) falls back to a central body column so it stays grabbable.
- **Spring physics** (`spring.js`) — hair / tail / ears / wires sway from the body's motion, not rigidly. Detected by bone NAME; for **opaque rigs** (every bone called `Bone037_016`) a **geometric fallback** springs the far-reaching dangly chains instead (relative to the model's own longest chain, so it's scale-free). Roxanne = 17 named springs · GLaDOS = 5 wire springs · Toothless = 24 geometric (tail + wings, plus a gentle idle breeze). Stress-tested NaN-free.
- **AI expression** (`procedural.js` + `EnigmaAvatar.express`) — `happy, talk, sad, alert, wag, nod, shake`. Drives the body bones; the springs make the tail/hair follow. "wag" swishes the hips so the spring tail whips. Drivable remotely over the bus (see below).
- **Per-model size** (remembered per model) + model swap with **1 / 2 / 3** = Roxanne / Night Fury / GLaDOS.
- **Right-click menu + Settings** (on the avatar) — a plain, OS-style context menu: pick a model, **Express ❯** and **Size ❯** submenus, **Settings…**, and **Quit** (overlay). **Settings…** opens a normal settings dialog with native controls — model dropdown, size & hair/tail-stiffness sliders, and checkboxes (spring physics / idle motion / lock in place / show info panel). Only opens *on* the avatar, so it never hijacks the desktop.
- **Any format** — glTF/GLB, **VRM** (@pixiv/three-vrm), and **FBX** (with .tga textures). Three.js + addons are **vendored locally** (`node_modules`) — **no CDN, fully offline** (the black-box privacy principle; was an unpkg.com dependency — avatar audit #1).
- **Add / import models** — right-click **Add model…**: native picker for `.glb/.gltf/.vrm/.fbx` or a Unity **`.unitypackage`** (VRChat avatar) → copied into `models/`, registered in `models.json`, loaded. `import_unitypackage.py` does the `.unitypackage` → folder conversion (mesh + textures, GUID-path flatten, largest-mesh pick) and writes a `materials.json` that re-binds FBX materials to their `.mat` textures by name — FBX embeds none, so without this the model loads untextured.
- **Facial layer** (`facial.js`) — idle eye-blink + **lip-sync**, via blendshape visemes if present, else a **jaw bone** (e.g. Mal0's `Bip_Jaw`); body-only if neither. Toggle in Settings.
- **Voice + lip-sync** — Kokoro TTS (the voice mod's local pipeline) speaks; the overlay drives the mouth from the audio's loudness (Web-Audio RMS). **No fallback** (by design). `avatar_say` MCP tool / `speak.py`.

## How it's built (the method)
- Pure Three.js, deterministic. **No RL, no per-model training.** The MuJoCo/RL locomotion route in `rl/` is **PARKED** — floating removed the need to solve walking (the hard part that sprawled on Z-up/T-pose rigs).
- Claude verifies the **logic** numerically (raycast hits, bone counts, NaN checks) because the software-WebGL preview **can't render skinned meshes**. **Visual polish needs your eyes or the real overlay.**

## Run it on your desktop (NO admin)
**Double-click the `Enigma Avatar` icon on your Desktop.** (Created by a one-off WScript shortcut → runs `Start-Avatar.ps1` hidden. Also available: `mods\avatar\Enigma Avatar.bat`, or run `Start-Avatar.ps1` directly to see logs.) The avatar pops onto your desktop with **no UI** — **right-click it** for everything (models / express / size / settings / quit). Launches hidden, no console.
- **Size is remembered** per model across launches (localStorage). First run is `DEFAULT_SIZE` (0.5); after that it reopens at whatever you last used. Resize via scroll, right-click → Size, the Settings slider, or `+/-`.
- The info panel is **hidden by default**; re-enable it in **Settings → Show info panel** or with **H**.
- **left-drag** to move · scroll or **+/-** to resize · **Ctrl+Alt+Q** quit · **Ctrl+Alt+A** force click-through.
- Portable **Node v24** (`%LOCALAPPDATA%\node-portable`) + Electron are already installed — no admin. Never use a winget MSI (needs admin; see the `no_admin_constraint` memory).

## AI control (the bus) — Enigma/Odysseus drive the avatar
The avatar listens on a local WebSocket bus so anything on the machine can move it:
- **`bus.py`** — the relay hub on `ws://127.0.0.1:8765`. The overlay launcher starts it; or run `python mods/avatar/bus.py` standalone.
- **`avatar_express` MCP tool** (in `modkit_mcp.py`) — Enigma/Odysseus call it to give the avatar body language as they reply ("talk" while explaining, "wag" when pleased, "nod"/"shake" for yes/no…). Safe no-op if the avatar isn't running.
- **`say.py`** — CLI for testing/demo: `python mods/avatar/say.py wag` · `say.py talk 4` · `say.py size 0.8`.
- **Verified end-to-end**: MCP tool / CLI → bus → live `EnigmaAvatar.express()` (`test_avatar_bus.py`, plus a real-browser check). The overlay auto-connects under Electron; in a plain browser, `EnigmaAvatar.connect()`.

## Tuning knobs (browser console, or the bus)
- `EnigmaAvatar.express("wag")` — emote.
- `EnigmaAvatar.springTune({ stiffness: 0.14, drag: 0.5, gravity: -3, breeze: 0.16 })` — hair/tail feel (`breeze` = idle drift of geometric/opaque-rig chains, e.g. Toothless).
- `EnigmaAvatar.tune({ breathe: 0.075, look: 0.18, armRest: 1.15, elbow: 0.45 })` — idle motion: breathing, head look-around, how far arms drop from the T-pose, elbow bend. (Idle keeps the **feet planted** — motion is upper-body + head only.)
- `EnigmaAvatar.state()` — debug (size, pos, springBones, procBones, toggles).

## Per-avatar reality
- **Roxanne** — full 19-bone humanoid + 17 named springs → emotes + hair/tail physics fully.
- **GLaDOS** — head/neck procedural + her 5 ceiling wires as springs (no humanoid limbs); expresses via head tilt + swaying wires. The old global bob is gone, so the wires move **only** via their joints.
- **Night Fury (Toothless)** — 187 bones, but ALL opaque names, so name-matching finds nothing. The geometric fallback springs its tail + wing chains (24 bones) with an idle breeze → it drifts while floating and sways when dragged. No procedural idle/emotes yet (would need named bones or a per-model body map).
- **Mal0** (FBX, imported from a VRChat `.unitypackage`) — full humanoid: **19 procedural roles** matched (helper/twist/pelvis-aux bones correctly excluded — avatar audit #4), **29 spring bones** (hair/tail/ears — fingers excluded after fixing `fin`→`finger` over-match), and a **`Bip_Jaw` lip-sync** (no visemes → jaw-flap). Textures re-bound from the `.mat` files via `materials.json` (body→Mal_0Col + normal, hair→hair.tga, etc. — verified every ref resolves). Detection + texture map verified against the real data; jaw/limb axis & sign and final look are your visual pass.

## Next
1. **Your visual pass on the real overlay** (software-WebGL can't render skinned meshes, so this needs your eyes): per-rig limb-swing axis (`tune({swingAxis})`), Mal0's jaw-flap axis/sign (`facialTune({jawAxis,jawOpen})`), lip-sync gain, Toothless breeze/stiffness, and texture appearance.
2. **Kokoro install** for voice: `python -m pip install --user kokoro` (no fallback by design). Then `speak.py` / the `avatar_say` MCP tool talk + lip-sync.
3. **Enigma** (still pretraining): once it serves, Odysseus calls `avatar_express` / `avatar_say` as it talks — the bus path is built & tested, so this is just switching it on.
