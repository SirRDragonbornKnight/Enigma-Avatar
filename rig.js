// rig.js — bone IDENTIFICATION as a layered cascade, replacing the brittle single
// name-regex that lived in procedural.js + spring.js. One resolver maps a model's
// bones to canonical humanoid roles via four tiers, each filling only roles still
// empty (except OVERRIDE, which forces):
//
//   1) VRM humanoid  — vrm.humanoid.getRawBoneNode(...) — authoritative when present
//   2) name regex    — roleOfName(), lifted byte-for-byte from the old procedural.js
//   3) geometry      — topology + symmetry inference (opaque rigs: every bone "Bone037")
//   4) override JSON  — per-model rig_overrides.json: force a role / exclude a bone
//
// The pure tiers (resolveNames / resolveGeometry / applyOverride / roleOfName) run on
// a plain BoneSnapshot — no WebGL — so they're unit-testable with synthetic skeletons
// (see tests/). Why a cascade and not "move the mesh": skeletal animation needs the
// bones; the hard part was always IDENTIFYING them, so we make identification robust
// and turn a future miss into a 1-line rig_overrides.json edit, not a regex change.
import * as THREE from "three";

// The 19 canonical roles. MUST match bone_limits.json / tests/test_avatar_bone_data.py.
export const ROLES = [
  "hips", "spine", "chest", "neck", "head",
  "left_shoulder", "left_arm", "left_forearm", "left_hand",
  "right_shoulder", "right_arm", "right_forearm", "right_hand",
  "left_leg", "left_shin", "left_foot",
  "right_leg", "right_shin", "right_foot",
];
export const CENTER_ROLES = new Set(["hips", "spine", "chest", "neck", "head"]);

// ── Tier 2: name regex (identical logic to the old procedural.js#roleOf + SKIP) ──
// SKIP: fingers/toes/face/dangly bits, IK helpers, deformation aids — "helper"/"twist"
// bones must never win a primary role over the real joint (avatar audit #4).
const SKIP = /pinky|index|middle|ring|thumb|finger|toe|eye|lid|jaw|tongue|hair|tail|cloth|skirt|helper|twist|ik$|_ik|ik-|-ik|target|pole|root.?joint|bolt|piston|string|bits/i;

export function roleOfName(raw) {
  const n = raw.toLowerCase();
  if (SKIP.test(n)) return null;
  // Side: left/right word or _l_/.l boundary, PLUS Blender ".L"/".R" tags that three.js
  // de-dotted on import into a glued uppercase L/R (upper_arm.L → "upper_armL"). Without
  // this every Blender/Rigify limb loses its side and stays in the bind T-pose (Toy Chica).
  let side = "";
  if (/(^|[^a-z])l(eft)?([^a-z]|$)|left/.test(n) || /[a-z]L([_.]|\d|$)/.test(raw)) side = "left";
  else if (/(^|[^a-z])r(ight)?([^a-z]|$)|right/.test(n) || /[a-z]R([_.]|\d|$)/.test(raw)) side = "right";
  const has = (re) => re.test(n);
  // Center bones are never side-tagged; a sided match (Bip_Pelvis_L/R) is an auxiliary
  // bone — reject it so the true center bone wins regardless of traversal order.
  if (has(/hips?|pelvis/)) return side ? null : "hips";
  if (has(/upperchest|chest/)) return side ? null : "chest";
  if (has(/spine|lowerback|waist|spine2/)) return side ? null : "spine";
  if (has(/neck/)) return side ? null : "neck";
  if (has(/head/)) return side ? null : "head";
  let part = null;
  if (has(/shoulder|clavicle/)) part = "shoulder";
  else if (has(/forearm|elbow|lower[_ ]?arm/)) part = "forearm";
  else if (has(/hand|wrist/)) part = "hand";
  else if (has(/upper[_ ]?arm/) || (has(/arm(?!ature)/) && !has(/forearm/))) part = "arm";   // (?!ature): "Armature" is not an arm
  else if (has(/thigh|up[_ ]?leg|upper[_ ]?leg/)) part = "leg";
  else if (has(/calf|shin|knee|low(er)?[_ ]?leg/)) part = "shin";
  else if (has(/foot|ankle/)) part = "foot";
  else if (has(/leg/)) part = "leg";
  if (!part) return null;
  return side ? `${side}_${part}` : null;   // limbs need a side
}

