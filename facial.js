// facial.js — FACIAL v2 (2026-06-12): PER-CHANNEL resolution. MOUTH and BLINK each walk their OWN
// ladder and the results compose — the v1 single ladder gated blink behind the mouth tier (a
// lids-only rig like glados' eye flaps could never blink, and a morph-mouth model with lid BONES
// lost its blink entirely; both audit-confirmed architecture bugs).
//   MOUTH:  VRM "aa" → named morph (widened dictionary) → jaw
//           bone → GEOMETRIC (head-anchored mouth-band classifier, then the legacy jaw-drop pick)
//   BLINK:  VRM "blink" → named morph → eyelid BONES (jaw not
//           required) → GEOMETRIC (mirrored eye-band morph — recovers unnamed blinks like shibahu's)
// `mode` keeps meaning "does she have a MOUTH" (every consumer reads it that way); blinkMode is new.
// Lip-sync stays amplitude-driven (mouth opens on loudness) via setMouth().
import * as THREE from "three";
import { detectMouthMorph } from "./geom_mouth.js";
import { analyzeMorphGeometry } from "./geom_face.js";   // head-anchored eye/mouth band classifier (facial v2 item ②, unit-tested)

// Widened name dictionaries (research 2026-06-11: ARKit camelCase, Unified Expressions, VRoid
// Fcl_*, CC V_*, MMD Japanese). No bare \bopen\b — it grabs eye_open etc.
const OPEN_RE = /jaw.?open|mouth.?open|mouthopen|(^|[._-])aa($|[._-])|vrc\.v_aa|viseme.?aa|fcl[._-]?mth[._-]?a$|(^|[._-])v[._-]open|あ/i;
const BLINK_RE = /blink|eyes?.?clos|wink|fcl[._-]?eye[._-]?close|まばたき|ウィンク/i;
const JAW_RE = /jaw/i;
const LID_RE = /eye.?lid|eyelid|(^|[._-])lid($|[._-])|eye.?flap/i;   // eye.?flap: glados' aperture flaps ARE her eyelids

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const BLINK_DUR = 0.22;   // one blink's close-open envelope (s) — fired ONLY by blink(), never autonomously

