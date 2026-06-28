// library.js — the model LIBRARY: pure-ish fs logic for discovering, importing, and removing
// models under models/. Extracted from main.js so it can be UNIT-TESTED with a temp dir (the
// riskiest code — folder scans + copies + the trash move — was previously untestable inside the
// Electron main process). main.js wires the real paths; tests/library.test.js wires a sandbox.
//
//   const lib = createLibrary({ modelsDir, manifestPath, runPython, scriptDir });
//
// Invariants enforced here (audit #4):
//   • NO bundled/built-in models (copyright) — models/ is the whole library; the launch default is
//     the procedural avatar (default_avatar.js). Any model is deletable.
//   • an import never clobbers an existing folder — it disambiguates the slug instead
//   • removeModel MOVES to models/_trash/ (recoverable) and only edits the manifest AFTER the move
//   • ids that aren't a clean basename are rejected (no `..`/separator path escapes)
//   • discovered URLs are percent-encoded so spaces/# in filenames don't break the loader
const fs = require("fs");
const path = require("path");

// HONEST coverage: only formats the loader can actually parse (loader.js: GLTFLoader for
// glTF/GLB/VRM, FBXLoader for FBX). There is NO OBJLoader/ColladaLoader, so .obj/.dae would
// fall through to GLTFLoader and die with a misleading "not valid JSON" — so they're excluded.
const MESH_EXT = new Set([".glb", ".gltf", ".vrm", ".fbx"]);
// NO bundled built-in models — the shipped repo must NOT reference third-party / copyrighted
// avatars. Every model is just a user-supplied folder under models/; the launch default is the
// procedural avatar (default_avatar.js) until a bespoke 3D avatar is made. Every model is deletable.
const SKIP_DIR = (n) => n.startsWith(".") || n.startsWith("_"); // _trash, _thumbs, dotfolders
const slug = (s) =>
  (s || "model")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "")
    .toLowerCase() || "model";
const title = (s) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
// a usable model id is a single clean path segment — reject separators / .. / empties (the renderer
// supplies ids, so this is the path-traversal backstop for delete + thumbnail writes).
const safeId = (id) => typeof id === "string" && id.length > 0 && id === path.basename(id) && !id.includes("..");
// build a relative model URL with each path segment percent-encoded (spaces / # / unicode safe)
const modelUrl = (id, mesh) => `./models/${encodeURIComponent(id)}/${encodeURIComponent(mesh)}`;
const thumbUrl = (id) => `./models/${encodeURIComponent(id)}/.thumb.png`;

