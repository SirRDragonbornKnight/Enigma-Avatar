// loader.js — multi-format asset loading for the avatar engine.
// glTF/GLB, VRM (glTF + VRM plugin), and FBX. Each load gets its OWN LoadingManager so
// concurrent/rapid model switches never share texture-resolution state. The manager
// decodes .tga (FBX/Unity textures are usually TGA). For FBX, texture lookups are forced
// into the model's own folder by basename — so the flat folders import_unitypackage.py
// produces resolve no matter what path a DCC tool baked in. glTF keeps its own (correct)
// relative paths (textures/ subfolders). Hands back a normalized { scene, animations, vrm }.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { TGALoader } from "three/addons/loaders/TGALoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const TEX_RE = /\.(tga|png|jpe?g|webp|bmp|gif|ktx2|basis|dds)(\?.*)?$/i;
export const baseName = (u) => u.split(/[?#]/)[0].split(/[\\/]/).pop();
export const kindOf = (url) => { const u = url.split(/[?#]/)[0].toLowerCase(); return u.endsWith(".fbx") ? "fbx" : u.endsWith(".vrm") ? "vrm" : "gltf"; };

// three.js r150+ REMOVED KHR_materials_pbrSpecularGlossiness support, so a model
// authored ONLY in spec-gloss (common in Sketchfab rips — e.g. Toy Chica: all 14
// materials, no metallic-roughness fallback) renders flat GREY: its base colour and
// diffuse texture live under that extension and the core loader ignores them. This
// minimal compat plugin re-binds diffuseFactor → material colour and diffuseTexture →
// material.map (glossiness → roughness approx). Harmless for models that don't use it.
function specGlossCompat(parser) {
  const NAME = "KHR_materials_pbrSpecularGlossiness";
  return {
    name: NAME,                                              // exact name → also silences the "Unknown extension" warning
    extendMaterialParams(materialIndex, materialParams) {
      const sg = parser.json.materials?.[materialIndex]?.extensions?.[NAME];
      if (!sg) return Promise.resolve();
      const pending = [];
      if (Array.isArray(sg.diffuseFactor)) {
        materialParams.color = new THREE.Color().setRGB(sg.diffuseFactor[0], sg.diffuseFactor[1], sg.diffuseFactor[2], THREE.LinearSRGBColorSpace);
        if (sg.diffuseFactor[3] != null) materialParams.opacity = sg.diffuseFactor[3];
      }
      materialParams.metalness = 0;                          // spec-gloss is non-metal by construction
      materialParams.roughness = sg.glossinessFactor != null ? 1 - sg.glossinessFactor : 0.6;
      if (sg.diffuseTexture) pending.push(parser.assignTexture(materialParams, "map", sg.diffuseTexture, THREE.SRGBColorSpace));
      return Promise.all(pending);
    },
  };
}

// Load any supported format; hand back a normalized { scene, animations, vrm }.
// opts: { kind, resourceDir, blobMap } — all optional; blobMap resolves multi-file
// drag-drop refs by basename. No module-level load state → no cross-load races.
export function loadAsset(url, onOk, onErr, opts = {}) {
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
    gl.register((parser) => specGlossCompat(parser));       // re-bind spec-gloss colour/texture (three.js r150+ dropped it)
    gl.load(url, (g) => {
      const vrm = g.userData?.vrm || null;
      if (vrm) { VRMUtils.removeUnnecessaryJoints?.(vrm.scene); vrm.scene.rotation.y = Math.PI; }   // VRM faces -Z → turn to camera
      onOk({ scene: vrm ? vrm.scene : (g.scene || g.scenes?.[0]), animations: g.animations || [], vrm });
    }, undefined, onErr);
  }
}

// FBX from Unity/VRChat ships materials with NO textures (bindings live in .mat files).
// import_unitypackage.py writes a materials.json next to the mesh mapping each FBX
// material name → { map, normalMap } texture files; re-attach them here.
async function applyFbxMaterials(root, dir, mgr) {
  if (!dir) return;                                   // only disk loads have a sidecar
  let spec;
  try { const r = await fetch(dir + "materials.json", { cache: "no-store" }); if (!r.ok) return; spec = await r.json(); } catch { return; }
  if (!spec || typeof spec !== "object") return;
  const texLoader = new THREE.TextureLoader(mgr);
  const cache = {};
  const tex = (file, srgb) => {                       // key by (file, srgb): the same file used as a colour map AND
    const key = file + "|" + (srgb ? "s" : "l");      // a normal/data map needs two textures in different colour spaces.
    if (!(key in cache)) {                            // .tga must go through the manager's TGALoader, not TextureLoader.
      const t = (mgr.getHandler(file) || texLoader).load(dir + file);
      if (t && "colorSpace" in t) t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
      cache[key] = t;
    }
    return cache[key];
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
