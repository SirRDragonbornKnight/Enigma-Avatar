// Enigma Avatar — engine (FLOATING desktop companion).
// Loads any rigged glTF/GLB/VRM and drives it with AI-composed procedural motion (pose/flex layers).
// It FLOATS anywhere on screen (no gravity / no walking) — drag to reposition
// (it stays), scroll to resize (remembered per-model). Spring-bone physics
// (hair/tail) and AI expression control are layered on top of this.
// NOTE: software-WebGL previews can't render skinned meshes — use a real browser.

import * as THREE from "three";
import { VRMUtils } from "@pixiv/three-vrm";
import { loadAsset, kindOf, baseName } from "./model/loader.js";
import { createVoice } from "./audio/voice.js";
import { createUI } from "./ui/ui.js";
import { buildProceduralRig } from "./motion/procedural.js";
import { coSpeechPose } from "./motion/motionmath.js"; // co-speech body-motion envelope (pure, unit-tested)
import { createConjure } from "./motion/conjure.js"; // P3: transform-based conjure (spawn / move / dismiss props)
import { parseControlTags, parseTagArg, resolvePropName } from "./control/control.js"; // P4: inline bracketed control tags in LLM speech
import { createControlSurface } from "./control/surface.js"; // the EnigmaAvatar control surface (facade the bus/query/devtools drive)
import { createBusRegistry } from "./control/bus.js"; // AI bus command table (action -> handler), wired after the deps exist
import { createProfileStore } from "./engine/profiles.js"; // per-avatar durable setup (headless engine module, carve S1-a)
import { createQueryReporter } from "./control/query.js"; // AI self-report (read-only ground truth) for the bus 'query' action
import { buildSpringBones } from "./motion/spring.js";
import { buildSoftMesh } from "./motion/softmesh.js"; // soft-mesh grab/poke (stretch feature, 2026-07-03)
import { createPhysics } from "./motion/physics.js";
import { buildFacial } from "./face/facial.js";
import { buildSilhouette, overSilhouette as overMask, fallbackGrabHandle } from "./interaction/hittest.js"; // pure, unit-tested click-through math
import { resolveAnchor, nearestPlatformSurfaceY, sanitizePlatforms } from "./interaction/placement.js"; // pure, unit-tested placement math
import { resolveRig, ROLES } from "./rig/rig.js";
import { analyzeMorphGeometry } from "./rig/face-geometry.js"; // morph region classification, exposed via query morphs (2026-07-03 audit)
import { computeWeightMass, subtreeMass, findRoleTwins, groupCoincidentRoots } from "./rig/skinweights.js"; // trust the WEIGHTS: auto-adopt stranded deforming twins + dedup parallel sprung chains (the Rigify disease, generalized)
// clip retargeting (retarget.js) was removed with the clip-library PURGE (2026-06-25) — the AI authors motion via the compositor, not authored clips.
// (#13: no model loaded shows a DOM message via enterNoModel(), not a self-made character. The old
//  default_avatar.js procedural-placeholder was deleted 2026-06-30 — there is no placeholder model.)
import { norm360, signed180, rotFromProfile, rotToSave, pickFps, dipToLocalPx, localPxToDip } from "./util/mathutil.js";
import { disposeMeshTree } from "./util/dispose.js"; // GPU-honest teardown: material.dispose() alone leaks the texture set
import { createGrabFollowFn } from "./motion/grabfollow.js"; // ragdoll grab: the grabbed limb leads, the body follows (pure factory, unit-tested)

// --- the per-frame motion seam (#1 / #24) — defined at module top so it imports WITHOUT the browser
// bootstrap below (no renderer / DOM needed), letting tests assert the REAL ordering, not a fake.
// THE order that makes AI motion survive on VRM: the procedural compositor writes the bone pose
// FIRST, then springs, then vrm.update() runs its OWN systems (spring bones / look-at / expressions).
// On a VRM, vrm.update() would normally copy the rest-pose normalized humanoid bones BACK over the
// raw bones — wiping the pose proc just wrote — UNLESS autoUpdateHumanBones was disabled at load (#1).
// Pure w.r.t. its args (no module globals).
export function stepProcVrmFrame(dt, { proc, facial, facialOn, spring, springOn, rig, vrm, soft } = {}) {
  if (proc) proc.update(dt, false); // base pose + cursor-look + the AI's motion layers + grip (no idle, no clips, no canned gestures)
  if (facial && facialOn) facial.update(dt); // blink + lip-sync (jaw / morphs / VRM weights)
  if (spring && springOn) {
    rig?.updateWorldMatrix?.(false, true);
    spring.update(dt);
  } // hair/tail/wires sway
  if (soft) soft.update(dt); // soft-mesh grabs/pokes: eased take-up while held, spring-back after release
  if (vrm) vrm.update(dt); // VRM spring bones / look-at / expressions (humanoid copy-back is OFF — see #1 at load)
}

