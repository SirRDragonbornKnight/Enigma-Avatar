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

// An "open mouth" channel: a jaw/mouth-open blendshape, or the "aa" viseme.
const OPEN_RE = /jaw.?open|mouth.?open|mouthopen|(^|[._-])aa($|[._-])|vrc\.v_aa|viseme.?aa/i;  // no bare \bopen\b — it grabs eye_open etc.
const BLINK_RE = /blink|eyes?.?clos|wink/i;
const JAW_RE = /jaw/i;
const LID_RE = /eye.?lid|eyelid|(^|[._-])lid($|[._-])/i;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// deterministic-ish blink jitter without Math.random (varies per call site index)
let _seed = 1;
const jitter = (lo, hi) => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return lo + (_seed / 0x7fffffff) * (hi - lo); };

export function buildFacial(model, vrm = null) {
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
  // Prefer a dedicated jaw/mouth-open morph; fall back to the "aa" viseme.
  let openHits = morphHits(/jaw.?open|mouth.?open|mouthopen/i);
  if (!openHits.length) openHits = morphHits(OPEN_RE);
  const blinkHits = morphHits(BLINK_RE);

  if (openHits.length) {
    const setMorph = (hits, v) => { for (const h of hits) h.mesh.morphTargetInfluences[h.idx] = v; };
    const P = { open: 1.0 };
    let mouth = 0, mouthTgt = 0, blinkT = jitter(2, 5), blinking = 0;
    return {
      mode: "morph",
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
    const P = { jawAxis: "x", jawOpen: 0.32, lidAxis: "x", lidClose: 0.5 };
    const jawRest = jaw.quaternion.clone();
    const lidRest = lids.map((b) => b.quaternion.clone());
    const _e = new THREE.Euler(), _q = new THREE.Quaternion();
    const applyAxis = (bone, rest, axis, ang) => { _e.set(axis === "x" ? ang : 0, axis === "y" ? ang : 0, axis === "z" ? ang : 0, "XYZ"); bone.quaternion.copy(rest).multiply(_q.setFromEuler(_e)); };
    let mouth = 0, mouthTgt = 0, blinkT = jitter(2, 5), blinking = 0;
    return {
      mode: "bones",
      info: `jaw bone "${jaw.name}"${lids.length ? ` + ${lids.length} eyelid bone(s)` : " (no eyelid bones — no blink)"}`,
      params: P, setParams: (p) => Object.assign(P, p),
      setMouth: (a) => { mouthTgt = clamp01(a); },
      blink() { blinking = 0.22; },
      update(dt, blinkOn = true) {
        mouth += (mouthTgt - mouth) * Math.min(1, dt * 20);
        applyAxis(jaw, jawRest, P.jawAxis, mouth * P.jawOpen);
        if (blinkOn && lids.length) {
          let c = 0;
          if (blinking > 0) { blinking -= dt; c = clamp01(Math.sin((1 - blinking / 0.22) * Math.PI)); }
          else { blinkT -= dt; if (blinkT <= 0) { blinking = 0.22; blinkT = jitter(2.5, 6); } }
          lids.forEach((b, i) => applyAxis(b, lidRest[i], P.lidAxis, c * P.lidClose));
        }
      },
    };
  }

  // ---------- 4) no face rig ----------
  return {
    mode: "none", info: "no face rig (body-only)", params: {},
    setParams() {}, setMouth() {}, blink() {}, update() {},
  };
}
