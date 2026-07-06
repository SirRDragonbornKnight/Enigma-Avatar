# Enigma Avatar -- Status & Launch

_Last updated 2026-07-06 (fresh-out-of-the-box cleanup pass; suite 326/0/6, smoke 7/7)._

## 2026-07-06 -- fresh-out-of-the-box cleanup

- Full-health audit receipts: node --test **326/0/6**, pytest **21/21**, eslint + tsc + prettier
  clean, live smoke **7/7** (boot, limits, strict wire, visible, elbow bend/release, snap).
- Swept the last stale-word drift: package.json description no longer says "emotes" (purged
  2026-06-25); dead `rl/` .gitignore entry removed; doc test-counts synced below.
- Pruned 7 dead `profiles.json` keys (targets no longer exist: the trashed zhu_yuan__nsfw__zzz x3
  plus 4 unresolvable bare-name keys). Cleared regenerable runtime litter (`outputs/` wavs/logs/
  one-off probes, `__pycache__/` -- NB these regenerate on every python run / TTS use; that is
  their job, not drift). Later the same day, `models/_trash` (41 MB, incl. the pruned-profiles
  archive) was emptied to the Windows Recycle Bin at the user's direction -- the trashed models
  are gone for good, so their tuning is moot. `removeModel` recreates `_trash` on demand.
- CI added: `.github/workflows/ci.yml` runs the full headless gate (lint + typecheck +
  format:check + node --test + pytest) on every push/PR -- the remote-side twin of the
  pre-commit hook (realmodels skips cleanly without the model library).

## 2026-07-05 -- the grab feel: honest bounds, constant size, ragdoll grab, mouse-lock

- **The grab jump was a LYING WINDOW SIZE:** Windows constrains a display-sized overlay window
  to the work area (created 1440 tall, real 1392 -- and nondeterministically per boot), while
  `avatar:init` reported display.bounds; every DIP<->local conversion carried a false 1440/1392
  ratio and the grab offset came out ~3.5% low. init now ships `win.getBounds()` truth. Receipt:
  `move {to:"cursor"}` lands her anchor bit-exact on the true OS cursor.
- **Constant px-per-world-unit across monitors** (`refH`/`refW` in init): every window frames
  `worldH = VIEW_H * innerHeight/refH`, so she keeps her on-screen size hopping between a 1440p
  and a 1080p display (was a constant FRACTION of each screen). The load-time WIDTH cap and
  `fitToScreen` are referenced/gated to the primary so wide models scale identically everywhere
  and peers can't diverge from the brain's size decision.
- **RAGDOLL GRAB (`src/motion/grabfollow.js`)** -- "grab the arm, it moves, then the body": one
  transient compositor fn() layer aims the grabbed limb chain at the cursor (ABSOLUTE servo,
  no windup; the rig's abduction SIGN is measured from its own response and locked once per
  grab -- a re-voting detector limit-cycled under the 90 deg/s speed clamp) and pendulums the
  torso from drag velocity (0.22 rad cap, settles). Near-base grabs hold the last aim
  (mouse-lock makes the target self-referential there). Joint table + speed clamps shape all
  of it; clearLayer on release eases out. Unit tests drive a SPEED-LIMITED simulated limb,
  including a reversed-axis rig.
- **MOUSE-LOCK on the grabbed part:** the brain captures the click point in the nearest bone's
  local frame, then per-frame measures where that part really is and `dragAdjust`s main's grab
  offset (brain-only IPC, finite, +-4000 DIP, 0.35 blend + 60 DIP/frame rate cap) -- the part
  stays pinned under the pointer and the body hangs around it. Drag REPLACEMENTS (latest grab
  wins, no edge) re-capture via a `dragSeq`; a detached/disposed lock bone is dropped by a
  liveness check; an unseen cursor (reload mid-drag) never locks a bogus bone.
- **Resize grows from her MIDDLE** (scroll/+,-: `applySize(.., "hips")`; the bus `size` verb
  keeps its documented feet default). A mid-drag resize honestly reports `anchorClamped: true`
  (the compensation glide would be discarded while a drag owns the position).
- **Grabbable at ANY size (the cap stays off):** the fallback grab handle keeps its BASE-side
  segment under the 60% cap (a giant avatar's handle used to sit entirely above the window =
  unclickable) and never tests over when fully off-window; a sub-48px-mask speck gets the same
  bounded handle. Fail-open preserved: capture stays small and near her body.
