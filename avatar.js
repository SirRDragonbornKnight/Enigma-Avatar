// Enigma Avatar — engine (FLOATING desktop companion).
// Loads any rigged glTF/GLB/VRM; plays its clips or a gentle procedural idle.
// It FLOATS anywhere on screen (no gravity / no walking) — drag to reposition
// (it stays), scroll to resize (remembered per-model). Spring-bone physics
// (hair/tail) and AI expression control are layered on top of this.
// NOTE: software-WebGL previews can't render skinned meshes — use a real browser.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { TGALoader } from "three/addons/loaders/TGALoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { buildProceduralRig } from "./procedural.js?v=19";
import { buildSpringBones } from "./spring.js?v=8";
import { buildFacial } from "./facial.js?v=1";

const params = new URLSearchParams(location.search);
const MODELS = {
  "1": "./models/roxanne_wolf/scene.gltf",
  "2": "./models/toothless/scene.gltf",
  "3": "./models/glados/scene.gltf",
};
const DEFAULT_MODEL = params.get("model") || MODELS["1"];

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
// Multi-format loading: glTF/GLB, VRM (glTF + VRM plugin), and FBX. Each load gets
// its OWN LoadingManager, so concurrent/rapid model switches never share texture-
// resolution state. The manager decodes .tga (FBX/Unity textures are usually TGA).
// For FBX, texture lookups are forced into the model's own folder by basename — so
// the flat folders import_unitypackage.py produces resolve no matter what path a DCC
// tool baked in. glTF keeps its own (correct) relative paths (textures/ subfolders).
const TEX_RE = /\.(tga|png|jpe?g|webp|bmp|gif|ktx2|basis|dds)(\?.*)?$/i;
const baseName = (u) => u.split(/[?#]/)[0].split(/[\\/]/).pop();
const kindOf = (url) => { const u = url.split(/[?#]/)[0].toLowerCase(); return u.endsWith(".fbx") ? "fbx" : u.endsWith(".vrm") ? "vrm" : "gltf"; };

// Load any supported format; hand back a normalized { scene, animations, vrm }.
// opts: { kind, resourceDir, blobMap } — all optional; blobMap resolves multi-file
// drag-drop refs by basename. No module-level load state → no cross-load races.
function loadAsset(url, onOk, onErr, opts = {}) {
  const kind = opts.kind || kindOf(url);
  const dir = opts.resourceDir ?? (!/^blob:|^data:/.test(url) ? url.slice(0, url.lastIndexOf("/") + 1) : "");
  const mgr = new THREE.LoadingManager();
  mgr.addHandler(/\.tga$/i, new TGALoader(mgr));
  if (opts.blobMap) {                                   // multi-file drag-drop: resolve every ref by basename
    mgr.setURLModifier((u) => opts.blobMap[baseName(u)] || u);
  } else if (kind === "fbx" && dir) {                   // FBX: force texture refs into the model's folder
    mgr.setURLModifier((u) => (!/^blob:|^data:/.test(u) && TEX_RE.test(u) ? dir + baseName(u) : u));
  }
  if (kind === "fbx") {
    new FBXLoader(mgr).load(url, async (obj) => {
      try { await applyFbxMaterials(obj, dir, mgr); } catch {}   // FBX has no embedded textures — bind them from materials.json
      onOk({ scene: obj, animations: obj.animations || [], vrm: null });
    }, undefined, onErr);
  } else {
    const gl = new GLTFLoader(mgr);
    gl.register((parser) => new VRMLoaderPlugin(parser));   // fills gltf.userData.vrm when it's a VRM
    gl.load(url, (g) => {
      const vrm = g.userData?.vrm || null;
      if (vrm) { VRMUtils.removeUnnecessaryJoints?.(vrm.scene); vrm.scene.rotation.y = Math.PI; }   // VRM faces -Z → turn to camera
      onOk({ scene: vrm ? vrm.scene : (g.scene || g.scenes?.[0]), animations: g.animations || [], vrm });
    }, undefined, onErr);
  }
}
// FBX from Unity/VRChat ships materials with NO textures (bindings live in .mat
// files). import_unitypackage.py writes a materials.json next to the mesh mapping
// each FBX material name → { map, normalMap } texture files; re-attach them here.
async function applyFbxMaterials(root, dir, mgr) {
  if (!dir) return;                                   // only disk loads have a sidecar
  let spec;
  try { const r = await fetch(dir + "materials.json", { cache: "no-store" }); if (!r.ok) return; spec = await r.json(); } catch { return; }
  if (!spec || typeof spec !== "object") return;
  const texLoader = new THREE.TextureLoader(mgr);
  const cache = {};
  const tex = (file, srgb) => {                       // .tga must go through the manager's TGALoader, not TextureLoader
    if (!(file in cache)) {
      const t = (mgr.getHandler(file) || texLoader).load(dir + file);
      if (srgb && t && "colorSpace" in t) t.colorSpace = THREE.SRGBColorSpace;
      cache[file] = t;
    }
    return cache[file];
  };
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      const e = m && m.name && spec[m.name];
      if (!e) continue;
      if (e.map) m.map = tex(e.map, true);
      if (e.normalMap) m.normalMap = tex(e.normalMap, false);
      m.needsUpdate = true;
    }
  });
}
const clock = new THREE.Clock();
const _box = new THREE.Box3();
const rig = new THREE.Group(); scene.add(rig);

let proc = null, spring = null, facial = null, BONE_LIMITS = {};
let boneHelper = null;                          // SkeletonHelper overlay — inspect the rig (every bone, named or not)
const BONES_KEY = "enigmaAvatar.showBones";
let bonesShown = (() => { try { return localStorage.getItem(BONES_KEY) === "1"; } catch { return false; } })();
fetch("./bone_limits.json").then((r) => r.json()).then((j) => (BONE_LIMITS = j)).catch(() => {});

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
let springOn = true, idleOn = true, facialOn = true, locked = false, menuShown = false, settingsShown = false;  // menu/settings state
let lookOn = true, idleBehaviorOn = true;                       // companion behaviors: track cursor + occasional emotes
const LOOK = { gainX: 1.4, gainY: 1.0, flipX: 1, flipY: -1, maxX: 0.6, maxY: 0.35 };  // cursor-look feel (flip signs per rig)
let _lookX = 0, _lookY = 0, _lookW = 0, _cursorIdle = 99;       // smoothed look state
let _idleClock = 0, _idleNext = 9, _downX = -999, _downY = 0;   // idle-emote timer + click/pet detection
const _clampN = (v, a, b) => (v < a ? a : v > b ? b : v);
const IDLE_EMOTES = ["nod", "happy", "alert", "wag"];

function applySize(s) {
  sizeScale = Math.max(0.02, s || 0.02);   // no upper cap (removed min/max); tiny floor so multiplicative resize can recover
  rig.scale.setScalar(sizeScale);
  sizeByModel[curKey] = sizeScale;
  try { localStorage.setItem(SIZE_KEY, JSON.stringify(sizeByModel)); } catch {}   // remember this size for next launch
  setStatus(`size ×${sizeScale.toFixed(2)}`);
}
const resizeBy = (m) => applySize(sizeScale * m);

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
  proc = buildProceduralRig(model, BONE_LIMITS);
  console.log("[avatar] procedural roles:", proc.matched.length, proc.matched.length ? "→ " + proc.matched.join(", ") : "(none)");
  setStatus(`loaded ✓ ${proc.matched.length ? "procedural idle on " + proc.matched.length + " bones" : "static (no recognised body bones)"}${clips.length ? " · " + clips.length + " baked clip(s) on-demand" : ""}`);
  // VRM ships its own spring bones (vrm.update drives them) — don't double up.
  if (vrm) {
    spring = null;
  } else {
    spring = buildSpringBones(model);
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
let _loadSeq = 0;
function loadModel(url, label) {
  curKey = url;
  const seq = ++_loadSeq;                          // guard: a slower earlier load must not clobber a newer switch
  setStatus(`loading ${label || url} …`);
  loadAsset(url,
    (asset) => { if (seq === _loadSeq) onModelLoaded(asset); },   // superseded by a newer switch → drop it
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

function computeFootprint() {
  if (!model) { hitMask = null; return; }
  const SW = 256, SH = Math.max(2, Math.round(256 * innerHeight / innerWidth));
  _fpRT.setSize(SW, SH);
  renderer.setRenderTarget(_fpRT);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const buf = new Uint8Array(SW * SH * 4);
  renderer.readRenderTargetPixels(_fpRT, 0, 0, SW, SH, buf);
  const mask = new Uint8Array(SW * SH);
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
  if (!proc || !idleBehaviorOn || held || cursor.over || menuShown || settingsShown || _rafSpeak) { _idleClock = 0; return; }
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

// --- voice + lip-sync -------------------------------------------------------
// We do NOT synthesize speech in the renderer. Modkit's Kokoro TTS writes a WAV
// and sends {action:"say", url} over the bus; here we play it through a Web Audio
// AnalyserNode and drive the facial mouth from the signal's RMS each frame, so the
// jaw/visemes track loudness. No speechSynthesis fallback (by design).
let _audioCtx = null, _srcNode = null, _rafSpeak = 0, _speakSeq = 0;
function stopSpeak() {
  _speakSeq++;                                   // invalidate any in-flight load/playback
  if (_rafSpeak) { cancelAnimationFrame(_rafSpeak); _rafSpeak = 0; }
  if (_srcNode) { try { _srcNode.stop(0); } catch {} try { _srcNode.disconnect(); } catch {} _srcNode = null; }
  if (facial) facial.setMouth(0);
}
// XHR reads file:// reliably in the Electron renderer (fetch() rejects file://).
function _loadAudioBytes(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true); xhr.responseType = "arraybuffer";
    xhr.onload = () => ((xhr.status === 200 || xhr.status === 0) && xhr.response ? resolve(xhr.response) : reject(new Error("HTTP " + xhr.status)));
    xhr.onerror = () => reject(new Error("could not read audio"));
    xhr.send();
  });
}
// Decode to raw samples and play through an AudioBufferSource — NOT a MediaElement:
// a file:// <audio> routed through Web Audio is treated as cross-origin and tainted,
// which silences BOTH the sound and the analyser. Raw AudioBuffers never taint.
async function speak(url, opts = {}) {
  stopSpeak();
  const myseq = _speakSeq;                        // this call's generation (stopSpeak bumped it)
  const gain = opts.gain ?? 9.0;                  // RMS is small (~0.05–0.2); scale up to 0..1 mouth
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") { try { await _audioCtx.resume(); } catch {} }
    const bytes = await _loadAudioBytes(url);
    if (myseq !== _speakSeq) return;              // superseded / stopped while loading
    const audioBuf = await _audioCtx.decodeAudioData(bytes);
    if (myseq !== _speakSeq) return;
    const src = _audioCtx.createBufferSource(); src.buffer = audioBuf;
    const an = _audioCtx.createAnalyser(); an.fftSize = 1024;
    src.connect(an); an.connect(_audioCtx.destination); _srcNode = src;
    const buf = new Uint8Array(an.fftSize);
    const tick = () => {
      if (myseq !== _speakSeq) return;
      an.getByteTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      if (facial) facial.setMouth(Math.min(1, Math.sqrt(sum / buf.length) * gain));
      _rafSpeak = requestAnimationFrame(tick);
    };
    src.onended = () => { if (myseq === _speakSeq) stopSpeak(); };
    src.start(0);
    EnigmaAvatar.express("talk", opts.dur);       // talking body language alongside the mouth
    tick();
  } catch (e) {
    setStatus("say failed: " + (e?.message || e));
    if (myseq === _speakSeq) stopSpeak();
  }
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
  matched: () => (proc ? proc.matched : []),
  tune: (p) => { if (proc) proc.setParams(p); return proc ? proc.params : null; },
  state: () => ({ held, size: +sizeScale.toFixed(2), pos: [+pos.x.toFixed(2), +pos.y.toFixed(2)], over: cursor.over, vrm: !!vrm, clips: clipNames(), procBones: proc ? proc.matched : [], springBones: spring ? spring.names : [], facial: facial ? { mode: facial.mode, info: facial.info } : null, attachments: attachObjs.map((a) => ({ id: a.id, category: a.category, attachedTo: a.attachedTo })), toggles: { spring: springOn, idle: idleOn, facial: facialOn, look: lookOn, idleBehavior: idleBehaviorOn, locked, menu: menuShown } }),
  springTune: (p) => springTune(p),                                      // saved per-avatar (hair flow, etc.)
  express: (type, dur) => { if (proc) proc.setExpression(type, dur); },   // AI-driven emote (talk/happy/wag/…)
  lookTune: (p) => Object.assign(LOOK, p),                               // tune/flip cursor-look (gainX/Y, flipX/Y, maxX/Y)
  facialTune: (p) => facialTune(p),                                      // saved per-avatar (jaw axis/open)
  mouth: (a) => { if (facial) facial.setMouth(a); },                      // 0..1 jaw/mouth open
  say: (url, opts) => speak(url, opts),                                   // play speech audio + lip-sync
  stopSpeak: () => stopSpeak(),
  attach: (url, opts) => attachMesh(url, opts),                           // prop/accessory → bone (opts: bone,pos,rot,scale)
  detach: (id) => detachAttachment(id),
  clearAttachments: () => clearAttachments(),
  attachments: () => attachObjs.map((a) => ({ id: a.id, category: a.category, url: a.url, bone: a.bone, attachedTo: a.attachedTo, pos: a.pos, rot: a.rot, scale: a.scale })),
  tuneAttachment: (id, opts) => tuneAttachment(id, opts),                 // live placement: {bone,pos:[x,y,z],rot:[deg],scale}
  bones: () => { const out = []; model?.traverse((o) => { if (o.isBone) out.push(o.name); }); return out; },   // names to target
  showSkeleton: (on) => showSkeleton(on),                                 // overlay the rig to inspect bones; persists
  bonesShown: () => bonesShown,
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
  else if (c.action === "recolor" && c.name) EnigmaAvatar.recolor(c.name, c.color || c.hex);   // tint a material
  else if (c.action === "hue" && c.name) EnigmaAvatar.hueShift(c.name, c.deg ?? c.value ?? 0);  // rotate a material's hue
}
window.EnigmaAvatar = EnigmaAvatar;
window.__AV = { THREE, scene, camera, rig, getModel: () => model };

// --- right-click menu (toggles + quick actions) -----------------------------
const BUILTIN_MODELS = [
  { id: "roxanne", url: MODELS["1"], label: "Roxanne" },
  { id: "toothless", url: MODELS["2"], label: "Night Fury" },
  { id: "glados", url: MODELS["3"], label: "GLaDOS" },
];
let MODEL_LIST = BUILTIN_MODELS.slice();           // built-ins + user models from models.json (loaded below)
function refreshModelList() {
  return fetch("./models.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const seen = new Set(BUILTIN_MODELS.map((m) => m.url));
      const extra = (j?.models || []).filter((m) => m?.url && !seen.has(m.url)).map((m) => ({ id: m.id, url: m.url, label: m.label || m.id }));
      MODEL_LIST = BUILTIN_MODELS.concat(extra);
      if (menuShown) rebuildMenu();
    })
    .catch(() => {});
}
// Import a new avatar. In Electron: a native open dialog that copies the files
// into models/ and registers them (handles .glb/.gltf/.vrm/.fbx AND .unitypackage
// via import_unitypackage.py). In a plain browser: the OS file picker (same as drag-drop).
async function addModel() {
  hideMenu();
  if (window.avatarIPC?.importModel) {
    setStatus("importing model…");
    try {
      const res = await window.avatarIPC.importModel();
      if (!res) { setStatus("import cancelled"); return; }
      if (res.error) { setStatus("import failed: " + res.error); return; }
      await refreshModelList();
      loadModel(res.url, res.label);
    } catch (e) { setStatus("import failed: " + (e?.message || e)); }
  } else {
    document.getElementById("file")?.click();
  }
}
// Attach a prop/accessory. Electron: native picker → copied into props/ (persists).
// Browser: a file picker (session-only blob). Lands on the right hand by default;
// re-place with EnigmaAvatar.tuneAttachment(id, {bone, pos:[x,y,z], rot:[deg], scale}).
let _propCategory = "prop";
async function addAttachment(category) {
  _propCategory = category; hideMenu();
  if (window.avatarIPC?.importProp) {
    setStatus(`importing ${category}…`);
    try {
      const res = await window.avatarIPC.importProp();
      if (!res) { setStatus("import cancelled"); return; }
      if (res.error) { setStatus("import failed: " + res.error); return; }
      attachMesh(res.url, { category });
    } catch (e) { setStatus("import failed: " + (e?.message || e)); }
  } else {
    _propInput.click();
  }
}
const _propInput = document.createElement("input");
_propInput.type = "file"; _propInput.accept = ".glb,.gltf,.vrm,.fbx"; _propInput.style.display = "none";
document.body.appendChild(_propInput);
_propInput.addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) attachMesh(URL.createObjectURL(f), { category: _propCategory, kind: kindOf(f.name) }); });
const EMOTES = ["happy", "talk", "wag", "nod", "alert", "sad", "shake"];

