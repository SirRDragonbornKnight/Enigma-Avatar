// conjure.js — the avatar CONJURES objects: spawn a .glb prop, move it with cartoon transforms
// (pop-in, hover, glide, follow-a-hand), then dismiss it with a poof. TRANSFORM-based, NOT rapier
// (rapier stays for throw/drop) per the blueprint. Lazy: nothing runs until the first conjure.
// Renderer-coupled (THREE + scene + loadAsset), so the MOTION MATH lives in motionmath.js
// (popScale / floatBob / easeInOut — all unit-tested) and this file is just the plumbing.
import * as THREE from "three";
import { popScale, floatBob, easeInOut } from "./motionmath.js";
import { disposeMeshTree } from "../util/dispose.js";

export function createConjure({ scene, loadAsset, getBoneWorld, onMiss } = {}) {
  const items = new Map(); // id -> rec
  let _n = 0;
  const POP = 0.35; // pop-in / poof-out duration (s)
  // Boundary guard: a bus message (or an AI tag) is untrusted input. A non-finite coordinate
  // (NaN from a stringly value, or Infinity) lerped into obj.position propagates through three.js
  // and blanks/explodes the prop. Coerce every coordinate to a finite number where it ENTERS here.
  const fin = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
  // The wire documents `at`/`to` as number[] too ({action:"conjure", at:[x,y,z]}) — reading .x
  // off an array silently no-oped every axis. Accept both shapes; null = unusable target.
  const xyz = (t) => (Array.isArray(t) ? { x: t[0], y: t[1], z: t[2] } : t && typeof t === "object" ? t : null);

  function spawn(url, opts = {}) {
    const id = String(opts.id || "conj" + ++_n);
    if (items.has(id)) _remove(id);
    while (items.size >= 16) {
      const oldest = items.keys().next().value;
      if (oldest == null) break;
      _remove(oldest);
    } // HARD CAP: an AI looping [conjure:x] must not spawn props without bound
    const at = xyz(opts.at) || {};
    const rec = {
      obj: null,
      base: 1,
      t: 0,
      dur: +opts.dur > 0 ? +opts.dur : 0, // 0 = stay until dismissed
      size: +opts.size > 0 ? +opts.size : 0.5,
      bone: opts.bone || null,
      amp: fin(opts.float, 0.04),
      home: new THREE.Vector3(fin(at.x), fin(at.y), fin(at.z)),
      from: null,
      to: null,
      moveT: 0,
      moveDur: 0,
      dismiss: 0,
    };
    items.set(id, rec);
    loadAsset(
      url,
      (asset) => {
        // record identity, not id presence: a same-id respawn replaces the map entry, and the
        // FIRST load completing late would add its orphaned scene — an undismissable ghost prop
        // that also grows the click-capture silhouette
        if (!asset?.scene || items.get(id) !== rec) return; // load lost a race with a dismiss/respawn
        const obj = asset.scene;
        const bb = new THREE.Box3().setFromObject(obj);
        const span = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
        rec.base = rec.size / span; // normalize to a sane world size
        obj.scale.setScalar(0.0001); // start invisible -> popScale grows it in
        obj.position.copy(rec.home);
        obj.traverse((o) => {
          if (o.isMesh) o.frustumCulled = false;
        });
        scene.add(obj);
        rec.obj = obj;
      },
      () => {
        items.delete(id);
        onMiss?.(url);
      }
    ); // load FAILED (missing/bad asset) -> drop it AND surface it (no silent vanish)
    return id;
  }

  function moveTo(id, target, opts = {}) {
    const rec = items.get(id);
    const t = xyz(target);
    if (!rec || !rec.obj || !t) return false;
    rec.from = rec.obj.position.clone();
    rec.to = new THREE.Vector3(
      fin(t.x, rec.obj.position.x),
      fin(t.y, rec.obj.position.y),
      fin(t.z, rec.obj.position.z) // omitted/garbage axis keeps current value (don't teleport to 0 or NaN)
    );
    rec.moveT = 0;
    rec.moveDur = +opts.dur > 0 ? +opts.dur : 0.8;
    return true;
  }

  function dismiss(id) {
    const rec = items.get(id);
    if (!rec) return false;
    if (!rec.obj) {
      items.delete(id);
      return true;
    } // still loading -> just forget it
    if (!rec.dismiss) rec.dismiss = 1e-4; // start the poof-out
    return true;
  }

  function _remove(id) {
    const rec = items.get(id);
    if (rec?.obj) {
      scene.remove(rec.obj);
      disposeMeshTree(rec.obj); // incl. textures — every despawn leaked the prop's texture set
    }
    items.delete(id);
  }

  function clear() {
    for (const id of [...items.keys()]) _remove(id);
  }

  function step(dt) {
    if (!items.size) return false;
    let alive = false;
    for (const [id, rec] of items) {
      alive = true;
      if (!rec.obj) continue; // still loading
      rec.t += dt;
      if (rec.dismiss > 0) {
        // poof OUT, then remove
        rec.dismiss += dt;
        const p = Math.min(1, rec.dismiss / POP);
        rec.obj.scale.setScalar(rec.base * popScale(1 - p));
        if (p >= 1) _remove(id);
        continue;
      }
      const pin = Math.min(1, rec.t / POP); // poof IN
      rec.obj.scale.setScalar(rec.base * (pin < 1 ? popScale(pin) : 1));
      if (rec.to) {
        // glide to a target
        rec.moveT += dt;
        const mp = easeInOut(Math.min(1, rec.moveT / rec.moveDur));
        rec.obj.position.lerpVectors(rec.from, rec.to, mp);
        if (mp >= 1) {
          rec.home.copy(rec.to);
          rec.to = null;
        }
      } else {
        if (rec.bone && getBoneWorld) {
          const w = getBoneWorld(rec.bone);
          if (w) rec.home.copy(w);
        } // follow a hand (conjure-at-hand)
        rec.obj.position.copy(rec.home);
        rec.obj.position.y += floatBob(rec.t, rec.amp); // gentle hover while held
      }
      if (rec.dur > 0 && rec.t >= rec.dur && !rec.dismiss) rec.dismiss = 1e-4; // timed auto-dismiss
    }
    return alive;
  }

  return {
    spawn,
    moveTo,
    dismiss,
    clear,
    step,
    count: () => items.size,
    ids: () => [...items.keys()],
    // live truth for query "props": per-prop world x/y + follow state (loaded=false = the asset
    // is still in flight; the position is where it will pop)
    report: () =>
      [...items.entries()].map(([id, r]) => ({
        id,
        loaded: !!r.obj,
        bone: r.bone,
        world: r.obj ? [r.obj.position.x, r.obj.position.y] : [r.home.x, r.home.y],
      })),
  };
}
