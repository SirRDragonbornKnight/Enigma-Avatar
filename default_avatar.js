// default_avatar.js — the NO-MODEL marker (user decision 2026-06-26: do NOT render a self-made character).
//
// The engine used to build a full cel-shaded procedural figure here so a fresh clone with no models/
// still had something to drive. That self-made character is RETIRED: when no model is loaded the
// avatar.js side shows a DOM message telling the user to add a .glb (right-click -> Add model). This
// build now returns an INERT, empty group — no bones, no meshes, nothing for the procedural
// compositor or spring system to drive. rig.js resolves 0 roles on it (no body bones), so proc.update
// is a no-op and nothing self-animates.
//
// buildDefaultAvatar() -> { scene, animations:[], vrm:null }   (same shape loadAsset returns)
import * as THREE from "three";

export function buildDefaultAvatar() {
  // An inert marker: a named, empty Group. NO skeleton, NO primitive body, NO drivable bones.
  // The "no model loaded" hint is a DOM overlay raised by avatar.js, not a rendered character.
  const root = new THREE.Group();
  root.name = "NoModelMarker";
  root.userData.isNoModelMarker = true;
  return { scene: root, animations: [], vrm: null };
}