const syncInteractive = () => window.avatarIPC?.setInteractive?.(menuShown || settingsShown || cursor.over || held);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// A plain, OS-style context menu (no glass / emoji / switches).
const MENU_CSS =
  "position:fixed;z-index:50;min-width:188px;background:rgba(38,38,41,.98);border:1px solid rgba(255,255,255,.13);" +
  "border-radius:8px;padding:4px;box-shadow:0 9px 28px rgba(0,0,0,.5);font:13px/1.25 'Segoe UI',system-ui,sans-serif;color:#f0f0f0;user-select:none;";
const menu = document.createElement("div");
menu.id = "avmenu"; menu.style.cssText = MENU_CSS + "display:none;";
document.body.appendChild(menu);

const menuSep = () => { const d = document.createElement("div"); d.style.cssText = "height:1px;background:rgba(255,255,255,.1);margin:4px 8px;"; return d; };
const menuRow = (label, o = {}) => {
  const d = document.createElement("div");
  d.style.cssText = "position:relative;display:flex;align-items:center;padding:6px 12px 6px 28px;border-radius:5px;white-space:nowrap;cursor:default;" + (o.danger ? "color:#ff8a8a;" : "");
  if (o.dot) { const m = document.createElement("span"); m.textContent = "●"; m.style.cssText = "position:absolute;left:11px;font-size:9px;color:#6fc3ff;"; d.appendChild(m); }
  else if (o.check) { const m = document.createElement("span"); m.textContent = "✓"; m.style.cssText = "position:absolute;left:10px;"; d.appendChild(m); }
  const lab = document.createElement("span"); lab.textContent = label; lab.style.flex = "1"; d.appendChild(lab);
  if (o.accel) { const a = document.createElement("span"); a.textContent = o.accel; a.style.cssText = "opacity:.42;font-size:11px;padding-left:24px;"; d.appendChild(a); }
  if (o.arrow) { const a = document.createElement("span"); a.textContent = "❯"; a.style.cssText = "opacity:.5;font-size:10px;padding-left:18px;"; d.appendChild(a); }
  d.onmouseenter = () => (d.style.background = "rgba(255,255,255,.13)");
  d.onmouseleave = () => (d.style.background = "transparent");
  if (o.onClick) d.onclick = (ev) => { ev.stopPropagation(); o.onClick(); };
  return d;
};
const submenu = (label, items) => {
  const wrap = document.createElement("div"); wrap.style.position = "relative";
  wrap.appendChild(menuRow(label, { arrow: true }));
  const fly = document.createElement("div"); fly.style.cssText = MENU_CSS + "display:none;position:absolute;top:-5px;left:100%;margin-left:3px;";
  for (const it of items) fly.appendChild(menuRow(it.label, { check: it.check, onClick: it.onClick }));
  wrap.appendChild(fly);
  let t;
  wrap.onmouseenter = () => {
    clearTimeout(t); fly.style.display = "block";
    fly.style.left = "100%"; fly.style.right = "auto"; fly.style.marginLeft = "3px"; fly.style.marginRight = "0";
    const r = fly.getBoundingClientRect();
    if (r.right > innerWidth - 4) { fly.style.left = "auto"; fly.style.right = "100%"; fly.style.marginLeft = "0"; fly.style.marginRight = "3px"; }
  };
  wrap.onmouseleave = () => { t = setTimeout(() => (fly.style.display = "none"), 130); };
  return wrap;
};

