# Enigma Avatar -- desktop companion (Desktop Mate-style)

A rigged 3D model -- **any shape: human, animal, robot** -- that animates with its
own **skeleton/bones** and **floats on a transparent, always-on-top overlay** of
your desktop, like _Desktop Mate_. One codebase, runs in a browser **and** in Electron.

> Engine: **Three.js (vendored locally -- no CDN, fully offline)**. Loads any rigged
> **glTF / GLB / VRM / FBX** and drives it with **pure AI-composed procedural motion**
> (layered `pose`/`flex` + per-finger control, sum-then-cap with a velocity clamp),
> spring-bone hair/tail physics, and facial lip-sync + strict (drive-only) blink.

> **For the engine's CURRENT capabilities, read [`STATUS.md`](STATUS.md) -> "CURRENT STATE".**
> The engine is primitives-only (no canned gestures/emotes/clips), purely generic (no per-model
> `rig_overrides`), with full per-finger control, a true sum-then-cap compositor, an enforced
> speed limit, working VRM bodies, and strict blink. This README reflects that.

## Files

- `index.html` + `avatar.js` -- the engine **orchestrator** (scene, render loop, model lifecycle, float/grab, the `EnigmaAvatar` control surface + bus `handleCommand`).
- `rig.js` -- **bone IDENTIFICATION cascade**: VRM humanoid -> name regex -> geometric/topological inference -> structural "between" repair. Generic (no per-model data); maps any rig's bones to 19 canonical roles and degrades gracefully on non-bipeds. Unit-tested.
- `procedural.js` -- the motion compositor: applies the AI's masked, weighted `pose`/`flex` layers (+ per-finger curl) over the roles `rig.js` resolves. Same-role layers sum, the sum is capped once to the joint limit, and the per-frame delta is rate-limited to `speed_limit`. No idle/emote catalog.
- `spring.js` -- spring-bone physics (hair/tail/ears sway); name-based + geometric fallback, with role-matched bones excluded so limbs never go floppy; gravity gated on real motion so fallback chains don't sag at rest.
- `facial.js` -- facial layer: blendshapes -> facial bones (jaw) -> none; lip-sync + strict blink (independent mouth/blink ladders; blink fires only on speech onset or the bus, never autonomously).
- `loader.js` -- multi-format asset loading (glTF/GLB / VRM / FBX only, spec-gloss compat, FBX material re-binding with failures surfaced to the log). `.obj`/`.dae` fail honestly (no parser).
- `voice.js` -- speech playback + amplitude lip-sync (Web-Audio RMS -> mouth).
- `conjure.js` -- transform-based prop spawn/glide/hover/dismiss (name-resolved, honest-miss); rapier for throw/drop.
- `physics.js` -- rapier rigid-body props; thrown props use CCD + thick slabs so they can't tunnel.
- `control.js` -- parses `perform`'s inline speech tags (`[emotion]`/`[conjure:x]`/`[pose:role=val]`/`[look:dir]`) into motion + the clean TTS line.
- `ui.js` -- the right-click menu + Settings dialog (all the DOM). Numerical inputs (no sliders); capability-driven attach-bone picker.
- `default_avatar.js` -- the **inert no-model marker** (an empty `NoModelMarker` group, 0 bones / 0 roles); when no model is loaded the overlay shows an ASCII DOM hint to add a `.glb`.
- `main.js` + `preload.js` + `package.json` -- the Electron shell (transparent, click-through overlay) + model-import dialog.
- `bus.py` -- local WebSocket relay (`ws://127.0.0.1:8765`) so Enigma/Odysseus can drive the avatar.
- `say.py` -- CLI to drive the avatar (model swap, size, `fingers`, `perform`, `snap`, **say** a WAV, **demo**); fails honestly on bad args, ASCII help.
- `speak.py` -- **Kokoro TTS -> lip-sync**: synthesize text and have the avatar speak it.
- `import_unitypackage.py` -- turn a Unity `.unitypackage` (VRChat avatar) into a loadable model folder.
- `models/` + `models.json` -- model folders + the user-model manifest (built-ins live in `avatar.js`).
- `bone_limits.json` -- 19-bone humanoid joint limits + speed limits (clamps procedural posing; role names match `rig.js`).
- `tests/` -- Node unit tests (`npm test`) for the rig cascade, spring detection, compositor sum-then-cap/speed-limit, and `vrm_order` (the VRM pose-order regression); also run under pytest via `tests/test_avatar_rig.py`. `tests/realmodels.test.js` locks the cascade's per-model role counts against the actual assets.
- `tools/rig_report.mjs` -- headless cascade inspector: `node tools/rig_report.mjs [model.glb] [--bones]` reads a model's real bones straight from its glTF JSON (no WebGL) and reports which of the 19 roles resolve and by which tier (incl. the tier-3.5 `resolveBetween` step + a blink-channel probe) -- so a cascade change can be measured against the real assets, not guessed.

## Run it on your desktop (NO admin)

**Double-click the `Enigma Avatar` desktop icon**, or run `Start-Avatar.ps1` (shows logs),
or `Enigma Avatar.bat`. It pops onto your desktop with no UI -- **right-click the avatar**
for everything (models, **Add model...**, size, settings, quit). Launches hidden.

