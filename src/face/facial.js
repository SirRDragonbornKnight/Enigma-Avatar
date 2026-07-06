// facial.js — PER-CHANNEL resolution. MOUTH and BLINK each walk their OWN ladder and the
// results compose — a single shared ladder would gate blink behind the mouth tier (a lids-only
// rig could never blink, and a morph-mouth model with lid BONES would lose its blink entirely).
//   MOUTH:  VRM "aa" → named morph (widened dictionary) → jaw
//           bone → GEOMETRIC (head-anchored mouth-band classifier, then the legacy jaw-drop pick)
//   BLINK:  VRM "blink" → named morph → eyelid BONES (jaw not
//           required) → GEOMETRIC (mirrored eye-band morph — recovers unnamed blinks like shibahu's)
// `mode` means "does she have a MOUTH" (every consumer reads it that way); blinkMode answers blink.
// Lip-sync stays amplitude-driven (mouth opens on loudness) via setMouth().
import * as THREE from "three";
import { detectMouthMorph } from "../rig/mouth-geometry.js";
import { analyzeMorphGeometry } from "../rig/face-geometry.js"; // head-anchored eye/mouth band classifier

// Read-back guard shared by every ladder's setParams: a saved profiles.json blob arrives RAW
// (hand-edited and legacy files included), and P feeds per-frame face math — mirror the writer
// (facialTune): finite NUMBERS only, plus the two documented string axes.
function mergeParams(P, p) {
  for (const k in p || {}) {
    if (k === "jawAxis" || k === "lidAxis") {
      if (p[k] === "x" || p[k] === "y" || p[k] === "z") P[k] = p[k];
    } else {
      const n = +p[k];
      if (isFinite(n)) P[k] = n;
    }
  }
}

// Widened name dictionaries (ARKit camelCase, Unified Expressions, VRoid
// Fcl_*, CC V_*, MMD Japanese). No bare \bopen\b — it grabs eye_open etc.
const OPEN_RE =
  /jaw.?open|mouth.?open|mouthopen|(^|[._-])aa($|[._-])|vrc\.v_aa|viseme.?aa|fcl[._-]?mth[._-]?a$|(^|[._-])v[._-]open|あ/i;
const BLINK_RE = /blink|eyes?.?clos|wink|fcl[._-]?eye[._-]?close|まばたき|ウィンク/i;
const JAW_RE = /jaw/i;
const LID_RE = /eye.?lid|eyelid|(^|[._-])lid($|[._-])|eye.?flap/i; // eye.?flap: glados' aperture flaps ARE her eyelids
// EXPRESSION channels: smile + brows, each down its own ladder
// (VRM expression → named morph → face BONES → honest none). Dictionaries follow the same
// research base as OPEN_RE: ARKit, VRoid Fcl_*, CC, MMD, plus Daz-Genesis face-bone names.
// MOUTH-scope only: Fcl_ALL_Joy / Fcl_EYE_Joy / 笑い are eye-CLOSING morphs —
// a smile that owns them shuts the eyes and the blink channel can never reopen them.
const SMILE_RE = /smile|mouthsmile|fcl[._-]?mth[._-]?fun|grin|にこ/i;
// No bare 'surprised': it would capture Fcl_MTH/EYE/ALL_Surprised — mouth and eyes
// driven by the BROW channel, fighting lip-sync and blink every frame.
const BROW_UP_RE = /brow.?(up|raise|outer.?up|inner.?up)|fcl[._-]?brw[._-]?(fun|surprised)|眉.?上/i;
// Channel exclusion nets (belt+braces beyond the scoped REs): a smile hit must not be an eye
// morph ("EyeSmile"), a brow hit must not be an eye or mouth morph. eye(?![._-]?brow) keeps "EyeBrowUp".
const SMILE_EXCLUDE_RE = /(^|[._-])eye(?![._-]?brow)|wink|ウィンク|目/i;
const BROW_EXCLUDE_RE = /(^|[._-])eye(?![._-]?brow)|mouth|(^|[._-])mth|口|目/i;
const CORNER_RE = /lip.?corner|mouth.?corner|corner.?lip|nasolabial.?mouth/i; // Daz: l/rLipCorner + l/rNasolabialMouthCorner
const CHEEK_UP_RE = /cheek.?upper|upper.?cheek/i; // subtle assist: a real smile raises the upper cheeks
const BROW_BONE_RE = /brow/i;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const BLINK_DUR = 0.22; // one blink's close-open envelope (s) — fired ONLY by blink(), never autonomously