function createLibrary({ modelsDir, manifestPath, runPython = null, scriptDir = __dirname } = {}) {
  function readManifest() {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      return m && typeof m === "object" ? m : {};
    } catch {
      return {};
    }
  }
  function writeManifest(m) {
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  }

  // The mesh inside a model folder: prefer scene.*, else <folder>.*, else the first mesh found.
  function meshInDir(dir) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const meshes = files.filter((f) => MESH_EXT.has(path.extname(f).toLowerCase()));
    if (!meshes.length) return null;
    const base = path.basename(dir).toLowerCase();
    return (
      meshes.find((f) => f.toLowerCase().startsWith("scene.")) ||
      meshes.find((f) => path.basename(f, path.extname(f)).toLowerCase() === base) ||
      meshes[0]
    );
  }

  // Scan models/ — the FOLDER is the library (no models.json drift). Each subfolder holding a mesh
  // is a model: label from the manifest (a user rename) → prettified folder name.
  function discoverModels() {
    const labels = {};
    const m = readManifest();
    for (const e of m.models || []) if (e && e.id) labels[e.id] = e.label;
    let dirs = [];
    try {
      dirs = fs
        .readdirSync(modelsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !SKIP_DIR(d.name))
        .map((d) => d.name);
    } catch {}
    const out = [];
    for (const id of dirs) {
      const mesh = meshInDir(path.join(modelsDir, id));
      if (!mesh) continue;
      out.push({
        id,
        builtin: false,
        label: labels[id] || title(id),
        url: modelUrl(id, mesh),
        thumb: fs.existsSync(path.join(modelsDir, id, ".thumb.png")) ? thumbUrl(id) : null,
      });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  function registerModel(id, label, url) {
    const m = readManifest();
    const models = Array.isArray(m.models) ? m.models : [];
    m.models = models.filter((x) => x && x.id !== id).concat([{ id, label, url }]);
    writeManifest(m);
  }

  // Rename a model: update only its manifest LABEL (cosmetic). The FOLDER stays the id, so model
  // URLs, the on-disk files, and per-avatar profiles (keyed by URL) are untouched — discoverModels()
  // just reads the new label next scan. id is basename-checked (path-traversal backstop).
  function renameModel(id, label) {
    if (!safeId(id)) return { error: "bad model id" };
    const name = String(label || "").trim();
    if (!name) return { error: "empty name" };
    const m = readManifest();
    const models = Array.isArray(m.models) ? m.models : [];
    const ex = models.find((x) => x && x.id === id);
    let url = ex ? ex.url : undefined;
    if (!url) {
      const mesh = meshInDir(path.join(modelsDir, id));
      if (mesh) url = modelUrl(id, mesh);
    }
    m.models = models.filter((x) => x && x.id !== id).concat([{ id, label: name, url }]);
    writeManifest(m);
    return { ok: true, id, label: name };
  }

  // A slug that does NOT already exist — so an import can never clobber a different user model that
  // happens to share a generic name (scene.glb).
  function freeSlug(base) {
    if (!fs.existsSync(path.join(modelsDir, base))) return base;
    for (let i = 2; i < 1000; i++) {
      const c = `${base}_${i}`;
      if (!fs.existsSync(path.join(modelsDir, c))) return c;
    }
    return `${base}_${Date.now()}`;
  }

  // Copy a set of files (a mesh + sibling assets, OR a .unitypackage) into models/<freeSlug>/ and
  // register a label. Shared by the native "Add model…" dialog AND drag-drop. → {id,label,url}|{error}.
  function importFiles(files, opts = {}) {
    if (!Array.isArray(files) || !files.length) return { error: "no files" };
    const pkg = files.find((f) => typeof f === "string" && f.toLowerCase().endsWith(".unitypackage"));
    if (pkg) {
      const base = slug(path.basename(pkg, path.extname(pkg)));
      if (!runPython) return { error: "unitypackage import unavailable here" };
      const r = runPython([path.join(scriptDir, "import_unitypackage.py"), pkg, "--name", base, "--register"]);
      if (r.status !== 0)
        return { error: "unitypackage import failed: " + (r.stderr || r.stdout || "").trim().split("\n").pop() };
      const mesh = meshInDir(path.join(modelsDir, base));
      if (mesh && opts.move !== false) {
        try {
          if (!path.resolve(pkg).toLowerCase().startsWith(path.resolve(modelsDir).toLowerCase()))
            fs.rmSync(pkg, { force: true });
        } catch {}
      } // moved into models/ → drop the source package
      return mesh
        ? { id: base, label: title(base), url: modelUrl(base, mesh), moved: true }
        : { error: "imported, but no mesh found" };
    }
    const mesh = files.find((f) => typeof f === "string" && MESH_EXT.has(path.extname(f).toLowerCase()));
    if (!mesh) return { error: "no .glb/.gltf/.vrm/.fbx among the files" };
    const stem = path.basename(mesh, path.extname(mesh));
    const name = freeSlug(slug(stem)); // never a built-in, never an existing folder
    const dest = path.join(modelsDir, name);
    try {
      fs.mkdirSync(dest, { recursive: true });
      for (const f of files) {
        try {
          fs.copyFileSync(f, path.join(dest, path.basename(f)));
        } catch {}
      }
    } catch (e) {
      return { error: "copy failed: " + (e && e.message) };
    }
    // the mesh itself MUST have landed — otherwise we'd register a model that can't load
    if (!fs.existsSync(path.join(dest, path.basename(mesh)))) {
      try {
        fs.rmSync(dest, { recursive: true, force: true });
      } catch {}
      return { error: "the model file failed to copy" };
    }
    const url = modelUrl(name, path.basename(mesh));
    registerModel(name, stem, url);
    // MOVE not copy (relocate into models/, no Downloads/Temp duplicate) — but TRANSACTIONAL: delete
    // sources ONLY after EVERY file is confirmed copied to dest (matching size) AND no two sources share
    // a basename (they'd collide on copy → one lost) AND the source isn't already under models/. Else
    // keep ALL sources — a partial delete could orphan a .gltf's .bin/textures and break the model with
    // NO recovery (audit 2026-06-09). opts.move===false keeps originals (dialog pick / shared library).
    let moved = false;
    if (opts.move !== false) {
      const home = path.resolve(modelsDir).toLowerCase();
      const bases = files.map((f) => path.basename(f));
      const noDupes = bases.every((b, i) => bases.indexOf(b) === i);
      const allCopied =
        noDupes &&
        files.every((f) => {
          try {
            const d = path.join(dest, path.basename(f));
            return fs.existsSync(d) && fs.statSync(d).size === fs.statSync(f).size;
          } catch {
            return false;
          }
        });
      if (allCopied) {
        for (const f of files) {
          try {
            if (!path.resolve(f).toLowerCase().startsWith(home)) {
              fs.rmSync(f, { force: true });
              moved = true;
            }
          } catch {}
        }
      }
    }
    return { id: name, label: stem, url, moved };
  }

  // Remove a model: MOVE its folder to models/_trash/ (recoverable), THEN drop its manifest label.
  // ANY model is removable (incl. built-ins — it's the user's install); ids are basename-checked so
  // a renderer-supplied id can't escape models/; the manifest is edited only after a real move.
  // (A deleted built-in just degrades to the procedural placeholder on next launch — works-on-any-device.)
  function removeModel(id) {
    if (!safeId(id)) return { error: "bad model id" };
    const dir = path.join(modelsDir, id);
    let trashed = false;
    try {
      if (fs.existsSync(dir)) {
        const trash = path.join(modelsDir, "_trash");
        fs.mkdirSync(trash, { recursive: true });
        let dst = path.join(trash, id);
        if (fs.existsSync(dst)) dst = path.join(trash, `${id}_${Date.now()}`); // don't clobber a prior trashed copy
        fs.renameSync(dir, dst); // throws (EPERM) if still in use → surfaced below
        trashed = true;
      }
      const m = readManifest();
      if (Array.isArray(m.models)) {
        m.models = m.models.filter((x) => x && x.id !== id);
        writeManifest(m);
      }
      return { ok: true, id, trashed };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  return {
    meshInDir,
    discoverModels,
    registerModel,
    renameModel,
    importFiles,
    removeModel,
    freeSlug,
    safeId,
    slug,
    title,
    modelUrl,
    thumbUrl,
    MESH_EXT,
  };
}

module.exports = { createLibrary, MESH_EXT, SKIP_DIR, slug, title, safeId, modelUrl, thumbUrl };
