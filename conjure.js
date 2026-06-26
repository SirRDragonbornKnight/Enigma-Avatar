// conjure.js — the avatar CONJURES objects: spawn a .glb prop, move it with cartoon transforms
// (pop-in, hover, glide, follow-a-hand), then dismiss it with a poof. TRANSFORM-based, NOT rapier
// (rapier stays for throw/drop) per the blueprint. Lazy: nothing runs until the first conjure.
// Renderer-coupled (THREE + scene + loadAsset), so the MOTION MATH lives in motionmath.js
// (popScale / floatBob / easeInOut — all unit-tested) and this file is just the plumbing.
import * as THREE from "three";
import { popScale, floatBob, easeInOut } from "./motionmath.js";

export function createConjure({ scene, loadAsset, getBoneWorld, onMiss } = {}) {
  const items = new Map();      // id -> rec
  let _n = 0;
  const POP = 0.35;             // pop-in / poof-out duration (s)

  function spawn(url, opts = {}) {
    const id = String(opts.id || ("conj" + (++_n)));
    if (items.has(id)) _remove(id);
    const at = opts.at || {};
    const rec = {
      obj: null, base: 1, t: 0,
      dur: +opts.dur > 0 ? +opts.dur : 0,              // 0 = stay until dismissed
      size: +opts.size > 0 ? +opts.size : 0.5,
      bone: opts.bone || null,
      amp: opts.float != null ? +opts.float : 0.04,
      home: new THREE.Vector3(+at.x || 0, +at.y || 0, +at.z || 0),
      from: null, to: null, moveT: 0, moveDur: 0, dismiss: 0,
    };
    items.set(id, rec);
    loadAsset(url, (asset) => {
      if (!asset?.scene || !items.has(id)) return;     // load lost a race with a dismiss
      const obj = asset.scene;
      const bb = new THREE.Box3().setFromObject(obj);
      const span = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
      rec.base = rec.size / span;                       // normalize to a sane world size
      obj.scale.setScalar(0.0001);                      // start invisible -> popScale grows it in
      obj.position.copy(rec.home);
      obj.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
      scene.add(obj);
      rec.obj = obj;
    }, () => { items.delete(id); onMiss?.(url); });   // load FAILED (missing/bad asset) -> drop it AND surface it (no silent vanish)
    return id;
  }

  function moveTo(id, target, opts = {}) {
    const rec = items.get(id); if (!rec || !rec.obj || !target) return false;
    rec.from = rec.obj.position.clone();
    rec.to = new THREE.Vector3(
      target.x != null ? +target.x : rec.obj.position.x,
      target.y != null ? +target.y : rec.obj.position.y,
      target.z != null ? +target.z : rec.obj.position.z,   // omitted z keeps current depth (don't teleport to 0)
    );
    rec.moveT = 0; rec.moveDur = +opts.dur > 0 ? +opts.dur : 0.8;
    return true;
  }

  function dismiss(id) {
    const rec = items.get(id); if (!rec) return false;
    if (!rec.obj) { items.delete(id); return true; }   // still loading -> just forget it
    if (!rec.dismiss) rec.dismiss = 1e-4;              // start the poof-out
    return true;
  }

  function _remove(id) {
    const rec = items.get(id);
    if (rec?.obj) {
      scene.remove(rec.obj);
      rec.obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
    }
    items.delete(id);
  }

  function clear() { for (const id of [...items.keys()]) _remove(id); }

  function step(dt) {
    if (!items.size) return false;
    let alive = false;
    for (const [id, rec] of items) {
      alive = true;
      if (!rec.obj) continue;                           // still loading
      rec.t += dt;
      if (rec.dismiss > 0) {                            // poof OUT, then remove
        rec.dismiss += dt;
        const p = Math.min(1, rec.dismiss / POP);
        rec.obj.scale.setScalar(rec.base * popScale(1 - p));
        if (p >= 1) _remove(id);
        continue;
      }
      const pin = Math.min(1, rec.t / POP);             // poof IN
      rec.obj.scale.setScalar(rec.base * (pin < 1 ? popScale(pin) : 1));
      if (rec.to) {                                     // glide to a target
        rec.moveT += dt;
        const mp = easeInOut(Math.min(1, rec.moveT / rec.moveDur));
        rec.obj.position.lerpVectors(rec.from, rec.to, mp);
        if (mp >= 1) { rec.home.copy(rec.to); rec.to = null; }
      } else {
        if (rec.bone && getBoneWorld) { const w = getBoneWorld(rec.bone); if (w) rec.home.copy(w); }   // follow a hand (conjure-at-hand)
        rec.obj.position.copy(rec.home);
        rec.obj.position.y += floatBob(rec.t, rec.amp); // gentle hover while held
      }
      if (rec.dur > 0 && rec.t >= rec.dur && !rec.dismiss) rec.dismiss = 1e-4;   // timed auto-dismiss
    }
    return alive;
  }

  return { spawn, moveTo, dismiss, clear, step, count: () => items.size, ids: () => [...items.keys()] };
}