export function buildFacial(model, vrm = null, opts = {}) {
  // ---------- 1) VRM expression manager ----------
  if (vrm && vrm.expressionManager) {
    const em = vrm.expressionManager;
    const P = { open: 1.0 };
    let mouth = 0,
      mouthTgt = 0,
      blinking = 0,
      manualBlink = -1,
      wasOn = false;
    const set = (n, v) => {
      try {
        em.setValue(n, v);
      } catch {}
    };
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
    // drive the ACTUAL matched name, not a hardcoded casing: the probe is case-insensitive but
    // em.setValue is exact — a model exposing "MouthOpen" matched, then every set("mouthOpen")
    // silently no-oped AND blocked the 'aa' fallback the ladder believed it had beaten
    const actual = (n) => names.find((x) => x.toLowerCase() === n) || null;
    const mouthName = actual("mouthopen") || actual("jawopen") || "aa"; // best opener, else 'aa'
    // expression channels via the VRM presets (happy = smile, surprised = brow raise)
    const smileName = actual("happy");
    const browName = actual("surprised");
    // blink is an OPTIONAL preset: reporting blinkMode "vrm" without one was a false 'via'
    // (set("blink") is a silent no-op on a preset-less model — she'd never blink while the
    // load reply claimed the vrm tier)
    const blinkName = actual("blink");
    const exprCur = { smile: 0, brows: 0 },
      exprTgt = { smile: 0, brows: 0 };
    return {
      mode: "vrm",
      blinkMode: blinkName ? "vrm" : "none",
      exprMode: { smile: smileName ? "vrm" : "none", brows: browName ? "vrm" : "none" },
      info: `VRM expressions (mouth '${mouthName}'${blinkName ? ` / blink '${blinkName}'` : " / blink none"}${smileName ? ` / smile '${smileName}'` : ""})`,
      ownedMorphs: [], // VRM drives expressions, not raw morph indices
      params: P,
      setParams: (p) => mergeParams(P, p),
      setMouth: (a) => {
        const n = +a;
        if (isFinite(n)) mouthTgt = clamp01(n);
      }, // ignore a NaN/garbage amplitude -> mouth holds last target, never freezes open until reload
      setExpr(p = {}) {
        const via = {};
        for (const k of ["smile", "brows"]) {
          const raw = p[k];
          if (typeof raw !== "number" || !isFinite(raw)) continue; // NUMBERS only — +true/+"0.9" would coerce garbage into a jammed smile; anything else HOLDS
          exprTgt[k] = clamp01(raw);
          via[k] = (k === "smile" ? smileName : browName) ? "vrm" : "none";
        }
        return { applied: { ...exprTgt }, via }; // truth: what will be driven, and through which channel
      },
      setBlink: (v) => {
        manualBlink = v == null || v < 0 ? -1 : clamp01(v);
      }, // hold the lids; <0 = released (eyes open)
      blink() {
        blinking = BLINK_DUR;
      }, // one blink — fired by a real drive only
      update(dt, blinkOn = true) {
        mouth += (mouthTgt - mouth) * Math.min(1, dt * 18);
        set(mouthName, mouth * P.open);
        for (const k of ["smile", "brows"]) exprCur[k] += (exprTgt[k] - exprCur[k]) * Math.min(1, dt * 10);
        if (smileName) set(smileName, exprCur.smile);
        if (browName) set(browName, exprCur.brows);
        if (!blinkName) {
          wasOn = blinkOn;
          return;
        } // no blink preset on this VRM — honest none, nothing to drive
        if (manualBlink >= 0) {
          set(blinkName, manualBlink);
          wasOn = blinkOn;
          return;
        } // manual hold wins; don't let the edge fight it
        // #22 STRICT: no auto-timer. Lids stay OPEN unless blink() queued a one-shot.
        if (blinkOn && blinking > 0) {
          blinking -= dt;
          set(blinkName, clamp01(Math.sin((1 - blinking / BLINK_DUR) * Math.PI)));
        } else if (wasOn && !blinkOn && blinking > 0) {
          set(blinkName, 0);
          blinking = 0;
        } // #32 blinkOn falling edge mid-blink: snap lids OPEN once, drop the queue
        else set(blinkName, 0); // default: eyes open, no autonomous blink
        wasOn = blinkOn;
      },
    };
  }

  // ---------- collect morph targets + face bones ONCE (both channels shop here) ----------
  const meshes = [];
  model.traverse((o) => {
    if (o.isMesh && o.morphTargetDictionary && o.morphTargetInfluences) meshes.push(o);
  });
  const morphHits = (re) => {
    const hits = [];
    for (const m of meshes)
      for (const name in m.morphTargetDictionary)
        if (re.test(name)) hits.push({ mesh: m, idx: m.morphTargetDictionary[name], name });
    return hits;
  };
  const setMorph = (hits, v) => {
    for (const h of hits) h.mesh.morphTargetInfluences[h.idx] = v;
  };
  const hitsForIndex = (i) => {
    // index-addressed morph (unnamed models) — meshes that really have it (when morphAttributes exist, the index must be present; some loaders/fixtures carry influences only)
    const hits = [];
    model.traverse((o) => {
      if (
        o.isMesh &&
        o.morphTargetInfluences &&
        i < o.morphTargetInfluences.length &&
        (!o.geometry?.morphAttributes?.position || o.geometry.morphAttributes.position[i])
      )
        hits.push({ mesh: o, idx: i, name: `#${i}` });
    });
    return hits;
  };
  let jaw = null;
  const lids = [];
  model.traverse((o) => {
    if (!o.isBone) return;
    if (!jaw && JAW_RE.test(o.name)) jaw = o;
    if (LID_RE.test(o.name)) lids.push(o);
  });
  const P = {
    open: 1.0,
    jawAxis: "x",
    jawOpen: 0.32,
    lidAxis: "x",
    lidClose: 0.5,
    lidLower: -0.5,
    lidCorner: 0.3,
    // expression bone-driver amounts, as FRACTIONS of the mouth/brow spread (facialTune-able per rig)
    smileUp: 0.22, // lip corners rise
    smileOut: 0.1, // ...and widen
    cheekLift: 0.08, // upper cheeks assist (subtle)
    browLift: 0.12, // brow raise
  };
  for (const k in P) if (opts[k] != null) P[k] = opts[k]; // caller-supplied face params (also set live via facialTune/setParams) — face rigs differ wildly
  const _e = new THREE.Euler(),
    _q = new THREE.Quaternion();
  const applyAxis = (bone, rest, axis, ang) => {
    _e.set(axis === "x" ? ang : 0, axis === "y" ? ang : 0, axis === "z" ? ang : 0, "XYZ");
    bone.quaternion.copy(rest).multiply(_q.setFromEuler(_e));
  };
  let _geo = opts.geo || null,
    _geoTried = !!opts.geo; // the loader shares its load-time analysis — ONE scan per model; the lazy path is only a fallback when none was passed
  const geoAnalysis = () => {
    if (_geoTried) return _geo;
    _geoTried = true;
    if (!opts.headBone) return null;
    try {
      _geo = analyzeMorphGeometry(model, {
        head: opts.headBone,
        bodyUp: opts.bodyUp || new THREE.Vector3(0, 1, 0),
        forward: opts.forward || new THREE.Vector3(0, 0, 1),
      });
    } catch (e) {
      console.warn("[avatar] geometric face analysis failed:", e);
    }
    return _geo;
  };

  // ---------- MOUTH ladder: named morph → jaw bone → geometric ----------
  let mouthDrv = null; // { kind, info, set(v01), owned?:[indices], bones?:[names] }
  if (!mouthDrv) {
    let hits = morphHits(/jaw.?open|mouth.?open|mouthopen/i); // a dedicated jaw/mouth-open morph beats the "aa" viseme
    if (!hits.length) hits = morphHits(OPEN_RE);
    if (hits.length)
      mouthDrv = {
        kind: "morph",
        info: `mouth morphs [${hits.map((h) => h.name).join(",")}]`,
        owned: [...new Set(hits.map((h) => h.idx))],
        ownedPairs: hits.map((h) => h.mesh.uuid + ":" + h.idx), // mesh-AWARE ownership: bare indices would cross-match other meshes' morphs
        set: (v) => setMorph(hits, v),
      };
  }
  if (!mouthDrv && jaw) {
    const jawRest = jaw.quaternion.clone(); // open by rotating the jaw; axis/sign per rig → tunable (Mal0's Bip_Jaw opens on local X)
    mouthDrv = {
      kind: "bones",
      info: `jaw bone "${jaw.name}"`,
      bones: [jaw.name],
      set: (v) => applyAxis(jaw, jawRest, P.jawAxis, v * P.jawOpen),
    };
  }
  if (!mouthDrv) {
    // geometric: head-anchored mouth-band classifier first, then the legacy single-signal jaw-drop
    const g = geoAnalysis();
    const top = g && g.mouth && g.mouth.length ? g.mouth[0] : null;
    if (top != null && (g.byIndex.get(top)?.mouthScore ?? 0) > 0.3) {
      const hits = hitsForIndex(top);
      if (hits.length)
        mouthDrv = {
          kind: "morph-geom",
          info: `mouth morph #${top} (geometric mouth band, score ${g.byIndex.get(top).mouthScore.toFixed(2)})`,
          owned: [top],
          ownedPairs: hits.map((h) => h.mesh.uuid + ":" + h.idx),
          set: (v) => setMorph(hits, v),
        };
    }
    if (!mouthDrv) {
      const geo = detectMouthMorph(model, { headBone: opts.headBone, bodyUp: opts.bodyUp }); // head-anchored cut (hair/hats don't skew it)
      if (geo && geo.mesh && geo.index != null)
        mouthDrv = {
          kind: "morph-geom",
          info: `morph #${geo.index} on 1 mesh (geometric jaw-drop, score ${geo.score.toFixed(2)} of ${geo.morphs})`,
          owned: [geo.index],
          ownedPairs: [geo.mesh.uuid + ":" + geo.index],
          set: (v) => {
            geo.mesh.morphTargetInfluences[geo.index] = v;
          },
        };
    }
  }

  // ---------- BLINK ladder: named morph → eyelid BONES (no jaw needed — the glados fix) →
  // geometric mirrored eye-band morph (recovers unnamed blinks, shibahu's #13 class) ----------
  let blinkDrv = null;
  if (!blinkDrv) {
    const hits = morphHits(BLINK_RE);
    if (hits.length)
      blinkDrv = {
        kind: "morph",
        info: `blink morphs [${hits.map((h) => h.name).join(",")}]`,
        owned: [...new Set(hits.map((h) => h.idx))],
        ownedPairs: hits.map((h) => h.mesh.uuid + ":" + h.idx),
        set: (c) => setMorph(hits, c),
      };
  }
  if (!blinkDrv && lids.length) {
    // A natural blink closes the UPPER lids one way and the LOWER lids the OPPOSITE way so they
    // MEET; corners barely move. Uniform driving splayed lola's 16-lid rig — classify by name;
    // no upper/lower naming → uniform (all "u").
    const UP = /upper|top/i,
      LO = /lower|bottom|under/i,
      hasUL = lids.some((b) => UP.test(b.name) || LO.test(b.name));
    const lidCat = lids.map((b) => (!hasUL ? "u" : LO.test(b.name) ? "l" : UP.test(b.name) ? "u" : "c"));
    const lidRest = lids.map((b) => b.quaternion.clone());
    blinkDrv = {
      kind: "bones",
      info: `${lids.length} eyelid bone(s)${hasUL ? " (upper/lower split)" : ""}`,
      bones: lids.map((b) => b.name),
      set: (c) =>
        lids.forEach((b, i) =>
          applyAxis(
            b,
            lidRest[i],
            P.lidAxis,
            c * P.lidClose * (lidCat[i] === "l" ? P.lidLower : lidCat[i] === "c" ? P.lidCorner : 1)
          )
        ),
    };
  }
  if (!blinkDrv) {
    const g = geoAnalysis();
    const top = g && g.eyes && g.eyes.length ? g.eyes[0] : null;
    if (top != null && (g.byIndex.get(top)?.eyeScore ?? 0) > 0.35 && !(mouthDrv?.owned || []).includes(top)) {
      // never double-book the mouth morph as the blink
      const hits = hitsForIndex(top);
      if (hits.length)
        blinkDrv = {
          kind: "morph-geom",
          info: `blink morph #${top} (geometric eye band, score ${g.byIndex.get(top).eyeScore.toFixed(2)})`,
          owned: [top],
          ownedPairs: hits.map((h) => h.mesh.uuid + ":" + h.idx),
          set: (c) => setMorph(hits, c),
        };
    }
  }

  // ---------- EXPRESSION ladders: smile + brows — named morph → face BONES → none ----------
  // Bone drivers TRANSLATE face bones in parent-local space (offsets ride the head like the skin
  // does). Sides come from POSITION relative to the corner midpoint, never from name parsing.
  const pairOf = (h) => h.mesh.uuid + ":" + h.idx;
  const ownedPairs = new Set([...(mouthDrv?.ownedPairs || []), ...(blinkDrv?.ownedPairs || [])]); // mesh+index pairs — a bare index would wrongly match OTHER meshes' morphs
  let smileDrv = null,
    browDrv = null;
  {
    const hits = morphHits(SMILE_RE).filter((h) => !ownedPairs.has(pairOf(h)) && !SMILE_EXCLUDE_RE.test(h.name)); // never double-book lip-sync/blink morphs; never adopt an EYE morph as the smile
    if (hits.length)
      smileDrv = {
        kind: "morph",
        info: `smile morphs [${hits.map((h) => h.name).join(",")}]`,
        owned: [...new Set(hits.map((h) => h.idx))],
        ownedPairs: hits.map(pairOf), // the brow ladder excludes these — a composite "smile_brow_up" morph must have ONE owner, not two channels fighting it every update
        set: (v) => setMorph(hits, v),
      };
  }
  if (!smileDrv) {
    const corners = [];
    model.traverse((o) => {
      if (o.isBone && CORNER_RE.test(o.name)) corners.push(o);
    });
    if (corners.length >= 2) {
      model.updateWorldMatrix(true, true);
      const wp = corners.map((b) => b.getWorldPosition(new THREE.Vector3()));
      const mid = wp.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(1 / wp.length);
      let width = 0; // mouth width (max corner spread) = the scale every offset is a fraction of
      for (let i = 0; i < wp.length; i++)
        for (let j = i + 1; j < wp.length; j++) width = Math.max(width, wp[i].distanceTo(wp[j]));
      if (width > 1e-6) {
        const upW = new THREE.Vector3(0, 1, 0);
        const _pq = new THREE.Quaternion();
        const _wsv = new THREE.Vector3();
        // width is WORLD units but bone.position is parent-LOCAL — divide out the parent's world
        // scale or the offset is wrong by the normalization factor (BASE_H/h0 is never 1):
        // invisible smile on cm rigs, overshoot on m rigs.
        const localK = (b) => 1 / Math.max(1e-6, Math.abs(b.parent.getWorldScale(_wsv).x) || 1);
        const items = corners.map((b, i) => {
          const outW = wp[i].clone().sub(mid);
          outW.addScaledVector(upW, -outW.dot(upW)); // lateral only (toward THIS corner)
          if (outW.lengthSq() > 1e-12) outW.normalize();
          const inv = b.parent.getWorldQuaternion(_pq).clone().invert();
          return {
            bone: b,
            rest: b.position.clone(),
            upL: upW.clone().applyQuaternion(inv),
            outL: outW.applyQuaternion(inv),
            k: localK(b),
          };
        });
        const cheeks = [];
        model.traverse((o) => {
          if (o.isBone && CHEEK_UP_RE.test(o.name)) cheeks.push(o);
        });
        const cheekItems = cheeks.map((b) => ({
          bone: b,
          rest: b.position.clone(),
          upL: upW.clone().applyQuaternion(b.parent.getWorldQuaternion(_pq).clone().invert()),
          k: localK(b),
        }));
        smileDrv = {
          kind: "bones",
          info: `${corners.length} lip-corner bone(s)${cheekItems.length ? ` + ${cheekItems.length} cheek` : ""}`,
          bones: corners.map((b) => b.name),
          set: (v) => {
            for (const it of items)
              it.bone.position
                .copy(it.rest)
                .addScaledVector(it.upL, v * P.smileUp * width * it.k)
                .addScaledVector(it.outL, v * P.smileOut * width * it.k);
            for (const c of cheekItems)
              c.bone.position.copy(c.rest).addScaledVector(c.upL, v * P.cheekLift * width * c.k);
          },
        };
      }
    }
  }
  {
    const browBlocked = new Set([...ownedPairs, ...(smileDrv?.ownedPairs || [])]); // mouth+blink+smile-owned
    const hits = morphHits(BROW_UP_RE).filter((h) => !browBlocked.has(pairOf(h)) && !BROW_EXCLUDE_RE.test(h.name));
    if (hits.length)
      browDrv = {
        kind: "morph",
        info: `brow morphs [${hits.map((h) => h.name).join(",")}]`,
        owned: [...new Set(hits.map((h) => h.idx))],
        set: (v) => setMorph(hits, v),
      };
  }
  if (!browDrv) {
    const brows = [];
    model.traverse((o) => {
      if (o.isBone && BROW_BONE_RE.test(o.name)) brows.push(o);
    });
    if (brows.length) {
      model.updateWorldMatrix(true, true);
      // scale: brow spread (same trick as the mouth), falling back to inter-brow midpoint height sanity
      const wp = brows.map((b) => b.getWorldPosition(new THREE.Vector3()));
      let spread = 0;
      for (let i = 0; i < wp.length; i++)
        for (let j = i + 1; j < wp.length; j++) spread = Math.max(spread, wp[i].distanceTo(wp[j]));
      if (spread > 1e-6) {
        const upW = new THREE.Vector3(0, 1, 0);
        const _pq = new THREE.Quaternion();
        const _wsv = new THREE.Vector3();
        const items = brows.map((b) => ({
          bone: b,
          rest: b.position.clone(),
          upL: upW.clone().applyQuaternion(b.parent.getWorldQuaternion(_pq).clone().invert()),
          k: 1 / Math.max(1e-6, Math.abs(b.parent.getWorldScale(_wsv).x) || 1), // world spread -> parent-local units (same fix as the smile tier)
        }));
        browDrv = {
          kind: "bones",
          info: `${brows.length} brow bone(s)`,
          bones: brows.map((b) => b.name),
          set: (v) => {
            for (const it of items)
              it.bone.position.copy(it.rest).addScaledVector(it.upL, v * P.browLift * spread * it.k);
          },
        };
      }
    }
  }

  // ---------- compose ONE facade (shared mouth smoother + one-shot blink, whatever the channel kinds) ----------
  if (!mouthDrv && !blinkDrv && !smileDrv && !browDrv) {
    // No channel at all — ACKNOWLEDGE it, never fake one (speech still plays, the face stays still).
    // Same facade SHAPE as the live one (#8): every method present, just inert.
    return {
      mode: "none",
      blinkMode: "none",
      exprMode: { smile: "none", brows: "none" },
      info: "no mouth channel and no blink channel — no jaw/lids, no named or geometric face morphs (speech plays without lip-sync)",
      ownedMorphs: [],
      params: {},
      setParams() {},
      setMouth() {},
      setExpr() {
        return { applied: {}, via: { smile: "none", brows: "none" } }; // honest: no face to express with
      },
      setBlink() {},
      blink() {},
      update() {},
    };
  }
  let mouth = 0,
    mouthTgt = 0,
    blinking = 0,
    manualBlink = -1,
    wasOn = false;
  const exprCur = { smile: 0, brows: 0 },
    exprTgt = { smile: 0, brows: 0 };
  const exprDrv = { smile: smileDrv, brows: browDrv };
  return {
    mode: mouthDrv ? mouthDrv.kind : "none", // consumers read mode as "does she have a MOUTH"; blink reports separately now
    blinkMode: blinkDrv ? blinkDrv.kind : "none",
    exprMode: { smile: smileDrv ? smileDrv.kind : "none", brows: browDrv ? browDrv.kind : "none" },
    info:
      `mouth: ${mouthDrv ? mouthDrv.info : "NONE"} · blink: ${blinkDrv ? blinkDrv.info : "NONE"}` +
      ` · smile: ${smileDrv ? smileDrv.info : "NONE"} · brows: ${browDrv ? browDrv.info : "NONE"}`,
    ownedMorphs: [
      ...new Set([
        ...(mouthDrv?.owned || []),
        ...(blinkDrv?.owned || []),
        ...(smileDrv?.owned || []),
        ...(browDrv?.owned || []),
      ]),
    ], // auto-driven morphs (a manual UI set won't stick)
    params: P,
    setParams: (p) => Object.assign(P, p),
    setMouth: (a) => {
      const n = +a;
      if (isFinite(n)) mouthTgt = clamp01(n);
    }, // ignore a NaN/garbage amplitude -> mouth holds last target, never freezes open until reload
    setExpr(p = {}) {
      // drive smile/brows 0..1; absent/garbage fields hold their channel. Replies TRUTH: the
      // accepted targets + which ladder tier answers each channel ("morph"|"bones"|"none").
      const via = {};
      for (const k of ["smile", "brows"]) {
        const raw = p[k];
        if (typeof raw !== "number" || !isFinite(raw)) continue; // NUMBERS only — +true/+"0.9" would coerce garbage into a jammed smile; anything else HOLDS
        exprTgt[k] = clamp01(raw);
        via[k] = exprDrv[k] ? exprDrv[k].kind : "none";
      }
      return { applied: { ...exprTgt }, via };
    },
    setBlink: (v) => {
      manualBlink = v == null || v < 0 ? -1 : clamp01(v);
    }, // hold the lids (wink/squint/calibration); <0 = released (eyes open)
    blink() {
      blinking = BLINK_DUR;
    }, // one blink — fired by a real drive only (speech onset / AI tag)
    update(dt, blinkOn = true) {
      if (mouthDrv) {
        mouth += (mouthTgt - mouth) * Math.min(1, dt * 18);
        mouthDrv.set(mouth * P.open);
      }
      for (const k of ["smile", "brows"]) {
        if (!exprDrv[k]) continue;
        const prev = exprCur[k];
        exprCur[k] += (exprTgt[k] - exprCur[k]) * Math.min(1, dt * 10);
        if (exprCur[k] !== prev || exprCur[k] > 0) exprDrv[k].set(exprCur[k]);
      }
      if (!blinkDrv) {
        wasOn = blinkOn;
        return;
      }
      if (manualBlink >= 0) {
        blinkDrv.set(manualBlink);
        wasOn = blinkOn;
        return;
      } // manual hold wins; the edge never fights it
      // #22 STRICT: no auto-timer. Lids stay OPEN unless blink() queued a one-shot envelope.
      if (blinkOn && blinking > 0) {
        blinking -= dt;
        blinkDrv.set(clamp01(Math.sin((1 - blinking / BLINK_DUR) * Math.PI)));
      } else if (wasOn && !blinkOn && blinking > 0) {
        blinkDrv.set(0);
        blinking = 0;
      } // #32-style falling edge mid-blink: snap lids OPEN once, drop the queue
      else blinkDrv.set(0); // default: eyes open, no autonomous blink
      wasOn = blinkOn;
    },
  };
}