// --- Settings dialog (normal OS form controls) ------------------------------
const settings = document.createElement("div");
settings.id = "avsettings";
settings.style.cssText =
  "position:fixed;z-index:60;display:none;width:268px;background:rgba(38,38,41,.99);border:1px solid rgba(255,255,255,.14);" +
  "border-radius:10px;box-shadow:0 16px 46px rgba(0,0,0,.55);font:13px/1.35 'Segoe UI',system-ui,sans-serif;color:#eee;user-select:none;";
document.body.appendChild(settings);

const sRow = (label, control) => { const r = document.createElement("div"); r.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;"; const l = document.createElement("span"); l.textContent = label; l.style.opacity = ".9"; r.append(l, control); return r; };
const sCheck = (label, on, set) => { const r = document.createElement("label"); r.style.cssText = "display:flex;align-items:center;gap:9px;padding:6px 0;cursor:pointer;"; const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = on; cb.onchange = (e) => { e.stopPropagation(); set(cb.checked); }; const t = document.createElement("span"); t.textContent = label; r.append(cb, t); return r; };
function buildSettings() {
  settings.innerHTML = "";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.1);";
  head.innerHTML = `<span style="font-weight:600">Avatar Settings</span>`;
  const x = document.createElement("button"); x.textContent = "✕"; x.style.cssText = "border:0;background:transparent;color:#bbb;font-size:14px;line-height:1;cursor:pointer;padding:2px 4px;";
  x.onclick = (e) => { e.stopPropagation(); hideSettings(); };
  head.appendChild(x); settings.appendChild(head);
  const body = document.createElement("div"); body.style.cssText = "padding:8px 14px 14px;"; settings.appendChild(body);

  const sel = document.createElement("select");
  for (const m of MODEL_LIST) { const o = document.createElement("option"); o.value = m.url; o.textContent = m.label; if (m.url === curKey) o.selected = true; sel.appendChild(o); }
  sel.onchange = (e) => { e.stopPropagation(); const m = MODEL_LIST.find((x) => x.url === sel.value); loadModel(sel.value, m?.label); };
  body.appendChild(sRow("Model", sel));

  const sz = document.createElement("input"); sz.type = "range"; sz.min = "0.05"; sz.max = "5"; sz.step = "0.05"; sz.value = String(sizeScale); sz.style.flex = "1";
  const szv = document.createElement("span"); szv.textContent = sizeScale.toFixed(2) + "×"; szv.style.cssText = "opacity:.6;font-size:11px;min-width:36px;text-align:right;";
  sz.oninput = (e) => { e.stopPropagation(); applySize(parseFloat(sz.value)); szv.textContent = sizeScale.toFixed(2) + "×"; };
  const szRow = sRow("Size", sz); szRow.appendChild(szv); body.appendChild(szRow);

  // Hair/tail physics — tuned live and saved into this avatar's profile. (Mal0's
  // default is wild; raise damping / lower gravity for flow. Breeze affects only
  // opaque/geometric rigs like Toothless.)
  const sp = () => profileFor(curKey).spring || {};
  const springSlider = (label, key, min, max, step, dflt) => {
    const r = document.createElement("input"); r.type = "range"; r.min = min; r.max = max; r.step = step;
    r.value = String(sp()[key] ?? dflt); r.style.flex = "1";
    r.oninput = (e) => { e.stopPropagation(); springTune({ [key]: parseFloat(r.value) }); };
    body.appendChild(sRow(label, r));
  };
  springSlider("Hair stiffness", "stiffness", "0.04", "0.5", "0.01", 0.14);
  springSlider("Hair damping", "drag", "0.1", "0.95", "0.01", 0.5);
  springSlider("Hair gravity", "gravity", "-6", "0", "0.1", -3.0);
  springSlider("Hair breeze", "breeze", "0", "0.6", "0.02", 0.16);

  // Colors — tint each material (the color multiplies its texture); saved per avatar.
  const mats = modelMaterials();
  if (mats.size) {
    const cr = document.createElement("div"); cr.style.cssText = "height:1px;background:rgba(255,255,255,.1);margin:8px 0;"; body.appendChild(cr);
    const ch = document.createElement("div"); ch.textContent = "Colors (tint per part)"; ch.style.cssText = "opacity:.6;font-size:11px;margin-bottom:2px;"; body.appendChild(ch);
    const saved = profileFor(curKey).colors || {};
    const savedHue = profileFor(curKey).hue || {};
    for (const [name, m] of mats) {
      const c = document.createElement("input"); c.type = "color";
      c.value = saved[name] || ("#" + (m.color ? m.color.getHexString(THREE.SRGBColorSpace) : "ffffff"));
      c.oninput = (e) => { e.stopPropagation(); recolor(name, c.value); };
      const h = document.createElement("input"); h.type = "range"; h.min = "0"; h.max = "360"; h.step = "5"; h.value = String(savedHue[name] || 0); h.title = "hue rotate"; h.style.flex = "1";
      h.oninput = (e) => { e.stopPropagation(); hueShift(name, parseFloat(h.value)); };
      const wrap = document.createElement("div"); wrap.style.cssText = "display:flex;gap:6px;align-items:center;flex:1;"; wrap.append(c, h);
      body.appendChild(sRow(name, wrap));
    }
  }

  const hr = document.createElement("div"); hr.style.cssText = "height:1px;background:rgba(255,255,255,.1);margin:8px 0;"; body.appendChild(hr);
  body.appendChild(sCheck("Spring physics", springOn, (v) => (springOn = v)));
  body.appendChild(sCheck("Idle motion", idleOn, (v) => (idleOn = v)));
  body.appendChild(sCheck("Look at cursor", lookOn, (v) => (lookOn = v)));
  body.appendChild(sCheck("Idle behavior (random emotes)", idleBehaviorOn, (v) => (idleBehaviorOn = v)));
  body.appendChild(sCheck("Face (blink / lip-sync)", facialOn, (v) => (facialOn = v)));
  body.appendChild(sCheck("Lock in place", locked, (v) => (locked = v)));
  body.appendChild(sCheck("Show skeleton (inspect bones)", bonesShown, (v) => showSkeleton(v)));
  const panelOn = !document.getElementById("ui")?.classList.contains("hidden");
  body.appendChild(sCheck("Show info panel", panelOn, (v) => document.getElementById("ui")?.classList.toggle("hidden", !v)));

  // --- Fit attachment (props / clothes / furniture): place the selected item ---
  if (attachObjs.length) {
    const fr = document.createElement("div"); fr.style.cssText = "height:1px;background:rgba(255,255,255,.1);margin:8px 0;"; body.appendChild(fr);
    const fh = document.createElement("div"); fh.textContent = "Fit attachment"; fh.style.cssText = "opacity:.6;font-size:11px;margin-bottom:2px;"; body.appendChild(fh);
    const sel = document.createElement("select");
    for (const a of attachObjs) { const o = document.createElement("option"); o.value = a.id; o.textContent = `${a.category}: ${baseName(a.url)}`; sel.appendChild(o); }
    body.appendChild(sRow("Item", sel));
    const fitBox = document.createElement("div"); body.appendChild(fitBox);
    const BTN = "padding:3px 8px;background:rgba(255,255,255,.08);color:#eee;border:1px solid rgba(255,255,255,.15);border-radius:4px;cursor:pointer;font:12px system-ui;";
    const BONES = ["righthand", "lefthand", "head", "neck", "back", "hips", "tail", "rightfoot", "leftfoot", ""];
    const renderFit = () => {
      fitBox.innerHTML = "";
      const a = attachObjs.find((x) => x.id === sel.value); if (!a) return;
      const bsel = document.createElement("select");
      for (const b of BONES) { const o = document.createElement("option"); o.value = b; o.textContent = b || "(world / no bone)"; if (b === a.bone) o.selected = true; bsel.appendChild(o); }
      bsel.onchange = (e) => { e.stopPropagation(); tuneAttachment(a.id, { bone: bsel.value }); };
      fitBox.appendChild(sRow("Bone", bsel));
      const scRow = document.createElement("div"); scRow.style.cssText = "display:flex;gap:5px;align-items:center;";
      const scVal = document.createElement("span"); scVal.textContent = "×" + a.scale.toFixed(4); scVal.style.cssText = "flex:1;font-size:11px;opacity:.7;text-align:right;";
      const scBtn = (lab, f) => { const b = document.createElement("button"); b.textContent = lab; b.style.cssText = BTN; b.onclick = (e) => { e.stopPropagation(); tuneAttachment(a.id, { scale: +(a.scale * f).toFixed(5) }); scVal.textContent = "×" + a.scale.toFixed(4); }; return b; };
      scRow.append(scVal, scBtn("−", 1 / 1.2), scBtn("+", 1.2)); fitBox.appendChild(sRow("Scale", scRow));
      ["x", "y", "z"].forEach((axis, i) => {
        const r = document.createElement("input"); r.type = "range"; r.min = "-180"; r.max = "180"; r.step = "1"; r.value = String(a.rot[i] || 0); r.style.flex = "1";
        r.oninput = (e) => { e.stopPropagation(); const rot = a.rot.slice(); rot[i] = parseFloat(r.value); tuneAttachment(a.id, { rot }); };
        fitBox.appendChild(sRow("Rotate " + axis.toUpperCase(), r));
      });
      const nudge = document.createElement("div"); nudge.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
      [["X−", 0, -1], ["X+", 0, 1], ["Y−", 1, -1], ["Y+", 1, 1], ["Z−", 2, -1], ["Z+", 2, 1]].forEach(([lab, ax, dir]) => {
        const b = document.createElement("button"); b.textContent = lab; b.style.cssText = BTN + "flex:1;min-width:30px;";
        b.onclick = (e) => {
          e.stopPropagation();
          const v = new THREE.Vector3(); a.obj?.parent?.getWorldScale(v);     // step ≈ 4% of avatar height, in bone-local units
          const stepLocal = (0.04 * BASE_H * (rig.scale.x || 1)) / (((v.x + v.y + v.z) / 3) || 1);
          const pos = a.pos.slice(); pos[ax] = +(pos[ax] + dir * stepLocal).toFixed(4); tuneAttachment(a.id, { pos });
        };
        nudge.appendChild(b);
      });
      fitBox.appendChild(sRow("Move", nudge));
    };
    sel.onchange = (e) => { e.stopPropagation(); renderFit(); };
    renderFit();
  }
}
function showSettings() {
  buildSettings();
  settings.style.display = "block";
  const r = settings.getBoundingClientRect();
  settings.style.left = Math.max(6, Math.round(innerWidth / 2 - r.width / 2)) + "px";
  settings.style.top = Math.max(6, Math.round(innerHeight / 2 - r.height / 2)) + "px";
  settingsShown = true; syncInteractive();
}
function hideSettings() { if (!settingsShown) return; settings.style.display = "none"; settingsShown = false; syncInteractive(); }

