// Tests for the bone-ID cascade (rig.js): name tier, geometry tier (incl. graceful
// degradation on non-bipeds) and VRM authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { resolveRig, roleOfName, resolveBetween, snapshotBones } from "../src/rig/rig.js";
import {
  fullBiped,
  blenderBiped,
  opaqueBiped,
  opaqueBipedNoTips,
  gladosLike,
  quadruped,
  namedQuadruped,
  minimalNameBiped,
  fakeVrm,
  makeBone,
  underArmature,
} from "./fixtures.js";

const NINETEEN = [
  "chest",
  "head",
  "hips",
  "left_arm",
  "left_foot",
  "left_forearm",
  "left_hand",
  "left_leg",
  "left_shin",
  "left_shoulder",
  "neck",
  "right_arm",
  "right_foot",
  "right_forearm",
  "right_hand",
  "right_leg",
  "right_shin",
  "right_shoulder",
  "spine",
];
const wpos = (bone) => {
  const v = new THREE.Vector3();
  bone.getWorldPosition(v);
  return v;
};

// ── Tier 2: names ───────────────────────────────────────────────────────────────
test("roleOfName — spot checks incl. the Armature / de-dotted guards", () => {
  assert.equal(roleOfName("Hips"), "hips");
  assert.equal(roleOfName("Armature"), null); // not an arm
  assert.equal(roleOfName("forearm"), null); // a limb with no side is rejected
  assert.equal(roleOfName("LeftForeArm"), "left_forearm");
  assert.equal(roleOfName("upper_armL"), "left_arm"); // Blender ".L" de-dotted
  assert.equal(roleOfName("upper_armR"), "right_arm");
  assert.equal(roleOfName("Bip_Pelvis_L"), null); // sided center bone → rejected
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

test("a NAMED quadruped (FrontLeftLeg/BackLeftLeg/...) gets NO false arm/torso roles", () => {
  // The name tier resolves left_leg + right_leg (two legs) but ZERO arms. Two legs alone is
  // the quadruped signature, so the humanoid gate must NOT trust it — geometry sees four
  // downward legs on a flat spine, no lateral arm pair, and emits no arm/chest/forearm roles.
  const r = resolveRig(namedQuadruped());
  for (const role of ["left_arm", "right_arm", "left_forearm", "right_forearm", "left_hand", "right_hand", "chest"]) {
    assert.ok(!(role in r.roles), `${role} must not be assigned on a named quadruped (no arms exist)`);
  }
  // the legs it DID name are real and must keep their roles (not be re-paired as arms)
  assert.equal(r.source.left_leg, "name");
  assert.equal(r.source.right_leg, "name");
});

// ── Tier 3.5: structural "between" repair (joint-style "shoulder" = upper arm) ─────
// lola_bunny / sexy_roxanne / renamon name the UPPER ARM "shoulder" (shoulder→elbow→wrist),
// so the clavicle wins `${side}_shoulder` and the real upper arm is dropped. The between-repair
// recovers it structurally (the bone between the resolved shoulder and forearm), no names needed.
function jointStyleArmBiped() {
  // arm chain: Shoulder1 (clavicle) → Shoulder2 (UPPER ARM, joint-named) → Elbow → Wrist → tip
  const arm = (pfx, sx) =>
    makeBone(
      pfx + "Shoulder1",
      [sx * 0.05, 0.1, 0],
      [
        makeBone(
          pfx + "Shoulder2",
          [sx * 0.13, 0, 0],
          [
            makeBone(
              pfx + "Elbow",
              [sx * 0.26, 0, 0],
              [makeBone(pfx + "Wrist", [sx * 0.22, 0, 0], [makeBone(pfx + "Wrist_end", [sx * 0.08, 0, 0])])]
            ),
          ]
        ),
      ]
    );
  const leg = (pfx, sx) =>
    makeBone(
      pfx + "Thigh",
      [sx * 0.1, -0.05, 0],
      [
        makeBone(
          pfx + "Knee",
          [0, -0.42, 0],
          [makeBone(pfx + "Ankle", [0, -0.42, 0], [makeBone(pfx + "Toe", [0, -0.05, 0.12])])]
        ),
      ]
    );
  const hips = makeBone(
    "Hips",
    [0, 1.0, 0],
    [
      makeBone(
        "Spine",
        [0, 0.12, 0],
        [
          makeBone("Neck", [0, 0.3, 0], [makeBone("Head", [0, 0.12, 0], [makeBone("Head_end", [0, 0.18, 0])])]),
          arm("Left", -1),
          arm("Right", +1),
        ]
      ),
      leg("Left", -1),
      leg("Right", +1),
    ]
  );
  return underArmature(hips);
}

test("between-repair: a joint-style 'shoulder' upper-arm resolves to left/right_arm (the correct bone)", () => {
  const r = resolveRig(jointStyleArmBiped());
  assert.equal(
    r.roles.left_arm?.name,
    "LeftShoulder2",
    "the UPPER ARM (2nd shoulder) holds left_arm, not the clavicle"
  );
  assert.equal(r.roles.right_arm?.name, "RightShoulder2");
  assert.equal(r.roles.left_shoulder.name, "LeftShoulder1", "the clavicle keeps the shoulder role");
  assert.ok(
    wpos(r.roles.left_arm).x < wpos(r.roles.left_shoulder).x,
    "upper arm is more −X (outboard) than the clavicle"
  );
  assert.ok(wpos(r.roles.left_hand).x < wpos(r.roles.left_arm).x, "hand outboard of the upper arm");
});

test("resolveBetween (in isolation): fills the middle joint from a shoulder+forearm gap, naming-agnostic", () => {
  const { snap, bones } = snapshotBones(jointStyleArmBiped());
  const idOf = (nm) => bones.findIndex((b) => b.name === nm);
  // simulate ONLY names resolving (clavicle=shoulder, elbow=forearm, wrist=hand) — geometry off
  const roleIds = {
    left_shoulder: idOf("LeftShoulder1"),
    left_forearm: idOf("LeftElbow"),
    left_hand: idOf("LeftWrist"),
    spine: idOf("Spine"),
    neck: idOf("Neck"),
  };
  const source = {};
  resolveBetween(snap, roleIds, source);
  assert.equal(
    bones[roleIds.left_arm].name,
    "LeftShoulder2",
    "between fills the upper arm = the bone between shoulder and forearm"
  );
  assert.equal(source.left_arm, "between");
  assert.ok(
    roleIds.chest == null,
    "chest stays empty here (Spine→Neck are directly linked, no middle bone — between never fabricates one)"
  );
});

test("Daz Genesis naming resolves: leading-l/r sides, Collar/ShldrBend shoulders, abdomen spine", () => {
  // zhu_yuan lesson (4/19 -> 19/19): Daz tags sides as a BARE lowercase l/r glued to the part.
  assert.equal(roleOfName("lThighBend_05"), "left_leg");
  assert.equal(roleOfName("rShin_023"), "right_shin");
  assert.equal(roleOfName("lFoot_08"), "left_foot");
  assert.equal(roleOfName("lCollar_063"), "left_shoulder", "Daz Collar = the clavicle");
  assert.equal(
    roleOfName("lShldrBend_064"),
    "left_shoulder",
    "ShldrBend maps shoulder too — arrives second, so the between-repair promotes it to the ARM"
  );
  assert.equal(roleOfName("lShldrTwist_065"), null, "twist bones still never win a role");
  assert.equal(roleOfName("lForearmBend_066"), "left_forearm");
  assert.equal(roleOfName("abdomenLower_059"), "spine", "Daz abdomen = spine");
  assert.equal(roleOfName("lowerBack"), "spine", "leading lowercase l NOT followed by a capital is not a side tag");
  assert.equal(roleOfName("rib_1"), null, "nor is a leading r");
});

test("accessory bones never steal a role by substring: ...Pad / ...Jiggle are SKIPPED (FNaF lesson)", () => {
  // R_ShoulderPad_jnt came BEFORE R_Shoulder_jnt in traversal order and stole right_shoulder.
  assert.equal(roleOfName("R_ShoulderPad_jnt_045"), null, "armor pad is not the shoulder");
  assert.equal(roleOfName("L_Shoulder_Jiggle_jnt_043"), null, "secondary-motion aid is not the shoulder");
  assert.equal(roleOfName("R_Shoulder_jnt_046"), "right_shoulder", "the REAL joint still resolves");
  assert.equal(roleOfName("L_Elbow_Jiggle_jnt_042"), null, "jiggle elbows are not forearms");
});

test("joint-style promotion: an OUTBOARD 'shoulder' that directly parents the elbow BECOMES the arm", () => {
  // FNaF-style chain: Shoulder_jnt (head at the arm line) -> Elbow -> Wrist, no upper-arm bone.
  // The shoulder bone spans the upper-arm segment, so it takes the ARM role (else the whole arm
  // is undriveable over the bus) and the shoulder role is honestly vacated.
  const arm = (pfx, sx) =>
    makeBone(
      pfx + "_Shoulder_jnt",
      [sx * 0.3, 0.1, 0],
      [
        makeBone(
          pfx + "_Elbow_jnt",
          [sx * 0.2, -0.02, 0],
          [makeBone(pfx + "_Wrist_jnt", [sx * 0.2, -0.02, 0], [makeBone(pfx + "_Wrist_end", [sx * 0.08, 0, 0])])]
        ),
      ]
    );
  const hips = makeBone(
    "Hips",
    [0, 1.0, 0],
    [
      makeBone(
        "Spine",
        [0, 0.12, 0],
        [makeBone("Neck", [0, 0.3, 0], [makeBone("Head", [0, 0.12, 0])]), arm("L", -1), arm("R", +1)]
      ),
    ]
  );
  const r = resolveRig(underArmature(hips));
  assert.equal(r.roles.left_arm?.name, "L_Shoulder_jnt", "the outboard shoulder bone IS the upper arm");
  assert.equal(r.roles.right_arm?.name, "R_Shoulder_jnt");
  assert.ok(!("left_shoulder" in r.roles), "the shoulder role is vacated, never double-driven");
  assert.equal(r.roles.left_forearm?.name, "L_Elbow_jnt", "elbow/wrist keep their joint-style mapping");
});

test("between-repair NEVER fabricates a middle bone when prox/dist are directly linked", () => {
  // shoulder → forearm directly (no upper-arm bone): left_arm must stay EMPTY, not alias the forearm
  const arm = (pfx, sx) =>
    makeBone(
      pfx + "Clavicle",
      [sx * 0.05, 0.1, 0],
      [
        makeBone(
          pfx + "ForeArm",
          [sx * 0.26, 0, 0],
          [makeBone(pfx + "Hand", [sx * 0.22, 0, 0], [makeBone(pfx + "Hand_end", [sx * 0.08, 0, 0])])]
        ),
      ]
    );
  const hips = makeBone(
    "Hips",
    [0, 1.0, 0],
    [
      makeBone(
        "Spine",
        [0, 0.12, 0],
        [makeBone("Neck", [0, 0.3, 0], [makeBone("Head", [0, 0.12, 0])]), arm("Left", -1), arm("Right", +1)]
      ),
    ]
  );
  const r = resolveRig(underArmature(hips));
  assert.ok(r.roles.left_forearm, "forearm still resolves");
  assert.ok(!("left_arm" in r.roles), "no upper arm bone exists → left_arm stays empty (not aliased to the forearm)");
});

// ── Minimal-name biped: a numeric-suffix shin must still be recovered ──────────────
// thigh "L_Leg", shin "L_Leg2" (lost the keyword → starts empty), foot "L_Foot". The shin is
// the bone between the resolved thigh and foot, so it must be filled (between/geometry), and
// proximal/distal ordering must be correct: thigh above shin above foot.
test("minimal-name biped: numeric-suffix shin (L_Leg2) is recovered, ordered thigh>shin>foot", () => {
  const r = resolveRig(minimalNameBiped());
  assert.deepEqual(r.matched, NINETEEN, "all 19 roles resolve despite the keyword-less shin");
  assert.equal(r.roles.left_shin?.name, "L_Leg2", "the middle leg bone holds left_shin");
  assert.equal(r.roles.right_shin?.name, "R_Leg2");
  assert.equal(r.roles.left_leg?.name, "L_Leg", "thigh keeps left_leg");
  assert.equal(r.roles.left_foot?.name, "L_Foot");
  assert.ok(wpos(r.roles.left_leg).y > wpos(r.roles.left_shin).y, "thigh above shin");
  assert.ok(wpos(r.roles.left_shin).y > wpos(r.roles.left_foot).y, "shin above foot");
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

// ── Boneless-scene safety: rig.js must degrade honestly on a scene with no bones (the no-model
// path renders an empty group + a DOM "add a model" hint), resolving ZERO roles, never throwing.
test("rig resolution on a boneless scene is inert: zero bones resolve, no roles, no crash", () => {
  const scene = new THREE.Group();
  const r = resolveRig(scene);
  assert.deepEqual(r.matched, [], "an empty scene resolves no roles");
  assert.deepEqual(r.report.bySource, {}, "no bones matched from any tier");
});
