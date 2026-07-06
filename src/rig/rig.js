// rig.js — bone IDENTIFICATION as a layered cascade, replacing the brittle single
// name-regex that lived in procedural.js + spring.js. One resolver maps a model's
// bones to canonical humanoid roles via generic tiers, each filling only roles still
// empty:
//
//   1) VRM humanoid  — vrm.humanoid.getRawBoneNode(...) — authoritative when present
//   2) name regex    — roleOfName(), lifted byte-for-byte from the old procedural.js
//   3) geometry      — topology + symmetry inference (opaque rigs: every bone "Bone037")
//   3.5) between     — structural middle-joint repair (a "shoulder"-named upper arm, etc.)
//
// Every tier is GENERIC — no per-model data. (The old per-model rig_overrides.json
// force/exclude tier was removed 2026-06-25, user: "nothing made specifically for any
// avatar"; a mis-identified rig is now fixed by improving a tier or repairing the model
// file, not by a hand-written map.) The pure tiers (resolveNames / resolveGeometry /
// roleOfName) run on a plain BoneSnapshot — no WebGL — so they're unit-testable with
// synthetic skeletons (see tests/).
import * as THREE from "three";

// The 19 canonical roles. MUST match bone_limits.json / tests/test_avatar_bone_data.py.
export const ROLES = [
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "left_shoulder",
  "left_arm",
  "left_forearm",
  "left_hand",
  "right_shoulder",
  "right_arm",
  "right_forearm",
  "right_hand",
  "left_leg",
  "left_shin",
  "left_foot",
  "right_leg",
  "right_shin",
  "right_foot",
];

// ── Tier 2: name regex (identical logic to the old procedural.js#roleOf + SKIP) ──
// SKIP: fingers/toes/face/dangly bits, IK helpers, deformation aids — "helper"/"twist"
// bones must never win a primary role over the real joint (avatar audit #4).
const SKIP =
  /pinky|index|middle|ring|thumb|finger|toe|eye|lid|jaw|tongue|hair|tail|cloth|skirt|helper|twist|ik$|_ik|ik-|-ik|target|pole|root.?joint|bolt|piston|string|bits|jig|pads?([^a-z]|$)/i;
// `pads?` + `jig` (model-zoo 2026-07-02): armor/accessory bones CONTAIN role words —
// "R_ShoulderPad_jnt" stole right_shoulder from the real "R_Shoulder_jnt" purely by traversal
// order (FNaF lolbit/mangle), and "L_Shoulder_Jiggle_jnt" is a secondary-motion aid, never the
// joint. The boundary check keeps "paddle"-ish names matchable. `jig` is deliberately bare
// (fnia 2026-07-02): GMod rigs spell it "ThighJigR" — with only /jiggle/ that helper STOLE the
// leg role and the knee bent sideways; no real joint name contains "jig".