export function buildFacial(model, vrm = null, opts = {}) {
  // ---------- 1) VRM expression manager ----------
  if (vrm && vrm.expressionManager) {
    const em = vrm.expressionManager;
    const P = { open: 1.0 };
    let mouth = 0, mouthTgt = 0, blinking = 0, manualBlink = -1, wasOn = false;
    const set = (n, v) => { try { em.setValue(n, v); } catch {} };
    // #31 probe the manager for the best mouth opener: a dedicated mouthOpen/jawOpen beats the
    // 'aa' viseme. Walk whatever name list the manager exposes; if set('aa') would be a no-op
    // (no 'aa' either) we still fall through to 'aa' so a future-bound expression isn't blocked.
    const exprNames = () => {
      const m = em.expressions || em._expressions || em.expressionMap || em._expressionMap;
      if (Array.isArray(m)) return m.map((e) => e && (e.expressionName || e.name)).filter(Boolean);
      if (m && typeof m === "object") return Object.keys(m);
      return [];
    };
    const names = exprNames();
    const has = (n) => names.some((x) => x.toLowerCase() === n);
    const mouthName = has("mouthopen") ? "mouthOpen" : has("jawopen") ? "jawOpen" : "aa";   // best opener, else 'aa'
    return {
      mode: "vrm", blinkMode: "vrm", info: `VRM expressions (mouth '${mouthName}' / blink)`,
      ownedMorphs: [],                                                                      // VRM drives expressions, not raw morph indices
      params: P, setParams: (p) => Object.assign(P, p),
      setMouth: (a) => { const n = +a; if (isFinite(n)) mouthTgt = clamp01(n); },   // ignore a NaN/garbage amplitude -> mouth holds last target, never freezes open until reload
      setBlink: (v) => { manualBlink = v == null || v < 0 ? -1 : clamp01(v); },             // hold the lids; <0 = released (eyes open)
      blink() { blinking = BLINK_DUR; },                                                    // one blink — fired by a real drive only
      update(dt, blinkOn = true) {
        mouth += (mouthTgt - mouth) * Math.min(1, dt * 18);
        set(mouthName, mouth * P.open);
        if (manualBlink >= 0) { set("blink", manualBlink); wasOn = blinkOn; return; }       // manual hold wins; don't let the edge fight it
        // #22 STRICT: no auto-timer. Lids stay OPEN unless blink() queued a one-shot.
        if (blinkOn && blinking > 0) { blinking -= dt; set("blink", clamp01(Math.sin((1 - blinking / BLINK_DUR) * Math.PI))); }
        else if (wasOn && !blinkOn && blinking > 0) { set("blink", 0); blinking = 0; }      // #32 blinkOn falling edge mid-blink: snap lids OPEN once, drop the queue
        else set("blink", 0);                                                               // default: eyes open, no autonomous blink
        wasOn = blinkOn;
      },
    };
  }

  // ---------- collect morph targets + face bones ONCE (both channels shop here) ----------
  const meshes = [];
  model.traverse((o) => { if (o.isMesh && o.morphTargetDictionary && o.morphTargetInfluences) meshes.push(o); });
  const morphHits = (re) => {
    const hits = [];
    for (const m of meshes) for (const name in m.morphTargetDictionary) if (re.test(name)) hits.push({ mesh: m, idx: m.morphTargetDictionary[name], name });
    return hits;
  };
  const setMorph = (hits, v) => { for (const h of hits) h.mesh.morphTargetInfluences[h.idx] = v; };
  const hitsForIndex = (i) => {                              // index-addressed morph (unnamed models) — meshes that really have it (when morphAttributes exist, the index must be present; some loaders/fixtures carry influences only)
    const hits = []; model.traverse((o) => { if (o.isMesh && o.morphTargetInfluences && i < o.morphTargetInfluences.length && (!o.geometry?.morphAttributes?.position || o.geometry.morphAttributes.position[i])) hits.push({ mesh: o, idx: i, name: `#${i}` }); });
    return hits;
  };
  let jaw = null; const lids = [];
  model.traverse((o) => { if (!o.isBone) return; if (!jaw && JAW_RE.test(o.name)) jaw = o; if (LID_RE.test(o.name)) lids.push(o); });
  const P = { open: 1.0, jawAxis: "x", jawOpen: 0.32, lidAxis: "x", lidClose: 0.5, lidLower: -0.5, lidCorner: 0.3 };
  for (const k in P) if (opts[k] != null) P[k] = opts[k];    // caller-supplied face params (also set live via facialTune/setParams) — face rigs differ wildly
  const _e = new THREE.Euler(), _q = new THREE.Quaternion();
  const applyAxis = (bone, rest, axis, ang) => { _e.set(axis === "x" ? ang : 0, axis === "y" ? ang : 0, axis === "z" ? ang : 0, "XYZ"); bone.quaternion.copy(rest).multiply(_q.setFromEuler(_e)); };
  let _geo = null, _geoTried = false;                        // lazy shared geometric analysis (only when a ladder reaches it)
  const geoAnalysis = () => {
    if (_geoTried) return _geo;
    _geoTried = true;
    if (!opts.headBone) return null;
    try { _geo = analyzeMorphGeometry(model, { head: opts.headBone, bodyUp: opts.bodyUp || new THREE.Vector3(0, 1, 0), forward: opts.forward || new THREE.Vector3(0, 0, 1) }); } catch (e) { console.warn("[avatar] geometric face analysis failed:", e); }
    return _geo;
  };

  // ---------- MOUTH ladder: named morph → jaw bone → geometric ----------
  let mouthDrv = null;                                       // { kind, info, set(v01), owned?:[indices], bones?:[names] }
  if (!mouthDrv) {
    let hits = morphHits(/jaw.?open|mouth.?open|mouthopen/i);   // a dedicated jaw/mouth-open morph beats the "aa" viseme
    if (!hits.length) hits = morphHits(OPEN_RE);
    if (hits.length) mouthDrv = { kind: "morph", info: `mouth morphs [${hits.map((h) => h.name).join(",")}]`, owned: [...new Set(hits.map((h) => h.idx))], set: (v) => setMorph(hits, v) };
  }
  if (!mouthDrv && jaw) {
    const jawRest = jaw.quaternion.clone();                  // open by rotating the jaw; axis/sign per rig → tunable (Mal0's Bip_Jaw opens on local X)
    mouthDrv = { kind: "bones", info: `jaw bone "${jaw.name}"`, bones: [jaw.name], set: (v) => applyAxis(jaw, jawRest, P.jawAxis, v * P.jawOpen) };
  }
  if (!mouthDrv) {                                           // geometric: head-anchored mouth-band classifier first, then the legacy single-signal jaw-drop
    const g = geoAnalysis();
    const top = g && g.mouth && g.mouth.length ? g.mouth[0] : null;
    if (top != null && (g.byIndex.get(top)?.mouthScore ?? 0) > 0.3) {
      const hits = hitsForIndex(top);
      if (hits.length) mouthDrv = { kind: "morph-geom", info: `mouth morph #${top} (geometric mouth band, score ${g.byIndex.get(top).mouthScore.toFixed(2)})`, owned: [top], set: (v) => setMorph(hits, v) };
    }
    if (!mouthDrv) {
      const geo = detectMouthMorph(model, { headBone: opts.headBone, bodyUp: opts.bodyUp });   // head-anchored cut (hair/hats don't skew it)
      if (geo && geo.mesh && geo.index != null) mouthDrv = { kind: "morph-geom", info: `morph #${geo.index} on 1 mesh (geometric jaw-drop, score ${geo.score.toFixed(2)} of ${geo.morphs})`, owned: [geo.index], set: (v) => { geo.mesh.morphTargetInfluences[geo.index] = v; } };
    }
  }

  // ---------- BLINK ladder: named morph → eyelid BONES (no jaw needed — the glados fix) →
  // geometric mirrored eye-band morph (recovers unnamed blinks, shibahu's #13 class) ----------
  let blinkDrv = null;
  if (!blinkDrv) {
    const hits = morphHits(BLINK_RE);
    if (hits.length) blinkDrv = { kind: "morph", info: `blink morphs [${hits.map((h) => h.name).join(",")}]`, owned: [...new Set(hits.map((h) => h.idx))], set: (c) => setMorph(hits, c) };
  }
  if (!blinkDrv && lids.length) {
    // A natural blink closes the UPPER lids one way and the LOWER lids the OPPOSITE way so they
    // MEET; corners barely move. Uniform driving splayed lola's 16-lid rig — classify by name;
    // no upper/lower naming → uniform (all "u").
    const UP = /upper|top/i, LO = /lower|bottom|under/i, hasUL = lids.some((b) => UP.test(b.name) || LO.test(b.name));
    const lidCat = lids.map((b) => !hasUL ? "u" : LO.test(b.name) ? "l" : UP.test(b.name) ? "u" : "c");
    const lidRest = lids.map((b) => b.quaternion.clone());
    blinkDrv = {
      kind: "bones", info: `${lids.length} eyelid bone(s)${hasUL ? " (upper/lower split)" : ""}`, bones: lids.map((b) => b.name),
      set: (c) => lids.forEach((b, i) => applyAxis(b, lidRest[i], P.lidAxis, c * P.lidClose * (lidCat[i] === "l" ? P.lidLower : lidCat[i] === "c" ? P.lidCorner : 1))),
    };
  }
  if (!blinkDrv) {
    const g = geoAnalysis();
    const top = g && g.eyes && g.eyes.length ? g.eyes[0] : null;
    if (top != null && (g.byIndex.get(top)?.eyeScore ?? 0) > 0.35 && !(mouthDrv?.owned || []).includes(top)) {   // never double-book the mouth morph as the blink
      const hits = hitsForIndex(top);
      if (hits.length) blinkDrv = { kind: "morph-geom", info: `blink morph #${top} (geometric eye band, score ${g.byIndex.get(top).eyeScore.toFixed(2)})`, owned: [top], set: (c) => setMorph(hits, c) };
    }
  }

  // ---------- compose ONE facade (shared mouth smoother + one-shot blink, whatever the channel kinds) ----------
  if (!mouthDrv && !blinkDrv) {
    // No channel at all — ACKNOWLEDGE it, never fake one (speech still plays, the face stays still).
    // Same facade SHAPE as the live one (#8): every method present, just inert.
    return { mode: "none", blinkMode: "none", info: "no mouth channel and no blink channel — no jaw/lids, no named or geometric face morphs (speech plays without lip-sync)", ownedMorphs: [], params: {}, setParams() {}, setMouth() {}, setBlink() {}, blink() {}, update() {} };
  }
  let mouth = 0, mouthTgt = 0, blinking = 0, manualBlink = -1, wasOn = false;
  return {
    mode: mouthDrv ? mouthDrv.kind : "none",                 // consumers read mode as "does she have a MOUTH"; blink reports separately now
    blinkMode: blinkDrv ? blinkDrv.kind : "none",
    info: `mouth: ${mouthDrv ? mouthDrv.info : "NONE"} · blink: ${blinkDrv ? blinkDrv.info : "NONE"}`,
    ownedMorphs: [...new Set([...(mouthDrv?.owned || []), ...(blinkDrv?.owned || [])])],   // auto-driven morphs (a manual UI set won't stick)
    params: P, setParams: (p) => Object.assign(P, p),
    setMouth: (a) => { const n = +a; if (isFinite(n)) mouthTgt = clamp01(n); },   // ignore a NaN/garbage amplitude -> mouth holds last target, never freezes open until reload
    setBlink: (v) => { manualBlink = v == null || v < 0 ? -1 : clamp01(v); },              // hold the lids (wink/squint/calibration); <0 = released (eyes open)
    blink() { blinking = BLINK_DUR; },                                                     // one blink — fired by a real drive only (speech onset / AI tag)
    update(dt, blinkOn = true) {
      if (mouthDrv) { mouth += (mouthTgt - mouth) * Math.min(1, dt * 18); mouthDrv.set(mouth * P.open); }
      if (!blinkDrv) { wasOn = blinkOn; return; }
      if (manualBlink >= 0) { blinkDrv.set(manualBlink); wasOn = blinkOn; return; }        // manual hold wins; the edge never fights it
      // #22 STRICT: no auto-timer. Lids stay OPEN unless blink() queued a one-shot envelope.
      if (blinkOn && blinking > 0) { blinking -= dt; blinkDrv.set(clamp01(Math.sin((1 - blinking / BLINK_DUR) * Math.PI))); }
      else if (wasOn && !blinkOn && blinking > 0) { blinkDrv.set(0); blinking = 0; }       // #32-style falling edge mid-blink: snap lids OPEN once, drop the queue
      else blinkDrv.set(0);                                                                // default: eyes open, no autonomous blink
      wasOn = blinkOn;
    },
  };
}
