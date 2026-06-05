// Enigma Avatar — engine (FLOATING desktop companion).
// Loads any rigged glTF/GLB/VRM; plays its clips or a gentle procedural idle.
// It FLOATS anywhere on screen (no gravity / no walking) — drag to reposition
// (it stays), scroll to resize (remembered per-model). Spring-bone physics
// (hair/tail) and AI expression control are layered on top of this.
// NOTE: software-WebGL previews can't render skinned meshes — use a real browser.

import * as THREE from "three";
import { VRMUtils } from "@pixiv/three-vrm";
import { loadAsset, kindOf, baseName } from "./loader.js";
import { createVoice } from "./voice.js";
import { createUI } from "./ui.js";
import { buildProceduralRig } from "./procedural.js";
import { buildSpringBones } from "./spring.js";
import { buildFacial } from "./facial.js";
import { resolveRig } from "./rig.js";
import { buildDefaultAvatar } from "./default_avatar.js";

const params = new URLSearchParams(location.search);
const MODELS = {
  "1": "./models/roxanne_wolf/scene.gltf",
  "2": "./models/toothless/scene.gltf",
  "3": "./models/glados/scene.gltf",
};
const DEFAULT_MODEL = params.get("model") || MODELS["1"];
const DEFAULT_KEY = "__default__";     // synthetic curKey for the zero-asset procedural placeholder (no /models/ path, no override)

const VIEW_H = 10;     // world units spanning screen height (ortho)
const BASE_H = 6;      // avatar world height at sizeScale 1
const statusEl = document.getElementById("status");
const setStatus = (m) => { if (statusEl) statusEl.textContent = m; console.log("[avatar]", m); };

// --- renderer / ortho camera ------------------------------------------------
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x445, 3.0));
scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const key = new THREE.DirectionalLight(0xffffff, 2.5); key.position.set(1, 2, 3); scene.add(key);

let worldW = 10, worldH = 10;
const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, -100, 100);
camera.position.set(0, 0, 10);
function frameCamera() {
  const aspect = innerWidth / innerHeight;
  worldH = VIEW_H; worldW = VIEW_H * aspect;
  camera.left = -worldW / 2; camera.right = worldW / 2; camera.top = worldH / 2; camera.bottom = -worldH / 2;
  camera.updateProjectionMatrix();
}
frameCamera();

const toWorld = (px, py) => new THREE.Vector2((px / innerWidth - 0.5) * worldW, (0.5 - py / innerHeight) * worldH);
const _p = new THREE.Vector3();
const toScreen = (wx, wy) => { _p.set(wx, wy, 0).project(camera); return [(_p.x * 0.5 + 0.5) * innerWidth, (-_p.y * 0.5 + 0.5) * innerHeight]; };

// --- model / animation ------------------------------------------------------
// Multi-format asset loading (glTF/GLB · VRM · FBX, spec-gloss compat, FBX material
// re-binding) lives in loader.js. loadAsset(url, onOk, onErr, opts) hands back a
// normalized { scene, animations, vrm }.
const clock = new THREE.Clock();
const _box = new THREE.Box3();
const rig = new THREE.Group(); scene.add(rig);

