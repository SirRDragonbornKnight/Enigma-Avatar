// realmodels.test.js — regression guard: run the REAL rig.js cascade against the REAL
// models and lock the role counts. The other suites test the cascade on SYNTHETIC
// skeletons; this proves it still behaves on the actual assets (the bone snapshot is
// extracted from each model's glTF JSON by tools/rig_report.mjs — same tiers the engine runs).
//
// models/ is gitignored (large + non-redistributable), so on a fresh clone there are no
// models and every case SKIPS — this suite only bites on a box that has the assets.
//
// Locked 2026-06-05 from a validated rig_report run. Meaning of the numbers:
//   • 19  → fully rigged; the good path must never regress.
//   • glados 2 (head/neck) and toothless 0 → NON-bipeds: geometry must keep DECLINING them,
//     so these are exact — a jump would mean the cascade is hallucinating limbs.
//   • lolbit 17 / mangle 15 / grace 0 → known stragglers (see STATUS). If you intentionally
//     improve the cascade or add a rig_overrides.json entry, update the expected count here.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readGltfJson, buildSnapshot, runCascade, discoverModels, loadOverrides, urlKeyFor, MODELS } from "../tools/rig_report.mjs";

const EXPECT = {
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

const overrides = loadOverrides();
const byDir = new Map(discoverModels().map((f) => [path.basename(path.dirname(f)), f]));

for (const [dir, expected] of Object.entries(EXPECT)) {
  const file = byDir.get(dir);
  test(`cascade: ${dir} → ${expected} roles`, { skip: file ? false : "model not present (gitignored)" }, () => {
    const gltf = readGltfJson(file);
    const snap = buildSnapshot(gltf);
    if (expected === "static") { assert.equal(snap.length, 0, `${dir} should have no joints`); return; }
    const r = runCascade(gltf, snap, overrides[urlKeyFor(file)] || null);
    assert.equal(r.matched.length, expected, `${dir} resolved ${r.matched.length} roles (expected ${expected}); unresolved: ${r.unresolved.join(", ")}`);
  });
}

// Sanity: the suite found the models dir at all (informational — skips on a fresh clone).
test("models directory discovered", { skip: byDir.size ? false : "no models/ on this machine" }, () => {
  assert.ok(byDir.size > 0);
  assert.ok(MODELS.endsWith("models"));
});
