// geom_face.js — classify UNNAMED morph targets by WHERE they displace the head: eye-region
// (blink candidates) / mouth-region (talk candidates) / other, by geometry alone, never names.
//
// WHY: Sketchfab rips strip morph names (face audit: 0/15 library models kept any), so name
// dictionaries never fire, and geom_mouth.js's single "drops head verts" score both noise-gates
// on expression-rich faces (shibahu: most of her morphs displace downward) and can't see blinks
// at all. This is the FACIAL v2 geometric tier (TODO item ②): per morph, find the displacement
// SUPPORT (verts whose world delta beats a floor), take its centroid + mean direction in a frame
// ANCHORED ON THE HEAD BONE, and score against anatomical bands — eyes ride a horizontal band
// ~62% up the head-bone→head-top span as two mirrored lateral lobes (or one-sided with a
// mirrored TWIN morph) moving DOWN or shrinking vertically; mouths sit ~25% up, near the
// midline, opening downward. Pure module: no DOM, no engine imports, silent (facial.js owns the
// verdict log); callers rank the returned 0..1 per-channel scores and may override any band.
import * as THREE from "three";

// Bands as FRACTIONS of the head span (head-bone origin → topmost vertex along bodyUp). Rigs
// disagree on where "head" sits (neck-top vs skull-centre), so every knob is overridable via
// opts; the ±band half-width absorbs that slack plus hair/hat span error.
const DEF = { eyeFrac: 0.62, mouthFrac: 0.25, band: 0.18, supportRel: 0.1, minScore: 0.05 };
const SPLIT = 0.04;       // ×span: midline dead-zone when splitting support into L/R lobes
const LOBE_MIN = 0.07;    // ×span: a true lateral lobe centres at least this far off-midline
const LOBE_BAL = 0.3;     // min L/R weight balance to call "two lobes" (one morph, both eyes)
const CENTER_MAX = 0.2;   // real twin lobes leave a weight GAP at the midline — a single
                          // centered blob also has wL≈wR; the gap is what tells them apart
