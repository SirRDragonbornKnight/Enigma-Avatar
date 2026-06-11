// facial.js — facial animation layer with a fallback ladder:
//   1) VRM   → vrm.expressionManager presets ("aa" mouth, "blink")
//   2) morph → blendshape/morph targets (VRChat visemes vrc.v_aa, "jawOpen", …)
//   3) bones → a jaw bone flaps (Bip_Jaw); eyelid bones blink if present
//   4) none  → no face rig (body-only); update() is a safe no-op
//
// It drives idle eye-blinks and a single 0..1 MOUTH-OPEN amount. Lip-sync feeds
// that amount from the audio analyser (see avatar.js / Phase 3 voice) via
// setMouth(); with no audio it just blinks. We do amplitude lip-sync (mouth opens
// on loudness), not phoneme→viseme — that reads fine for a desktop companion and
// works on any rig that has *some* open-mouth channel.
import * as THREE from "three";
import { detectMouthMorph } from "./geom_mouth.js";

// An "open mouth" channel: a jaw/mouth-open blendshape, or the "aa" viseme.
const OPEN_RE = /jaw.?open|mouth.?open|mouthopen|(^|[._-])aa($|[._-])|vrc\.v_aa|viseme.?aa/i;  // no bare \bopen\b — it grabs eye_open etc.
const BLINK_RE = /blink|eyes?.?clos|wink/i;
const JAW_RE = /jaw/i;
const LID_RE = /eye.?lid|eyelid|(^|[._-])lid($|[._-])/i;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// deterministic-ish blink jitter without Math.random (varies per call site index)
let _seed = 1;
const jitter = (lo, hi) => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return lo + (_seed / 0x7fffffff) * (hi - lo); };

