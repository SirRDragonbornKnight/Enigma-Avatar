// library.test.js — unit tests for the model library's fs logic (discover / import / trash) in a
// SANDBOX temp dir. Locks the clobber guards, the recoverable trash, path-safe ids, the
// mesh-landed check, and URL encoding.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pkg from "../src/model/library.cjs"; // CJS module → default import is bullet-proof across cjs-interop
const { createLibrary } = pkg;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enigma-lib-"));
  const modelsDir = path.join(root, "models");
  const manifestPath = path.join(root, "models.json");
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ models: [] }, null, 2));
  const lib = createLibrary({ modelsDir, manifestPath, runPython: null, scriptDir: root });
  return {
    root,
    modelsDir,
    manifestPath,
    lib,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}
function mkModel(modelsDir, id, mesh = "scene.gltf", body = "x") {
  const d = path.join(modelsDir, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, mesh), body);
  return d;
}
function srcFile(root, name, body = "glTF") {
  const p = path.join(root, "src");
  fs.mkdirSync(p, { recursive: true });
  const f = path.join(p, name);
  fs.writeFileSync(f, body);
  return f;
}

test("discoverModels lists folders-with-a-mesh, NO bundled built-ins, skips _/./no-mesh dirs", () => {
  const s = sandbox();
  try {
    mkModel(s.modelsDir, "roxanne_wolf");
    mkModel(s.modelsDir, "userA", "userA.glb");
    fs.mkdirSync(path.join(s.modelsDir, "nomesh"));
    fs.mkdirSync(path.join(s.modelsDir, "_trash"));
    fs.mkdirSync(path.join(s.modelsDir, ".hidden"));
    const list = s.lib.discoverModels();
    assert.deepStrictEqual(list.map((m) => m.id).sort(), ["roxanne_wolf", "userA"]);
    assert.strictEqual(list.find((m) => m.id === "roxanne_wolf").builtin, false); // no bundled/copyright built-ins
    assert.strictEqual(list.find((m) => m.id === "userA").builtin, false);
    assert.strictEqual(list.find((m) => m.id === "roxanne_wolf").label, "Roxanne Wolf"); // title-cased folder, no hard-coded label
  } finally {
    s.cleanup();
  }
});

test("discoverModels percent-encodes spaces in the URL", () => {
  const s = sandbox();
  try {
    mkModel(s.modelsDir, "spaced", "My Model.glb");
    assert.strictEqual(s.lib.discoverModels().find((x) => x.id === "spaced").url, "./models/spaced/My%20Model.glb");
  } finally {
    s.cleanup();
  }
});

test("importFiles copies + registers a plain mesh (encoded url)", () => {
  const s = sandbox();
  try {
    const r = s.lib.importFiles([srcFile(s.root, "Cute Bot.glb")]);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.id, "cute_bot");
    assert.ok(fs.existsSync(path.join(s.modelsDir, "cute_bot", "Cute Bot.glb")), "mesh copied");
    assert.strictEqual(r.url, "./models/cute_bot/Cute%20Bot.glb");
    assert.ok(
      JSON.parse(fs.readFileSync(s.manifestPath, "utf8")).models.some((m) => m.id === "cute_bot"),
      "registered"
    );
  } finally {
    s.cleanup();
  }
});

test("importFiles MOVES the source into models/ by default (no leftover duplicate); opts.move:false keeps it", () => {
  const s = sandbox();
  try {
    const src = srcFile(s.root, "Mover.glb");
    const r = s.lib.importFiles([src]);
    assert.ok(!r.error && r.moved, "moved");
    assert.ok(fs.existsSync(path.join(s.modelsDir, r.id, "Mover.glb")), "copy landed in models/");
    assert.ok(!fs.existsSync(src), "source removed (relocated, not duplicated)");
    const src2 = srcFile(s.root, "Keeper.glb");
    const r2 = s.lib.importFiles([src2], { move: false });
    assert.ok(!r2.error && !r2.moved, "opts.move:false → not moved");
    assert.ok(fs.existsSync(src2), "source kept");
  } finally {
    s.cleanup();
  }
});

test("importFiles move is TRANSACTIONAL — same-basename sources are NOT deleted (no data loss)", () => {
  const s = sandbox();
  try {
    // two sources share a basename → they collide on copy; deleting blindly would lose one.
    const dA = path.join(s.root, "A");
    fs.mkdirSync(dA, { recursive: true });
    const fa = path.join(dA, "dup.glb");
    fs.writeFileSync(fa, "AAAA");
    const dB = path.join(s.root, "B");
    fs.mkdirSync(dB, { recursive: true });
    const fb = path.join(dB, "dup.glb");
    fs.writeFileSync(fb, "BBBBBB");
    const r = s.lib.importFiles([fa, fb]);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.moved, false, "dup basenames → NOT moved (transactional)");
    assert.ok(fs.existsSync(fa) && fs.existsSync(fb), "BOTH sources kept — no partial delete");
  } finally {
    s.cleanup();
  }
});

