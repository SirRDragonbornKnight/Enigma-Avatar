// realmodels.test.js — regression guard: run the REAL rig.js cascade against the REAL
// models and lock the role counts. The other suites test the cascade on SYNTHETIC
// skeletons; this proves it still behaves on the actual assets (the bone snapshot is
// extracted from each model's glTF JSON by tools/rig_report.mjs — same tiers the engine runs).
//
// models/ is gitignored (large + non-redistributable), so on a fresh clone there are no
// models and every case SKIPS — this suite only bites on a box that has the assets.
// Point AVATAR_MODELS_DIR at a different folder to judge a model library that lives
// outside the repo (e.g. C:\Users\SirKn\3d Avatar\Avatars).
//
// Locked from validated rig_report runs. Meaning of the numbers:
//   • 19  → fully rigged; the good path must never regress.
//   • glados 2 (head/neck) and toothless 0 → NON-bipeds: geometry must keep DECLINING them,
//     so these are exact — a jump would mean the cascade is hallucinating limbs.
//   • lolbit 17 / mangle 15 / grace 0 → known stragglers. If you intentionally
//     improve the cascade, update the expected count here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readGltfJson, buildSnapshot, runCascade, MOD } from "../tools/rig_report.mjs";

// Env override so a model library outside the repo can be judged. discoverModels() in
// rig_report.mjs is hardwired to MOD/models; we re-implement its pick logic here against
// the overridable dir so the override actually takes effect (and an all-skip run can't lie).
const MODELS = process.env.AVATAR_MODELS_DIR || path.join(MOD, "models");

function discover(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const sub = path.join(dir, d.name);
    const files = fs.readdirSync(sub);
    const pick = files.find((f) => /^scene\.(gltf|glb)$/i.test(f)) || files.find((f) => /\.(glb|gltf|vrm)$/i.test(f));
    if (pick) out.push(path.join(sub, pick));
  }
  return out;
}

const EXPECT = {
  makiro: 19,
  "51dc47334dee42b9bb8e53ee07aa8006": 19,
  roxanne_wolf: 19,
  "mal0_scp-1471": 19,
  "fexa_-_fnaf__cryptiacurves": 19,
  "love-taste-toy-chica": 19,
  fnaf_help_wanted__lolbit: 17,
  glamrock_mangleupdated: 15,
  glados: 2,
  grace_howard: 0,
  toothless: 0,
  spyro: "static",   // no skin/joints → no bone snapshot at all
};

const byDir = new Map(discover(MODELS).map((f) => [path.basename(path.dirname(f)), f]));
const matchedKeys = Object.keys(EXPECT).filter((dir) => byDir.has(dir));

for (const [dir, expected] of Object.entries(EXPECT)) {
  const file = byDir.get(dir);
  test(`cascade: ${dir} -> ${expected} roles`, { skip: file ? false : "model not present (gitignored)" }, () => {
    const gltf = readGltfJson(file);
    const snap = buildSnapshot(gltf);
    if (expected === "static") { assert.equal(snap.length, 0, `${dir} should have no joints`); return; }
    const r = runCascade(gltf, snap);
    assert.equal(r.matched.length, expected, `${dir} resolved ${r.matched.length} roles (expected ${expected}); unresolved: ${r.unresolved.join(", ")}`);
  });
}

// GUARD: an all-skip run must never masquerade as a pass. If the library has models present
// but NONE of them are EXPECT keys, every case above skipped and asserted nothing — fail loudly
// so a green report can't hide an empty/renamed/relocated library.
test("library is covered (no silent all-skip)", { skip: byDir.size ? false : "no models present on this machine" }, () => {
  assert.ok(
    matchedKeys.length > 0,
    `${byDir.size} model dir(s) present (${[...byDir.keys()].join(", ")}) but ZERO match an EXPECT key — ` +
      `the cascade is untested here. Add the present model(s) to EXPECT (run 'node tools/rig_report.mjs').`,
  );
});

// Sanity: report which models actually exercised the cascade (informational).
test("at least one real model exercised the cascade", { skip: byDir.size ? false : "no models present on this machine" }, () => {
  assert.ok(matchedKeys.length > 0, `covered: ${matchedKeys.join(", ") || "none"}`);
});