function rebuildMenu() {
  menu.innerHTML = "";
  for (const m of MODEL_LIST) menu.appendChild(menuRow(m.label, { dot: curKey === m.url, onClick: () => { loadModel(m.url, m.label); hideMenu(); } }));
  menu.appendChild(menuRow("Add model…", { onClick: () => addModel() }));
  menu.appendChild(submenu("Add to avatar", [
    { label: "Clothing…", onClick: () => addAttachment("clothes") },
    { label: "Prop…", onClick: () => addAttachment("prop") },
    { label: "Furniture…", onClick: () => addAttachment("furniture") },
  ]));
  if (attachObjs.length) menu.appendChild(submenu(`Remove (${attachObjs.length})`, attachObjs
    .map((a) => ({ label: `${a.category}: ${baseName(a.url)}`, onClick: () => { detachAttachment(a.id); hideMenu(); } }))
    .concat([{ label: "— all —", onClick: () => { clearAttachments(); hideMenu(); } }])));
  menu.appendChild(menuSep());
  menu.appendChild(submenu("Express", EMOTES.map((e) => ({ label: cap(e), onClick: () => EnigmaAvatar.express(e) }))));   // fire several; flyout stays open
  menu.appendChild(submenu("Size", [
    { label: "Bigger", onClick: () => resizeBy(1.1) },
    { label: "Smaller", onClick: () => resizeBy(1 / 1.1) },
    { label: "Reset", onClick: () => applySize(DEFAULT_SIZE) },
  ]));
  menu.appendChild(menuSep());
  menu.appendChild(menuRow("Settings…", { onClick: () => { hideMenu(); showSettings(); } }));
  if (window.avatarIPC?.quit) { menu.appendChild(menuSep()); menu.appendChild(menuRow("Quit avatar", { accel: "Ctrl+Alt+Q", danger: true, onClick: () => window.avatarIPC.quit() })); }
}
function showMenu(x, y) {
  rebuildMenu();
  menu.style.display = "block";
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + "px";
  menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + "px";
  menuShown = true; syncInteractive();
}
function hideMenu() { if (!menuShown) return; menu.style.display = "none"; menuShown = false; syncInteractive(); }
addEventListener("contextmenu", (e) => {
  if (e.target instanceof Node && (menu.contains(e.target) || settings.contains(e.target))) { e.preventDefault(); return; }
  cursor.x = e.clientX; cursor.y = e.clientY; computeOver();
  if (cursor.over) { e.preventDefault(); hideSettings(); showMenu(e.clientX, e.clientY); }
});
addEventListener("keydown", (e) => { if (e.key === "Escape") { if (settingsShown) hideSettings(); else hideMenu(); } });