let proc = null, spring = null, facial = null, BONE_LIMITS = {};
let boneHelper = null;                          // SkeletonHelper overlay — inspect the rig (every bone, named or not)
const BONES_KEY = "enigmaAvatar.showBones";
let bonesShown = (() => { try { return localStorage.getItem(BONES_KEY) === "1"; } catch { return false; } })();
fetch("./bone_limits.json").then((r) => r.json()).then((j) => (BONE_LIMITS = j)).catch(() => {});
// Per-model bone-role overrides (rig.js tier 4), keyed by model URL. A future
// mis-identified rig is a 1-line edit here — never a code/regex change.
let rigOverrides = {};
function loadRigOverrides() { return fetch("./rig_overrides.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) rigOverrides = j; }).catch(() => {}); }

let model = null, mixer = null, vrm = null;
let actions = {}, current = null, clipIdle = null;
let modelDims = { w: 1, h: 2 };               // scaled model bbox (for the hit region)

// --- float state + per-model size -------------------------------------------
const pos = new THREE.Vector2(0, -1.5);       // avatar base position on the screen plane (floats here)
const glideT = new THREE.Vector2(0, -1.5);    // smooth-move target (arrow keys / moveTo glide toward here)
let gliding = false;
function _clampScreen(v) {                     // keep the avatar's base on-screen (with a margin)
  const mx = worldW / 2 - 0.6, my = worldH / 2 - 0.4;
  v.x = Math.max(-mx, Math.min(mx, v.x)); v.y = Math.max(-my, Math.min(my, v.y)); return v;
}
function glideTo(px, py) { glideT.copy(_clampScreen(toWorld(px, py))); gliding = true; }
function nudge(dxFrac, dyFrac) {               // move by a fraction of screen W/H (x right+, y up+), smoothly
  const b = gliding ? glideT : pos;
  glideT.set(b.x + (dxFrac || 0) * worldW, b.y + (dyFrac || 0) * worldH); _clampScreen(glideT); gliding = true;
}
let held = false;
const cursor = { x: -1, y: -1, over: false };
const grab = new THREE.Vector2();
const DEFAULT_SIZE = 0.5;                       // first-run size (a sensible default); after that it remembers the last-used size
const SIZE_KEY = "enigmaAvatar.sizes";
const sizeByModel = (() => { try { return JSON.parse(localStorage.getItem(SIZE_KEY)) || {}; } catch { return {}; } })();  // per-model size, persisted across launches
let curKey = DEFAULT_MODEL;
let sizeScale = sizeByModel[curKey] ?? DEFAULT_SIZE;   // reopen at the last-used size for this model
let springOn = true, idleOn = true, facialOn = true, locked = false;   // engine toggles (Settings checkboxes)
let lookOn = true, idleBehaviorOn = true;                       // companion behaviors: track cursor + occasional emotes
// Accessor bridge so ui.js (Settings checkboxes) can read/write these toggles. Their
// source of truth stays here — the animate loop reads the raw `let`s directly.
const flags = {
  get springOn() { return springOn; }, set springOn(v) { springOn = v; },
  get idleOn() { return idleOn; }, set idleOn(v) { idleOn = v; },
  get lookOn() { return lookOn; }, set lookOn(v) { lookOn = v; },
  get idleBehaviorOn() { return idleBehaviorOn; }, set idleBehaviorOn(v) { idleBehaviorOn = v; },
  get facialOn() { return facialOn; }, set facialOn(v) { facialOn = v; },
  get locked() { return locked; }, set locked(v) { locked = v; },
};
const LOOK = { gainX: 1.4, gainY: 1.0, flipX: 1, flipY: -1, maxX: 0.6, maxY: 0.35 };  // cursor-look feel (flip signs per rig)
let _lookX = 0, _lookY = 0, _lookW = 0, _cursorIdle = 99;       // smoothed look state
let _idleClock = 0, _idleNext = 9, _downX = -999, _downY = 0;   // idle-emote timer + click/pet detection
const _clampN = (v, a, b) => (v < a ? a : v > b ? b : v);
const IDLE_EMOTES = ["nod", "happy", "alert", "wag"];

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
function applySize(s) {
  sizeScale = Math.max(0.02, s || 0.02);   // no upper cap (removed min/max); tiny floor so multiplicative resize can recover
  rig.scale.setScalar(sizeScale);
  sizeByModel[curKey] = sizeScale;
  try { localStorage.setItem(SIZE_KEY, JSON.stringify(sizeByModel)); } catch {}   // remember this size for next launch
  setStatus(`size ×${sizeScale.toFixed(2)}`);
}
const resizeBy = (m) => applySize(sizeScale * m);
// Keep the avatar fitting the screen: a too-large saved size makes the head/feet clip
// off the top/bottom — and on a SMALLER monitor that reads as "can't see the avatar".
// Shrinks an over-tall avatar to a margin-safe height; never enlarges (respects smaller sizes).
function fitToScreen() {
  const h = (modelDims.h || BASE_H) * sizeScale;       // current world-space height
  const maxH = worldH * 0.6;                           // leave head + feet margin (head clears camTop at pos.y -1.5)
  if (h > maxH && isFinite(maxH) && h > 0) applySize(sizeScale * (maxH / h));
}

function clipNames() { return Object.keys(actions); }
function findClip(re) { for (const n of Object.keys(actions)) if (re.test(n)) return n; return null; }
function playAction(action, { loop = true, fade = 0.3, onDone = null } = {}) {
  if (!action) return false;
  action.loop = loop ? THREE.LoopRepeat : THREE.LoopOnce; action.clampWhenFinished = !loop;
  action.reset().fadeIn(fade).play();
  if (current && current !== action) current.fadeOut(fade);
  current = action;
  if (!loop && onDone && mixer) { const h = (e) => { if (e.action === action) { mixer.removeEventListener("finished", h); onDone(); } }; mixer.addEventListener("finished", h); }
  return true;
}

function disposeModel() {
  if (!model) return;
  voice.stop();                                   // stop any in-flight speech/lip-sync before tearing down the model
  if (boneHelper) { scene.remove(boneHelper); boneHelper.geometry?.dispose?.(); boneHelper.material?.dispose?.(); boneHelper = null; }
  rig.remove(model);
  if (vrm) VRMUtils.deepDispose?.(vrm.scene);
  model.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
  model = null; mixer = null; vrm = null; proc = null; spring = null; actions = {}; current = null; clipIdle = null;
}

function onModelLoaded(asset) {
  disposeModel();
  model = asset.scene;
  if (!model) { setStatus("load failed: no scene"); return; }
  vrm = asset.vrm || null;
  _box.setFromObject(model);
  const w0 = _box.max.x - _box.min.x, h0 = _box.max.y - _box.min.y;
  let s = BASE_H / (h0 || 1);
  if (w0 * s > worldW * 0.85) s = (worldW * 0.85) / w0;   // cap width so wide models (GLaDOS) fit
  model.scale.setScalar(s);
  _box.setFromObject(model);
  const c = _box.getCenter(new THREE.Vector3());
  model.position.x -= c.x; model.position.z -= c.z; model.position.y -= _box.min.y;  // feet at rig origin
  model.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  rig.add(model);
  modelDims = { w: _box.max.x - _box.min.x, h: _box.max.y - _box.min.y };
  sizeScale = sizeByModel[curKey] ?? DEFAULT_SIZE;        // remember size per model (persisted)
  rig.scale.setScalar(sizeScale);
  fitToScreen();                                          // correct a too-large saved size so she isn't clipped off-screen

  actions = {};
  const clips = asset.animations || [];
  if (clips.length) {                             // keep the baked clips, but DON'T auto-play them — baked-anim
    mixer = new THREE.AnimationMixer(model);       // models (mangle/lolbit/51dc) must act like the REST of the
    for (const cl of clips) actions[cl.name] = mixer.clipAction(cl);   // models: driven by the procedural rig.
  }
  clipIdle = null;                                // default idle = PROCEDURAL for EVERY model (uniform behaviour)
  // The procedural rig drives idle + look-at + emotes + AI bone control the SAME
  // way on all models, so a model never just loops its own canned animation. Baked
  // clips stay callable on demand via play()/loop() — the AI can still trigger a
  // model's own animation deliberately, but it never hijacks the default idle.
  // This is the uniform substrate the AI drives on top of ("full body, like a car").
  // Identify bones ONCE via the cascade (VRM → name → geometry → override), then feed
  // BOTH the procedural idle and the spring physics the same resolved map.
  const resolved = resolveRig(model, vrm, { override: rigOverrides[curKey] });
  proc = buildProceduralRig(model, BONE_LIMITS, resolved);
  console.log("[avatar] roles:", resolved.matched.length, JSON.stringify(resolved.report.bySource), resolved.matched.length ? "→ " + resolved.matched.join(", ") : "(none)");
  setStatus(`loaded ✓ ${resolved.matched.length ? "procedural idle on " + resolved.matched.length + " bones" : "static (no recognised body bones)"}${clips.length ? " · " + clips.length + " baked clip(s) on-demand" : ""}`);
  // VRM ships its own spring bones (vrm.update drives them) — don't double up.
  if (vrm) {
    spring = null;
  } else {
    // Pass the role-matched bones as `exclude` so a humanoid's limbs are never sprung
    // (only true dangly bits), plus any per-model spring override (extra/never).
    spring = buildSpringBones(model, { exclude: resolved.springExclude, override: rigOverrides[curKey] });
    if (spring && profileFor(curKey).spring) spring.setParams(profileFor(curKey).spring);   // per-avatar tuned physics
    if (spring?.count) console.log("[avatar] spring bones (" + spring.count + "):", spring.names.join(", "));
  }
  facial = buildFacial(model, vrm);               // facial layer (morphs → bones → none); drives lip-sync + eye blinks
  if (facial && profileFor(curKey).facial) facial.setParams(profileFor(curKey).facial);     // per-avatar jaw/face tuning
  reapplyAttachments();                           // re-attach saved props/accessories for this model
  applyColors();                                  // re-apply saved per-material color tints
  applyHue();                                     // re-apply saved per-material hue shifts
  hitMask = null; computeFootprint();             // prime the grab silhouette immediately (no fallback flash)
  updateBoneHelper();                             // (re)build the skeleton overlay if it's toggled on
}
// --- skeleton overlay (inspect the rig: see EVERY bone, role-matched or not) ----
function updateBoneHelper() {
  if (boneHelper) { scene.remove(boneHelper); boneHelper.geometry?.dispose?.(); boneHelper.material?.dispose?.(); boneHelper = null; }
  if (!bonesShown || !model) return;
  const h = new THREE.SkeletonHelper(model);
  if (!h.bones || !h.bones.length) { h.dispose?.(); return; }   // static mesh — no bones to draw
  h.material.depthTest = false; h.material.transparent = true; h.material.opacity = 0.92;   // draw OVER the mesh
  h.renderOrder = 999;
  boneHelper = h; scene.add(h);
  console.log("[avatar] skeleton shown:", h.bones.length, "bones");
}
function showSkeleton(on) {
  bonesShown = on == null ? !bonesShown : !!on;
  try { localStorage.setItem(BONES_KEY, bonesShown ? "1" : "0"); } catch {}
  updateBoneHelper();
  setStatus("skeleton " + (bonesShown ? "on" : "off"));
  return bonesShown;
}
// --- onboarding hint (shown ONLY when the device has no models → procedural placeholder) ---
let _onboarding = false;
function showOnboarding() {
  _onboarding = true;
  document.getElementById("ui")?.classList.remove("hidden");    // reveal the status line as the hint surface
  setStatus("Showing a built-in placeholder — no avatar model on this device yet.\nRight-click the figure → Add model…  ·  or drag a .glb / .gltf / .vrm / .fbx onto the window.");
}
function clearOnboarding() {                                     // a real model loaded → retract the hint we raised
  if (!_onboarding) return;
  _onboarding = false;
  document.getElementById("ui")?.classList.add("hidden");
}
let _loadSeq = 0;
function loadModel(url, label) {
  curKey = url;
  const seq = ++_loadSeq;                          // guard: a slower earlier load must not clobber a newer switch
  if (url === DEFAULT_KEY) { onModelLoaded(buildDefaultAvatar()); showOnboarding(); return; }   // zero-asset procedural placeholder
  setStatus(`loading ${label || url} …`);
  loadAsset(url,
    (asset) => { if (seq === _loadSeq) { onModelLoaded(asset); clearOnboarding(); } },   // superseded by a newer switch → drop it
    (err) => { if (seq === _loadSeq) { setStatus(`load failed: ${err?.message || err}`); console.error(err); } });
}

// --- attachments (props / accessories) --------------------------------------
// Load any mesh and parent it to a BONE so it rides the animation — held items,
// hats, the pole Mal0 ships with, glasses, simple capes. Per-avatar, persisted.
// (Body-conforming clothing still needs a mesh rigged to a matching skeleton —
// this covers rigid / bone-attached extras.) Placement (bone + offset) is tunable
// live via EnigmaAvatar.tuneAttachment(); the defaults are a starting point.
// Per-avatar PROFILE (durable): attachments (by category) + tuned spring/facial,
// keyed by model URL. Saved to profiles.json via IPC (Electron) with a localStorage
// fallback — so each avatar keeps its own setup for next time.
const PROFILE_KEY = "enigmaAvatar.profiles";
let profiles = {};
const profileFor = (key) => (profiles[key] || (profiles[key] = {}));
async function loadProfiles() {
  try { const r = await fetch("./profiles.json", { cache: "no-store" }); if (r.ok) { profiles = (await r.json()) || {}; return; } } catch {}
  try { profiles = JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; } catch { profiles = {}; }
}
let _profileTimer = 0;
function saveProfileSoon() {        // debounced persist of the whole profiles object (no attachment snapshot)
  clearTimeout(_profileTimer);
  _profileTimer = setTimeout(() => {
    const data = JSON.stringify(profiles, null, 2);
    try { window.avatarIPC?.saveProfiles?.(data); } catch {}
    try { localStorage.setItem(PROFILE_KEY, data); } catch {}
  }, 400);
}
// Snapshot the CURRENT model's live attachments into its profile — called ONLY by
// attach mutations, never by recolor/tune. So a recolor fired mid-restore (while
// props are still async-loading) can't truncate the saved list (avatar audit #2).
function commitAttachments() {
  profileFor(curKey).attachments = attachObjs.filter((a) => !String(a.url).startsWith("blob:"))
    .map((a) => ({ id: a.id, category: a.category, url: a.url, bone: a.bone, pos: a.pos, rot: a.rot, scale: a.scale }));
}
let attachObjs = [];   // live for the current model: [{id,category,url,bone,pos,rot,scale,obj,attachedTo}]
let _attachSeq = 0;
const D2R = Math.PI / 180;
const BONE_ALIAS = {
  righthand: "right.*(hand|wrist)", lefthand: "left.*(hand|wrist)",
  rightfoot: "right.*(foot|ankle|toe)", leftfoot: "left.*(foot|ankle|toe)",
  head: "head", neck: "neck", hips: "hips|pelvis", back: "chest|spine", tail: "tail",
};
function findBone(query) {
  if (!model || !query) return null;
  const q = String(query).toLowerCase();
  let re; try { re = new RegExp(BONE_ALIAS[q] || q, "i"); } catch { re = new RegExp(q.replace(/[^a-z0-9]+/gi, ".*"), "i"); }
  let best = null;
  model.traverse((o) => { if (!best && o.isBone && re.test(o.name)) best = o; });
  return best;
}
function _placeAttachment(a) {
  a.obj.position.fromArray(a.pos);
  a.obj.rotation.set(a.rot[0] * D2R, a.rot[1] * D2R, a.rot[2] * D2R);
  a.obj.scale.setScalar(a.scale);
}
function saveAttachments() { commitAttachments(); saveProfileSoon(); }   // snapshot + persist
function attachMesh(url, opts = {}) {
  const category = opts.category || "prop";
  const defBone = category === "furniture" ? "" : category === "clothes" ? "back" : "righthand";
  const a = { id: opts.id || ("a" + (++_attachSeq)), category, url, bone: opts.bone ?? defBone,
              pos: opts.pos || [0, 0, 0], rot: opts.rot || [0, 0, 0], scale: opts.scale ?? 1 };
  loadAsset(url, (asset) => {
    if (!asset.scene) { setStatus("attach failed: no mesh"); return; }
    a.obj = asset.scene;
    const bone = a.bone ? findBone(a.bone) : null;     // furniture (no bone) → rides the rig root (floats with her)
    a.attachedTo = bone ? bone.name : "(rig root)";
    a.obj.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
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
      const aH = (BASE_H * (rig.scale.x || 1)) || 1;
      const frac = category === "furniture" ? 0.9 : category === "clothes" ? 1.0 : 0.45;
      const s = (aH * frac) / pMax;
      if (isFinite(s) && s > 0) { a.scale = +s.toFixed(4); _placeAttachment(a); }
    }
    attachObjs.push(a);
    if (!opts._restore) saveAttachments();
    console.log("[avatar] attached", baseName(url), "→", a.attachedTo);
    setStatus(`attached ${baseName(url)} → ${a.attachedTo}`);
  }, (err) => setStatus(`attach failed: ${err?.message || err}`), { kind: opts.kind || kindOf(url) });
  return a.id;
}
function detachAttachment(id) {
  const i = attachObjs.findIndex((a) => a.id === id);
  if (i < 0) return false;
  const a = attachObjs[i];
  a.obj?.parent?.remove(a.obj);
  a.obj?.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  attachObjs.splice(i, 1); saveAttachments(); return true;
}
function clearAttachments() {
  for (const a of attachObjs) { a.obj?.parent?.remove(a.obj); a.obj?.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
  attachObjs = []; saveAttachments();
}
function reapplyAttachments() {
  attachObjs = [];                          // previous model (and its bone-children) were disposed
  for (const cfg of (profileFor(curKey).attachments || [])) attachMesh(cfg.url, { ...cfg, _restore: true });
}
function tuneAttachment(id, opts = {}) {
  const a = attachObjs.find((x) => x.id === id);
  if (!a || !a.obj) return null;
  if (opts.pos) a.pos = opts.pos;
  if (opts.rot) a.rot = opts.rot;
  if (opts.scale != null) a.scale = opts.scale;
  if (opts.bone && opts.bone !== a.bone) {
    a.bone = opts.bone; const bone = findBone(a.bone);
    a.obj.parent?.remove(a.obj); (bone || rig).add(a.obj); a.attachedTo = bone ? bone.name : "(rig root)";
  }
  _placeAttachment(a); saveAttachments();
  return { id: a.id, bone: a.bone, attachedTo: a.attachedTo, pos: a.pos, rot: a.rot, scale: a.scale };
}
// Per-avatar physics / face tuning — applied live and saved into the profile.
function springTune(p) {
  const prof = profileFor(curKey); prof.spring = { ...(prof.spring || {}), ...p };
  if (spring) spring.setParams(prof.spring); saveProfileSoon(); return prof.spring;
}
function facialTune(p) {
  const prof = profileFor(curKey); prof.facial = { ...(prof.facial || {}), ...p };
  if (facial) facial.setParams(prof.facial); saveProfileSoon();
  return facial ? { mode: facial.mode, info: facial.info, params: facial.params } : null;
}
// Per-material color TINT (multiplies the texture), per part, saved per avatar.
function modelMaterials() {
  const out = new Map();                 // name -> first material with that name
  model?.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && m.name && !out.has(m.name)) out.set(m.name, m);
  });
  return out;
}
function _setColor(name, hex) {
  let n = 0;
  model?.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && m.name === name && m.color) { m.color.set(hex); m.needsUpdate = true; n++; }
  });
  return n;
}
function recolor(name, hex) {
  const n = _setColor(name, hex);
  const p = profileFor(curKey); p.colors = p.colors || {}; p.colors[name] = hex; saveProfileSoon();
  return n;
}
function applyColors() { const c = profileFor(curKey).colors; if (c) for (const k in c) _setColor(k, c[k]); }
// Hue-shift a material's final color IN-SHADER (rotates hue, keeps the texture's detail)
// — for parts a flat tint can't reach. Live via a uniform; saved per avatar.
function _hueMaterial(m, deg) {
  const rad = ((((deg || 0) % 360) + 360) % 360) * Math.PI / 180;
  if (m.userData._hueU) { m.userData._hueU.value = rad; return; }   // already patched → just update the uniform
  const u = { value: rad };
  m.userData._hueU = u;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uHue = u;
    shader.fragmentShader = "uniform float uHue;\nvec3 _hueRot(vec3 c){float s=sin(uHue),k=cos(uHue);return clamp(mat3(0.299+0.701*k+0.168*s,0.587-0.587*k+0.330*s,0.114-0.114*k-0.497*s, 0.299-0.299*k-0.328*s,0.587+0.413*k+0.035*s,0.114-0.114*k+0.292*s, 0.299-0.300*k+1.250*s,0.587-0.588*k-1.050*s,0.114+0.886*k-0.203*s)*c,0.0,1.0);}\n"
      + shader.fragmentShader.replace("#include <map_fragment>", "#include <map_fragment>\n  diffuseColor.rgb = _hueRot(diffuseColor.rgb);");
  };
  m.needsUpdate = true;   // force recompile so onBeforeCompile injects the patch
}
function _setHue(name, deg) {
  let n = 0;
  model?.traverse((o) => { if (!o.isMesh || !o.material) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && m.name === name && m.color) { _hueMaterial(m, deg); n++; } });
  return n;
}
function hueShift(name, deg) { const n = _setHue(name, deg); const p = profileFor(curKey); p.hue = p.hue || {}; p.hue[name] = deg; saveProfileSoon(); return n; }
function applyHue() { const h = profileFor(curKey).hue; if (h) for (const k in h) _setHue(k, h[k]); }