test("importFiles NEVER overwrites an EXISTING folder (glados.glb when models/glados exists → free slug)", () => {
  const s = sandbox();
  try {
    mkModel(s.modelsDir, "glados", "scene.gltf", "ORIGINAL");
    const r = s.lib.importFiles([srcFile(s.root, "glados.glb", "ATTACKER")]);
    assert.ok(!r.error, r.error);
    assert.notStrictEqual(r.id, "glados", "did NOT import into the existing folder");
    assert.strictEqual(
      fs.readFileSync(path.join(s.modelsDir, "glados", "scene.gltf"), "utf8"),
      "ORIGINAL",
      "existing folder untouched"
    );
    assert.ok(fs.existsSync(path.join(s.modelsDir, r.id, "glados.glb")), "imported under a free slug");
  } finally {
    s.cleanup();
  }
});

test("importFiles disambiguates an existing user id instead of overwriting", () => {
  const s = sandbox();
  try {
    mkModel(s.modelsDir, "scene", "scene.glb", "OLD");
    const r = s.lib.importFiles([srcFile(s.root, "scene.glb", "NEW")]);
    assert.notStrictEqual(r.id, "scene", "didn't reuse the existing id");
    assert.strictEqual(
      fs.readFileSync(path.join(s.modelsDir, "scene", "scene.glb"), "utf8"),
      "OLD",
      "existing model preserved"
    );
  } finally {
    s.cleanup();
  }
});

test("importFiles fails cleanly when the mesh can't copy (no broken entry, no orphan folder)", () => {
  const s = sandbox();
  try {
    const r = s.lib.importFiles([path.join(s.root, "does", "not", "exist.glb")]);
    assert.ok(r.error, "returns an error");
    assert.strictEqual(JSON.parse(fs.readFileSync(s.manifestPath, "utf8")).models.length, 0, "nothing registered");
    assert.ok(!fs.existsSync(path.join(s.modelsDir, "exist")), "no orphan folder");
  } finally {
    s.cleanup();
  }
});

test("HONEST coverage — .obj/.dae are NOT loadable (no OBJ/Collada loader), so they aren't treated as meshes", () => {
  const s = sandbox();
  try {
    // a folder whose ONLY mesh-ish file is a .obj must NOT be discovered as a model — there is no
    // OBJLoader in loader.js, so listing it would offer a model that dies with a bogus 'not valid JSON'.
    mkModel(s.modelsDir, "objonly", "thing.obj");
    mkModel(s.modelsDir, "daeonly", "thing.dae");
    mkModel(s.modelsDir, "realglb", "real.glb");
    assert.deepStrictEqual(
      s.lib
        .discoverModels()
        .map((m) => m.id)
        .sort(),
      ["realglb"],
      "only the loadable mesh is offered"
    );
    // and importing a bare .obj is rejected, not silently relocated into a broken model
    const r = s.lib.importFiles([srcFile(s.root, "model.obj")]);
    assert.ok(r.error, "an .obj import is rejected with an error");
    // MESH_EXT itself must not advertise the unsupported formats
    assert.ok(!s.lib.MESH_EXT.has(".obj") && !s.lib.MESH_EXT.has(".dae"), "MESH_EXT drops .obj/.dae");
    assert.ok(s.lib.MESH_EXT.has(".glb") && s.lib.MESH_EXT.has(".fbx"), "MESH_EXT keeps glb/fbx");
  } finally {
    s.cleanup();
  }
});

test("removeModel MOVES a user model to _trash + drops its manifest entry", () => {
  const s = sandbox();
  try {
    mkModel(s.modelsDir, "userA", "userA.glb");
    s.lib.registerModel("userA", "User A", "./models/userA/userA.glb");
    const r = s.lib.removeModel("userA");
    assert.ok(r.ok && r.trashed, "trashed");
    assert.ok(!fs.existsSync(path.join(s.modelsDir, "userA")), "gone from models/");
    assert.ok(fs.existsSync(path.join(s.modelsDir, "_trash", "userA", "userA.glb")), "recoverable in _trash");
    assert.ok(
      !JSON.parse(fs.readFileSync(s.manifestPath, "utf8")).models.some((m) => m.id === "userA"),
      "manifest entry dropped"
    );
  } finally {
    s.cleanup();
  }
});

test("removeModel trashes any model + rejects traversal/separator/empty ids without touching the manifest", () => {
  const s = sandbox();
  try {
    mkModel(s.modelsDir, "glados");
    s.lib.registerModel("a/b", "weird", "x");
    const before = fs.readFileSync(s.manifestPath, "utf8");
    assert.ok(s.lib.removeModel("../evil").error, "rejects ../ id");
    assert.ok(s.lib.removeModel("a/b").error, "rejects separator id");
    assert.ok(s.lib.removeModel("").error, "rejects empty id");
    assert.strictEqual(fs.readFileSync(s.manifestPath, "utf8"), before, "manifest untouched by any rejected remove");
    const r = s.lib.removeModel("glados");
    assert.ok(r.ok && r.trashed, "model trashed");
    assert.ok(!fs.existsSync(path.join(s.modelsDir, "glados")), "moved out of models/");
    assert.ok(fs.existsSync(path.join(s.modelsDir, "_trash", "glados")), "recoverable in _trash");
  } finally {
    s.cleanup();
  }
});