export function roleOfName(raw) {
  const n = raw.toLowerCase();
  if (SKIP.test(n)) return null;
  // Side: left/right word or _l_/.l boundary, PLUS Blender ".L"/".R" tags that three.js
  // de-dotted on import into a glued uppercase L/R (upper_arm.L → "upper_armL"). Without
  // this every Blender/Rigify limb loses its side and stays in the bind T-pose (Toy Chica).
  // Daz Genesis (model-zoo 2026-07-02): the side tag is a BARE leading lowercase l/r glued to a
  // capitalized part — lShldrBend, rThighBend, lFoot. Neither the word-boundary rule nor the
  // Blender de-dot rule sees it, so every Daz limb lost its side and the whole body went undriven
  // (zhu_yuan: 4/19 roles from 493 bones).
  let side = "";
  if (/(^|[^a-z])l(eft)?([^a-z]|$)|left/.test(n) || /[a-z]L([_.]|\d|$)/.test(raw) || /^l[A-Z]/.test(raw)) side = "left";
  else if (/(^|[^a-z])r(ight)?([^a-z]|$)|right/.test(n) || /[a-z]R([_.]|\d|$)/.test(raw) || /^r[A-Z]/.test(raw))
    side = "right";
  const has = (re) => re.test(n);
  // Center bones are never side-tagged; a sided PELVIS (Bip_Pelvis_L/R) is an auxiliary
  // bone — reject it so the true center bone wins regardless of traversal order. A sided
  // HIP is different (fnia 2026-07-02): Source/GMod rigs name the THIGH joint "bip_hip_R",
  // so it falls through to the limb chain below and resolves as the leg.
  if (has(/pelvis/)) return side ? null : "hips";
  if (has(/(^|[^a-z])hips?([^a-z]|$)/) && !side) return "hips";
  if (has(/upperchest|chest/)) return side ? null : "chest";
  if (has(/spine|lowerback|waist|spine2|abdomen/)) return side ? null : "spine"; // abdomen = Daz spine
  if (has(/neck/)) return side ? null : "neck";
  if (has(/head/)) return side ? null : "head";
  let part = null;
  if (has(/shoulder|clavicle|collar|shldr/)) part = "shoulder";
  // collar/shldr = Daz clavicle + upper arm ("lCollar" wins the shoulder role first; "lShldrBend"
  // also maps shoulder but arrives second, so the between-repair then correctly fills the ARM
  // role with it — Collar -> ShldrBend -> ForearmBend has ShldrBend as the bone between.)
  else if (has(/forearm|elbow|lower[_ ]?arm/)) part = "forearm";
  else if (has(/hand|wrist/)) part = "hand";
  else if (has(/upper[_ ]?arm/) || (has(/arm(?!ature)/) && !has(/forearm/)))
    part = "arm"; // (?!ature): "Armature" is not an arm
  else if (has(/thigh|up[_ ]?leg|upper[_ ]?leg|(^|[^a-z])hips?([^a-z]|$)/))
    part = "leg"; // sided "hip" = Source-style thigh (bip_hip_R)
  else if (has(/calf|shin|knee|low(er)?[_ ]?leg/)) part = "shin";
  else if (has(/foot|ankle/)) part = "foot";
  else if (has(/leg/)) part = "leg";
  if (!part) return null;
  return side ? `${side}_${part}` : null; // limbs need a side
}

export function resolveNames(snap) {
  const roleIds = {};
  for (const b of snap) {
    const r = roleOfName(b.name);
    if (r && roleIds[r] == null) roleIds[r] = b.id; // first match wins (traversal order)
  }
  return roleIds;
}

// ── Snapshot: live model → plain POJO the pure tiers run on (world positions, and
// parent/children re-linked across non-bone Object3D gaps). Returns the parallel
// bones[] so the orchestrator can map a resolved id back to the live THREE bone. ──
const _v = new THREE.Vector3();
export function snapshotBones(model) {
  model.updateWorldMatrix(true, true);
  const bones = [];
  const idOf = new Map();
  model.traverse((o) => {
    if (o.isBone) {
      idOf.set(o, bones.length);
      bones.push(o);
    }
  });
  const nearestBoneAncestor = (o) => {
    let p = o.parent;
    while (p) {
      if (p.isBone && idOf.has(p)) return idOf.get(p);
      p = p.parent;
    }
    return -1;
  };
  const snap = bones.map((b, id) => {
    b.getWorldPosition(_v);
    return { id, name: b.name, pos: { x: _v.x, y: _v.y, z: _v.z }, parent: -1, children: [] };
  });
  for (let id = 0; id < bones.length; id++) {
    const par = nearestBoneAncestor(bones[id]);
    snap[id].parent = par;
    if (par >= 0) snap[par].children.push(id);
  }
  return { snap, bones };
}

// helper role lists
const armRoles = (side) => [`${side}_shoulder`, `${side}_arm`, `${side}_forearm`, `${side}_hand`];
const legRoles = (side) => [`${side}_leg`, `${side}_shin`, `${side}_foot`];