const TWIN = { dh: 0.1, dx: 0.1, ratio: 3, sided: 0.7 };   // wink-pair gates (×span / energy)
const MID_SCALE = 0.2;    // ×span: mouth midline-closeness falloff
const MIRROR_PEN = 0.55;  // un-mirrored eye-band morphs stay candidates (merged single-strip
                          // lids exist), they just rank under properly lobed/twinned ones

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const vec = (v, x, y, z) => (v && v.isVector3 ? v.clone() : new THREE.Vector3(x, y, z));
const perp = (u) => {     // any unit vector ⊥ u — used when the caller's forward ∥ up
  const t = Math.abs(u.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  return t.addScaledVector(u, -t.dot(u)).normalize();
};

export function analyzeMorphGeometry(model, opts = {}) {
  const out = { morphs: [], eyes: [], mouth: [], byIndex: new Map() };
  const head = opts.head || null;
  // No head bone = no anchor frame: report "nothing classifiable" so the caller falls back to
  // other ladder tiers (names/clips/bone poses) instead of us guessing a frame off the bbox.
  if (!model || !head || !head.isObject3D) return out;
  model.updateWorldMatrix(true, true);   // bind-pose world transforms; skinning never needed
  const p = {
    eyeFrac: opts.eyeFrac ?? DEF.eyeFrac, mouthFrac: opts.mouthFrac ?? DEF.mouthFrac,
    band: opts.band ?? DEF.band, supportRel: opts.supportRel ?? DEF.supportRel,
    minScore: opts.minScore ?? DEF.minScore,
  };
  // Head-anchored orthonormal frame from the CALLER's body axes — the rig build already knows
  // bodyUp/forward, and models bind in any pose, so orientation is never re-derived here.
  const up = vec(opts.bodyUp, 0, 1, 0).normalize();
  let fwd = vec(opts.forward, 0, 0, 1);
  fwd.addScaledVector(up, -fwd.dot(up)).normalize();   // orthogonalize against up
  if (fwd.lengthSq() < 0.5) fwd = perp(up);            // degenerate forward: bands only need up, the midline just needs SOME right axis
  const right = new THREE.Vector3().crossVectors(up, fwd);
  const origin = head.getWorldPosition(new THREE.Vector3());

  // Head span over ALL meshes, not just morphed ones: morph meshes can be tiny patches
  // (teeth/lash strips) whose own extent would garbage the bands; the model's topmost vertex
  // above the head bone is the scalp/hair line on anything remotely humanoid.
  const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _b = new THREE.Vector3();
  let span = 0;
  model.traverse((o) => {
    const pos = o.isMesh ? o.geometry?.attributes?.position : null;
    if (!pos) return;
    const st = Math.max(1, Math.floor(pos.count / 4000));   // one-shot load-time scan — sampling is fine
    for (let i = 0; i < pos.count; i += st) {
      const h = _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).sub(origin).dot(up);
      if (h > span) span = h;
    }
  });
  if (!(span > 1e-6)) return out;   // nothing above the head bone → bands are meaningless

  // Pass 1: one support-statistics record per (mesh, morph index).
  const recs = [];
  model.traverse((o) => {
    const g = o.isMesh ? o.geometry : null;
    const targets = g?.morphAttributes?.position;
    const pos = g?.attributes?.position;
    if (!targets?.length || !pos) return;
    if (targets.some((t) => !t || t.count !== pos.count)) return;   // foreign buffer layout → trust nothing in this mesh
    const rel = g.morphTargetsRelative !== false;   // GLTFLoader authors DELTAS; legacy absolute targets get the base subtracted
    const lin = new THREE.Matrix3().setFromMatrix4(o.matrixWorld);  // NOT the normal matrix — deltas are displacements
    const st = Math.max(1, Math.floor(pos.count / 4000));
    const idxs = [], X = [], H = [], Z = [];        // sampled base verts in head-frame coords, computed once for every morph
    for (let i = 0; i < pos.count; i += st) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).sub(origin);
      idxs.push(i); X.push(_v.dot(right)); H.push(_v.dot(up)); Z.push(_v.dot(fwd));
    }
    const delta = (t, k) => {                       // world-space displacement of sample k
      _d.fromBufferAttribute(t, idxs[k]);
      if (!rel) _d.sub(_b.fromBufferAttribute(pos, idxs[k]));
      return _d.applyMatrix3(lin);
    };
    for (let mi = 0; mi < targets.length; mi++) {
      const t = targets[mi];
      let maxLen = 0;
      for (let k = 0; k < idxs.length; k++) maxLen = Math.max(maxLen, delta(t, k).length());
      const r = { mesh: o, meshName: o.name || "", index: mi, support: 0, M: 0, cx: 0, ch: 0,
                  cz: 0, dir: new THREE.Vector3(), wL: 0, wR: 0, wC: 0, sxL: 0, sxR: 0,
                  bandEye: 0, bandMouth: 0, Shh: 0, Su: 0, Shu: 0, down: 0, conv: 0, dom: 0,
                  mirrored: false, eyeScore: 0, mouthScore: 0 };
      recs.push(r);
      if (maxLen <= 0) continue;   // zero-support morph: keep the entry so callers see it, scores stay 0
      // Support floor relative to the morph's OWN peak — separates true support from the
      // compression micro-noise rips smear across the whole mesh.
      const floor = Math.max(maxLen * p.supportRel, span * 1e-6), split = SPLIT * span;
      for (let k = 0; k < idxs.length; k++) {
        const d = delta(t, k), w = d.length();
        if (w <= floor) continue;
        const x = X[k], h = H[k], hn = h / span, du = d.dot(up);
        r.support++; r.M += w; r.cx += w * x; r.ch += w * h; r.cz += w * Z[k]; r.dir.add(d);
        r.Shh += w * h * h; r.Su += w * du; r.Shu += w * h * du;
        if (x < -split) { r.wL += w; r.sxL += w * x; } else if (x > split) { r.wR += w; r.sxR += w * x; } else { r.wC += w; }
        if (Math.abs(hn - p.eyeFrac) <= p.band) r.bandEye += w;
        if (Math.abs(hn - p.mouthFrac) <= p.band) r.bandMouth += w;
      }
      if (!r.M) continue;
      r.cx /= r.M; r.ch /= r.M; r.cz /= r.M; r.bandEye /= r.M; r.bandMouth /= r.M;
      // Vertical character: DOWN = coherent net downward motion (lid drop / jaw open). CONV =
      // negative height↔vertical-delta covariance = vertical SHRINK — a both-lids blink nets to
      // ~zero mean direction, covariance is what still catches it. Both correlation-ish 0..1.
      r.down = clamp01(-r.dir.dot(up) / r.M);
      const mu = r.Su / r.M, cov = r.Shu / r.M - r.ch * mu, varH = Math.max(0, r.Shh / r.M - r.ch * r.ch);
      r.conv = clamp01(-cov / (Math.sqrt(varH) * (r.M / r.support) + 1e-12));
      r.dom = r.wL > TWIN.sided * r.M ? -1 : r.wR > TWIN.sided * r.M ? 1 : 0;   // one-sided (wink half)?
      if (r.wL > 0 && r.wR > 0 && Math.min(r.wL, r.wR) / Math.max(r.wL, r.wR) >= LOBE_BAL
          && r.wC / r.M < CENTER_MAX
          && Math.min(-r.sxL / r.wL, r.sxR / r.wR) >= LOBE_MIN * span) r.mirrored = true;
    }
  });

  // Pass 2: a one-sided morph earns "mirrored" through a TWIN — another morph on the SAME mesh
  // with matching height, a mirrored lateral centroid and comparable energy (L/R wink pairs).
  // Same-mesh only: synced cross-mesh groups duplicate IN PLACE, they don't mirror.
  for (let a = 0; a < recs.length; a++) {
    for (let b = a + 1; b < recs.length; b++) {
      const A = recs[a], B = recs[b];
      if (A.mesh !== B.mesh || !A.dom || !B.dom || A.dom === B.dom) continue;
      if (Math.abs(A.ch - B.ch) > TWIN.dh * span) continue;
      if (Math.abs(Math.abs(A.cx) - Math.abs(B.cx)) > TWIN.dx * span) continue;
      if (Math.min(Math.abs(A.cx), Math.abs(B.cx)) < LOBE_MIN * span) continue;
      if (Math.max(A.M, B.M) > TWIN.ratio * Math.min(A.M, B.M)) continue;
      A.mirrored = B.mirrored = true;
    }
  }

  // Pass 3: score + publish. Per-mesh entries stay raw for disambiguation; byIndex merges
  // same-index morphs across meshes by MAX (synced groups: face/lash/brow meshes share index
  // order, and the strongest mesh is the one worth trusting).
  for (const r of recs) {
    if (r.M > 0) {
      r.eyeScore = r.bandEye * (0.5 + 0.5 * Math.max(r.down, r.conv)) * (r.mirrored ? 1 : MIRROR_PEN);
      const mid = 1 - Math.min(1, Math.abs(r.cx) / (MID_SCALE * span));
      r.mouthScore = r.bandMouth * (0.5 + 0.5 * r.down) * (0.4 + 0.6 * mid);
    }
    const dl = r.dir.length();
    out.morphs.push({
      index: r.index, meshName: r.meshName, support: r.support,   // support = SAMPLED support vert count
      centroidLocal: [r.cx, r.ch, r.cz],                          // head-frame [right, up, forward], world units
      dir: dl > 0 ? [r.dir.dot(right) / dl, r.dir.dot(up) / dl, r.dir.dot(fwd) / dl] : [0, 0, 0],
      eyeScore: r.eyeScore, mouthScore: r.mouthScore, mirrored: r.mirrored,
    });
    const s = out.byIndex.get(r.index);
    if (!s) out.byIndex.set(r.index, { eyeScore: r.eyeScore, mouthScore: r.mouthScore });
    else { s.eyeScore = Math.max(s.eyeScore, r.eyeScore); s.mouthScore = Math.max(s.mouthScore, r.mouthScore); }
  }
  const rank = (key) => [...out.byIndex.entries()]
    .filter(([, s]) => s[key] > p.minScore)                       // sub-noise candidates never reach callers
    .sort((a, b) => b[1][key] - a[1][key] || a[0] - b[0])         // score desc, index tiebreak for determinism
    .map(([i]) => i);
  out.eyes = rank("eyeScore");
  out.mouth = rank("mouthScore");
  return out;
}