export function buildFacial(model, vrm = null, opts = {}) {
  // ---------- 1) VRM expression manager ----------
  if (vrm && vrm.expressionManager) {
    const em = vrm.expressionManager;
    const P = { open: 1.0 };
    let mouth = 0, mouthTgt = 0, blinkT = jitter(2, 5), blinking = 0;
    const set = (n, v) => { try { em.setValue(n, v); } catch {} };
    return {
      mode: "vrm", info: "VRM expressions (aa / blink)",
      params: P, setParams: (p) => Object.assign(P, p),
      setMouth: (a) => { mouthTgt = clamp01(a); },
      blink() { blinking = 0.22; },
      update(dt, blinkOn = true) {
        mouth += (mouthTgt - mouth) * Math.min(1, dt * 18);
        set("aa", mouth * P.open);
        if (blinkOn) {
          if (blinking > 0) { blinking -= dt; set("blink", clamp01(Math.sin((1 - blinking / 0.22) * Math.PI))); }
          else { set("blink", 0); blinkT -= dt; if (blinkT <= 0) { blinking = 0.22; blinkT = jitter(2.5, 6); } }
        }
      },
    };
  }

  // ---------- collect morph targets across all meshes ----------
  const meshes = [];
  model.traverse((o) => { if (o.isMesh && o.morphTargetDictionary && o.morphTargetInfluences) meshes.push(o); });
  const morphHits = (re) => {
    const hits = [];
    for (const m of meshes) for (const name in m.morphTargetDictionary) if (re.test(name)) hits.push({ mesh: m, idx: m.morphTargetDictionary[name], name });
    return hits;
  };
  // An explicit mouth-morph INDEX (name-free) wins — for models whose morph targets are
  // unnamed or garbage-named, where the regex picker below finds nothing (e.g. 51dc: 76
  // unnamed morphs). Set per-model via rig_overrides.json `face.mouthMorph`, found by
  // probing `EnigmaAvatar.setMorph(i,1)` (or a geometric pick). The "trust no names" path.
  let openHits;
  const ov = opts.mouthMorph;
  if (ov != null && Number.isInteger(ov) && ov >= 0) {       // explicit INDEX override — must be a real, in-range index
    openHits = [];
    model.traverse((o) => { if (o.isMesh && o.morphTargetInfluences && ov < o.morphTargetInfluences.length) openHits.push({ mesh: o, idx: ov, name: `#${ov}` }); });
    if (!openHits.length) console.warn(`[avatar] face.mouthMorph #${ov} is out of range on every mesh — ignoring it, falling back (fix the override)`);
  } else {
    if (ov != null) console.warn(`[avatar] face.mouthMorph must be a non-negative integer, got ${JSON.stringify(ov)} — ignoring`);
    // Prefer a dedicated jaw/mouth-open morph; fall back to the "aa" viseme.
    openHits = morphHits(/jaw.?open|mouth.?open|mouthopen/i);
    if (!openHits.length) openHits = morphHits(OPEN_RE);
  }
  const blinkHits = morphHits(BLINK_RE);

  if (openHits.length) {
    const setMorph = (hits, v) => { for (const h of hits) h.mesh.morphTargetInfluences[h.idx] = v; };
    const P = { open: 1.0 };
    let mouth = 0, mouthTgt = 0, blinkT = jitter(2, 5), blinking = 0;
    return {
      mode: "morph",
      ownedMorphs: [...new Set([...openHits.map((h) => h.idx), ...blinkHits.map((h) => h.idx)])],   // mouth + blink morphs the layer auto-drives (a manual UI set won't stick)
      info: `morph targets — mouth:[${openHits.map((h) => h.name).join(",")}]${blinkHits.length ? " blink:[" + blinkHits.map((h) => h.name).join(",") + "]" : " (no blink morph)"}`,
      params: P, setParams: (p) => Object.assign(P, p),
      setMouth: (a) => { mouthTgt = clamp01(a); },
      blink() { blinking = 0.22; },
      update(dt, blinkOn = true) {
        mouth += (mouthTgt - mouth) * Math.min(1, dt * 18);
        setMorph(openHits, mouth * P.open);
        if (blinkOn && blinkHits.length) {
          if (blinking > 0) { blinking -= dt; setMorph(blinkHits, clamp01(Math.sin((1 - blinking / 0.22) * Math.PI))); }
          else { setMorph(blinkHits, 0); blinkT -= dt; if (blinkT <= 0) { blinking = 0.22; blinkT = jitter(2.5, 6); } }
        }
      },
    };
  }

  // ---------- 3) bones: a jaw bone flaps; eyelid bones blink ----------
  let jaw = null, lids = [];
  model.traverse((o) => {
    if (!o.isBone) return;
    if (!jaw && JAW_RE.test(o.name)) jaw = o;
    if (LID_RE.test(o.name)) lids.push(o);
  });
  if (jaw) {
    // open by rotating the jaw about an axis; sign/axis vary per rig → tunable.
    // (Mal0's Bip_Jaw opens on local X; tune({ jawAxis:'x'|'y'|'z', jawOpen:rad }).)
    const P = { jawAxis: "x", jawOpen: 0.32, lidAxis: "x", lidClose: 0.5, lidLower: -0.5, lidCorner: 0.3 };
    for (const k in P) if (opts[k] != null) P[k] = opts[k];   // per-model face override (rig_overrides.json face:{lidAxis,lidClose,lidLower,...}) — eyelid rigs differ wildly
    // A natural blink closes the UPPER lids one way and the LOWER lids the OPPOSITE way so they MEET in
    // the middle; corners barely move. Driving every lid uniformly (the old behaviour) splays a multi-lid
    // rig like lola (3 upper + 3 lower + 2 corner per eye) into a mess — her reported "blinking is wrong".
    // Classify by name; a rig with no upper/lower naming falls back to uniform (all "u" → the old path).
    const UP = /upper|top/i, LO = /lower|bottom|under/i, hasUL = lids.some((b) => UP.test(b.name) || LO.test(b.name));
    const lidCat = lids.map((b) => !hasUL ? "u" : LO.test(b.name) ? "l" : UP.test(b.name) ? "u" : "c");   // u=upper(main) · l=lower(opposite) · c=corner(slight)
    const jawRest = jaw.quaternion.clone();
    const lidRest = lids.map((b) => b.quaternion.clone());
    const _e = new THREE.Euler(), _q = new THREE.Quaternion();
    const applyAxis = (bone, rest, axis, ang) => { _e.set(axis === "x" ? ang : 0, axis === "y" ? ang : 0, axis === "z" ? ang : 0, "XYZ"); bone.quaternion.copy(rest).multiply(_q.setFromEuler(_e)); };
    let mouth = 0, mouthTgt = 0, blinkT = jitter(2, 5), blinking = 0, manualBlink = -1;
    return {
      mode: "bones",
      info: `jaw bone "${jaw.name}"${lids.length ? ` + ${lids.length} eyelid bone(s)${hasUL ? " (upper/lower split)" : ""}` : " (no eyelid bones — no blink)"}`,
      boneNames: () => [jaw.name, ...lids.map((b) => b.name)],   // bones THIS layer owns — the ambient idle must not touch them (they'd tremble when facial is toggled off)
      params: P, setParams: (p) => Object.assign(P, p),
      setMouth: (a) => { mouthTgt = clamp01(a); },
      setBlink: (v) => { manualBlink = v == null || v < 0 ? -1 : clamp01(v); },   // hold the lids at v (deliberate blink/wink/squint, and live axis calibration); <0 = back to the auto timer
      blink() { blinking = 0.22; },
      update(dt, blinkOn = true) {
        mouth += (mouthTgt - mouth) * Math.min(1, dt * 20);
        applyAxis(jaw, jawRest, P.jawAxis, mouth * P.jawOpen);
        if (blinkOn && lids.length) {
          let c;
          if (manualBlink >= 0) c = manualBlink;                 // held (AI blink / test)
          else { c = 0; if (blinking > 0) { blinking -= dt; c = clamp01(Math.sin((1 - blinking / 0.22) * Math.PI)); } else { blinkT -= dt; if (blinkT <= 0) { blinking = 0.22; blinkT = jitter(2.5, 6); } } }
          lids.forEach((b, i) => applyAxis(b, lidRest[i], P.lidAxis, c * P.lidClose * (lidCat[i] === "l" ? P.lidLower : lidCat[i] === "c" ? P.lidCorner : 1)));
        }
      },
    };
  }

  // ---------- 3.5) GEOMETRIC mouth morph (name-free, automatic) ----------
  // No VRM, no NAMED mouth morph, no jaw bone — but the model may still have an unnamed
  // mouth blendshape (51dc: 76 unnamed morphs). Find it by GEOMETRY (the morph that drops
  // head-region verts downward). General: no per-model config, no names. A wrong pick is a
  // 1-line rig_overrides face.mouthMorph override (which wins, above — section 2).
  const geom = detectMouthMorph(model);
  if (geom && geom.mesh && geom.index != null) {
    const mesh = geom.mesh, idx = geom.index;     // drive ONLY the winning mesh — index i is a DIFFERENT shape on other meshes
    const P = { open: 1.0 };
    let mouth = 0, mouthTgt = 0;
    return {
      mode: "morph-geom",
      ownedMorphs: [idx],                            // this morph is auto-driven by lip-sync (a manual UI set won't hold)
      info: `morph #${idx} on 1 mesh (geometric jaw-drop, score ${geom.score.toFixed(2)} of ${geom.morphs} morphs) — override via rig_overrides face.mouthMorph`,
      params: P, setParams: (p) => Object.assign(P, p),
      setMouth: (a) => { mouthTgt = clamp01(a); },
      blink() {},
      update(dt) { mouth += (mouthTgt - mouth) * Math.min(1, dt * 18); mesh.morphTargetInfluences[idx] = mouth * P.open; },
    };
  }

  // ---------- 4) no mouth channel — ACKNOWLEDGE it, don't fake one ----------
  // No VRM expression, no named morph, no jaw bone, and the geometric pass found no
  // confident jaw-drop. This model simply has no way to open its mouth — say so plainly;
  // speech still plays, the mouth just stays still. (Never force a random morph.)
  return {
    mode: "none", info: "no mouth channel — no jaw bone, no mouth morph, no VRM expression (speech plays without lip-sync)", params: {},
    setParams() {}, setMouth() {}, blink() {}, update() {},
  };
}
