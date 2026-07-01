// query.js — the AI self-report reporter (extracted from avatar.js, Phase 3 carve 2).
//
// answerQuery(what) returns LIVE ground truth about the avatar for the bus `query` action: the
// recolor/mesh/region/bone/morph handles, live rotation, facial mode, model, position, the
// driver's capabilities, and a set of DIAGNOSTIC probes (joints, stance, IK residual, grip,
// skin-weight truth, per-mesh bounds, eye gaze). Read-ONLY — it never mutates engine state.
//
// WIRING: avatar.js calls createQueryReporter(engine, services) after the control surface exists.
// `engine` is the live state container (built inline in avatar.js); state that changes over the avatar's life
// (facial/proc/platforms/curDisp/curKey/sizeScale/weight maps/rig) is read off it and
// snapshotted once at the TOP of each call so a single report is internally consistent. `services`
// holds the stable helpers (EnigmaAvatar, _norm360, getRot, outfitNames, profileFor, allMeshesInfo).
import * as THREE from "three";

export function createQueryReporter(engine, services) {
  const { EnigmaAvatar, _norm360, getRot, outfitNames, profileFor, allMeshesInfo } = services;

  return function answerQuery(what) {
    const facial = engine.facial,
      proc = engine.proc,
      platforms = engine.platforms,
      curDisp = engine.curDisp,
      curKey = engine.curKey,
      sizeScale = engine.sizeScale,
      _weightMass = engine.weightMass,
      _springNeverExtra = engine.springNeverExtra;
    if (what === "materials") return EnigmaAvatar.materials(); // [{index,name}] — the recolor handle
    if (what === "meshes") return EnigmaAvatar.meshes(); // [{index,name,visible}] — show/hide handle
    if (what === "regions") return EnigmaAvatar.springRegions(); // [{region,count,weight,nsfw}] — soft-body jiggle areas
    if (what === "bones") return EnigmaAvatar.bones(); // [{name,label,role}] — every bone + the user's friendly label
    if (what === "morphs") return EnigmaAvatar.morphs(); // [{index,name,value}] — the model's own shape keys
    if (what === "rotation") {
      // LIVE rig rotation (a live rotate-drag differs from the saved profile — the driver must see the truth)
      const R = 180 / Math.PI;
      return {
        x: _norm360(engine.rig.rotation.x * R),
        y: _norm360(engine.rig.rotation.y * R),
        z: _norm360(engine.rig.rotation.z * R),
        saved: getRot(),
      };
    }
    if (what === "facial")
      return facial
        ? { mode: facial.mode, info: facial.info, lipSync: facial.mode !== "none" }
        : { mode: "none", lipSync: false };
    if (what === "model") return { url: curKey, size: +sizeScale.toFixed(2) };
    if (what === "where") return EnigmaAvatar.where(); // screen-px position + screen size + cursor (AI movement)
    if (what === "capabilities" || what === "caps") return proc ? proc.capabilities() : null; // what the brain can drive: roles, flex-able limbs, expressions, channels, limits
    if (what === "roles") return proc ? { bones: proc.roleBones(), flex: proc.flexAxes() } : null; // DIAGNOSTIC: role → actual bone name + flex axes
    if (what === "joints") return proc ? proc.jointAngles() : null; // DIAGNOSTIC: live knee/elbow angles
    if (what === "stance") return proc?.stance ? proc.stance() : null; // DIAGNOSTIC: leg stance truth — knee angles, toe headings, kneecap-vs-toes drift on squat-normalized rigs
    if (what === "grip") return proc?.gripState ? proc.gripState() : null; // DIAGNOSTIC: the reactive finger grip (the idle diagnostic died with the idle machinery, 2026-06-12)
    if (what === "outfits") return { outfits: outfitNames(), hiddenMeshes: profileFor(curKey).hiddenMeshes || [] }; // the saved looks + the live hidden set
    if (what === "platforms")
      return {
        count: platforms.length,
        platforms: platforms.map((p) => ({
          px: Math.round(p.gx - curDisp.x),
          py: Math.round(p.gy - curDisp.y),
          w: p.w,
        })),
      }; // in her current monitor's px (the `where` convention)
    if (what === "bounds") {
      // DIAGNOSTIC: per-VISIBLE-mesh world bounds (posed) — find what inflates the dims
      const out = [];
      const b = new THREE.Box3(),
        t = new THREE.Box3();
      allMeshesInfo().forEach(({ mesh, name }, index) => {
        if (!mesh.visible) return;
        b.makeEmpty();
        if (mesh.isSkinnedMesh && mesh.computeBoundingBox) {
          mesh.computeBoundingBox();
          if (mesh.boundingBox && !mesh.boundingBox.isEmpty())
            b.union(t.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld));
        }
        if (b.isEmpty()) b.expandByObject(mesh);
        out.push({
          index,
          name,
          w: +(b.max.x - b.min.x).toFixed(2),
          h: +(b.max.y - b.min.y).toFixed(2),
          x: [+b.min.x.toFixed(2), +b.max.x.toFixed(2)],
        });
      });
      return out.sort((a, c) => c.w - a.w).slice(0, 8);
    }
    if (what === "weights") {
      // DIAGNOSTIC: skin-weight truth — how many bones really deform + the heaviest (everything else is control/helper soup)
      if (!_weightMass || !_weightMass.size) return { deforming: 0 };
      let total = 0;
      _weightMass.forEach((v) => {
        total += v;
      });
      const top = [..._weightMass.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([b, m]) => ({ bone: b.name, mass: +m.toFixed(1) }));
      return {
        deforming: _weightMass.size,
        totalMass: +total.toFixed(1),
        unsprungTwinBones: _springNeverExtra.length,
        top,
      };
    }
    return EnigmaAvatar.state(); // default: full live state
  };
}
