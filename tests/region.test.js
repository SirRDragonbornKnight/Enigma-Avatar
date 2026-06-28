// region.test.js — the bone-name → jiggle-region classifier, checked against the ACTUAL bone
// names dumped from the installed models (tools/inspect_model.py). This is the contract that
// decides which bones get a soft-body spring and which weight slider they land under, so it's
// pinned to real-world names (incl. the NSFW Mal0 rig) — not invented ones.
import { test } from "node:test";
import assert from "node:assert";
import { classifyBone, NSFW_REGIONS } from "../region.js";

// (the BREEZE_SCALE NSFW-zero test died with the breeze itself, 2026-06-12 — no ambient wind exists)

test("innocent real-word bones don't classify as NSFW (audit false positives)", () => {
  assert.notStrictEqual(classifyBone("TopKnot_01"), "dick", "a samurai hair bun is not anatomy");
  assert.notStrictEqual(classifyBone("Top_Knot"), "dick");
  assert.notStrictEqual(classifyBone("Butterfly_L"), "butt", "a hair ornament is not a butt");
  assert.notStrictEqual(classifyBone("Canal_flow"), "anus");
  assert.strictEqual(classifyBone("KnotBase"), "dick", "the real canine-anatomy name still lands"); // guard must not over-block
});

test("audit round 2: mechanical / hair / cockpit names stay innocent; missing NSFW vocab lands", () => {
  assert.notStrictEqual(classifyBone("AnalogStick_L"), "anus"); // gamepad prop on a robot rig
  assert.notStrictEqual(classifyBone("Analog_01"), "anus");
  assert.strictEqual(classifyBone("Anal_01"), "anus"); // the real name still lands
  assert.strictEqual(classifyBone("HairKnot"), "hair"); // a bun is HAIR, not anatomy
  assert.strictEqual(classifyBone("Hair_Knot_L"), "hair");
  assert.notStrictEqual(classifyBone("RopeKnot"), "dick");
  assert.strictEqual(classifyBone("KnotBase"), "dick"); // canine anatomy still lands (no over-block)
  assert.strictEqual(classifyBone("Gear_01"), null); // robot gears are not ears (FNaF animatronics!)
  assert.strictEqual(classifyBone("Linear_Drive"), null);
  assert.strictEqual(classifyBone("LeftEar"), "ear"); // camel-case side prefix still lands
  assert.strictEqual(classifyBone("Ear_03"), "ear");
  assert.strictEqual(classifyBone("Cockpit_Frame"), null);
  assert.notStrictEqual(classifyBone("Peacock_Feather"), "dick");
  assert.strictEqual(classifyBone("Cock_01"), "dick");
  assert.strictEqual(classifyBone("Tits_L"), "breast");
  assert.strictEqual(classifyBone("Title_Card"), null);
  assert.strictEqual(classifyBone("Ass_02"), "butt");
  assert.notStrictEqual(classifyBone("Bass_01"), "butt");
  assert.strictEqual(classifyBone("Groin_jiggle"), "genital");
});

test("audit round 3: corrective/mechanical names stay innocent; tightened guards hold", () => {
  assert.strictEqual(
    classifyBone("Bicep_Bulge_R"),
    null,
    "muscle correctives are not NSFW (bulge dropped from the vocab)"
  );
  assert.strictEqual(classifyBone("EyeBulge_L"), null);
  assert.strictEqual(classifyBone("Calf_Bulge"), null);
  assert.strictEqual(classifyBone("Braid_Knot_L"), "hair"); // a braid's knot is hair
  assert.notStrictEqual(classifyBone("BunKnot"), "dick");
  assert.notStrictEqual(classifyBone("Hair__Knot"), "dick"); // double separator slipped the old single-char lookbehind
  assert.strictEqual(classifyBone("KnotBase"), "dick"); // canine anatomy STILL lands
  assert.notStrictEqual(classifyBone("Analysis_Helper"), "anus");
  assert.strictEqual(classifyBone("Anal_01"), "anus");
  assert.strictEqual(classifyBone("Shears_L"), null); // not an ear
  assert.strictEqual(classifyBone("Hearing_Aid"), null);
  assert.strictEqual(classifyBone("Early_Bone"), null);
  assert.strictEqual(classifyBone("DEF-Hear.L_021"), "ear"); // Mal0's spelling STILL lands
  assert.strictEqual(classifyBone("Cockle_Shell"), null);
  assert.strictEqual(classifyBone("Cocker_Tail"), "tail"); // not a dick (tail is fine)
  assert.strictEqual(classifyBone("Cock_01"), "dick");
  assert.strictEqual(classifyBone("Clitellum"), null);
  assert.strictEqual(classifyBone("DEF-Clit_01"), "genital");
});

