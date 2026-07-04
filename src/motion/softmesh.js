// softmesh.js — soft-body MESH deformation (2026-07-03, the stretch feature): grab a region of
// skin near any bone, pull it, hold it, release it -> it springs back with a jelly wobble and
// restores the geometry BIT-EXACTLY. Also poke/bulge along vertex normals (a dent pressed in, or
// the pushed-from-inside cheek read from outside).
//
// HOW IT RIDES THE SKELETON: displacement is written into the geometry's BASE position attribute
// (pre-skinning), selected + directed in the mesh's BIND frame. GPU skinning then carries the
// stretched region with whatever the bones do — she can turn her head while you hold her cheek.
//
// GENERIC-ONLY: no per-model data. The anchor is any bone (role-resolved by the caller); the
// selection radius defaults to a fraction of the model's own height; stretch SATURATES (tanh)
// so no pull can explode the mesh. Overlapping grabs exclude already-claimed vertices, so every
// grab restores from its own pristine copy.
import * as THREE from "three";

// ---- pure math (unit-tested) -------------------------------------------------------------------
/** Quartic falloff: 1 at the grab point, 0 at radius; C1-smooth at the rim. */
export const falloffW = (d, r) => {
  if (!(r > 0)) return 0;
  const t = d / r;
  return t >= 1 ? 0 : (1 - t * t) * (1 - t * t);
};
/** Rubber limit: ~linear for small pulls, asymptotic to `max` — how far can we go, stably. */
export const saturate = (mag, max) => (max > 0 ? max * Math.tanh(mag / max) : 0);
/** One damped-spring step toward 0 (semi-implicit Euler). Underdamped by default = jelly. */
export function springStep(s, dt, k = 140, c = 10) {
  s.vel += (-k * s.amp - c * s.vel) * dt;
  s.amp += s.vel * dt;
  return s;
}