// --- hit-test via the on-screen PIXEL SILHOUETTE (what actually renders) -------
// Render the model to a tiny offscreen buffer ~6×/s and keep its alpha as a
// silhouette MASK. A click then only lands on the avatar where there's an actual
// lit pixel (plus a small grab tolerance) — NOT anywhere inside its bounding box —
// so you can click *through* the empty gaps around a limb straight to the desktop.
// (Boxes also lie for skinned rigs — Roxanne's collapsed to her feet, GLaDOS's
// blew up — which the footprint sidesteps.) A rig that renders degenerate (its
// footprint fills the screen) falls back to a central body column so it stays grabbable.
const _fpRT = new THREE.WebGLRenderTarget(2, 2);
let hitRect = [0, 0, 0, 0];           // debug bbox of the silhouette / fallback region
let hitMask = null;                   // Uint8Array silhouette (1 = avatar) at maskW×maskH, bottom-left origin; null → fallback
let maskW = 0, maskH = 0;
let fpCoverage = 0, fpClock = 0.2;
// Footprint scratch, REUSED across passes — this runs ~6×/s, so a fresh RGBA-readback
// array + mask every call was needless GC churn. Re-allocated only when the window
// aspect changes (SW is fixed at 256; SH tracks innerHeight/innerWidth).
let _fpBuf = null, _fpMask = null, _fpW = 0, _fpH = 0;