test("Mal0's NSFW rig classifies into the right regions", () => {
  assert.strictEqual(classifyBone("DEF-Breast.L_082"), "breast");
  assert.strictEqual(classifyBone("DEF-Breast.R.002_end_0240"), "breast");
  assert.strictEqual(classifyBone("DEF-Butt1.L_0149"), "butt");
  // Mal0's three distinct chains each get their OWN region (→ own weight slider) — they were lumped
  // under one "genital" weight, which hid two sliders the user expected ("missing a few weights").
  assert.strictEqual(classifyBone("Pussy1.L_0179"), "genital");
  assert.strictEqual(classifyBone("Pussy2.R_0183"), "genital");
  assert.strictEqual(classifyBone("AssHole1.R_0189"), "anus");
  assert.strictEqual(classifyBone("DE-Dick1_0210"), "dick"); // "Dick1" — no word boundary
  assert.strictEqual(classifyBone("DE-Dick1.007_end_0224"), "dick");
  assert.strictEqual(classifyBone("Sheath_01"), "dick");
  assert.strictEqual(classifyBone("KnotBase"), "dick");
  assert.strictEqual(classifyBone("DEF-TailC_0203"), "tail");
  assert.strictEqual(classifyBone("DEF-HairC3_029"), "hair");
  assert.strictEqual(classifyBone("DEF-Hear.L_021"), "ear"); // Mal0 spells "ear" as "Hear"
});

test("structural / non-jiggle bones are NOT sprung (the guards)", () => {
  assert.strictEqual(classifyBone("DEF-forearm.L_092"), null); // forEARm — not an ear
  assert.strictEqual(classifyBone("thigh_r_119"), null); // aveline leg — not jiggle (would go floppy)
  assert.strictEqual(classifyBone("thigh_knee_l_125"), null);
  assert.strictEqual(classifyBone("heart_up_54"), null); // aveline hEARt deco — not an ear
  assert.strictEqual(classifyBone("L_hip_JNT_0182"), null); // renamon hip — structural
  assert.strictEqual(classifyBone("Button01"), null); // butt(?!on)
  assert.strictEqual(classifyBone("Finger_R_03"), null); // fin(?!ger)
  assert.strictEqual(classifyBone("mixamorig:Spine"), null);
});

test("renamon / makiro / aveline danglies classify sensibly", () => {
  assert.strictEqual(classifyBone("Renamon_RigVer01:L_ear01_bndJNT_017"), "ear");
  assert.strictEqual(classifyBone("Renamon_RigVer01:tail05_bndJNT_0177"), "tail");
  assert.strictEqual(classifyBone("Renamon_RigVer01:R_rearShoulderFluff01_bndJNT_096"), "accessory"); // fluff, NOT butt
  assert.strictEqual(classifyBone("Breast_L_Armature"), "breast");
  assert.strictEqual(classifyBone("FrontHair_L_Armature"), "hair");
  assert.strictEqual(classifyBone("aveline_tail_152"), "tail");
});

test("cloth is its own region; generic jiggle bones are caught", () => {
  assert.strictEqual(classifyBone("Skirt_F_01"), "cloth");
  assert.strictEqual(classifyBone("Cloth_back_2"), "cloth");
  assert.strictEqual(classifyBone("BreastJiggle_L"), "breast"); // body region wins over generic
  assert.strictEqual(classifyBone("Boob_Bounce_01"), "breast");
  assert.strictEqual(classifyBone("Wobble_03"), "jiggle"); // generic fallback
  assert.strictEqual(classifyBone(""), null);
  assert.strictEqual(classifyBone(null), null);
});

test("NSFW regions are exactly breast/butt/genital/dick/anus", () => {
  for (const r of ["breast", "butt", "genital", "dick", "anus"]) assert.ok(NSFW_REGIONS.has(r), r);
  assert.ok(!NSFW_REGIONS.has("hair") && !NSFW_REGIONS.has("cloth") && !NSFW_REGIONS.has("tail"));
});