// --- input (drag to reposition; NO hand cursor; NO fall) --------------------
addEventListener("resize", () => { renderer.setSize(innerWidth, innerHeight); frameCamera(); });
addEventListener("wheel", (e) => { if (cursor.over) resizeBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); }, { passive: true });
addEventListener("pointermove", (e) => { cursor.x = e.clientX; cursor.y = e.clientY; computeOver(); });
addEventListener("pointerdown", (e) => {
  if (e.target instanceof Node && (menu.contains(e.target) || settings.contains(e.target))) return;  // clicking a popup's own controls
  const wasOpen = menuShown || settingsShown;
  hideMenu(); hideSettings();                                   // any outside click dismisses popups
  if (wasOpen) return;                                          // the dismiss click shouldn't also grab
  computeOver();
  if (cursor.over && !locked) { held = true; grab.copy(toWorld(cursor.x, cursor.y).sub(pos)); _downX = cursor.x; _downY = cursor.y; } else { _downX = -999; }
});
addEventListener("pointerup", (e) => {
  // a click/pet (pressed on the avatar, released with minimal movement) → happy reaction
  if (held && _downX > -100 && Math.abs(e.clientX - _downX) < 6 && Math.abs(e.clientY - _downY) < 6) {
    EnigmaAvatar.express(Math.random() < 0.5 ? "happy" : "wag", 1.6);
  }
  held = false; fpClock = 1; _downX = -999;   // re-scan the silhouette at the new spot
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
  loadAsset(url, (a) => { URL.revokeObjectURL(url); onModelLoaded(a); },
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
  loadAsset(map[main.name], (a) => { cleanup(); onModelLoaded(a); },
            (err) => { cleanup(); setStatus(`load failed: ${err?.message || err}`); }, { kind: kindOf(main.name), blobMap: map });
}
document.getElementById("file")?.addEventListener("change", (e) => { if (e.target.files?.length) loadFiles(e.target.files); });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files); });

// --- go ---------------------------------------------------------------------
applySize(sizeScale);
animate();
// Load per-avatar profiles + the model list first, THEN the default model — so its
// saved attachments and tuned physics apply on the very first load.
Promise.allSettled([loadProfiles(), refreshModelList()]).then(() => loadModel(DEFAULT_MODEL, "default model"));

// In the desktop overlay, connect to the local AI bus (see mods/avatar/bus.py)
// so Enigma/Odysseus can drive emotes — the tail wags when it talks. A plain
// browser preview has no bus and no avatarIPC, so we skip it there to avoid
// console spam from failed sockets (test it manually with EnigmaAvatar.connect()).
if (window.avatarIPC) EnigmaAvatar.connect();