function computeFootprint() {
  if (!model) { hitMask = null; return; }
  const SW = 256, SH = Math.max(2, Math.round(256 * innerHeight / innerWidth));
  if (SW !== _fpW || SH !== _fpH) {                // (re)allocate buffers + RT only on an aspect change
    _fpW = SW; _fpH = SH; _fpBuf = new Uint8Array(SW * SH * 4); _fpMask = new Uint8Array(SW * SH); _fpRT.setSize(SW, SH);
  }
  renderer.setRenderTarget(_fpRT);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const buf = _fpBuf, mask = _fpMask;
  renderer.readRenderTargetPixels(_fpRT, 0, 0, SW, SH, buf);   // overwrites every byte of buf
  mask.fill(0);                                                // mask is reused → clear last pass's bits before re-marking
  let mnx = 1e9, mny = 1e9, mxx = -1, mxy = -1, count = 0;
  for (let i = 0, p = 3; i < SW * SH; i++, p += 4) {
    if (buf[p] > 24) { mask[i] = 1; count++; const x = i % SW, y = (i / SW) | 0; if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; }
  }
  fpCoverage = count / (SW * SH);
  if (!count || fpCoverage > 0.55) { hitMask = null; return; }   // empty, or corrupted (degenerate geometry) → fallback column
  hitMask = mask; maskW = SW; maskH = SH;
  const sxL = (mnx / SW) * innerWidth, sxR = ((mxx + 1) / SW) * innerWidth;
  const syT = (1 - (mxy + 1) / SH) * innerHeight, syB = (1 - mny / SH) * innerHeight;
  hitRect = [Math.round(sxL), Math.round(syT), Math.round(sxR), Math.round(syB)];
}