export function buildSoftMesh(model) {
  const meshes = [];
  model.traverse((o) => {
    const pos = o.isSkinnedMesh ? o.geometry?.attributes?.position : null;
    if (pos && !pos.isInterleavedBufferAttribute) meshes.push(o); // interleaved: can't own the buffer -> skip honestly
  });
  // Characteristic body scale in BIND units — the SAME frame select() measures distances in.
  // (Audit 2026-07-04: the world box was wrong twice — normalization scale made "8% of height"
  // mean 30%+ of the body on meter rigs / "no vertices" on cm rigs, and setFromObject() included
  // display furniture. The skinned meshes ARE the character; their geometry boxes through
  // bindMatrix are bind-frame, cheap, and pose-independent.)
  const _bb = new THREE.Box3(),
    _mb = new THREE.Box3();
  for (const m of meshes) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    _mb.copy(m.geometry.boundingBox).applyMatrix4(m.bindMatrix);
    _bb.union(_mb);
  }
  const _ext = new THREE.Vector3();
  if (!_bb.isEmpty()) _bb.getSize(_ext);
  const modelH = Math.max(_ext.x, _ext.y, _ext.z) || 1; // largest extent: height for humanoids, length for crawlers — axis-agnostic (bind frames vary in up-axis)

  const grabs = new Map(); // id -> grab record
  const claimed = new Map(); // mesh -> Set(vertIndex) owned by an active grab (no double-booking)
  let _gid = 0;

  const _m4 = new THREE.Matrix4();
  function bindPosOfBone(bone) {
    // the bone's position in BIND space (from boneInverses) + the meshes that skin to it
    for (const m of meshes) {
      const idx = m.skeleton ? m.skeleton.bones.indexOf(bone) : -1;
      if (idx >= 0) return new THREE.Vector3().setFromMatrixPosition(_m4.copy(m.skeleton.boneInverses[idx]).invert());
    }
    return null;
  }

  // Select verts near `anchor` (bind frame) across all soft meshes. Returns per-mesh entries.
  function select(anchor, radius) {
    const entries = [];
    const v = new THREE.Vector3();
    for (const m of meshes) {
      const pos = m.geometry.attributes.position;
      const nrm = m.geometry.attributes.normal || null;
      const already = claimed.get(m);
      const idx = [],
        w = [],
        base = [],
        normals = [];
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.bindMatrix); // geometry -> bind frame
        const d = v.distanceTo(anchor);
        if (d >= radius) continue;
        if (already && already.has(i)) continue; // owned by another live grab — never double-book
        idx.push(i);
        w.push(falloffW(d, radius));
        base.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (nrm) normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      }
      if (idx.length) entries.push({ mesh: m, idx, w, base, normals: nrm ? normals : null });
    }
    return entries;
  }

  function claim(entries) {
    for (const e of entries) {
      let set = claimed.get(e.mesh);
      if (!set) claimed.set(e.mesh, (set = new Set()));
      for (const i of e.idx) set.add(i);
    }
  }
  function unclaim(entries) {
    for (const e of entries) {
      const set = claimed.get(e.mesh);
      if (set) for (const i of e.idx) set.delete(i);
    }
  }

  function apply(g) {
    // write base + dir*amp*w into the position attribute (dir in GEOMETRY space per mesh)
    const v = new THREE.Vector3();
    for (const e of g.entries) {
      const pos = e.mesh.geometry.attributes.position;
      for (let k = 0; k < e.idx.length; k++) {
        const i = e.idx[k],
          b = 3 * k,
          s = g.amp * e.w[k];
        if (g.mode === "normal" && e.normals) v.set(e.normals[b], e.normals[b + 1], e.normals[b + 2]);
        else v.copy(e.dirGeo);
        pos.setXYZ(i, e.base[b] + v.x * s, e.base[b + 1] + v.y * s, e.base[b + 2] + v.z * s);
      }
      pos.needsUpdate = true;
    }
  }

  function restore(g) {
    for (const e of g.entries) {
      const pos = e.mesh.geometry.attributes.position;
      for (let k = 0; k < e.idx.length; k++) {
        const b = 3 * k;
        pos.setXYZ(e.idx[k], e.base[b], e.base[b + 1], e.base[b + 2]); // bit-exact: the stored pristine copy
      }
      pos.needsUpdate = true;
    }
    unclaim(g.entries);
  }

  /**
   * Start (or re-aim) a grab. {bone, radius?, pull:[x,y,z]} — pull in bind-frame units
   * (roughly world units of the model). Returns truth or a named error; never a fake success.
   */
  function grab(bone, opts = {}) {
    if (!meshes.length) return { error: "no skinned meshes on this model" };
    if (opts.pull != null && (!Array.isArray(opts.pull) || opts.pull.length !== 3))
      return { error: "pull must be [x,y,z]" }; // a short array would Math.hypot(..,undefined) -> NaN into the mesh, permanently
    const pull = Array.isArray(opts.pull) ? opts.pull.map(Number) : [0, 0, 0];
    if (!pull.every(isFinite)) return { error: "pull must be finite [x,y,z]" };
    const existing = opts.id != null ? grabs.get(String(opts.id)) : null;
    if (!existing && grabs.size >= 8) return { error: "too many active grabs (max 8)" }; // cap every NEW grab — a fresh driver id must not bypass it
    let g = existing;
    if (!g) {
      if (!bone || !bone.isObject3D) return { error: "no such bone/role to grab" };
      const anchor = bindPosOfBone(bone);
      if (!anchor) return { error: `bone '${bone.name}' skins no soft mesh` };
      const radius = Math.min(0.6 * modelH, Math.max(0.001 * modelH, +opts.radius > 0 ? +opts.radius : 0.08 * modelH)); // floor at 0.1% of height: a driver may pinch TIGHT (zhu's cheek needed < 0.005H)
      let entries = select(anchor, radius);
      if (opts.mode === "normal") {
        entries = entries.filter((e) => e.normals); // poke displaces along NORMALS — a normal-less mesh would silently shove +Z (a guess)
        if (!entries.length) return { error: `no vertex normals near '${bone.name}' — poke needs a mesh with normals` };
      }
      if (!entries.length) return { error: `no vertices within ${radius.toFixed(3)} of '${bone.name}'` };
      // dir per mesh in GEOMETRY space: bind-frame dir through the inverse bind rotation
      const nq = new THREE.Quaternion();
      for (const e of entries) {
        e.mesh.bindMatrix.decompose(new THREE.Vector3(), nq, new THREE.Vector3());
        e.dirGeo = new THREE.Vector3(0, 0, 1).copy(_dirOf(pull)).applyQuaternion(nq.invert());
      }
      claim(entries);
      let autoId = null;
      if (opts.id == null)
        do autoId = "g" + ++_gid;
        while (grabs.has(autoId)); // never collide with a driver-chosen id (a collision orphaned the old grab's pristine copies)
      g = {
        id: opts.id != null ? String(opts.id) : autoId,
        entries,
        radius,
        maxStretch: 0.9 * radius,
        amp: 0,
        vel: 0,
        target: 0,
        holding: true,
        mode: opts.mode === "normal" ? "normal" : "dir",
      };
      grabs.set(g.id, g);
    } else if (pull.some((n) => n !== 0)) {
      const nq = new THREE.Quaternion();
      for (const e of g.entries) {
        e.mesh.bindMatrix.decompose(new THREE.Vector3(), nq, new THREE.Vector3());
        e.dirGeo = _dirOf(pull).applyQuaternion(nq.invert());
      }
      g.holding = true;
    }
    const mag = Math.hypot(pull[0], pull[1], pull[2]);
    g.target = saturate(mag, g.maxStretch);
    return {
      grabbed: g.id,
      verts: g.entries.reduce((n, e) => n + e.idx.length, 0),
      radius: +g.radius.toFixed(3),
      pull: +mag.toFixed(3),
      applied: +g.target.toFixed(3), // tanh rubber limit: applied < pull as you near the max
      max: +g.maxStretch.toFixed(3),
    };
  }
  const _dirOf = (p) => {
    const v = new THREE.Vector3(p[0], p[1], p[2]);
    return v.lengthSq() > 1e-12 ? v.normalize() : v.set(0, 0, 1);
  };

  /** Poke/bulge along vertex NORMALS: amount>0 bulges out (pushed from inside), <0 dents in. */
  function poke(bone, opts = {}) {
    const amt = +opts.amount;
    if (!isFinite(amt) || amt === 0) return { error: "poke needs a non-zero finite amount" };
    const r = grab(bone, { radius: opts.radius, pull: [0, 0, 1], mode: "normal" });
    if (r.error) return r;
    const g = grabs.get(r.grabbed);
    g.amp = saturate(amt, g.maxStretch); // instant press...
    g.target = 0;
    g.holding = false; // ...released immediately -> the spring animates the wobble-back
    apply(g);
    return { poked: g.id, verts: r.verts, amount: +g.amp.toFixed(3), max: r.max };
  }

  /** Release one grab (id) or all (true). The spring takes over; restore happens at rest. */
  function release(which) {
    const ids = which === true || which == null ? [...grabs.keys()] : grabs.has(String(which)) ? [String(which)] : [];
    for (const id of ids) grabs.get(id).holding = false;
    return { released: ids };
  }

  function update(dt) {
    if (!grabs.size || !(dt > 0)) return;
    for (const [id, g] of grabs) {
      if (g.holding) {
        const prev = g.amp;
        g.amp += (g.target - g.amp) * Math.min(1, dt * 12); // eased take-up while held
        g.vel = 0;
        if (g.amp !== prev) apply(g);
      } else {
        springStep(g, Math.min(dt, 1 / 30)); // clamp dt: a hitch frame must not explode the spring
        if (Math.abs(g.amp) < 0.002 * g.radius && Math.abs(g.vel) < 0.01 * g.radius) {
          restore(g); // settled: pristine geometry, grab gone
          grabs.delete(id);
        } else apply(g);
      }
    }
  }

  function restoreAll() {
    for (const g of grabs.values()) restore(g);
    grabs.clear();
  }

  return {
    meshCount: meshes.length,
    grab,
    poke,
    release,
    update,
    restoreAll,
    list: () =>
      [...grabs.values()].map((g) => ({
        id: g.id,
        amp: +g.amp.toFixed(4),
        target: +g.target.toFixed(4),
        holding: g.holding,
        verts: g.entries.reduce((n, e) => n + e.idx.length, 0),
      })),
  };
}