// ── Tier 3: geometric / topological inference (for roles the names didn't fill) ──
// Scale-free; tolerant of T- and mild A-pose binds (a steeply-down or pre-bent OPAQUE rig
// may not classify and just degrades to names). DEGRADES GRACEFULLY: a confident
// humanoid is required (hips + a rising spine + a mirrored LATERAL arm pair) before any role is
// emitted. Non-bipeds (GLaDOS's wires, a dragon's 4 down-legs + tail) fail that gate
// and return {} — their head/neck come from names, the dangly bits from
// spring physics — so geometry never mislabels them. Returns { role: id }.
export function resolveGeometry(snap, opts = {}) {
  const existing = opts.existing || {};
  const out = {};
  if (snap.length < 4) return out;

  const pos = (id) => snap[id].pos;
  const kids = (id) => snap[id].children;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const s of snap) {
    const p = s.pos;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const H = Math.max(1e-6, maxY - minY),
    W = Math.max(1e-6, maxX - minX),
    cx = (minX + maxX) / 2;
  const relY = (id) => (pos(id).y - minY) / H;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  const memoLeaf = new Array(snap.length).fill(-1);
  const leafCount = (id) => {
    if (memoLeaf[id] >= 0) return memoLeaf[id];
    const k = kids(id);
    if (!k.length) return (memoLeaf[id] = 1);
    let n = 0;
    for (const c of k) n += leafCount(c);
    return (memoLeaf[id] = n);
  };
  const farLeaf = (id) => {
    let best = pos(id),
      bd = -1;
    const stack = [id];
    while (stack.length) {
      const x = stack.pop();
      const k = kids(x);
      if (!k.length) {
        const d = dist(pos(id), pos(x));
        if (d > bd) {
          bd = d;
          best = pos(x);
        }
      } else for (const c of k) stack.push(c);
    }
    return best;
  };

  // 1) hips anchor — centered bone in the lower-mid band that roots the most leaves.
  let hipsId = existing.hips != null ? existing.hips : null;
  if (hipsId == null) {
    let best = null,
      bestScore = -1;
    for (const s of snap) {
      const ry = relY(s.id);
      if (ry < 0.3 || ry > 0.72) continue; // pelvis sits ~50–65% up; allow leggy rigs
      if (Math.abs(s.pos.x - cx) > 0.12 * W) continue;
      const score = leafCount(s.id) * 1000 - ry * 10;
      if (score > bestScore) {
        bestScore = score;
        best = s.id;
      }
    }
    hipsId = best;
  }
  if (hipsId == null) return out; // no pelvis → not a standing biped → emit nothing

  // 2) spine chain — walk up the centerline from hips.
  const chain = [hipsId];
  let cur = hipsId;
  for (let guard = 0; guard < 64; guard++) {
    const k = kids(cur).filter((c) => pos(c).y > pos(cur).y + 0.02 * H && Math.abs(pos(c).x - cx) < 0.12 * W);
    if (!k.length) break;
    k.sort((a, b) => Math.abs(pos(a).x - cx) - Math.abs(pos(b).x - cx) || pos(b).y - pos(a).y);
    cur = k[0];
    chain.push(cur);
  }
  const upper = chain.slice(1);
  const spineRise = upper.length ? (pos(upper[upper.length - 1]).y - pos(hipsId).y) / H : 0;

  // 3) limb branches off the chain → classify lateral (arm) vs downward (leg).
  const chainSet = new Set(chain);
  const branches = [];
  for (const node of chain) {
    for (const c of kids(node)) {
      if (chainSet.has(c)) continue;
      const bchain = [c];
      let b = c;
      for (let g = 0; g < 64; g++) {
        const bk = kids(b);
        if (bk.length !== 1) break;
        b = bk[0];
        bchain.push(b);
      }
      const fl = farLeaf(c);
      const dir = { x: fl.x - pos(node).x, y: fl.y - pos(node).y, z: fl.z - pos(node).z };
      const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
      dir.x /= dl;
      dir.y /= dl;
      dir.z /= dl;
      branches.push({ parent: node, dir, rootX: pos(c).x, reachLen: dist(pos(node), fl), chainBones: bchain });
    }
  }
  const armCand = branches.filter(
    (br) =>
      Math.abs(br.dir.x) >= Math.abs(br.dir.y) &&
      Math.abs(br.dir.x) >= Math.abs(br.dir.z) &&
      br.dir.y > -0.45 &&
      br.reachLen >= 0.12 * H
  );
  const legCand = branches.filter((br) => br.dir.y <= -0.45 && br.reachLen >= 0.15 * H);
  const pair = (cands) => {
    const left = cands.filter((b) => b.rootX < cx - 1e-4 * W).sort((a, b) => b.reachLen - a.reachLen);
    const right = cands.filter((b) => b.rootX > cx + 1e-4 * W).sort((a, b) => b.reachLen - a.reachLen);
    return left.length && right.length ? { left: left[0], right: right[0] } : null; // the single best mirrored pair
  };
  const arms = pair(armCand);
  const legs = pair(legCand);

  // CONFIDENCE GATE. Two ways to qualify as a humanoid worth filling:
  //  (a) the NAME tier resolved an ARM role → it's definitely a biped (a quadruped has FOUR
  //      legs and NO arms), so trust that and let geometry fill only the gaps. An arm is the
  //      load-bearing signal, NOT "any two limbs": a named quadruped (FrontLeftLeg/BackLeftLeg/
  //      ... → left_leg + right_leg) resolves two LEGS but zero arms, and two legs alone is the
  //      quadruped signature — it must fall through to (b) and FAIL, not bypass it.
  //  (b) names didn't prove an arm → demand strong geometry evidence: a rising spine, a lateral
  //      arm PAIR, AND arms attaching clearly ABOVE the legs. A winged quadruped (Toothless)
  //      pairs its wings laterally but they sit near its legs on a ~horizontal spine, so it
  //      FAILS (b) and returns {} — staying a spring-physics creature (tail + wings sway)
  //      rather than getting bogus limb idle. A named quadruped hits (b) too: its four legs are
  //      all DOWNWARD (legCand, never armCand), so no arm pair forms and the gate denies it.
  const armY = arms ? Math.min(relY(arms.left.parent), relY(arms.right.parent)) : 0;
  const legY = legs ? Math.max(relY(legs.left.parent), relY(legs.right.parent)) : null;
  const upright = !!arms && (legY == null ? armY >= 0.58 : armY - legY >= 0.12);
  const nameArm = existing.left_arm != null || existing.right_arm != null;
  if (!(nameArm || (spineRise >= 0.2 && upright))) return out;

  // 4) torso: head = top of chain; neck below; spine (lower) + chest (upper) between.
  if (upper.length) {
    if (existing.head == null) out.head = upper[upper.length - 1];
    const interior = upper.slice(0, -1);
    if (interior.length) {
      const neck = interior[interior.length - 1];
      if (relY(neck) >= 0.55 && existing.neck == null) out.neck = neck;
      const torso = interior.slice(0, -1);
      if (torso.length === 1) {
        if (existing.spine == null) out.spine = torso[0];
      } else if (torso.length >= 2) {
        if (existing.spine == null) out.spine = torso[0];
        if (existing.chest == null) out.chest = torso[torso.length - 1];
      }
    }
  }
  if (existing.hips == null) out.hips = hipsId;

  // 5) limb sub-roles — distal-anchored (hand/foot = chain end), so a missing shoulder
  // just leaves left_shoulder empty rather than shifting every role.
  const assignLimb = (branch, roles) => {
    let c = branch.chainBones.slice();
    // Drop a short end-tip leaf (toe / hand_end): only a leaf whose FINAL segment is much
    // shorter than the segment BEFORE it (compared to the previous segment, NOT the chain
    // average — so a genuine distal bone on a tip-less rig isn't wrongly dropped, which would
    // shift every limb role up by one). Needs ≥3 bones so there's a previous segment.
    if (c.length >= 3) {
      const segs = [];
      for (let i = 1; i < c.length; i++) segs.push(dist(pos(c[i - 1]), pos(c[i])));
      const L = segs.length - 1;
      if (kids(c[c.length - 1]).length === 0 && segs[L] < 0.5 * segs[L - 1]) c = c.slice(0, -1);
    }
    const distal = roles.slice().reverse(); // hand,forearm,arm,shoulder  /  foot,shin,leg
    for (let i = 0; i < distal.length && i < c.length; i++) {
      const id = c[c.length - 1 - i],
        role = distal[i];
      if (existing[role] == null && out[role] == null) out[role] = id;
    }
  };
  if (arms) {
    assignLimb(arms.left, armRoles("left"));
    assignLimb(arms.right, armRoles("right"));
  }
  if (legs) {
    assignLimb(legs.left, legRoles("left"));
    assignLimb(legs.right, legRoles("right"));
  }
  return out;
}