function overSilhouette(cx, cy) {
  const bx = Math.floor((cx / innerWidth) * maskW);
  const by = Math.floor((1 - cy / innerHeight) * maskH);         // flip Y: buffer is bottom-left origin
  const r = Math.max(1, Math.round(8 * maskW / innerWidth));     // ~8px screen grab tolerance, in mask cells (tight to the mesh)
  for (let dy = -r; dy <= r; dy++) {
    const yy = by + dy; if (yy < 0 || yy >= maskH) continue;
    const row = yy * maskW;
    for (let dx = -r; dx <= r; dx++) { const xx = bx + dx; if (xx < 0 || xx >= maskW) continue; if (hitMask[row + xx]) return true; }
  }
  return false;
}

function computeOver() {
  if (!model) { cursor.over = false; return; }
  let over;
  if (hitMask) {
    over = overSilhouette(cursor.x, cursor.y);                   // shaped to the avatar — empty space clicks through
  } else {                                                       // corrupted/empty footprint → central body column
    const hw = Math.min((modelDims.w || 2) * sizeScale, worldW * 0.6) / 2;
    const hh = Math.min((modelDims.h || 4) * sizeScale, worldH * 0.9);
    const [ax, ay] = toScreen(pos.x - hw, pos.y + hh), [bx, by] = toScreen(pos.x + hw, pos.y);
    let mnx = Math.min(ax, bx) - 26, mxx = Math.max(ax, bx) + 26, mny = Math.min(ay, by) - 26, mxy = Math.max(ay, by) + 26;
    mnx = Math.max(0, mnx); mny = Math.max(0, mny); mxx = Math.min(innerWidth, mxx); mxy = Math.min(innerHeight, mxy);
    hitRect = [mnx, mny, mxx, mxy];
    over = cursor.x >= mnx && cursor.x <= mxx && cursor.y >= mny && cursor.y <= mxy;
  }
  if (over !== cursor.over) { cursor.over = over; syncInteractive(); }
}

// Head/neck track the cursor (gentle), decaying to idle when the cursor is still/away.
function updateLook(dt) {
  if (!proc || !proc.setLook) return;
  _cursorIdle += dt;
  let tx = 0, ty = 0, tw = 0;
  if (lookOn && _cursorIdle < 2.5 && cursor.x >= 0) {
    const [hx, hy] = toScreen(pos.x, pos.y + (modelDims.h || 4) * sizeScale * 0.85);   // ≈ head position, in screen px
    tx = _clampN(((cursor.x - hx) / innerWidth) * LOOK.gainX * LOOK.flipX, -LOOK.maxX, LOOK.maxX);
    ty = _clampN(((cursor.y - hy) / innerHeight) * LOOK.gainY * LOOK.flipY, -LOOK.maxY, LOOK.maxY);
    tw = 1;
  }
  const k = Math.min(1, dt * 5);
  _lookX += (tx - _lookX) * k; _lookY += (ty - _lookY) * k; _lookW += (tw - _lookW) * k;
  proc.setLook(_lookX, _lookY, _lookW);
}
// Occasional gentle emote when left alone (not held / hovered / speaking / menu open).
function maybeIdleBehavior(dt) {
  if (!proc || !idleBehaviorOn || held || cursor.over || ui.isOpen() || voice.isSpeaking()) { _idleClock = 0; return; }
  _idleClock += dt;
  if (_idleClock >= _idleNext) {
    _idleClock = 0; _idleNext = 8 + Math.random() * 12;
    EnigmaAvatar.express(IDLE_EMOTES[(Math.random() * IDLE_EMOTES.length) | 0], 1.8);
  }
}

// --- float + idle (NO gravity, NO walking) ----------------------------------
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  if (held) { pos.copy(toWorld(cursor.x, cursor.y).sub(grab)); gliding = false; }   // drag overrides any glide
  else if (gliding) { pos.lerp(glideT, Math.min(1, dt * 4)); if (pos.distanceTo(glideT) < 0.02) { pos.copy(glideT); gliding = false; } }  // smooth glide to target
  rig.position.set(pos.x, pos.y, 0);                            // float in place — no rigid bob; motion comes from bones + springs
  updateLook(dt);                                               // head tracks the cursor
  maybeIdleBehavior(dt);                                        // occasional gentle emote when left alone
  if (mixer && current) { mixer.update(dt); if (proc) proc.update(dt, false, { additive: true }); }  // a clip is playing → emotes layer additively
  else if (proc && idleOn) proc.update(dt, false);              // no clip playing → full procedural idle + emotes
  if (facial && facialOn) facial.update(dt);                    // blink + lip-sync (jaw / morphs / VRM weights)
  if (spring && springOn) { rig.updateWorldMatrix(false, true); spring.update(dt); }  // hair/tail/wires sway
  if (vrm) vrm.update(dt);                                       // VRM spring bones / look-at / expressions
  renderer.render(scene, camera);
  fpClock += dt;                                                 // refresh the grab footprint ~6×/s while not dragging
  if (!held && fpClock > 0.16) { fpClock = 0; computeFootprint(); }
}

// --- voice + lip-sync (speech playback + amplitude lip-sync) -----------------
// Implementation in voice.js; wire it to the live facial layer + the "talk" emote.
const voice = createVoice({
  getFacial: () => facial,
  onSpeakStart: (dur) => EnigmaAvatar.express("talk", dur),
  setStatus,
});

