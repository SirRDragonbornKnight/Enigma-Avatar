// fix_model.mjs — the MODEL REPAIR backend (pure Node, ZERO dependencies).
/* eslint-disable no-control-regex -- decodes binary glTF bone names; literal control bytes in these regexes are intentional */
//
// A glTF model's bone/node NAMES are the engine's whole identity layer (rig.js resolves roles by
// name). When a name is wrong the model misbehaves and there's no in-engine fix — you have to edit
// the FILE. The defects the library scan found are almost all NAME defects:
//   • marie: 147/149 bone names are UTF-8 mojibake (U+FFFD) → 0 roles resolve.
//   • renamon: the real arm clavicle is named a "fluff" bone → arms unresolved.
//   • any rig: a bone the resolver mis-identifies → a 1-line rename fixes it forever.
// All of these are STRING edits inside the GLB/glTF JSON — no mesh surgery, no image encoder, no
// dependency. This patches the JSON in place and writes a REPAIRED COPY (the original is never
// touched), so a bad edit is just a discarded folder.
//
// A .glb is a binary container: [12-byte header][JSON chunk][BIN chunk]. We rewrite only the JSON
// chunk (re-padded, lengths recomputed); the BIN chunk (geometry/anim) is copied byte-for-byte.
// A .gltf is plain JSON next to a .bin + textures/ — we patch the JSON and copy the siblings.
//
// CLI:  node fix_model.mjs <in.glb|in.gltf> <out-dir> <ops.json>
//   ops.json = { "renames": { "OldName": "NewName", ... }, "repairMojibake": true }
// Prints a JSON result line: {"ok":true,"out":"<path>","renamed":N,"repaired":M} or {"error":"..."}.
import fs from "fs";
import path from "path";

const GLB_MAGIC = 0x46546c67; // "glTF"
const JSON_TYPE = 0x4e4f534a; // "JSON"
const BIN_TYPE = 0x004e4942; // "BIN\0"

// ── mojibake repair ────────────────────────────────────────────────────────────────────────
// The classic corruption: UTF-8 bytes decoded as Latin-1/CP1252 (é → "Ã©") or, worse, lost to
// U+FFFD on a bad import. We can only RECOVER the first kind (re-encode Latin-1 → decode UTF-8);
// genuine U+FFFD bytes are gone, so for those we sanitize to ASCII-safe placeholders that at least
// let the resolver and overrides ADDRESS the bone by a stable name.
function repairName(name, idx) {
  if (typeof name !== "string" || !name) return name;
  // (1) recoverable mojibake: re-interpret the JS string's chars as Latin-1 bytes, decode as UTF-8.
  if (/[À-ÿ]{1,} ?|Ã|Â|â€/.test(name)) {
    try {
      const bytes = Uint8Array.from([...name].map((c) => c.charCodeAt(0) & 0xff));
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (decoded && !decoded.includes("�")) return decoded;
    } catch {}
  }
  // (2) unrecoverable: replacement chars / control bytes → a stable ASCII slug (keeps any good run).
  if (/[�\x00-\x1f]/.test(name)) {
    const slug = name.replace(/[�\x00-\x1f]+/g, "_").replace(/^_+|_+$/g, "");
    return slug && /[a-z0-9]/i.test(slug) ? slug : `Bone_${idx}`;
  }
  return name;
}

// ── scene-junk + duplicate-body planners (model-zoo 2026-07-02) ─────────────────────────────
// Both repairs are MESH-DETACH passes: they delete `node.mesh` (and `node.skin`) but never remove
// nodes or rebuild indices — the safest possible glTF surgery. Bones, animations, and hierarchy
// are untouched; the orphaned mesh/accessor data stays behind as inert bytes.

// every node that IS a joint or sits UNDER one (a hat parented to the Head joint is a legit
// rigid attachment — never junk)
function underJointSet(gltf) {
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  const set = new Set();
  for (const s of gltf.skins || []) for (const j of s.joints || []) set.add(j);
  const queue = [...set];
  while (queue.length) {
    const i = queue.pop();
    for (const c of nodes[i]?.children || [])
      if (!set.has(c)) {
        set.add(c);
        queue.push(c);
      }
  }
  return set;
}

