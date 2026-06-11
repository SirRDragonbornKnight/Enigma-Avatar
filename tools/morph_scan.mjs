// morph_scan.mjs — headless GEOMETRIC mouth-morph finder (dev tool, names never used).
//
// Models like 51dc ship 70+ UNNAMED morph targets, so the live lip-sync (which picks the
// mouth by NAME) finds nothing. The fix must be GENERAL — detect the mouth by GEOMETRY,
// not by hand-editing the asset or hardcoding a per-model index. This tool is the OFFLINE
// validator for that detector (geom_mouth.js runs the SAME idea live on three.js geometry):
// it decodes each morph target's POSITION deltas straight from the GLB (no WebGL) and scores
// them for a JAW-DROP signature — downward vertex motion concentrated in the HEAD region
// (top of the rest pose). The top-scoring morph is the mouth-open channel. Verify live;
// a wrong pick is a one-line rig_overrides `face.mouthMorph` correction (cascade philosophy).
//
//   node tools/morph_scan.mjs                # every installed model
//   node tools/morph_scan.mjs <model|id>     # one model
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readGltfJson, discoverModels } from "./rig_report.mjs";

// the GLB BIN chunk (where accessor bytes live)
function binOf(file) {
  const buf = fs.readFileSync(file);
  if (!file.toLowerCase().endsWith(".glb")) return null;        // .gltf external .bin not handled here
  let off = 12;
  while (off + 8 <= buf.length) {
    const clen = buf.readUInt32LE(off), ctype = buf.readUInt32LE(off + 4); off += 8;
    if (ctype === 0x004e4942) return buf.subarray(off, off + clen);   // 'BIN\0'
    off += clen + (clen % 4 ? 4 - (clen % 4) : 0);
  }
  return null;
}
// decode a plain FLOAT VEC3 accessor → Float32Array(count*3); null if not float-vec3 (e.g. quantized)
function decodeVec3(gltf, bin, ai) {
  const acc = gltf.accessors?.[ai];
  if (!acc || acc.type !== "VEC3" || acc.componentType !== 5126) return null;   // need FLOAT VEC3
  const out = new Float32Array(acc.count * 3);                                  // zero base (covers a bufferView-less sparse accessor)
  if (acc.bufferView != null) {
    const bv = gltf.bufferViews[acc.bufferView];
    const base = (bv.byteOffset || 0) + (acc.byteOffset || 0), stride = bv.byteStride || 12;
    for (let i = 0; i < acc.count; i++) { const o = base + i * stride; out[i * 3] = bin.readFloatLE(o); out[i * 3 + 1] = bin.readFloatLE(o + 4); out[i * 3 + 2] = bin.readFloatLE(o + 8); }
  } else if (!acc.sparse) {
    return null;                                                                // no bytes and not sparse → no data
  }
  if (acc.sparse) {                                                             // sparse = only changed verts (very common for morphs)
    try {
      const s = acc.sparse, iv = gltf.bufferViews[s.indices.bufferView], vv = gltf.bufferViews[s.values.bufferView];
      const ibase = (iv.byteOffset || 0) + (s.indices.byteOffset || 0), vbase = (vv.byteOffset || 0) + (s.values.byteOffset || 0);
      const ict = s.indices.componentType, isz = ict === 5125 ? 4 : ict === 5123 ? 2 : 1;
      const readIdx = ict === 5125 ? (o) => bin.readUInt32LE(o) : ict === 5123 ? (o) => bin.readUInt16LE(o) : (o) => bin.readUInt8(o);
      for (let k = 0; k < s.count; k++) { const idx = readIdx(ibase + k * isz), vo = vbase + k * 12; out[idx * 3] = bin.readFloatLE(vo); out[idx * 3 + 1] = bin.readFloatLE(vo + 4); out[idx * 3 + 2] = bin.readFloatLE(vo + 8); }
    } catch { /* malformed sparse — keep the (zero) base rather than crash */ }
  }
  return out;
}