export function resolveNames(snap, excludeIds = new Set()) {
  const roleIds = {};
  for (const b of snap) {
    if (excludeIds.has(b.id)) continue;
    const r = roleOfName(b.name);
    if (r && roleIds[r] == null) roleIds[r] = b.id;   // first match wins (traversal order)
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
  model.traverse((o) => { if (o.isBone) { idOf.set(o, bones.length); bones.push(o); } });
  const nearestBoneAncestor = (o) => { let p = o.parent; while (p) { if (p.isBone && idOf.has(p)) return idOf.get(p); p = p.parent; } return -1; };
  const snap = bones.map((b, id) => { b.getWorldPosition(_v); return { id, name: b.name, pos: { x: _v.x, y: _v.y, z: _v.z }, parent: -1, children: [] }; });
  for (let id = 0; id < bones.length; id++) { const par = nearestBoneAncestor(bones[id]); snap[id].parent = par; if (par >= 0) snap[par].children.push(id); }
  return { snap, bones };
}

// helper role lists
const armRoles = (side) => [`${side}_shoulder`, `${side}_arm`, `${side}_forearm`, `${side}_hand`];
const legRoles = (side) => [`${side}_leg`, `${side}_shin`, `${side}_foot`];

// ── Tier 3: geometric / topological inference (for roles the names didn't fill) ──
// Scale-free; tolerant of T- and mild A-pose binds (a steeply-down or pre-bent OPAQUE rig
// may not classify and just degrades to names/override). DEGRADES GRACEFULLY: a confident
// humanoid is required (hips + a rising spine + a mirrored LATERAL arm pair) before any role is
// emitted. Non-bipeds (GLaDOS's wires, a dragon's 4 down-legs + tail) fail that gate
// and return {} — their head/neck come from names/override, the dangly bits from
// spring physics — so geometry never mislabels them. Returns { role: id }.
export function resolveGeometry(snap, opts = {}) {
  const existing = opts.existing || {};
  const exclude = opts.excludeIds || new Set();
  const out = {};
  if (snap.length < 4) return out;

  const pos = (id) => snap[id].pos;
  const kids = (id) => snap[id].children.filter((c) => !exclude.has(c));
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const s of snap) { const p = s.pos; if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z; }
  const H = Math.max(1e-6, maxY - minY), W = Math.max(1e-6, maxX - minX), cx = (minX + maxX) / 2;
  const relY = (id) => (pos(id).y - minY) / H;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  const memoLeaf = new Array(snap.length).fill(-1);
  const leafCount = (id) => { if (memoLeaf[id] >= 0) return memoLeaf[id]; const k = kids(id); if (!k.length) return memoLeaf[id] = 1; let n = 0; for (const c of k) n += leafCount(c); return memoLeaf[id] = n; };
  const farLeaf = (id) => { let best = pos(id), bd = -1; const stack = [id]; while (stack.length) { const x = stack.pop(); const k = kids(x); if (!k.length) { const d = dist(pos(id), pos(x)); if (d > bd) { bd = d; best = pos(x); } } else for (const c of k) stack.push(c); } return best; };

  // 1) hips anchor — centered bone in the lower-mid band that roots the most leaves.
  let hipsId = existing.hips != null ? existing.hips : null;
  if (hipsId == null) {
    let best = null, bestScore = -1;
    for (const s of snap) {
      if (exclude.has(s.id)) continue;
      const ry = relY(s.id);
      if (ry < 0.30 || ry > 0.72) continue;   // pelvis sits ~50–65% up; allow leggy rigs
      if (Math.abs(s.pos.x - cx) > 0.12 * W) continue;
      const score = leafCount(s.id) * 1000 - ry * 10;
      if (score > bestScore) { bestScore = score; best = s.id; }
    }
    hipsId = best;
  }
  if (hipsId == null) return out;   // no pelvis → not a standing biped → emit nothing

  // 2) spine chain — walk up the centerline from hips.
  const chain = [hipsId]; let cur = hipsId;
  for (let guard = 0; guard < 64; guard++) {
    const k = kids(cur).filter((c) => pos(c).y > pos(cur).y + 0.02 * H && Math.abs(pos(c).x - cx) < 0.12 * W);
    if (!k.length) break;
    k.sort((a, b) => (Math.abs(pos(a).x - cx) - Math.abs(pos(b).x - cx)) || (pos(b).y - pos(a).y));
    cur = k[0]; chain.push(cur);
  }
  const upper = chain.slice(1);
  const spineRise = upper.length ? (pos(upper[upper.length - 1]).y - pos(hipsId).y) / H : 0;

  // 3) limb branches off the chain → classify lateral (arm) vs downward (leg).
  const chainSet = new Set(chain);
  const branches = [];
  for (const node of chain) {
    for (const c of kids(node)) {
      if (chainSet.has(c)) continue;
      const bchain = [c]; let b = c;
      for (let g = 0; g < 64; g++) { const bk = kids(b); if (bk.length !== 1) break; b = bk[0]; bchain.push(b); }
      const fl = farLeaf(c);
      const dir = { x: fl.x - pos(node).x, y: fl.y - pos(node).y, z: fl.z - pos(node).z };
      const dl = Math.hypot(dir.x, dir.y, dir.z) || 1; dir.x /= dl; dir.y /= dl; dir.z /= dl;
      branches.push({ parent: node, dir, rootX: pos(c).x, reachLen: dist(pos(node), fl), chainBones: bchain });
    }
  }
  const armCand = branches.filter((br) => Math.abs(br.dir.x) >= Math.abs(br.dir.y) && Math.abs(br.dir.x) >= Math.abs(br.dir.z) && br.dir.y > -0.45 && br.reachLen >= 0.12 * H);
  const legCand = branches.filter((br) => br.dir.y <= -0.45 && br.reachLen >= 0.15 * H);
  const pair = (cands) => {
    const left = cands.filter((b) => b.rootX < cx - 1e-4 * W).sort((a, b) => b.reachLen - a.reachLen);
    const right = cands.filter((b) => b.rootX > cx + 1e-4 * W).sort((a, b) => b.reachLen - a.reachLen);
    return (left.length && right.length) ? { left: left[0], right: right[0] } : null;   // the single best mirrored pair
  };
  const arms = pair(armCand);
  const legs = pair(legCand);

  // CONFIDENCE GATE. Two ways to qualify as a humanoid worth filling:
  //  (a) the NAME tier already resolved ≥2 of the four limbs → it's definitely a biped,
  //      so trust that and let geometry fill only the gaps (center bones, a missing limb).
  //  (b) names found ~nothing (opaque rig) → demand strong geometry evidence: a rising
  //      spine, a lateral arm pair, AND arms attaching clearly ABOVE the legs. A winged
  //      quadruped (Toothless) pairs its wings laterally but they sit near its legs on a
  //      ~horizontal spine, so it FAILS (b) and returns {} — staying a spring-physics
  //      creature (tail + wings sway) rather than getting bogus limb idle.
  const armY = arms ? Math.min(relY(arms.left.parent), relY(arms.right.parent)) : 0;
  const legY = legs ? Math.max(relY(legs.left.parent), relY(legs.right.parent)) : null;
  const upright = !!arms && (legY == null ? armY >= 0.58 : (armY - legY) >= 0.12);
  const nameHumanoid = ["left_arm", "right_arm", "left_leg", "right_leg"].filter((r) => existing[r] != null).length >= 2;
  if (!(nameHumanoid || (spineRise >= 0.20 && upright))) return out;

  // 4) torso: head = top of chain; neck below; spine (lower) + chest (upper) between.
  if (upper.length) {
    if (existing.head == null) out.head = upper[upper.length - 1];
    const interior = upper.slice(0, -1);
    if (interior.length) {
      const neck = interior[interior.length - 1];
      if (relY(neck) >= 0.55 && existing.neck == null) out.neck = neck;
      const torso = interior.slice(0, -1);
      if (torso.length === 1) { if (existing.spine == null) out.spine = torso[0]; }
      else if (torso.length >= 2) { if (existing.spine == null) out.spine = torso[0]; if (existing.chest == null) out.chest = torso[torso.length - 1]; }
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
      const segs = []; for (let i = 1; i < c.length; i++) segs.push(dist(pos(c[i - 1]), pos(c[i])));
      const L = segs.length - 1;
      if (kids(c[c.length - 1]).length === 0 && segs[L] < 0.5 * segs[L - 1]) c = c.slice(0, -1);
    }
    const distal = roles.slice().reverse();               // hand,forearm,arm,shoulder  /  foot,shin,leg
    for (let i = 0; i < distal.length && i < c.length; i++) {
      const id = c[c.length - 1 - i], role = distal[i];
      if (existing[role] == null && out[role] == null) out[role] = id;
    }
  };
  if (arms) { assignLimb(arms.left, armRoles("left")); assignLimb(arms.right, armRoles("right")); }
  if (legs) { assignLimb(legs.left, legRoles("left")); assignLimb(legs.right, legRoles("right")); }
  return out;
}

