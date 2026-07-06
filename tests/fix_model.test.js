// fix_model.test.js — the model-repair backend (tools/fix_model.mjs). Builds a tiny valid GLB
// in-memory (no model files needed), repairs it, and reads it back: bone renames land, recoverable
// mojibake is decoded, lost U+FFFD names slug to addressable placeholders, and the BIN chunk
// (geometry/anim) survives byte-for-byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { repairModel, diagnoseModel, planSceneJunk, planDupBodies } from "../tools/fix_model.mjs";

const JSON_TYPE = 0x4e4f534a,
  BIN_TYPE = 0x004e4942,
  MAGIC = 0x46546c67;
function buildGlb(json, bin) {
  const enc = new TextEncoder();
  let j = enc.encode(JSON.stringify(json));
  const jp = (4 - (j.length % 4)) % 4;
  if (jp) {
    const p = new Uint8Array(j.length + jp);
    p.set(j);
    p.fill(0x20, j.length);
    j = p;
  }
  let b = bin || new Uint8Array(0);
  const bp = (4 - (b.length % 4)) % 4;
  if (bp) {
    const p = new Uint8Array(b.length + bp);
    p.set(b);
    b = p;
  }
  const total = 12 + 8 + j.length + (b.length ? 8 + b.length : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  let o = 12;
  out.writeUInt32LE(j.length, o);
  out.writeUInt32LE(JSON_TYPE, o + 4);
  Buffer.from(j).copy(out, o + 8);
  o += 8 + j.length;
  if (b.length) {
    out.writeUInt32LE(b.length, o);
    out.writeUInt32LE(BIN_TYPE, o + 4);
    Buffer.from(b).copy(out, o + 8);
  }
  return out;
}
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fixmodel-"));
}

test("repair: bone renames apply; BIN chunk survives byte-for-byte", () => {
  const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); // stand-in geometry/anim payload
  const json = {
    asset: { version: "2.0" },
    nodes: [{ name: "L_rearShoulder_root" }, { name: "Spine" }, { name: "L_elbow" }],
  };
  const dir = tmp();
  const src = path.join(dir, "m.glb");
  fs.writeFileSync(src, buildGlb(json, bin));
  const out = path.join(dir, "fixed");
  const res = repairModel(src, out, { renames: { L_rearShoulder_root: "LeftShoulder" } });
  assert.equal(res.renamed, 1);
  const back = diagnoseModel(res.out);
  assert.ok(back.names.includes("LeftShoulder"), "rename landed");
  assert.ok(!back.names.includes("L_rearShoulder_root"), "old name gone");
  // BIN intact: re-read the raw GLB and find the BIN chunk bytes
  const buf = fs.readFileSync(res.out);
  let o = 12,
    seen = null;
  while (o < buf.readUInt32LE(8)) {
    const len = buf.readUInt32LE(o),
      type = buf.readUInt32LE(o + 4);
    if (type === BIN_TYPE) seen = buf.subarray(o + 8, o + 8 + 8);
    o += 8 + len + ((4 - (len % 4)) % 4);
  }
  assert.deepEqual([...seen], [1, 2, 3, 4, 5, 6, 7, 8], "BIN chunk preserved exactly");
});

test("repair: recoverable mojibake (UTF-8-as-Latin1) is decoded back", () => {
  // "Tête" mis-decoded becomes "TÃªte"; the repair should restore "Tête"
  const json = { asset: { version: "2.0" }, nodes: [{ name: "TÃªte" }, { name: "Spine" }] };
  const dir = tmp();
  const src = path.join(dir, "m.glb");
  fs.writeFileSync(src, buildGlb(json, null));
  const res = repairModel(src, path.join(dir, "fixed"), { repairMojibake: true });
  const back = diagnoseModel(res.out);
  assert.ok(back.names.includes("Tête"), `recovered accented name (got ${JSON.stringify(back.names)})`);
  assert.equal(res.repaired, 1);
});

