// morphs.js — morph targets / blendshapes, the avatar's OWN toggles (engine carve S1-c, 2026-07-06).
//
// Third subsystem lifted out of the avatar.js closure into headless `src/engine/`. A model can ship
// shape keys (makiro: 19) — facial expressions, body toggles, "show/hide X". Exporters usually strip
// the names, so address BY INDEX (0..count-1). We drive only the PRIMARY morph group — the meshes
// that share the LARGEST morph count (the face/body carrying the shapes). For a normal rig (makiro:
// 4 body meshes x the SAME 19 morphs) that's every morph mesh; for a divergent rig it's just the
// main one, so a mesh that reuses an index for a DIFFERENT shape isn't distorted (audit). Saved per
// avatar.
//
// The store also HOLDS the load-time geometric morph classification (eye/mouth bands): the host
// computes it ONCE at load — rest pose, real facing (audit 2026-07-04: a lazy query-time scan
// classified whatever pose she happened to be holding) — and parks it here via setMorphGeo; query
// paths read it via morphGeoAnalysis (null = honestly unclassified).
//
// createMorphStore(deps) — everything impure is INJECTED, so the store runs headless:
//   getModel()        -> live THREE root (or null)
//   getFacial()       -> live facial facade (or null); .ownedMorphs = lip-sync/blink-driven indices
//   profileFor(key)   -> per-avatar profile object   ·   saveProfileSoon() -> debounced persist
//   getKey()          -> current model key           ·   setStatus(msg)    -> on-screen status line
export function createMorphStore({ getModel, getFacial, profileFor, saveProfileSoon, getKey, setStatus }) {
  let _morphGeo = null;
  const resetMorphGeo = () => {
    _morphGeo = null;
  };
  const setMorphGeo = (g) => {
    _morphGeo = g || null;
  };
  const morphGeoAnalysis = () => _morphGeo; // null = honestly unclassified (no head anchor / no morphs / analysis failed)

  function morphMeshes() {
    let maxN = 0;
    getModel()?.traverse((o) => {
      if (o.isMesh && o.morphTargetInfluences) maxN = Math.max(maxN, o.morphTargetInfluences.length);
    });
    const meshes = [];
    if (maxN)
      getModel()?.traverse((o) => {
        if (o.isMesh && o.morphTargetInfluences && o.morphTargetInfluences.length === maxN) meshes.push(o);
      });
    return { meshes, n: maxN };
  }

  function morphNameAt(i) {
    // best-effort name from the primary group's morphTargetDictionary (often absent)
    for (const o of morphMeshes().meshes) {
      if (!o.morphTargetDictionary) continue;
      for (const k in o.morphTargetDictionary) if (o.morphTargetDictionary[k] === i) return k;
    }
    return null;
  }

  function allMorphsInfo() {
    const { meshes, n } = morphMeshes();
    if (!n) return [];
    const cur = meshes[0]?.morphTargetInfluences || [];
    const owned = new Set(getFacial()?.ownedMorphs || []); // morphs the lip-sync/blink layer auto-drives → a manual set won't hold (flag them so the UI explains it)
    const g = morphGeoAnalysis();
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = g?.byIndex?.get(i);
      const region = !s
        ? null
        : s.mouthScore > s.eyeScore && s.mouthScore > 0.05
          ? "mouth"
          : s.eyeScore > 0.05
            ? "eyes"
            : null;
      out.push({
        index: i,
        name: morphNameAt(i),
        value: +(cur[i] || 0),
        auto: owned.has(i),
        region, // geometric band guess ("mouth"|"eyes"|null) — a hunting driver starts HERE, not at 42 blind probes
        score: s ? +Math.max(s.mouthScore, s.eyeScore).toFixed(2) : 0,
      });
    }
    return out;
  }

  function setMorphValue(i, v) {
    const raw = v == null ? 1 : +v;
    if (!isFinite(raw)) return 0; // Math.max/min are NaN-transparent — a garbage bus value would hit the GPU AND be persisted
    const amt = Math.max(0, Math.min(1, raw));
    let nHit = 0;
    for (const o of morphMeshes().meshes)
      if (i < o.morphTargetInfluences.length) {
        o.morphTargetInfluences[i] = amt;
        nHit++;
      }
    const p = profileFor(getKey());
    p.morphs = p.morphs || {};
    if (amt <= 0) delete p.morphs[i];
    else p.morphs[i] = amt; // default (0) → don't persist
    saveProfileSoon();
    setStatus(`morph #${i}${morphNameAt(i) ? " (" + morphNameAt(i) + ")" : ""} -> ${amt.toFixed(2)}; ${nHit} mesh`);
    return nHit;
  }

  function applyMorphs() {
    const m = profileFor(getKey()).morphs;
    if (!m) return;
    const { meshes } = morphMeshes();
    for (const k in m) {
      const i = +k,
        val = +m[k];
      if (!isFinite(val)) continue;
      const amt = val < 0 ? 0 : val > 1 ? 1 : val;
      for (const o of meshes) if (i < o.morphTargetInfluences.length) o.morphTargetInfluences[i] = amt;
    } // VALIDATE on read-back: a garbage/legacy profiles.json value must not reach the GPU (the writer guards; the load path must too)
  }

  return {
    morphMeshes,
    morphNameAt,
    allMorphsInfo,
    setMorphValue,
    applyMorphs,
    resetMorphGeo,
    setMorphGeo,
    morphGeoAnalysis,
  };
}