// Capture the overlay's own canvas (the avatar on transparency — NO desktop behind
// it) to a PNG, so it can be inspected in isolation, "like in Blender". Crops tight
// to the avatar's silhouette by default (full window with {full:true}). Pair with
// showSkeleton(true) to capture the rig over the mesh.
async function snapshot(opts = {}) {
  if (!window.avatarIPC || !window.avatarIPC.capture) { setStatus("snap unavailable (no IPC)"); return null; }
  let rect = null;
  if (!opts.full && model && hitRect && hitRect[2] > hitRect[0] && hitRect[3] > hitRect[1]) {
    const pad = opts.pad ?? 48;
    const x = Math.max(0, Math.floor(hitRect[0] - pad));
    const y = Math.max(0, Math.floor(hitRect[1] - pad));
    const w = Math.min(Math.round(innerWidth) - x, Math.ceil(hitRect[2] - hitRect[0] + pad * 2));
    const h = Math.min(Math.round(innerHeight) - y, Math.ceil(hitRect[3] - hitRect[1] + pad * 2));
    if (w > 8 && h > 8) rect = { x, y, width: w, height: h };
  }
  const r = await window.avatarIPC.capture({ rect, name: opts.name });
  if (r && r.ok) setStatus(`snap ✓ ${r.width}×${r.height} → ${r.path}`);
  else setStatus("snap failed: " + (r && r.error));
  console.log("[avatar] snap:", JSON.stringify(r));
  return r;
}