// SCENE JUNK: a rigged file's unskinned meshes that hang OUTSIDE the skeleton — display shelves,
// floating logos, backdrop planes (aveline ships all three). Files with no skin at all (statues,
// props, furniture) are never touched: with no skeleton there is no "junk", only the model.
export function planSceneJunk(gltf) {
  if (!(gltf.skins || []).length) return [];
  const under = underJointSet(gltf);
  const out = [];
  (gltf.nodes || []).forEach((n, i) => {
    if (n && n.mesh != null && n.skin == null && !under.has(i)) out.push(i);
  });
  return out;
}

// DUPLICATE BODIES: some rips ship the character TWICE (mangle: a driven copy + a static T-pose
// twin on a parallel skeleton). Signature = the sorted joint NAMES; two skins with the SAME
// signature but DISJOINT joint nodes are parallel copies — keep the first skeleton, detach every
// mesh bound to the others. Skins that SHARE joints are normal per-mesh skins — never touched.
export function planDupBodies(gltf) {
  const skins = gltf.skins || [];
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  // signature = sorted joint names with the exporter's per-node counter stripped — mangle's twin
  // copies name-match exactly EXCEPT for trailing indices ("Jumpscare_jnt_end_end_0204" vs
  // "_0239"). Tiny skins are excluded from grouping: two disjoint 2-joint prop skins with generic
  // names ("Bone_1") must never look like duplicate bodies.
  const sig = (s) =>
    (s.joints || [])
      .map((j) => (nodes[j]?.name || "#" + j).replace(/_\d+$/, ""))
      .sort()
      .join("\n");
  const groups = new Map();
  skins.forEach((s, i) => {
    if ((s.joints || []).length < 8) return; // a body has many joints; props don't
    const k = sig(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  const loserSkins = new Set();
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const keepJoints = new Set(skins[idxs[0]].joints || []);
    for (const si of idxs.slice(1)) {
      const shares = (skins[si].joints || []).some((j) => keepJoints.has(j));
      if (!shares) loserSkins.add(si); // disjoint twin skeleton -> its meshes go
    }
  }
  const out = [];
  nodes.forEach((n, i) => {
    if (n && n.mesh != null && loserSkins.has(n.skin)) out.push(i);
  });
  return out;
}

function applyOps(gltf, ops) {
  let renamed = 0,
    repaired = 0;
  const renames = (ops && ops.renames) || {};
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || typeof n.name !== "string") continue;
    if (Object.prototype.hasOwnProperty.call(renames, n.name)) {
      n.name = String(renames[n.name]);
      renamed++;
      continue;
    }
    if (ops && ops.repairMojibake) {
      const fixed = repairName(n.name, i);
      if (fixed !== n.name) {
        n.name = fixed;
        repaired++;
      }
    }
  }
  let junkRemoved = 0,
    dupRemoved = 0;
  if (ops && ops.stripJunk) {
    for (const i of planSceneJunk(gltf)) {
      delete nodes[i].mesh;
      junkRemoved++;
    }
  }
  if (ops && ops.dedupeBodies) {
    for (const i of planDupBodies(gltf)) {
      delete nodes[i].mesh;
      delete nodes[i].skin;
      dupRemoved++;
    }
  }
  return { renamed, repaired, junkRemoved, dupRemoved };
}

// ── GLB read/write ───────────────────────────────────────────────────────────────────────────
function readGlb(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error("not a GLB (bad magic)");
  const total = buf.readUInt32LE(8);
  let off = 12,
    json = null,
    binChunk = null;
  while (off < total) {
    const len = buf.readUInt32LE(off),
      type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_TYPE) json = JSON.parse(new TextDecoder("utf-8").decode(data));
    else if (type === BIN_TYPE) binChunk = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, binChunk };
}
function writeGlb(json, binChunk) {
  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) {
    const p = new Uint8Array(jsonBytes.length + jpad);
    p.set(jsonBytes);
    p.fill(0x20, jsonBytes.length);
    jsonBytes = p;
  } // pad with spaces
  let binBytes = binChunk || new Uint8Array(0);
  const bpad = (4 - (binBytes.length % 4)) % 4;
  if (bpad) {
    const p = new Uint8Array(binBytes.length + bpad);
    p.set(binBytes);
    binBytes = p;
  } // pad with zeros
  const hasBin = binChunk && binChunk.length > 0;
  const total = 12 + 8 + jsonBytes.length + (hasBin ? 8 + binBytes.length : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  let o = 12;
  out.writeUInt32LE(jsonBytes.length, o);
  out.writeUInt32LE(JSON_TYPE, o + 4);
  Buffer.from(jsonBytes).copy(out, o + 8);
  o += 8 + jsonBytes.length;
  if (hasBin) {
    out.writeUInt32LE(binBytes.length, o);
    out.writeUInt32LE(BIN_TYPE, o + 4);
    Buffer.from(binBytes).copy(out, o + 8);
  }
  return out;
}

