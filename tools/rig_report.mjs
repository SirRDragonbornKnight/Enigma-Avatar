// rig_report.mjs — headless rig-cascade inspector for REAL models (dev tool, not shipped in the overlay).
//
// The cascade in rig.js is unit-tested only on SYNTHETIC skeletons (tests/). This tool
// closes that gap: it extracts a real bone snapshot (names + world positions + bone-only
// hierarchy, in three.js DFS order) straight from a .glb/.gltf's JSON — no WebGL, no mesh
// or texture decode — and runs the SAME pure rig.js tiers the live engine uses, so you can
// see exactly which of the 19 canonical roles a model resolves, by which tier, and what's
// left unresolved — measuring whether a cascade change helps or regresses a real rig.
//
//   node tools/rig_report.mjs                 # every model under models/
//   node tools/rig_report.mjs <model.glb>     # one model
//   node tools/rig_report.mjs --bones <m.glb> # also dump every bone (name · height% · side)
//
// Bone transforms live in the glTF JSON, so this reads only that chunk — it never touches the
// (large, non-redistributable) mesh/texture data, and prints nothing that could redistribute it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveNames, resolveGeometry, resolveBetween, ROLES } from "../src/rig/rig.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MOD = path.resolve(HERE, ".."); // enigma-avatar
export const MODELS = path.join(MOD, "models");

// ── glTF / GLB → JSON (the JSON chunk holds every node transform we need) ──────
export function readGltfJson(file) {
  const buf = fs.readFileSync(file);
  if (file.toLowerCase().endsWith(".glb")) {
    if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB (bad magic)"); // 'glTF'
    let off = 12; // skip 12-byte header
    while (off + 8 <= buf.length) {
      const clen = buf.readUInt32LE(off),
        ctype = buf.readUInt32LE(off + 4);
      off += 8;
      if (ctype === 0x4e4f534a) return JSON.parse(buf.subarray(off, off + clen).toString("utf8")); // 'JSON'
      off += clen + (clen % 4 ? 4 - (clen % 4) : 0); // chunks are 4-byte aligned
    }
    throw new Error("no JSON chunk in GLB");
  }
  return JSON.parse(buf.toString("utf8"));
}

// ── column-major mat4 (three.js convention) so world positions match the engine ──
function compose(t, q, s) {
  const [x, y, z, w] = q,
    [sx, sy, sz] = s;
  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2,
    yy = y * y2,
    yz = y * z2,
    zz = z * z2;
  const wx = w * x2,
    wy = w * y2,
    wz = w * z2;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}