- Portable **Node v24** (`%LOCALAPPDATA%\node-portable`) + Electron are already installed -- **no admin**.
  First launch runs `npm install` (electron + three + three-vrm) locally. **Never use a winget MSI** (needs admin).
- **left-drag** move; scroll or **+/-** resize (**0** resets); **Ctrl+Shift+Alt+Q** quit; **Ctrl+Shift+Alt+C** force click-through (PANIC: reclaim the desktop if she ever blocks clicks); **Ctrl+Shift+Alt+A** force interactive (reach the panel); **H** info panel.

## Add / swap models

> **First run on a new device:** `models/` isn't shipped (large + non-redistributable), so a fresh clone has no models. The overlay then shows an **ASCII "No model loaded" hint** (no self-made placeholder character) -- add a real model with either route below and it replaces the hint.

- **Right-click -> Add model...** -- native file picker. Pick a `.glb`/`.gltf`/`.vrm`/`.fbx`
  (or a `.gltf` + its `.bin` + textures together), or a Unity **`.unitypackage`**
  (VRChat avatar) -- it's copied into `models/`, registered, and loaded.
- Or **drag a file onto the overlay** (interactive mode).
- VRChat `.unitypackage` from the CLI: `python import_unitypackage.py "Avatar.unitypackage" --name myavatar --register`
  (flattens the mesh + textures into `models/myavatar/`; `.tga` decode + texture-path repair handled by the loader).

## Features

- **Floats in place** -- no gravity/walk; stays where you drop it. Grab its actual
  **silhouette** (rendered shape), so empty space around limbs clicks through to the desktop.
- **Spring physics** -- hair/tail/ears sway from body motion (name-based; geometric fallback for opaque rigs; no gravity sag at rest).
- **AI-composed motion** -- no canned gestures/emotes/clips/idle. The AI composes movement from
  PRIMITIVES: masked, weighted `pose`/`flex` motion layers + per-finger `fingers`, authored over
  the bus or from inline-tagged speech (`perform`). Disjoint layers sum; same-role layers sum-then-cap;
  the per-frame delta is velocity-clamped; timed layers self-expire.
  Left alone she stands still -- springs, blink (on a drive), and cursor-look are the only reflexes.
- **Facial layer** -- amplitude lip-sync (blendshapes/visemes if present, else a jaw bone) + strict blink (speech-onset / bus only).
- **Voice** -- Kokoro TTS speaks and the mouth lip-syncs to the audio (no cloud, **no fallback**).
- **VRM bodies move** -- `autoUpdateHumanBones=false` at load lets the compositor drive `.vrm` humanoids.

## AI control (the bus) -- Enigma/Odysseus drive the avatar

The overlay listens on a local WebSocket bus (`bus.py`, `ws://127.0.0.1:8765`); a driver sends
JSON `{action, ...}` commands that `avatar.js`'s `handleCommand` applies. Any LLM that can emit
that protocol drives her -- Enigma, Odysseus, or the CLIs below.

- **`say.py`** -- one command at the bus: `python say.py model mal0`; `say.py size 0.8`; `say.py fingers R 1`; `say.py perform "Hi! [pose:right_arm=1.0]"`; `say.py say file:///C:/tmp/x.wav` (run `say.py` with no args for the full list).
- **`speak.py`** -- `python speak.py "hello, I am Enigma"` -- Kokoro TTS + lip-sync (needs Kokoro: `python -m pip install --user kokoro`).

## Control surface (browser console `EnigmaAvatar.*`, or the bus)

- `EnigmaAvatar.poseLayer({ flex:{ right_arm:[1.0] }, dur:2 })` -- set a weighted motion layer (the core primitive; same-role layers sum, the sum is capped to the joint limit, the delta is speed-limited).
- `EnigmaAvatar.fingers({ side:'R', curl:1 })` -- per-finger curl 0..1 (or `{ spec:{ default:1, index:0 } }` to point; `curl:null` releases to the reactive grip).
- `EnigmaAvatar.perform("Watch this! [pose:right_arm=1.0]")` -- drive motion from inline-tagged speech (`[pose:role=val]` drives a full pitch/yaw/roll triple); returns the clean line to speak.
- `EnigmaAvatar.springTune({ stiffness, drag, gravity })` -- hair/tail feel (saved per avatar).
- `EnigmaAvatar.facialTune({ jawAxis:'x', jawOpen:0.32 })` -- jaw-flap axis/amount (per-rig; needs your eyes).
- `EnigmaAvatar.say("file:///...wav")` / `EnigmaAvatar.mouth(0.5)` -- speech + manual jaw.
- `EnigmaAvatar.capabilities()` -- what THIS model can drive (roles, flex-able limbs, finger names, angle + speed limits, units).
- `EnigmaAvatar.state()` -- debug (size, pos, springBones, facial mode, toggles).

## Needs your eyes (can't be verified headless)

Software-WebGL can't render skinned meshes, so visual polish is a manual pass on the real
overlay: per-rig motion-layer feel and amplitude/choreography, the velocity-clamp's effect on
co-speech snappiness vs the Filian target, jaw-flap axis/sign (`facialTune`), lip-sync gain, and
texture appearance. Detection logic (bone roles, springs, jaw, fingers) is verified numerically.