// ── orchestrator ────────────────────────────────────────────────────────────────────────────
export function repairModel(inPath, outDir, ops) {
  const ext = path.extname(inPath).toLowerCase();
  const base = path.basename(inPath);
  // Repair writes a COPY, never in place — enforce it HERE, not just in the shell caller (which
  // always allocates a sibling <id>_fixed dir): a CLI caller passing the model's OWN dir would
  // silently overwrite the original. A NESTED outDir (tests use <dir>/fixed) is fine — the .gltf
  // sibling-copy loop below just skips the output dir so it never copies into itself.
  // Lowercased only on Windows (case-insensitive paths there, not on Linux).
  const _norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const _outAbs = _norm(outDir);
  if (_outAbs === _norm(path.dirname(inPath))) {
    throw new Error("outDir must differ from the model's own directory (repair writes a copy, never in place)");
  }
  fs.mkdirSync(outDir, { recursive: true });
  let stats;
  if (ext === ".glb") {
    const { json, binChunk } = readGlb(fs.readFileSync(inPath));
    stats = applyOps(json, ops);
    fs.writeFileSync(path.join(outDir, base), writeGlb(json, binChunk));
  } else if (ext === ".gltf") {
    const json = JSON.parse(fs.readFileSync(inPath, "utf-8"));
    stats = applyOps(json, ops);
    fs.writeFileSync(path.join(outDir, base), JSON.stringify(json));
    // copy the siblings the .gltf references (.bin, textures/) so the repaired copy is self-contained
    const srcDir = path.dirname(inPath);
    for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (e.name === base) continue;
      const s = path.join(srcDir, e.name),
        d = path.join(outDir, e.name);
      if (_norm(s) === _outAbs) continue; // a nested outDir must never be copied into itself
      if (e.isDirectory()) fs.cpSync(s, d, { recursive: true });
      else fs.copyFileSync(s, d);
    }
  } else throw new Error("unsupported format: " + ext + " (only .glb / .gltf)");
  return { ok: true, out: path.join(outDir, base), ...stats };
}

// Detect which repairs a model NEEDS (for the Settings UI to offer them). Read-only.
export function diagnoseModel(inPath) {
  const ext = path.extname(inPath).toLowerCase();
  let json;
  if (ext === ".glb") json = readGlb(fs.readFileSync(inPath)).json;
  else if (ext === ".gltf") json = JSON.parse(fs.readFileSync(inPath, "utf-8"));
  else return { error: "unsupported format" };
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  let mojibake = 0,
    recoverable = 0;
  for (const n of nodes) {
    if (!n || typeof n.name !== "string") continue;
    if (/[�]/.test(n.name)) mojibake++;
    else if (/Ã|Â|â€|[À-ÿ]{2,}/.test(n.name)) recoverable++;
  }
  return {
    nodes: nodes.length,
    mojibake,
    recoverable,
    sceneJunk: planSceneJunk(json).length, // unskinned meshes outside the skeleton (shelves/logos)
    dupBodies: planDupBodies(json).length, // meshes bound to a duplicate parallel skeleton
    names: nodes.map((n) => (n && n.name) || null),
  };
}

// CLI entry
if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/") ?? ""}` ||
  process.argv[1]?.endsWith("fix_model.mjs")
) {
  try {
    const [, , inPath, outDir, opsArg] = process.argv;
    if (inPath && !outDir) {
      console.log(JSON.stringify(diagnoseModel(inPath)));
    } // 1-arg = diagnose
    else {
      const ops = opsArg
        ? fs.existsSync(opsArg)
          ? JSON.parse(fs.readFileSync(opsArg, "utf-8"))
          : JSON.parse(opsArg)
        : {};
      console.log(JSON.stringify(repairModel(inPath, outDir, ops)));
    }
  } catch (e) {
    console.log(JSON.stringify({ error: String((e && e.message) || e) }));
    process.exitCode = 1;
  }
}
