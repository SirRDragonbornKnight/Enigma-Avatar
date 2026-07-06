// skeleton.js — a live THREE bone tree from glTF/GLB BYTES, no WebGL, no mesh/texture decode.
// The sim-host utilityProcess builds the same skeleton the renderer's
// GLTFLoader would (nodes referenced as skin joints become THREE.Bone, in the same DFS order),
// so the rig cascade and the compositor can run headless in the host. PURE: bytes/JSON in,
// objects out — the caller owns file IO. tools/rig_report.mjs shares the JSON reader.
import * as THREE from "three";

// glTF JSON from raw bytes: GLB is sniffed by MAGIC (never the filename); anything else is
// parsed as a bare .gltf JSON. Only the JSON chunk is read — mesh/texture BIN chunks are skipped.
export function gltfJsonFromBuffer(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength >= 12 && dv.getUint32(0, true) === 0x46546c67) {
    // 'glTF'
    let off = 12; // skip the 12-byte header
    while (off + 8 <= u8.byteLength) {
      const clen = dv.getUint32(off, true),
        ctype = dv.getUint32(off + 4, true);
      off += 8;
      if (ctype === 0x4e4f534a) return JSON.parse(new TextDecoder().decode(u8.subarray(off, off + clen))); // 'JSON'
      off += clen + (clen % 4 ? 4 - (clen % 4) : 0); // chunks are 4-byte aligned
    }
    throw new Error("no JSON chunk in GLB");
  }
  return JSON.parse(new TextDecoder().decode(u8));
}

// Build the node tree: THREE.Bone for every node referenced as a skin joint (exactly what the
// renderer's GLTFLoader marks as Bone), THREE.Object3D for everything between — snapshotBones
// re-links bone parent/children across those gaps, and world transforms flow through them.
// Node transforms honor both forms: TRS fields, or a baked `matrix` (decomposed).
// Returns { root, bones } with world matrices up to date; bones in scene DFS pre-order.
export function buildSkeleton(gltf) {
  const nodes = gltf.nodes || [];
  const joints = new Set();
  for (const sk of gltf.skins || []) for (const j of sk.joints || []) joints.add(j);
  const root = new THREE.Group();
  if (!joints.size) return { root, bones: [] }; // static mesh — honestly un-rigged
  const objs = nodes.map((n, i) => {
    const o = joints.has(i) ? new THREE.Bone() : new THREE.Object3D();
    o.name = n.name || "";
    if (Array.isArray(n.matrix)) {
      new THREE.Matrix4().fromArray(n.matrix).decompose(o.position, o.quaternion, o.scale);
    } else {
      if (n.translation) o.position.fromArray(n.translation);
      if (n.rotation) o.quaternion.fromArray(n.rotation);
      if (n.scale) o.scale.fromArray(n.scale);
    }
    return o;
  });
  const hasParent = new Array(nodes.length).fill(false);
  nodes.forEach((n, i) =>
    (n.children || []).forEach((c) => {
      hasParent[c] = true;
      objs[i].add(objs[c]);
    })
  );
  const sceneIdx = gltf.scene ?? 0;
  const sceneRoots = gltf.scenes?.[sceneIdx]?.nodes;
  const roots = sceneRoots?.length ? sceneRoots : objs.map((_, i) => i).filter((i) => !hasParent[i]);
  for (const i of roots) root.add(objs[i]);
  root.updateWorldMatrix(true, true);
  const bones = [];
  root.traverse((o) => {
    if (o.isBone) bones.push(o);
  });
  return { root, bones };
}
