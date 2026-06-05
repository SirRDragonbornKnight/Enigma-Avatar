// Tests for the bone-ID cascade (rig.js): name tier, geometry tier (incl. graceful
// degradation on non-bipeds), per-model override (force/exclude), and VRM authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { resolveRig, roleOfName } from "../rig.js";
import { buildDefaultAvatar } from "../default_avatar.js";
import { fullBiped, blenderBiped, opaqueBiped, opaqueBipedNoTips, gladosLike, quadruped, fakeVrm } from "./fixtures.js";

const NINETEEN = [
  "chest", "head", "hips",
  "left_arm", "left_foot", "left_forearm", "left_hand", "left_leg", "left_shin", "left_shoulder",
  "neck",
  "right_arm", "right_foot", "right_forearm", "right_hand", "right_leg", "right_shin", "right_shoulder",
  "spine",
];
const wpos = (bone) => { const v = new THREE.Vector3(); bone.getWorldPosition(v); return v; };

// ── Tier 2: names ───────────────────────────────────────────────────────────────
test("roleOfName — spot checks incl. the Armature / de-dotted guards", () => {
  assert.equal(roleOfName("Hips"), "hips");
  assert.equal(roleOfName("Armature"), null);            // not an arm
  assert.equal(roleOfName("forearm"), null);             // a limb with no side is rejected
  assert.equal(roleOfName("LeftForeArm"), "left_forearm");
  assert.equal(roleOfName("upper_armL"), "left_arm");    // Blender ".L" de-dotted
  assert.equal(roleOfName("upper_armR"), "right_arm");
  assert.equal(roleOfName("Bip_Pelvis_L"), null);        // sided center bone → rejected
});

test("name tier resolves a named biped to all 19 roles", () => {
  const r = resolveRig(fullBiped());
  assert.deepEqual(r.matched, NINETEEN);
  assert.deepEqual(r.report.bySource, { name: 19 });
});

test("name tier handles Blender .L/.R de-dotted rigs (Toy Chica bug)", () => {
  const r = resolveRig(blenderBiped());
  assert.deepEqual(r.matched, NINETEEN);
  assert.deepEqual(r.report.bySource, { name: 19 });
});

// ── Tier 3: geometry ──────────────────────────────────────────────────────────────
test("geometry tier resolves an OPAQUE biped (junk names) to all 19 roles", () => {
  const r = resolveRig(opaqueBiped());
  assert.deepEqual(r.matched, NINETEEN);
  assert.deepEqual(r.report.bySource, { geometry: 19 });
  // sides correct (model-left = −X) and head is at the top
  assert.ok(wpos(r.roles.left_arm).x < wpos(r.roles.right_arm).x, "left arm should be −X");
  assert.ok(wpos(r.roles.left_leg).x < wpos(r.roles.right_leg).x, "left leg should be −X");
  assert.ok(wpos(r.roles.head).y > wpos(r.roles.hips).y, "head above hips");
});

test("geometry maps a TIP-LESS opaque biped without shifting distal roles (fix: tip-drop vs prev segment)", () => {
  const r = resolveRig(opaqueBipedNoTips());
  assert.deepEqual(r.matched, NINETEEN);
  assert.ok(wpos(r.roles.left_foot).y < wpos(r.roles.left_shin).y, "foot below shin");
  assert.ok(wpos(r.roles.left_shin).y < wpos(r.roles.left_leg).y, "shin below leg (thigh)");
  assert.ok(wpos(r.roles.left_hand).x < wpos(r.roles.left_forearm).x, "hand outboard of forearm");
});

test("override: a bone both excluded AND force-assigned stays OUT of every role (exclude wins)", () => {
  const r = resolveRig(fullBiped(), null, { override: { exclude: ["LeftHand"], roles: { left_hand: "LeftHand" } } });
  const used = Object.values(r.roles).map((b) => b.name);
  assert.ok(!used.includes("LeftHand"), "excluded bone must hold no role even when also force-assigned");
});

test("geometry degrades gracefully — GLaDOS-like rig gets NO false limbs", () => {
  const r = resolveRig(gladosLike());
  for (const role of ["hips", "left_arm", "right_arm", "left_leg", "right_leg"]) {
    assert.ok(!(role in r.roles), `${role} must not be assigned on a non-biped`);
  }
});

test("geometry degrades gracefully — quadruped gets NO arms (front legs aren't arms)", () => {
  const r = resolveRig(quadruped());
  for (const role of ["left_arm", "right_arm"]) assert.ok(!(role in r.roles), `${role} must not be assigned`);
});

// ── Tier 4: override (force / exclude) ────────────────────────────────────────────
test("override FORCES a role, beating the name tier", () => {
  const r = resolveRig(fullBiped(), null, { override: { roles: { left_arm: "RightUpperArm" } } });
  assert.equal(r.source.left_arm, "override");
  assert.equal(r.roles.left_arm.name, "RightUpperArm");
});

test("override EXCLUDE keeps a bone out of every role", () => {
  const r = resolveRig(fullBiped(), null, { override: { exclude: ["LeftHand"] } });
  const used = Object.values(r.roles).map((b) => b.name);
  assert.ok(!used.includes("LeftHand"), "excluded bone must hold no role");
});

// ── Tier 1: VRM authority ─────────────────────────────────────────────────────────
test("VRM humanoid map is authoritative over names", () => {
  const m = fullBiped();
  const r = resolveRig(m, fakeVrm(m));
  assert.deepEqual(r.matched, NINETEEN);
  assert.deepEqual(r.report.bySource, { vrm: 19 });
});

test("a VRM gap falls through to the name tier", () => {
  const m = fullBiped();
  const vrm = fakeVrm(m);
  const orig = vrm.humanoid.getRawBoneNode;
  vrm.humanoid.getRawBoneNode = (n) => (n === "chest" || n === "upperChest" ? null : orig(n));
  const r = resolveRig(m, vrm);
  assert.equal(r.source.chest, "name", "chest should be filled by the name tier when VRM lacks it");
});

// ── Built-in procedural placeholder (the no-model fallback — must always rig cleanly) ──
test("the zero-asset procedural default avatar resolves to all 19 roles via the name tier", () => {
  const r = resolveRig(buildDefaultAvatar().scene);
  assert.deepEqual(r.matched, NINETEEN);
  assert.deepEqual(r.report.bySource, { name: 19 });
});
