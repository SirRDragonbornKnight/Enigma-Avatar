// attachments.js — bone-attached props / accessories.
//
// Load any mesh
// and parent it to a BONE so it rides the animation — held items, hats, the pole Mal0 ships with,
// glasses, simple capes. Per-avatar, persisted. (Body-conforming clothing still needs a mesh rigged
// to a matching skeleton — this covers rigid / bone-attached extras.) Placement (bone + offset) is
// tunable live via tuneAttachment(); the defaults are a starting point.
//
// THE RACE RULE: attach loads are async — a model swap mid-load must NOT attach
// the prop to the NEW model nor durably write it into the WRONG profile. The load callback compares
// the key it was aimed at against the CURRENT key and disposes the late asset on mismatch.
//
// createAttachmentStore(deps) — everything impure is INJECTED, so the store (and the race) runs
// headless under node --test:
//   loadAsset(url, onOk, onErr, opts)  ·  kindOf(url)  ·  baseName(url)   the loader trio
//   getModel() / getRig() / getRoleBones() / getKey()   live engine state thunks
//   getAvatarWorldHeight()   -> her CURRENT world height (auto-size reference)
//   dispose(root)            -> GPU-honest teardown (geometry + materials + textures)
//   profileFor(key) / saveProfileSoon() / commitAttachments()   the profile store's edges
//   setStatus(msg)           -> on-screen status line
import * as THREE from "three";
import { ROLES } from "../rig/rig.js";

const D2R = Math.PI / 180;
const BONE_ALIAS = {
  righthand: "right.*(hand|wrist)",
  lefthand: "left.*(hand|wrist)",
  rightfoot: "right.*(foot|ankle|toe)",
  leftfoot: "left.*(foot|ankle|toe)",
  head: "head",
  neck: "neck",
  hips: "hips|pelvis",
  back: "chest|spine",
  tail: "tail",
};
// attach-friendly aliases → canonical RIG ROLE (resolved STRUCTURALLY by rig.js). These win
// over name matching, so a prop lands on the REAL hand/head even when the bone is named
// "Bip_R_Wrist_023" or is corrupted — trust no names. Falls back to a name regex only for
// non-role targets (tail, or any arbitrary bone the AI names explicitly).
const ROLE_ALIAS = {
  righthand: "right_hand",
  lefthand: "left_hand",
  rightfoot: "right_foot",
  leftfoot: "left_foot",
  head: "head",
  neck: "neck",
  hips: "hips",
  back: "chest",
  chest: "chest",
  spine: "spine",
};
const ROLES_SET = new Set(ROLES);

// Bus attach/tune numerics are stringly-typed — one garbage triplet would NaN the prop's matrix
// (invisible prop) AND be persisted to the profile. Sanitize at the entry.
const _v3 = (v, d) => (Array.isArray(v) && v.length === 3 && v.every((n) => isFinite(+n)) ? v.map(Number) : d);
const _num = (v, d) => (isFinite(+v) ? +v : d);