// --- AI control surface -----------------------------------------------------
const EnigmaAvatar = {
  actions: () => clipNames(),
  play(name, opts = {}) { return playAction(actions[name] || actions[findClip(new RegExp(name, "i"))], { loop: false, ...opts, onDone: () => { if (clipIdle) playAction(clipIdle, { loop: true }); else current = null; } }); },
  loopClip(name) { return playAction(actions[name] || actions[findClip(new RegExp(name, "i"))], { loop: true }); },
  moveTo(px, py) { glideTo(px, py); },                           // smooth-glide to screen px,py (stays there)
  nudge: (dx, dy) => nudge(dx, dy),                              // move by a fraction of the screen (arrow keys)
  glideTo: (px, py) => glideTo(px, py),
  setSize: (s) => applySize(s), size: () => sizeScale,
  load(url) { loadModel(url, url); },
  reloadRig: () => loadRigOverrides().then(() => { if (curKey && /models\//.test(curKey)) loadModel(curKey, curKey); }),   // re-read rig_overrides.json + re-resolve the CURRENT disk model live (no restart) — the AI's fix loop. Skips drag-dropped/transient models (bare filename / revoked blob / no override entry).
  matched: () => (proc ? proc.matched : []),
  tune: (p) => { if (proc) proc.setParams(p); return proc ? proc.params : null; },
  state: () => ({ held, size: +sizeScale.toFixed(2), pos: [+pos.x.toFixed(2), +pos.y.toFixed(2)], over: cursor.over, vrm: !!vrm, clips: clipNames(), procBones: proc ? proc.matched : [], springBones: spring ? spring.names : [], facial: facial ? { mode: facial.mode, info: facial.info } : null, attachments: attachObjs.map((a) => ({ id: a.id, category: a.category, attachedTo: a.attachedTo })), toggles: { spring: springOn, idle: idleOn, facial: facialOn, look: lookOn, idleBehavior: idleBehaviorOn, locked, menu: ui.isOpen() } }),
  springTune: (p) => springTune(p),                                      // saved per-avatar (hair flow, etc.)
  express: (type, dur) => { if (proc) proc.setExpression(type, dur); },   // AI-driven emote (talk/happy/wag/…)
  lookTune: (p) => Object.assign(LOOK, p),                               // tune/flip cursor-look (gainX/Y, flipX/Y, maxX/Y)
  facialTune: (p) => facialTune(p),                                      // saved per-avatar (jaw axis/open)
  mouth: (a) => { if (facial) facial.setMouth(a); },                      // 0..1 jaw/mouth open
  say: (url, opts) => voice.speak(url, opts),                             // play speech audio + lip-sync
  stopSpeak: () => voice.stop(),
  attach: (url, opts) => attachMesh(url, opts),                           // prop/accessory → bone (opts: bone,pos,rot,scale)
  detach: (id) => detachAttachment(id),
  clearAttachments: () => clearAttachments(),
  attachments: () => attachObjs.map((a) => ({ id: a.id, category: a.category, url: a.url, bone: a.bone, attachedTo: a.attachedTo, pos: a.pos, rot: a.rot, scale: a.scale })),
  tuneAttachment: (id, opts) => tuneAttachment(id, opts),                 // live placement: {bone,pos:[x,y,z],rot:[deg],scale}
  bones: () => { const out = []; model?.traverse((o) => { if (o.isBone) out.push(o.name); }); return out; },   // names to target
  showSkeleton: (on) => showSkeleton(on),                                 // overlay the rig to inspect bones; persists
  bonesShown: () => bonesShown,
  snap: (opts) => snapshot(opts || {}),                                   // capture the avatar in isolation → PNG (inspect)
  materials: () => [...modelMaterials().keys()],                          // recolorable parts (hair, body, eyes…)
  recolor: (name, hex) => recolor(name, hex),                            // tint a part; saved per avatar
  hueShift: (name, deg) => hueShift(name, deg),                          // rotate a part's hue (keeps detail); saved
  connect(url = "ws://127.0.0.1:8765") { try { const ws = new WebSocket(url); ws.onopen = () => setStatus("AI bus connected"); ws.onmessage = (e) => { try { handleCommand(JSON.parse(e.data)); } catch {} }; ws.onclose = () => setTimeout(() => this.connect(url), 4000); ws.onerror = () => ws.close(); } catch (err) { console.error(err); } },
};
function handleCommand(c) {
  if (c.action === "play") EnigmaAvatar.play(c.name, c.opts);
  else if (c.action === "loop") EnigmaAvatar.loopClip(c.name);
  else if (c.action === "moveTo") EnigmaAvatar.moveTo(c.px ?? 0, c.py ?? 0);
  else if (c.action === "size") EnigmaAvatar.setSize(c.value ?? 1);
  else if (c.action === "load" && c.url) EnigmaAvatar.load(c.url);
  else if (c.action === "reloadRig") EnigmaAvatar.reloadRig();          // re-read overrides + re-resolve (after an AI edits rig_overrides.json)
  else if (c.action === "express") EnigmaAvatar.express(c.name, c.dur);
  else if (c.action === "say" && c.url) EnigmaAvatar.say(c.url, c);     // play speech wav + lip-sync (+talk body language)
  else if (c.action === "mouth") EnigmaAvatar.mouth(c.value ?? 0);      // manual jaw drive (testing)
  else if (c.action === "stop") EnigmaAvatar.stopSpeak();
  else if (c.action === "attach" && c.url) EnigmaAvatar.attach(c.url, c);              // prop/accessory → bone
  else if (c.action === "detach") c.id ? EnigmaAvatar.detach(c.id) : EnigmaAvatar.clearAttachments();
  else if (c.action === "tuneAttachment" && c.id) EnigmaAvatar.tuneAttachment(c.id, c);
  else if (c.action === "springTune") { const { action, ...p } = c; EnigmaAvatar.springTune(p); }   // live hair tuning (saved)
  else if (c.action === "facialTune") { const { action, ...p } = c; EnigmaAvatar.facialTune(p); }
  else if (c.action === "tune") { const { action, ...p } = c; EnigmaAvatar.tune(p); }   // procedural idle feel (drift/armSwing/sway/twist…)
  else if (c.action === "showBones") EnigmaAvatar.showSkeleton(c.on ?? c.value);         // skeleton overlay on/off (no arg → toggle)
  else if (c.action === "snap" || c.action === "screenshot") EnigmaAvatar.snap(c);       // capture avatar → PNG for inspection
  else if (c.action === "setDisplay" || c.action === "monitor") moveToDisplay(c.index ?? c.value ?? "next");   // move overlay to a monitor (index, or "next"/"prev")
  else if (c.action === "settings") { if (c.open === false) ui.hideSettings(); else ui.showSettings(); }   // open/close the Settings panel
  else if (c.action === "recolor" && c.name) EnigmaAvatar.recolor(c.name, c.color || c.hex);   // tint a material
  else if (c.action === "hue" && c.name) EnigmaAvatar.hueShift(c.name, c.deg ?? c.value ?? 0);  // rotate a material's hue
}
window.EnigmaAvatar = EnigmaAvatar;
window.__AV = { THREE, scene, camera, rig, getModel: () => model };

// --- monitors (move the overlay between screens, from the UI / a hotkey) -----
// Main is the source of truth for the display layout; the renderer caches a
// left→right-sorted copy so the right-click "Move to monitor" menu can build
// synchronously, and stays in sync via the avatar:displayChanged event.
let DISPLAYS = [];          // [{index,label,primary,x,y,w,h}] sorted left→right; index = screen.getAllDisplays() index
let curDisplayIdx = 0;      // electron index the overlay is on right now
let _hopArmed = true;       // drag-across-monitors: armed until a hop fires; re-arms when the cursor is back inside
async function refreshDisplays() {
  if (!window.avatarIPC?.getDisplays) return;
  try { const info = await window.avatarIPC.getDisplays(); if (info) { DISPLAYS = info.displays || []; curDisplayIdx = info.current ?? curDisplayIdx; } } catch {}
}
function moveToDisplay(idx) {
  if (idx === "next" || idx === "prev") {                        // resolve a relative hop against the sorted list
    if (DISPLAYS.length) { const at = Math.max(0, DISPLAYS.findIndex((d) => d.index === curDisplayIdx)); idx = DISPLAYS[(at + (idx === "next" ? 1 : -1) + DISPLAYS.length) % DISPLAYS.length].index; }
    else idx = curDisplayIdx;
  }
  if (window.avatarIPC?.setDisplay) { window.avatarIPC.setDisplay(idx); curDisplayIdx = idx; setStatus("monitor → " + idx); }
}
window.avatarIPC?.onDisplayChanged?.((info) => { if (!info) return; DISPLAYS = info.displays || []; curDisplayIdx = info.current ?? curDisplayIdx; });   // DISPLAYS feeds the drag-hop; no monitor menu to rebuild
// Recenter the avatar on the current monitor after a move — its position is in world
// coords, so a hop to a different-sized screen can strand it at an edge / off-screen.
// Snap it to centre-lower of the (now-resized) window so it's always immediately visible.
function recenterAvatar() {
  renderer.setSize(innerWidth, innerHeight);     // a monitor hop resizes the window, but the renderer's
  frameCamera();                                 // 'resize' event can fire stale/late — force canvas+camera to match NOW
  fitToScreen();                                 // shrink if a saved size is too big for THIS monitor (the head-clip bug)
  pos.set(0, -1.5); _clampScreen(pos);           // WORLD coords (centre-x, standing) — resolution-independent
  glideT.copy(pos); gliding = false; held = false;
  fpClock = 1;                                   // re-scan the grab silhouette at the new spot
  setStatus("centered on this monitor");
}
window.avatarIPC?.onCenter?.(() => { if (!held) recenterAvatar(); });   // don't recenter mid-drag — the drag-hop owns the position
// Drag ACROSS monitors. The overlay window lives on ONE screen, so dragging the avatar
// can't normally cross to another monitor — it stops dead at the window edge. When the
// user drags it against an edge that borders another display, hop the overlay there and
// let the drag continue. (This is how the user actually moves it — by mouse, not the menu.)
function maybeDragHop() {
  if (!held || !_hopArmed || DISPLAYS.length < 2) return;
  const cur = DISPLAYS.find((d) => d.index === curDisplayIdx); if (!cur) return;
  const sharesV = (d) => d.y < cur.y + cur.h && d.y + d.h > cur.y;       // monitors that overlap vertically
  const EDGE = 6;
  let target = null;
  if (cursor.x >= innerWidth - EDGE)  target = DISPLAYS.find((d) => d.index !== cur.index && Math.abs(d.x - (cur.x + cur.w)) <= 16 && sharesV(d));   // right neighbour
  else if (cursor.x <= EDGE)          target = DISPLAYS.find((d) => d.index !== cur.index && Math.abs((d.x + d.w) - cur.x) <= 16 && sharesV(d));      // left neighbour
  if (target) { _hopArmed = false; grab.set(0, 0); curDisplayIdx = target.index; window.avatarIPC?.setDisplayDrag?.(target.index); setStatus("→ next monitor"); }
}
// Re-arm only once the cursor is back inside the window, so we don't ping-pong on the shared edge.
function _rearmHop() { if (!_hopArmed && cursor.x > innerWidth * 0.15 && cursor.x < innerWidth * 0.85) _hopArmed = true; }
refreshDisplays();

// --- UI: right-click menu + Settings dialog (DOM built in ui.js) -------------
// Built-in models are defined here (they reference the MODELS paths above); user
// models come from models.json, loaded by ui.refreshModelList().
const BUILTIN_MODELS = [
  { id: "roxanne", url: MODELS["1"], label: "Roxanne" },
  { id: "toothless", url: MODELS["2"], label: "Night Fury" },
  { id: "glados", url: MODELS["3"], label: "GLaDOS" },
];
let ui;   // the menu/Settings UI (ui.js) — created just below, once the engine fns it calls exist
const syncInteractive = () => window.avatarIPC?.setInteractive?.((ui?.isOpen() ?? false) || cursor.over || held);

// Build the menu/Settings UI (ui.js) and wire it to engine state + actions. It owns
// its own DOM + open/close state; everything it touches comes through this api object.
ui = createUI({
  THREE, BASE_H, rig,
  avatarIPC: window.avatarIPC,
  setStatus, baseName, kindOf, profileFor, modelMaterials, flags,
  builtinModels: BUILTIN_MODELS,
  getCurKey: () => curKey,
  getAttachObjs: () => attachObjs,
  getBonesShown: () => bonesShown,
  loadModel, attachMesh, detachAttachment, clearAttachments,
  express: (t, d) => EnigmaAvatar.express(t, d),
  showSkeleton, recolor, hueShift, springTune, tuneAttachment,
  syncInteractive,
});

addEventListener("contextmenu", (e) => {
  if (ui.containsEvent(e.target)) { e.preventDefault(); return; }
  cursor.x = e.clientX; cursor.y = e.clientY; computeOver();
  if (cursor.over) { e.preventDefault(); ui.hideSettings(); ui.showMenu(e.clientX, e.clientY); }
});
addEventListener("keydown", (e) => { if (e.key === "Escape") { if (ui.isSettingsOpen()) ui.hideSettings(); else ui.hideMenu(); } });

// --- input (drag to reposition; NO hand cursor; NO fall) --------------------
addEventListener("resize", () => { renderer.setSize(innerWidth, innerHeight); frameCamera(); _clampScreen(pos); if (gliding) _clampScreen(glideT); });   // a monitor hop resizes the window → keep her on-screen
addEventListener("wheel", (e) => { if (cursor.over) resizeBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); }, { passive: true });
addEventListener("pointermove", (e) => { cursor.x = e.clientX; cursor.y = e.clientY; computeOver(); if (held) { _rearmHop(); maybeDragHop(); } });
addEventListener("pointerdown", (e) => {
  if (ui.containsEvent(e.target)) return;                        // clicking a popup's own controls
  const wasOpen = ui.isOpen();
  ui.hideMenu(); ui.hideSettings();                             // any outside click dismisses popups
  if (wasOpen) return;                                          // the dismiss click shouldn't also grab
  computeOver();
  if (cursor.over && !locked) { held = true; grab.copy(toWorld(cursor.x, cursor.y).sub(pos)); _downX = cursor.x; _downY = cursor.y; } else { _downX = -999; }
});
addEventListener("pointerup", (e) => {
  // a click/pet (pressed on the avatar, released with minimal movement) → happy reaction
  if (held && _downX > -100 && Math.abs(e.clientX - _downX) < 6 && Math.abs(e.clientY - _downY) < 6) {
    EnigmaAvatar.express(Math.random() < 0.5 ? "happy" : "wag", 1.6);
  }
  held = false; fpClock = 1; _downX = -999; _hopArmed = true;   // re-scan silhouette; re-arm the cross-monitor drag-hop
});
addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "h") document.getElementById("ui")?.classList.toggle("hidden");
  else if (e.key.toLowerCase() === "b") showSkeleton();          // toggle the skeleton overlay
  else if (e.key === "+" || e.key === "=") resizeBy(1.1);
  else if (e.key === "-" || e.key === "_") resizeBy(1 / 1.1);
  else if (e.key === "0") applySize(DEFAULT_SIZE);               // reset — same value as the menu's Size → Reset
  else if (e.key === "ArrowLeft") nudge(-0.33, 0);              // glide across the screen (when focused; also Ctrl+Alt+arrows globally)
  else if (e.key === "ArrowRight") nudge(0.33, 0);
  else if (e.key === "ArrowUp") nudge(0, 0.2);
  else if (e.key === "ArrowDown") nudge(0, -0.2);
  else if (MODELS[e.key]) loadModel(MODELS[e.key], MODELS[e.key]);
});
function loadFile(file) {                                       // single file (self-contained .glb/.vrm/.fbx)
  const url = URL.createObjectURL(file);
  curKey = file.name;
  loadAsset(url, (a) => { URL.revokeObjectURL(url); onModelLoaded(a); clearOnboarding(); },
            (err) => { URL.revokeObjectURL(url); setStatus(`load failed: ${err?.message || err}`); }, { kind: kindOf(file.name) });
}
function loadFiles(fileList) {                                  // drag-drop: 1 file, or .gltf + .bin + textures together
  const files = [...fileList];
  if (files.length <= 1) { if (files[0]) loadFile(files[0]); return; }
  const main = files.find((f) => /\.(gltf|glb|vrm|fbx)$/i.test(f.name)) || files[0];
  const map = {}; const urls = [];
  for (const f of files) { const u = URL.createObjectURL(f); map[f.name] = u; urls.push(u); }   // resolve refs by basename
  curKey = main.name;
  // revoke late: FBX kicks off texture loads asynchronously after onLoad, so don't
  // pull the blob URLs out from under them. (Page unload frees them regardless.)
  const cleanup = () => setTimeout(() => urls.forEach(URL.revokeObjectURL), 20000);
  loadAsset(map[main.name], (a) => { cleanup(); onModelLoaded(a); clearOnboarding(); },
            (err) => { cleanup(); setStatus(`load failed: ${err?.message || err}`); }, { kind: kindOf(main.name), blobMap: map });
}
document.getElementById("file")?.addEventListener("change", (e) => { if (e.target.files?.length) loadFiles(e.target.files); });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files); });