function mul(a, b) {
  // a*b, column-major (index = col*4 + row)
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
const localMatrix = (n) =>
  Array.isArray(n.matrix)
    ? n.matrix.slice()
    : compose(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);

// ── build the bone snapshot the pure tiers consume (parity with rig.js#snapshotBones) ──
// Bones = nodes referenced as skin joints (three.js marks exactly those as THREE.Bone).
// World positions come from the bind-pose node transforms; bone parent/children skip any
// non-bone nodes between them; order is scene DFS pre-order, filtered to bones.
export function buildSnapshot(gltf) {
  const nodes = gltf.nodes || [];
  const joints = new Set();
  for (const sk of gltf.skins || []) for (const j of sk.joints || []) joints.add(j);

  const parentOf = new Array(nodes.length).fill(-1);
  for (let i = 0; i < nodes.length; i++) for (const c of nodes[i].children || []) parentOf[c] = i;

  // world matrix per node, DFS from the active scene's roots
  const world = new Array(nodes.length).fill(null);
  const order = []; // DFS pre-order over ALL nodes (bone filter applied later)
  const sceneRoots = gltf.scenes?.[gltf.scene ?? 0]?.nodes || nodes.map((_, i) => i).filter((i) => parentOf[i] < 0);
  const visit = (i, parentW) => {
    const w = parentW ? mul(parentW, localMatrix(nodes[i])) : localMatrix(nodes[i]);
    world[i] = w;
    order.push(i);
    for (const c of nodes[i].children || []) visit(c, w);
  };
  for (const r of sceneRoots) visit(r, null);

  const nearestBoneAncestor = (i) => {
    let p = parentOf[i];
    while (p >= 0) {
      if (joints.has(p)) return p;
      p = parentOf[p];
    }
    return -1;
  };
  const boneNodes = order.filter((i) => joints.has(i)); // three.js DFS-order bone list
  const idByNode = new Map(boneNodes.map((node, id) => [node, id]));
  const snap = boneNodes.map((node, id) => ({
    id,
    node,
    name: nodes[node].name ?? `node_${node}`,
    pos: { x: world[node][12], y: world[node][13], z: world[node][14] },
    parent: -1,
    children: [],
  }));
  for (let id = 0; id < boneNodes.length; id++) {
    const pn = nearestBoneAncestor(boneNodes[id]);
    const pid = pn >= 0 ? idByNode.get(pn) : -1;
    snap[id].parent = pid;
    if (pid >= 0) snap[pid].children.push(id);
  }
  return snap;
}

// ── VRM tier-1 parity: pull the humanoid bone→node map from the VRM extension ──
// (rig.js tier 1 trusts vrm.humanoid; without it a VRM under-reports here. We read the
// same mapping straight from the glTF JSON so VRM models are judged the way they really load.)
const VRM_TO_ROLE = {
  hips: "hips",
  spine: "spine",
  chest: "chest",
  upperChest: "chest",
  neck: "neck",
  head: "head",
  leftShoulder: "left_shoulder",
  leftUpperArm: "left_arm",
  leftLowerArm: "left_forearm",
  leftHand: "left_hand",
  rightShoulder: "right_shoulder",
  rightUpperArm: "right_arm",
  rightLowerArm: "right_forearm",
  rightHand: "right_hand",
  leftUpperLeg: "left_leg",
  leftLowerLeg: "left_shin",
  leftFoot: "left_foot",
  rightUpperLeg: "right_leg",
  rightLowerLeg: "right_shin",
  rightFoot: "right_foot",
};
function vrmRoleNodes(gltf) {
  const ex = gltf.extensions || {};
  const out = {}; // role -> node index
  const hb0 = ex.VRM?.humanoid?.humanBones; // VRM 0.x: [{bone, node}]
  if (Array.isArray(hb0))
    for (const e of hb0) {
      const r = VRM_TO_ROLE[e.bone];
      if (r && e.node != null && out[r] == null) out[r] = e.node;
    }
  const hb1 = ex.VRMC_vrm?.humanoid?.humanBones; // VRM 1.0: { bone: { node } }
  if (hb1 && typeof hb1 === "object")
    for (const [b, v] of Object.entries(hb1)) {
      const r = VRM_TO_ROLE[b];
      if (r && v?.node != null && out[r] == null) out[r] = v.node;
    }
  return Object.keys(out).length ? out : null;
}

// ── run the generic cascade tiers like rig.js#resolveRig (VRM → name → geometry) ──
export function runCascade(gltf, snap) {
  const idByNode = new Map(snap.map((s) => [s.node, s.id]));

  const roleIds = {},
    source = {};
  const fill = (role, id, tier) => {
    if (id != null && id >= 0 && roleIds[role] == null) {
      roleIds[role] = id;
      source[role] = tier;
    }
  };
  const vrm = vrmRoleNodes(gltf); // tier 1
  if (vrm)
    for (const [role, node] of Object.entries(vrm)) {
      const id = idByNode.get(node);
      if (id != null) fill(role, id, "vrm");
    }

  const nameIds = resolveNames(snap); // tier 2
  for (const role in nameIds) fill(role, nameIds[role], "name");

  if (ROLES.some((r) => roleIds[r] == null)) {
    // tier 3 (only if gaps)
    const geo = resolveGeometry(snap, { existing: roleIds });
    for (const role in geo) fill(role, geo[role], "geometry");
  }
  resolveBetween(snap, roleIds, source); // tier 3.5: middle-joint repair (joint-style "shoulder" = upper arm); snap carries parent/children

  const bySource = {};
  for (const r in source) bySource[source[r]] = (bySource[source[r]] || 0) + 1;
  return {
    roleIds,
    source,
    isVRM: !!vrm,
    matched: ROLES.filter((r) => roleIds[r] != null),
    unresolved: ROLES.filter((r) => roleIds[r] == null),
    bySource,
  };
}

// ── reporting ──────────────────────────────────────────────────────────────────
export function urlKeyFor(file) {
  return "./" + path.relative(MOD, file).split(path.sep).join("/");
} // matches the live curKey

function report(file, showBones) {
  const key = urlKeyFor(file);
  let gltf;
  try {
    gltf = readGltfJson(file);
  } catch (e) {
    console.log(`\n# ${key}\n  x ${e.message}`);
    return null;
  }
  const snap = buildSnapshot(gltf);
  if (!snap.length) {
    console.log(`\n# ${key}\n  (no skin/joints - static mesh, correctly un-rigged)`);
    return { key, matched: [], static: true };
  }
  const r = runCascade(gltf, snap);
  const tag = r.isVRM ? " (VRM)" : "";
  console.log(`\n# ${key}${tag}`);
  console.log(`  bones: ${snap.length}   roles: ${r.matched.length}/19   by ${JSON.stringify(r.bySource)}`);
  if (r.unresolved.length) console.log(`  unresolved: ${r.unresolved.join(", ")}`);
  else console.log(`  ok - all 19 roles resolved`);
  if (showBones) {
    let minY = Infinity,
      maxY = -Infinity;
    for (const s of snap) {
      if (s.pos.y < minY) minY = s.pos.y;
      if (s.pos.y > maxY) maxY = s.pos.y;
    }
    const H = Math.max(1e-6, maxY - minY);
    for (const s of snap) {
      const pct = Math.round(((s.pos.y - minY) / H) * 100);
      const role = Object.keys(r.roleIds).find((k) => r.roleIds[k] === s.id);
      console.log(`    ${String(pct).padStart(3)}%  ${s.name}${role ? `   -> ${role} [${r.source[role]}]` : ""}`);
    }
  }
  return { key, matched: r.matched, unresolved: r.unresolved };
}

export function discoverModels() {
  if (!fs.existsSync(MODELS)) return [];
  const out = [];
  for (const d of fs.readdirSync(MODELS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(MODELS, d.name);
    const files = fs.readdirSync(dir);
    const pick = files.find((f) => /^scene\.(gltf|glb)$/i.test(f)) || files.find((f) => /\.(glb|gltf|vrm)$/i.test(f));
    if (pick) out.push(path.join(dir, pick));
  }
  return out;
}

// ── CLI (only when run directly, e.g. `node tools/rig_report.mjs`; not on import) ──
function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const showBones = process.argv.includes("--bones");
  const targets = args.length ? args.map((a) => path.resolve(a)) : discoverModels();
  if (!targets.length) {
    console.log("no models found under " + MODELS);
    return;
  }
  console.log(`rig cascade report - ${targets.length} model(s)`);
  const results = targets.map((f) => report(f, showBones)).filter(Boolean);
  const full = results.filter((r) => r.matched.length === 19).length;
  const partial = results.filter((r) => !r.static && r.matched.length > 0 && r.matched.length < 19);
  console.log(
    `\n-- ${full}/${results.length} fully rigged (19/19)` +
      (partial.length
        ? ` - ${partial.length} partial: ${partial.map((r) => path.basename(path.dirname(r.key)) + " " + r.matched.length).join(", ")}`
        : "") +
      " --"
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