export function createAttachmentStore({
  loadAsset,
  kindOf,
  baseName,
  getModel,
  getRig,
  getRoleBones,
  getKey,
  getAvatarWorldHeight,
  dispose,
  profileFor,
  saveProfileSoon,
  commitAttachments,
  setStatus,
}) {
  let attachObjs = []; // live for the current model: [{id,category,url,bone,pos,rot,scale,obj,attachedTo}]
  let _attachSeq = 0;
  const getAttachments = () => attachObjs;

  function findBone(query) {
    const model = getModel();
    if (!model || !query) return null;
    const q = String(query).toLowerCase();
    const role = ROLE_ALIAS[q] || (ROLES_SET.has(q) ? q : null); // a canonical role, or an alias for one?
    if (role && getRoleBones()[role]) return getRoleBones()[role]; // → the STRUCTURALLY resolved bone (name-agnostic)
    let re;
    try {
      re = new RegExp(BONE_ALIAS[q] || q, "i");
    } catch {
      re = new RegExp(q.replace(/[^a-z0-9]+/gi, ".*"), "i");
    } // else a name match (tail / arbitrary bone)
    let best = null;
    model.traverse((o) => {
      if (!best && o.isBone && re.test(o.name)) best = o;
    });
    return best;
  }

  function _placeAttachment(a) {
    a.obj.position.fromArray(a.pos);
    a.obj.rotation.set(a.rot[0] * D2R, a.rot[1] * D2R, a.rot[2] * D2R);
    a.obj.scale.setScalar(a.scale);
  }

  function saveAttachments() {
    commitAttachments();
    saveProfileSoon();
  } // snapshot + persist

  function attachMesh(url, opts = {}) {
    const category = opts.category || "prop";
    const defBone = category === "furniture" ? "" : category === "clothes" ? "back" : "righthand";
    const a = {
      id: opts.id || "a" + ++_attachSeq,
      category,
      url,
      bone: opts.bone ?? defBone,
      pos: _v3(opts.pos, [0, 0, 0]),
      rot: _v3(opts.rot, [0, 0, 0]),
      scale: opts.scale != null ? _num(opts.scale, 1) : 1,
    };
    const forKey = getKey(); // the model this attach was aimed at — a swap mid-load must not
    // attach the prop to the NEW model and durably write it into the WRONG profile
    loadAsset(
      url,
      (asset) => {
        if (!asset.scene) {
          setStatus("attach failed: no mesh");
          return;
        }
        if (getKey() !== forKey) {
          dispose(asset.scene);
          setStatus(`attach dropped: model changed while ${baseName(url)} loaded`);
          return;
        }
        a.obj = asset.scene;
        const bone = a.bone ? findBone(a.bone) : null; // furniture (no bone) → rides the rig root (floats with her)
        a.attachedTo = bone ? bone.name : "(rig root)";
        a.obj.traverse((o) => {
          if (o.isMesh) o.frustumCulled = false;
        });
        (bone || getRig()).add(a.obj);
        _placeAttachment(a);
        // Auto-size a FRESH prop to a sane fraction of the avatar — a separate mesh has
        // its own units, so scale:1 can render giant/tiny. Avatar
        // height uses BASE_H×size (skinned-mesh bboxes are unreliable); prop uses its
        // own bbox. Skipped when a scale was given or when restoring a saved one.
        if (opts.scale == null && !opts._restore && getModel()) {
          a.obj.updateWorldMatrix(true, true);
          const pb = new THREE.Box3().setFromObject(a.obj);
          const pMax = Math.max(pb.max.x - pb.min.x, pb.max.y - pb.min.y, pb.max.z - pb.min.z) || 1;
          const aH = getAvatarWorldHeight() || 1;
          const frac = category === "furniture" ? 0.9 : category === "clothes" ? 1.0 : 0.45;
          const s = (aH * frac) / pMax;
          if (isFinite(s) && s > 0) {
            a.scale = +s.toFixed(4);
            _placeAttachment(a);
          }
        }
        attachObjs.push(a);
        if (!opts._restore) saveAttachments();
        console.log("[avatar] attached", baseName(url), "->", a.attachedTo);
        setStatus(`attached ${baseName(url)} -> ${a.attachedTo}`);
      },
      (err) => setStatus(`attach failed: ${err?.message || err}`),
      { kind: opts.kind || kindOf(url) }
    );
    return a.id;
  }

  function detachAttachment(id) {
    const i = attachObjs.findIndex((a) => a.id === id);
    if (i < 0) return false;
    const a = attachObjs[i];
    a.obj?.parent?.remove(a.obj);
    dispose(a.obj);
    attachObjs.splice(i, 1);
    saveAttachments();
    return true;
  }

  function clearAttachments() {
    for (const a of attachObjs) {
      a.obj?.parent?.remove(a.obj);
      dispose(a.obj);
    }
    attachObjs = [];
    saveAttachments();
  }

  function reapplyAttachments() {
    // Furniture rides the RIG root (not the disposed model subtree) — explicitly remove what's
    // still parented there, or every model switch leaves a ghost chair with no remaining handle.
    const rig = getRig();
    for (const a of attachObjs)
      if (a.obj && a.obj.parent === rig) {
        rig.remove(a.obj);
        dispose(a.obj);
      }
    attachObjs = []; // bone-parented props died with the disposed model subtree
    for (const cfg of profileFor(getKey()).attachments || []) attachMesh(cfg.url, { ...cfg, _restore: true });
  }

  function tuneAttachment(id, opts = {}) {
    const a = attachObjs.find((x) => x.id === id);
    if (!a || !a.obj) return null;
    if (opts.pos) a.pos = _v3(opts.pos, a.pos);
    if (opts.rot) a.rot = _v3(opts.rot, a.rot);
    if (opts.scale != null) a.scale = _num(opts.scale, a.scale);
    if (opts.bone && opts.bone !== a.bone) {
      a.bone = opts.bone;
      const bone = findBone(a.bone);
      a.obj.parent?.remove(a.obj);
      (bone || getRig()).add(a.obj);
      a.attachedTo = bone ? bone.name : "(rig root)";
    }
    _placeAttachment(a);
    saveAttachments();
    return { id: a.id, bone: a.bone, attachedTo: a.attachedTo, pos: a.pos, rot: a.rot, scale: a.scale };
  }

  return {
    getAttachments,
    findBone,
    attachMesh,
    detachAttachment,
    clearAttachments,
    reapplyAttachments,
    tuneAttachment,
  };
}