// --- go ---------------------------------------------------------------------
applySize(sizeScale);
animate();
// Load per-avatar profiles + the model list first, THEN the default model — so its
// saved attachments and tuned physics apply on the very first load. If the default
// model isn't present (a FRESH CLONE on another device — models/ is gitignored), fall
// back to the zero-asset procedural placeholder + an onboarding hint, so the overlay is
// never blank and the user can Add model… straight from there. (Works on any device.)
Promise.allSettled([loadProfiles(), ui.refreshModelList(), loadRigOverrides()]).then(startup);
function startup() {
  const seq = ++_loadSeq;
  curKey = DEFAULT_MODEL;
  setStatus("loading default model …");
  loadAsset(DEFAULT_MODEL,
    (asset) => { if (seq === _loadSeq) { onModelLoaded(asset); clearOnboarding(); } },
    () => { if (seq !== _loadSeq) return; console.warn("[avatar] no default model on this device → procedural placeholder"); curKey = DEFAULT_KEY; onModelLoaded(buildDefaultAvatar()); showOnboarding(); });
}

// In the desktop overlay, connect to the local AI bus (see mods/avatar/bus.py)
// so Enigma/Odysseus can drive emotes — the tail wags when it talks. A plain
// browser preview has no bus and no avatarIPC, so we skip it there to avoid
// console spam from failed sockets (test it manually with EnigmaAvatar.connect()).
if (window.avatarIPC) EnigmaAvatar.connect();
