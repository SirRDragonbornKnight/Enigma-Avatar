# Avatar model notes — where a VRChat-style avatar's "settings" actually live

_Investigation 2026-06-09 (tools/inspect_model.py over the installed library)._

## TL;DR

Every model currently installed is a **Sketchfab GLB export**. A GLB/FBX export keeps the
**mesh + skeleton** and _sometimes_ **morph targets (blendshapes)** — and **drops everything
else**. So an avatar's "extra settings" survive in our files as exactly two things:

1. **Morph targets / blendshapes** → exposed in Settings as **Shapes / morphs** (by index).
2. **The bone rig** (incl. NSFW jiggle chains) → exposed as **Jiggle** regions (per-area weight).

There is **no embedded toggle menu** in any current model, because that menu is a _Unity_ thing.

## What each avatar-format carries

| Where settings live                                                                                                                            | Survives a GLB/Sketchfab export?                                  | How we read it                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **VRChat** — VRCAvatarDescriptor, Expression **Menu**/Parameters, **PhysBones**, Contacts, Constraints                                         | ❌ No — these are Unity components, not glTF. Stripped at export. | n/a (gone)                                                                                                                            |
| **VRM** (`.vrm` = glTF + `VRMC_vrm` / `VRMC_springBone`) — expressions (blendshape presets), spring bones, first-person, look-at, meta/license | ✅ Yes — embedded in glTF extensions                              | `@pixiv/three-vrm` (already a dep) → `asset.vrm`; `vrm.update(dt)` drives springs+expressions. **Dormant today** (no .vrm installed). |
| **Morph targets** (glTF `mesh.primitives[].targets`)                                                                                           | ✅ Yes (names usually stripped)                                   | `EnigmaAvatar.morphs()` → Settings "Shapes / morphs", by **index**                                                                    |
| **Skeleton / jiggle bones**                                                                                                                    | ✅ Yes                                                            | `spring.js` + `region.js` → Settings "Jiggle" per-area weights                                                                        |

## The library we scanned (all Sketchfab GLB, no VRM, no embedded menu)

| Model               | Skin       | Morphs             | Notable jiggle bones                                                                                                                  |
| ------------------- | ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| **mal0_scp-1471**   | 277 joints | 0                  | full NSFW rig: `DEF-Breast.*` (8), `DEF-Butt1.*` (6), `Pussy1/2/3 · AssHole1/2 · DE-Dick1.*` → **genital 33**, hair 39, ear 8, tail 7 |
| **renamon**         | 254        | 0                  | ears, tail(9), rearShoulderFluff (→ accessory), hip                                                                                   |
| **makiro**          | 79         | **19 / body mesh** | Breast (2-bone), front hair                                                                                                           |
| **bunny-robot-r34** | 0 (rigid)  | 0                  | none — parts = meshes only                                                                                                            |
| **aveline_robot**   | 141        | 0                  | tail(9), thigh (NOT sprung — structural), ear, heart (NOT ear — guard)                                                                |

### Mal0 specifics (the user's question)

- **"Show her boobs"** = hide the **clothing MESH** (Settings → Parts → untick the cloth mesh).
  The body+chest is modelled underneath. It is NOT a blendshape toggle (Mal0 has 0 morphs).
- **"Bones for a dick"** = the `DE-Dick1.001…007` chain (+ Pussy/AssHole). These are now a
  first-class **genital** jiggle region (live count: 33 bones) with its own weight slider.
- Mal0's **cloth is a mesh with no cloth bones** → it can't sway via bone-springs; that needs a
  vertex cloth sim (not built). The Cloth weight slider drives cloth _bones_ when a model has them
  (skirts/capes), and the Settings note says so.

## How "settings" map onto our UI (capability-driven, trust-no-names)

- **Jiggle (per area):** `region.js` classifies each soft/dangly bone → breast / butt / genital /
  belly / hair / tail / ear / wing / cloth / accessory. Each region gets a 0..2 weight (0 = rigid,
  1 = default, 2 = bouncy). Saved per avatar in `profiles.json` → `regions:{}`.
- **Shapes / morphs:** every shape key by index, 0..1 slider. Saved → `morphs:{}`. (This is the
  generic stand-in for a VRChat toggle/expression menu on a name-stripped GLB.)
- **Parts:** every mesh by index — show/hide (remove/add) + rename. Saved → `hiddenMeshes`, `meshLabels`.
- **Rotate:** yaw °, or "Rotate by dragging" (spin the body with the mouse). Saved → `yaw`.

## When a real `.vrm` arrives (future)

`three-vrm` is already installed, so `asset.vrm` will populate and:

- **Spring bones** drive automatically via `vrm.update(dt)` (we already skip our own spring for VRM).
- **Expressions** (`vrm.expressionManager`) are NAMED toggles — surface them in the same
  "Shapes / morphs" section but with their real names instead of `#index`.
- **Meta/license** can gate redistribution (keep copyrighted VRMs gitignored, as we already do).

## MODEL VARIANCE STUDY — all 12 installed avatars (static scan 2026-06-10)

_describe.mjs + supplemental probes; full table in the session log. The point: no two models agree
on units, bind pose, naming, or capability set — this section is what to check when a NEW one lands._

### Per-model one-liners (the thing each one breaks)