- **Sprung regions swing FREE during drags** -- the grabbed-region hold (pin -> damp) was
  removed for good: on ryuri the whole lower body is ONE tail region, so any nearby grab
  "froze the bottom". The ragdoll layer carries the grab feel.
- **smoke VISIBLE hardened:** asserts her REAL on-screen body height (`dims * size` -- dims are
  scale-normalized, so a 0.02-size speck used to pass) + anchor on glass.
- `onMyDisplay()` compares display IDENTITY (id via `avatar:pos.disp`), not origins -- the
  window origin is work-area-constrained and diverges from the display origin under a
  top/left-docked taskbar (region snapshots/crops would have silently died there).
- Suite: node **321 pass / 0 fail / 6 skipped** (327 total), pytest **21/21**, eslint + tsc +
  prettier clean, smoke **7/7**. (Engine side, same day: SFT v2 trained on the Phase-1 mix --
  val loss 0.7997, fluent chat; identity upweighting is the known next step.)

## 2026-07-04 (late) -- zero-trust audit round 2: the ryuri crumple + 20 fixes

- **The smoke was failing live (5/6) and the "passing" snap was a photo of NOTHING.** Root cause
  chain: the new `ryuri.glb` (a lamia -- humanoid torso on a ~112-bone snake tail) authors its
  mane/tail BIND vertices out to y=-5062 while its skeleton spans 2.28 units. `bodyBox()`
  normalized on raw bind-geometry boxes, so she scaled to a 0.42-unit speck; the twin-adoption
  tolerance (3% of the assumed 6-unit height) then exceeded HALF her real body and cross-adopted
  116 bones -- crumpled mesh, left/right motion cross-wired, and a persisted position at the
  1.4x-permeable clamp extreme (y=2016) parked her below every display. Three fixes:
  `bodyBox()` measures SKINNED bounds (what renders, `SkinnedMesh.computeBoundingBox`), the
  coincidence tolerances for twin-adoption/spring-dedup come from the SKELETON's own span, and
  boot/rebuild restores clamp to SOLID glass (`clampToUnion {solid:true}` -- the permeable bottom
  is a live-drag affordance, not a resting place). ryuri: 12/19 roles is HONEST (no legs).
- **`npm run smoke` gained receipt 4 "VISIBLE"** (sane world height + anchor on glass) -- the exact
  class every other receipt missed while she was invisible. Smoke is 7 checks now, 7/7 live.
- **Spring NaN freeze (HIGH):** geo-chain stiffness > 2/3 made `regionFeel` return stiff > 1 ->
  `pow(negative, fractional)` = NaN -> every geo-sprung chain froze at rest via the per-frame NaN
  reset. Capped below 1 in `regionFeel` + regression tests; `impulse()` also gained finiteness
  guards (Infinity vector = NaN tip; Infinity dur = immortal zombie impulse).
- **Strict wire tightened** (protocol.js + python mirror + tests): required fields reject
  null/""/whitespace (they used to dispatch and answer reqId callers with silent `undefined`);
  `recolor` requires index-or-name; a garbage `query.what` is a named error ("actions" and a
  MISSING what stay valid). Conjure: documented `at`/`to` array forms now work (they silently
  no-oped -- `.x` off an array), string `to` is an honest "not a feature", unknown dismiss/move
  ids reply `{error}` not fake success, and a same-id double-spawn can no longer leak an
  undismissable ghost prop into the click silhouette.
- **Facial truth:** the VRM tier drives the ACTUAL matched expression name (case bug: probe was
  case-insensitive, setValue exact -- "MouthOpen" models had no lip-sync while info claimed
  otherwise); `blinkMode:"vrm"` is only reported when a blink preset EXISTS; `facialTune` accepts
  the documented `jawAxis`/`lidAxis` strings (numericOnly silently stripped them); composite
  smile/brow morphs get ONE owner (channels no longer fight).
- **Leaks + races:** all teardown paths dispose TEXTURES (util/dispose.js -- material.dispose()
  alone leaked the texture set per model swap / prop despawn / ball throw); one AnalyserNode no
  longer leaks per utterance; drag-drop `loadFile`/`loadFiles` honor the `_loadSeq` last-caller-wins
  guard; an attach that finishes after a model swap is dropped instead of writing into the WRONG
  model's profile.