export function scan(file) {
  let gltf; try { gltf = readGltfJson(file); } catch (e) { return { file: path.basename(file), error: e.message }; }
  const bin = binOf(file);
  if (!bin) return { file: path.basename(file), error: "no BIN chunk (needs a .glb)" };

  const meshes = []; let draco = false;
  for (const m of gltf.meshes || []) {
    for (const pr of m.primitives || []) {
      if (pr.extensions?.KHR_draco_mesh_compression) { draco = true; continue; }
      if (!pr.targets || pr.attributes?.POSITION == null) continue;
      let baseP, deltas;
      try { baseP = decodeVec3(gltf, bin, pr.attributes.POSITION); deltas = pr.targets.map((t) => (t.POSITION != null ? decodeVec3(gltf, bin, t.POSITION) : null)); }
      catch { continue; }                                       // one bad accessor must not abort the whole scan
      if (!baseP) continue;
      meshes.push({ base: baseP, deltas, count: baseP.length / 3 });
      break;   // one primitive per mesh is enough
    }
  }
  if (!meshes.length) return { file: path.basename(file), error: draco ? "Draco-compressed — decode LIVE (geom_mouth.js + DRACOLoader); offline scan can't read it" : "no decodable morph targets (none, or quantized positions)" };

  // rest-pose bbox over ALL 3 axes — the UP axis is the LONGEST (a standing humanoid is
  // tallest along up). The source rip may be Y-up OR Z-up (51dc is Z-up in local space),
  // so we DETECT it, never assume (the bug that made the first pass score all-zeros).
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const ms of meshes) for (let v = 0; v < ms.count; v++) for (let a = 0; a < 3; a++) { const c = ms.base[v * 3 + a]; if (c < mn[a]) mn[a] = c; if (c > mx[a]) mx[a] = c; }
  const rng = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  const up = rng[0] >= rng[1] && rng[0] >= rng[2] ? 0 : rng[1] >= rng[2] ? 1 : 2;
  const H = Math.max(1e-6, rng[up]);
  const headCut = mx[up] - 0.35 * H;   // top ~35% along UP = head region

  const nMorph = Math.max(...meshes.map((ms) => ms.deltas.length));
  const score = new Array(nMorph).fill(0), info = new Array(nMorph).fill(null);
  for (let mi = 0; mi < nMorph; mi++) {
    let down = 0, cnt = 0, usum = 0;
    for (const ms of meshes) {
      const d = ms.deltas[mi]; if (!d) continue;
      for (let v = 0; v < ms.count; v++) {
        const bu = ms.base[v * 3 + up]; if (bu < headCut) continue;   // HEAD region (along up)
        const du = d[v * 3 + up]; if (du >= 0) continue;              // downward = jaw drop
        const mag = -du; if (mag < 1e-5) continue;
        down += mag; cnt++; usum += bu;
      }
    }
    score[mi] = down;
    info[mi] = { downScore: +down.toFixed(3), verts: cnt, regCenterNormUp: cnt ? +(((usum / cnt) - mn[up]) / H).toFixed(2) : null };
  }
  const upAxis = "XYZ"[up];
  const order = [...score.keys()].sort((a, b) => score[b] - score[a]);
  const best = order[0], bestS = score[best];
  const near = score.filter((s) => s >= bestS * 0.5 && s > 1e-4).length;   // winner + identical clones; SAME gate as geom_mouth.js
  const pick = bestS > 1e-4 && near <= Math.max(3, nMorph * 0.25) ? best : null;
  return {
    file: path.basename(file),
    morphs: nMorph,
    upAxis,
    pick,
    duplicates: pick != null ? near : 0,        // >1 = pick is split across identical clone morphs (HIGH confidence, not ambiguous)
    top: order.slice(0, 5).map((i) => ({ morph: i, ...info[i] })),
    note: "pick = strongest downward (jaw-drop) motion in the head region, gated by near-equal count (same rule as geom_mouth.js). Verify live; correct via rig_overrides face.mouthMorph.",
  };
}

function resolveTarget(arg) {
  const direct = path.resolve(arg);
  const all = discoverModels();
  if (all.some((f) => path.resolve(f) === direct)) return direct;
  const byId = all.find((f) => path.basename(path.dirname(f)).toLowerCase().includes(arg.toLowerCase()));
  return byId || direct;
}
function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const targets = args.length ? args.map(resolveTarget) : discoverModels();
  for (const t of targets) process.stdout.write(JSON.stringify(scan(t), null, 2) + "\n");
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
