// ui.js — the avatar's right-click menu + Settings dialog (all the DOM construction).
// Pulled out of avatar.js so the engine orchestrator isn't buried under ~280 lines of
// element-building. It owns NO engine state; everything it touches comes through `api`
// (getters for live state, action functions, and a `flags` accessor object for the
// boolean toggles whose source of truth stays in avatar.js).
//
// createUI(api) → { showMenu, hideMenu, showSettings, hideSettings, rebuildMenu,
//                   refreshModelList, isOpen, isMenuOpen, isSettingsOpen, containsEvent }
export function createUI(api) {
  const { THREE, BASE_H, rig, avatarIPC, setStatus, baseName, kindOf, profileFor, modelMaterials, flags } = api;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const EMOTES = ["happy", "talk", "wag", "nod", "alert", "sad", "shake"];

  let menuShown = false, settingsShown = false;

  // built-ins + user models from models.json
  const BUILTIN_MODELS = api.builtinModels;
  let MODEL_LIST = BUILTIN_MODELS.slice();
  function refreshModelList() {
    return fetch("./models.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const seen = new Set(BUILTIN_MODELS.map((m) => m.url));
        const extra = (j?.models || []).filter((m) => m?.url && !seen.has(m.url)).map((m) => ({ id: m.id, url: m.url, label: m.label || m.id }));
        MODEL_LIST = BUILTIN_MODELS.concat(extra);
        if (menuShown) rebuildMenu();
      })
      .catch(() => {});
  }
  // Import a new avatar. Electron: native dialog → copy into models/ + register
  // (.glb/.gltf/.vrm/.fbx and .unitypackage via import_unitypackage.py). Browser: file picker.
  async function addModel() {
    hideMenu();
    if (avatarIPC?.importModel) {
      setStatus("importing model…");
      try {
        const res = await avatarIPC.importModel();
        if (!res) { setStatus("import cancelled"); return; }
        if (res.error) { setStatus("import failed: " + res.error); return; }
        await refreshModelList();
        api.loadModel(res.url, res.label);
      } catch (e) { setStatus("import failed: " + (e?.message || e)); }
    } else {
      document.getElementById("file")?.click();
    }
  }
  // Attach a prop/accessory. Electron: native picker → copied into props/. Browser: blob.
  let _propCategory = "prop";
  async function addAttachment(category) {
    _propCategory = category; hideMenu();
    if (avatarIPC?.importProp) {
      setStatus(`importing ${category}…`);
      try {
        const res = await avatarIPC.importProp();
        if (!res) { setStatus("import cancelled"); return; }
        if (res.error) { setStatus("import failed: " + res.error); return; }
        api.attachMesh(res.url, { category });
      } catch (e) { setStatus("import failed: " + (e?.message || e)); }
    } else {
      _propInput.click();
    }
  }
  const _propInput = document.createElement("input");
  _propInput.type = "file"; _propInput.accept = ".glb,.gltf,.vrm,.fbx"; _propInput.style.display = "none";
  document.body.appendChild(_propInput);
  _propInput.addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) api.attachMesh(URL.createObjectURL(f), { category: _propCategory, kind: kindOf(f.name) }); });

  // A plain, OS-style context menu (no glass / emoji / switches).
  const MENU_CSS =
    "position:fixed;z-index:50;min-width:188px;background:rgba(38,38,41,.98);border:1px solid rgba(255,255,255,.13);" +
    "border-radius:8px;padding:4px;box-shadow:0 9px 28px rgba(0,0,0,.5);font:13px/1.25 'Segoe UI',system-ui,sans-serif;color:#f0f0f0;user-select:none;";
  const menu = document.createElement("div");
  menu.id = "avmenu"; menu.style.cssText = MENU_CSS + "display:none;";
  document.body.appendChild(menu);

  const menuSep = () => { const d = document.createElement("div"); d.style.cssText = "height:1px;background:rgba(255,255,255,.1);margin:4px 8px;"; return d; };
  const menuRow = (label, o = {}) => {
    const d = document.createElement("div");
    d.style.cssText = "position:relative;display:flex;align-items:center;padding:6px 12px 6px 28px;border-radius:5px;white-space:nowrap;cursor:default;" + (o.danger ? "color:#ff8a8a;" : "");
    if (o.dot) { const m = document.createElement("span"); m.textContent = "●"; m.style.cssText = "position:absolute;left:11px;font-size:9px;color:#6fc3ff;"; d.appendChild(m); }
    else if (o.check) { const m = document.createElement("span"); m.textContent = "✓"; m.style.cssText = "position:absolute;left:10px;"; d.appendChild(m); }
    const lab = document.createElement("span"); lab.textContent = label; lab.style.flex = "1"; d.appendChild(lab);
    if (o.accel) { const a = document.createElement("span"); a.textContent = o.accel; a.style.cssText = "opacity:.42;font-size:11px;padding-left:24px;"; d.appendChild(a); }
    if (o.arrow) { const a = document.createElement("span"); a.textContent = "❯"; a.style.cssText = "opacity:.5;font-size:10px;padding-left:18px;"; d.appendChild(a); }
    d.onmouseenter = () => (d.style.background = "rgba(255,255,255,.13)");
    d.onmouseleave = () => (d.style.background = "transparent");
    if (o.onClick) d.onclick = (ev) => { ev.stopPropagation(); o.onClick(); };
    return d;
  };
  const submenu = (label, items) => {
    const wrap = document.createElement("div"); wrap.style.position = "relative";
    wrap.appendChild(menuRow(label, { arrow: true }));
    const fly = document.createElement("div"); fly.style.cssText = MENU_CSS + "display:none;position:absolute;top:-5px;left:100%;margin-left:3px;";
    for (const it of items) fly.appendChild(menuRow(it.label, { check: it.check, onClick: it.onClick }));
    wrap.appendChild(fly);
    let t;
    wrap.onmouseenter = () => {
      clearTimeout(t); fly.style.display = "block";
      fly.style.left = "100%"; fly.style.right = "auto"; fly.style.marginLeft = "3px"; fly.style.marginRight = "0";
      const r = fly.getBoundingClientRect();
      if (r.right > innerWidth - 4) { fly.style.left = "auto"; fly.style.right = "100%"; fly.style.marginLeft = "0"; fly.style.marginRight = "3px"; }
    };
    wrap.onmouseleave = () => { t = setTimeout(() => (fly.style.display = "none"), 130); };
    return wrap;
  };

  // --- Settings dialog (normal OS form controls) ------------------------------
  const settings = document.createElement("div");
  settings.id = "avsettings";
  settings.style.cssText =
    "position:fixed;z-index:60;display:none;flex-direction:column;width:268px;max-height:92vh;background:rgba(38,38,41,.99);border:1px solid rgba(255,255,255,.14);" +
    "border-radius:10px;box-shadow:0 16px 46px rgba(0,0,0,.55);font:13px/1.35 'Segoe UI',system-ui,sans-serif;color:#eee;user-select:none;";
  document.body.appendChild(settings);

  const sRow = (label, control) => { const r = document.createElement("div"); r.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;"; const l = document.createElement("span"); l.textContent = label; l.style.opacity = ".9"; r.append(l, control); return r; };
  const sCheck = (label, on, set) => { const r = document.createElement("label"); r.style.cssText = "display:flex;align-items:center;gap:9px;padding:6px 0;cursor:pointer;"; const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = on; cb.onchange = (e) => { e.stopPropagation(); set(cb.checked); }; const t = document.createElement("span"); t.textContent = label; r.append(cb, t); return r; };
  let _colorsOpen = false;   // remember the Colors section's expand state across re-opens
  function buildSettings() {
    const curKey = api.getCurKey();
    settings.innerHTML = "";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.1);flex-shrink:0;";
    head.innerHTML = `<span style="font-weight:600">Avatar Settings</span>`;
    const x = document.createElement("button"); x.textContent = "✕"; x.style.cssText = "border:0;background:transparent;color:#bbb;font-size:14px;line-height:1;cursor:pointer;padding:2px 4px;";
    x.onclick = (e) => { e.stopPropagation(); hideSettings(); };
    head.appendChild(x); settings.appendChild(head);
    const body = document.createElement("div"); body.style.cssText = "padding:8px 14px 14px;overflow-y:auto;overflow-x:hidden;min-height:0;flex:1 1 auto;"; settings.appendChild(body);

    const sel = document.createElement("select");
    for (const m of MODEL_LIST) { const o = document.createElement("option"); o.value = m.url; o.textContent = m.label; if (m.url === curKey) o.selected = true; sel.appendChild(o); }
    sel.onchange = (e) => { e.stopPropagation(); const m = MODEL_LIST.find((x) => x.url === sel.value); api.loadModel(sel.value, m?.label); };
    body.appendChild(sRow("Model", sel));

    const sizeScale = api.getSizeScale();
    const sz = document.createElement("input"); sz.type = "range"; sz.min = "0.05"; sz.max = "5"; sz.step = "0.05"; sz.value = String(sizeScale); sz.style.flex = "1";
    const szv = document.createElement("span"); szv.textContent = sizeScale.toFixed(2) + "×"; szv.style.cssText = "opacity:.6;font-size:11px;min-width:36px;text-align:right;";
    sz.oninput = (e) => { e.stopPropagation(); api.applySize(parseFloat(sz.value)); szv.textContent = api.getSizeScale().toFixed(2) + "×"; };
    const szRow = sRow("Size", sz); szRow.appendChild(szv); body.appendChild(szRow);

    // Hair/tail physics — tuned live and saved into this avatar's profile.
    const sp = () => profileFor(curKey).spring || {};
    const springSlider = (label, key, min, max, step, dflt) => {
      const r = document.createElement("input"); r.type = "range"; r.min = min; r.max = max; r.step = step;
      r.value = String(sp()[key] ?? dflt); r.style.flex = "1";
      r.oninput = (e) => { e.stopPropagation(); api.springTune({ [key]: parseFloat(r.value) }); };
      body.appendChild(sRow(label, r));
    };
    springSlider("Hair stiffness", "stiffness", "0.04", "0.5", "0.01", 0.14);
    springSlider("Hair damping", "drag", "0.1", "0.95", "0.01", 0.5);
    springSlider("Hair gravity", "gravity", "-6", "0", "0.1", -3.0);
    springSlider("Hair breeze", "breeze", "0", "0.6", "0.02", 0.16);

    // Colors — tint each material (the color multiplies its texture); saved per avatar.
    const mats = modelMaterials();
    if (mats.size) {
      const cr = document.createElement("div"); cr.style.cssText = "height:1px;background:rgba(255,255,255,.1);margin:8px 0;"; body.appendChild(cr);
      // Collapsible — a model like grace_howard has many materials; collapse by default
      // when there are more than a handful. The expand state persists across re-opens.
      const open0 = _colorsOpen || mats.size <= 6;
      const ch = document.createElement("div");
      ch.style.cssText = "opacity:.7;font-size:11px;margin-bottom:2px;cursor:pointer;display:flex;align-items:center;gap:6px;";
      const caret = document.createElement("span"); caret.textContent = open0 ? "▾" : "▸"; caret.style.fontSize = "9px";
      const lbl = document.createElement("span"); lbl.textContent = `Colors — tint per part (${mats.size})`;
      ch.append(caret, lbl); body.appendChild(ch);
      const colorBox = document.createElement("div"); colorBox.style.display = open0 ? "block" : "none"; body.appendChild(colorBox);
      ch.onclick = (e) => { e.stopPropagation(); _colorsOpen = colorBox.style.display === "none"; colorBox.style.display = _colorsOpen ? "block" : "none"; caret.textContent = _colorsOpen ? "▾" : "▸"; };
      const saved = profileFor(curKey).colors || {};
      const savedHue = profileFor(curKey).hue || {};
      for (const [name, m] of mats) {
        const c = document.createElement("input"); c.type = "color";
        c.value = saved[name] || ("#" + (m.color ? m.color.getHexString(THREE.SRGBColorSpace) : "ffffff"));
        c.oninput = (e) => { e.stopPropagation(); api.recolor(name, c.value); };
        const h = document.createElement("input"); h.type = "range"; h.min = "0"; h.max = "360"; h.step = "5"; h.value = String(savedHue[name] || 0); h.title = "hue rotate"; h.style.flex = "1";
        h.oninput = (e) => { e.stopPropagation(); api.hueShift(name, parseFloat(h.value)); };
        const wrap = document.createElement("div"); wrap.style.cssText = "display:flex;gap:6px;align-items:center;flex:1;"; wrap.append(c, h);
        colorBox.appendChild(sRow(name, wrap));
      }
    }

    const hr = document.createElement("div"); hr.style.cssText = "height:1px;background:rgba(255,255,255,.1);margin:8px 0;"; body.appendChild(hr);
    body.appendChild(sCheck("Spring physics", flags.springOn, (v) => (flags.springOn = v)));
    body.appendChild(sCheck("Idle motion", flags.idleOn, (v) => (flags.idleOn = v)));
    body.appendChild(sCheck("Look at cursor", flags.lookOn, (v) => (flags.lookOn = v)));
    body.appendChild(sCheck("Idle behavior (random emotes)", flags.idleBehaviorOn, (v) => (flags.idleBehaviorOn = v)));
    body.appendChild(sCheck("Face (blink / lip-sync)", flags.facialOn, (v) => (flags.facialOn = v)));
    body.appendChild(sCheck("Lock in place", flags.locked, (v) => (flags.locked = v)));
    body.appendChild(sCheck("Show skeleton (inspect bones)", api.getBonesShown(), (v) => api.showSkeleton(v)));
    const panelOn = !document.getElementById("ui")?.classList.contains("hidden");
    body.appendChild(sCheck("Show info panel", panelOn, (v) => document.getElementById("ui")?.classList.toggle("hidden", !v)));

    // --- Fit attachment (props / clothes / furniture): place the selected item ---
    const attachObjs = api.getAttachObjs();
    if (attachObjs.length) {
      const fr = document.createElement("div"); fr.style.cssText = "height:1px;background:rgba(255,255,255,.1);margin:8px 0;"; body.appendChild(fr);
      const fh = document.createElement("div"); fh.textContent = "Fit attachment"; fh.style.cssText = "opacity:.6;font-size:11px;margin-bottom:2px;"; body.appendChild(fh);
      const isel = document.createElement("select");
      for (const a of attachObjs) { const o = document.createElement("option"); o.value = a.id; o.textContent = `${a.category}: ${baseName(a.url)}`; isel.appendChild(o); }
      body.appendChild(sRow("Item", isel));
      const fitBox = document.createElement("div"); body.appendChild(fitBox);
      const BTN = "padding:3px 8px;background:rgba(255,255,255,.08);color:#eee;border:1px solid rgba(255,255,255,.15);border-radius:4px;cursor:pointer;font:12px system-ui;";
      const BONES = ["righthand", "lefthand", "head", "neck", "back", "hips", "tail", "rightfoot", "leftfoot", ""];
      const renderFit = () => {
        fitBox.innerHTML = "";
        const a = attachObjs.find((x) => x.id === isel.value); if (!a) return;
        const bsel = document.createElement("select");
        for (const b of BONES) { const o = document.createElement("option"); o.value = b; o.textContent = b || "(world / no bone)"; if (b === a.bone) o.selected = true; bsel.appendChild(o); }
        bsel.onchange = (e) => { e.stopPropagation(); api.tuneAttachment(a.id, { bone: bsel.value }); };
        fitBox.appendChild(sRow("Bone", bsel));
        const scRow = document.createElement("div"); scRow.style.cssText = "display:flex;gap:5px;align-items:center;";
        const scVal = document.createElement("span"); scVal.textContent = "×" + a.scale.toFixed(4); scVal.style.cssText = "flex:1;font-size:11px;opacity:.7;text-align:right;";
        const scBtn = (lab, f) => { const b = document.createElement("button"); b.textContent = lab; b.style.cssText = BTN; b.onclick = (e) => { e.stopPropagation(); api.tuneAttachment(a.id, { scale: +(a.scale * f).toFixed(5) }); scVal.textContent = "×" + a.scale.toFixed(4); }; return b; };
        scRow.append(scVal, scBtn("−", 1 / 1.2), scBtn("+", 1.2)); fitBox.appendChild(sRow("Scale", scRow));
        ["x", "y", "z"].forEach((axis, i) => {
          const r = document.createElement("input"); r.type = "range"; r.min = "-180"; r.max = "180"; r.step = "1"; r.value = String(a.rot[i] || 0); r.style.flex = "1";
          r.oninput = (e) => { e.stopPropagation(); const rot = a.rot.slice(); rot[i] = parseFloat(r.value); api.tuneAttachment(a.id, { rot }); };
          fitBox.appendChild(sRow("Rotate " + axis.toUpperCase(), r));
        });
        const nudge = document.createElement("div"); nudge.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
        [["X−", 0, -1], ["X+", 0, 1], ["Y−", 1, -1], ["Y+", 1, 1], ["Z−", 2, -1], ["Z+", 2, 1]].forEach(([lab, ax, dir]) => {
          const b = document.createElement("button"); b.textContent = lab; b.style.cssText = BTN + "flex:1;min-width:30px;";
          b.onclick = (e) => {
            e.stopPropagation();
            const v = new THREE.Vector3(); a.obj?.parent?.getWorldScale(v);     // step ≈ 4% of avatar height, in bone-local units
            const stepLocal = (0.04 * BASE_H * (rig.scale.x || 1)) / (((v.x + v.y + v.z) / 3) || 1);
            const p = a.pos.slice(); p[ax] = +(p[ax] + dir * stepLocal).toFixed(4); api.tuneAttachment(a.id, { pos: p });
          };
          nudge.appendChild(b);
        });
        fitBox.appendChild(sRow("Move", nudge));
      };
      isel.onchange = (e) => { e.stopPropagation(); renderFit(); };
      renderFit();
    }
  }
  function showSettings() {
    buildSettings();
    settings.style.display = "flex";
    const r = settings.getBoundingClientRect();
    settings.style.left = Math.max(6, Math.round(innerWidth / 2 - r.width / 2)) + "px";
    settings.style.top = Math.max(6, Math.round(innerHeight / 2 - r.height / 2)) + "px";
    settingsShown = true; api.syncInteractive();
  }
  function hideSettings() { if (!settingsShown) return; settings.style.display = "none"; settingsShown = false; api.syncInteractive(); }

  function rebuildMenu() {
    const curKey = api.getCurKey();
    const attachObjs = api.getAttachObjs();
    const DISPLAYS = api.getDisplays();
    const curDisplayIdx = api.getCurDisplayIdx();
    menu.innerHTML = "";
    for (const m of MODEL_LIST) menu.appendChild(menuRow(m.label, { dot: curKey === m.url, onClick: () => { api.loadModel(m.url, m.label); hideMenu(); } }));
    menu.appendChild(menuRow("Add model…", { onClick: () => addModel() }));
    menu.appendChild(submenu("Add to avatar", [
      { label: "Clothing…", onClick: () => addAttachment("clothes") },
      { label: "Prop…", onClick: () => addAttachment("prop") },
      { label: "Furniture…", onClick: () => addAttachment("furniture") },
    ]));
    if (attachObjs.length) menu.appendChild(submenu(`Remove (${attachObjs.length})`, attachObjs
      .map((a) => ({ label: `${a.category}: ${baseName(a.url)}`, onClick: () => { api.detachAttachment(a.id); hideMenu(); } }))
      .concat([{ label: "— all —", onClick: () => { api.clearAttachments(); hideMenu(); } }])));
    menu.appendChild(menuSep());
    menu.appendChild(submenu("Express", EMOTES.map((e) => ({ label: cap(e), onClick: () => api.express(e) }))));   // fire several; flyout stays open
    menu.appendChild(submenu("Size", [
      { label: "Bigger", onClick: () => api.resizeBy(1.1) },
      { label: "Smaller", onClick: () => api.resizeBy(1 / 1.1) },
      { label: "Reset", onClick: () => api.applySize(api.DEFAULT_SIZE) },
    ]));
    // Move the overlay to another screen (only with >1 monitor). The dot marks the
    // current one; Ctrl+Alt+M cycles without opening the menu.
    if (DISPLAYS.length > 1) menu.appendChild(submenu("Move to monitor", DISPLAYS.map((d) => ({
      label: d.label, check: d.index === curDisplayIdx,
      onClick: () => { api.moveToDisplay(d.index); hideMenu(); },
    }))));
    menu.appendChild(menuSep());
    menu.appendChild(menuRow("Settings…", { onClick: () => { hideMenu(); showSettings(); } }));
    if (avatarIPC?.quit) { menu.appendChild(menuSep()); menu.appendChild(menuRow("Quit avatar", { accel: "Ctrl+Alt+Q", danger: true, onClick: () => avatarIPC.quit() })); }
  }
  function showMenu(x, y) {
    rebuildMenu();
    menu.style.display = "block";
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + "px";
    menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + "px";
    menuShown = true; api.syncInteractive();
    const sig = api.getDisplays().length + ":" + api.getCurDisplayIdx();        // refresh monitors; redraw only if changed
    api.refreshDisplays().then(() => { if (menuShown && sig !== api.getDisplays().length + ":" + api.getCurDisplayIdx()) rebuildMenu(); });
  }
  function hideMenu() { if (!menuShown) return; menu.style.display = "none"; menuShown = false; api.syncInteractive(); }

  return {
    showMenu, hideMenu, showSettings, hideSettings, rebuildMenu, refreshModelList,
    isOpen: () => menuShown || settingsShown,
    isMenuOpen: () => menuShown,
    isSettingsOpen: () => settingsShown,
    containsEvent: (target) => target instanceof Node && (menu.contains(target) || settings.contains(target)),
  };
}