// ── Tier 3.5: structural "between" repair — fill a MIDDLE joint that naming/geometry missed
// because the rig uses JOINT-STYLE names. Many rigs name the UPPER ARM "shoulder"
// (shoulder→elbow→wrist), so the clavicle wins `${side}_shoulder` and the real upper arm is
// dropped — left_arm/right_arm stay empty on lola, sexy_roxanne, renamon (3 of 12 models, the
// single most-missed role). The fix needs no names at all: the bone sitting BETWEEN the resolved
// proximal and distal joints in the BONE HIERARCHY *is* the middle joint, anatomically always.
// Same shape recovers a chest between spine and neck. Fills only empty roles → never displaces a resolved one.
function boneBetween(snap, proxId, distId) {
  // walk up the parent chain from the distal bone; the child-of-prox on that path is the middle.
  let cur = distId;
  for (let g = 0; g < 128 && cur >= 0; g++) {
    const par = snap[cur].parent;
    if (par === proxId) return cur !== distId ? cur : -1; // cur===dist ⇒ prox & dist are directly linked, no middle bone exists
    cur = par;
  }
  return -1; // distal isn't a descendant of proximal (unexpected rig) → leave the gap
}
export function resolveBetween(snap, roleIds, source) {
  const fill = (midRole, proxRole, distRole) => {
    if (roleIds[midRole] != null || roleIds[proxRole] == null || roleIds[distRole] == null) return;
    const id = boneBetween(snap, roleIds[proxRole], roleIds[distRole]);
    if (id >= 0) {
      roleIds[midRole] = id;
      if (source) source[midRole] = "between";
    }
  };
  // Joint-style PROMOTION (model-zoo 2026-07-02): when the "shoulder" bone DIRECTLY parents the
  // elbow (Shoulder_jnt -> Elbow_jnt -> Wrist_jnt — no bone in between), that bone spans the
  // upper-arm segment: it IS the upper arm, there is no clavicle. Without this the arm role
  // stays empty and the whole arm is UNDRIVEABLE over the bus (FNaF lolbit/mangle). The bone
  // MOVES to the arm role (never duplicated — two roles on one bone would double-apply offsets);
  // the shoulder role is honestly vacated, like any rig without clavicles.
  // CLAVICLE GUARD (geometric, no names): a TRUE clavicle whose rig simply lacks an upper-arm
  // bone must NOT be promoted (driving it swings the whole girdle from an inboard pivot — the
  // pinned between-repair intent: never fake a bone that isn't there). The tell is the head
  // position: a clavicle head sits NEAR the centerline; a joint-style shoulder head sits OUT
  // at the arm line. Promote only when the head is already well outboard (>=50% of the elbow's
  // horizontal reach from the body's center). Corpus-measured 2026-07-02 (33 models): true
  // clavicles ratio 0.09-0.45, joint-style shoulders 0.55-1.05 — clean separation. KNOWN LATENT
  // EDGE (zero-trust audit): a FOLDED bind (elbow tucked inboard) compresses the elbow's reach
  // and can push a true clavicle over the threshold — no corpus rig combines a folded bind with
  // a missing upper-arm bone, but if one appears, tighten this with a shoulder-to-elbow segment
  // check rather than raw horiz ratios.
  const promote = (midRole, proxRole, distRole) => {
    if (roleIds[midRole] != null || roleIds[proxRole] == null || roleIds[distRole] == null) return;
    if (snap[roleIds[distRole]].parent !== roleIds[proxRole]) return; // a middle bone exists (fill's job) or unlinked
    const cId = roleIds.spine ?? roleIds.chest ?? roleIds.hips ?? roleIds.neck;
    if (cId == null) return; // no centerline reference -> stay conservative, leave the gap
    const c = snap[cId].pos;
    const horiz = (b) => Math.hypot(b.pos.x - c.x, b.pos.z - c.z);
    if (horiz(snap[roleIds[proxRole]]) < 0.5 * horiz(snap[roleIds[distRole]])) return; // inboard head = true clavicle
    roleIds[midRole] = roleIds[proxRole];
    delete roleIds[proxRole];
    if (source) {
      source[midRole] = "between";
      delete source[proxRole];
    }
  };
  fill("left_arm", "left_shoulder", "left_forearm"); // upper arm named "shoulder" (joint-style rigs)
  fill("right_arm", "right_shoulder", "right_forearm");
  promote("left_arm", "left_shoulder", "left_forearm"); // ...and when NO middle bone exists at all
  promote("right_arm", "right_shoulder", "right_forearm");
  fill("chest", "spine", "neck"); // an upper-torso bone the centerline walk skipped
  fill("left_shin", "left_leg", "left_foot"); // numeric-suffix shin (thigh "L_Leg", shin "L_Leg2" lost the keyword)
  fill("right_shin", "right_leg", "right_foot");
}