// The browser runtime bootstrap (renderer, DOM, animate loop, AI bus) only runs in the overlay
// window. Under `node --test` there is no `location`/`document`, so the module loads as just the
// pure export above and the bootstrap is skipped — keeping avatar.js import-safe for unit tests.
if (typeof location !== "undefined" && typeof document !== "undefined") {
  const params = new URLSearchParams(location.search);
  // NO hard-coded / bundled models — the repo must not reference third-party (copyrighted) avatars.
  // The launch default is the FIRST model the user's models/ folder has (resolved in startup() via
  // avatarIPC.listModels), else the no-model DOM message (enterNoModel — no placeholder). `?model=<url>`
  // still forces a specific one.
  const FORCED_MODEL = params.get("model") || null;
  const DEFAULT_KEY = "__default__"; // synthetic curKey for the zero-asset procedural placeholder (no /models/ path, no override)

  const VIEW_H = 10; // world units spanning screen height (ortho)
  const BASE_H = 6; // avatar world height at sizeScale 1
  const statusEl = document.getElementById("status");
  const setStatus = (m) => {
    if (statusEl) statusEl.textContent = m;
    console.log("[avatar]", m);
  };

  // --- renderer / ortho camera ------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); // cap fill cost on HiDPI — a small avatar doesn't need 2× supersampling
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445, 3.0));
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.5);
  key.position.set(1, 2, 3);
  scene.add(key);

  let worldW = 10,
    worldH = 10;
  let _refH = 0; // primary work-area height (DIP, via avatar:init) — the shared px-per-world-unit reference
  const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, -100, 100);
  camera.position.set(0, 0, 10);
  function frameCamera() {
    const aspect = innerWidth / innerHeight;
    // Constant PX-PER-WORLD-UNIT across every window (user 2026-07-05: she must keep her size
    // hopping between different-resolution monitors): the world span scales with THIS window's
    // height relative to the primary's, so 6 world units render as the same pixel height
    // everywhere. Before, worldH was a constant -> she was a constant FRACTION of each screen.
    worldH = VIEW_H * (_refH > 0 ? innerHeight / _refH : 1);
    worldW = worldH * aspect;
    camera.left = -worldW / 2;
    camera.right = worldW / 2;
    camera.top = worldH / 2;
    camera.bottom = -worldH / 2;
    camera.updateProjectionMatrix();
  }
  frameCamera();

  const toWorld = (px, py) => new THREE.Vector2((px / innerWidth - 0.5) * worldW, (0.5 - py / innerHeight) * worldH);
  const _p = new THREE.Vector3();
  const toScreen = (wx, wy) => {
    _p.set(wx, wy, 0).project(camera);
    return [(_p.x * 0.5 + 0.5) * innerWidth, (-_p.y * 0.5 + 0.5) * innerHeight];
  };

  // --- model / animation ------------------------------------------------------
  // Multi-format asset loading (glTF/GLB · VRM · FBX, spec-gloss compat, FBX material
  // re-binding) lives in loader.js. loadAsset(url, onOk, onErr, opts) hands back a
  // normalized { scene, animations, vrm }.
  const clock = new THREE.Clock();
  const _box = new THREE.Box3();
  const rig = new THREE.Group();
  scene.add(rig);

  // --- ground shadow — a soft contact patch under her feet, so she reads as STANDING on something
  // instead of floating. Scene-level (not a rig child): it stays on the "ground" while she jumps
  // (fading/shrinking with height — the classic grounding cue) and stays flat if she's rotated/lying.
  let shadowMesh = null;
  let shadowOn = (() => {
    try {
      return localStorage.getItem("enigmaAvatar.shadow") !== "0";
    } catch {
      return true;
    }
  })();
  function makeShadow() {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const g = cv.getContext("2d");
    const grad = g.createRadialGradient(64, 64, 8, 64, 64, 62);
    grad.addColorStop(0, "rgba(0,0,0,0.8)");
    grad.addColorStop(0.65, "rgba(0,0,0,0.3)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(cv),
        transparent: true,
        depthWrite: false,
        opacity: 0.55,
      })
    );
    m.renderOrder = -1; // composited UNDER her
    scene.add(m);
    return m;
  }
  function updateShadow() {
    if (!shadowMesh) shadowMesh = makeShadow();
    shadowMesh.visible = shadowOn && !!model;
    if (!shadowMesh.visible) return;
    const w = Math.max(0.35, (modelDims.w || 1.5) * sizeScale * 1.1);
    // Anchor the shadow to the FLOOR (the visible desk line), not to her feet, so it stays on the
    // ground and reads as a real cast shadow when she floats up the screen — instead of a dark blob
    // hovering in mid-air under her. It only follows her feet DOWN, when she's dragged below the desk
    // line (no floor under her there to catch it). Fades + spreads with height (the classic grounding
    // cue). Falls back to the feet line until main has sent this window's display geometry (_gReady).
    const feetY = pos.y + _motionY; // her actual feet, including any jump hop (matches rig.position.y)
    const floorY = _gReady ? floorWorldY() : feetY;
    const height = Math.max(0, feetY - floorY); // how far her feet float above the ground (world units)
    const spread = 1 + Math.min(0.4, height * 0.06); // a higher caster throws a broader, softer patch
    shadowMesh.scale.set(w * spread, w * 0.16 * spread, 1); // flat ellipse on the floor (ortho front view)
    shadowMesh.position.set(pos.x, Math.min(feetY, floorY) - w * 0.02, -2); // on the floor when above it; at the feet when below; z behind her
    shadowMesh.material.opacity = 0.55 / (1 + height * 0.8); // dimmer the higher she floats
  }
  function setShadowOn(v) {
    shadowOn = !!v;
    try {
      localStorage.setItem("enigmaAvatar.shadow", shadowOn ? "1" : "0");
    } catch {}
    updateShadow();
    wake(1);
    setStatus("ground shadow " + (shadowOn ? "on" : "off"));
    return shadowOn;
  }

  let proc = null,
    spring = null,
    facial = null,
    soft = null, // soft-mesh grab/poke deformation layer (softmesh.js, 2026-07-03)
    BONE_LIMITS = {};
  let _weightMass = null,
    _springNeverExtra = []; // skin-weight pass state (per loaded model): bone→mass + the sprung twin chains excluded by dedup
  // --- RIGID-BODY physics (rapier, lazy WASM) — real dynamics for free props (throw the ball!).
  // Soft jiggle stays on spring.js; this layer is the §E foundation for sit/throw/cloth.
  const physics = createPhysics({ scene, loadAsset });
  const conjurer = createConjure({
    // P3: spawn props + move them with cartoon transforms (rapier stays for throw/drop)
    scene,
    loadAsset,
    getBoneWorld: (role) => {
      const r = proc?.roles?.();
      const b = r && r[role];
      return b ? b.getWorldPosition(new THREE.Vector3()) : null;
    },
    onMiss: (url) => {
      setStatus("conjure: couldn't load " + url);
      console.warn("[avatar] conjure: asset failed to load:", url);
    }, // surface a missing/bad prop instead of vanishing silently
  });
  const BALL_URL = "./props/worn_baseball_ball/worn_baseball_ball.glb";
  const CONJURE_ASSETS = { ball: BALL_URL, baseball: BALL_URL }; // friendly conjure names -> bundled prop URLs (stage the .glb on disk; see the audit note)
  let _floorWY = null;
  let _lastPropN = 0; // brain: # props in the last broadcast (send ONE empty buffer when balls clear → peers drop their ghosts)
  // PEER-side ghost props: a peer can't run physics, so it mirrors the brain's ball transforms onto clones.
  let _ghostProto = null,
    _ghosts = [],
    _lastProps = null,
    _ghostLoading = false;
  function throwBall() {
    const h = (modelDims.h || BASE_H) * sizeScale;
    // throw from her upper body, toward the cursor's side of the screen (or a random side)
    const dir = cursor.seen ? Math.sign(toWorld(cursor.x, cursor.y).x - pos.x) || 1 : Math.random() < 0.5 ? -1 : 1;
    physics.throwProp(
      BALL_URL,
      { x: pos.x + dir * h * 0.18, y: pos.y + h * 0.62 },
      { x: dir * (4.2 + Math.random() * 2.2), y: 4 + Math.random() * 1.6 },
      Math.max(0.22, h * 0.11)
    );
    // (she used to emote "happy" here — body expressions purged; an AI driver can author a reaction)
    wake(3);
    setStatus("throw!");
  }
  function dropBall() {
    // a ball falls onto her → bounces off her body capsule (shows she's SOLID)
    const h = (modelDims.h || BASE_H) * sizeScale;
    physics.throwProp(
      BALL_URL,
      { x: pos.x + (Math.random() - 0.5) * h * 0.12, y: pos.y + h * 1.3 },
      { x: (Math.random() - 0.5) * 1.2, y: 0.5 },
      Math.max(0.22, h * 0.11)
    );
    wake(3);
    setStatus("drop!");
  }
  // Pose-broadcast layout (brain serializes its live skeleton → peers mirror it). Both windows load the
  // same model → identical bone/morph order, so the Float32Array buffer is self-describing by length.
  let _poseBones = [],
    _poseMorphs = [],
    poseLen = 0,
    _poseBuf = null,
    _lastPose = null,
    _poseTag = 0; // tag = hash of curKey — length alone can coincide across models (audit hardening)
  let roleBones = {}; // role -> live bone (from the resolved rig) — attach targets resolve here FIRST (structural; trust no names)
  let _rigReport = null; // the cascade's verdict for the CURRENT model ({bySource, unresolved}) — Settings shows it
  let boneHelper = null; // SkeletonHelper overlay — inspect the rig (every bone, named or not)
  const BONES_KEY = "enigmaAvatar.showBones";
  let bonesShown = (() => {
    try {
      return localStorage.getItem(BONES_KEY) === "1";
    } catch {
      return false;
    }
  })();
  // Read a local sibling JSON off the bundle. Plain fetch works because the page is served from
  // app://enigma (registered with supportFetchAPI) — the file:// era, where fetch() rejected the
  // scheme and these reads silently failed on every live launch, ended with the app:// cutover.
  // Resolves null on any failure (missing/unparseable), never rejects.
  const readLocalJson = (url) =>
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  // Resolved BEFORE any rig build (onModelLoaded awaits it): buildProceduralRig captures the table
  // at call time, so a first load that won this read's race used to build with {} — no joint caps
  // and no speed clamp — until the next model switch. Absent/corrupt file still resolves to {}
  // (inert limits, honest degrade — but now LOUDLY), never a blocked load.
  const BONE_LIMITS_READY = readLocalJson("./bone_limits.json").then((j) => {
    if (j) BONE_LIMITS = j;
    else console.warn("[avatar] bone_limits.json unreadable -> no joint/speed caps");
  });
  // Per-model rig overrides REMOVED 2026-06-25 (user: "nothing made specifically for any avatar").
  // The rig resolver (rig.js) is purely generic: VRM -> name -> geometry. No per-model data path.

  let model = null,
    vrm = null;
  let modelDims = { w: 1, h: 2 }; // scaled model bbox (for the hit region)

  // --- float state + GLOBAL position (multi-window monitor rewrite) -----------
  // `pos` is the avatar's base in THIS window's world plane, but it is DERIVED every frame from the one
  // GLOBAL position main owns (virtual-desktop DIP). Every overlay window renders her from the same
  // global position offset by its own display origin → she spans bezels / crosses monitors with no
  // repaint tricks. The PRIMARY display's window is the "brain" (animation + UI + AI bus); the others
  // are "peers" that mirror the brain's broadcast pose and only support grab. See main.js / preload.js.
  const pos = new THREE.Vector2(0, -1.5); // DERIVED world-space base = gToWorld(gPos)
  let _isBrain = false;
  let myOrigin = { x: 0, y: 0 }; // this window's display origin (DIP)
  let myBounds = { width: 1, height: 1 }; // this window's display size (DIP) — matches main's init payload {width,height}
  let gPos = { x: 0, y: 0 }; // avatar global position (DIP) — authoritative cache from main
  let curDisp = { x: 0, y: 0, width: 1, height: 1 }; // the display she's currently on (DIP) — from main
  let gGlide = null; // smooth-move target (DIP); the brain steps gPos toward it
  let gliding = false;
  let gGlideDur = 0, // >0 = timed glide: arrive in exactly this many seconds (smoothstep), else exponential
    gGlideT = 0,
    gGlideFrom = null; // start point of a timed glide
  let _gReady = false; // received the first global-pos broadcast yet?
  let _peerCount = 0; // other windows (gate the pose broadcast — skip on single-monitor)
  let _motionY = 0; // vertical jump/flip hop (LOCAL; never a global move)
  // DIP(global) → this window's world. Mixed-DPI safe: DIP→local CSS px with THIS window's own ratio.
  function gToWorld(gx, gy) {
    const [lx, ly] = dipToLocalPx(gx, gy, myOrigin, myBounds, innerWidth, innerHeight);
    return toWorld(lx, ly);
  }
  // World-Y of the visible desk line (work-area bottom of her CURRENT display, under her x). This is
  // "the ground": the rapier props bounce off it AND the contact shadow rests on it, so both agree on
  // where the floor is. Mixed-DPI safe (uses this window's own ratio via dipToLocalPx).
  function floorWorldY() {
    const wb = curDisp.wb ?? curDisp.y + curDisp.height;
    const [, lypx] = dipToLocalPx(gPos.x, wb, myOrigin, myBounds, innerWidth, innerHeight);
    return toWorld(0, lypx).y;
  }
  function localPxToGlobal(cx, cy) {
    const [x, y] = localPxToDip(cx, cy, myOrigin, myBounds, innerWidth, innerHeight);
    return { x, y };
  }
  // Is she standing on THIS window's display? Captures/thumbnails route to HER window in main —
  // a crop rect computed in a DIFFERENT window's pixel space would cut garbage out of that capture.
  function onMyDisplay() {
    return (
      _gReady && Math.round(curDisp.x) === Math.round(myOrigin.x) && Math.round(curDisp.y) === Math.round(myOrigin.y)
    );
  }
  function _clampToDisp(p) {
    // glide/nudge stay on her current screen (only a DRAG crosses bezels).
    // WALLS v2 (user 2026-06-12: the body-scaled walls MOVED when she was resized — wrong): FIXED
    // slim margins, independent of her size. The BOTTOM is PERMEABLE — she can be sent to / through the
    // screen bottom (recover via tray / goTo); the screen-bottom floor SNAP was removed 2026-06-25, so
    // she no longer auto-rests on the desk line. The clamp only stops her from being lost entirely.
    const d = curDisp,
      m = 16;
    return {
      x: Math.max(d.x + m, Math.min(d.x + d.width - m, p.x)),
      y: Math.max(d.y + m, Math.min(d.y + d.height * 1.4, p.y)),
    };
  }
  // --- AI-PLACEABLE PLATFORMS (user design 2026-06-12; screen-bottom floor snap removed 2026-06-25) -
  // Platforms are AI-placed effect surfaces: visible translucent bars on every window, rapier static
  // slabs in the brain (balls roll on them), and snap targets for her feet. Released or glided near a
  // PLATFORM top, her feet ease onto it — but nothing hard-blocks pushing her past it. The screen
  // bottom is NO LONGER a snap line (only platforms are); she rests wherever you drop her.
  let platforms = []; // [{gx, gy, w}] in global DIP (surface line at gy, span w centred on gx)
  let _pfGroup = null;
  function renderPlatforms() {
    if (_pfGroup) {
      scene.remove(_pfGroup);
      _pfGroup.traverse((o) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
      _pfGroup = null;
    }
    if (!platforms.length) {
      wake(0.5);
      return;
    }
    _pfGroup = new THREE.Group();
    for (const pf of platforms) {
      const [lx, ly] = dipToLocalPx(pf.gx, pf.gy, myOrigin, myBounds, innerWidth, innerHeight);
      const p1 = toWorld(lx - pf.w / 2, ly),
        p2 = toWorld(lx + pf.w / 2, ly);
      const bar = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.max(0.05, Math.abs(p2.x - p1.x)), 0.05),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthTest: false })
      );
      bar.position.set((p1.x + p2.x) / 2, p1.y, -1.5);
      bar.renderOrder = 5;
      bar.frustumCulled = false;
      _pfGroup.add(bar);
    }
    scene.add(_pfGroup);
    wake(1);
  }
  function syncPlatformPhysics() {
    // brain only: mirror the bars as rapier static slabs (balls roll on them)
    if (!_isBrain || !physics.setPlatforms) return;
    physics.setPlatforms(
      platforms.map((pf) => {
        const [lx, ly] = dipToLocalPx(pf.gx, pf.gy, myOrigin, myBounds, innerWidth, innerHeight);
        const p1 = toWorld(lx - pf.w / 2, ly),
          p2 = toWorld(lx + pf.w / 2, ly);
        return { x: (p1.x + p2.x) / 2, y: p1.y, halfW: Math.max(0.03, Math.abs(p2.x - p1.x) / 2) };
      })
    );
  }
  function setPlatforms(list) {
    platforms = sanitizePlatforms(list);
    renderPlatforms();
    syncPlatformPhysics();
    setStatus(platforms.length ? `platforms: ${platforms.length}` : "platforms cleared");
    return platforms.length;
  }
  function surfaceYAt(gx, gy) {
    // nearest AI-placed PLATFORM top under gx, within the snap band (math in placement.js, unit-tested).
    // SCREEN-BOTTOM FLOOR SNAP REMOVED (user request 2026-06-25) — only AI-placed platforms are snap
    // targets now. With no platform under her this returns null and floorSnap() is a no-op.
    return nearestPlatformSurfaceY(gx, gy, platforms, curDisp.height * 0.05);
  }
  function floorSnap() {
    // drag-release / glide-arrival: feet ease onto a nearby PLATFORM top (screen-bottom floor snap removed 2026-06-25)
    if (!_isBrain || held || _dragActive || gliding) return;
    const s = surfaceYAt(gPos.x, gPos.y);
    if (s != null && Math.abs(s - gPos.y) > 0.5) setGlide(gPos.x, s);
  }
  function setGlide(gx, gy, dur) {
    // Returns the ACCEPTED target + whether the display clamp changed it, so a driver learns the
    // truth in the reply instead of discovering a silent clamp screenshots later (2026-07-03 audit:
    // the py clamp swallowed a head-anchored resize compensation and the head left the screen).
    if (!isFinite(gx) || !isFinite(gy)) return null;
    gGlide = _clampToDisp({ x: gx, y: gy });
    const clamped = Math.abs(gGlide.x - gx) > 0.5 || Math.abs(gGlide.y - gy) > 0.5;
    gGlideDur = +dur > 0 ? Math.min(+dur, 30) : 0;
    if (gGlideDur > 0) {
      gGlideT = 0;
      gGlideFrom = { x: gPos.x, y: gPos.y };
    } else gGlideFrom = null;
    gliding = true;
    return { x: gGlide.x, y: gGlide.y, clamped };
  }
  // --- AI movement: where is she + named anchors, resolved against her CURRENT display ---------
  function posScreen() {
    return [Math.round(gPos.x - curDisp.x), Math.round(gPos.y - curDisp.y)];
  } // px within her current monitor
  function anchorGlobal(a) {
    // 12% edge margin; anchors sit a bit low (feet on the deck) — math in placement.js (unit-tested)
    return resolveAnchor(a, curDisp, localPxToGlobal(cursor.x, cursor.y));
  }
  function glideTo(px, py, dur) {
    // px,py = px within her current display; dur (s) = timed glide (paces walks + lets a frame-blind
    // driver watch the motion). Returns the accepted-target truth {px,py,clamped}.
    const r = setGlide(curDisp.x + px, curDisp.y + py, dur);
    return r ? { px: Math.round(r.x - curDisp.x), py: Math.round(r.y - curDisp.y), clamped: r.clamped } : null;
  }
  function goTo(target, dur) {
    // a named anchor (string) OR {px,py within current display}
    let g;
    if (typeof target === "string") {
      g = anchorGlobal(target);
      if (!g) return null;
    } else if (target && target.px != null) {
      g = [curDisp.x + +target.px, curDisp.y + +target.py];
    } else return null;
    const r = setGlide(g[0], g[1], dur);
    wake(1.2);
    setStatus("-> " + (typeof target === "string" ? target : Math.round(target.px) + "," + Math.round(target.py)));
    return r ? { px: Math.round(r.x - curDisp.x), py: Math.round(r.y - curDisp.y), clamped: r.clamped } : null;
  }
  function whereAmI() {
    return {
      screen: [curDisp.width, curDisp.height],
      screenPos: posScreen(),
      cursor: [cursor.x | 0, cursor.y | 0],
      pos: [Math.round(gPos.x), Math.round(gPos.y)],
      size: +sizeScale.toFixed(2),
      gliding,
    };
  }
  // Root-motion (jump / flip / lay-down / get-up) was purged 2026-06-25; _motionY (the live vertical hop,
  // still carried in the pose buffer) stays 0. _cancelMotion just zeroes it so a model switch / manual
  // rotate can never strand her mid-air from a streamed-in value.
  function _cancelMotion() {
    _motionY = 0;
  }
  function nudge(dxFrac, dyFrac) {
    // move by a fraction of her CURRENT screen (x right+, y up+)
    setGlide(gPos.x + (dxFrac || 0) * curDisp.width, gPos.y - (dyFrac || 0) * curDisp.height); // y up+ → DIP y decreases
  }
  let held = false;
  const cursor = { x: -1, y: -1, over: false, seen: false }; // seen: a real cursor position arrived (local OR relayed from a peer display — relayed coords can be legitimately negative)
  const DEFAULT_SIZE = 0.5; // first-run size (a sensible default); after that it remembers the last-used size
  const SIZE_KEY = "enigmaAvatar.sizes";
  const LAST_MODEL_KEY = "enigmaAvatar.lastModel"; // last real model loaded → reopen it next launch (not an arbitrary alphabetical one)
  const sizeByModel = (() => {
    try {
      return JSON.parse(localStorage.getItem(SIZE_KEY)) || {};
    } catch {
      return {};
    }
  })(); // per-model size, persisted across launches
  let curKey = FORCED_MODEL || DEFAULT_KEY; // real model resolved in startup() (first in the library, else procedural)
  let sizeScale = sizeByModel[curKey] ?? DEFAULT_SIZE; // reopen at the last-used size for this model
  let springOn = true,
    facialOn = true,
    locked = false; // engine toggles (Settings checkboxes; the idle toggle died with the idle machinery, 2026-06-12 — proc.update is purely reactive/commanded now and always runs)
  // AI-control kill-switch (brain-only, persisted). When OFF, inbound AI bus commands are DROPPED at
  // the connect() chokepoint before they can do anything — so nothing the avatar does over the bus can
  // be a surprise. Flip it back on (Settings checkbox or the tray's "Accept AI control") and the
  // still-open bus connection resumes instantly. Default ON to preserve the say.py / Odysseus workflow.
  // MIRROR of main's kill-switch authority (main persists it in window-state.json and pushes every
  // change; the initial value rides avatar:init). The no-IPC context (plain browser / tests) keeps
  // the local default ON and toggles locally — nothing to persist there.
  let aiControlOn = true;
  // Flash the (normally hidden) status line on each ACCEPTED bus command so an AI-driven move is never
  // mistaken for a glitch; restore the panel's prior visibility after a beat. setAiControl persists the
  // toggle and mirrors it to the tray checkbox. Both are wired into the control surface / UI below.
  let _aiFlashTimer = null,
    _aiFlashWasHidden = false;
  function flashAiActivity(action) {
    if (action === "query" || action === "capabilities") return; // read-only introspection isn't a visible action — don't flash on the brain's verify-by-numbers chatter
    setStatus("AI: " + (action || "command"));
    const el = document.getElementById("ui");
    if (!el) return;
    if (_aiFlashTimer) clearTimeout(_aiFlashTimer);
    else _aiFlashWasHidden = el.classList.contains("hidden");
    el.classList.remove("hidden");
    _aiFlashTimer = setTimeout(() => {
      _aiFlashTimer = null;
      if (_aiFlashWasHidden) el.classList.add("hidden");
    }, 1500);
  }
  function applyAiControl(on) {
    // the pushed truth from main lands here (and the local no-IPC toggle)
    aiControlOn = !!on;
    setStatus(aiControlOn ? "AI control ON" : "AI control PAUSED (bus commands ignored)");
  }
  function setAiControl(on) {
    if (window.avatarIPC?.setAiControl) {
      window.avatarIPC.setAiControl(!!on); // main is the AUTHORITY — it persists and pushes the change back to every window's mirror
      return;
    }
    applyAiControl(on); // no-IPC (plain browser / tests): local-only
  }
  // Accessor bridge so ui.js (Settings checkboxes) can read/write these toggles. Their
  // source of truth stays here — the animate loop reads the raw `let`s directly.
  const flags = {
    get springOn() {
      return springOn;
    },
    set springOn(v) {
      springOn = v;
    },
    get facialOn() {
      return facialOn;
    },
    set facialOn(v) {
      facialOn = v;
    },
    get locked() {
      return locked;
    },
    set locked(v) {
      locked = v;
    },
  };

  // --- SIZE POLICY (one place) ------------------------------------------------
  // There is ONE size value (sizeScale), persisted per model. Three entry points
  // touch it, and they intentionally do NOT clamp the same way (they don't conflict —
  // each serves a different purpose):
  //   • applySize / resizeBy / scroll / +,− keys / bus → free, with only a 0.02
  //     FLOOR. No upper cap, by design: the user or the AI can make it as big as wanted.
  //   • Settings slider (ui.js) → 0.05–5 is just that control's convenience range,
  //     NOT a global limit (scroll / keys / bus can still exceed it).
  //   • fitToScreen → the ONLY automatic adjustment: shrink-only, on load/recenter,
  //     so a too-large SAVED size can't strand the avatar clipped off a smaller monitor.
  // Net: manual sizing is unbounded-up / floored-down; auto-fit only ever shrinks.
  function applySize(s, anchor) {
    const n = +s;
    if (!isFinite(n)) return null; // bus is stringly-typed — `size "big"` must not set rig.scale = NaN (invisible model, unrecoverable hit-test)
    const prev = sizeScale;
    sizeScale = Math.max(0.02, n || 0.02); // no upper cap (removed min/max); tiny floor so multiplicative resize can recover
    rig.scale.setScalar(sizeScale);
    // GROW-ANCHOR (user 2026-07-02): default scales from the FEET (gPos IS the feet point, so she
    // stays planted on the floor). anchor "hips"|"head" pins THAT body point on screen instead —
    // the fourth-wall "walk up to the screen" loom keeps her face in frame while she grows past it.
    let anchorClamped = false; // truth for the reply: did the display clamp swallow the compensation?
    if ((anchor === "hips" || anchor === "head") && isFinite(worldH) && innerHeight > 0) {
      const frac = anchor === "head" ? 0.92 : 0.5; // the pinned point's height as a fraction of her height
      const dW = (modelDims.h || BASE_H) * (sizeScale - prev) * frac; // how far that point rose, world units
      const r = setGlide(gPos.x, gPos.y + (dW * innerHeight) / worldH); // drop the feet to compensate (display-clamped, published)
      anchorClamped = !!(r && r.clamped); // clamped = the pinned point will NOT hold (it drifts off-screen)
    }
    sizeByModel[curKey] = sizeScale;
    if (!window.avatarIPC || _isBrain)
      try {
        localStorage.setItem(SIZE_KEY, JSON.stringify(sizeByModel));
      } catch {} // ONE writer — a peer's fitToScreen must not clobber the shared size store with its module-load-stale copy
    setStatus(`size x${sizeScale.toFixed(2)}`);
    return {
      size: +sizeScale.toFixed(3),
      anchor: anchor === "hips" || anchor === "head" ? anchor : "feet",
      anchorClamped,
    };
  }
  const resizeBy = (m) => applySize(sizeScale * m, "hips"); // scroll/+,- grow from her MIDDLE (user 2026-07-05: "larger from the bottom" felt wrong); the bus `size` verb keeps its documented feet default
  // Keep the avatar fitting the screen: a too-large saved size makes the head/feet clip
  // off the top/bottom — and on a SMALLER monitor that reads as "can't see the avatar".
  // Shrinks an over-tall avatar to a margin-safe height; never enlarges (respects smaller sizes).
  function fitToScreen() {
    const h = (modelDims.h || BASE_H) * sizeScale; // current world-space height
    const maxH = worldH * 0.6; // leave head + feet margin (head clears camTop at pos.y -1.5)
    if (h > maxH && isFinite(maxH) && h > 0) applySize(sizeScale * (maxH / h));
  }

  function disposeModel() {
    if (!model) return;
    voice.stop(); // stop any in-flight speech/lip-sync before tearing down the model
    if (soft) {
      soft.restoreAll(); // geometry back to pristine before dispose (grabs must never outlive the model)
      soft = null;
    }
    if (boneHelper) {
      scene.remove(boneHelper);
      boneHelper.geometry?.dispose?.();
      boneHelper.material?.dispose?.();
      boneHelper = null;
    }
    rig.remove(model);
    if (vrm) VRMUtils.deepDispose?.(vrm.scene);
    disposeMeshTree(model); // geometry + materials + TEXTURES (material.dispose alone leaked the texture set every swap)
    _boneMarks.clear(); // the checkbox markers rode this model's bones — just disposed by the traverse above
    model = null;
    vrm = null;
    proc = null;
    spring = null;
    _meshList = null;
  }

  // #13: the NO-MODEL state. We do NOT run the model pipeline (resolve / compositor / spring / facial)
  // on the inert marker — there's no body to drive. Tear down any real model, drop all per-model
  // engine state to a clean "nothing loaded" baseline, and let showOnboarding() raise the DOM message.
  // curKey stays DEFAULT_KEY so gallery / removeModel / peer-mirror paths that reference __default__
  // resolve here instead of a self-made character.
  function enterNoModel() {
    disposeModel();
    curKey = DEFAULT_KEY;
    modelDims = { w: 1, h: 2 };
    roleBones = {};
    resetMorphGeo();
    _weightMass = null;
    _springNeverExtra = [];
    _poseBones = [];
    _poseMorphs = [];
    poseLen = 0;
    _poseBuf = null;
    _lastPose = null;
    facial = null;
    proc = null;
    spring = null;
    vrm = null;
    hitMask = null;
    updateBoneHelper(); // tear down any skeleton overlay from the previous model
    updateShadow(); // no model -> no shadow (updateShadow gates on `model`)
    wake(1);
    if (_isBrain) window.avatarIPC?.modelLoaded?.(DEFAULT_KEY); // peers mirror the no-model state (onModel -> applyPeerModel)
  }

  function onModelLoaded(asset) {
    // EVERY load path funnels here (loadModel, drag-drop loadFile/loadFiles, startup tryLoad) — so
    // THIS is where the build awaits the joint-limit table; gating only loadModel left startup and
    // drag-drop building uncapped rigs when they won the read's race. Queued builds run in call
    // order (same resolved promise -> FIFO microtasks) and each starts with disposeModel(), so
    // last-caller-wins is preserved.
    BONE_LIMITS_READY.then(() => _buildModelGuarded(asset));
  }
  function _buildModelGuarded(asset) {
    // BOUNDARY GUARD: the rig/facial build below can throw on a corrupt/degenerate model (resolveRig,
    // buildProceduralRig, buildFacial, the bind-normalization math). Inside the loader's async onLoad a
    // throw escapes PAST onErr as an unhandled rejection, leaving a HALF-STATE: old model already
    // disposed, no new one, no honest message. Catch it here -> the canonical no-model state + a reason.
    try {
      _buildLoadedModel(asset);
      _signalLoaded({
        loaded: curKey,
        facial: facial?.mode || "none",
        blink: facial?.blinkMode || "none",
        size: +sizeScale.toFixed(2),
      }); // the bus 'load' reply: the model is BUILT (rig+facial+springs live), not merely requested
    } catch (e) {
      console.error("[avatar] model build failed -> honest no-model fallback:", e);
      try {
        window.avatarIPC?.log?.(`[avatar] model build failed: ${(e && e.message) || e}`);
      } catch {}
      enterNoModel();
      setStatus(`load failed: ${(e && e.message) || "rig build error"}`);
      _signalLoaded({ error: String((e && e.message) || "rig build error"), url: curKey }); // carry WHICH load failed — the keyed waiter must not adopt another load's failure
    }
  }
  function _buildLoadedModel(asset) {
    disposeModel();
    if (!asset.scene) throw new Error("asset has no scene"); // THROW into the boundary guard — a bare return fell through to the SUCCESS reply with a blank screen (audit 2026-07-04)
    model = asset.scene;
    vrm = asset.vrm || null;
    // #1: STOP vrm.update() from copying the rest-pose normalized humanoid bones back over the AI
    // pose every frame. With autoUpdateHumanBones on, the procedural compositor writes a head/arm pose
    // and vrm.update() (run later in the frame) immediately overwrites it with the rig's rest rotation
    // — the AI motion never reaches the screen on VRM models. We drive the raw bones ourselves; VRM's
    // own update stays only for its spring bones / look-at / expressions.
    if (vrm?.humanoid) vrm.humanoid.autoUpdateHumanBones = false;
    // NORMALIZE ON THE BODY, NOT THE PACKAGING (model-zoo 2026-07-02): some GLBs ship display
    // furniture — aveline's shelf + floating logo made the whole-scene box huge, so the BASE_H
    // scale shrank the actual robot to a speck standing on her own plinth. When the file contains
    // skinned meshes, their union IS the character; static extras become background. Files with no
    // skinned mesh at all (statues, props, furniture) keep the whole-scene box, unchanged.
    // Measure SKINNED bounds, not raw bind-geometry boxes (ryuri 2026-07-04): exports whose
    // inverse-bind matrices carry the geometry→skeleton mapping author vertices in a DIFFERENT
    // space than the nodes (her mane/tail bind verts reached y=-5062 while the skeleton spans
    // 2.28) — the raw box normalized her to a 0.42-unit crumple. What renders is what we measure.
    const _oneB = new THREE.Box3();
    const bodyBox = () => {
      model.updateWorldMatrix(true, true);
      _box.makeEmpty();
      model.traverse((o) => {
        if (o.isSkinnedMesh && o.geometry) {
          o.computeBoundingBox(); // skinned-vertex bounds in mesh-local space (bone pose applied)
          _oneB.copy(o.boundingBox).applyMatrix4(o.matrixWorld);
          _box.union(_oneB);
        }
      });
      if (!isFinite(_box.min.y) || !(_box.max.y - _box.min.y > 0.001)) _box.setFromObject(model);
      return _box;
    };
    bodyBox();
    const w0 = _box.max.x - _box.min.x,
      h0 = _box.max.y - _box.min.y;
    let s = BASE_H / (h0 || 1);
    if (w0 * s > worldW * 0.85) s = (worldW * 0.85) / w0; // cap width so wide models (GLaDOS) fit
    model.scale.setScalar(s);
    bodyBox();
    const c = _box.getCenter(new THREE.Vector3());
    model.position.x -= c.x;
    model.position.z -= c.z;
    model.position.y -= _box.min.y; // feet at rig origin
    model.traverse((o) => {
      if (o.isMesh) o.frustumCulled = false;
    });
    rig.add(model);
    _meshList = [];
    model.traverse((o) => {
      if (o.isMesh) _meshList.push({ mesh: o, name: o.name || null });
    }); // INDEX AUTHORITY: pristine file order, captured before any surgery/adoption can reshuffle traversal
    modelDims = { w: _box.max.x - _box.min.x, h: _box.max.y - _box.min.y };
    // pose-broadcast layout (brain serializes → peers mirror): ordered bones + morph meshes. Both windows
    // load the SAME model → identical traversal order, so the flat buffer is self-describing by length.
    _poseBones = [];
    _poseMorphs = [];
    model.traverse((o) => {
      if (o.isBone) _poseBones.push(o);
    });
    model.traverse((o) => {
      if (o.isMesh && o.morphTargetInfluences && o.morphTargetInfluences.length) _poseMorphs.push(o);
    });
    poseLen = 7 + 4 * _poseBones.length + _poseMorphs.reduce((n, m) => n + m.morphTargetInfluences.length, 0);
    {
      let h = 0;
      const s = String(curKey);
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      _poseTag = (h >>> 8) / 8388608;
    } // same url → same tag in every window; float32-exact
    _poseBuf = new Float32Array(poseLen);
    _lastPose = null;
    sizeScale = sizeByModel[curKey] ?? DEFAULT_SIZE; // remember size per model (persisted)
    rig.scale.setScalar(sizeScale);
    fitToScreen(); // correct a too-large saved size so she isn't clipped off-screen

    // (Embedded-clip playback removed 2026-06-25 — the AI drives every model purely through the
    //  procedural compositor; baked clips in a .glb are ignored. No clip-mixer state remains.)
    // The procedural rig drives look-at + AI bone control the SAME way on all models (no idle,
    // no canned clips — purged). This is the uniform substrate the AI composes motion on top of.
    // Identify bones ONCE via the generic cascade (VRM -> name -> geometry), then feed BOTH the
    // procedural pose and the spring physics the same resolved map.
    // (Rigify parallel-skeleton "reparent" surgery was REMOVED 2026-06-25 with the per-model override
    // system — it only ever ran for hand-written rig_overrides entries, which no longer exist.)
    const resolved = resolveRig(model, vrm);
    roleBones = resolved.roles || {}; // expose role→bone for attach-by-role (structural; trust no names)
    resetMorphGeo(); // new model, new head anchor -> re-classify morphs lazily on next query
    // SKIN-WEIGHT AUTO-ADOPTION (2026-06-12, the system pass): generalize the parallel-limb surgery.
    // Any DEFORMING bone that is a coincident twin of a resolved role bone but lives OUTSIDE its
    // subtree (a Rigify DEF chain rooted on the spine/shoulder, follow-constraints baked away) gets
    // attached under it — world-preserving — so the visual limb rides the driven chain on ANY such
    // export, with no hand-written override map. Idempotent: twins a map already moved are inside
    // the subtree and skipped.
    _weightMass = null;
    _springNeverExtra = [];
    let _skelH = 0; // the SKELETON's own world span — coincidence tolerances live in bone space,
    // and mesh dims lie on mismatched-space exports (ryuri: mesh box 5255 vs skeleton 2.28 —
    // a mesh-based tolerance half the skeleton tall cross-adopted 116 bones and crumpled her)
    try {
      _weightMass = computeWeightMass(model);
      if (_weightMass.size) {
        {
          const v = new THREE.Vector3();
          let lo = Infinity,
            hi = -Infinity;
          for (const [b, m] of _weightMass) {
            if (m > 0.5) {
              b.getWorldPosition(v);
              if (v.y < lo) lo = v.y;
              if (v.y > hi) hi = v.y;
            }
          }
          if (hi > lo) _skelH = hi - lo;
        }
        const twins = findRoleTwins(roleBones, _weightMass, _skelH || modelDims.h || 2);
        let n = 0;
        for (const { bone, twin } of twins) {
          let cyc = false;
          for (let p = bone; p; p = p.parent)
            if (p === twin) {
              cyc = true;
              break;
            }
          if (cyc) continue;
          bone.attach(twin);
          n++;
        }
        if (n) {
          model.updateWorldMatrix(true, true);
          const m = `[avatar] skin-weight pass: auto-adopted ${n} stranded deforming twin bone(s) under their role bones`;
          console.log(m);
          try {
            window.avatarIPC?.log?.(m);
          } catch {}
        }
      }
    } catch (e) {
      console.warn("[avatar] skin-weight pass failed (continuing without):", e);
    }
    applyRotation(); // THIS model's saved rotation BEFORE the axis derivation — the rig may still carry the PREVIOUS model's live tilt (e.g. switched while lying), and the toe-forward probe in buildProceduralRig is world-absolute
    proc = buildProceduralRig(model, BONE_LIMITS, resolved);
    _rigReport = resolved.report; // kept for the Settings verdict line (what the cascade decided, at a glance)
    console.log(
      "[avatar] roles:",
      resolved.matched.length,
      JSON.stringify(resolved.report.bySource),
      resolved.matched.length ? "→ " + resolved.matched.join(", ") : "(none)"
    );
    setStatus(
      `loaded ✓ ${resolved.matched.length ? resolved.matched.length + " bones driven" : "static (no recognised body bones)"}`
    );
    // VRM ships its own spring bones (vrm.update drives them) — don't double up.
    if (vrm) {
      spring = null;
    } else {
      // Pass the role-matched bones as `exclude` so a humanoid's limbs are never sprung
      // (only true dangly bits).
      spring = buildSpringBones(model, {
        exclude: resolved.springExclude,
        regionWeight: profileFor(curKey).regions || {},
      }); // per-region jiggle weights restored from profile
      // SPRING TWIN DEDUP (skin-weight pass): Rigify exports spring the SAME tail/ear as 2–3
      // parallel chains (ORG + control + DEF) → desynced physics fights blending on one mesh
      // (mushy tail). Keep the chain the mesh actually listens to (highest subtree weight mass),
      // attach the twins under it so they RIDE it, and rebuild the springs with them excluded.
      if (spring?.count && _weightMass && _weightMass.size) {
        try {
          const sprungSet0 = new Set(spring.names),
            roots = [];
          model.traverse((o) => {
            if (o.isBone && sprungSet0.has(o.name) && !(o.parent && sprungSet0.has(o.parent.name))) roots.push(o);
          });
          const groups = groupCoincidentRoots(roots, _skelH || modelDims.h || 2);
          if (groups.length) {
            const never = [];
            for (const g of groups) {
              g.sort((a, b) => subtreeMass(b, _weightMass) - subtreeMass(a, _weightMass)); // winner = the deforming chain
              const win = g[0];
              for (const lose of g.slice(1)) {
                let cyc = false;
                for (let p = win; p; p = p.parent)
                  if (p === lose) {
                    cyc = true;
                    break;
                  }
                if (cyc) continue;
                win.attach(lose);
                lose.traverse((o) => {
                  if (o.isBone) never.push(o.name);
                });
              }
            }
            if (never.length) {
              model.updateWorldMatrix(true, true);
              _springNeverExtra = never;
              spring = buildSpringBones(model, {
                exclude: resolved.springExclude,
                regionWeight: profileFor(curKey).regions || {},
                neverExtra: _springNeverExtra,
              });
              const m = `[avatar] spring twin dedup: ${groups.length} coincident chain group(s) — twins now ride the deforming chain (${never.length} bone(s) un-sprung)`;
              console.log(m);
              try {
                window.avatarIPC?.log?.(m);
              } catch {}
            }
          }
        } catch (e) {
          console.warn("[avatar] spring twin dedup failed (continuing without):", e);
        }
      }
      // BIND-NORMALIZATION × DANGLY CHAINS: standing a squat-bound rig up rotates the head/trunk.
      // Rigid accessories (ears, hats) must FOLLOW that rotation — but hair/tail are authored
      // relative to GRAVITY, so their world hang must be PRESERVED ("hair to attach to her head",
      // 2026-06-11: her strands plumed forward off the freshly-leveled head). Counter-rotate each
      // sprung chain ROOT by the net normalization its ancestors received, then rebuild the
      // springs so rests + verlet tips re-capture from the corrected pose.
      if (spring?.count && proc?.restAdjust && Object.keys(proc.restAdjust).length) {
        const sprungSet = new Set(spring.names);
        const _net = new THREE.Quaternion(),
          _pq = new THREE.Quaternion();
        let fixed = 0;
        model.traverse((o) => {
          if (!o.isBone || !sprungSet.has(o.name) || (o.parent && sprungSet.has(o.parent.name))) return; // chain ROOTS only
          _net.identity();
          let any = false;
          for (let p = o.parent; p; p = p.parent) {
            // nearest→farthest with right-multiply = farthest ancestor's rotation applied first
            const a = proc.restAdjust[p.name];
            if (a) {
              _net.multiply(a);
              any = true;
            }
          }
          if (!any) return;
          o.parent.getWorldQuaternion(_pq);
          const adj = _pq.clone().invert().multiply(_net.clone().invert()).multiply(_pq);
          o.quaternion.copy(adj.multiply(o.quaternion.clone()));
          fixed++;
        });
        if (fixed) {
          model.updateWorldMatrix(true, true);
          spring = buildSpringBones(model, {
            exclude: resolved.springExclude,
            regionWeight: profileFor(curKey).regions || {},
            neverExtra: _springNeverExtra,
          }); // keep the twin-dedup exclusions through the rebuild
          console.log(`[avatar] gravity-preserved ${fixed} dangly chain root(s) against the bind normalization`);
        }
      }
      if (spring && profileFor(curKey).spring) spring.setParams(profileFor(curKey).spring); // per-avatar tuned physics (global hair feel)
      if (profileFor(curKey).objects) physics.tune(profileFor(curKey).objects); // per-avatar object-toy feel (ball gravity/bounce)
      if (spring?.count) console.log("[avatar] spring bones (" + spring.count + "):", spring.names.join(", "));
    }
    // RE-ANCHOR + RE-MEASURE — deliberately AFTER the gravity counter-rotation above: this measures
    // the FINAL standing pose. Measuring before it caught the pre-fix hair plume (head-leveling
    // rotations amplified down 16-bone strands) as a 12.8-unit "height" on a 3.5-unit model — the
    // poison behind the floating mesh, the giant shadow and the crushed auto-size ("the walls were
    // pushing the avatar up when i made it larger"; battery 2026-06-12). The bind box measured at
    // load had the squat-bound feet line wrong instead (shadow at her shins) — this fixes both.
    {
      applyMeshVisibility(); // hide saved-off parts FIRST — parked variant meshes must not inflate the measurement
      const rq = rig.quaternion.clone();
      rig.quaternion.identity();
      rig.updateWorldMatrix(true, true);
      _box.makeEmpty(); // VISIBLE meshes only + SKINNING-AWARE (the geometry box lies on skin-assembled models)
      expandVisiblePosed(_box);
      // SANITY GATE backstop: the model was normalized to BASE_H at load — a box wildly past that is
      // a poisoned measurement; keep the bind dims, move nothing, and say so loudly.
      const s = rig.scale.x || 1;
      const bw = (_box.max.x - _box.min.x) / s,
        bh2 = (_box.max.y - _box.min.y) / s;
      let shifted = false;
      if (
        isFinite(_box.min.y) &&
        _box.max.y > _box.min.y &&
        bw > 0.01 &&
        bh2 > 0.01 &&
        bw < BASE_H * 2.5 &&
        bh2 < BASE_H * 2.5
      ) {
        const c = _box.getCenter(new THREE.Vector3());
        model.position.x -= (c.x - rig.position.x) / s;
        model.position.z -= c.z / s;
        model.position.y -= (_box.min.y - rig.position.y) / s; // feet back on the rig origin = the shadow/footprint/floor line
        modelDims = { w: bw, h: bh2 };
        shifted = true;
      } else if (isFinite(_box.min.y)) {
        const m = `[avatar] POISONED bounds measure on ${curKey}: ${bw.toFixed(1)}x${bh2.toFixed(1)} (normalized models are ~${BASE_H}) — keeping bind dims ${modelDims.w.toFixed(1)}x${modelDims.h.toFixed(1)}, anchor untouched`;
        console.warn(m);
        try {
          window.avatarIPC?.log?.(m);
        } catch {}
      }
      rig.quaternion.copy(rq);
      rig.updateWorldMatrix(true, true);
      if (shifted && spring?.count)
        spring = buildSpringBones(model, {
          exclude: resolved.springExclude,
          regionWeight: profileFor(curKey).regions || {},
          neverExtra: _springNeverExtra,
        }); // verlet tips re-capture from the shifted rest — no load-time settle wiggle
      if (shifted && spring && profileFor(curKey).spring) spring.setParams(profileFor(curKey).spring);
      fitToScreen(); // the TRUE height can exceed the bind height (catgirl: squat → standing) — re-cap so she still fits her screen
    }
    {
      // facial v2: per-channel ladders (mouth + blink independent); the geometric tiers need the
      // resolved HEAD + the body frame to anchor their eye/mouth bands on any rig.
      soft = buildSoftMesh(model); // soft-mesh grab/poke layer (bind-space vertex regions; rides skinning)
      const _fa = proc?.jointAngles ? proc.jointAngles().fwd : null;
      const _fwd = _fa ? new THREE.Vector3(_fa[0], _fa[1], _fa[2]) : new THREE.Vector3(0, 0, 1);
      // ONE morph classification, HERE at load: rest pose + the rig's real facing (audit
      // 2026-07-04: the lazy query-path re-scan classified whatever pose she happened to be
      // HOLDING and cached that for the session, in a head-only frame that could disagree with
      // the facial build's — and the second-scale scan ran twice per model).
      _morphGeo = null;
      if (roleBones.head && morphMeshes().n) {
        try {
          _morphGeo = analyzeMorphGeometry(model, {
            head: roleBones.head,
            bodyUp: new THREE.Vector3(0, 1, 0),
            forward: _fwd,
          });
        } catch (e) {
          console.warn("[avatar] morph classification failed:", e);
        }
      }
      facial = buildFacial(model, vrm, {
        headBone: roleBones.head || null,
        bodyUp: new THREE.Vector3(0, 1, 0), // rig-up post-normalization
        forward: _fwd,
        geo: _morphGeo, // share the load-time analysis — facial's lazy fallback only runs if this is null
      });
    }
    if (facial && profileFor(curKey).facial) facial.setParams(profileFor(curKey).facial); // per-avatar jaw/face tuning
    console.log(
      "[avatar] mouth:",
      facial.mode === "none"
        ? "NONE — this model has no mouth channel (speech without lip-sync)"
        : `${facial.mode} — ${facial.info}`
    ); // acknowledge the mouth channel (or its absence) AS SUCH — never fake one
    reapplyAttachments(); // re-attach saved props/accessories for this model
    captureOriginalColors(); // snapshot loaded colors FIRST (so "Reset colors" can restore them)
    applyColors(); // re-apply saved per-material color tints
    applyHue(); // re-apply saved per-material hue shifts
    applyMeshVisibility(); // re-hide any meshes turned off (clothing variants etc.)
    applyMorphs(); // re-apply saved morph/blendshape values (the avatar's own toggles)
    applyRotation(); // restore the saved rotation (all 3 axes)
    proc?.bindExtras?.({ sprungNames: spring ? spring.names : [] }); // the finger-grip layer must not double-drive a sprung hand ribbon (the spring writes those every frame after proc)
    // (The per-model idle profile application lived here — the WHOLE idle system is deleted,
    // user order 2026-06-12: "delete the idle animation everywhere and anything that has to
    // do with it". Reactive channels — cursor-look, blink, springs, gestures, grip — stay.)
    // flush relayed mutations that were queued while THIS window's copy lagged the model switch
    if (_staleCmds.length) {
      const q = _staleCmds.filter((x) => x.key === curKey);
      _staleCmds = _staleCmds.filter((x) => x.key !== curKey);
      for (const cmd of q) _runUiCmd(cmd);
    }
    hitMask = null;
    computeFootprint(); // prime the grab silhouette immediately (no fallback flash)
    updateBoneHelper(); // (re)build the skeleton overlay if it's toggled on
    scheduleThumb(); // refresh this model's gallery thumbnail once it settles
    wake(2); // hold full rate briefly so the new model settles (springs/pose) smoothly
    try {
      if (/\/models\//.test(curKey)) localStorage.setItem(LAST_MODEL_KEY, curKey);
    } catch {} // remember this model → reopen it next launch
    // Tell main → peers mirror it. Transient blob loads (bare filename) stay LOCAL — a peer can't
    // resolve another window's blob URL; it keeps the previous model instead of bricking on a phantom.
    if (_isBrain && (curKey === DEFAULT_KEY || /\/models\//.test(curKey))) window.avatarIPC?.modelLoaded?.(curKey);
  }
  // --- skeleton overlay (inspect the rig: see EVERY bone, role-matched or not) ----
  function updateBoneHelper() {
    if (boneHelper) {
      scene.remove(boneHelper);
      boneHelper.geometry?.dispose?.();
      boneHelper.material?.dispose?.();
      boneHelper = null;
    }
    if (!bonesShown || !model) return;
    const h = new THREE.SkeletonHelper(model);
    if (!h.bones || !h.bones.length) {
      h.dispose?.();
      return;
    } // static mesh — no bones to draw
    h.material.depthTest = false;
    h.material.transparent = true;
    h.material.opacity = 0.92; // draw OVER the mesh
    h.renderOrder = 999;
    boneHelper = h;
    scene.add(h);
    console.log("[avatar] skeleton shown:", h.bones.length, "bones");
  }
  function showSkeleton(on) {
    bonesShown = on == null ? !bonesShown : !!on;
    try {
      localStorage.setItem(BONES_KEY, bonesShown ? "1" : "0");
    } catch {}
    updateBoneHelper();
    setStatus("skeleton " + (bonesShown ? "on" : "off"));
    return bonesShown;
  }
  // --- NO-MODEL overlay (#13: the self-made character is retired — no model loaded shows a MESSAGE) ---
  // When no .glb is loaded we render nothing (no placeholder model) and put
  // up a visible DOM panel telling the user how to add one. ASCII only (no emojis), per the avatar
  // console/UI rule. Raised when the placeholder loads, retracted the instant a real model arrives.
  let _onboarding = false,
    _noModelEl = null;
  function _noModelOverlay() {
    if (_noModelEl) return _noModelEl;
    const d = document.createElement("div");
    d.id = "no-model-overlay";
    d.style.cssText = [
      "position:fixed",
      "left:50%",
      "top:50%",
      "transform:translate(-50%,-50%)",
      "max-width:340px",
      "padding:18px 22px",
      "box-sizing:border-box",
      "font:14px/1.5 system-ui,sans-serif",
      "color:#eef1f8",
      "text-align:center",
      "background:rgba(24,26,34,0.92)",
      "border:1px solid rgba(255,255,255,0.18)",
      "border-radius:12px",
      "z-index:2147483646",
      "pointer-events:none",
      "box-shadow:0 6px 24px rgba(0,0,0,0.45)",
    ].join(";");
    d.innerHTML =
      "<div style='font-weight:600;margin-bottom:6px'>No model loaded</div>" +
      "<div>Right-click and choose Add model to load a .glb file" +
      " (.gltf / .vrm / .fbx also work, or drag one onto the window).</div>";
    document.body.appendChild(d);
    _noModelEl = d;
    return d;
  }
  function showOnboarding() {
    _onboarding = true;
    _noModelOverlay().style.display = "block";
  }
  function clearOnboarding() {
    // a real model loaded -> retract the message
    if (!_onboarding) return;
    _onboarding = false;
    if (_noModelEl) _noModelEl.style.display = "none";
  }
  let _loadSeq = 0;
  const _peerRetries = {}; // url -> failed mirror-load attempts (peer only)
  // Bus 'load' completion signal (2026-07-03): load used to be fire-and-forget, so a driver had to
  // GUESS settle time with sleeps (8-15s per model this session). One waiter slot: the newest load
  // owns it; a superseded asker gets {superseded:true}, a failed build an honest {error}.
  let _loadNotify = null,
    _loadNotifyKey = null; // the url the armed waiter asked for (audit 2026-07-04: unkeyed, ANY load path's build resolved a pending bus reqId with the WRONG model's success)
  function _signalLoaded(result) {
    const n = _loadNotify;
    if (!n) return;
    const id = result && (result.url ?? (result.loaded !== "none" ? result.loaded : DEFAULT_KEY));
    if (_loadNotifyKey != null && id != null && id !== _loadNotifyKey) {
      // a DIFFERENT load (gallery click / drag-drop) finished while the waiter's own load was
      // in flight and seq-dropped — honest supersession, never a fake success for the wrong model
      _loadNotify = null;
      _loadNotifyKey = null;
      n({ superseded: true, by: id });
      return;
    }
    _loadNotify = null;
    _loadNotifyKey = null;
    n(result);
  }
  function awaitNextLoad(key) {
    return new Promise((res) => {
      if (_loadNotify) _loadNotify({ superseded: true });
      _loadNotify = res;
      _loadNotifyKey = key != null ? String(key) : null;
    });
  }
  function loadModel(url, label) {
    _cancelMotion(); // a model switch zeroes any in-flight jump hop (stale baseline / rotation)
    if (held) {
      held = false;
      window.avatarIPC?.dragEnd?.();
    } // …and never leave her glued to the cursor across a switch (main also endDrag()s on modelLoaded — belt + braces)
    const seq = ++_loadSeq; // guard: a slower earlier load must not clobber a newer switch
    if (url === DEFAULT_KEY) {
      enterNoModel();
      showOnboarding();
      _signalLoaded({ loaded: "none" });
      return;
    } // #13: no-model state (inert marker + DOM message), NOT a self-made character
    setStatus(`loading ${label || url} ...`);
    loadAsset(
      url,
      (asset) => {
        if (seq === _loadSeq) {
          curKey = url;
          _peerRetries[url] = 0;
          onModelLoaded(asset); // awaits BONE_LIMITS_READY inside — every load path shares that gate
          clearOnboarding();
        }
      }, // commit curKey only on the WINNING load — a failed load must not misroute saves + `query model` onto a model that isn't on screen
      (err) => {
        if (seq !== _loadSeq) return;
        setStatus(`load failed: ${err?.message || err}`);
        _signalLoaded({ error: String(err?.message || err), url });
        console.error(err);
        try {
          window.avatarIPC?.log?.(`LOAD FAILED ${url}: ${err?.message || err}`);
        } catch {} // renderer console is invisible in the main log — failures must be loud (the shibahu lesson, 2026-06-12)
        // A peer that fails the mirror-load would show the PREVIOUS model frozen forever (its pose
        // frames are dropped by the length guard) — retry a few times, loudly, into the main log.
        if (!_isBrain && (_peerRetries[url] = (_peerRetries[url] || 0) + 1) <= 3) {
          window.avatarIPC?.log?.(
            "peer model load failed (attempt " + _peerRetries[url] + "/3): " + url + " — " + (err?.message || err)
          );
          setTimeout(() => {
            if (seq === _loadSeq && curKey !== url) loadModel(url, label);
          }, 5000);
        }
      }
    );
  }

  // --- attachments (props / accessories) --------------------------------------
  // Load any mesh and parent it to a BONE so it rides the animation — held items,
  // hats, the pole Mal0 ships with, glasses, simple capes. Per-avatar, persisted.
  // (Body-conforming clothing still needs a mesh rigged to a matching skeleton —
  // this covers rigid / bone-attached extras.) Placement (bone + offset) is tunable
  // live via EnigmaAvatar.tuneAttachment(); the defaults are a starting point.
  // Per-avatar PROFILE (durable): attachments (by category) + tuned spring/facial, keyed by model
  // URL. The store itself is a headless engine module (src/engine/profiles.js — carve S1-a); the
  // closure only wires its impure edges in as thunks. ONE-writer rule, debounce, mirror fallback,
  // and the blob-filter all live (and are unit-tested) THERE.
  const { profileFor, loadProfiles, saveProfileSoon, commitAttachments } = createProfileStore({
    readJson: () => readLocalJson("./profiles.json"),
    saveIpc: (data) => window.avatarIPC?.saveProfiles?.(data),
    isWriter: () => !(window.avatarIPC && !_isBrain), // peers apply relayed mutations in-memory only
    mirror: (() => {
      try {
        return localStorage;
      } catch {
        return null;
      }
    })(),
    logError: (m) => {
      console.error(m);
      try {
        window.avatarIPC?.log?.(m);
      } catch {}
    },
    getKey: () => curKey,
    getAttachments: () => attachObjs,
  });
  let attachObjs = []; // live for the current model: [{id,category,url,bone,pos,rot,scale,obj,attachedTo}]
  let _attachSeq = 0;
  const D2R = Math.PI / 180;
  const BONE_ALIAS = {
    righthand: "right.*(hand|wrist)",
    lefthand: "left.*(hand|wrist)",
    rightfoot: "right.*(foot|ankle|toe)",
    leftfoot: "left.*(foot|ankle|toe)",
    head: "head",
    neck: "neck",
    hips: "hips|pelvis",
    back: "chest|spine",
    tail: "tail",
  };
  // attach-friendly aliases → canonical RIG ROLE (resolved STRUCTURALLY by rig.js). These win
  // over name matching, so a prop lands on the REAL hand/head even when the bone is named
  // "Bip_R_Wrist_023" or is corrupted — trust no names. Falls back to a name regex only for
  // non-role targets (tail, or any arbitrary bone the AI names explicitly).
  const ROLE_ALIAS = {
    righthand: "right_hand",
    lefthand: "left_hand",
    rightfoot: "right_foot",
    leftfoot: "left_foot",
    head: "head",
    neck: "neck",
    hips: "hips",
    back: "chest",
    chest: "chest",
    spine: "spine",
  };
  const ROLES_SET = new Set(ROLES);
  function findBone(query) {
    if (!model || !query) return null;
    const q = String(query).toLowerCase();
    const role = ROLE_ALIAS[q] || (ROLES_SET.has(q) ? q : null); // a canonical role, or an alias for one?
    if (role && roleBones[role]) return roleBones[role]; // → the STRUCTURALLY resolved bone (name-agnostic)
    let re;
    try {
      re = new RegExp(BONE_ALIAS[q] || q, "i");
    } catch {
      re = new RegExp(q.replace(/[^a-z0-9]+/gi, ".*"), "i");
    } // else a name match (tail / arbitrary bone)
    let best = null;
    model.traverse((o) => {
      if (!best && o.isBone && re.test(o.name)) best = o;
    });
    return best;
  }
  function _placeAttachment(a) {
    a.obj.position.fromArray(a.pos);
    a.obj.rotation.set(a.rot[0] * D2R, a.rot[1] * D2R, a.rot[2] * D2R);
    a.obj.scale.setScalar(a.scale);
  }
  function saveAttachments() {
    commitAttachments();
    saveProfileSoon();
  } // snapshot + persist
  // Bus attach/tune numerics are stringly-typed — one garbage triplet would NaN the prop's matrix
  // (invisible prop) AND be persisted to the profile. Sanitize at the entry.
  const _v3 = (v, d) => (Array.isArray(v) && v.length === 3 && v.every((n) => isFinite(+n)) ? v.map(Number) : d);
  const _num = (v, d) => (isFinite(+v) ? +v : d);
  function attachMesh(url, opts = {}) {
    const category = opts.category || "prop";
    const defBone = category === "furniture" ? "" : category === "clothes" ? "back" : "righthand";
    const a = {
      id: opts.id || "a" + ++_attachSeq,
      category,
      url,
      bone: opts.bone ?? defBone,
      pos: _v3(opts.pos, [0, 0, 0]),
      rot: _v3(opts.rot, [0, 0, 0]),
      scale: opts.scale != null ? _num(opts.scale, 1) : 1,
    };
    const forKey = curKey; // the model this attach was aimed at — a swap mid-load must not
    // attach the prop to the NEW model and durably write it into the WRONG profile
    loadAsset(
      url,
      (asset) => {
        if (!asset.scene) {
          setStatus("attach failed: no mesh");
          return;
        }
        if (curKey !== forKey) {
          disposeMeshTree(asset.scene);
          setStatus(`attach dropped: model changed while ${baseName(url)} loaded`);
          return;
        }
        a.obj = asset.scene;
        const bone = a.bone ? findBone(a.bone) : null; // furniture (no bone) → rides the rig root (floats with her)
        a.attachedTo = bone ? bone.name : "(rig root)";
        a.obj.traverse((o) => {
          if (o.isMesh) o.frustumCulled = false;
        });
        (bone || rig).add(a.obj);
        _placeAttachment(a);
        // Auto-size a FRESH prop to a sane fraction of the avatar — a separate mesh has
        // its own units, so scale:1 can render giant/tiny (avatar audit #1). Avatar
        // height uses BASE_H×size (skinned-mesh bboxes are unreliable); prop uses its
        // own bbox. Skipped when a scale was given or when restoring a saved one.
        if (opts.scale == null && !opts._restore && model) {
          a.obj.updateWorldMatrix(true, true);
          const pb = new THREE.Box3().setFromObject(a.obj);
          const pMax = Math.max(pb.max.x - pb.min.x, pb.max.y - pb.min.y, pb.max.z - pb.min.z) || 1;
          const aH = BASE_H * (rig.scale.x || 1) || 1;
          const frac = category === "furniture" ? 0.9 : category === "clothes" ? 1.0 : 0.45;
          const s = (aH * frac) / pMax;
          if (isFinite(s) && s > 0) {
            a.scale = +s.toFixed(4);
            _placeAttachment(a);
          }
        }
        attachObjs.push(a);
        if (!opts._restore) saveAttachments();
        console.log("[avatar] attached", baseName(url), "->", a.attachedTo);
        setStatus(`attached ${baseName(url)} -> ${a.attachedTo}`);
      },
      (err) => setStatus(`attach failed: ${err?.message || err}`),
      { kind: opts.kind || kindOf(url) }
    );
    return a.id;
  }
  function disposeObj(root) {
    disposeMeshTree(root); // incl. textures — see util/dispose.js
  }
  function detachAttachment(id) {
    const i = attachObjs.findIndex((a) => a.id === id);
    if (i < 0) return false;
    const a = attachObjs[i];
    a.obj?.parent?.remove(a.obj);
    disposeObj(a.obj);
    attachObjs.splice(i, 1);
    saveAttachments();
    return true;
  }
  function clearAttachments() {
    for (const a of attachObjs) {
      a.obj?.parent?.remove(a.obj);
      disposeObj(a.obj);
    }
    attachObjs = [];
    saveAttachments();
  }
  function reapplyAttachments() {
    // Furniture rides the RIG root (not the disposed model subtree) — explicitly remove what's
    // still parented there, or every model switch leaves a ghost chair with no remaining handle.
    for (const a of attachObjs)
      if (a.obj && a.obj.parent === rig) {
        rig.remove(a.obj);
        disposeObj(a.obj);
      }
    attachObjs = []; // bone-parented props died with the disposed model subtree
    for (const cfg of profileFor(curKey).attachments || []) attachMesh(cfg.url, { ...cfg, _restore: true });
  }
  function tuneAttachment(id, opts = {}) {
    const a = attachObjs.find((x) => x.id === id);
    if (!a || !a.obj) return null;
    if (opts.pos) a.pos = _v3(opts.pos, a.pos);
    if (opts.rot) a.rot = _v3(opts.rot, a.rot);
    if (opts.scale != null) a.scale = _num(opts.scale, a.scale);
    if (opts.bone && opts.bone !== a.bone) {
      a.bone = opts.bone;
      const bone = findBone(a.bone);
      a.obj.parent?.remove(a.obj);
      (bone || rig).add(a.obj);
      a.attachedTo = bone ? bone.name : "(rig root)";
    }
    _placeAttachment(a);
    saveAttachments();
    return { id: a.id, bone: a.bone, attachedTo: a.attachedTo, pos: a.pos, rot: a.rot, scale: a.scale };
  }
  // Per-avatar physics / face tuning — applied live and saved into the profile.
  // Keep only FINITE numeric entries from a tune-params object — the bus is stringly-typed, and one
  // garbage value ({stiffness:"abc"}) would NaN-poison every spring tip AND be PERSISTED to the profile
  // (a freeze that survives restarts). The Settings path validates in ui.js; the bus path lands here.
  function numericOnly(p) {
    const out = {};
    for (const k in p) {
      const n = +p[k];
      if (isFinite(n)) out[k] = n;
    }
    return out;
  }
  function springTune(p) {
    const prof = profileFor(curKey);
    prof.spring = { ...(prof.spring || {}), ...numericOnly(p) };
    if (spring) spring.setParams(prof.spring);
    saveProfileSoon();
    return prof.spring;
  }
  // Object-toy feel (thrown/dropped balls): gravity + bounce, saved per avatar like the hair tune.
  // (User 2026-07-02: the Ball menu had no way to SEE or SET what object gravity was doing.)
  function physicsTune(p) {
    const prof = profileFor(curKey);
    prof.objects = { ...(prof.objects || {}), ...numericOnly(p) };
    physics.tune(prof.objects);
    saveProfileSoon();
    return prof.objects;
  }
  function facialTune(p) {
    const prof = profileFor(curKey);
    // jawAxis/lidAxis are the documented STRING knobs ("x"|"y"|"z") — numericOnly stripped them
    // silently, so a rig whose jaw opens on Y could never be fixed through the API it documents
    const axes = {};
    for (const k of ["jawAxis", "lidAxis"]) {
      if (p && ["x", "y", "z"].includes(p[k])) axes[k] = p[k];
    }
    prof.facial = { ...(prof.facial || {}), ...numericOnly(p), ...axes };
    if (facial) facial.setParams(prof.facial);
    saveProfileSoon();
    return facial ? { mode: facial.mode, info: facial.info, params: facial.params } : null;
  }
  // (idleTune / idleCapsNow / reseedIdleNow lived here — deleted with the whole idle system,
  // user order 2026-06-12. There is no idle to tune and no personality to seed.)
  // Every material by OBJECT (incl. unnamed AND duplicate-named), in traversal order, WITH the
  // owning mesh name — the stable INDEX the overlay OWNS and reports over the AI bus
  // ('query materials'). recolor-by-index, the Settings color list, and "look at the parts"
  // all use THIS list (the authority), NOT the static profiler's gltf-array index, and NOT
  // names (a model can have unnamed or repeated names — index is the only reliable handle).
  function allMaterialsInfo() {
    const seen = new Set(),
      out = [];
    model?.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material])
        if (m && !seen.has(m)) {
          seen.add(m);
          out.push({ m, mesh: o.name || null });
        }
    });
    return out;
  }
  function allMaterials() {
    return allMaterialsInfo().map((x) => x.m);
  }
  function _setColor(target, hex) {
    let n = 0;
    if (typeof target === "number") {
      // by INDEX (the live authority — names untrusted)
      const m = allMaterials()[target];
      if (m && m.color) {
        m.color.set(hex);
        m.needsUpdate = true;
        n = 1;
      }
      return n;
    }
    model?.traverse((o) => {
      // by NAME (legacy; silently 0 if no match)
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material])
        if (m && m.name === target && m.color) {
          m.color.set(hex);
          m.needsUpdate = true;
          n++;
        }
    });
    return n;
  }
  function recolor(target, hex) {
    const n = _setColor(target, hex);
    // persist keyed by the material's NAME (re-applies on reload even if the index shifts);
    // an unnamed material falls back to a synthetic key.
    const m = typeof target === "number" ? allMaterials()[target] : null;
    // persist by name ONLY when the name is unique — a duplicate name would re-tint EVERY same-named
    // material on the next load though just one was tinted live (audit); else the "#index" handle
    const dup = m && m.name ? allMaterials().filter((x) => x && x.name === m.name).length > 1 : false;
    const key = m ? (m.name && !dup ? m.name : `#${target}`) : target;
    const p = profileFor(curKey);
    p.colors = p.colors || {};
    p.colors[key] = hex;
    saveProfileSoon();
    if (typeof target === "number")
      setStatus(`recolor #${target}${m && m.name ? " (" + m.name + ")" : ""} -> ${hex}; ${n} hit`);
    return n;
  }
  // Re-apply saved tints on load. A key is either a material NAME or a "#<index>" handle (how an
  // UNNAMED material is saved) — route "#N" through the index path so index-recolors persist too.
  function applyColors() {
    const c = profileFor(curKey).colors;
    if (!c) return;
    for (const k in c) {
      const mi = /^#(\d+)$/.exec(k);
      _setColor(mi ? +mi[1] : k, c[k]);
    }
  }
  // Remember each material's loaded color ONCE (before any saved tint) so "Reset colors" can
  // restore it. Called on every model load, before applyColors re-tints.
  function captureOriginalColors() {
    for (const m of allMaterials()) if (m.color && !m.userData._origColor) m.userData._origColor = m.color.clone();
  }
  // Restore every material to its original loaded color + clear hue, and wipe this avatar's saved
  // tints — the Settings "Reset colors" one-click restart.
  function resetColors() {
    for (const m of allMaterials()) {
      if (m.color && m.userData._origColor) {
        m.color.copy(m.userData._origColor);
        m.needsUpdate = true;
      }
      if (m.userData._hueU) m.userData._hueU.value = 0;
    }
    const p = profileFor(curKey);
    p.colors = {};
    p.hue = {};
    saveProfileSoon();
    setStatus("colors reset to original");
  }

  // --- meshes (sub-objects: clothing variants, hide-able body parts) ----------
  // A model bundles multiple meshes (e.g. 2 shirts / shorts / a nude body). Address them by INDEX in
  // traversal order — names are unreliable — and toggle visibility to pick a variant. Hidden set saved.
  // Mesh list in PRISTINE FILE ORDER, cached at load BEFORE any hierarchy surgery/adoption.
  // hiddenMeshes/meshLabels/colors are keyed by INDEX — live traversal order CHANGES when bones are
  // reparented (battery 2026-06-12: aveline's hidden floor planes came back because the skin-weight
  // adoption shifted traversal and her saved [0..4] started hiding five robot parts instead).
  let _meshList = null;
  function allMeshesInfo() {
    if (_meshList) return _meshList.filter((e) => e.mesh && e.mesh.parent !== null); // drop disposed strays, keep order
    const out = [];
    model?.traverse((o) => {
      if (o.isMesh) out.push({ mesh: o, name: o.name || null });
    });
    return out;
  }
  function setMeshVisible(i, on) {
    const arr = allMeshesInfo();
    const it = arr[i];
    if (!it) return 0;
    it.mesh.visible = !!on;
    const p = profileFor(curKey);
    const hid = new Set(p.hiddenMeshes || []);
    if (on) hid.delete(i);
    else hid.add(i);
    p.hiddenMeshes = [...hid].sort((a, b) => a - b);
    saveProfileSoon();
    hitMask = null;
    computeFootprint();
    refreshDims(); // silhouette changed → re-scan the grab footprint + the dims (shadow/walls/capsule)
    setStatus(`mesh #${i}${it.name ? " (" + it.name + ")" : ""} -> ${on ? "shown" : "hidden"}`);
    return 1;
  }
  function applyMeshVisibility() {
    const hid = profileFor(curKey).hiddenMeshes;
    if (!hid || !hid.length) return;
    const arr = allMeshesInfo();
    for (const i of hid) if (arr[i]) arr[i].mesh.visible = false;
  }
  // Bounds over VISIBLE meshes, SKINNING-AWARE: expandByObject reads the UNSKINNED geometry box,
  // which lies for models whose parts are authored side-by-side and assembled by skinning (aveline:
  // a 15-unit-wide geometry box on a 1-unit-wide robot → giant shadow + crushed scale). SkinnedMesh
  // .computeBoundingBox() poses every vertex through its bones — the truth.
  function expandVisiblePosed(box) {
    // MEASURE THE BONES, NOT THE MESH (battery 2026-06-12, round 2): skinned-mesh bounding boxes are
    // computed against the BIND-time frame — after we scale/shift/normalize the model they come back
    // as frame-trap garbage (her body measured 0.26 units, a hair object 7.4 — dims hit 12.8 on a
    // 3.5-unit model, mesh floated above the base, shadow exploded, auto-size crushed). The DEFORMING
    // bones (skin-weight map) are the truth the whole engine already trusts: their world positions
    // bound her body, a small pad covers flesh beyond joints, and stray ground/backdrop planes are
    // excluded automatically (planes aren't bones). Static no-bone models (statues) keep honest rigid
    // geometry boxes.
    const v = new THREE.Vector3();
    const pts = [];
    if (_weightMass && _weightMass.size)
      for (const [b, m] of _weightMass) {
        if (m > 0.5) {
          b.getWorldPosition(v);
          pts.push({ x: v.x, y: v.y, m });
        }
      }
    if (!pts.length)
      model.traverse((o) => {
        if (o.isBone) {
          o.getWorldPosition(v);
          pts.push({ x: v.x, y: v.y, m: 1 });
        }
      });
    if (pts.length > 3) {
      // MASS-WEIGHTED 1–99% bounds: a parked-but-lightly-weighted helper (an IK target at the rig
      // root, 5 units off the body) must not define her box — its sliver of mass falls outside the
      // percentile. The body's bones carry ~all the mass and set the real extent.
      const pct = (key, p) => {
        const s2 = pts.slice().sort((a, b2) => a[key] - b2[key]);
        const tot = s2.reduce((t, e) => t + e.m, 0);
        let acc = 0;
        for (const e of s2) {
          acc += e.m;
          if (acc >= tot * p) return e[key];
        }
        return s2[s2.length - 1][key];
      };
      box.min.set(pct("x", 0.01), pct("y", 0.01), -0.5);
      box.max.set(pct("x", 0.99), pct("y", 0.99), 0.5);
      box.expandByScalar(Math.max(box.max.y - box.min.y, 0.1) * 0.07); // flesh extends past the joints
      // HEIGHT from ANATOMY when the rig resolved: feet→head role span + headroom. Hair/cloth bones
      // are heavy AND long (twin-tails), so even weighted percentiles stretch the vertical box —
      // but a humanoid's height IS her feet-to-crown distance, and the roles are exact.
      const ft2 = roleBones.left_foot || roleBones.right_foot,
        hd2 = roleBones.head;
      if (ft2 && hd2) {
        const fy = ft2.getWorldPosition(v).y;
        const hy = hd2.getWorldPosition(new THREE.Vector3()).y;
        if (hy > fy + 0.05) {
          box.min.y = fy - (hy - fy) * 0.04;
          box.max.y = hy + (hy - fy) * 0.18;
        } // soles below the ankle joint; crown above the head joint
      }
      return;
    }
    if (pts.length) {
      for (const p of pts) box.expandByPoint(v.set(p.x, p.y, 0));
      box.expandByScalar(0.2);
      return;
    }
    model.traverse((o) => {
      if (o.isMesh && o.visible) box.expandByObject(o);
    });
  }
  // Re-measure her on-screen dims from VISIBLE meshes (rotation neutralized) — show/hide and outfit
  // swaps change the real silhouette, and dims feed the shadow width, walls, capsule and grab box.
  function refreshDims() {
    if (!model) return;
    const rq = rig.quaternion.clone();
    rig.quaternion.identity();
    rig.updateWorldMatrix(true, true);
    _box.makeEmpty();
    expandVisiblePosed(_box);
    if (isFinite(_box.min.y) && _box.max.y > _box.min.y) {
      const s = rig.scale.x || 1;
      const w = (_box.max.x - _box.min.x) / s,
        h = (_box.max.y - _box.min.y) / s;
      if (w > 0.01 && h > 0.01 && w < BASE_H * 2.5 && h < BASE_H * 2.5)
        modelDims = { w, h }; // same sanity gate as the load re-anchor — never trust a poisoned measurement
      else {
        const m = `[avatar] POISONED dims refresh skipped: ${w.toFixed(1)}x${h.toFixed(1)}`;
        console.warn(m);
        try {
          window.avatarIPC?.log?.(m);
        } catch {}
      }
    }
    rig.quaternion.copy(rq);
    rig.updateWorldMatrix(true, true);
  }

  // --- OUTFITS — named mesh-visibility presets per model ("can i put clothes on avatars", 2026-06-12):
  // one-click looks built from the parts a model SHIPS (dressed / undressed / armor-off …). A preset
  // is just the hidden-mesh index list under a name, saved in the profile; wearing one shows
  // EVERYTHING first then hides the preset's set (applyMeshVisibility only hides — a wear must also
  // restore parts the previous look had off).
  function outfitNames() {
    return Object.keys(profileFor(curKey).outfits || {});
  }
  function saveOutfit(name) {
    const s = String(name || "").trim();
    if (!s) return null;
    const p = profileFor(curKey);
    p.outfits = p.outfits || {};
    p.outfits[s] = [...(p.hiddenMeshes || [])];
    saveProfileSoon();
    setStatus(`outfit saved: ${s}`);
    return outfitNames();
  }
  function wearOutfit(name) {
    const p = profileFor(curKey),
      o = (p.outfits || {})[String(name || "").trim()];
    if (!o) {
      setStatus(`no outfit "${name}"`);
      return false;
    }
    const hid = new Set(o.map((i) => +i).filter((i) => Number.isInteger(i) && i >= 0));
    const arr = allMeshesInfo();
    for (let i = 0; i < arr.length; i++) arr[i].mesh.visible = !hid.has(i);
    p.hiddenMeshes = [...hid].sort((a, b) => a - b);
    saveProfileSoon();
    hitMask = null;
    computeFootprint();
    refreshDims(); // silhouette changed
    setStatus(`outfit: ${name}`);
    return true;
  }
  function deleteOutfit(name) {
    const p = profileFor(curKey);
    if (p.outfits) delete p.outfits[String(name || "").trim()];
    saveProfileSoon();
    return outfitNames();
  }

  // --- rotation: turn the avatar on ALL THREE axes (pitch X / yaw Y / roll Z); persisted per model.
  // Stored as profile.rot = {x,y,z} in degrees. Migrates the legacy single-axis profile.yaw → rot.y.
  const _norm360 = norm360; // alias — the pure impl lives in mathutil.js (unit-tested)
  function getRot() {
    return rotFromProfile(profileFor(curKey));
  }
  function applyRotationTo(r) {
    rig.rotation.set((r.x * Math.PI) / 180, (r.y * Math.PI) / 180, (r.z * Math.PI) / 180);
  }
  function applyRotation() {
    applyRotationTo(getRot());
  } // restore saved rotation on load
  function _saveRot(r) {
    const p = profileFor(curKey);
    const saved = rotToSave(r); // normalized {x,y,z} or null (all-zero → drop the key)
    if (saved) p.rot = saved;
    else delete p.rot;
    if ("yaw" in p) delete p.yaw; // drop the legacy key once we write the new shape
    saveProfileSoon();
  }
  // Set ONE axis (Settings fields / bus). axis ∈ "x"|"y"|"z". Persists + re-scans the grab silhouette.
  function setRotAxis(axis, deg) {
    if (axis !== "x" && axis !== "y" && axis !== "z") return 0; // ignore a bad axis (don't persist / re-scan a no-op)
    _cancelMotion(); // an explicit rotate zeroes any jump hop (no rig.rotation tug-of-war)
    const r = getRot();
    r[axis] = _norm360(deg);
    applyRotationTo(r);
    _saveRot(r);
    hitMask = null;
    computeFootprint();
    return r[axis];
  }
  // Set all three axes at once (drag-rotate commit / bus {x,y,z}).
  function setRot(r) {
    _cancelMotion(); // explicit rotate zeroes any jump hop
    const nr = { x: _norm360(r.x), y: _norm360(r.y), z: _norm360(r.z) };
    applyRotationTo(nr);
    _saveRot(nr);
    hitMask = null;
    computeFootprint();
    return nr;
  }
  function setYaw(deg) {
    return setRotAxis("y", deg);
  } // back-compat (bus `rotate {deg}`, legacy callers/tests)

  // --- soft-body jiggle REGIONS (per-area weight: breast/butt/genital/cloth/hair/tail/…) ---
  // The spring tags each dangly/soft bone with a region; this layer lets the user set "how much
  // each area jiggles" (0 = pinned/rigid, 1 = default, >1 = bouncier). Saved per avatar so e.g.
  // Mal0's breast/butt/genital chains can each be tuned or switched off. Cloth is its OWN region.
  function springRegions() {
    return spring ? spring.regions() : [];
  }
  function setRegionWeight(region, w) {
    const p = profileFor(curKey);
    p.regions = p.regions || {};
    const v = spring ? spring.setRegionWeight(region, w) : Math.max(0, Math.min(2, +w || 0));
    if (v === 1) delete p.regions[region];
    else p.regions[region] = v; // 1 == default → don't bloat the profile with no-op entries
    saveProfileSoon();
    setStatus(`${region} jiggle -> ${v.toFixed(2)}`);
    return v;
  }

  // --- morph targets / blendshapes (the avatar's OWN toggles & expressions) -----------------
  // A model can ship shape keys (makiro: 19) — facial expressions, body toggles, "show/hide X".
  // Exporters usually strip the names, so address BY INDEX (0..count-1). We drive only the PRIMARY
  // morph group — the meshes that share the LARGEST morph count (the face/body carrying the shapes).
  // For a normal rig (makiro: 4 body meshes × the SAME 19 morphs) that's every morph mesh; for a
  // divergent rig it's just the main one, so a mesh that reuses an index for a DIFFERENT shape isn't
  // distorted (audit). Saved per avatar.
  function morphMeshes() {
    let maxN = 0;
    model?.traverse((o) => {
      if (o.isMesh && o.morphTargetInfluences) maxN = Math.max(maxN, o.morphTargetInfluences.length);
    });
    const meshes = [];
    if (maxN)
      model?.traverse((o) => {
        if (o.isMesh && o.morphTargetInfluences && o.morphTargetInfluences.length === maxN) meshes.push(o);
      });
    return { meshes, n: maxN };
  }
  function morphNameAt(i) {
    // best-effort name from the primary group's morphTargetDictionary (often absent)
    for (const o of morphMeshes().meshes) {
      if (!o.morphTargetDictionary) continue;
      for (const k in o.morphTargetDictionary) if (o.morphTargetDictionary[k] === i) return k;
    }
    return null;
  }
  // Per-model morph classification (2026-07-03 audit finding 4): the geometric eye/mouth-band
  // analysis always existed but was facial.js-private, so a model with 42 unnamed morphs meant 42
  // blind snap probes. Computed ONCE at load — rest pose, real facing — in the facial build block
  // (audit 2026-07-04: computing lazily at query time classified the LIVE pose and cached it).
  let _morphGeo = null;
  function resetMorphGeo() {
    _morphGeo = null;
  }
  function morphGeoAnalysis() {
    return _morphGeo; // null = honestly unclassified (no head anchor / no morphs / analysis failed)
  }
  function allMorphsInfo() {
    const { meshes, n } = morphMeshes();
    if (!n) return [];
    const cur = meshes[0]?.morphTargetInfluences || [];
    const owned = new Set(facial?.ownedMorphs || []); // morphs the lip-sync/blink layer auto-drives → a manual set won't hold (flag them so the UI explains it)
    const g = morphGeoAnalysis();
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = g?.byIndex?.get(i);
      const region = !s
        ? null
        : s.mouthScore > s.eyeScore && s.mouthScore > 0.05
          ? "mouth"
          : s.eyeScore > 0.05
            ? "eyes"
            : null;
      out.push({
        index: i,
        name: morphNameAt(i),
        value: +(cur[i] || 0),
        auto: owned.has(i),
        region, // geometric band guess ("mouth"|"eyes"|null) — a hunting driver starts HERE, not at 42 blind probes
        score: s ? +Math.max(s.mouthScore, s.eyeScore).toFixed(2) : 0,
      });
    }
    return out;
  }
  function setMorphValue(i, v) {
    const raw = v == null ? 1 : +v;
    if (!isFinite(raw)) return 0; // Math.max/min are NaN-transparent — a garbage bus value would hit the GPU AND be persisted
    const amt = Math.max(0, Math.min(1, raw));
    let nHit = 0;
    for (const o of morphMeshes().meshes)
      if (i < o.morphTargetInfluences.length) {
        o.morphTargetInfluences[i] = amt;
        nHit++;
      }
    const p = profileFor(curKey);
    p.morphs = p.morphs || {};
    if (amt <= 0) delete p.morphs[i];
    else p.morphs[i] = amt; // default (0) → don't persist
    saveProfileSoon();
    setStatus(`morph #${i}${morphNameAt(i) ? " (" + morphNameAt(i) + ")" : ""} -> ${amt.toFixed(2)}; ${nHit} mesh`);
    return nHit;
  }
  function applyMorphs() {
    const m = profileFor(curKey).morphs;
    if (!m) return;
    const { meshes } = morphMeshes();
    for (const k in m) {
      const i = +k,
        val = +m[k];
      if (!isFinite(val)) continue;
      const amt = val < 0 ? 0 : val > 1 ? 1 : val;
      for (const o of meshes) if (i < o.morphTargetInfluences.length) o.morphTargetInfluences[i] = amt;
    } // VALIDATE on read-back: a garbage/legacy profiles.json value must not reach the GPU (the writer guards; the load path must too)
  }
  // Per-mesh friendly LABEL (parts often have useless names like "Object_107" or duplicates) — the
  // user can rename a part so the Settings list is legible. Stored per avatar, keyed by mesh index.
  function setMeshLabel(i, label) {
    const p = profileFor(curKey);
    p.meshLabels = p.meshLabels || {};
    const s = String(label || "").trim();
    if (s) p.meshLabels[i] = s;
    else delete p.meshLabels[i];
    saveProfileSoon();
    return s;
  }
  // Per-BONE friendly LABEL (rig names are soup: "HairBoneL006_0524") — the user names a bone once
  // ("ahoge", "left ear tip") and it shows wherever bones surface (Settings, query bones, repair),
  // so they can point at parts of the rig in plain words. Stored per avatar, keyed by BONE NAME.
  function setBoneLabel(name, label) {
    const p = profileFor(curKey);
    p.boneLabels = p.boneLabels || {};
    const s = String(label || "").trim();
    if (s) p.boneLabels[name] = s;
    else delete p.boneLabels[name];
    saveProfileSoon();
    return s;
  }
  // --- BONE IDENTIFICATION (user 2026-06-12: "i will need a way of identifying them") -------------
  // highlightBone: a hot-pink marker rides the named bone for a moment (relayed → shows on whichever
  // monitor she's on) — the AI/bus's way to point AT a part. For the HUMAN, Settings → Bones puts a
  // checkbox on every row (setBoneMark): ✓ = the marker stays on that bone until unchecked. The old
  // click-modes (click-her-to-pick + hover-a-row-to-flash) were replaced at user direction
  // (2026-07-03: "i do not like the click the bone idea — just make it a checkbox to see the bone").
  function _findBone(name) {
    const key = String(name);
    let b = roleBones[key] || null; // canonical role ("left_arm") resolves FIRST — the AI speaks roles, not per-rig bone names
    if (!b)
      model.traverse((o) => {
        if (o.isBone && o.name === key) b = o;
      });
    return b;
  }
  function _makeMarkMesh() {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1, 14, 10),
      new THREE.MeshBasicMaterial({
        color: 0xff2bd6,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.85,
      })
    );
    m.renderOrder = 1001;
    m.frustumCulled = false;
    return m;
  }
  function _rideBone(mark, b) {
    b.add(mark); // riding the bone = it follows every pose, on every window's copy
    const ws = new THREE.Vector3();
    b.getWorldScale(ws);
    const want = Math.max(0.03, (modelDims.h || 2) * sizeScale * 0.02); // ~2% of her on-screen height
    mark.scale.setScalar(want / Math.max(1e-6, Math.abs(ws.x) || 1));
    mark.position.set(0, 0, 0);
  }
  let _hlMark = null,
    _hlTimer = 0;
  function highlightBone(name, dur = 1.6) {
    if (!model || !name) return false;
    const b = _findBone(name);
    if (!b) {
      setStatus(`no bone "${name}"`);
      return false;
    }
    if (!_hlMark) _hlMark = _makeMarkMesh();
    _hlMark.removeFromParent();
    _rideBone(_hlMark, b);
    clearTimeout(_hlTimer);
    _hlTimer = setTimeout(
      () => {
        try {
          _hlMark?.removeFromParent();
        } catch {}
      },
      Math.max(250, (+dur || 1.6) * 1000)
    );
    wake((+dur || 1.6) + 0.4);
    return true;
  }
  // Persistent markers (the Settings checkboxes). One mesh per checked bone so several can be
  // compared at once; cleared with the model (disposeModel — the meshes ride its bones).
  const _boneMarks = new Map(); // raw bone name -> marker mesh riding that bone
  function setBoneMark(name, on) {
    const key = String(name || "");
    if (!key) return false;
    const cur = _boneMarks.get(key);
    if (!on) {
      if (!cur) return true; // already off
      cur.removeFromParent();
      cur.geometry.dispose();
      cur.material.dispose();
      _boneMarks.delete(key);
      wake(0.5);
      return true;
    }
    if (cur) return true; // already marked
    if (!model) return false;
    const b = _findBone(key);
    if (!b) {
      setStatus(`no bone "${key}"`);
      return false;
    }
    const m = _makeMarkMesh();
    _rideBone(m, b);
    _boneMarks.set(key, m);
    wake(0.5);
    return true;
  }
  const boneMarks = () => [..._boneMarks.keys()]; // which bones are checked — Settings re-reads this on every re-open/re-render

  // --- rotate mode: DRAG the body to rotate it (↔ horizontal = yaw, ↕ vertical = pitch) instead of
  // moving the window. Roll (Z) is set via the numeric field. Settings stays usable while you pose it.
  let rotateMode = false;
  let spinning = false,
    _spinX = 0,
    _spinY = 0,
    _spinRot = { x: 0, y: 0, z: 0 };
  const SPIN_DEG_PER_PX = 0.8;
  function setRotateMode(on) {
    rotateMode = on == null ? !rotateMode : !!on;
    setStatus("rotate-by-drag " + (rotateMode ? "on - drag: left/right turn, up/down tilt" : "off"));
    return rotateMode;
  }
  // target rotation from the live drag delta (yaw from horizontal travel, pitch from vertical; roll held)
  function _spinTo(e) {
    const cx = e && e.clientX != null ? e.clientX : cursor.x,
      cy = e && e.clientY != null ? e.clientY : cursor.y;
    return {
      x: _spinRot.x + (cy - _spinY) * SPIN_DEG_PER_PX,
      y: _spinRot.y + (cx - _spinX) * SPIN_DEG_PER_PX,
      z: _spinRot.z,
    };
  }
  function spinLive(e) {
    // live rotate-drag preview; no persist/footprint
    const r = _spinTo(e);
    if (_isBrain) applyRotationTo({ x: _norm360(r.x), y: _norm360(r.y), z: _norm360(r.z) });
    else uiRotLive(r); // peer: the brain applies it; the result streams back via the pose broadcast
  }
  // Hue-shift a material's final color IN-SHADER (rotates hue, keeps the texture's detail)
  // — for parts a flat tint can't reach. Live via a uniform; saved per avatar.
  function _hueMaterial(m, deg) {
    const rad = (((((deg || 0) % 360) + 360) % 360) * Math.PI) / 180;
    if (m.userData._hueU) {
      m.userData._hueU.value = rad;
      return;
    } // already patched → just update the uniform
    const u = { value: rad };
    m.userData._hueU = u;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uHue = u;
      shader.fragmentShader =
        "uniform float uHue;\nvec3 _hueRot(vec3 c){float s=sin(uHue),k=cos(uHue);return clamp(mat3(0.299+0.701*k+0.168*s,0.587-0.587*k+0.330*s,0.114-0.114*k-0.497*s, 0.299-0.299*k-0.328*s,0.587+0.413*k+0.035*s,0.114-0.114*k+0.292*s, 0.299-0.300*k+1.250*s,0.587-0.588*k-1.050*s,0.114+0.886*k-0.203*s)*c,0.0,1.0);}\n" +
        shader.fragmentShader.replace(
          "#include <map_fragment>",
          "#include <map_fragment>\n  diffuseColor.rgb = _hueRot(diffuseColor.rgb);"
        );
    };
    m.needsUpdate = true; // force recompile so onBeforeCompile injects the patch
  }
  function _setHue(name, deg) {
    let n = 0;
    model?.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material])
        if (m && m.name === name && m.color) {
          _hueMaterial(m, deg);
          n++;
        }
    });
    return n;
  }
  function hueShift(name, deg) {
    const n = _setHue(name, deg);
    const p = profileFor(curKey);
    p.hue = p.hue || {};
    p.hue[name] = deg;
    saveProfileSoon();
    return n;
  }
  function applyHue() {
    const h = profileFor(curKey).hue;
    if (h) for (const k in h) _setHue(k, h[k]);
  }

  // --- hit-test via the on-screen PIXEL SILHOUETTE (what actually renders) -------
  // Render the model to a tiny offscreen buffer ~6×/s and keep its alpha as a
  // silhouette MASK. A click then only lands on the avatar where there's an actual
  // lit pixel (plus a small grab tolerance) — NOT anywhere inside its bounding box —
  // so you can click *through* the empty gaps around a limb straight to the desktop.
  // (Boxes also lie for skinned rigs — Roxanne's collapsed to her feet, GLaDOS's
  // blew up — which the footprint sidesteps.) A rig that renders degenerate (its
  // footprint fills the screen) falls back to a central body column so it stays grabbable.
  const _fpRT = new THREE.WebGLRenderTarget(2, 2);
  let hitRect = [0, 0, 0, 0]; // debug bbox of the silhouette / fallback region
  let hitMask = null; // Uint8Array silhouette (1 = avatar) at maskW×maskH, bottom-left origin; null → fallback
  let maskW = 0,
    maskH = 0;
  let fpCoverage = 0,
    fpClock = 0.2,
    _fbWarned = false;
  // Footprint scratch, REUSED across passes — this runs ~6×/s, so a fresh RGBA-readback
  // array + mask every call was needless GC churn. Re-allocated only when the window
  // aspect changes (SW is fixed at 256; SH tracks innerHeight/innerWidth).
  let _fpBuf = null,
    _fpMask = null,
    _fpW = 0,
    _fpH = 0;

  function computeFootprint() {
    if (!model) {
      hitMask = null;
      return;
    }
    const SW = 256,
      SH = Math.max(2, Math.round((256 * innerHeight) / innerWidth));
    if (SW !== _fpW || SH !== _fpH) {
      // (re)allocate buffers + RT only on an aspect change
      _fpW = SW;
      _fpH = SH;
      _fpBuf = new Uint8Array(SW * SH * 4);
      _fpMask = new Uint8Array(SW * SH);
      _fpRT.setSize(SW, SH);
    }
    renderer.setRenderTarget(_fpRT);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    const buf = _fpBuf,
      mask = _fpMask;
    try {
      renderer.readRenderTargetPixels(_fpRT, 0, 0, SW, SH, buf);
    } catch (e) {
      // overwrites every byte of buf
      hitMask = null;
      try {
        window.avatarIPC?.log?.(
          "[avatar] footprint readback threw (" + ((e && e.message) || e) + ") -> hitMask=null (fail-safe THROUGH)"
        );
      } catch {}
      return;
    } // GL context loss must NOT leave a STALE silhouette capturing clicks where she no longer is — strict fail-safe
    // Mask derivation + the empty/over-coverage fail-open decision live in the pure,
    // unit-tested hittest module; this stays the GPU-readback adapter around it.
    const sil = buildSilhouette(buf, SW, SH, mask);
    fpCoverage = sil.coverage;
    if (!sil.ok) {
      hitMask = null;
      return;
    } // empty, or near-fully opaque (corrupted render) -> fail-safe fallback. A legit large-but-SHAPED avatar keeps its precise mask, so the empty gaps around her still click through.
    hitMask = mask;
    maskW = SW;
    maskH = SH;
    const [mnx, mny, mxx, mxy] = sil.bbox;
    const sxL = (mnx / SW) * innerWidth,
      sxR = ((mxx + 1) / SW) * innerWidth;
    const syT = (1 - (mxy + 1) / SH) * innerHeight,
      syB = (1 - mny / SH) * innerHeight;
    hitRect = [Math.round(sxL), Math.round(syT), Math.round(sxR), Math.round(syB)];
  }

  function computeOver() {
    if (!model) {
      cursor.over = false;
      return;
    }
    let over;
    if (hitMask) {
      // shaped to the avatar — empty space clicks through (pure module: overMask)
      over = overMask(cursor.x, cursor.y, { mask: hitMask, maskW, maskH, innerWidth, innerHeight });
      // A SPECK-sized avatar (over-shrunk with the size cap off) is honest but unaimable — the
      // 8px mask tolerance needs pixel-perfect aim. Give her the same BOUNDED handle the no-mask
      // path gets (min half-width 28px) so she stays grabbable/recoverable at any size.
      if (!over && hitRect && hitRect[2] - hitRect[0] < 48 && hitRect[3] - hitRect[1] < 48) {
        const [cxp, cyp] = toScreen(pos.x, pos.y);
        const edgeX = toScreen(pos.x + (modelDims.w || 1.4) * sizeScale * 0.5, pos.y)[0];
        const topY = toScreen(pos.x, pos.y + (modelDims.h || 4) * sizeScale * 0.55)[1];
        over = fallbackGrabHandle({
          cxp,
          cyp,
          edgeX,
          topY,
          innerWidth,
          innerHeight,
          cursorX: cursor.x,
          cursorY: cursor.y,
        }).over;
      }
    } else {
      // FAIL-SAFE fallback (silhouette unavailable: empty / off-screen / corrupted render). A click-
      // through overlay MUST fail toward passing clicks through, never toward blocking the desktop.
      // (1) If she does not project onto THIS window, nothing is grabbable here -> click through. This
      // is also what keeps the PEER monitors click-through while she lives on another screen — the exact
      // multi-monitor lockout. (2) Otherwise expose only a SMALL central grab handle around her body,
      // hard-capped so it can never eat the screen. Geometry lives in the pure hittest module; the
      // world->screen projection (toScreen) is the adapter here.
      const [cxp, cyp] = toScreen(pos.x, pos.y);
      const edgeX = toScreen(pos.x + (modelDims.w || 1.4) * sizeScale * 0.5, pos.y)[0];
      const topY = toScreen(pos.x, pos.y + (modelDims.h || 4) * sizeScale * 0.55)[1];
      const fb = fallbackGrabHandle({
        cxp,
        cyp,
        edgeX,
        topY,
        innerWidth,
        innerHeight,
        cursorX: cursor.x,
        cursorY: cursor.y,
      });
      over = fb.over;
      hitRect = fb.rect;
      // log once when the fallback actually exposes a handle (i.e. she projects on-screen)
      const onScreen = fb.rect[0] || fb.rect[1] || fb.rect[2] || fb.rect[3];
      if (onScreen && !_fbWarned) {
        _fbWarned = true;
        try {
          window.avatarIPC?.log?.(
            `[avatar] click-through FALLBACK (no silhouette; coverage=${fpCoverage.toFixed(2)}) -> small grab handle ${Math.round(fb.rect[2] - fb.rect[0])}x${Math.round(fb.rect[3] - fb.rect[1])}px at ${Math.round(cxp)},${Math.round(cyp)}`
          );
        } catch {}
      }
    }
    if (over !== cursor.over) {
      cursor.over = over;
      syncInteractive();
    }
  }

  // (The random idle-emote scheduler that lived here is GONE — user ruling 2026-06-11 "remove all
  // of it": NOTHING fires by itself. Emotes happen only when commanded: tap/pet, menu, bus, AI.)

  // --- float + idle (NO gravity, NO walking) ----------------------------------
  // ADAPTIVE FRAME RATE — the overlay used to redraw a near-static figure 60×/s forever (~13% of a
  // core at idle). Now we render at 60 only when something is MOVING; settle to 30, then 15 after a
  // few idle seconds. backgroundThrottling stays OFF, and the loop still ticks ≥15×/s, so she can
  // never vanish on an unfocused monitor — we just stop burning the core to redraw the same frame.
  // `wake(s)` holds full rate for s seconds after a kick (emote / drag-release / load) so spring
  // settle + emotes still look smooth.
  // The animate loop drives the seam (defined at module top) with live module state.
  const stepProcVrm = (dt) => stepProcVrmFrame(dt, { proc, facial, facialOn, spring, springOn, rig, vrm, soft });
  const FPS_ACTIVE = 60,
    FPS_IDLE = 30,
    FPS_REST = 15;
  let _frameAcc = 0,
    _restClock = 0,
    _wakeUntil = 0,
    _wasActive = false;
  let _hbLast = 0; // last click-through liveness heartbeat (ms). The arbiter in main treats a window that
  // stops reporting as a hung renderer and forces it click-through, so we re-send our CURRENT state ~1x/s
  // even when it hasn't changed — otherwise an idle-but-legit hover over her would look "stale" and drop.
  function wake(sec = 1) {
    const s = +sec;
    _wakeUntil = Math.max(_wakeUntil, performance.now() + (isFinite(s) && s > 0 ? s : 1) * 1000);
  } // a NaN here would poison every later Math.max → 15fps forever
  const PEER_FPS = 30;
  function animate() {
    requestAnimationFrame(animate); // cheap heartbeat — keeps the compositor live on every monitor
    _frameAcc += clock.getDelta();
    // Click-through liveness beat (~1x/s, brain AND peers): re-assert our current hit state so a
    // healthy idle hover stays grabbable while a HUNG renderer (no beats) gets failed open by main.
    const _now = performance.now();
    if (_now - _hbLast >= 1000) {
      _hbLast = _now;
      syncInteractive();
    }
    if (!_isBrain) {
      peerFrame();
      return;
    } // peers: mirror the brain's broadcast pose; no animation work
    const active =
      held || spinning || gliding || cursor.over || voice.isSpeaking() || ui.isOpen() || performance.now() < _wakeUntil;
    if (active && !_wasActive) fpClock = 1;
    _wasActive = active; // idle→active edge: force a fresh grab silhouette so a grab right after waking can't miss a stale mask
    const fps = pickFps(active, _restClock, FPS_ACTIVE, FPS_IDLE, FPS_REST, 6);
    if (_frameAcc < 1 / fps) return; // not time for the next frame's WORK yet (skip render, keep the heartbeat)
    const dt = Math.min(0.05, Math.max(0, _frameAcc || 0));
    _frameAcc = 0; // floor at 0 (NaN/negative would bypass the velocity clamp + freeze layer expiry)
    if (active) _restClock = 0;
    else _restClock += dt;
    // (root-motion updateMotion() removed 2026-06-25 — _motionY stays 0; the AI authors motion via layers)
    // GLIDE: the brain steps the GLOBAL position toward the target and publishes it (main re-broadcasts to
    // every window). DRAG is owned by main (it follows the OS cursor across monitors), so we don't touch
    // gPos while held — it arrives via onGlobalPos.
    if (!held && gGlide) {
      if (gGlideDur > 0 && gGlideFrom) {
        // timed glide: smoothstep from start to target over exactly gGlideDur seconds
        gGlideT += dt;
        const f = Math.min(1, gGlideT / gGlideDur);
        const e = f * f * (3 - 2 * f);
        gPos.x = gGlideFrom.x + (gGlide.x - gGlideFrom.x) * e;
        gPos.y = gGlideFrom.y + (gGlide.y - gGlideFrom.y) * e;
        if (f >= 1) {
          gGlide = null;
          gliding = false;
          gGlideDur = 0;
          gGlideFrom = null;
          floorSnap();
        }
      } else {
        const k = Math.min(1, dt * 4);
        gPos.x += (gGlide.x - gPos.x) * k;
        gPos.y += (gGlide.y - gPos.y) * k;
        if (Math.hypot(gGlide.x - gPos.x, gGlide.y - gPos.y) < 1) {
          gPos.x = gGlide.x;
          gPos.y = gGlide.y;
          gGlide = null;
          gliding = false;
          floorSnap();
        } // arrivals settle onto a nearby surface (no-op when none is within the band)
      }
      window.avatarIPC?.setGlobalPos?.(gPos.x, gPos.y);
    }
    const _bp = gToWorld(gPos.x, gPos.y);
    pos.set(_bp.x, _bp.y); // derived base (read by look/hit-test math)
    rig.position.set(_bp.x, _bp.y + _motionY, 0); // global-derived base + the local jump hop; bones/springs do the rest
    updateShadow(); // ground-contact patch under the feet (stays grounded through jumps)
    stepProcVrm(dt); // proc pose → springs → vrm.update, in the ONE order that survives the VRM humanoid copy-back (#1)
    // rigid-body props (rapier): keep the floor at the bottom of HER current monitor, track her body
    // as a collision capsule (props bounce off her), step the world.
    if (physics.count() > 0 && _gReady) {
      const fy = floorWorldY() + 0.02; // the physics floor matches the visible desk line — the same ground the contact shadow rests on
      if (_floorWY === null || Math.abs(fy - _floorWY) > 1e-3) {
        _floorWY = fy;
        physics.setFloor(fy);
      }
      const hW = (modelDims.h || BASE_H) * sizeScale,
        rr = Math.max(0.1, (modelDims.w || 1.5) * sizeScale * 0.28);
      physics.setAvatar({ x: pos.x, y: pos.y + hW * 0.5 + _motionY, halfH: Math.max(0.1, hW * 0.5 - rr), r: rr }); // capsule spanning feet→head, centred mid-body
      if (physics.step(dt)) wake(0.5); // hold full frame rate while something is in flight
    }
    // P3: advance conjured props (pop-in / glide / hover / timed-dismiss) UNCONDITIONALLY. This was
    // wrongly nested in the `physics.count() > 0` guard, so a conjured prop never animated unless a
    // rapier ball happened to be in flight — it spawned invisible (scale ~0) and stayed frozen.
    // step() early-outs cheaply when there are no props.
    if (conjurer.step(dt)) wake(0.5);
    renderer.render(scene, camera);
    if (_peerCount > 0 && window.avatarIPC?.sendPose) window.avatarIPC.sendPose(serializePose()); // → main → peer windows mirror this exact pose (skip entirely on single-monitor)
    if (_peerCount > 0 && window.avatarIPC?.sendProps) {
      // → peers render ghost balls on HER monitor (props live only in this brain scene)
      const _pn = physics.count();
      if (_pn > 0 || _lastPropN > 0) window.avatarIPC.sendProps(physics.serializeProps(pos.x, pos.y)); // n=0 buffer once when they clear → peers drop ghosts
      _lastPropN = _pn;
    }
    fpClock += dt; // refresh the grab footprint (a 2nd low-res render + readback) — less often when idle
    if (!held && fpClock > (active ? 0.16 : 0.5)) {
      fpClock = 0;
      computeFootprint();
      computeOver();
    } // re-test the hover too: she GLIDES out from under a stationary cursor, and a stale `over` keeps eating desktop clicks where she WAS
  }
  // --- peer window: a stationary mirror of the brain ---------------------------
  // A peer never animates — it derives her base from the global position, applies the brain's broadcast
  // pose, and renders its slice (the GPU clips whatever falls outside this display). It ALWAYS renders
  // (a stationary transparent window that stops drawing would show a STALE surface — the very bug this
  // rewrite exists to kill) and keeps a grab silhouette so she's draggable on this monitor too.
  function peerFrame() {
    if (_frameAcc < 1 / PEER_FPS) return;
    const dt = Math.min(0.05, Math.max(0, _frameAcc || 0));
    _frameAcc = 0; // floor at 0 (NaN/negative would bypass the velocity clamp + freeze layer expiry)
    if (model && _gReady) {
      if (_lastPose) applyPose(_lastPose);
      const _bp = gToWorld(gPos.x, gPos.y);
      pos.set(_bp.x, _bp.y);
      rig.position.set(_bp.x, _bp.y + _motionY, 0);
      updateShadow(); // peers ground her too (the mirrored half needs the same contact patch)
      applyGhosts(); // mirror the brain's physics props (the ball) onto THIS monitor
      fpClock += dt;
      if (fpClock > 0.3) {
        fpClock = 0;
        computeFootprint();
        computeOver();
      } // keep her grabbable on this monitor
    }
    renderer.render(scene, camera);
  }
  // PEER: render ghost copies of the brain's physics props (the ball) — placed relative to OUR copy of
  // her root, so they land on the monitor she's standing on and fall off-screen on the others. The ball
  // asset is lazily loaded once (only if a prop ever arrives), then cloned per prop. Single prop type
  // for now (the bundled baseball); a future multi-prop world would key the clone by an asset id.
  function applyGhosts() {
    const buf = _lastProps,
      n = buf && buf.length ? buf[0] | 0 : 0;
    if (!n && !_ghosts.length) return; // nothing to draw and nothing to hide
    if (n && !_ghostProto) {
      loadGhostProto();
      return;
    } // need the mesh first — paints next frame
    for (let i = 0; i < n; i++) {
      let g = _ghosts[i];
      if (!g) {
        g = _ghostProto.clone(true);
        scene.add(g);
        _ghosts[i] = g;
      }
      const k = 1 + i * 7;
      g.position.set(pos.x + buf[k], pos.y + buf[k + 1], 0);
      g.quaternion.set(buf[k + 2], buf[k + 3], buf[k + 4], buf[k + 5]);
      g.scale.setScalar(buf[k + 6]);
      g.visible = true;
    }
    for (let i = n; i < _ghosts.length; i++) if (_ghosts[i]) _ghosts[i].visible = false; // hide retired ghosts (e.g. after "clear balls")
  }
  function loadGhostProto() {
    if (_ghostLoading || _ghostProto) return;
    _ghostLoading = true;
    loadAsset(
      BALL_URL,
      (asset) => {
        _ghostLoading = false;
        if (!asset || !asset.scene) return;
        _ghostProto = asset.scene;
        _ghostProto.traverse((o) => {
          if (o.isMesh) o.frustumCulled = false;
        });
      },
      () => {
        _ghostLoading = false;
      }
    );
  }
  // Pack the live skeleton into a flat Float32Array: [ modelTag, motionY, rigQuat(4), rigScale(1), bone quats…, morph influences… ].
  function serializePose() {
    if (!_poseBuf || _poseBuf.length !== poseLen) return _poseBuf || new Float32Array(0);
    let k = 0;
    _poseBuf[k++] = _poseTag;
    _poseBuf[k++] = _motionY;
    const rq = rig.quaternion;
    _poseBuf[k++] = rq.x;
    _poseBuf[k++] = rq.y;
    _poseBuf[k++] = rq.z;
    _poseBuf[k++] = rq.w;
    _poseBuf[k++] = rig.scale.x;
    for (let i = 0; i < _poseBones.length; i++) {
      const q = _poseBones[i].quaternion;
      _poseBuf[k++] = q.x;
      _poseBuf[k++] = q.y;
      _poseBuf[k++] = q.z;
      _poseBuf[k++] = q.w;
    }
    for (const mesh of _poseMorphs) {
      const inf = mesh.morphTargetInfluences;
      for (let j = 0; j < inf.length; j++) _poseBuf[k++] = inf[j];
    }
    return _poseBuf;
  }
  function applyPose(buf) {
    if (!buf || !_poseBones.length || buf.length !== poseLen) return; // length mismatch (mid model-load) → skip this frame
    let k = 0;
    if (Math.abs(buf[k++] - _poseTag) > 1e-9) return; // different MODEL with a coincidentally equal layout → never apply its quats onto ours
    _motionY = buf[k++];
    rig.quaternion.set(buf[k], buf[k + 1], buf[k + 2], buf[k + 3]);
    k += 4;
    rig.scale.setScalar(buf[k]);
    sizeScale = buf[k++]; // track the live size too — the shadow width + fallback grab box read sizeScale, not rig.scale
    for (let i = 0; i < _poseBones.length; i++) {
      _poseBones[i].quaternion.set(buf[k], buf[k + 1], buf[k + 2], buf[k + 3]);
      k += 4;
    }
    for (const mesh of _poseMorphs) {
      const inf = mesh.morphTargetInfluences;
      for (let j = 0; j < inf.length; j++) inf[j] = buf[k++];
    }
  }

  // --- voice + lip-sync (speech playback + amplitude lip-sync) -----------------
  // Implementation in voice.js; wired to the live facial layer + the co-speech body envelope (P2).
  let _speechRms = 0; // smoothed live speech loudness -> co-speech body amplitude (P2)
  const voice = createVoice({
    getFacial: () => facial,
    onSpeakStart: (dur) => {
      facial?.blink?.();
      if (proc?.setLayer) proc.setLayer("cospeech", { fn: (t) => coSpeechPose(t, _speechRms) });
      wake((+dur > 0 ? +dur : 2) + 0.5);
    }, // #22/#8: blink on speech ONSET (facial no longer free-runs blinks); P2: co-speech BODY layer from the live envelope
    onEnvelope: (rms) => {
      _speechRms += (rms - _speechRms) * 0.3;
    }, // smooth the RMS so the body emphasis doesn't twitch frame-to-frame
    onSpeakEnd: () => {
      _speechRms = 0;
      if (proc?.clearLayer) proc.clearLayer("cospeech");
    },
    setStatus,
  });

  // Capture the overlay's own canvas (the avatar on transparency — NO desktop behind
  // it) to a PNG, so it can be inspected in isolation, "like in Blender". Crops tight
  // to the avatar's silhouette by default (full window with {full:true}). Pair with
  // showSkeleton(true) to capture the rig over the mesh.
  async function snapshot(opts = {}) {
    if (!window.avatarIPC || !window.avatarIPC.capture) {
      setStatus("snap unavailable (no IPC)");
      return null;
    }
    let rect = null; // she's on ANOTHER monitor → full capture of her window (this hitRect is in OUR pixels, not that window's)
    let regionUsed = null,
      regionMiss = null;
    // REGION SNAP (2026-07-03 audit): crop to a named role/bone ("head" = face close-up) instead of
    // the whole-model hitRect. The engine knows where every bone is on screen — a frame-blind driver
    // must not binary-search for the face with size/move rounds. opts.radius (world units) overrides
    // the default head-sized crop; a missing bone or off-screen region falls back to the full rect
    // and NAMES the miss in the reply.
    if (opts.region && model && onMyDisplay()) {
      const key = String(opts.region);
      let b = roleBones[key] || null; // canonical role resolves FIRST (the AI speaks roles, not per-rig names)
      if (!b)
        model.traverse((o) => {
          if (o.isBone && o.name === key) b = o;
        });
      if (!b) regionMiss = `no role/bone '${key}' on this model`;
      else {
        const v = new THREE.Vector3();
        b.getWorldPosition(v).project(camera);
        const cx = ((v.x + 1) / 2) * innerWidth,
          cy = ((1 - v.y) / 2) * innerHeight;
        const wR = +opts.radius > 0 ? +opts.radius : 0.15 * (modelDims.h || BASE_H) * sizeScale; // ~a head of her height
        const pr = Math.max(70, (wR * innerHeight) / worldH);
        const x = Math.max(0, Math.floor(cx - pr)),
          y = Math.max(0, Math.floor(cy - pr));
        const w = Math.min(Math.round(innerWidth) - x, Math.ceil(cx + pr) - x),
          h = Math.min(Math.round(innerHeight) - y, Math.ceil(cy + pr) - y);
        if (w > 8 && h > 8) {
          rect = { x, y, width: w, height: h };
          regionUsed = key;
        } else regionMiss = `region '${key}' is off-screen`;
      }
    }
    if (
      !rect &&
      !opts.full &&
      model &&
      onMyDisplay() &&
      hitRect &&
      hitRect[2] > hitRect[0] &&
      hitRect[3] > hitRect[1]
    ) {
      const pad = opts.pad ?? 48;
      const x = Math.max(0, Math.floor(hitRect[0] - pad));
      const y = Math.max(0, Math.floor(hitRect[1] - pad));
      const w = Math.min(Math.round(innerWidth) - x, Math.ceil(hitRect[2] - hitRect[0] + pad * 2));
      const h = Math.min(Math.round(innerHeight) - y, Math.ceil(hitRect[3] - hitRect[1] + pad * 2));
      if (w > 8 && h > 8) rect = { x, y, width: w, height: h };
    }
    const r = await window.avatarIPC.capture({ rect, name: opts.name });
    if (r && typeof r === "object") {
      if (regionUsed) r.region = regionUsed; // the crop the caller asked for was honored
      if (regionMiss) r.regionMiss = regionMiss; // honest: fell back to the whole-model rect, and why
    }
    if (r && r.ok) setStatus(`snap ok ${r.width}x${r.height} -> ${r.path}`);
    else setStatus("snap failed: " + (r && r.error));
    console.log("[avatar] snap:", JSON.stringify(r));
    return r;
  }

  // --- gallery thumbnails -----------------------------------------------------
  // After a real models/ model settles, capture it to models/<id>/.thumb.png so the gallery shows
  // a PICTURE (recognise by look, not by a cryptic folder name). Skips transient drag-drops and the
  // zero-asset placeholder (no models/ id), debounces, and bails if a newer model switch supersedes.
  let _thumbTimer = 0;
  function thumbRect() {
    if (!hitRect || !(hitRect[2] > hitRect[0] && hitRect[3] > hitRect[1])) return null;
    const pad = 24;
    const x = Math.max(0, Math.floor(hitRect[0] - pad));
    const y = Math.max(0, Math.floor(hitRect[1] - pad));
    const w = Math.min(Math.round(innerWidth) - x, Math.ceil(hitRect[2] - hitRect[0] + pad * 2));
    const h = Math.min(Math.round(innerHeight) - y, Math.ceil(hitRect[3] - hitRect[1] + pad * 2));
    return w > 8 && h > 8 ? { x, y, width: w, height: h } : null;
  }
  function scheduleThumb() {
    const id = (/\/models\/([^/]+)\//.exec(curKey) || [])[1];
    if (!id || !window.avatarIPC?.saveThumb) return; // transient / placeholder → no thumb
    const seq = _loadSeq,
      key = curKey;
    clearTimeout(_thumbTimer);
    const tryCapture = () => {
      if (seq !== _loadSeq || key !== curKey) return; // a newer / different model loaded → abandon this capture
      if (window.avatarIPC && !onMyDisplay()) return; // she's on ANOTHER window's display → THAT window's scheduleThumb owns the capture (every window schedules one; exactly the host fires)
      if (ui?.isOpen?.()) {
        _thumbTimer = setTimeout(tryCapture, 1200);
        return;
      } // a panel (Settings/gallery/menu) covers her → wait for a CLEAN frame, don't bake the UI into the thumb
      window.avatarIPC
        .saveThumb({ id, rect: onMyDisplay() ? thumbRect() : null }) // her window ≠ this one → full capture (our rect is the wrong pixel space there)
        .then((r) => {
          if (r && r.ok) ui?.refreshModelList?.();
          else if (r && r.error) console.warn("[avatar] gallery thumb save failed:", r.error); // cosmetic, but say so once
        })
        .catch((e) => console.warn("[avatar] gallery thumb save failed:", e));
    };
    _thumbTimer = setTimeout(tryCapture, 1400);
  }

  // --- AI control surface -----------------------------------------------------
  // The EnigmaAvatar control surface (src/control/surface.js). The facade the bus, the query
  // reporter, devtools/globals, and connect() all drive. Built HERE so the engine fns it delegates to
  // already exist; mutable state is read through live getters, and things defined LATER (ui ~3047,
  // handleCommand ~3117, the ui* relays ~2964) come in as getters too -- only ever called at runtime.
  // The single ENGINE STATE CONTAINER — one live view onto the closure's mutable state. The control
  // modules read state through it (engine.proc, engine.model, …) and receive ONE object whose
  // properties are live by construction: getters become live read accessors, statics are stable
  // in-place objects shared by reference. (Built inline here; this used to live in engine/state.js.)
  const makeEngineView = (getters = {}, statics = {}) => {
    const view = { ...statics };
    for (const k in getters) Object.defineProperty(view, k, { get: getters[k], enumerable: true, configurable: true });
    return view;
  };
  const engine = makeEngineView(
    {
      proc: () => proc,
      facial: () => facial,
      spring: () => spring,
      soft: () => soft, // soft-mesh grab/poke layer (bus stretch/poke verbs)
      model: () => model,
      vrm: () => vrm,
      sizeScale: () => sizeScale,
      held: () => held,
      modelDims: () => modelDims,
      springOn: () => springOn,
      facialOn: () => facialOn,
      locked: () => locked,
      rotateMode: () => rotateMode,
      bonesShown: () => bonesShown,
      curKey: () => curKey,
      weightMass: () => _weightMass,
      springNeverExtra: () => _springNeverExtra,
      attachObjs: () => attachObjs,
      roleBones: () => roleBones,
      platforms: () => platforms,
      curDisp: () => curDisp,
      ui: () => ui,
      handleCommand: () => handleCommand,
      aiPaused: () => !aiControlOn, // kill-switch: connect() drops inbound commands while true
      uiLoadModel: () => uiLoadModel,
      uiAttach: () => uiAttach,
      uiDetach: () => uiDetach,
      uiClearAttachments: () => uiClearAttachments,
    },
    { pos, cursor, CONJURE_ASSETS, rig }
  );

  const EnigmaAvatar = createControlSurface(engine, {
    glideTo,
    nudge,
    goTo,
    whereAmI,
    applySize,
    awaitNextLoad, // bus 'load' replies when the model is BUILT (no more guessed sleeps)
    springTune,
    facialTune,
    throwBall,
    dropBall,
    physics,
    setStatus,
    voice,
    tuneAttachment,
    showSkeleton,
    snapshot,
    allMaterialsInfo,
    recolor,
    hueShift,
    resetColors,
    profileFor,
    allMeshesInfo,
    setMeshVisible,
    setMeshLabel,
    setBoneLabel,
    setRot,
    setYaw,
    setRotAxis,
    getRot,
    springRegions,
    setRegionWeight,
    allMorphsInfo,
    setMorphValue,
    setRotateMode,
    posScreen,
    conjurer,
    resolvePropName,
    parseControlTags,
    parseTagArg,
    wake,
    onAiCommand: (action) => flashAiActivity(action), // no-surprises flash — connect() validates before calling, so only real commands reach this
  });
  // Answer a 'query' from the AI bus with LIVE ground truth — the overlay is the authority on
  // what it actually loaded (current model, facial/mouth mode, materials by index, roles).
  // Reporter lives in src/control/query.js; mutable state is read through live getters.
  const answerQuery = createQueryReporter(engine, {
    EnigmaAvatar,
    _norm360,
    getRot,
    outfitNames,
    profileFor,
    allMeshesInfo,
  });
  window.EnigmaAvatar = EnigmaAvatar;
  window.__AV = { THREE, scene, camera, rig, getModel: () => model };

  // --- multi-window wiring (monitor rewrite) ----------------------------------
  // Main owns the avatar's GLOBAL position + the display layout. This window just renders her from the
  // broadcasts and reports grabs. The old move-the-window-between-monitors machinery (placeOnDisplay,
  // drag-hop, recenter) is gone — windows are stationary, only her global position moves.
  window.avatarIPC?.onInit?.((info) => {
    if (!info) return;
    _isBrain = !!info.isBrain;
    if (info.origin) myOrigin = info.origin;
    if (info.bounds) myBounds = info.bounds;
    if (isFinite(info.refH) && info.refH > 0) _refH = info.refH; // shared px-per-world-unit reference (see frameCamera)
    _peerCount = info.peerCount || 0;
    _myWinId = info.winId ?? null; // to skip our own uiCmd echo (we already applied it)
    if (typeof info.aiControl === "boolean") aiControlOn = info.aiControl; // seed the kill-switch mirror from main's persisted authority (silent — no boot flash)
    renderer.setSize(innerWidth, innerHeight);
    frameCamera();
    setStatus(_isBrain ? "brain window ready" : "mirror window ready");
    _initSeen = true;
    maybeStart();
  });
  // Kill-switch changes pushed by main (tray click, or any window's Settings checkbox routed
  // through the authority) land on EVERY window's mirror.
  window.avatarIPC?.onAiControlChanged?.((on) => applyAiControl(on));
  let _wasDragFlag = false,
    _dragActive = false; // _dragActive: a main-owned drag is in flight (broadcast to EVERY window via p.drag) — so ANY window's pointerup can release it, even one that didn't start the grab
  // RAGDOLL GRAB (grabfollow.js): pick the limb chain nearest the grab point and set the ONE
  // transient fn() layer that aims it at the cursor + pendulums the torso. Chains are canonical
  // roles only (generic); a rig with no such limb (ryuri has no legs) simply skips the aim and
  // keeps the pendulum. Cleared on the release edge.
  const GRAB_CHAINS = [
    { pick: ["left_hand", "left_forearm", "left_arm"], aim: "left_arm" },
    { pick: ["right_hand", "right_forearm", "right_arm"], aim: "right_arm" },
    { pick: ["left_foot", "left_shin", "left_leg"], aim: "left_leg" },
    { pick: ["right_foot", "right_shin", "right_leg"], aim: "right_leg" },
  ];
  function startGrabFollow(wx, wy) {
    if (!proc?.setLayer) return;
    const roles = proc.roles();
    const flexable = new Set(proc.capabilities().flexRoles || []);
    const v = new THREE.Vector3();
    const maxD = (modelDims.h || 2) * sizeScale * 0.22; // grab must be ON the limb, body-scaled
    let aimRole = null,
      bd = maxD * maxD;
    for (const ch of GRAB_CHAINS) {
      if (!flexable.has(ch.aim) || !roles[ch.aim]) continue; // no abduction axis on this rig -> can't aim it
      for (const rn of ch.pick) {
        const b = roles[rn];
        if (!b) continue;
        b.getWorldPosition(v);
        const dx = v.x - wx,
          dy = v.y - wy,
          d2 = dx * dx + dy * dy;
        if (d2 < bd) {
          bd = d2;
          aimRole = ch.aim;
        }
      }
    }
    const S = new THREE.Vector3(),
      C = new THREE.Vector3();
    const boneChild = (b) => {
      for (const k of b.children) if (k.isBone) return k;
      return null;
    };
    proc.setLayer("grab_follow", {
      fn: createGrabFollowFn({
        aimRole,
        aimState: aimRole
          ? () => {
              const b = roles[aimRole],
                c = b && boneChild(b);
              if (!b || !c) return null;
              b.getWorldPosition(S);
              c.getWorldPosition(C);
              return { sx: S.x, sy: S.y, dx: C.x - S.x, dy: C.y - S.y };
            }
          : null,
        cursorWorld: () => (cursor.seen ? toWorld(cursor.x, cursor.y) : null),
        dragX: () => gPos.x,
        now: () => performance.now(),
      }),
    });
  }
  window.avatarIPC?.onGlobalPos?.((p) => {
    if (!p || !isFinite(p.gx) || !isFinite(p.gy)) return;
    const moved = Math.abs(p.gx - gPos.x) + Math.abs(p.gy - gPos.y) > 0.5;
    gPos.x = p.gx;
    gPos.y = p.gy;
    if (p.disp) curDisp = p.disp;
    _gReady = true;
    if (p.drag && (gGlide || gliding)) {
      gGlide = null;
      gliding = false;
    } // a main-owned drag (from ANY window) outranks an AI glide — without this the two write gPos in turn and she rubber-bands
    const df = !!p.drag;
    _dragActive = df;
    if (_isBrain && df !== _wasDragFlag) {
      _wasDragFlag = df;
      proc?.setGrip?.("both", df); // carried by the body → she grips with both hands for the ride
      if (df) {
        // GRAB-BY-WHERE-YOU-GRAB: (1) damp the sprung region under the cursor so it rides near the
        // hand instead of swinging away; (2) RAGDOLL FOLLOW — the grabbed limb aims at the cursor
        // and the torso pendulums after the drag (grabfollow.js). The brain's cursor is live for
        // its own display and ~30Hz-relayed from peers, so a grab on any monitor works.
        const gw = toWorld(cursor.x, cursor.y);
        spring?.holdNearest?.(gw.x, gw.y, (modelDims.h || 2) * sizeScale * 0.25);
        startGrabFollow(gw.x, gw.y);
      } else {
        spring?.releaseHeld?.();
        proc?.clearLayer?.("grab_follow"); // the compositor eases the aim/pendulum offsets back at the speed limits — no snap
        setTimeout(() => floorSnap(), 30); // release edge: feet ease onto a nearby PLATFORM top (screen-bottom floor snap removed 2026-06-25)
      }
    }
    if (moved && _isBrain) wake(0.6); // keep the brain (→ pose broadcast) lively while she's dragged from another monitor
  });
  window.avatarIPC?.onCursor?.((p) => {
    // a peer display's pointermove, relayed in global DIP -> OUR local px (possibly off-window)
    if (!_isBrain || !p || !isFinite(p.gx) || !isFinite(p.gy)) return;
    const [lx, ly] = dipToLocalPx(p.gx, p.gy, myOrigin, myBounds, innerWidth, innerHeight);
    cursor.x = lx;
    cursor.y = ly;
    cursor.seen = true;
  });
  let _pendingModel = null; // a relayed model that arrived before profiles finished loading
  function applyPeerModel(url) {
    if (url === "__default__") {
      if (curKey !== DEFAULT_KEY) {
        enterNoModel();
        showOnboarding();
      }
    } // #13: peer mirrors the no-model state too
    else if (url !== curKey) loadModel(url, url);
  }
  window.avatarIPC?.onModel?.((url) => {
    // peers mirror the brain's current model
    if (_isBrain || !url) return;
    if (!_preloadDone) {
      _pendingModel = url;
      return;
    } // don't resolve a rig before profiles are in
    applyPeerModel(url);
  });
  window.avatarIPC?.onPose?.((buf) => {
    _lastPose = buf;
  }); // peer: latest brain pose to mirror next frame
  window.avatarIPC?.onProps?.((buf) => {
    _lastProps = buf;
  }); // peer: latest brain prop (ball) transforms to mirror
  // (#11: the peer-tap poke chain was DELETED — there is no canned tap reaction; the AI authors any
  //  response via the compositor. The main.js/preload.js poke wiring is removed by the shell side.)

  // --- UI command relay — the menu/Settings work on ANY monitor -----------------
  // Every window builds the same menu/Settings UI (ui.js below) and opens it LOCALLY on
  // right-click; this relay keeps the N model copies + the brain's animation in agreement
  // about every MUTATION the UI / hotkeys / AI bus can make:
  //   • the initiating window applies the command immediately (sync read-back, zero lag),
  //     then main re-broadcasts it (stamped with the sender id) to every window;
  //   • each window applies relayed commands per the scope table — "all" = render state every
  //     window owns its own copy of (materials, mesh visibility, attachments, toggles), "brain" =
  //     state that already streams to peers via the pose/model broadcasts (animation, gestures,
  //     morph influences, size, model loads);
  //   • a window skips its OWN echo, so everything executes exactly once per window.
  // The AI bus (brain-only) routes its visual mutations through the same relay, so an AI recolor
  // shows up on whatever monitor she's standing on, not just the primary.
  let _myWinId = null; // this window's webContents id (from avatar:init) — to skip our own echo
  const UI_CMDS = {
    // brain-scope: peers see the result through the pose / model / scale stream
    loadModel: { scope: "brain", fn: (u, l) => loadModel(u, l) },
    // (express relay removed — body expressions were purged 2026-06-25)
    ball: { scope: "brain", fn: (n) => EnigmaAvatar.ball(n) },
    // Conjured-prop controls (user 2026-07-02: a stranded prop sat mid-screen with "nothing I can
    // do about it") — props live in the BRAIN scene, so the menu's dismiss/clear relay there.
    conjureDismiss: {
      scope: "brain",
      fn: (id) => {
        conjurer.dismiss(String(id));
        wake(1);
      },
    },
    conjureClear: {
      scope: "brain",
      fn: () => {
        conjurer.clear();
        wake(1);
      },
    },
    resizeBy: { scope: "brain", fn: (m) => resizeBy(m) },
    applySize: { scope: "brain", fn: (s) => applySize(s) },
    _rotLive: {
      scope: "brain",
      fn: (r) => {
        if (r) applyRotationTo({ x: _norm360(r.x), y: _norm360(r.y), z: _norm360(r.z) });
      },
    }, // rotate-drag preview from a peer (no persist — pointerup sends the real setRot)
    // all-scope: per-window render state — every copy applies it (the pose stream doesn't carry it).
    // bound: the command targets THIS MODEL's parts by index — mid-switch it must queue, not misfire.
    setFlag: {
      scope: "all",
      fn: (k, v) => {
        if (k in flags) flags[k] = !!v;
      },
    },
    recolor: { scope: "all", bound: true, fn: (t, hex) => recolor(t, hex) },
    hueShift: { scope: "all", bound: true, fn: (n, d) => hueShift(n, d) },
    resetColors: { scope: "all", bound: true, fn: () => resetColors() },
    setMeshVisible: { scope: "all", bound: true, fn: (i, on) => setMeshVisible(i, on) },
    setMeshLabel: { scope: "all", bound: true, fn: (i, l) => setMeshLabel(i, l) },
    setPlatforms: { scope: "all", fn: (l) => setPlatforms(l) }, // AI effect surfaces — every window draws its bars; the brain feeds the physics slabs
    saveOutfit: { scope: "all", bound: true, fn: (n) => saveOutfit(n) }, // outfit presets: every window keeps its profile copy in sync; the brain persists
    wearOutfit: { scope: "all", bound: true, fn: (n) => wearOutfit(n) },
    deleteOutfit: { scope: "all", bound: true, fn: (n) => deleteOutfit(n) },
    setBoneLabel: { scope: "all", bound: true, fn: (n, l) => setBoneLabel(n, l) },
    highlightBone: { scope: "all", bound: true, fn: (n, d) => highlightBone(n, d) }, // the marker must show on whichever monitor she's standing on
    setBoneMark: { scope: "all", bound: true, fn: (n, on) => setBoneMark(n, on) }, // Settings checkbox: pin/unpin a marker on a bone — same every-monitor rule
    setMorphValue: { scope: "all", bound: true, fn: (i, v) => setMorphValue(i, v) },
    setRot: { scope: "all", bound: true, fn: (r) => setRot(r) },
    setRotAxis: { scope: "all", bound: true, fn: (a, d) => setRotAxis(a, d) },
    setRotateMode: { scope: "all", fn: (on) => setRotateMode(on) },
    showSkeleton: { scope: "all", fn: (on) => showSkeleton(on) },
    setShadowOn: { scope: "all", fn: (v) => setShadowOn(v) },
    springTune: { scope: "all", bound: true, fn: (p) => springTune(p) },
    physicsTune: { scope: "brain", fn: (p) => physicsTune(p) }, // rapier props live in the brain's scene only
    facialTune: { scope: "all", bound: true, fn: (p) => facialTune(p) },
    setRegionWeight: { scope: "all", bound: true, fn: (r, w) => setRegionWeight(r, w) },
    attachMesh: { scope: "all", bound: true, fn: (u, o) => attachMesh(u, o) },
    detachAttachment: { scope: "all", bound: true, fn: (id) => detachAttachment(id) },
    clearAttachments: { scope: "all", bound: true, fn: () => clearAttachments() },
    tuneAttachment: { scope: "all", bound: true, fn: (id, o) => tuneAttachment(id, o) },
    __refreshModels: { scope: "all", fn: () => ui?.refreshModelList?.() }, // the model library changed (import/remove/rename) → update every window's gallery/menu
  };
  // A relayed mutation: apply here (when in scope) for instant feedback, then broadcast so the
  // other windows converge. With no IPC (browser preview / tests) it's just the local call.
  function relayed(name) {
    const c = UI_CMDS[name];
    return (...args) => {
      let r;
      if (c.scope === "all" || _isBrain) r = c.fn(...args);
      if (_peerCount > 0 && window.avatarIPC?.uiCmd) window.avatarIPC.uiCmd({ fn: name, args, key: curKey }); // key: the model this mutation was made AGAINST (see the mid-switch queue below)
      return r;
    };
  }
  // Mid-model-switch guard (audit): peers lag the brain by a full asset load. An all-scope mutation
  // relayed during that window would execute against the peer's OLD model (wrong material/mesh
  // index) and the NEW model's copy would permanently miss it. Queue mismatched commands and apply
  // them when OUR copy catches up to that model.
  let _staleCmds = [];
  function _runUiCmd(cmd) {
    const c = UI_CMDS[cmd.fn];
    if (!c) return;
    try {
      c.fn(...(Array.isArray(cmd.args) ? cmd.args : []));
    } catch (err) {
      console.error("[avatar] relayed " + cmd.fn + " failed:", err);
    }
  }
  window.avatarIPC?.onUiCmd?.((cmd) => {
    if (!cmd || cmd.src === _myWinId) return; // our own echo — already applied
    const c = UI_CMDS[cmd.fn];
    if (!c) return;
    if (c.scope === "brain" && !_isBrain) return;
    if (c.bound && cmd.key && cmd.key !== curKey) {
      if (_staleCmds.length < 64) _staleCmds.push(cmd);
      return;
    }
    _runUiCmd(cmd);
  });
  // Relayed handles shared by the createUI api, the bus's visual mutations, and the hotkeys.
  const uiLoadModel = relayed("loadModel"),
    uiSetRot = relayed("setRot"),
    uiSetRotAxis = relayed("setRotAxis");
  const uiConjureDismiss = relayed("conjureDismiss"),
    uiConjureClear = relayed("conjureClear");
  const uiResizeBy = relayed("resizeBy"),
    uiApplySize = relayed("applySize"),
    uiRotLive = relayed("_rotLive");
  const uiShowSkeleton = relayed("showSkeleton"),
    uiRecolor = relayed("recolor"),
    uiHueShift = relayed("hueShift");
  const uiResetColors = relayed("resetColors"),
    uiSetMeshVisible = relayed("setMeshVisible"),
    uiSetMorphValue = relayed("setMorphValue");
  const uiSetBoneLabel = relayed("setBoneLabel"); // name a bone — Settings input + the bus 'nameBone' action share this relay
  const uiHighlightBone = relayed("highlightBone"); // flash a marker on a bone — the bus's point-at-a-part
  const uiSetBoneMark = relayed("setBoneMark"); // pin/unpin a bone marker — the Settings "see it" checkboxes
  const uiSaveOutfit = relayed("saveOutfit"),
    uiWearOutfit = relayed("wearOutfit"),
    uiDeleteOutfit = relayed("deleteOutfit"); // outfit presets (Settings → Parts + bus 'outfit')
  const uiSetPlatforms = relayed("setPlatforms"); // AI platforms (bus 'platform')
  const uiSetRegionWeight = relayed("setRegionWeight"),
    uiSetRotateMode = relayed("setRotateMode");
  // attachMesh generates ids from a per-window counter — relayed calls must carry ONE id picked by
  // the initiator, or a window created mid-session (display plugged in) would number its copies
  // differently and a later relayed detach(id) would silently miss there.
  const _uiAttachRaw = relayed("attachMesh");
  const uiAttach = (u, o) =>
    _uiAttachRaw(u, { ...(o || {}), id: (o && o.id) || "a" + Math.random().toString(36).slice(2, 9) });
  const uiDetach = relayed("detachAttachment"),
    uiClearAttachments = relayed("clearAttachments"),
    uiTuneAttachment = relayed("tuneAttachment");
  const uiSpringTune = relayed("springTune"),
    uiPhysicsTune = relayed("physicsTune"),
    uiFacialTune = relayed("facialTune");
  // Settings checkboxes write the engine toggles through here → mirrored to every window (locked /
  // rotate-mode gate POINTER handling per window; the rest gate the brain's animation loop).
  const relayFlags = {};
  {
    const _setFlag = relayed("setFlag");
    for (const k of ["springOn", "facialOn", "locked"])
      Object.defineProperty(relayFlags, k, {
        get: () => flags[k],
        set: (v) => {
          _setFlag(k, v);
        },
      });
  }

  // --- UI: right-click menu + Settings dialog (DOM built in ui.js) -------------
  // NO bundled built-in models (copyright) — the model list comes ENTIRELY from the live folder scan
  // (avatarIPC.listModels). This stays an empty seed / browser-fallback list.
  const BUILTIN_MODELS = [];
  let ui; // the menu/Settings UI (ui.js) — created just below, once the engine fns it calls exist
  const syncInteractive = () =>
    window.avatarIPC?.setInteractive?.({ over: cursor.over || held, uiOpen: ui?.isOpen() ?? false });
  // The avatarIPC handed to the UI: library mutations (import/remove/rename) already route through
  // main, but the OTHER windows' galleries must learn the library changed — broadcast a refresh.
  const uiIPC = window.avatarIPC
    ? Object.assign({}, window.avatarIPC, {
        importModel: async () => {
          const r = await window.avatarIPC.importModel();
          if (r && r.url) relayed("__refreshModels")();
          return r;
        },
        importDropped: async (p) => {
          const r = await window.avatarIPC.importDropped(p);
          if (r && r.url) relayed("__refreshModels")();
          return r;
        },
        removeModel: async (id) => {
          const r = await window.avatarIPC.removeModel(id);
          if (r && r.ok) relayed("__refreshModels")();
          return r;
        },
        renameModel: async (id, l) => {
          const r = await window.avatarIPC.renameModel(id, l);
          if (r && r.ok) relayed("__refreshModels")();
          return r;
        },
      })
    : null;

  // Build the menu/Settings UI (ui.js) and wire it to engine state + actions. It owns its own
  // DOM + open/close state; everything it touches comes through this api object. Mutations are
  // the RELAYED handles above, so the menu works identically on every monitor's window.
  ui = createUI({
    THREE,
    BASE_H,
    rig,
    avatarIPC: uiIPC,
    setStatus,
    baseName,
    kindOf,
    profileFor,
    flags: relayFlags,
    builtinModels: BUILTIN_MODELS,
    getCurKey: () => curKey,
    getAttachObjs: () => attachObjs,
    getBonesShown: () => bonesShown,
    getShadowOn: () => shadowOn,
    setShadowOn: relayed("setShadowOn"), // ground-contact shadow toggle (Settings)
    getAiControl: () => aiControlOn,
    setAiControl: (v) => setAiControl(v), // AI-control kill-switch (Settings checkbox; NOT relayed — brain-only)
    loadModel: uiLoadModel,
    attachMesh: uiAttach,
    detachAttachment: uiDetach,
    clearAttachments: uiClearAttachments,
    // (express binding removed — body expressions were purged 2026-06-25; the Express menu is gone too)
    ball: relayed("ball"), // rapier ball-physics toys (throw/drop/clear) for the right-click "Ball" menu
    conjureIds: () => conjurer.ids(), // live conjured props (brain window; peers honestly list none)
    conjureDismiss: uiConjureDismiss,
    conjureClear: uiConjureClear, // manual escape hatch — a stranded prop is no longer bus-only
    showSkeleton: uiShowSkeleton,
    recolor: uiRecolor,
    hueShift: uiHueShift,
    springTune: uiSpringTune,
    physicsTune: uiPhysicsTune,
    tuneAttachment: uiTuneAttachment,
    resetColors: uiResetColors,
    materials: () => EnigmaAvatar.materials(), // parts BY INDEX (+name/mesh hints, +current hex) for the Settings color list
    rigVerdict: () => {
      // ONE honest line: what the cascade decided for THIS model, at a glance (Settings shows it —
      // "is a repair worth it?" without opening devtools). Model-zoo follow-up 2026-07-02.
      if (!model) return "";
      const n = Object.keys(roleBones).length;
      if (!n) return "static: no recognised body bones (props / statues stay honest)";
      const parts = [`${n}/19 driven`];
      const un = _rigReport?.unresolved || [];
      if (un.length) parts.push("missing: " + un.join(", "));
      if (facial) parts.push("face: " + facial.mode);
      parts.push((spring?.count || 0) + " spring bones");
      return parts.join("   ·   ");
    },
    meshes: () => EnigmaAvatar.meshes(),
    setMeshVisible: uiSetMeshVisible, // sub-objects (show/hide) for Settings
    setMeshLabel: relayed("setMeshLabel"), // rename a part (legible Settings list)
    bones: () => EnigmaAvatar.bones(),
    setBoneLabel: relayed("setBoneLabel"), // name bones (Settings → Bones)
    highlightBone: uiHighlightBone,
    setBoneMark: uiSetBoneMark, // Settings → Bones checkbox: ✓ = marker rides that bone until unchecked
    boneMarks: () => boneMarks(), // which bones are currently marked (checkbox state across re-renders)
    outfits: () => outfitNames(),
    saveOutfit: uiSaveOutfit,
    wearOutfit: uiWearOutfit,
    deleteOutfit: uiDeleteOutfit, // one-click looks (Settings → Parts)
    setRotAxis: uiSetRotAxis,
    setRot: uiSetRot,
    getRot: () => getRot(), // 3-axis rotation for Settings
    signed180, // 0..360 storage -> signed (-180,180] for the Settings fields, so the user can rotate either direction
    setYaw: (deg) => uiSetRotAxis("y", deg),
    getYaw: () => getRot().y, // back-compat (Y axis only)
    getRotateMode: () => rotateMode,
    setRotateMode: uiSetRotateMode, // drag-to-spin: a Settings toggle (auto-disarmed on panel close) + Alt+drag + AI/bus
    springRegions: () => springRegions(),
    setRegionWeight: uiSetRegionWeight, // per-area jiggle weights for Settings
    morphs: () => allMorphsInfo(),
    setMorphValue: uiSetMorphValue, // shape-key sliders for Settings
    renameModel: (id, label) => uiIPC?.renameModel?.(id, label), // gallery model rename → manifest label (+ refresh broadcast)
    // Model repair (in-Settings editor): live role resolution + the file-repair backend.
    getRoleInfo: () => ({
      matched: proc ? proc.matched.length : 0,
      total: ROLES.length,
      missing: proc ? ROLES.filter((r) => !proc.matched.includes(r)) : ROLES.slice(),
    }),
    diagnoseModel: (id) => uiIPC?.diagnoseModel?.(id),
    repairModel: (opts) => uiIPC?.repairModel?.(opts),
    syncInteractive,
  });

  // AI bus command registry (src/control/bus.js). Built HERE — after the control surface, the ui
  // object, and the ui* relays all exist — so the handlers' references resolve. Mutable engine state
  // (facial/spring/springOn/bonesShown/rotateMode/platforms/curDisp are reassigned over the avatar's
  // life) is passed as live getter thunks, never frozen, so a handler always sees current truth.
  const { handleCommand } = createBusRegistry(engine, {
    EnigmaAvatar,
    ui,
    wake,
    getRot,
    answerQuery,
    uiAttach,
    uiDetach,
    uiClearAttachments,
    uiTuneAttachment,
    uiSpringTune,
    uiFacialTune,
    uiShowSkeleton,
    uiRecolor,
    uiResetColors,
    uiSetMeshVisible,
    uiSetRot,
    uiSetRotAxis,
    uiSetRegionWeight,
    uiSetMorphValue,
    uiSetRotateMode,
    uiSetBoneLabel,
    uiHighlightBone,
    uiDeleteOutfit,
    uiSaveOutfit,
    uiWearOutfit,
    uiSetPlatforms,
    uiHueShift,
  });
  addEventListener("contextmenu", (e) => {
    // works in EVERY window — the menu opens where she was clicked; mutations relay
    if (ui.containsEvent(e.target)) {
      e.preventDefault();
      return;
    }
    cursor.x = e.clientX;
    cursor.y = e.clientY;
    computeOver();
    if (cursor.over) {
      e.preventDefault();
      ui.hideSettings();
      ui.showMenu(e.clientX, e.clientY);
    }
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      ui.hideMenu();
      ui.hideSettings();
      ui.hideGallery();
    }
  });

  // --- input (drag to reposition; NO hand cursor; NO fall) --------------------
  addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    frameCamera();
  }); // windows are stationary now; this only fires on (re)creation
  addEventListener(
    "wheel",
    (e) => {
      if (cursor.over) uiResizeBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    },
    { passive: true }
  ); // works on any monitor — size applies on the brain, streams back via the pose scale
  let _curSent = 0,
    _beatSent = 0;
  addEventListener("pointermove", (e) => {
    cursor.x = e.clientX;
    cursor.y = e.clientY;
    cursor.seen = true;
    computeOver(); // recompute hover/grab state for the new cursor position
    if (!_isBrain && window.avatarIPC?.cursorMoved) {
      // relay to the brain (~30Hz) so she watches the cursor on THIS monitor too
      const now = performance.now();
      if (now - _curSent > 33) {
        _curSent = now;
        const g = localPxToGlobal(e.clientX, e.clientY);
        window.avatarIPC.cursorMoved(g.x, g.y);
      }
    }
    if (spinning) {
      // drag-to-rotate (↔ yaw, ↕ pitch) — any window
      if (!(e.buttons & 1)) {
        spinning = false;
        uiSetRot(_spinTo(e));
        window.avatarIPC?.dragEnd?.();
        return;
      } // missed a pointerup (released off-window) → commit + stop + end the spin hold
      spinLive(e);
    }
    if (held || spinning) {
      // GRAB drag / spin hold: heartbeat so main knows our capture is alive
      const now = performance.now(); // (its watchdog ends the session if cursor moves continue beat-less)
      if (now - _beatSent > 40) {
        _beatSent = now;
        window.avatarIPC?.dragBeat?.();
      }
    }
  });
  addEventListener("pointerdown", (e) => {
    if (ui.containsEvent(e.target)) return; // clicking a popup's own controls
    cursor.x = e.clientX;
    cursor.y = e.clientY;
    computeOver();
    ui.hideMenu(); // the right-click menu always dismisses on an outside click
    if (cursor.over) {
      ui.hideGallery();
      if (!locked) {
        if (e.altKey || rotateMode) {
          // ALT+drag rotates (↔ yaw, ↕ pitch) — any window. A held MODE hijacked the primary gesture ("can't move her, can rotate"; 2026-06-11) → a modifier can't get stuck; rotateMode remains for deliberate AI/bus use.
          spinning = true;
          _spinX = cursor.x;
          _spinY = cursor.y;
          _spinRot = getRot();
          window.avatarIPC?.dragStart?.(0, 0, true); // register the spin HOLD with main → arbiter freezes on this window (capture survives bezels; no position follow)
        } else {
          // GRAB: main drives her global position from the OS cursor until release → seamless across monitors
          held = true;
          const g = localPxToGlobal(cursor.x, cursor.y);
          window.avatarIPC?.dragStart?.(g.x - gPos.x, g.y - gPos.y); // grab offset in DIP → she stays pinned under the cursor across the bezel
          gGlide = null;
          gliding = false;
        }
      }
    } else {
      ui.hideSettings();
      ui.hideGallery(); // clicking empty space dismisses the working panels (any window)
    }
  });
  addEventListener("pointerup", (e) => {
    if (spinning) {
      spinning = false;
      uiSetRot(_spinTo(e));
      window.avatarIPC?.dragEnd?.();
      wake(2);
      return;
    } // commit the dragged rotation (persists + re-scans silhouette) + end the spin hold; hold full rate so the hair settles
    if (held || _dragActive) window.avatarIPC?.dragEnd?.(); // release the main-owned drag — even one that STARTED on another monitor's window (a cross-bezel release never reaches the grabber → stuck to the cursor)
    // (#11: the peer-tap poke send was DELETED — a tap has no canned reaction; nothing to route to the brain.)
    held = false;
    fpClock = 1;
    wake(2);
  });
  // Win+L / UAC / pointer-capture loss mid-drag: pointerup never arrives — release the main-owned
  // drag explicitly, or she stays glued to the cursor after unlock. Sent as a CANCEL: main honors
  // it only from the grab window (a cancel from any other window is spurious bezel noise).
  const _abortInput = () => {
    if (held) {
      window.avatarIPC?.dragEnd?.("cancel");
      held = false;
      fpClock = 1;
    }
    if (spinning) {
      spinning = false;
      window.avatarIPC?.dragEnd?.("cancel");
    }
  };
  addEventListener("pointercancel", _abortInput);
  addEventListener("blur", _abortInput);
  // Arrow nudge from ANY window: the brain glides locally (eased); a peer can't run the glide step,
  // so it routes through main's immediate nudge (the previously-orphaned avatar:nudge channel).
  const kNudge = (dx, dy) => {
    if (_isBrain) nudge(dx, dy);
    else window.avatarIPC?.nudge?.(dx, dy);
  };
  addEventListener("keydown", (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || "")) return; // typing in a Settings field (hex / rename) must NOT fire h/b/1-9/arrow hotkeys
    if (e.key.toLowerCase() === "h") document.getElementById("ui")?.classList.toggle("hidden");
    else if (e.key.toLowerCase() === "b")
      uiShowSkeleton(!bonesShown); // toggle the skeleton overlay (explicit value → every window flips in lockstep)
    else if (e.key === "+" || e.key === "=") uiResizeBy(1.1);
    else if (e.key === "-" || e.key === "_") uiResizeBy(1 / 1.1);
    else if (e.key === "0")
      uiApplySize(DEFAULT_SIZE); // reset — same value as the menu's Size → Reset
    else if (e.key === "ArrowLeft")
      kNudge(-0.33, 0); // glide across the screen (when focused; also Ctrl+Shift+Alt+arrows globally)
    else if (e.key === "ArrowRight") kNudge(0.33, 0);
    else if (e.key === "ArrowUp") kNudge(0, 0.2);
    else if (e.key === "ArrowDown") kNudge(0, -0.2);
    else if (/^[1-9]$/.test(e.key)) {
      const m = (ui?.getModels?.() || [])[+e.key - 1];
      if (m) uiLoadModel(m.url, m.label);
    } // number keys 1–9 load the Nth model in the library (cached list — no per-keypress fs scan / race)
  });
  function loadFile(file) {
    // single file (self-contained .glb/.vrm/.fbx)
    const url = URL.createObjectURL(file);
    const seq = ++_loadSeq; // same last-caller-wins guard as loadModel — a slow drop must not clobber a newer gallery pick
    loadAsset(
      url,
      (a) => {
        URL.revokeObjectURL(url);
        if (seq !== _loadSeq) return; // superseded while parsing
        curKey = file.name;
        onModelLoaded(a);
        clearOnboarding();
      }, // commit curKey only on SUCCESS — a failed load must not misroute saves/queries onto a phantom
      (err) => {
        URL.revokeObjectURL(url);
        if (seq !== _loadSeq) return;
        setStatus(`load failed: ${err?.message || err}`);
      },
      { kind: kindOf(file.name) }
    );
  }
  function loadFiles(fileList) {
    // drag-drop: 1 file, or .gltf + .bin + textures together
    const files = [...fileList];
    if (files.length <= 1) {
      if (files[0]) loadFile(files[0]);
      return;
    }
    const main = files.find((f) => /\.(gltf|glb|vrm|fbx)$/i.test(f.name)) || files[0];
    const map = {};
    const urls = [];
    for (const f of files) {
      const u = URL.createObjectURL(f);
      map[f.name] = u;
      urls.push(u);
    } // resolve refs by basename
    // revoke late: FBX kicks off texture loads asynchronously after onLoad, so don't
    // pull the blob URLs out from under them. (Page unload frees them regardless.)
    const cleanup = () => setTimeout(() => urls.forEach(URL.revokeObjectURL), 20000);
    const seq = ++_loadSeq; // last-caller-wins, same as loadFile
    loadAsset(
      map[main.name],
      (a) => {
        cleanup();
        if (seq !== _loadSeq) return; // superseded while parsing
        curKey = main.name;
        onModelLoaded(a);
        clearOnboarding();
      }, // commit curKey only on SUCCESS
      (err) => {
        cleanup();
        if (seq !== _loadSeq) return;
        setStatus(`load failed: ${err?.message || err}`);
      },
      { kind: kindOf(main.name), blobMap: map }
    );
  }
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", (e) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    // Electron exposes a real .path on dropped files → copy into models/ (a PERMANENT add, in the
    // gallery next launch). Browser/no-path → fall back to a transient blob load (this session only).
    const paths = [...files].map((f) => f.path).filter(Boolean);
    if (paths.length && window.avatarIPC?.importDropped) {
      setStatus("adding dropped model ...");
      window.avatarIPC
        .importDropped(paths)
        .then((res) => {
          if (!res || res.error || !res.url) {
            setStatus("add failed (" + (res?.error || "?") + ") - loading temporarily");
            loadFiles(files);
            return;
          }
          relayed("__refreshModels")(); // every window's gallery learns the new model
          uiLoadModel(res.url, res.label); // a drop on ANY window loads it everywhere (brain loads → peers mirror)
        })
        .catch(() => loadFiles(files));
    } else {
      loadFiles(files);
    }
  });

  // --- go ---------------------------------------------------------------------
  applySize(sizeScale);
  animate();
  // Start once we know our ROLE (init from main) AND the profiles/list are loaded. Only the
  // BRAIN resolves + loads the first model and joins the AI bus — peers wait for main's avatar:model
  // (else every window would execute every bus command N times, and N windows would race the gallery).
  let _preloadDone = false,
    _initSeen = false,
    _started = false;
  function maybeStart() {
    if (_started || !_preloadDone || !_initSeen) return;
    _started = true;
    if (_isBrain) {
      startup();
      if (window.avatarIPC) EnigmaAvatar.connect();
    } // brain: load the model + drive the bus
    // peers: idle until main broadcasts avatar:model (onModel handler loads it)
  }
  Promise.allSettled([loadProfiles(), ui.refreshModelList()]).then(() => {
    _preloadDone = true;
    maybeStart();
    if (_pendingModel && !_isBrain) {
      const u = _pendingModel;
      _pendingModel = null;
      applyPeerModel(u);
    } // the model relay that raced our preload
  });
  function startup() {
    const seq = ++_loadSeq;
    const placeholder = () => {
      if (seq !== _loadSeq) return;
      console.warn("[avatar] no usable model -> no-model state (add a .glb)");
      enterNoModel();
      showOnboarding();
    }; // #13: inert marker + DOM message, not a self-made character
    const tryLoad = (url, label) => {
      if (seq !== _loadSeq) return; // a user keypress already loaded something → don't override it
      setStatus(`loading ${label || url} ...`);
      loadAsset(
        url,
        (asset) => {
          if (seq === _loadSeq) {
            curKey = url;
            onModelLoaded(asset);
            clearOnboarding();
          }
        }, // set curKey only on a WINNING load (no clobber if superseded mid-startup)
        () => placeholder()
      );
    };
    if (FORCED_MODEL) {
      tryLoad(FORCED_MODEL, FORCED_MODEL);
      return;
    } // ?model=<url> override
    // No hard-coded default → reuse the list refreshModelList ALREADY fetched (no 2nd folder scan):
    // the LAST model the user had (if still installed), else the first, else the procedural avatar.
    const models = ui?.getModels?.() || [];
    let last = null;
    try {
      last = localStorage.getItem(LAST_MODEL_KEY);
    } catch {}
    const pick = (last && models.find((m) => m.url === last)) || models[0];
    if (pick) {
      tryLoad(pick.url, pick.label);
      return;
    }
    placeholder(); // first run / empty library → procedural avatar…
    setTimeout(() => {
      try {
        ui?.showGallery?.();
      } catch {}
    }, 400); // …and pop the model gallery so they can add / choose one right away
  }

  // The AI bus connection (EnigmaAvatar.connect) is started in maybeStart() — and ONLY on the brain
  // window, so a multi-monitor set doesn't execute every bus command once per window. See enigma-avatar/bus.py.
} // end browser-runtime bootstrap (skipped under node --test; see the import-safety guard at the top)
