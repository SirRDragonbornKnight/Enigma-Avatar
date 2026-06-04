# Enigma Avatar — desktop companion (Desktop Mate-style)

A rigged 3D model — **any shape: human, animal, robot** — that animates with its
own **skeleton/bones** and **floats on a transparent, always-on-top overlay** of
your desktop, like *Desktop Mate*. One codebase, runs in a browser **and** in Electron.

> Engine: **Three.js (vendored locally — no CDN, fully offline)**. Loads any rigged
> **glTF / GLB / VRM / FBX**, plays its animation clips or a procedural idle, with
> spring-bone hair/tail physics, facial blink + lip-sync, and AI-driven emotes.

## Files
- `index.html` + `avatar.js` — the engine (loads a model, idles/emotes, floats, grab-to-move).
- `procedural.js` — procedural skeletal animator (humanoid idle + emotes) for rigs with no clips.
- `spring.js` — spring-bone physics (hair/tail/ears sway); name-based with a geometric fallback.
- `facial.js` — facial layer: blendshapes → facial bones (jaw) → none; blink + lip-sync.
- `main.js` + `preload.js` + `package.json` — the Electron shell (transparent, click-through overlay) + model-import dialog.
- `bus.py` — local WebSocket relay (`ws://127.0.0.1:8765`) so Enigma/Odysseus can drive the avatar.
- `say.py` — CLI to drive the avatar (emotes, model swap, size, **say** a WAV).
- `speak.py` — **Kokoro TTS → lip-sync**: synthesize text and have the avatar speak it.
- `import_unitypackage.py` — turn a Unity `.unitypackage` (VRChat avatar) into a loadable model folder.
- `models/` + `models.json` — model folders + the user-model manifest (built-ins live in `avatar.js`).
- `bone_limits.json` — salvaged 19-bone humanoid joint limits (clamps procedural posing).

## Run it on your desktop (NO admin)
**Double-click the `Enigma Avatar` desktop icon**, or run `Start-Avatar.ps1` (shows logs),
or `Enigma Avatar.bat`. It pops onto your desktop with no UI — **right-click the avatar**
for everything (models, **Add model…**, express, size, settings, quit). Launches hidden.

- Portable **Node v24** (`%LOCALAPPDATA%\node-portable`) + Electron are already installed — **no admin**.
  First launch runs `npm install` (electron + three + three-vrm) locally. **Never use a winget MSI** (needs admin).
- **left-drag** move · scroll or **+/-** resize (**0** resets) · **Ctrl+Alt+Q** quit · **Ctrl+Alt+A** force click-through · **H** info panel.

## Add / swap models
- **Right-click → Add model…** — native file picker. Pick a `.glb`/`.gltf`/`.vrm`/`.fbx`
  (or a `.gltf` + its `.bin` + textures together), or a Unity **`.unitypackage`**
  (VRChat avatar) — it's copied into `models/`, registered, and loaded.
- Or **drag a file onto the overlay** (interactive mode).
- VRChat `.unitypackage` from the CLI: `python import_unitypackage.py "Avatar.unitypackage" --name myavatar --register`
  (flattens the mesh + textures into `models/myavatar/`; `.tga` decode + texture-path repair handled by the loader).

## Features
- **Floats in place** — no gravity/walk; stays where you drop it. Grab its actual
  **silhouette** (rendered shape), so empty space around limbs clicks through to the desktop.
- **Spring physics** — hair/tail/ears sway from body motion (name-based; geometric fallback for opaque rigs).
- **Procedural idle + emotes** — breathing/look idle and `happy, talk, wag, nod, shake, sad, alert`.
  Layers **additively over animation clips** when a model ships its own idle.
- **Facial layer** — idle eye-blink + lip-sync, via blendshapes/visemes if present, else a jaw bone.
- **Voice** — Kokoro TTS speaks and the mouth lip-syncs to the audio (no cloud, **no fallback**).

## AI control (the bus) — Enigma/Odysseus drive the avatar
- **`avatar_express` MCP tool** (in `modkit_mcp.py`) — body language as the AI replies.
- **`avatar_say` MCP tool** — the avatar speaks the text (Kokoro) and lip-syncs.
- **`say.py`** — `python say.py wag` · `say.py talk 4` · `say.py model mal0` · `say.py size 0.8` · `say.py say file:///C:/tmp/x.wav`.
- **`speak.py`** — `python speak.py "hello, I am Enigma"` (needs Kokoro: `python -m pip install --user kokoro`).

## Tuning knobs (browser console, or the bus)
- `EnigmaAvatar.express("wag")` — emote.
- `EnigmaAvatar.springTune({ stiffness, drag, gravity, breeze })` — hair/tail feel.
- `EnigmaAvatar.tune({ breathe, look, armRest, elbow, swingAxis })` — idle motion (swingAxis flips limb swing per rig).
- `EnigmaAvatar.facialTune({ jawAxis:'x', jawOpen:0.32 })` — jaw-flap axis/amount (per-rig; needs your eyes).
- `EnigmaAvatar.say("file:///…wav")` / `EnigmaAvatar.mouth(0.5)` — speech + manual jaw.
- `EnigmaAvatar.state()` — debug (size, pos, springBones, procBones, facial mode, toggles).

## Needs your eyes (can't be verified headless)
Software-WebGL can't render skinned meshes, so visual polish is a manual pass on the real
overlay: per-rig limb-swing axis (`swingAxis`), jaw-flap axis/sign (`facialTune`), lip-sync
gain, and texture appearance. Detection logic (bone roles, springs, jaw) is verified numerically.