test("repair: lost U+FFFD names slug to stable addressable placeholders (marie's class)", () => {
  const json = { asset: { version: "2.0" }, nodes: [{ name: "���" }, { name: "Hand_�" }, { name: "Spine" }] };
  const dir = tmp();
  const src = path.join(dir, "m.glb");
  fs.writeFileSync(src, buildGlb(json, null));
  const res = repairModel(src, path.join(dir, "fixed"), { repairMojibake: true });
  const back = diagnoseModel(res.out);
  assert.equal(back.mojibake, 0, "no replacement chars remain → every bone is addressable");
  assert.ok(back.names.includes("Hand"), "a partly-good name keeps its readable run");
  assert.ok(
    back.names.some((n) => /^Bone_\d+$/.test(n)),
    "a fully-lost name becomes Bone_<index>"
  );
  assert.ok(back.names.includes("Spine"), "clean names are untouched");
});

test("diagnose: counts mojibake vs recoverable vs clean", () => {
  const json = { asset: { version: "2.0" }, nodes: [{ name: "�" }, { name: "TÃªte" }, { name: "Hips" }] };
  const dir = tmp();
  const src = path.join(dir, "m.glb");
  fs.writeFileSync(src, buildGlb(json, null));
  const d = diagnoseModel(src);
  assert.equal(d.nodes, 3);
  assert.equal(d.mojibake, 1);
  assert.equal(d.recoverable, 1);
});

test("planSceneJunk: unskinned meshes OUTSIDE the skeleton are junk; joint-parented props are kept", () => {
  const g = {
    skins: [{ joints: [2, 3] }],
    nodes: [
      { name: "SceneRoot", children: [1, 2, 4, 6] },
      { name: "Body", mesh: 0, skin: 0 },
      { name: "Hips", children: [3] },
      { name: "Head", children: [5] },
      { name: "Shelf", mesh: 1 }, // unskinned, outside the skeleton -> junk (the aveline shelf)
      { name: "Hat", mesh: 2 }, // rigid prop parented under the Head JOINT -> legit, kept
      { name: "Logo", mesh: 3 }, // junk (the floating logo)
    ],
  };
  assert.deepEqual(planSceneJunk(g), [4, 6], "shelf + logo detach; body and hat stay");
  assert.deepEqual(planSceneJunk({ nodes: [{ name: "Statue", mesh: 0 }] }), [], "no skins -> no junk concept");
});

test("planDupBodies: a disjoint same-name twin skeleton loses its meshes; shared-joint skins never do", () => {
  // two full skeletons whose bone names match after stripping the exporter counter (the mangle twin)
  const joints = (start) => Array.from({ length: 8 }, (_, i) => ({ name: `B${i}_jnt_${start + i}` }));
  const g = {
    nodes: [...joints(0), ...joints(100), { name: "BodyA", mesh: 0, skin: 0 }, { name: "BodyB", mesh: 1, skin: 1 }],
    skins: [{ joints: [0, 1, 2, 3, 4, 5, 6, 7] }, { joints: [8, 9, 10, 11, 12, 13, 14, 15] }],
  };
  assert.deepEqual(planDupBodies(g), [17], "the twin skeleton's body detaches; the first skeleton keeps its mesh");
  // NORMAL multi-skin model: two skins SHARING the same joints (per-mesh skins) -> untouched
  const shared = {
    nodes: [...joints(0), { name: "Top", mesh: 0, skin: 0 }, { name: "Bottom", mesh: 1, skin: 1 }],
    skins: [{ joints: [0, 1, 2, 3, 4, 5, 6, 7] }, { joints: [0, 1, 2, 3, 4, 5, 6, 7] }],
  };
  assert.deepEqual(planDupBodies(shared), [], "shared-skeleton skins are normal, never deduped");
  // tiny disjoint prop skins with generic names must not look like duplicate bodies
  const props = {
    nodes: [{ name: "Bone_1" }, { name: "Bone_2" }, { name: "P1", mesh: 0, skin: 0 }, { name: "P2", mesh: 1, skin: 1 }],
    skins: [{ joints: [0] }, { joints: [1] }],
  };
  assert.deepEqual(planDupBodies(props), [], "sub-8-joint skins are excluded from grouping");
});
