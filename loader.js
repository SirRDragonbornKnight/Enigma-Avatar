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
// Map a URL to the loader that handles it. glTF/GLB/VRM -> GLTFLoader; FBX -> FBXLoader.
// Anything else (.obj/.dae/...) has NO loader here -> "unsupported", so loadAsset fails
// honestly instead of feeding the file to GLTFLoader and dying on "not valid JSON".
// (blob:/data: URLs carry no extension; only an explicit opts.kind can name them.)
export const kindOf = (url) => {
  const u = url.split(/[?#]/)[0].toLowerCase();
  if (u.endsWith(".fbx")) return "fbx";
  if (u.endsWith(".vrm")) return "vrm";
  if (u.endsWith(".glb") || u.endsWith(".gltf")) return "gltf";
  if (/^blob:|^data:/.test(url)) return "gltf"; // no extension to read; assume glTF unless opts.kind says otherwise
  return "unsupported";
};
const extOf = (url) => {
  const u = url.split(/[?#]/)[0].toLowerCase();
  const i = u.lastIndexOf(".");
  return i >= 0 ? u.slice(i) : "";
};

// three.js r150+ REMOVED KHR_materials_pbrSpecularGlossiness support, so a model
// authored ONLY in spec-gloss (common in Sketchfab rips — e.g. Toy Chica: all 14
// materials, no metallic-roughness fallback) renders flat GREY: its base colour and
// diffuse texture live under that extension and the core loader ignores them. This
// minimal compat plugin re-binds the DIFFUSE side (diffuseFactor → colour, diffuseTexture
// → map, glossinessFactor → roughness approx) so the model is COLOURED, not grey. It does
// NOT transcode the specular side (see the NOTE in the body) — highlights are approximate.
// Harmless for models that don't use the extension.
function specGlossCompat(parser) {
  const NAME = "KHR_materials_pbrSpecularGlossiness";
  return {
    name: NAME, // exact name → also silences the "Unknown extension" warning
    extendMaterialParams(materialIndex, materialParams) {
      const mat = parser.json.materials?.[materialIndex];
      const sg = mat?.extensions?.[NAME];
      if (!sg) return Promise.resolve();
      const pending = [];
      if (Array.isArray(sg.diffuseFactor)) {
        materialParams.color = new THREE.Color().setRGB(
          sg.diffuseFactor[0],
          sg.diffuseFactor[1],
          sg.diffuseFactor[2],
          THREE.LinearSRGBColorSpace
        );
        // diffuseFactor[3] is the base alpha. The core loader sets `transparent` from alphaMode but
        // takes opacity from the (absent) metallic-roughness baseColor, so a translucent spec-gloss
        // material would otherwise render fully OPAQUE. Supply opacity, and only force the transparent
        // pass when the author actually asked for blending (so an OPAQUE material isn't mis-sorted).
        if (sg.diffuseFactor[3] != null && mat.alphaMode && mat.alphaMode !== "OPAQUE") {
          materialParams.opacity = sg.diffuseFactor[3];
          if (mat.alphaMode === "BLEND") materialParams.transparent = true;
        }
      }
      materialParams.metalness = 0; // spec-gloss is non-metal by construction
      materialParams.roughness = sg.glossinessFactor != null ? 1 - sg.glossinessFactor : 0.6;
      if (sg.diffuseTexture)
        pending.push(parser.assignTexture(materialParams, "map", sg.diffuseTexture, THREE.SRGBColorSpace));
      // NOTE: specularFactor and specularGlossinessTexture are NOT converted — MeshStandardMaterial has
      // no specular-colour input, and the spec-gloss texture packs glossiness in its ALPHA channel (a
      // faithful map would need an offscreen channel-swap into a roughnessMap). Base colour + diffuse
      // map (the flat-grey fix) are exact; per-texel glossiness/specular tint is the remaining gap.
      return Promise.all(pending);
    },
  };
}

// Load any supported format; hand back a normalized { scene, animations, vrm }.
// opts: { kind, resourceDir, blobMap } — all optional; blobMap resolves multi-file
// drag-drop refs by basename. No module-level load state → no cross-load races.
export function loadAsset(url, onOk, onErr, opts = {}) {
  // Normalize EXACTLY as the browser URL parser will, BEFORE any guard runs: it strips ASCII tab/newline/
  // CR from anywhere in the URL and trims leading/trailing C0-control+space. Checking the raw string would
  // let " https://evil/x.glb" or "ht\ttps://..." slip past the remote block and still get FETCHED (what we
  // CHECK must equal what the loader LOADS). Harmless for file://, blob:, data:, and local paths.
  /* eslint-disable no-control-regex -- deliberately strips C0 control chars so what we CHECK equals what we LOAD (security) */
  url = String(url)
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
  /* eslint-enable no-control-regex */
  // SECURITY: the bus is the driver and any local process can send {action:"load",url}. Block REMOTE
  // fetch by default — a bus message must not make the overlay pull an arbitrary http(s) URL. Local
  // paths, file://, blob:, data: all pass, so the external models dir (C:\Users\SirKn\3d Avatar\
  // Avatars\) keeps loading with no path restriction. (Set opts.allowRemote to opt in explicitly.)
  if (!opts.allowRemote && /^https?:/i.test(url)) {
    onErr?.(new Error("remote URL load blocked (local files only)"));
    return;
  }
  const kind = opts.kind || kindOf(url);
  if (kind === "unsupported") {
    // HONEST failure — no loader for this format (.obj/.dae/...)
    onErr?.(new Error(`unsupported format: ${extOf(url) || "(no extension)"} -- only glTF/GLB/VRM/FBX are loadable`));
    return;
  }
  const dir = opts.resourceDir ?? (!/^blob:|^data:/.test(url) ? url.slice(0, url.lastIndexOf("/") + 1) : "");
  const onWarn = opts.onWarn || ((e) => window.avatarIPC?.log?.(`[loader] FBX bind: ${(e && e.message) || e}`));
  const mgr = new THREE.LoadingManager();
  mgr.addHandler(/\.tga$/i, new TGALoader(mgr));
  if (opts.blobMap) {
    // multi-file drag-drop: resolve every ref by basename
    mgr.setURLModifier((u) => opts.blobMap[baseName(u)] || u);
  } else if (kind === "fbx" && dir) {
    // FBX: force texture refs into the model's folder
    mgr.setURLModifier((u) => (!/^blob:|^data:/.test(u) && TEX_RE.test(u) ? dir + baseName(u) : u));
  }
  if (kind === "fbx") {
    const fbx = opts._fbxLoaderFactory ? opts._fbxLoaderFactory(mgr) : new FBXLoader(mgr); // seam: tests inject a fake loader
    fbx.load(
      url,
      async (obj) => {
        // FBX has no embedded textures — bind them from materials.json. Surface ANY binding
        // problem (missing sidecar, per-texture load failure) instead of black-holing it.
        try {
          const probs = await applyFbxMaterials(obj, dir, mgr);
          for (const p of probs) onWarn(p);
        } catch (e) {
          onWarn(e);
        }
        try {
          onOk({ scene: obj, animations: obj.animations || [], vrm: null });
        } catch (e) {
          onErr?.(e);
        } // FBX onLoad is async -> a throw in onOk escapes as an unhandled rejection (never reaches onErr); route it to the honest-failure path
      },
      undefined,
      onErr
    );
  } else {
    const gl = new GLTFLoader(mgr);
    gl.register((parser) => new VRMLoaderPlugin(parser)); // fills gltf.userData.vrm when it's a VRM
    gl.register((parser) => specGlossCompat(parser)); // re-bind spec-gloss colour/texture (three.js r150+ dropped it)
    gl.load(
      url,
      (g) => {
        const vrm = g.userData?.vrm || null;
        if (vrm) {
          VRMUtils.removeUnnecessaryJoints?.(vrm.scene);
          vrm.scene.rotation.y = Math.PI;
        } // VRM faces -Z → turn to camera
        onOk({ scene: vrm ? vrm.scene : g.scene || g.scenes?.[0], animations: g.animations || [], vrm });
      },
      undefined,
      onErr
    );
  }
}

// FBX from Unity/VRChat ships materials with NO textures (bindings live in .mat files).
// import_unitypackage.py writes a materials.json next to the mesh mapping each FBX
// material name → { map, normalMap } texture files; re-attach them here.
// Returns an array of Error problems (empty = clean). Does NOT throw for the common
// "untextured FBX, no sidecar" case — that's reported as a single honest warning so the
// caller can surface it instead of silently claiming a clean load.
export async function applyFbxMaterials(root, dir, mgr) {
  const problems = [];
  // Does this FBX actually carry materials that WANT textures? An untextured prop legitimately
  // has none → no sidecar needed. A textured one with no materials.json is a real binding gap.
  let wantsTextures = false;
  root.traverse((o) => {
    if (o.isMesh && o.material) wantsTextures = true;
  });
  if (!dir) {
    // only disk loads have a sidecar
    if (wantsTextures) problems.push(new Error("FBX has materials but no resource dir -- textures cannot be bound"));
    return problems;
  }
  let spec;
  try {
    const r = await fetch(dir + "materials.json", { cache: "no-store" });
    if (!r.ok) {
      if (wantsTextures)
        problems.push(new Error(`no materials.json next to FBX (HTTP ${r.status}) -- materials render untextured`));
      return problems;
    }
    spec = await r.json();
  } catch (e) {
    problems.push(new Error(`materials.json unreadable: ${(e && e.message) || e}`));
    return problems;
  }
  if (!spec || typeof spec !== "object") {
    problems.push(new Error("materials.json is not a valid material map — ignored"));
    return problems;
  }
  const texLoader = new THREE.TextureLoader(mgr);
  const cache = {};
  const tex = (file, srgb) => {
    // key by (file, srgb): the same file used as a colour map AND
    const key = file + "|" + (srgb ? "s" : "l"); // a normal/data map needs two textures in different colour spaces.
    if (!(key in cache)) {
      // .tga must go through the manager's TGALoader, not TextureLoader.
      const t = (mgr.getHandler(file) || texLoader).load(
        dir + file,
        undefined,
        undefined,
        (err) => problems.push(new Error(`texture '${file}' failed to load: ${(err && err.message) || err}`)) // load() error callback — surface, don't swallow
      );
      if (t && "colorSpace" in t) t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
      cache[key] = t;
    }
    return cache[key];
  };
  let bound = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const e = m && m.name && spec[m.name];
      if (!e) continue;
      if (e.map) m.map = tex(e.map, true);
      if (e.normalMap) m.normalMap = tex(e.normalMap, false);
      m.needsUpdate = true;
      bound++;
    }
  });
  if (wantsTextures && bound === 0)
    problems.push(new Error("materials.json matched none of the FBX material names -- nothing bound"));
  return problems;
}