// ── Tier 4: per-model override (force / exclude). Mutates roleIds + source. ──
export function applyOverride(roleIds, source, entry, byName) {
  if (!entry) return;
  const ex = Array.isArray(entry.exclude) ? new Set(entry.exclude.map((nm) => byName.get(nm)).filter((x) => x != null)) : new Set();
  if (ex.size) for (const r of Object.keys(roleIds)) if (ex.has(roleIds[r])) { delete roleIds[r]; delete source[r]; }
  if (entry.roles && typeof entry.roles === "object") {
    for (const [role, name] of Object.entries(entry.roles)) {
      const id = byName.get(name);
      if (id == null) { console.warn(`[avatar] rig override: bone "${name}" for role "${role}" not found`); continue; }
      if (ex.has(id)) { console.warn(`[avatar] rig override: "${name}" is both excluded and forced to "${role}" — exclude wins`); continue; }
      roleIds[role] = id; source[role] = "override";     // FORCE — beats vrm/name/geometry (but NOT exclude)
    }
  }
}

// VRM humanoid bone name → our role (left/right are VRM's anatomical sides).
const VRM_TO_ROLE = [
  ["hips", "hips"], ["spine", "spine"], ["chest", "chest"], ["upperChest", "chest"], ["neck", "neck"], ["head", "head"],
  ["leftShoulder", "left_shoulder"], ["leftUpperArm", "left_arm"], ["leftLowerArm", "left_forearm"], ["leftHand", "left_hand"],
  ["rightShoulder", "right_shoulder"], ["rightUpperArm", "right_arm"], ["rightLowerArm", "right_forearm"], ["rightHand", "right_hand"],
  ["leftUpperLeg", "left_leg"], ["leftLowerLeg", "left_shin"], ["leftFoot", "left_foot"],
  ["rightUpperLeg", "right_leg"], ["rightLowerLeg", "right_shin"], ["rightFoot", "right_foot"],
];
const safeVrmBone = (vrm, name) => { try { return vrm.humanoid.getRawBoneNode(name) || null; } catch { return null; } };

