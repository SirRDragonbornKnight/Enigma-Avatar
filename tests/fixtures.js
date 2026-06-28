// Synthetic THREE.Bone skeletons for rig tests — no WebGL/renderer needed.
// Bone/Object3D matrix math runs headless in Node, so we can build a skeleton,
// hand it to buildProceduralRig / buildSpringBones / resolveRig, and assert on the
// resolved role map. Positions are LOCAL (relative to parent); world positions
// compose via updateWorldMatrix (which the rig code calls).
import * as THREE from "three";

export function makeBone(name, pos = [0, 0, 0], children = []) {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(pos[0], pos[1], pos[2]);
  for (const c of children) b.add(c);
  return b;
}

// Wrap a skeleton root under a non-bone "Armature" Object3D — the common glTF shape,
// and it exercises the `arm(?!ature)` guard: "Armature" must NEVER become an arm.
export function underArmature(rootBone, name = "Armature") {
  const g = new THREE.Object3D();
  g.name = name;
  g.add(rootBone);
  return g;
}

// ── arm/leg chain helpers (sx = +1 right side of model-space, -1 left) ──────────
function arm(prefix, sx, { shoulder = "Shoulder", upper = "UpperArm", fore = "Forearm", hand = "Hand" } = {}) {
  return makeBone(
    prefix + shoulder,
    [sx * 0.05, 0.1, 0],
    [
      makeBone(
        prefix + upper,
        [sx * 0.13, 0, 0],
        [
          makeBone(
            prefix + fore,
            [sx * 0.26, 0, 0],
            [
              makeBone(
                prefix + hand,
                [sx * 0.22, 0, 0],
                [
                  makeBone(prefix + "Hand_end", [sx * 0.08, 0, 0]), // leaf so `hand` has a child to orient
                  // a real FINGER chain (3 joints) — exercises the finger-curl calibration + grip layer
                  // (the audit caught the grip test passing vacuously on a finger-less fixture)
                  makeBone(
                    prefix + "IndexFinger1",
                    [sx * 0.07, 0, 0.02],
                    [
                      makeBone(
                        prefix + "IndexFinger2",
                        [sx * 0.035, 0, 0],
                        [makeBone(prefix + "IndexFinger3", [sx * 0.025, 0, 0])]
                      ),
                    ]
                  ),
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );
}
function leg(prefix, sx, { thigh = "Thigh", shin = "Shin", foot = "Foot" } = {}) {
  return makeBone(
    prefix + thigh,
    [sx * 0.1, -0.05, 0],
    [
      makeBone(
        prefix + shin,
        [0, -0.42, 0],
        [
          makeBone(
            prefix + foot,
            [0, -0.42, 0],
            [
              makeBone(prefix + "Toe", [0, -0.05, 0.12]), // leaf so `foot` has a child
            ]
          ),
        ]
      ),
    ]
  );
}

// ── A clean humanoid whose names map to all 19 canonical roles ──────────────────
// (distinct chest + shin names, unlike Mixamo which lacks both). The positive
// "everything resolves" case.
export function fullBiped() {
  const hips = makeBone(
    "Hips",
    [0, 1.0, 0],
    [
      makeBone(
        "Spine",
        [0, 0.12, 0],
        [
          makeBone(
            "Chest",
            [0, 0.14, 0],
            [
              makeBone("Neck", [0, 0.16, 0], [makeBone("Head", [0, 0.1, 0], [makeBone("Head_end", [0, 0.18, 0])])]),
              arm("Left", -1),
              arm("Right", +1),
            ]
          ),
        ]
      ),
      leg("Left", -1),
      leg("Right", +1),
    ]
  );
  return underArmature(hips);
}

// ── Blender/Rigify rig: ".L"/".R" de-dotted by three.js into a glued "L"/"R" ────
// (upper_arm.L → "upper_armL"). Without raw-side detection these limbs lose their
// side and stay T-posed (the Toy Chica bug). Also has an "Armature" root to assert
// it isn't stolen into an arm role.
export function blenderBiped() {
  const hips = makeBone(
    "hips",
    [0, 1.0, 0],
    [
      makeBone(
        "spine",
        [0, 0.12, 0],
        [
          makeBone(
            "chest",
            [0, 0.14, 0],
            [
              makeBone("neck", [0, 0.16, 0], [makeBone("head", [0, 0.1, 0], [makeBone("head_end", [0, 0.18, 0])])]),
              arm("", -1, { shoulder: "shoulderL", upper: "upper_armL", fore: "forearmL", hand: "handL" }),
              arm("", +1, { shoulder: "shoulderR", upper: "upper_armR", fore: "forearmR", hand: "handR" }),
            ]
          ),
        ]
      ),
      leg("", -1, { thigh: "thighL", shin: "shinL", foot: "footL" }),
      leg("", +1, { thigh: "thighR", shin: "shinR", foot: "footR" }),
    ]
  );
  return underArmature(hips);
}

// ── A rig with dangly bits to exercise spring-bone NAME detection ───────────────
// hair chain, BackStrand chain (the 51dc case), a tail, a skirt — and decoys that
// must NOT spring: a "forearm" (forEARm — `ear` preceded by `for`) and a "Finger".
export function hairRig() {
  const hair = makeBone(
    "Hair",
    [0, 0.05, 0],
    [makeBone("Hair_01", [0, -0.12, 0], [makeBone("Hair_02", [0, -0.12, 0], [makeBone("Hair_03", [0, -0.12, 0])])])]
  );
  const strand = makeBone(
    "BackStrand0",
    [0.06, 0, -0.02],
    [
      makeBone(
        "BackStrand1",
        [0, -0.14, 0],
        [makeBone("BackStrand2", [0, -0.14, 0], [makeBone("BackStrand3", [0, -0.14, 0])])]
      ),
    ]
  );
  const tail = makeBone(
    "Tail",
    [0, 0, -0.1],
    [makeBone("Tail_01", [0, 0, -0.14], [makeBone("Tail_02", [0, 0, -0.14])])]
  );
  const skirt = makeBone("Skirt_F", [0, -0.05, 0.08], [makeBone("Skirt_F_end", [0, -0.2, 0])]);
  const head = makeBone("Head", [0, 0.6, 0], [hair, strand]);
  const forearmDecoy = makeBone("forearmL", [-0.2, 0.2, 0], [makeBone("handL", [-0.2, 0, 0])]);
  const fingerDecoy = makeBone("Finger1", [-0.05, 0, 0], [makeBone("Finger2", [-0.04, 0, 0])]);
  const hips = makeBone("Hips", [0, 1.0, 0], [head, tail, skirt, forearmDecoy, fingerDecoy]);
  return underArmature(hips);
}

// ── An opaque biped: identical geometry to fullBiped, but every bone has a junk
// name (no left/right, no body-part word) so ONLY the geometry tier can resolve it. ──
export function opaqueBiped() {
  let n = 0;
  const nm = () => "j" + n++;
  const armO = (sx) =>
    makeBone(
      nm(),
      [sx * 0.05, 0.1, 0],
      [
        makeBone(
          nm(),
          [sx * 0.13, 0, 0],
          [makeBone(nm(), [sx * 0.26, 0, 0], [makeBone(nm(), [sx * 0.22, 0, 0], [makeBone(nm(), [sx * 0.08, 0, 0])])])]
        ),
      ]
    );
  const legO = (sx) =>
    makeBone(
      nm(),
      [sx * 0.1, -0.05, 0],
      [makeBone(nm(), [0, -0.42, 0], [makeBone(nm(), [0, -0.42, 0], [makeBone(nm(), [0, -0.05, 0.12])])])]
    );
  const hips = makeBone(
    nm(),
    [0, 1.0, 0],
    [
      makeBone(
        nm(),
        [0, 0.12, 0],
        [
          // spine
          makeBone(
            nm(),
            [0, 0.14, 0],
            [
              // chest
              makeBone(
                nm(),
                [0, 0.16, 0],
                [
                  // neck
                  makeBone(nm(), [0, 0.1, 0]), // head (leaf)
                ]
              ),
              armO(-1),
              armO(+1),
            ]
          ),
        ]
      ),
      legO(-1),
      legO(+1),
    ]
  );
  return underArmature(hips);
}

// ── GLaDOS-like: a head on a vertical stalk + asymmetric hanging wires (NO mirrored
// lateral limbs). The geometry tier must assign NO arms/legs (degrade gracefully). ──
export function gladosLike() {
  let n = 0;
  const nm = () => "g" + n++;
  const wire = (x, z) => makeBone(nm(), [x, -0.1, z], [makeBone(nm(), [0, -0.35, 0], [makeBone(nm(), [0, -0.35, 0])])]);
  const head = makeBone(nm(), [0, -0.3, 0], [makeBone(nm(), [0, -0.2, 0])]); // head + tip, hanging down
  const neck = makeBone(nm(), [0, -0.3, 0], [head]);
  const mount = makeBone(
    nm(),
    [0, 2.4, 0],
    [
      // ceiling mount, top
      neck,
      wire(0.3, 0.1),
      wire(0.55, -0.2),
      wire(-0.2, 0.3),
      wire(0.15, 0.45), // asymmetric wires
    ]
  );
  return underArmature(mount, "Root");
}

// ── Quadruped: horizontal spine, four DOWNWARD legs (two mirrored pairs), a tail.
// No lateral arm pair → the humanoid gate fails → geometry assigns nothing. ──
export function quadruped() {
  let n = 0;
  const nm = () => "q" + n++;
  const legD = (x, z) => makeBone(nm(), [x, 0, z], [makeBone(nm(), [0, -0.45, 0], [makeBone(nm(), [0, -0.45, 0])])]);
  const root = makeBone(
    nm(),
    [0, 1.0, 0],
    [
      makeBone(nm(), [0, 0, -0.7], [makeBone(nm(), [0, 0, -0.4])]), // tail (-Z)
      makeBone(nm(), [0, 0.1, 0.7], [makeBone(nm(), [0, 0.1, 0.3])]), // neck/head (+Z)
      legD(-0.3, 0.5),
      legD(0.3, 0.5),
      legD(-0.3, -0.5),
      legD(0.3, -0.5),
    ]
  );
  return underArmature(root);
}

// ── A NAMED quadruped: a horizontal spine + four DOWNWARD legs whose names resolve to
// left_leg/right_leg (FrontLeftLeg/BackLeftLeg/...), a named Hips, neck/head and a tail.
// It has NO arms. The name tier resolves two LEGS but zero arms, so the humanoid gate must
// NOT trust it on legs alone (two legs = quadruped signature); geometry sees four downward
// legs on a flat spine → no lateral arm pair → no false arm/torso roles. ──
export function namedQuadruped() {
  // legs splay slightly outward then drop straight down (clearly downward, never lateral).
  const legD = (name, x, z) =>
    makeBone(
      name,
      [x, 0, z],
      [makeBone(name + "_Knee", [x * 0.1, -0.45, 0], [makeBone(name + "_Foot", [0, -0.45, 0])])]
    );
  const hips = makeBone(
    "Hips",
    [0, 1.0, 0],
    [
      makeBone("Tail", [0, 0, -0.7], [makeBone("Tail_01", [0, 0, -0.4])]), // -Z
      makeBone("Neck", [0, 0.1, 0.7], [makeBone("Head", [0, 0.1, 0.3])]), // +Z, near-horizontal
      legD("FrontLeftLeg", -0.3, 0.5),
      legD("FrontRightLeg", 0.3, 0.5),
      legD("BackLeftLeg", -0.3, -0.5),
      legD("BackRightLeg", 0.3, -0.5),
    ]
  );
  return underArmature(hips);
}

// ── A minimal-name biped whose LEG chain uses a numeric suffix: thigh "L_Leg", shin
// "L_Leg2" (lost the shin keyword), foot "L_Foot". First-match keeps left_leg on the thigh
// and L_Leg2 name-resolves to nothing, so the shin starts EMPTY — it must be recovered (the
// bone between the resolved thigh and foot). Arms are fully named so the rig is unambiguously
// a biped without leaning on the leg names. ──
export function minimalNameBiped() {
  const armC = (pfx, sx) =>
    makeBone(
      pfx + "Shoulder",
      [sx * 0.05, 0.1, 0],
      [
        makeBone(
          pfx + "UpperArm",
          [sx * 0.13, 0, 0],
          [
            makeBone(
              pfx + "Forearm",
              [sx * 0.26, 0, 0],
              [makeBone(pfx + "Hand", [sx * 0.22, 0, 0], [makeBone(pfx + "Hand_end", [sx * 0.08, 0, 0])])]
            ),
          ]
        ),
      ]
    );
  // thigh "L_Leg", shin "L_Leg2" (numeric-suffix gap), foot "L_Foot".
  const legC = (sx, side) =>
    makeBone(
      side + "_Leg",
      [sx * 0.1, -0.05, 0],
      [
        makeBone(
          side + "_Leg2",
          [0, -0.42, 0],
          [makeBone(side + "_Foot", [0, -0.42, 0], [makeBone(side + "_Toe", [0, -0.05, 0.12])])]
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
          makeBone(
            "Chest",
            [0, 0.14, 0],
            [
              makeBone("Neck", [0, 0.16, 0], [makeBone("Head", [0, 0.1, 0], [makeBone("Head_end", [0, 0.18, 0])])]),
              armC("Left", -1),
              armC("Right", +1),
            ]
          ),
        ]
      ),
      legC(-1, "L"),
      legC(+1, "R"),
    ]
  );
  return underArmature(hips);
}

// ── A stand-in for @pixiv/three-vrm's vrm.humanoid: maps standard VRM bone names to
// the matching bones in a built skeleton (so the VRM tier can be tested with no file). ──
const VRM_NAME_TO_FIXTURE = {
  hips: "Hips",
  spine: "Spine",
  chest: "Chest",
  neck: "Neck",
  head: "Head",
  leftShoulder: "LeftShoulder",
  leftUpperArm: "LeftUpperArm",
  leftLowerArm: "LeftForearm",
  leftHand: "LeftHand",
  rightShoulder: "RightShoulder",
  rightUpperArm: "RightUpperArm",
  rightLowerArm: "RightForearm",
  rightHand: "RightHand",
  leftUpperLeg: "LeftThigh",
  leftLowerLeg: "LeftShin",
  leftFoot: "LeftFoot",
  rightUpperLeg: "RightThigh",
  rightLowerLeg: "RightShin",
  rightFoot: "RightFoot",
};
export function fakeVrm(skeletonRoot) {
  const byName = {};
  skeletonRoot.traverse((o) => {
    if (o.isBone) byName[o.name] = o;
  });
  return { humanoid: { getRawBoneNode: (vname) => byName[VRM_NAME_TO_FIXTURE[vname]] || null } };
}

// ── An opaque biped with NO end-tip bones (hand/foot ARE the chain leaves) — locks that a
// tip-less rig maps distal roles correctly (no role-shift from the tip-drop heuristic). ──
export function opaqueBipedNoTips() {
  let n = 0;
  const nm = () => "k" + n++;
  const armO = (sx) =>
    makeBone(
      nm(),
      [sx * 0.05, 0.1, 0],
      [
        makeBone(
          nm(),
          [sx * 0.13, 0, 0],
          [
            makeBone(
              nm(),
              [sx * 0.26, 0, 0],
              [
                makeBone(nm(), [sx * 0.22, 0, 0]), // hand — LEAF, no tip
              ]
            ),
          ]
        ),
      ]
    );
  const legO = (sx) =>
    makeBone(
      nm(),
      [sx * 0.1, -0.05, 0],
      [
        makeBone(
          nm(),
          [0, -0.42, 0],
          [
            makeBone(nm(), [0, -0.42, 0]), // foot — LEAF, no toe
          ]
        ),
      ]
    );
  const hips = makeBone(
    nm(),
    [0, 1.0, 0],
    [
      makeBone(
        nm(),
        [0, 0.12, 0],
        [
          makeBone(
            nm(),
            [0, 0.14, 0],
            [makeBone(nm(), [0, 0.16, 0], [makeBone(nm(), [0, 0.1, 0])]), armO(-1), armO(+1)]
          ),
        ]
      ),
      legO(-1),
      legO(+1),
    ]
  );
  return underArmature(hips);
}