// VRM humanoid bone name → our role (left/right are VRM's anatomical sides).
const VRM_TO_ROLE = [
  ["hips", "hips"],
  ["spine", "spine"],
  ["chest", "chest"],
  ["upperChest", "chest"],
  ["neck", "neck"],
  ["head", "head"],
  ["leftShoulder", "left_shoulder"],
  ["leftUpperArm", "left_arm"],
  ["leftLowerArm", "left_forearm"],
  ["leftHand", "left_hand"],
  ["rightShoulder", "right_shoulder"],
  ["rightUpperArm", "right_arm"],
  ["rightLowerArm", "right_forearm"],
  ["rightHand", "right_hand"],
  ["leftUpperLeg", "left_leg"],
  ["leftLowerLeg", "left_shin"],
  ["leftFoot", "left_foot"],
  ["rightUpperLeg", "right_leg"],
  ["rightLowerLeg", "right_shin"],
  ["rightFoot", "right_foot"],
];
const safeVrmBone = (vrm, name) => {
  try {
    return vrm.humanoid.getRawBoneNode(name) || null;
  } catch {
    return null;
  }
};

// ── Orchestrator: run the four tiers and return live-bone role map + diagnostics. ──
export function resolveRig(model, vrm = null) {
  const { snap, bones } = snapshotBones(model);
  const boneToId = new Map(bones.map((b, i) => [b, i]));
  const byName = new Map();
  for (const s of snap) if (!byName.has(s.name)) byName.set(s.name, s.id);

  const roleIds = {},
    source = {};
  const fill = (role, id, tier) => {
    if (id != null && id >= 0 && roleIds[role] == null) {
      roleIds[role] = id;
      source[role] = tier;
    }
  };

  // (the per-model override force/exclude tier was removed 2026-06-25 — the excludeIds hook the
  // tiers used to thread through was dead scaffolding and is gone with it)
  if (vrm?.humanoid?.getRawBoneNode) {
    // tier 1
    for (const [vrmName, role] of VRM_TO_ROLE) {
      const node = safeVrmBone(vrm, vrmName);
      const id = node ? boneToId.get(node) : null;
      if (id != null) fill(role, id, "vrm");
    }
  }
  const nameIds = resolveNames(snap); // tier 2
  for (const role in nameIds) fill(role, nameIds[role], "name");
  if (ROLES.some((r) => roleIds[r] == null)) {
    // tier 3 (only if gaps)
    const geo = resolveGeometry(snap, { existing: roleIds });
    for (const role in geo) fill(role, geo[role], "geometry");
  }
  resolveBetween(snap, roleIds, source); // tier 3.5: structural middle-joint repair (joint-style "shoulder" = upper arm)

  const roles = {};
  for (const r in roleIds) roles[r] = bones[roleIds[r]];
  const bySource = {};
  for (const r in source) bySource[source[r]] = (bySource[source[r]] || 0) + 1;
  return {
    roles,
    source,
    matched: Object.keys(roles).sort(),
    springExclude: new Set(Object.values(roles)),
    report: { bySource, unresolved: ROLES.filter((r) => roleIds[r] == null) },
  };
}
