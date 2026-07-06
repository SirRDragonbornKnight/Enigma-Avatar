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
    if (d.name.startsWith("_")) continue; // models/_trash holds retired models — not installed
    if (d.isDirectory()) {
      const sub = path.join(dir, d.name);
      const files = fs.readdirSync(sub);
      const pick = files.find((f) => /^scene\.(gltf|glb)$/i.test(f)) || files.find((f) => /\.(glb|gltf|vrm)$/i.test(f));
      if (pick) out.push(path.join(sub, pick));
    } else if (/\.(glb|gltf|vrm)$/i.test(d.name)) {
      // FLAT library dirs too (Desktop\Avatars / 3d Avatar\Avatars are flat) — keyed by file stem,
      // so AVATAR_MODELS_DIR pointed at either actually finds models (a subdir-only walk finds NOTHING there)
      out.push(path.join(dir, d.name));
    }
  }
  return out;
}

const EXPECT = {
  // ---- installed in models/ (ALL FIVE exercise the cascade on every run; a key naming a
  // renamed/removed file skips silently and locks nothing) ----
  makiro: 19,
  miku_brazilian_chiku_by_manolo122lq_beta: 19,
  rachnera__monster_musume: 19,
  // ryuri is a LAMIA — humanoid torso on a ~112-bone snake tail, NO legs. 12 is FULL coverage
  // for her body plan (hips/leg roles honestly vacant; the tail is spring physics, not roles).
  ryuri: 12,
  // zhu_yuan locks the Daz Genesis naming support (a side-detection regression drops it to 4/19).
  zhu_yuan: 19,
  // ---- the external flat library (C:\Users\SirKn\3d Avatar\Avatars) — these bite when
  // AVATAR_MODELS_DIR points there; keyed by lowercased file stem. Keys must match the
  // CURRENT filenames (measure with tools/rig_report.mjs) or a case skips silently. ----
  fexa_blender: 19,
  "mal0_-_v_2_0": 19,
  "love-taste-toy-chica": 19,
  // lolbit/mangle: 16 roles each — the RIGHT 16 (joint-style arm promotion);
  // clavicle-less shoulder slots honestly vacant (lolbit also lacks chest; mangle lacks hips).
  fnaf_help_wanted__lolbit: 16,
  glamrock_mangleupdated: 16,
  "g.l.a.d.o.s": 2, // head/neck only (no body) — a jump means the cascade is hallucinating limbs
};

const keyOf = (f) =>
  (path.dirname(f) === path.resolve(MODELS)
    ? path.basename(f).replace(/\.(glb|gltf|vrm)$/i, "") // flat library file -> keyed by stem
    : path.basename(path.dirname(f))
  ).toLowerCase(); // models/<id>/scene.gltf -> keyed by the id dir; lowercased so Makiro.glb == makiro/
const byDir = new Map(discover(MODELS).map((f) => [keyOf(f), f]));
const matchedKeys = Object.keys(EXPECT).filter((dir) => byDir.has(dir));

for (const [dir, expected] of Object.entries(EXPECT)) {
  const file = byDir.get(dir);
  test(`cascade: ${dir} -> ${expected} roles`, { skip: file ? false : "model not present (gitignored)" }, () => {
    const gltf = readGltfJson(file);
    const snap = buildSnapshot(gltf);
    if (expected === "static") {
      assert.equal(snap.length, 0, `${dir} should have no joints`);
      return;
    }
    const r = runCascade(gltf, snap);
    assert.equal(
      r.matched.length,
      expected,
      `${dir} resolved ${r.matched.length} roles (expected ${expected}); unresolved: ${r.unresolved.join(", ")}`
    );
  });
}

// GUARD: an all-skip run must never masquerade as a pass. If the library has models present
// but NONE of them are EXPECT keys, every case above skipped and asserted nothing — fail loudly
// so a green report can't hide an empty/renamed/relocated library.
test(
  "library is covered (no silent all-skip)",
  { skip: byDir.size ? false : "no models present on this machine" },
  () => {
    assert.ok(
      matchedKeys.length > 0,
      `${byDir.size} model dir(s) present (${[...byDir.keys()].join(", ")}) but ZERO match an EXPECT key — ` +
        `the cascade is untested here. Add the present model(s) to EXPECT (run 'node tools/rig_report.mjs').`
    );
  }
);

// Sanity: report which models actually exercised the cascade (informational).
test(
  "at least one real model exercised the cascade",
  { skip: byDir.size ? false : "no models present on this machine" },
  () => {
    assert.ok(matchedKeys.length > 0, `covered: ${matchedKeys.join(", ") || "none"}`);
  }
);

// COMPLETENESS (the stronger guard, repo library only): every model INSTALLED in models/ must be
// locked by an EXPECT entry. The one-match guard above can pass while most installed models
// exercise nothing (renamed dirs make their keys skip silently).
test(
  "every installed repo model is locked by an EXPECT entry (no silent coverage holes)",
  {
    skip: process.env.AVATAR_MODELS_DIR
      ? "external library (curated coverage only)"
      : byDir.size
        ? false
        : "no models present",
  },
  () => {
    const missing = [...byDir.keys()].filter((k) => !(k in EXPECT));
    assert.deepEqual(
      missing,
      [],
      `models/ has unlocked model(s): ${missing.join(", ")} — measure with 'node tools/rig_report.mjs' and add them to EXPECT`
    );
  }
);