- **roxanne_wolf** — the control specimen: perfect T-pose, 19/19 roles, jaw lip-sync, 20 fingers/hand. BUT folder-format gltf with **71MB external 4K textures** (+license.txt) — imports must carry the folder.
- **sexy_roxanne_wolf** — same character, DIFFERENT rig family: chest + upper arms unresolved, **jaw GONE** (SFW Roxanne lip-syncs, NSFW can't), an `Eye_Con` controller passes the eye filter as a 3rd "C" eye. Same character ≠ same rig.
- **mal0_scp-1471** — 277 bones, **48% zero-weight**; the canonical WAVING bind; static describe resolves head≡right_shoulder (same node!) — ⚠️ verify `query roles` live vs describe before driving her head by scan data.
- **makiro** — A-pose; **Z-up bind space ~5× smaller than world** (raw-data tools get garbage without node transforms); 76 morphs all UNNAMED ×4 meshes; DUPLICATE eye pairs; unlit materials.
- **renamon** — Maya namespace on 253/254 joints; bind in **centimeters**; thigh named "hip", upper arm named "shoulder", NO pelvis name → hips/thighs/upper-arms unresolved; digitigrade bent-back knees; **116-bone fluff** under one "accessory" slider; 30MB single texture.
- **lola_bunny** — upper arms named "shoulder 2" (joint-style naming) → arm IK/hang skipped; **±-prefixed wardrobe system** (25 variant meshes: Fit/Nude/Topless/…); 87/236 zero-weight joints.
- **aveline_robot** — display-POSED bind (left arm raised 65°, knees folded) on a full 19/19 rig; 5 rigid ribbon meshes poison the bbox (19×19 units); ONE center eye; no mouth.
- **fexa_blender** — chest filled by the geometry tier; **Eyepatch** classifies as a 3rd eye (gets eye-look drive!); big units (skel 88).
- **glados** — non-humanoid (2/19), hangs from the TOP of her bbox (feet-at-bottom shadow logic wrong by construction); folder-format.
- **marie** — **BROKEN: 147/149 bone names are U+FFFD mojibake** → 0 roles, no springs (can't address bones by name); 29 of 41 meshes are rigid props. Fix = UTF-8 re-export, out of engine scope.
- **valkyrie_tyan_nsfw / bunny-robot-r34** — 0 joints: STATIC statues. Load/size/move/recolor/Parts only; every animation layer must no-op gracefully (they do).

### What's universal vs not (the assumptions audit)

- UNIVERSAL (12/12): Sketchfab exports, single scene root, ≤1 skin, no VRM, no mixamorig, **morph names never survive**, materials always present.
- MAJORITY: rigged (10/12); ≥16 roles (7/10 rigged); name tier does ~all role work (geometry tier filled only 5 roles across the library; the per-model override mechanism was never needed and has since been removed).
- **NOT majority — bind pose**: only 4 of 8 measurable rigs are T-pose (A / waving / posed / digitigrade-relaxed make up the rest) → aimArm + per-rig flex calibration are load-bearing on HALF the library.
- **The COMMON case has NO mouth**: 8/12 models have no lip-sync channel at all (jaw bone: 3; geometric morph pick: 1). Silent-face `say` is normal, not an edge.
- Eyes: exactly-2-sided-eyes is only 5/10 — extras (controllers, eyepatches, dupe pairs, center eyes) ALL get driven; there is no side-C dedupe. ⚠️ engine gap to watch.
- Zero-weight joints in EVERY rigged model (median ~38, up to 48%) — bone counts always overstate drivable bones.
- Scale spread: native heights 0.56 → 199 units (~350×); files 2.2 → 88MB; textures 0 → 80MB.

### ⚠️ ACTIONABLE cross-model pattern (rig.js candidate)

In 3 of 10 rigged models (lola, sexy_roxanne, renamon) the **upper-arm role fails for the same
reason: the upper-arm bone is literally named "shoulder"** (joint-style naming: shoulder→elbow→wrist).
Upper-arm is the most-missed role in the library (3×), then chest (3×), then hips/thighs (renamon).
ONE name-tier rule — "a second 'shoulder' in the same chain (or the child of a resolved shoulder
that parents a forearm) = upper arm" — would recover 6 arm chains across 3 models, enabling
arm-hang/IK/clap on all of them.

### NEW-MODEL CHECKLIST (run before first drive)

1. `describe.mjs` → type + health (mojibake names = dead on arrival; re-export UTF-8).
2. Roles: check the 3 fragile ones first — hips, chest, BOTH upper arms; two roles on one node = geometry-tier suspect.
3. Bind pose: arm elevation/elbow/knee angles (T? A? posed? digitigrade?) — non-T makes normalization load-bearing.
4. Units/axes: bind bbox vs skeleton world height (cm rigs, Z-up bind data exist).
5. Meshes: unskinned props/ribbons (bbox poison), wardrobe variants (±-prefix, suit/skin) + default visibility.
6. Fingers per hand (0–29 seen), eye bones (+ false candidates: patches, controllers, dupes).
7. Mouth: jaw / morph / NONE (expect none).
8. `classifyBone` over the joints: regions present, NSFW set?, over-matches (renamon's 116 "accessory"), custom spellings ("Hear").
9. Zero-weight share; texture budget + largest file; file-size-vs-texture gap (= geometry density → load hitch).
10. After load: **`query roles`/`query model` on the LIVE overlay — static describe is a preview and can disagree (mal0's head)**.

## Tools (kept under enigma-avatar/tools/)

- `inspect_model.py <file.glb…>` — offline dump of a model's extensions / nodes / meshes / morphs.
- `avbus.py <cmds.json>` — drive / query the LIVE overlay over the bus (regions, morphs, weights,
  rotate, rename…) — for actions the MCP `avatar_command` schema doesn't expose.