- **Compositor clamp gaps:** on no-hinge roles (head/torso) parts-pitch + flex-pitch are clamped
  COMBINED (was 2x the advertised limit); released abduction eases at the speed limit (was the one
  hard snap left). Softmesh: displacement amplitude honors the bindMatrix scale, and claims are
  keyed by the shared position BUFFER (two meshes sharing one geometry can no longer corrupt the
  pristine restore).
- **realmodels.test.js repaired:** the EXPECT table pointed at renamed/deleted files, so only
  makiro exercised the cascade while the suite stayed green (zhu_yuan's Daz lock silently skipped).
  Re-keyed to the real library (all 5 installed models + 6 external), plus a completeness guard:
  an installed-but-unlocked model now FAILS the suite.
- **voice.py service:** TTS no longer held hostage by a missing faster-whisper, and the
  first-call-fails/second-call-passes gate is gone (load() is idempotent and nulls failed
  providers -- presence == loaded); socket framing reads exact lengths (short recv crashed the
  connection) with a 32MB cap. bus.py logs hub-logic errors instead of swallowing them as
  disconnects; the `app://enigma/@fs/` handler requires an ABSOLUTE path (a UNC-mangled relative
  path used to resolve against the CWD).
- Suite: node **315 pass / 0 fail / 6 skipped** (external-library locks), pytest **21/21**,
  eslint + tsc + prettier clean, smoke **7/7** with ryuri booted, visible, and driving.

## 2026-07-02 (later) -- animation session findings + 4 fixes

- **Rig fix (the "legs bend backwards" bug):** on Source/GMod rigs (fnia pack) the LEG roles
  resolved to `ThighJigR/L` jiggle helpers because (a) the real thigh is named `bip_hip_R` and the
  sided-hip rule rejected it as an auxiliary center bone, and (b) SKIP only knew the spelling
  "jiggle", not "Jig". Fixed in `src/rig/rig.js` (sided hip -> leg; bare `jig` in SKIP) + pinned in
  `tests/rig.test.js`. Live receipt: fnia legs now drive `bip_hip_*`/`bip_knee_*`, knee folds the
  right way (side-view snaps).
- **`highlightBone` accepts canonical roles** (`left_arm`), not just raw bone names, and
  `capabilities` now returns `roleBones` (role -> real bone name) -- the "which bone is my arm"
  introspection. `showBones` + role highlight + a small flex + a side snap = the bone-direction
  check recipe.
- **`size` grow-anchor:** `{action:"size", value, anchor:"feet"|"hips"|"head"}` -- default stays
  feet (floor-planted); `head` pins the face on screen for the walk-up-to-the-screen loom.
- **Object-physics knobs:** Settings -> Advanced physics gained "Object gravity" (live) and
  "Object bounce" (next throw), saved per avatar (`profile.objects`), engine defaults -14 / 0.62
  (`physics.tune`). The Ball menu's behavior is now observable and tunable.
- **Multi-character packs:** the rig binds ONE skeleton (first in traversal); other characters are
  statues. Isolate a character with Parts show/hide and save it as an OUTFIT (fnia has "bonnie"
  saved). Gotcha: isolated characters keep their authored offset from the pack origin.
- **Conjured-props escape hatch:** right-click menu gained a "Conjured props" submenu (per-prop
  dismiss + clear all; only shows while props exist) — an AI-stranded prop is no longer bus-only
  (user hit exactly that: a test chair sat mid-screen untouchable). `api.conjureIds/-Dismiss/-Clear`,
  registry scope=brain (props live in the brain scene).
- Suite at the time: node 282/0 (11 skip), pytest 21/21, eslint+prettier clean. (Since committed.)

## 2026-07-02 — the file:// era is over

- **The page is served from `app://enigma`** (a custom Electron protocol in `shell/main.cjs`), not
  `file://`. `fetch()` works, `'self'` in the CSP covers everything local (no `file:` carve-outs),
  and the bus Origin is the literal string `app://enigma`. External model libraries and TTS WAVs
  ride `app://enigma/@fs/<absolute path>` (mapped in `src/util/localurl.js`); loading from outside
  the repo keeps working with no path restriction.
- **Why it happened:** `fetch("./bone_limits.json")` (and `profiles.json`, and the FBX
  `materials.json` sidecar) can NEVER succeed on a `file://` page — so the joint/speed-limit system
  was silently inert on every live launch from its introduction until 2026-07-01, while http-served
  tests passed. The limits table (90 deg/s caps, real joint ranges, 60 deg/s default) is **live for
  the first time**: bus-authored poses now EASE instead of snapping, and any drive recipe tuned
  before 2026-07-01 was tuned without clamps.
- **The bus wire is STRICT:** `connect()` validates every inbound command against
  `src/control/protocol.js` — an unknown action or missing required field gets a NAMED
  `{error: reason}` reply (reqId callers) and never dispatches. The registry stays lenient for
  in-process callers.
- **The kill-switch authority lives in MAIN** (persisted in `window-state.json`, no renderer
  localStorage): tray and Settings both route through one setter; every window mirrors the pushed
  state; `avatar:init` seeds it race-free.
- **The bus routes replies:** requests' reqIds are rewritten to unique hub ids and each reply goes
  back to its asker alone (two drivers both using `"reqId": 1` can no longer consume each other's
  answers). A bus monitor no longer sees routed replies — only requests and unrouted replies.

A rigged 3D model (human / animal / robot) that floats on a transparent, always-on-top,
click-through desktop overlay (Desktop-Mate-style). Loads any glTF/GLB/VRM/FBX, drives
AI-composed procedural motion (a masked, weighted LAYER stack) + spring physics + facial lip-sync,
and is driven by Enigma / Odysseus (or any LLM) over a local bus.

## CURRENT STATE -- intent overhaul (2026-06-26)

The engine is primitives-only (no canned gestures), purely generic (no per-model data), and now
composites motion correctly with a velocity cap. Read these first -- some older sections below
predate them:

- **No canned gestures / emotes / clips anywhere.** All motion is composed from PRIMITIVES
  (`pose` / `flex` motion layers + per-finger curl, authored by the AI via `perform`). There is
  no gesture, emote, or clip _catalog_ to call -- "purge means purge". (The old `express` bus
  action and `say.py` `express`/`play`/`loop` commands are gone; the AI authors emotion as layers.)
- **No per-model data.** The per-model `rig_overrides.json` mechanism was **removed end-to-end**
  (loader, the resolver's force/exclude tier, the spring `extra`/`never` and facial
  `mouthMorph`/`blinkMorphs` hooks, the diagnostic tools' override loading, and their tests).
  The rig resolver is now **purely generic**: VRM -> name -> geometry -> structural "between"
  repair. A mis-identified rig is fixed by improving a tier or repairing the model FILE
  (`tools/` model-repair) -- never a hand map. The lone per-model eye-flip is now the global
  default (`EYE.flipY: -1`).
- **Full per-finger control.** Every finger joint resolves into a named chain; `setFingers(side,
spec)` drives any finger 0..1 (composing over the reactive carry-grip), exposed on the bus as
  `fingers` and listed in `capabilities().channels.fingers`. (Replaces the whole-hand `gripFingers`.)
- **Compositor is TRUE sum-then-cap with a velocity clamp.** Same-role layers SUM, then the summed
  offset is clamped ONCE to the per-role joint limit (was wrongly cap-per-layer-then-compose); the
  `flex` channel honors the same per-role limits (was a flat +-2.2 rad); and a per-frame angular
  delta clamp enforces each role's `speed_limit` (deg/s) from `bone_limits.json` so motion is
  velocity-continuous and never janky. The layer `speed` param is now meaningful for data layers
  (was a no-op). (Measured 2026-07-02: co-speech is NOT affected by the clamp — its peak angular
  velocity is ~30 deg/s, well under the 90 deg/s caps. What the clamp DOES shape is every
  bus-authored pose/flex layer. Note the whole table was silently inert on live launches until
  2026-07-01 — see the 2026-07-02 entry above.)
- **VRM bodies now actually move.** `vrm.humanoid.autoUpdateHumanBones=false` is set at load, so
  `vrm.update()` no longer copies the rest-pose humanoid bones back over the AI pose every frame.
  Pinned by `tests/vrm_order.test.js`.
- **Strict blink (no autonomous blinking).** The free-running auto-blink timer is REMOVED. A blink
  fires ONLY on a real drive: speech onset (`onSpeakStart`), or the bus `blink` action / a held
  `setBlink`. Default = eyes open. Both facial facades (bone/morph and VRM) expose `blink()`/
  `setBlink()` with one facade shape (VRM gained `setBlink`/`blinkMode`/`ownedMorphs`).
- **Inert no-model marker.** `default_avatar.js` no longer builds a self-made character -- it
  returns an empty `NoModelMarker` (0 bones, 0 roles). With no model loaded the overlay shows a
  styled ASCII DOM message: "No model loaded - right-click and choose Add model to load a .glb
  file." (A nicer placeholder is a FUTURE item.)
- **Loadable formats are honest: glTF / GLB / VRM / FBX only.** `.obj`/`.dae` are dropped (they had
  no parser and failed with a misleading "not valid JSON" error). FBX material-bind failures now
  surface to the log instead of being swallowed.
- Suite: `node --test` -> **326 pass / 0 fail / 6 skipped** (2026-07-06, incl. softmesh, expression
  channels, the grab-feel work and every audit pass's regressions); pytest **21/21** (origin gate incl. `app://enigma`, reply routing,
  protocol mirror, bone data, voice service); eslint + prettier + tsc clean; smoke **7/7**.

## Motion compositor & AI control (P1-P4)

The AI composes ALL motion as masked, weighted LAYERS on a stack (no canned gesture library);
disjoint roles SUM, same-role layers SUM-then-cap, timed layers self-expire. Driven over the
bus (`handleCommand`):

- **`pose` / `layer` / `capabilities`** (P1) -- set a motion layer `{parts,flex,weight,amp,speed,dur,env,id}`,
  run layer-stack ops (add/clear/clearAll), and query what THIS model can drive (roles, flexRoles,
  expressions, channels incl. per-finger control, per-role angle limits + speed limits, units). The
  compositor lives in `procedural.js` (`setLayer`/`applyLayers`): same-role layers sum, the summed
  offset is clamped once to the joint limit, and the per-frame delta is rate-limited to each role's
  `speed_limit`. The motion math is in `motionmath.js` (unit-tested).
- **co-speech** (P2) -- `voice.js` publishes the live speech-RMS envelope; `avatar.js` drives a
  `cospeech` BODY layer (`coSpeechPose`) so she moves while talking (not just the jaw); auto-clears
  on speech end. (Measured 2026-07-02: its ~30 deg/s peak sits under the 90 deg/s clamp -- the
  speed limit never bites it.)
- **`conjure`** (P3) -- `conjure.js`: spawn a prop, glide/hover/follow-a-hand, poof-dismiss
  (transform-based; rapier stays for throw/drop). `conjure spawn|move|dismiss|clear`. A bare prop
  name resolves through `resolvePropName`/`CONJURE_ASSETS` (unknown name = honest error, not a
  silent guess); a miss surfaces via `onMiss`. `moveTo` preserves a 2D prop's depth when z is omitted.
- **`expr` / `stretch` / `poke`** (2026-07-03/04) -- `expr {smile,brows}` drives expression channels
  down per-channel ladders (VRM preset -> named morph -> face bones -> honest none; the reply's `via`
  names the tier per channel, `query capabilities`.expressions reports it up front). `stretch`
  grabs a bind-space skin region near any role/bone, holds/drags it, springs back bit-exact on
  release; `poke` dents/bulges along vertex normals (`softmesh.js`). All three live on the
  `EnigmaAvatar` facade too (devtools-drivable) and reply truth, never silence.
- **`perform`** (P4 substrate) -- `control.js` parses inline tags in the LLM's own speech
  (`[emotion]` / `[conjure:x]` / `[pose:role=val]` / `[look:dir]`) into motion AND returns the clean
  TTS line. `[pose:role=val]` drives a full `[pitch,yaw,roll]` triple (`val` or `p/y/r`), not pitch-
  only; `[look:dir]` covers 8 compass directions + an explicit `look:px,py` point form and pushes an
  honest `look-skip:` marker (no false success) when a direction can't apply. The whole control
  surface is plain text an AI authors and a human reads -- no opaque policy.
- **OPEN (P4 brain + feel):** the LLM that authors the tag/pose streams (P4 "the brain") is the
  remaining build, intentionally designed WITH the user (see the blueprint sec 9), and feel tuning
  by the user's eye -- motion amplitude/choreography, the velocity-clamp's effect on co-speech
  snappiness vs the Filian target, jaw axis/lip-sync gain -- is a manual pass on the live overlay
  (headless tests can't judge feel; software WebGL can't render skinned meshes).

## Architecture (modules)

The engine is split into focused modules; `src/avatar.js` is the orchestrator that wires them.
Files are folderized by concern (2026-06-29): `shell/` (Electron main), `src/<concern>/`
(`model rig motion face audio interaction control ui util`), `python/` (bus + CLIs), `voice/`
(vendored TTS). Full tree in `README.md`; the bare module names below now live under those folders.

- **`rig.js`** -- bone **identification** cascade (the heart): `resolveRig(model, vrm)` maps any
  rig's bones to the 19 canonical roles via generic tiers, each filling only still-empty roles:
  **VRM humanoid -> name regex -> geometry/topology -> structural "between" repair**. No per-model
  data. Geometry degrades gracefully -- a non-biped (GLaDOS, a dragon) gets no false limbs, and a
  name-resolved quadruped no longer bypasses the geometry upright gate (no false arm/torso roles on
  creatures). Pure functions over a bone snapshot -> unit-tested with synthetic skeletons (no WebGL).
- **`procedural.js`** -- the motion compositor: applies the AI's masked, weighted `pose`/`flex` layers (+ per-finger curl) over `rig.js`'s role map. No idle/emote catalog. `setLayer`/`applyLayers` sum same-role layers, cap the sum once to the joint limit, and rate-limit the per-frame delta to `speed_limit`.
- **`spring.js`** -- spring-bone physics (hair/tail/ears); name + geometric fallback. Role-matched
  bones are passed as an `exclude` set so a humanoid's limbs never get sprung. Geometric-fallback
  chains no longer sag under gravity at rest (gravity is gated on real body motion).
- **`facial.js`** -- VRM expr -> morph -> jaw-bone -> none; lip-sync + blink, with independent mouth
  and blink ladders, plus smile/brows EXPRESSION channels (morph -> face-bone tiers, mesh-aware
  morph ownership so channels never fight). Blink is strict (no free-running timer): driven only
  on speech onset or the bus.
- **`softmesh.js`** -- soft-body mesh deformation: grab/pull/hold/spring-back + poke along normals,
  selected + calibrated in BIND space (rides GPU skinning); claim-exclusive regions restore bit-exact.
- **`loader.js`** -- multi-format loading (glTF/GLB/VRM/FBX only, spec-gloss compat, FBX material
  bind with failures surfaced to the log).
- **`voice.js`** -- speech playback + RMS-driven mouth.
- **`conjure.js`** -- transform-based prop spawn/glide/hover/dismiss; rapier for throw/drop.
- **`physics.js`** -- rapier rigid-body props; thrown props use CCD + thick platform slabs (no tunneling).
- **`control.js`** -- parses `perform`'s inline speech tags into motion + the clean TTS line.
- **`ui.js`** -- the right-click menu + Settings dialog (all DOM). The Jiggle/Cloth/Morphs panels use
  NUMERICAL inputs (no sliders); the attach-bone picker is capability/role-driven.
- **`main.cjs`/`preload.cjs`** -- the Electron shell (transparent overlay, IPC, monitor hop, import dialogs).

## What works

- **Floats in place** (no gravity/walk); grab its actual **silhouette** (rendered shape), so empty
  space around limbs clicks through to the desktop. Degenerate rigs fall back to a body column.
- **Bone-ID cascade** identifies rigs robustly. Verified on the model zoo (see Per-avatar below);
  a future mis-identified rig is fixed by improving a cascade tier or repairing the model file, not a per-model map.
- **Spring physics** -- hair/tail/ears/wires sway; opaque rigs (Toothless) use the geometric fallback.
- **AI-composed motion** -- no gesture/emote/idle/clip catalog; the AI builds movement from `pose`/`flex` layers + per-finger curl (or `perform`). Disjoint layers sum, same-role layers sum-then-cap, timed layers self-expire; left idle she stands still.
- **Facial** -- amplitude lip-sync (morphs/visemes or a jaw bone) + strict blink (speech-onset / bus only, no autonomous blinking).
- **Voice** -- Kokoro TTS speaks; mouth lip-syncs to the audio (no cloud, **no fallback**).
- **Right-click menu + Settings** -- models, Add model.../clothing/prop/furniture, Size,
  Move to monitor, and a Settings dialog (model, size, hair physics, per-part color/hue tint,
  toggles for spring/look/face/lock/skeleton/panel, attachment fitting).
- **Multi-monitor** -- per-display window; right-click -> Move to monitor, `Ctrl+Shift+Alt+M`, drag across an
  edge to hop. **Cache disabled** in the shell, so renderer edits load fresh (no `?v=` bumping).
- **No model loaded** -- an inert marker; the overlay shows an ASCII DOM hint to add a `.glb`.

## Run it on your desktop (NO admin)

**Double-click the `Enigma Avatar` desktop icon** (runs `Start-Avatar.ps1` hidden; also `Enigma Avatar.bat`,
or run `Start-Avatar.ps1` directly to see logs). It pops onto your desktop with **no UI** -- **right-click it**
for everything. Portable **Node v24** (`%LOCALAPPDATA%\node-portable`) + Electron are installed locally; first
launch runs `npm install`. **Never use a winget MSI** (needs admin -- see the `no_admin_constraint` memory).

- **left-drag** move; scroll or **+/-** resize (**0** resets); **Ctrl+Shift+Alt+Q** quit; **Ctrl+Shift+Alt+C** force click-through (PANIC: reclaim the desktop if she ever blocks clicks); **Ctrl+Shift+Alt+A** force interactive (reach the panel); **H** info panel.
- Size is remembered per model (localStorage); per-avatar attachments / physics / colors persist in `profiles.json`.

## AI control (the bus)

- **`bus.py`** -- routing hub on `ws://127.0.0.1:8765` (the launcher starts it; or run it standalone).
  A driver sends JSON `{action, ...}` commands that the registry (`src/control/bus.js`) applies; any
  LLM that speaks that protocol drives her. Commands broadcast; replies are ROUTED to their asker
  (reqIds rewritten to hub ids and restored on delivery), so concurrent drivers never cross wires.
  The wire is STRICT: invalid commands get a named `{error}` reply and never dispatch.
- **AI-control kill-switch ("no surprises").** MAIN owns the toggle (persisted in
  `window-state.json`, default ON); every window mirrors it, and the bus gate reads the mirror at the
  `connect()` chokepoint (`src/control/surface.js`): while OFF, EVERY inbound command is dropped
  before it dispatches (queries included -- a reqId driver gets an honest
  `{"error":"ai control paused"}` reply), so nothing over the bus can be a surprise. Flip it from
  **Settings -> "Accept AI control (bus)"** or the **tray** checkbox (reachable even when she can't be
  clicked); the still-open socket resumes instantly. Each ACCEPTED command also briefly reveals the
  status line ("AI: <action>") so an AI-driven move is never mistaken for a glitch. Origin gating in
  `bus.py` (`ALLOWED_ORIGINS = [None, "app://enigma"]`) still blocks cross-site (browser) producers
  at the handshake.
- **`say.py`** -- CLI: `say.py model chica`; `size 0.8`; `fingers R 1`; `perform "Hi! [pose:right_arm=1.0]"`; `snap`; `demo` (run with no args for the full list). Fails honestly on bad args (no raw traceback); ASCII help.
- **`speak.py`** -- Kokoro TTS: synthesize text and have her speak it + lip-sync.

## Tests

- **`npm test`** (in `enigma-avatar/`) runs the Node unit tests in `tests/`: the rig cascade (name /
  geometry / VRM tiers, with negative assertions for graceful degradation), spring detection, the
  compositor sum-then-cap + speed-limit math, and `tests/vrm_order.test.js` (proves `vrm.update()`
  no longer stomps the AI pose). The suite asserts INTENT, not current behavior. Current count:
  **326 pass / 0 fail / 6 skipped** (2026-07-06; the skips are the external-library realmodels locks).
- **`node tools/rig_report.mjs`** -- headless cascade inspector: extracts each model's REAL bone snapshot from
  its glTF JSON (names + world positions + hierarchy, no WebGL / no mesh decode) and runs the SAME tiers the
  engine uses (incl. the tier-3.5 `resolveBetween` step + the current facial regexes + a blink-channel probe),
  printing which of the 19 roles resolve and by which tier. `--bones` dumps every bone (height% /
  side); pass a path for one model, or no args for all. `tests/realmodels.test.js` turns this into a regression
  guard that LOCKS the per-model counts in "Per-avatar reality" below (with an `AVATAR_MODELS_DIR` override +
  a guard that fails loudly on an all-skip masquerade) -- so a cascade change that quietly breaks
  a real rig fails the suite. (Skips cleanly on a fresh clone, where `models/` is gitignored-absent.)
- (`tests/test_avatar_bone_data.py` locks the 19 role names in `bone_limits.json` on the pytest
  side; the once-referenced `test_avatar_rig.py` never existed in this repo.) Verification of
  _rendering/feel_ still needs real eyes (software-WebGL can't render skinned meshes) -- drive the
  live overlay + `EnigmaAvatar.snap()` to inspect.

## Per-avatar reality (cascade results)

_All counts below are ASSERTED by `tests/realmodels.test.js` (verified via `tools/rig_report.mjs`)._

- **Roxanne / 51dc** -- 19 roles by name; full role coverage + hair/tail physics.
- **Mal0 / Toy Chica / Fexa** -- 19 roles (name + geometry filling torso/limb gaps; Chica's Blender `.L/.R` sides resolve -- the old T-pose is fixed).
- **Lolbit** -- 17: its arms are a 3-joint `Shoulder->Elbow->Wrist` chain with **no separate upper-arm bone**, so `left/right_arm` stay empty (Shoulder->`shoulder`, Elbow->`forearm`, Wrist->`hand`). **Mangle** -- 15: no `hips` bone, chest is named `Spine1` (loses to `Spine` for the `spine` slot), and decorative `ShoulderPad` + a duplicated skeleton confuse the right side. Both could be recovered by a cascade-tier improvement, but because it means mapping a role onto a joint it wasn't named for, the resulting arm-swing **feel needs a live look** -- measure any candidate with `node tools/rig_report.mjs <model>` first.
- **GLaDOS** -- head/neck only (no body); her wires spring. Correct.
- **Night Fury (Toothless)** -- non-biped: geometry declines it (wings aren't arms), so it stays a spring creature (tail + wings sway), no bogus limb motion.
- **grace_howard** -- MMD export whose Japanese bone names were **already corrupted to `U+FFFD` at export time and baked into the (valid-UTF-8) glTF as literal replacement chars** (~2.6k of them; the original Shift-JIS is gone, not recoverable from this file). three.js and the `rig_report` tool both read the same `U+FFFD` soup, and many bones collapse to identical names -- so the name tier can't even address them uniquely. It needs a **UTF-8 re-export from the source MMD model** (or new geometry-tier coverage), not a name map. **Spyro** -- no skin/joints (static), correct.

## Next (open work)

1. **Feel tuning by the user's eye** on the live overlay: motion amplitude/choreography, the
   velocity-clamp's effect on co-speech snappiness vs the Filian target, jaw axis/sign (`facialTune`),
   lip-sync gain. Headless tests can't judge feel.
2. **P4 "the brain"** -- the LLM that authors the tag/pose streams over the bus. The bus +
   `perform`/`pose` path is built & tested; any OpenAI-compatible author (a local model, OR Claude/any
   agent) can drive her over the bus today via `say.py` / `avbus.py` / Odysseus -- tags are sanitized
   against live caps first. NOT blocked on Enigma (which is the future local-from-scratch author, still
   pretraining). (The standalone `brain.py` decide->act->verify driver loop and its `--llm` author were
   REMOVED 2026-06-30 at the user's request, along with the cursor-follow gaze system and the
   `src/engine/state.js` container.) What remains is the persistent perception/memory "mind", designed
   WITH the user.
3. **A nicer/"cuter" no-model placeholder** (current state is just the ASCII text hint).
4. **Model-zoo stragglers** (measure each with `node tools/rig_report.mjs <model>`, confirm the swing
   live): lolbit/mangle arm (+mangle hips/chest) via a cascade-tier improvement; grace_howard needs a
   **UTF-8 bone-name re-export** before the name tier can bite (its names are baked-in `U+FFFD`
   mojibake -- see Per-avatar above).