// ── Orchestrator: run the four tiers and return live-bone role map + diagnostics. ──
export function resolveRig(model, vrm = null, opts = {}) {
  const { snap, bones } = snapshotBones(model);
  const boneToId = new Map(bones.map((b, i) => [b, i]));
  const byName = new Map();
  for (const s of snap) if (!byName.has(s.name)) byName.set(s.name, s.id);

  const roleIds = {}, source = {};
  const fill = (role, id, tier) => { if (id != null && id >= 0 && roleIds[role] == null) { roleIds[role] = id; source[role] = tier; } };

  const ov = opts.override || null;
  const excludeIds = new Set();
  if (ov && Array.isArray(ov.exclude)) for (const nm of ov.exclude) { const id = byName.get(nm); if (id != null) excludeIds.add(id); }

  if (vrm?.humanoid?.getRawBoneNode) {                                  // tier 1
    for (const [vrmName, role] of VRM_TO_ROLE) {
      const node = safeVrmBone(vrm, vrmName);
      const id = node ? boneToId.get(node) : null;
      if (id != null && !excludeIds.has(id)) fill(role, id, "vrm");
    }
  }
  const nameIds = resolveNames(snap, excludeIds);                       // tier 2
  for (const role in nameIds) fill(role, nameIds[role], "name");
  if (ROLES.some((r) => roleIds[r] == null)) {                         // tier 3 (only if gaps)
    const geo = resolveGeometry(snap, { existing: roleIds, excludeIds });
    for (const role in geo) fill(role, geo[role], "geometry");
  }
  if (ov) applyOverride(roleIds, source, ov, byName);                  // tier 4 (force)

  const roles = {}; for (const r in roleIds) roles[r] = bones[roleIds[r]];
  const bySource = {}; for (const r in source) bySource[source[r]] = (bySource[source[r]] || 0) + 1;
  return {
    roles, source,
    matched: Object.keys(roles).sort(),
    springExclude: new Set(Object.values(roles)),
    report: { bySource, unresolved: ROLES.filter((r) => roleIds[r] == null) },
  };
}
