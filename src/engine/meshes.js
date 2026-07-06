// meshes.js — mesh VISIBILITY + named OUTFIT presets.
//
// A model bundles multiple meshes (e.g. 2 shirts /
// shorts / a nude body); address them by INDEX in traversal order — names are unreliable — and
// toggle visibility to pick a variant. The hidden set persists per avatar; an OUTFIT is just a
// hidden-index list under a name.
//
// INDEX AUTHORITY: the mesh list is cached in PRISTINE FILE ORDER at load, BEFORE any hierarchy
// surgery/adoption. hiddenMeshes/meshLabels/colors are keyed by INDEX — live traversal order
// CHANGES when bones are reparented (skin-weight adoption shifts traversal order, so a saved
// index list keyed to live order would start hiding the wrong parts).
//
// createMeshStore(deps) — everything impure is INJECTED (the closure-thunk pattern the control
// plane and profile store use), so the store runs headless under node --test:
//   getModel()            -> live THREE root (or null); .traverse() is all the store needs
//   profileFor(key)       -> per-avatar profile object (engine/profiles.js)
//   saveProfileSoon()     -> debounced persist
//   getKey()              -> current model key
//   onSilhouetteChange()  -> visibility changed what RENDERS: the host drops its hit mask and
//                            re-measures footprint + dims (shadow/walls/capsule/grab box)
//   setStatus(msg)        -> transient on-screen status line
export function createMeshStore({ getModel, profileFor, saveProfileSoon, getKey, onSilhouetteChange, setStatus }) {
  let _meshList = null; // pristine-order cache; null → live traversal fallback (no model loaded yet)

  function cacheMeshList() {
    _meshList = [];
    getModel()?.traverse((o) => {
      if (o.isMesh) _meshList.push({ mesh: o, name: o.name || null });
    });
  }
  function clearMeshList() {
    _meshList = null;
  }

  function allMeshesInfo() {
    if (_meshList) return _meshList.filter((e) => e.mesh && e.mesh.parent !== null); // drop disposed strays, keep order
    const out = [];
    getModel()?.traverse((o) => {
      if (o.isMesh) out.push({ mesh: o, name: o.name || null });
    });
    return out;
  }

  function setMeshVisible(i, on) {
    const arr = allMeshesInfo();
    const it = arr[i];
    if (!it) return 0;
    it.mesh.visible = !!on;
    const p = profileFor(getKey());
    const hid = new Set(p.hiddenMeshes || []);
    if (on) hid.delete(i);
    else hid.add(i);
    p.hiddenMeshes = [...hid].sort((a, b) => a - b);
    saveProfileSoon();
    onSilhouetteChange();
    setStatus(`mesh #${i}${it.name ? " (" + it.name + ")" : ""} -> ${on ? "shown" : "hidden"}`);
    return 1;
  }

  function applyMeshVisibility() {
    const hid = profileFor(getKey()).hiddenMeshes;
    if (!hid || !hid.length) return;
    const arr = allMeshesInfo();
    for (const i of hid) if (arr[i]) arr[i].mesh.visible = false;
  }

  // OUTFITS — named mesh-visibility presets per model:
  // one-click looks built from the parts a model SHIPS (dressed / undressed / armor-off …). Wearing
  // one shows EVERYTHING first then hides the preset's set (applyMeshVisibility only hides — a wear
  // must also restore parts the previous look had off).
  function outfitNames() {
    return Object.keys(profileFor(getKey()).outfits || {});
  }
  function saveOutfit(name) {
    const s = String(name || "").trim();
    if (!s) return null;
    const p = profileFor(getKey());
    p.outfits = p.outfits || {};
    p.outfits[s] = [...(p.hiddenMeshes || [])];
    saveProfileSoon();
    setStatus(`outfit saved: ${s}`);
    return outfitNames();
  }
  function wearOutfit(name) {
    const p = profileFor(getKey()),
      o = (p.outfits || {})[String(name || "").trim()];
    if (!o) {
      setStatus(`no outfit "${name}"`);
      return false;
    }
    const hid = new Set(o.map((i) => +i).filter((i) => Number.isInteger(i) && i >= 0));
    const arr = allMeshesInfo();
    for (let i = 0; i < arr.length; i++) arr[i].mesh.visible = !hid.has(i);
    p.hiddenMeshes = [...hid].sort((a, b) => a - b);
    saveProfileSoon();
    onSilhouetteChange();
    setStatus(`outfit: ${name}`);
    return true;
  }
  function deleteOutfit(name) {
    const p = profileFor(getKey());
    if (p.outfits) delete p.outfits[String(name || "").trim()];
    saveProfileSoon();
    return outfitNames();
  }

  return {
    cacheMeshList,
    clearMeshList,
    allMeshesInfo,
    setMeshVisible,
    applyMeshVisibility,
    outfitNames,
    saveOutfit,
    wearOutfit,
    deleteOutfit,
  };
}
