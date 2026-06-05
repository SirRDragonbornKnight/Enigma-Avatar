// default_avatar.js — a zero-asset, license-clean PROCEDURAL placeholder character.
//
// Why this exists: models/ is gitignored (large + non-redistributable rips), so a
// FRESH CLONE on someone else's device has NO models. Rather than a blank overlay, the
// engine builds THIS: a cel-shaded anime-styled figure on a real, canonically-NAMED bone
// skeleton with primitive meshes parented to each bone. So the whole engine works on it
// out of the box — rig.js's NAME tier resolves all 19 roles, the procedural idle poses
// it, the spring system sways the twin-tails, and the user can right-click → Add model…
//
// Pure THREE (MeshToonMaterial + primitives) — no download, no asset, no licence → runs
// on ANY device, and doubles as a live demo of the procedural substrate.
//
// buildDefaultAvatar() → { scene, animations:[], vrm:null }   (same shape loadAsset returns)
import * as THREE from "three";

export function buildDefaultAvatar() {
  // ── cel shading: a stepped gradient ramp gives flat, banded "anime" lighting ──
  const ramp = new Uint8Array([90, 158, 215, 255]);          // 4 tones (dark→light)
  const grad = new THREE.DataTexture(ramp, ramp.length, 1, THREE.RedFormat);
  grad.minFilter = grad.magFilter = THREE.NearestFilter; grad.needsUpdate = true;
  const toon = (color, extra) => new THREE.MeshToonMaterial({ color, gradientMap: grad, ...extra });
  const M = {
    skin: toon(0xffe0cb), hair: toon(0x9a8cf0), white: toon(0xfbfdff),
    iris: toon(0x46c2ea), dark: toon(0x2f2f3a), top: toon(0xeef1f8),
    skirt: toon(0x3d5570, { side: THREE.DoubleSide }), shoe: toon(0x39414f),
    accent: toon(0xff6f93), blush: toon(0xff9d9d, { transparent: true, opacity: 0.55 }),
  };
  const UP = new THREE.Vector3(0, 1, 0);
  const sd = (s) => (s < 0 ? "Left" : "Right");              // model-left = −X (cascade convention)

  // ── named bone skeleton (rig.js name tier → all 19 roles; big-head/short-neck anime proportions) ──
  const bone = (name, pos, kids = []) => { const b = new THREE.Bone(); b.name = name; b.position.set(pos[0], pos[1], pos[2]); for (const k of kids) b.add(k); return b; };
  const armB = (s) => bone(sd(s) + "Shoulder", [s * 0.05, 0.06, 0], [
    bone(sd(s) + "UpperArm", [s * 0.085, -0.01, 0], [
      bone(sd(s) + "Forearm", [s * 0.20, 0, 0], [
        bone(sd(s) + "Hand", [s * 0.18, 0, 0], [bone(sd(s) + "Hand_end", [s * 0.05, 0, 0])]),
      ]),
    ]),
  ]);
  const legB = (s) => bone(sd(s) + "Thigh", [s * 0.07, -0.04, 0], [
    bone(sd(s) + "Shin", [0, -0.34, 0], [
      bone(sd(s) + "Foot", [0, -0.32, 0], [bone(sd(s) + "Toe", [0, -0.03, 0.12])]),
    ]),
  ]);
  // twin-tail hair chains — NOT roles (names match the spring detector → they SWAY with motion)
  const tail = (tag, s) => bone("Hair_" + tag + "_0", [s * 0.16, 0.12, -0.02], [
    bone("Hair_" + tag + "_1", [s * 0.05, -0.20, 0], [
      bone("Hair_" + tag + "_2", [s * 0.02, -0.21, 0], [bone("Hair_" + tag + "_end", [0, -0.16, 0])]),
    ]),
  ]);
  const head = bone("Head", [0, 0.08, 0], [bone("Head_end", [0, 0.30, 0]), tail("tailL", -1), tail("tailR", 1)]);
  const hips = bone("Hips", [0, 0.92, 0], [
    bone("Spine", [0, 0.10, 0], [
      bone("Chest", [0, 0.15, 0], [bone("Neck", [0, 0.11, 0], [head]), armB(-1), armB(1)]),
    ]),
    legB(-1), legB(1),
  ]);
  const armature = new THREE.Object3D(); armature.name = "Armature"; armature.add(hips);

  // ── helpers ──
  const find = (n) => { let r = null; armature.traverse((o) => { if (!r && o.isBone && o.name === n) r = o; }); return r; };
  const put = (boneName, geo, mat, pos = [0, 0, 0], rot = null, scale = null) => {
    const b = find(boneName); if (!b) return null;
    const m = new THREE.Mesh(geo, mat);
    m.position.set(pos[0], pos[1], pos[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    if (scale != null) (Array.isArray(scale) ? m.scale.set(scale[0], scale[1], scale[2]) : m.scale.setScalar(scale));
    b.add(m); return m;
  };
  const capsuleOn = (b, v, r, mat) => {                       // capsule from b's origin toward child-local v
    const len = v.length(); if (len < 1e-4) return;
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.001, len - r * 2), 6, 10), mat);
    m.position.copy(v).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(UP, v.clone().normalize());
    b.add(m);
  };

  // ── body: capsules along the role bones (shirt on torso/upper-arm, skin elsewhere) ──
  const segMat = (c) => /Spine|Chest|Shoulder|UpperArm/.test(c) ? M.top : M.skin;
  const segR = (c) =>
    /Spine|Chest/.test(c) ? 0.085 : /Neck/.test(c) ? 0.045 : /Head/.test(c) ? 0.04 :
    /Shoulder/.test(c) ? 0.05 : /UpperArm/.test(c) ? 0.038 : /Forearm/.test(c) ? 0.032 :
    /Hand/.test(c) ? 0.028 : /Thigh/.test(c) ? 0.05 : /Shin/.test(c) ? 0.05 :   // Thigh→Shin = thigh
    /Foot/.test(c) ? 0.042 : 0.03;                                              // Shin→Foot = shin
  armature.traverse((b) => {
    if (!b.isBone) return;
    for (const c of b.children) {
      if (!c.isBone || /_end$|Toe$/.test(c.name) || /^Hair/.test(c.name)) continue;
      capsuleOn(b, c.position, segR(c.name), segMat(c.name));
    }
  });

  // ── swaying twin-tails: tapered hair capsules along the Hair_* chains + accent ties ──
  armature.traverse((b) => {
    if (!b.isBone || !/^Hair_tail.*_\d$/.test(b.name)) return;
    const depth = +((b.name.match(/_(\d)$/) || [])[1] || 0);
    for (const c of b.children) if (c.isBone) capsuleOn(b, c.position, Math.max(0.018, 0.055 - depth * 0.013), M.hair);
  });
  put("Hair_tailL_0", new THREE.TorusGeometry(0.045, 0.018, 8, 14), M.accent, [0, 0.02, 0], [Math.PI / 2, 0, 0]);
  put("Hair_tailR_0", new THREE.TorusGeometry(0.045, 0.018, 8, 14), M.accent, [0, 0.02, 0], [Math.PI / 2, 0, 0]);

  // ── head + face (all local to the Head bone; face on +Z, toward the camera) ──
  const HC = 0.16, R = 0.17;                                  // head center height, radius
  put("Head", new THREE.SphereGeometry(R, 28, 22), M.skin, [0, HC, 0]);
  const eye = (s) => {
    const ex = s * 0.066, ey = HC - 0.005, ez = 0.150;
    put("Head", new THREE.SphereGeometry(0.045, 16, 14), M.white, [ex, ey, ez], [0, 0, s * -0.18], [1.0, 1.45, 0.55]); // sclera
    put("Head", new THREE.SphereGeometry(0.030, 16, 14), M.iris, [ex, ey - 0.006, ez + 0.022], null, [1.0, 1.25, 0.5]); // iris
    put("Head", new THREE.SphereGeometry(0.015, 12, 10), M.dark, [ex, ey - 0.004, ez + 0.034], null, [1.0, 1.2, 0.5]);  // pupil
    put("Head", new THREE.SphereGeometry(0.009, 10, 8), M.white, [ex + s * 0.008, ey + 0.018, ez + 0.040]);             // catchlight
    put("Head", new THREE.BoxGeometry(0.05, 0.009, 0.012), M.hair, [ex, HC + 0.058, ez - 0.004], [0, 0, s * 0.12]);     // eyebrow
    put("Head", new THREE.SphereGeometry(0.028, 12, 10), M.blush, [s * 0.10, HC - 0.05, ez - 0.03], null, [1.2, 0.7, 0.4]); // blush
  };
  eye(-1); eye(1);
  put("Head", new THREE.BoxGeometry(0.020, 0.010, 0.010), M.accent, [0, HC - 0.072, 0.166]);   // small mouth

  // ── hair: scalp cap + back volume + spiky bangs ──
  put("Head", new THREE.SphereGeometry(R * 1.08, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.52), M.hair, [0, HC, 0]); // top cap
  put("Head", new THREE.SphereGeometry(R * 0.95, 20, 18), M.hair, [0, HC - 0.05, -0.06], null, [1.05, 1.25, 0.95]); // back mass
  const bangN = 7;
  for (let i = 0; i < bangN; i++) {
    const t = i / (bangN - 1) - 0.5;                          // −0.5..0.5
    const drop = 0.10 - Math.abs(t) * 0.035;                  // longer in the middle
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.034, drop, 5), M.hair);
    c.rotation.x = Math.PI;                                   // apex points DOWN (toward the eyes)
    c.position.set(t * 0.20, HC + 0.12 - drop / 2, 0.145 - Math.abs(t) * 0.02);
    find("Head").add(c);
  }

  // ── outfit + extremities ──
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.17, 0.16, 16, 1, true), M.skirt);
  skirt.position.set(0, -0.04, 0); find("Hips").add(skirt);
  put("Chest", new THREE.TorusGeometry(0.06, 0.015, 8, 16), M.accent, [0, 0.145, 0.005], [Math.PI / 2, 0, 0]); // collar
  for (const s of [-1, 1]) {
    put(sd(s) + "Hand", new THREE.SphereGeometry(0.035, 12, 10), M.skin, [s * 0.03, 0, 0], null, [1, 1.1, 0.8]);
    put(sd(s) + "Foot", new THREE.BoxGeometry(0.06, 0.045, 0.12), M.shoe, [0, -0.015, 0.03]);
  }

  const root = new THREE.Group(); root.name = "DefaultAvatar"; root.add(armature);
  return { scene: root, animations: [], vrm: null };
}
