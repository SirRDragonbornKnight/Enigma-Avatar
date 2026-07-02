// ui.js — the avatar's right-click menu + Settings dialog (all the DOM construction).
// Pulled out of avatar.js so the engine orchestrator isn't buried under ~280 lines of
// element-building. It owns NO engine state; everything it touches comes through `api`
// (getters for live state, action functions, and a `flags` accessor object for the
// boolean toggles whose source of truth stays in avatar.js).
//
// createUI(api) → the menu / Settings / gallery control surface (showMenu, showSettings,
//                 refreshModelList, containsEvent, ...) — see the full return at the bottom of this file.
import { ROLES as CANON_ROLES } from "../rig/rig.js"; // the 19 canonical roles — single source of truth (no hand-copy to drift)

export function createUI(api) {
  const { THREE, BASE_H, rig, avatarIPC, setStatus, baseName, kindOf, profileFor, flags } = api;
  // 0..360 stored rotation -> signed (-180,180] for the Settings fields, so the user can dial the
  // OTHER direction (negative = left/down), not just climb 0..360. Identity fallback if not provided.
  const signed180 = api.signed180 || ((v) => v);
  // Body emotes + the gesture/motion catalog were PURGED 2026-06-25 ("purge means purge") — the AI now
  // authors ALL motion via the compositor (pose/flex/perform). The only menu actions left are the rapier
  // ball-physics toys (NOT gestures): throw / drop / clear.
  const BALL_ACTIONS = [
    { name: "throwball", label: "Throw ball" },
    { name: "dropball", label: "Drop ball on her" },
    { name: "clearballs", label: "Clear balls" },
  ];

  // CANON_ROLES (the attach-picker's universe of 19 canonical roles) is imported from rig.js above,
  // so it can never drift from the resolver's own list. Only used to derive which roles THIS body resolved.
  // Resolved roles for THIS body, from the live role query. getRoleInfo() reports `missing`
  // (role names the rig didn't resolve); the picker offers everything EXCEPT those. If `matched`
  // ever arrives as a name array, prefer it directly. No role query -> empty (only "no bone").
  function resolvedRoles() {
    const ri = api.getRoleInfo ? api.getRoleInfo() : null;
    if (!ri) return [];
    if (Array.isArray(ri.matched)) return ri.matched.slice();
    const missing = new Set(ri.missing || []);
    return CANON_ROLES.filter((r) => !missing.has(r));
  }

  let menuShown = false,
    settingsShown = false,
    galleryShown = false,
    _galleryVer = 0;
  let _settingsPos = null,
    _galleryPos = null; // remember where the user dragged each panel (per session)

  // built-ins + user models from models.json
  const BUILTIN_MODELS = api.builtinModels;
  let MODEL_LIST = BUILTIN_MODELS.slice();
  // The model library = a LIVE scan of models/ in the desktop app (the folder is the source of
  // truth → no models.json drift). Browser fallback: read models.json. Each entry is
  // {id,label,url,builtin,thumb}. Rebuilds whatever popup is open afterwards.
  function refreshModelList() {
    const load = avatarIPC?.listModels
      ? avatarIPC.listModels().then((list) => {
          MODEL_LIST = Array.isArray(list) ? list : [];
        }) // desktop: the live folder scan is authoritative
      : fetch("./models.json", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null)) // browser fallback: read the manifest
          .then((j) => {
            MODEL_LIST = (j?.models || [])
              .filter((m) => m?.url)
              .map((m) => ({ id: m.id, url: m.url, label: m.label || m.id, builtin: false, thumb: null }));
          });
    return Promise.resolve(load)
      .catch(() => {})
      .then(() => {
        _galleryVer++;
        if (menuShown) rebuildMenu();
        if (galleryShown && !_confirmRemove && !_renameId) buildGallery();
      }); // bump the thumb cache-token on a real refresh; DON'T rebuild out from under an armed delete-confirm / rename
  }
  // Import a new avatar. Electron: native dialog → copy into models/ + register
  // (.glb/.gltf/.vrm/.fbx and .unitypackage via import_unitypackage.py). Browser: file picker.
  async function addModel() {
    hideMenu();
    if (avatarIPC?.importModel) {
      setStatus("importing model…");
      try {
        const res = await avatarIPC.importModel();
        if (!res) {
          setStatus("import cancelled");
          return;
        }
        if (res.error) {
          setStatus("import failed: " + res.error);
          return;
        }
        await refreshModelList();
        api.loadModel(res.url, res.label);
      } catch (e) {
        setStatus("import failed: " + (e?.message || e));
      }
    } else {
      // browser / no-IPC fallback: pick a single self-contained file and load it as a blob
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".glb,.gltf,.vrm,.fbx";
      inp.style.display = "none";
      document.body.appendChild(inp);
      inp.addEventListener("change", (e) => {
        const f = e.target.files?.[0];
        if (f) {
          const u = URL.createObjectURL(f);
          api.loadModel(u, f.name);
          setTimeout(() => URL.revokeObjectURL(u), 20000);
        }
        inp.remove();
      }); // revoke after the async load settles (20s, matches the drag-drop sweep) — don't leak a blob handle per pick
      inp.click();
    }
  }
  // Attach a prop/accessory. Electron: native picker → copied into props/. Browser: blob.
  let _propCategory = "prop";
  async function addAttachment(category) {
    _propCategory = category;
    hideMenu();
    if (avatarIPC?.importProp) {
      setStatus(`importing ${category}…`);
      try {
        const res = await avatarIPC.importProp();
        if (!res) {
          setStatus("import cancelled");
          return;
        }
        if (res.error) {
          setStatus("import failed: " + res.error);
          return;
        }
        api.attachMesh(res.url, { category });
      } catch (e) {
        setStatus("import failed: " + (e?.message || e));
      }
    } else {
      _propInput.click();
    }
  }
  // Delete a USER-added model (built-ins aren't removable): drop its models.json entry + files
  // via main, then refresh the list. The remove counterpart to "Add model…".
  async function removeModelById(id, label) {
    hideMenu();
    if (!avatarIPC?.removeModel) {
      setStatus("remove needs the desktop app");
      return;
    }
    // is the model on screen the one being removed? (structural id compare — names untrusted)
    const curId = (/\/models\/([^/]+)\//.exec(api.getCurKey() || "") || [])[1];
    const wasCurrent = curId === id;
    setStatus(`removing ${label}…`);
    try {
      const res = await avatarIPC.removeModel(id);
      if (res?.error) {
        setStatus("remove failed: " + res.error);
        return;
      }
      await refreshModelList();
      // if the removed model was on screen, switch to whatever's LEFT (or the procedural placeholder
      // if the library is now empty — built-ins can be deleted, so don't assume one exists), THEN
      // rebuild the open gallery so the "current" highlight tracks the new model (audit #5 H3).
      if (wasCurrent) {
        const next = MODEL_LIST[0];
        api.loadModel(next ? next.url : "__default__", next ? next.label : "Default");
        if (galleryShown) buildGallery();
      }
      setStatus(`removed ${label}`);
    } catch (e) {
      setStatus("remove failed: " + (e?.message || e));
    }
  }
  const _propInput = document.createElement("input");
  _propInput.type = "file";
  _propInput.accept = ".glb,.gltf,.vrm,.fbx";
  _propInput.style.display = "none";
  document.body.appendChild(_propInput);
  _propInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) {
      const u = URL.createObjectURL(f);
      api.attachMesh(u, { category: _propCategory, kind: kindOf(f.name) });
      setTimeout(() => URL.revokeObjectURL(u), 20000);
    }
  }); // revoke after the async load settles — don't leak a blob handle per prop pick

  // A plain, OS-style context menu (no glass / emoji / switches).
  const MENU_CSS =
    "position:fixed;z-index:50;min-width:188px;background:rgba(38,38,41,.98);border:1px solid rgba(255,255,255,.13);" +
    "border-radius:8px;padding:4px;box-shadow:0 9px 28px rgba(0,0,0,.5);font:13px/1.25 'Segoe UI',system-ui,sans-serif;color:#f0f0f0;user-select:none;";
  const menu = document.createElement("div");
  menu.id = "avmenu";
  menu.style.cssText = MENU_CSS + "display:none;";
  document.body.appendChild(menu);

  const menuSep = () => {
    const d = document.createElement("div");
    d.style.cssText = "height:1px;background:rgba(255,255,255,.1);margin:4px 8px;";
    return d;
  };
  const menuRow = (label, o = {}) => {
    const d = document.createElement("div");
    d.style.cssText =
      "position:relative;display:flex;align-items:center;padding:6px 12px 6px 28px;border-radius:5px;white-space:nowrap;cursor:default;" +
      (o.danger ? "color:#ff8a8a;" : "");
    if (o.dot) {
      const m = document.createElement("span");
      m.textContent = "●";
      m.style.cssText = "position:absolute;left:11px;font-size:9px;color:#6fc3ff;";
      d.appendChild(m);
    } else if (o.check) {
      const m = document.createElement("span");
      m.textContent = "✓";
      m.style.cssText = "position:absolute;left:10px;";
      d.appendChild(m);
    }
    const lab = document.createElement("span");
    lab.textContent = label;
    lab.style.flex = "1";
    d.appendChild(lab);
    if (o.accel) {
      const a = document.createElement("span");
      a.textContent = o.accel;
      a.style.cssText = "opacity:.42;font-size:11px;padding-left:24px;";
      d.appendChild(a);
    }
    if (o.arrow) {
      const a = document.createElement("span");
      a.textContent = "❯";
      a.style.cssText = "opacity:.5;font-size:10px;padding-left:18px;";
      d.appendChild(a);
    }
    d.onmouseenter = () => (d.style.background = "rgba(255,255,255,.13)");
    d.onmouseleave = () => (d.style.background = "transparent");
    if (o.onClick)
      d.onclick = (ev) => {
        ev.stopPropagation();
        o.onClick();
      };
    return d;
  };
  const submenu = (label, items) => {
    const wrap = document.createElement("div");
    wrap.style.position = "relative";
    wrap.appendChild(menuRow(label, { arrow: true }));
    const fly = document.createElement("div");
    fly.style.cssText = MENU_CSS + "display:none;position:absolute;top:-5px;left:100%;margin-left:3px;";
    for (const it of items) fly.appendChild(menuRow(it.label, { check: it.check, onClick: it.onClick }));
    wrap.appendChild(fly);
    let t;
    wrap.onmouseenter = () => {
      clearTimeout(t);
      fly.style.display = "block";
      fly.style.left = "100%";
      fly.style.right = "auto";
      fly.style.marginLeft = "3px";
      fly.style.marginRight = "0";
      const r = fly.getBoundingClientRect();
      if (r.right > innerWidth - 4) {
        fly.style.left = "auto";
        fly.style.right = "100%";
        fly.style.marginLeft = "0";
        fly.style.marginRight = "3px";
      }
    };
    wrap.onmouseleave = () => {
      t = setTimeout(() => (fly.style.display = "none"), 130);
    };
    return wrap;
  };

  // --- Settings dialog (normal OS form controls) ------------------------------
  const settings = document.createElement("div");
  settings.id = "avsettings";
  settings.style.cssText =
    "position:fixed;z-index:60;display:none;flex-direction:column;width:268px;max-height:92vh;background:rgba(38,38,41,.99);border:1px solid rgba(255,255,255,.14);" +
    "border-radius:10px;box-shadow:0 16px 46px rgba(0,0,0,.55);font:13px/1.35 'Segoe UI',system-ui,sans-serif;color:#eee;user-select:none;";
  document.body.appendChild(settings);

  const sRow = (label, control) => {
    const r = document.createElement("div");
    r.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;";
    const l = document.createElement("span");
    l.textContent = label;
    l.style.opacity = ".9";
    r.append(l, control);
    return r;
  };
  const sCheck = (label, on, set) => {
    const r = document.createElement("label");
    r.style.cssText = "display:flex;align-items:center;gap:9px;padding:6px 0;cursor:pointer;";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    cb.onchange = (e) => {
      e.stopPropagation();
      set(cb.checked);
    };
    const t = document.createElement("span");
    t.textContent = label;
    r.append(cb, t);
    return r;
  };
  // Compact number field — the ONLY "how much" control in Settings (type the value in).
  // No range slider exists anywhere in this panel (hard rule: NO SLIDERS); every weight,
  // morph, region, rotation, scale and offset goes through this helper.
  const numInput = (value, opts = {}) => {
    const r = document.createElement("input");
    r.type = "number";
    if (opts.min != null) r.min = opts.min;
    if (opts.max != null) r.max = opts.max;
    if (opts.step != null) r.step = opts.step;
    if (opts.title) r.title = opts.title;
    r.value = String(value);
    r.style.cssText =
      "width:62px;background:rgba(255,255,255,.06);color:#eee;border:1px solid rgba(255,255,255,.16);border-radius:4px;padding:2px 5px;font:12px system-ui;";
    r.oninput = (e) => {
      e.stopPropagation();
      const v = parseFloat(r.value);
      // Number.isFinite (not !isNaN) so "1e999"/Infinity is rejected too, not just NaN/"".
      if (Number.isFinite(v)) opts.onChange(v);
    };
    return r;
  };
  let _colorsOpen = false,
    _partsOpen = true,
    _advOpen = false,
    _morphsOpen = false,
    _repairOpen = false,
    _bonesOpen = false; // remember each section's expand state across re-opens; Parts starts OPEN (audit: `= false` made `open0 = _partsOpen !== false` ship collapsed — the exact "can't find the body-suit toggle" regression)
  // Friendly names for the jiggle regions the spring reports (trust-no-names: these label a
  // structural region tag, not a bone name). Cloth is split into its own Settings box.
  const REGION_LABEL = {
    breast: "Breast",
    butt: "Butt",
    genital: "Genital",
    belly: "Belly / tummy",
    hair: "Hair",
    tail: "Tail",
    ear: "Ears",
    wing: "Wings",
    cloth: "Cloth / fabric",
    accessory: "Accessory",
    jiggle: "Jiggle bones",
    other: "Other dangly",
  };
  // A 0..max "how much" knob — jiggle-region weights and morph values. NO SLIDER (hard rule):
  // a number field you type the value into (numInput), not a range input.
  const weightRow = (label, value, onChange, max = 2) => {
    const r = document.createElement("div");
    r.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;";
    const l = document.createElement("span");
    l.textContent = label;
    l.style.cssText = "opacity:.9;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const n = numInput((+value).toFixed(1), { min: "0", max: String(max), step: "0.1", onChange: (v) => onChange(v) });
    r.append(l, n);
    return r;
  };
  // A jiggle CHAIN row: an explicit on/off checkbox + a number field for the weight. The bone
  // chains were only controllable by knowing "0 = off" — the user asked for chains they can SEE
  // and TOGGLE. Unchecking remembers the previous weight; rechecking restores it. NO SLIDER.
  const chainRow = (label, value, onChange, max = 2) => {
    const r = document.createElement("div");
    r.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:7px;padding:6px 0;";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = +value > 0;
    cb.title = "this chain moves: on / off";
    cb.style.flex = "0 0 auto";
    const l = document.createElement("span");
    l.textContent = label;
    l.style.cssText = "opacity:.9;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    let last = +value > 0 ? +value : 1; // what "on" restores
    const n = numInput((+value).toFixed(1), {
      min: "0",
      max: String(max),
      step: "0.1",
      onChange: (v) => {
        if (Number.isNaN(v)) return;
        cb.checked = v > 0;
        if (v > 0) last = v;
        onChange(v);
      },
    });
    cb.onchange = (e) => {
      e.stopPropagation();
      const v = cb.checked ? last : 0;
      n.value = String(v);
      onChange(v);
    };
    r.append(cb, l, n);
    return r;
  };
  const sectionHead = (text) => {
    const d = document.createElement("div");
    d.textContent = text;
    d.style.cssText = "opacity:.6;font-size:11px;margin:2px 0;";
    return d;
  };
  const divider = () => {
    const d = document.createElement("div");
    d.style.cssText = "height:1px;background:rgba(255,255,255,.1);margin:8px 0;";
    return d;
  };
  // Collapsible Settings section: a divider, a clickable caret+label header, and a box that
  // `fill(box)` populates (or `onOpen(box)` renders lazily, for the IPC-backed repair panel). ONE
  // source of truth for the ~6 sections that each hand-rolled this boilerplate -- one such copy
  // drifted into a shipped "can't find the body-suit toggle" regression (see the _partsOpen note).
  // open()/set() read+persist the section's expand flag across panel re-opens. `right` is an optional
  // header control (e.g. the Colors "Reset" button) that must NOT toggle the section when clicked.
  function collapsible(parent, opts) {
    const {
      label,
      open,
      set,
      fill,
      onOpen,
      right = null,
      headOpacity = ".7",
      caretSize = "9px",
      brighten = false,
    } = opts;
    parent.appendChild(divider());
    const ch = document.createElement("div");
    ch.style.cssText =
      `opacity:${headOpacity};font-size:11px;margin-bottom:2px;cursor:pointer;display:flex;align-items:center;gap:6px;` +
      (brighten ? "user-select:none;" : "");
    const caret = document.createElement("span");
    caret.textContent = open() ? "▾" : "▸";
    caret.style.fontSize = caretSize;
    const lbl = document.createElement("span");
    lbl.textContent = label;
    ch.append(caret, lbl);
    if (right) {
      lbl.style.flex = "1";
      ch.appendChild(right);
    }
    parent.appendChild(ch);
    const box = document.createElement("div");
    box.style.display = open() ? "block" : "none";
    parent.appendChild(box);
    ch.onclick = (e) => {
      if (right && (e.target === right || right.contains(e.target))) return; // a header control isn't a toggle
      e.stopPropagation();
      const nowOpen = box.style.display === "none";
      set(nowOpen);
      box.style.display = nowOpen ? "block" : "none";
      caret.textContent = nowOpen ? "▾" : "▸";
      if (nowOpen && onOpen) onOpen(box);
    };
    if (brighten) {
      ch.onmouseenter = () => {
        ch.style.opacity = "1";
      };
      ch.onmouseleave = () => {
        ch.style.opacity = headOpacity;
      };
    }
    if (fill) fill(box);
    if (open() && onOpen) onOpen(box);
    return box;
  }
  // Make a floating panel draggable by its header (the Settings / model gallery open centered and
  // used to be pinned there — now you can move them out of the way). Header buttons still work.
  function dragByHeader(panel, handle, onMove) {
    handle.style.cursor = "move";
    handle.style.touchAction = "none";
    let sx = 0,
      sy = 0,
      ox = 0,
      oy = 0,
      on = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button,input,select,a,label")) return; // don't hijack a header control (the ✕)
      on = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = panel.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {}
      e.preventDefault();
      e.stopPropagation();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!on) return;
      if (!(e.buttons & 1)) {
        on = false;
        return;
      } // primary button no longer held (a pointerup we missed) → stop following the cursor
      const nx = Math.max(8 - panel.offsetWidth + 56, Math.min(ox + (e.clientX - sx), innerWidth - 56));
      const ny = Math.max(6, Math.min(oy + (e.clientY - sy), innerHeight - 28));
      panel.style.left = nx + "px";
      panel.style.top = ny + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      if (onMove) onMove(nx, ny);
    });
    const end = (e) => {
      if (on) {
        on = false;
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch {}
      }
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  function buildSettings() {
    const curKey = api.getCurKey();
    settings.innerHTML = "";
    const head = document.createElement("div");
    head.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.1);flex-shrink:0;";
    head.innerHTML = `<span style="font-weight:600">Avatar Settings</span>`;
    const x = document.createElement("button");
    x.textContent = "✕";
    x.style.cssText =
      "border:0;background:transparent;color:#bbb;font-size:14px;line-height:1;cursor:pointer;padding:2px 4px;";
    x.onclick = (e) => {
      e.stopPropagation();
      hideSettings();
    };
    head.appendChild(x);
    settings.appendChild(head);
    dragByHeader(settings, head, (px, py) => {
      _settingsPos = { x: px, y: py };
    });
    const body = document.createElement("div");
    body.style.cssText = "padding:8px 14px 14px;overflow-y:auto;overflow-x:hidden;min-height:0;flex:1 1 auto;";
    settings.appendChild(body);

    const sel = document.createElement("select");
    for (const m of MODEL_LIST) {
      const o = document.createElement("option");
      o.value = m.url;
      o.textContent = m.label;
      if (m.url === curKey) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = (e) => {
      e.stopPropagation();
      const m = MODEL_LIST.find((x) => x.url === sel.value);
      api.loadModel(sel.value, m?.label);
    };
    body.appendChild(sRow("Model", sel));
    // Rotate (yaw) — turn the avatar to see its back / sides; saved per model. Plus a "drag to
    // spin" mode so the user can turn it by dragging the body instead of moving the window.
    if (api.setRotAxis || api.setYaw) {
      const r0 = api.getRot ? api.getRot() : { x: 0, y: api.getYaw ? api.getYaw() : 0, z: 0 };
      const setAxis = (axis, v) => (api.setRotAxis ? api.setRotAxis(axis, v) : api.setYaw(v));
      const rotWrap = document.createElement("div");
      rotWrap.style.cssText = "display:flex;gap:6px;align-items:center;flex:0 0 auto;";
      for (const axis of ["x", "y", "z"]) {
        // pitch / yaw / roll — turn the avatar on every axis
        const g = document.createElement("div");
        g.style.cssText = "display:flex;align-items:center;gap:2px;";
        const t = document.createElement("span");
        t.textContent = axis.toUpperCase();
        t.style.cssText = "opacity:.5;font-size:10px;";
        const n = numInput(signed180(r0[axis] || 0), {
          min: "-180", // signed: negative turns her the OTHER way (left / down), not only right / up
          max: "180",
          step: "15",
          title:
            "rotate " + axis.toUpperCase() + " — " + (axis === "x" ? "pitch" : axis === "y" ? "yaw" : "roll") + " °",
          onChange: (v) => setAxis(axis, v),
        });
        n.style.width = "42px";
        g.append(t, n);
        rotWrap.appendChild(g);
      }
      const rst = document.createElement("button");
      rst.textContent = "↺";
      rst.title = "reset rotation (0,0,0)";
      rst.style.cssText =
        "border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#eee;border-radius:4px;font:12px system-ui;padding:1px 7px;cursor:pointer;";
      rst.onclick = (e) => {
        e.stopPropagation();
        if (api.setRot) api.setRot({ x: 0, y: 0, z: 0 });
        else api.setYaw(0);
        buildSettings();
      };
      rotWrap.appendChild(rst);
      body.appendChild(sRow("Rotate °", rotWrap));
      // Rotate-by-drag TOGGLE (user request 2026-06-30: "make rotate a toggle instead of the Alt
      // button"). Arm it and a drag on her body spins her instead of moving the window. SAFE because
      // hideSettings() auto-disarms it (line ~1314) — the armed mode can never outlive the panel and
      // hijack a later move-drag, which was the 2026-06-11 "can't move her, can rotate" failure that
      // demoted it to Alt-only. Alt+drag still works too, for a quick spin without arming.
      if (api.setRotateMode && api.getRotateMode)
        body.appendChild(sCheck("Rotate by dragging her", api.getRotateMode(), (on) => api.setRotateMode(on)));
      const rotHint = document.createElement("div");
      rotHint.textContent = "Turn her by hand: arm the toggle and drag her — or hold Alt and drag (↔ turn, ↕ tilt)";
      rotHint.style.cssText = "padding:4px 0 2px;opacity:.55;font-size:11px;";
      body.appendChild(rotHint);
    }

    // (The "Idle — this avatar's own behavior" section lived here — DELETED with the whole idle
    //  system, user order 2026-06-12: "delete the idle animation everywhere and anything that has
    //  to do with it". There is nothing to tune: she only moves when something real drives her.)

    // Size is scroll-only (hover the avatar + wheel; +/- and 0 on the keyboard; AI bus `size`).

    // --- Jiggle (soft-body) — per AREA. The spring tags each soft/dangly bone with a region
    //     (breast/butt/genital/belly/hair/tail/…); set how much each AREA moves (0 = rigid / off,
    //     1 = default, 2 = bouncy). Saved per avatar. NSFW areas are first-class so e.g. Mal0's
    //     breast/butt/genital chains can each be tuned or switched off. Cloth → its own box below.
    const regions = api.springRegions ? api.springRegions() : [];
    const bodyRegions = regions.filter((r) => r.region !== "cloth");
    const clothRegion = regions.find((r) => r.region === "cloth");
    if (bodyRegions.length) {
      body.appendChild(divider());
      body.appendChild(sectionHead("Jiggle — the soft-body bone CHAINS (✓ = moves; number = how much)"));
      for (const rg of bodyRegions)
        body.appendChild(
          chainRow((REGION_LABEL[rg.region] || rg.region) + " ·" + rg.count, rg.weight, (v) =>
            api.setRegionWeight(rg.region, v)
          )
        );
    }
    if (clothRegion) {
      body.appendChild(divider());
      body.appendChild(sectionHead("Cloth / fabric"));
      body.appendChild(
        chainRow("Cloth sway ·" + clothRegion.count, clothRegion.weight, (v) => api.setRegionWeight("cloth", v))
      );
      const note = document.createElement("div");
      note.textContent = "drives cloth bones; cloth with no bones can't sway (needs vertex sim)";
      note.style.cssText = "opacity:.45;font-size:10px;line-height:1.3;";
      body.appendChild(note);
    }

    // Advanced physics — the GLOBAL spring feel (hair/tail). Collapsed: most users only touch the
    // per-area jiggle above. Tuned live (type the value) + saved into this avatar's profile.
    {
      const sp = () => profileFor(curKey).spring || {};
      collapsible(body, {
        label: "Advanced physics (global feel)",
        open: () => _advOpen,
        set: (v) => (_advOpen = v),
        fill: (advBox) => {
          const springNum = (label, key, min, max, step, dflt) =>
            advBox.appendChild(
              sRow(
                label,
                numInput(sp()[key] ?? dflt, { min, max, step, onChange: (v) => api.springTune({ [key]: v }) })
              )
            );
          springNum("Hair stiffness", "stiffness", "0.04", "0.5", "0.01", 0.14);
          springNum("Hair damping", "drag", "0.1", "0.95", "0.01", 0.5);
          springNum("Hair gravity", "gravity", "-6", "0", "0.1", -3.0);
          // (the "Hair breeze" knob died with the idle system, 2026-06-12 — ambient wind was self-generated motion)
        },
      });
    }

    // Colors — recolor each material by its STABLE INDEX. Names are unreliable (a model can have
    // UNNAMED or duplicate-named materials), so we address by index and show the name/mesh only as
    // a hint — this also surfaces parts the old name-only list silently dropped. Type an #rrggbb
    // code or use the swatch; "Reset" restores every part's original loaded color.
    const mats = api.materials ? api.materials() : [];
    if (mats.length) {
      const reset = document.createElement("button");
      reset.textContent = "Reset";
      reset.title = "restore every part's original loaded color";
      reset.style.cssText =
        "border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#eee;border-radius:4px;font:11px system-ui;padding:1px 8px;cursor:pointer;flex:0 0 auto;";
      reset.onclick = (e) => {
        e.stopPropagation();
        if (api.resetColors) api.resetColors();
        buildSettings();
      };
      // Collapsible — a model like grace_howard has many materials; collapse by default when
      // there are more than a handful (the expand state persists across re-opens).
      collapsible(body, {
        label: `Colors — by part index (${mats.length})`,
        open: () => _colorsOpen || mats.length <= 6,
        set: (v) => (_colorsOpen = v),
        right: reset,
        fill: (colorBox) => {
          for (const mat of mats) {
            const hex0 = mat.hex || "#ffffff";
            const c = document.createElement("input");
            c.type = "color";
            c.value = hex0;
            c.style.cssText =
              "width:30px;height:24px;padding:0;border:1px solid rgba(255,255,255,.16);border-radius:4px;background:transparent;cursor:pointer;flex:0 0 auto;";
            const t = document.createElement("input");
            t.type = "text";
            t.value = hex0;
            t.spellcheck = false;
            t.maxLength = 7;
            t.placeholder = "#rrggbb";
            t.style.cssText =
              "width:80px;background:rgba(255,255,255,.06);color:#eee;border:1px solid rgba(255,255,255,.16);border-radius:4px;padding:2px 5px;font:12px ui-monospace,Consolas,monospace;";
            // accept "#rrggbb" or "rrggbb"; ignore partial/invalid input so typing doesn't flicker
            const apply = (raw) => {
              const s = String(raw).trim();
              if (!/^#?[0-9a-fA-F]{6}$/.test(s)) return;
              const hex = s[0] === "#" ? s : "#" + s;
              c.value = hex;
              t.value = hex;
              api.recolor(mat.index, hex);
            };
            c.oninput = (e) => {
              e.stopPropagation();
              apply(c.value);
            };
            t.oninput = (e) => {
              e.stopPropagation();
              apply(t.value);
            };
            const wrap = document.createElement("div");
            wrap.style.cssText = "display:flex;gap:6px;align-items:center;flex:0 0 auto;";
            wrap.append(c, t);
            const label =
              `#${mat.index}` + (mat.name ? " · " + mat.name : "") + (mat.mesh ? "  (" + mat.mesh + ")" : "");
            colorBox.appendChild(sRow(label, wrap));
          }
        },
      });
    }

    // Parts (meshes) — show/hide each sub-object BY INDEX (clothing variants, hide-able body parts).
    // Names are unreliable, so address by #index; toggling live tells you which is which.
    // Every sub-object shows up (the user asked for ALL parts): tick = visible (remove/add a part),
    // and the text field RENAMES it (names like "Object_107" or duplicates are useless — give it a
    // legible name). Both saved per avatar. Addressed by #index (the only reliable handle).
    const parts = api.meshes ? api.meshes() : [];
    if (parts.length >= 1) {
      // DEFAULT OPEN — it used to auto-collapse on models with >8 parts, and the tiny dim header didn't
      // read as clickable, so the user couldn't find the body-suit toggle at all ("part toggle is not
      // accessible"). The list is the point of this section; the caret stays for collapsing it.
      collapsible(body, {
        label: `Parts — show / hide / rename (${parts.length})`,
        open: () => _partsOpen !== false,
        set: (v) => (_partsOpen = v),
        headOpacity: ".85",
        caretSize: "10px",
        brighten: true,
        fill: (box) => {
          // OUTFITS (2026-06-12): one-click looks — a named snapshot of which parts are hidden. Tick the
          // parts into a look below, type a name, Enter; "Wear" swaps the whole look at once. Saved per avatar.
          if (api.outfits) {
            const bar = document.createElement("div");
            bar.style.cssText = "display:flex;gap:5px;align-items:center;margin:2px 0 6px;flex-wrap:wrap;";
            const BTN2 =
              "border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#eee;border-radius:4px;font:12px system-ui;padding:2px 7px;cursor:pointer;";
            const sel = document.createElement("select");
            sel.style.cssText =
              "background:rgba(255,255,255,.08);color:#eee;border:1px solid rgba(255,255,255,.16);border-radius:4px;font:12px system-ui;padding:2px 4px;max-width:108px;";
            const names = api.outfits();
            if (!names.length) {
              const o = document.createElement("option");
              o.textContent = "(no outfits)";
              sel.appendChild(o);
              sel.disabled = true;
            } else
              for (const n of names) {
                const o = document.createElement("option");
                o.value = n;
                o.textContent = n;
                sel.appendChild(o);
              }
            const wear = document.createElement("button");
            wear.textContent = "Wear";
            wear.style.cssText = BTN2;
            wear.disabled = !names.length;
            wear.onclick = (e) => {
              e.stopPropagation();
              if (api.wearOutfit && sel.value) {
                api.wearOutfit(sel.value);
                buildSettings();
              }
            };
            const del = document.createElement("button");
            del.textContent = "✕";
            del.title = "delete this outfit";
            del.style.cssText = BTN2;
            del.disabled = !names.length;
            del.onclick = (e) => {
              e.stopPropagation();
              if (api.deleteOutfit && sel.value) {
                api.deleteOutfit(sel.value);
                buildSettings();
              }
            };
            const nameIn = document.createElement("input");
            nameIn.type = "text";
            nameIn.placeholder = "save current as… ⏎";
            nameIn.spellcheck = false;
            nameIn.style.cssText =
              "background:rgba(255,255,255,.06);color:#eee;border:1px solid rgba(255,255,255,.14);border-radius:4px;padding:2px 5px;font:12px system-ui;width:118px;";
            nameIn.onkeydown = (e) => {
              e.stopPropagation();
              if (e.key === "Enter" && nameIn.value.trim() && api.saveOutfit) {
                api.saveOutfit(nameIn.value.trim());
                buildSettings();
              }
            };
            bar.append(sel, wear, del, nameIn);
            box.appendChild(bar);
          }
          for (const p of parts) {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:7px;padding:4px 0;";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = p.visible;
            cb.title = "show / hide this part";
            cb.onchange = (e) => {
              e.stopPropagation();
              api.setMeshVisible(p.index, cb.checked);
            };
            const idx = document.createElement("span");
            idx.textContent = "#" + p.index;
            idx.style.cssText = "opacity:.5;font:11px ui-monospace,Consolas,monospace;flex:0 0 auto;";
            const nm = document.createElement("input");
            nm.type = "text";
            nm.value = p.label || "";
            nm.placeholder = p.name || "part " + p.index;
            nm.spellcheck = false;
            nm.title = "rename this part" + (p.name ? " (file name: " + p.name + ")" : "");
            nm.style.cssText =
              "flex:1;min-width:0;background:rgba(255,255,255,.06);color:#eee;border:1px solid rgba(255,255,255,.14);border-radius:4px;padding:2px 5px;font:12px system-ui;";
            nm.onkeydown = (e) => e.stopPropagation(); // typing here must not trigger the global 1-9 / h / b hotkeys
            nm.onchange = (e) => {
              e.stopPropagation();
              if (api.setMeshLabel) api.setMeshLabel(p.index, nm.value);
            };
            row.append(cb, idx, nm);
            box.appendChild(row);
          }
        },
      });
    }

    // Bones — NAME the rig (saved per avatar). Rig names are soup ("HairBoneL006_0524"); a label
    // here shows wherever bones surface (query bones, repair) and lets the user point at a bone
    // in plain words ("the ahoge"). Big rigs: filter + capped list (a Rigify export has 593).
    const bones = api.bones ? api.bones() : [];
    if (bones.length) {
      // The bone SYSTEM presents 593 rows of Rigify soup on some rigs ("seems bad"; user 2026-06-12)
      // — but the skin weights know which ~170 actually move mesh. Default view = real bones only
      // (deforming / role-resolved / already named), sorted roles-first then by influence; a
      // checkbox reveals the helper soup when it's genuinely needed.
      const hasW = bones.some((b) => b.deforms != null);
      const realCount = hasW ? bones.filter((b) => b.deforms || b.role || b.label).length : bones.length;
      collapsible(body, {
        label: hasW
          ? `Bones — name them (${realCount} real of ${bones.length})`
          : `Bones — name them (${bones.length})`,
        open: () => _bonesOpen === true, // default CLOSED — huge lists; deliberate section
        set: (v) => (_bonesOpen = v),
        brighten: true,
        fill: (bbox) => {
          const filt = document.createElement("input");
          filt.type = "text";
          filt.placeholder = "filter bones (name / label / role)…";
          filt.spellcheck = false;
          filt.style.cssText =
            "width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);color:#eee;border:1px solid rgba(255,255,255,.14);border-radius:4px;padding:3px 6px;font:12px system-ui;margin:2px 0 4px;";
          filt.onkeydown = (e) => e.stopPropagation(); // typing must not trigger global hotkeys
          // IDENTIFY bones (user 2026-06-12): Pick = the next click ON HER selects the nearest bone
          // into the filter; hovering/clicking a row's raw name flashes a pink marker on that bone.
          let showAll = false,
            allCb = null;
          if (api.pickBone) {
            const pk = document.createElement("button");
            const IDLE_TXT = "Pick a bone — click a spot on her body";
            pk.textContent = IDLE_TXT;
            pk.style.cssText =
              "border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#eee;border-radius:4px;font:12px system-ui;padding:3px 8px;cursor:pointer;margin:2px 0 4px;display:block;";
            pk.onclick = (e) => {
              e.stopPropagation();
              pk.textContent = "…now click her (anywhere else cancels)";
              api.pickBone((name) => {
                filt.value = name;
                showAll = true;
                if (allCb) allCb.checked = true;
                render();
                pk.textContent = IDLE_TXT;
              }); // a picked helper bone must be visible in the list
            };
            bbox.appendChild(pk);
          }
          const list = document.createElement("div");
          const CAP = 30;
          let allRow = null;
          if (hasW && realCount < bones.length) {
            // the helper-soup toggle (only when weights distinguish real from soup)
            allRow = document.createElement("label");
            allRow.style.cssText =
              "display:flex;align-items:center;gap:6px;font-size:11px;opacity:.7;margin:0 0 4px;cursor:pointer;";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            allCb = cb;
            cb.onchange = (e) => {
              e.stopPropagation();
              showAll = cb.checked;
              render();
            };
            const t = document.createElement("span");
            t.textContent = `show ${bones.length - realCount} helper bones (deform nothing)`;
            allRow.append(cb, t);
          }
          const render = () => {
            list.innerHTML = "";
            const q = filt.value.trim().toLowerCase();
            const base = hasW && !showAll ? bones.filter((b) => b.deforms || b.role || b.label) : bones; // default: only bones that move mesh / hold a role / are named
            const hits = base.filter(
              (b) =>
                !q ||
                b.name.toLowerCase().includes(q) ||
                (b.label || "").toLowerCase().includes(q) ||
                (b.role || "").toLowerCase().includes(q)
            );
            for (const b of hits.slice(0, CAP)) {
              const row = document.createElement("div");
              row.style.cssText = "display:flex;align-items:center;gap:7px;padding:3px 0;";
              const nm = document.createElement("input");
              nm.type = "text";
              nm.value = b.label || "";
              nm.placeholder = "name it…";
              nm.spellcheck = false;
              nm.title = "your name for this bone (raw: " + b.name + ")";
              nm.style.cssText =
                "width:108px;flex:0 0 auto;background:rgba(255,255,255,.06);color:#eee;border:1px solid rgba(255,255,255,.14);border-radius:4px;padding:2px 5px;font:12px system-ui;";
              nm.onkeydown = (e) => e.stopPropagation();
              nm.onchange = (e) => {
                e.stopPropagation();
                if (api.setBoneLabel) api.setBoneLabel(b.name, nm.value);
                b.label = nm.value.trim() || null;
              };
              const raw = document.createElement("span");
              raw.textContent = b.name + (b.role ? "  ·  " + b.role : "");
              raw.style.cssText =
                "opacity:.55;font:11px ui-monospace,Consolas,monospace;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;";
              raw.title = b.name + " — hover/click: show this bone on her";
              if (api.highlightBone) {
                // identify: light the bone up on her body
                raw.onmouseenter = () => api.highlightBone(b.name, 1.2);
                raw.onclick = (e) => {
                  e.stopPropagation();
                  api.highlightBone(b.name, 3);
                };
              }
              row.append(nm, raw);
              list.appendChild(row);
            }
            if (hits.length > CAP) {
              const more = document.createElement("div");
              more.textContent = `…${hits.length - CAP} more — type to filter`;
              more.style.cssText = "opacity:.45;font-size:11px;padding:2px 0;";
              list.appendChild(more);
            }
          };
          filt.oninput = (e) => {
            e.stopPropagation();
            render();
          };
          if (allRow) bbox.append(filt, allRow, list);
          else bbox.append(filt, list);
          render();
        },
      });
    }

    // Shapes / morphs — the model's OWN shape keys (facial expressions, body toggles like "show X").
    // Exporters usually strip the names, so address by index; slide 0..1. Saved per avatar. This is
    // how a VRChat-style avatar's "extra settings" survive a GLB export (makiro ships 19).
    const morphs = api.morphs ? api.morphs() : [];
    if (morphs.length) {
      collapsible(body, {
        label: `Shapes / morphs (${morphs.length})`,
        open: () => _morphsOpen || morphs.length <= 6,
        set: (v) => (_morphsOpen = v),
        fill: (mbox) => {
          for (const mph of morphs) {
            const tag = "#" + mph.index + (mph.name ? " · " + mph.name : "");
            if (mph.auto) {
              // this morph is auto-driven by lip-sync/blink → a slider here would just snap back; label it instead
              const r = document.createElement("div");
              r.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 0;opacity:.5;";
              const l = document.createElement("span");
              l.textContent = tag;
              l.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
              const b = document.createElement("span");
              b.textContent = "auto · lip-sync";
              b.style.cssText =
                "font-size:10px;border:1px solid rgba(255,255,255,.2);border-radius:4px;padding:0 5px;flex:0 0 auto;";
              r.append(l, b);
              mbox.appendChild(r);
            } else {
              mbox.appendChild(weightRow(tag, mph.value, (v) => api.setMorphValue(mph.index, v), 1));
            }
          }
        },
      });
    }

    const hr = document.createElement("div");
    hr.style.cssText = "height:1px;background:rgba(255,255,255,.1);margin:8px 0;";
    body.appendChild(hr);
    body.appendChild(sCheck("Spring physics", flags.springOn, (v) => (flags.springOn = v)));
    body.appendChild(sCheck("Face (blink / lip-sync)", flags.facialOn, (v) => (flags.facialOn = v)));
    body.appendChild(sCheck("Lock in place", flags.locked, (v) => (flags.locked = v)));
    body.appendChild(sCheck("Show skeleton (inspect bones)", api.getBonesShown(), (v) => api.showSkeleton(v)));
    if (api.getShadowOn)
      body.appendChild(sCheck("Ground shadow (stands on a surface)", api.getShadowOn(), (v) => api.setShadowOn(v)));
    // AI-control kill-switch: when off, the avatar ignores every command from the bus (no surprises).
    if (api.getAiControl)
      body.appendChild(sCheck("Accept AI control (bus)", api.getAiControl(), (v) => api.setAiControl(v)));
    const panelOn = !document.getElementById("ui")?.classList.contains("hidden");
    body.appendChild(
      sCheck("Show info panel", panelOn, (v) => document.getElementById("ui")?.classList.toggle("hidden", !v))
    );

    // --- Model repair (the in-Settings editor) — diagnose this model's rig + rewrite broken bone
    //     names into a repaired COPY (the original is never touched). Bone names ARE the engine's
    //     identity layer, so fixing them is how a mis-rigged model (marie's mojibake, a fluff-named
    //     arm) becomes drivable. Desktop-only (needs the file backend).
    if (api.repairModel && api.getCurKey) {
      const curId = (/\/models\/([^/]+)\//.exec(api.getCurKey() || "") || [])[1];
      if (curId) {
        collapsible(body, {
          label: "Model repair (fix the rig / bone names)",
          open: () => _repairOpen,
          set: (v) => (_repairOpen = v),
          onOpen: (box) => renderRepair(box, curId),
        });
      }
    }

    // --- Fit attachment (props / clothes / furniture): place the selected item ---
    const attachObjs = api.getAttachObjs();
    if (attachObjs.length) {
      const fr = document.createElement("div");
      fr.style.cssText = "height:1px;background:rgba(255,255,255,.1);margin:8px 0;";
      body.appendChild(fr);
      const fh = document.createElement("div");
      fh.textContent = "Fit attachment";
      fh.style.cssText = "opacity:.6;font-size:11px;margin-bottom:2px;";
      body.appendChild(fh);
      const isel = document.createElement("select");
      for (const a of attachObjs) {
        const o = document.createElement("option");
        o.value = a.id;
        o.textContent = `${a.category}: ${baseName(a.url)}`;
        isel.appendChild(o);
      }
      body.appendChild(sRow("Item", isel));
      const fitBox = document.createElement("div");
      body.appendChild(fitBox);
      const BTN =
        "padding:3px 8px;background:rgba(255,255,255,.08);color:#eee;border:1px solid rgba(255,255,255,.15);border-radius:4px;cursor:pointer;font:12px system-ui;";
      // Capability-driven attach targets: the roles THIS body actually resolved (so you can only
      // pin a prop to a bone that exists) + "(world / no bone)". NOT a hardcoded human list — a
      // wolf rig with no fingers won't offer a finger; a tailed rig that resolved a tail will.
      const attachBones = () => resolvedRoles(); // [] of canonical role names this model exposes
      const renderFit = () => {
        fitBox.innerHTML = "";
        const a = attachObjs.find((x) => x.id === isel.value);
        if (!a) return;
        const bsel = document.createElement("select");
        const opts = attachBones();
        if (a.bone && !opts.includes(a.bone)) opts.unshift(a.bone); // keep the active selection even if it's a non-role bone the AI named (e.g. "tail")
        opts.push(""); // the world / no-bone option always last
        for (const b of opts) {
          const o = document.createElement("option");
          o.value = b;
          o.textContent = b ? b.replace(/_/g, " ") : "(world / no bone)";
          if (b === a.bone) o.selected = true;
          bsel.appendChild(o);
        }
        bsel.onchange = (e) => {
          e.stopPropagation();
          api.tuneAttachment(a.id, { bone: bsel.value });
        };
        fitBox.appendChild(sRow("Bone", bsel));
        fitBox.appendChild(
          sRow(
            "Scale",
            numInput(+a.scale.toFixed(4), {
              min: "0.001",
              step: "0.05",
              onChange: (v) => api.tuneAttachment(a.id, { scale: v }),
            })
          )
        );
        ["x", "y", "z"].forEach((axis, i) => {
          fitBox.appendChild(
            sRow(
              "Rotate " + axis.toUpperCase(),
              numInput(a.rot[i] || 0, {
                min: "-180",
                max: "180",
                step: "5",
                onChange: (v) => {
                  const rot = a.rot.slice();
                  rot[i] = v;
                  api.tuneAttachment(a.id, { rot });
                },
              })
            )
          );
        });
        const nudge = document.createElement("div");
        nudge.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
        [
          ["X−", 0, -1],
          ["X+", 0, 1],
          ["Y−", 1, -1],
          ["Y+", 1, 1],
          ["Z−", 2, -1],
          ["Z+", 2, 1],
        ].forEach(([lab, ax, dir]) => {
          const b = document.createElement("button");
          b.textContent = lab;
          b.style.cssText = BTN + "flex:1;min-width:30px;";
          b.onclick = (e) => {
            e.stopPropagation();
            const v = new THREE.Vector3();
            a.obj?.parent?.getWorldScale(v); // step ≈ 4% of avatar height, in bone-local units
            const stepLocal = (0.04 * BASE_H * (rig.scale.x || 1)) / ((v.x + v.y + v.z) / 3 || 1);
            const p = a.pos.slice();
            p[ax] = +(p[ax] + dir * stepLocal).toFixed(4);
            api.tuneAttachment(a.id, { pos: p });
          };
          nudge.appendChild(b);
        });
        fitBox.appendChild(sRow("Move", nudge));
      };
      isel.onchange = (e) => {
        e.stopPropagation();
        renderFit();
      };
      renderFit();
    }
  }
  // The MODEL-REPAIR panel body (async — diagnose is an IPC round-trip). Shows live role resolution,
  // bone-name health, and one-click fixes that write a repaired COPY into the library, then load it.
  const CANON_RENAME = {
    // rename target the name tier recognizes, per role (assisted role assignment)
    hips: "Hips",
    spine: "Spine",
    chest: "Chest",
    neck: "Neck",
    head: "Head",
    left_shoulder: "LeftShoulder",
    left_arm: "LeftUpperArm",
    left_forearm: "LeftLowerArm",
    left_hand: "LeftHand",
    right_shoulder: "RightShoulder",
    right_arm: "RightUpperArm",
    right_forearm: "RightLowerArm",
    right_hand: "RightHand",
    left_leg: "LeftUpperLeg",
    left_shin: "LeftLowerLeg",
    left_foot: "LeftFoot",
    right_leg: "RightUpperLeg",
    right_shin: "RightLowerLeg",
    right_foot: "RightFoot",
  };
  function renderRepair(box, curId) {
    box.innerHTML = "";
    const note = (t, dim = true) => {
      const d = document.createElement("div");
      d.textContent = t;
      d.style.cssText = `font-size:11px;line-height:1.4;${dim ? "opacity:.6;" : ""}margin:3px 0;`;
      return d;
    };
    const BTN =
      "padding:4px 10px;background:rgba(110,195,255,.16);color:#cfe9ff;border:1px solid rgba(110,195,255,.4);border-radius:5px;cursor:pointer;font:12px system-ui;margin-top:4px;";
    // 1) live role resolution (synchronous, from the engine)
    const ri = api.getRoleInfo ? api.getRoleInfo() : null;
    if (ri) {
      box.appendChild(
        note(
          `Body roles resolved: ${ri.matched} / ${ri.total}` +
            (ri.missing.length ? "  —  missing: " + ri.missing.join(", ") : "  ✓ full skeleton"),
          ri.missing.length > 0
        )
      );
    }
    box.appendChild(note("Scanning bone names…"));
    const doRepair = async (ops, label) => {
      setStatus(label + "…");
      const res = await api.repairModel({ id: curId, ops });
      if (!res || res.error) {
        setStatus("repair failed: " + (res?.error || "?"));
        return;
      }
      setStatus(`repaired ✓ ${res.renamed || 0} renamed, ${res.repaired || 0} names fixed → ${res.label}`);
      await refreshModelList();
      api.loadModel(res.url, res.label); // switch to the repaired copy (gallery now lists both)
      hideSettings();
    };
    Promise.resolve(api.diagnoseModel ? api.diagnoseModel(curId) : null)
      .then((d) => {
        const scanLine = box.lastChild;
        if (scanLine) box.removeChild(scanLine);
        if (!d || d.error) {
          box.appendChild(note("Name scan unavailable: " + (d?.error || "—")));
          return;
        }
        const broken = (d.mojibake || 0) + (d.recoverable || 0);
        box.appendChild(
          note(
            `Bones in file: ${d.nodes}` + (broken ? `  —  ${broken} with broken names` : "  ✓ names look clean"),
            broken > 0
          )
        );
        // a) repair broken/garbled names (marie's mojibake class)
        if (broken > 0) {
          const b = document.createElement("button");
          b.textContent = `Fix ${broken} broken bone name${broken > 1 ? "s" : ""} → new copy`;
          b.style.cssText = BTN;
          b.onclick = (e) => {
            e.stopPropagation();
            doRepair({ repairMojibake: true }, "repairing bone names");
          };
          box.appendChild(b);
        }
        // b) assisted role assignment — for each MISSING role, rename a chosen bone to a canonical name
        if (ri && ri.missing.length && Array.isArray(d.names)) {
          box.appendChild(note("Assign a missing role to a bone (renames it so the rig resolves):", false));
          const boneNames = d.names.filter(Boolean);
          for (const role of ri.missing) {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:6px;padding:3px 0;";
            const rl = document.createElement("span");
            rl.textContent = role.replace(/_/g, " ");
            rl.style.cssText = "font-size:11px;width:96px;flex:0 0 auto;opacity:.85;";
            const sel = document.createElement("select");
            sel.style.cssText =
              "flex:1;min-width:0;background:rgba(255,255,255,.06);color:#eee;border:1px solid rgba(255,255,255,.16);border-radius:4px;font:11px system-ui;padding:2px;";
            const o0 = document.createElement("option");
            o0.value = "";
            o0.textContent = "(pick a bone…)";
            sel.appendChild(o0);
            for (const nm of boneNames) {
              const o = document.createElement("option");
              o.value = nm;
              o.textContent = nm;
              sel.appendChild(o);
            }
            sel.onchange = (e) => {
              e.stopPropagation();
              if (sel.value) doRepair({ renames: { [sel.value]: CANON_RENAME[role] || role } }, `assigning ${role}`);
            };
            row.append(rl, sel);
            box.appendChild(row);
          }
        }
        box.appendChild(note("Repairs write a NEW model (original kept). Switch back anytime in the gallery."));
      })
      .catch((e) => {
        box.appendChild(note("scan error: " + (e?.message || e)));
      });
  }

  function showSettings() {
    buildSettings();
    settings.style.display = "flex";
    if (_settingsPos) {
      settings.style.left = _settingsPos.x + "px";
      settings.style.top = _settingsPos.y + "px";
    } else {
      const r = settings.getBoundingClientRect();
      settings.style.left = Math.max(6, Math.round(innerWidth / 2 - r.width / 2)) + "px";
      settings.style.top = Math.max(6, Math.round(innerHeight / 2 - r.height / 2)) + "px";
    }
    settingsShown = true;
    api.syncInteractive();
  }
  function hideSettings() {
    if (!settingsShown) return;
    settings.style.display = "none";
    settingsShown = false;
    // Drag-to-spin is a SETTINGS-session tool: leaving it armed after the panel closes turns every later
    // drag into an accidental rotate (user request 2026-06-09: "rotate toggles off when settings close").
    if (api.setRotateMode && api.getRotateMode && api.getRotateMode()) api.setRotateMode(false);
    api.syncInteractive();
  }

  // --- Model gallery: a grid of THUMBNAIL cards (pick / add / remove by PICTURE, not by a cryptic
  // folder name — the trust-no-names principle applied to the UI). Built-ins can't be removed. ----
  const gallery = document.createElement("div");
  gallery.id = "avgallery";
  gallery.style.cssText =
    "position:fixed;z-index:60;display:none;flex-direction:column;width:420px;max-width:92vw;max-height:88vh;background:rgba(32,32,36,.99);border:1px solid rgba(255,255,255,.14);" +
    "border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.6);font:13px/1.35 'Segoe UI',system-ui,sans-serif;color:#eee;user-select:none;";
  document.body.appendChild(gallery);
  let _confirmRemove = null; // id awaiting an inline delete confirm (no native dialog → testable)
  let _renameId = null; // id whose card is in inline-rename mode (mutually exclusive with remove)
  const letter = (label) => {
    const d = document.createElement("div");
    d.textContent = ((label || "?").trim().charAt(0) || "?").toUpperCase();
    d.style.cssText = "font-size:30px;font-weight:700;color:rgba(255,255,255,.5);";
    return d;
  };
  function cardFor(m) {
    const card = document.createElement("div");
    const current = api.getCurKey() === m.url;
    card.dataset.id = m.id || "";
    card.style.cssText =
      "position:relative;display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 6px;border-radius:9px;cursor:pointer;border:2px solid " +
      (current ? "#6fc3ff" : "transparent") +
      ";background:rgba(255,255,255,.04);";
    const thumb = document.createElement("div");
    thumb.style.cssText =
      "width:100%;aspect-ratio:1/1;border-radius:7px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.28);";
    if (m.thumb) {
      const img = document.createElement("img");
      img.src = m.thumb + "?v=" + _galleryVer;
      img.style.cssText = "width:100%;height:100%;object-fit:contain;";
      img.onerror = () => {
        img.remove();
        thumb.appendChild(letter(m.label));
      };
      thumb.appendChild(img);
    } else thumb.appendChild(letter(m.label));
    const name = document.createElement("div");
    name.textContent = m.label;
    name.title = m.label;
    name.style.cssText =
      "font-size:11.5px;max-width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
      (current ? "color:#9fdcff;font-weight:600;" : "");
    card.append(thumb, name);
    card.onclick = (e) => {
      e.stopPropagation();
      if (_confirmRemove) {
        _confirmRemove = null;
        buildGallery();
        return;
      }
      if (_renameId) {
        _renameId = null;
        buildGallery();
        return;
      }
      api.loadModel(m.url, m.label);
      hideGallery();
    };
    if (avatarIPC?.renameModel) {
      // ✎ rename → inline editor (manifest label only)
      const ed = document.createElement("button");
      ed.textContent = "✎";
      ed.title = "rename " + m.label;
      ed.className = "ged";
      ed.style.cssText =
        "position:absolute;top:3px;left:3px;width:20px;height:20px;line-height:1;border:0;border-radius:50%;background:rgba(0,0,0,.55);color:#bfe3ff;cursor:pointer;font-size:11px;padding:0;";
      ed.onclick = (e) => {
        e.stopPropagation();
        _confirmRemove = null;
        _renameId = m.id;
        buildGallery();
      };
      card.appendChild(ed);
      if (_renameId === m.id) {
        const ov = document.createElement("div");
        ov.style.cssText =
          "position:absolute;inset:0;border-radius:9px;background:rgba(20,20,24,.95);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:8px;";
        const inp = document.createElement("input");
        inp.type = "text";
        inp.value = m.label;
        inp.spellcheck = false;
        inp.className = "grename";
        inp.style.cssText =
          "width:100%;background:rgba(255,255,255,.08);color:#eee;border:1px solid rgba(255,255,255,.2);border-radius:5px;padding:3px 6px;font:12px system-ui;text-align:center;";
        const save = async () => {
          const v = inp.value.trim();
          _renameId = null;
          if (v && v !== m.label && api.renameModel) {
            try {
              await api.renameModel(m.id, v);
            } catch {}
          }
          refreshModelList();
        }; // refreshModelList rebuilds the gallery itself (_renameId now null)
        inp.onclick = (e) => e.stopPropagation();
        inp.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            _renameId = null;
            buildGallery();
          }
        };
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;";
        const ok = document.createElement("button");
        ok.textContent = "Save";
        ok.className = "gsave";
        ok.style.cssText =
          "border:0;border-radius:5px;background:#2f6f9f;color:#fff;padding:3px 10px;cursor:pointer;font:11px system-ui;";
        ok.onclick = (e) => {
          e.stopPropagation();
          save();
        };
        const no = document.createElement("button");
        no.textContent = "Cancel";
        no.style.cssText =
          "border:1px solid rgba(255,255,255,.2);border-radius:5px;background:transparent;color:#eee;padding:3px 10px;cursor:pointer;font:11px system-ui;";
        no.onclick = (e) => {
          e.stopPropagation();
          _renameId = null;
          buildGallery();
        };
        row.append(ok, no);
        ov.append(inp, row);
        card.appendChild(ov);
      }
    }
    if (avatarIPC?.removeModel) {
      // ANY model is removable (built-ins too — it's your install)
      const x = document.createElement("button");
      x.textContent = "✕";
      x.title = "remove " + m.label;
      x.className = "gx";
      x.style.cssText =
        "position:absolute;top:3px;right:3px;width:20px;height:20px;line-height:1;border:0;border-radius:50%;background:rgba(0,0,0,.55);color:#ff9a9a;cursor:pointer;font-size:12px;padding:0;";
      x.onclick = (e) => {
        e.stopPropagation();
        _confirmRemove = m.id;
        buildGallery();
      };
      card.appendChild(x);
      if (_confirmRemove === m.id) {
        const ov = document.createElement("div");
        ov.style.cssText =
          "position:absolute;inset:0;border-radius:9px;background:rgba(20,20,24,.93);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:6px;text-align:center;";
        const q = document.createElement("div");
        q.textContent = "Remove “" + m.label + "”?";
        q.style.cssText = "font-size:11.5px;";
        const sub = document.createElement("div");
        sub.textContent = "moves to _trash (recoverable)";
        sub.style.cssText = "font-size:9.5px;opacity:.6;";
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;";
        const yes = document.createElement("button");
        yes.textContent = "Remove";
        yes.className = "gyes";
        yes.style.cssText =
          "border:0;border-radius:5px;background:#a23b3b;color:#fff;padding:3px 10px;cursor:pointer;font:11px system-ui;";
        yes.onclick = (e) => {
          e.stopPropagation();
          _confirmRemove = null;
          removeModelById(m.id, m.label);
        };
        const no = document.createElement("button");
        no.textContent = "Cancel";
        no.style.cssText =
          "border:1px solid rgba(255,255,255,.2);border-radius:5px;background:transparent;color:#eee;padding:3px 10px;cursor:pointer;font:11px system-ui;";
        no.onclick = (e) => {
          e.stopPropagation();
          _confirmRemove = null;
          buildGallery();
        };
        row.append(yes, no);
        ov.append(q, sub, row);
        card.appendChild(ov);
      }
    }
    return card;
  }
  function buildGallery() {
    gallery.innerHTML = "";
    const head = document.createElement("div");
    head.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;padding:11px 15px;border-bottom:1px solid rgba(255,255,255,.1);flex-shrink:0;";
    head.innerHTML = `<span style="font-weight:600">Choose a model · ${MODEL_LIST.length}</span>`;
    const x = document.createElement("button");
    x.textContent = "✕";
    x.style.cssText = "border:0;background:transparent;color:#bbb;font-size:15px;cursor:pointer;padding:2px 4px;";
    x.onclick = (e) => {
      e.stopPropagation();
      hideGallery();
    };
    head.appendChild(x);
    gallery.appendChild(head);
    dragByHeader(gallery, head, (px, py) => {
      _galleryPos = { x: px, y: py };
    });
    const grid = document.createElement("div");
    grid.id = "avgrid";
    grid.style.cssText =
      "display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:9px;padding:13px 15px;overflow-y:auto;overflow-x:hidden;";
    if (!MODEL_LIST.length) {
      // empty library (e.g. every model deleted) → say so, don't just show a lone Add card
      const empty = document.createElement("div");
      empty.style.cssText =
        "grid-column:1/-1;text-align:center;opacity:.7;font-size:12px;line-height:1.5;padding:8px 4px;";
      empty.textContent =
        "No models yet — drop a .glb / .vrm / .fbx onto the avatar, or use “Add model…”. (The placeholder avatar is showing meanwhile.)";
      grid.appendChild(empty);
    }
    for (const m of MODEL_LIST) grid.appendChild(cardFor(m));
    const add = document.createElement("div");
    add.id = "avadd";
    add.style.cssText =
      "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:8px 6px;border-radius:9px;cursor:pointer;border:2px dashed rgba(255,255,255,.22);min-height:120px;color:#bbb;";
    add.innerHTML = `<div style="font-size:26px;line-height:1">＋</div><div style="font-size:11px">Add model…</div>`;
    add.onclick = (e) => {
      e.stopPropagation();
      hideGallery();
      addModel();
    };
    grid.appendChild(add);
    gallery.appendChild(grid);
  }
  function showGallery() {
    _confirmRemove = null;
    _renameId = null;
    buildGallery();
    gallery.style.display = "flex";
    if (_galleryPos) {
      gallery.style.left = _galleryPos.x + "px";
      gallery.style.top = _galleryPos.y + "px";
    } else {
      const r = gallery.getBoundingClientRect();
      gallery.style.left = Math.max(6, Math.round(innerWidth / 2 - r.width / 2)) + "px";
      gallery.style.top = Math.max(6, Math.round(innerHeight / 2 - r.height / 2)) + "px";
    }
    galleryShown = true;
    api.syncInteractive();
  }
  function hideGallery() {
    if (!galleryShown) return;
    gallery.style.display = "none";
    galleryShown = false;
    _confirmRemove = null;
    _renameId = null;
    api.syncInteractive();
  }

  function rebuildMenu() {
    const curKey = api.getCurKey();
    const attachObjs = api.getAttachObjs();
    menu.innerHTML = "";
    // One entry → the visual gallery (pick / add / remove there). The accel hint shows what's loaded.
    const cur = MODEL_LIST.find((m) => m.url === curKey);
    menu.appendChild(
      menuRow("Choose model…", {
        accel: cur ? cur.label : "",
        onClick: () => {
          hideMenu();
          showGallery();
        },
      })
    );
    menu.appendChild(
      submenu("Add to avatar", [
        { label: "Clothing…", onClick: () => addAttachment("clothes") },
        { label: "Prop…", onClick: () => addAttachment("prop") },
        { label: "Furniture…", onClick: () => addAttachment("furniture") },
      ])
    );
    if (attachObjs.length)
      menu.appendChild(
        submenu(
          `Remove (${attachObjs.length})`,
          attachObjs
            .map((a) => ({
              label: `${a.category}: ${baseName(a.url)}`,
              onClick: () => {
                api.detachAttachment(a.id);
                hideMenu();
              },
            }))
            .concat([
              {
                label: "— all —",
                onClick: () => {
                  api.clearAttachments();
                  hideMenu();
                },
              },
            ])
        )
      );
    menu.appendChild(menuSep());
    if (api.ball)
      menu.appendChild(
        submenu(
          "Ball",
          BALL_ACTIONS.map((m) => ({ label: m.label, onClick: () => api.ball(m.name) }))
        )
      ); // rapier ball-physics toys (the Express emotes + gesture catalog were purged 2026-06-25 — motion is AI-authored)
    // Resize = scroll wheel (or +/- keys); monitor = drag across an edge or Ctrl+Shift+Alt+M.
    menu.appendChild(menuSep());
    menu.appendChild(
      menuRow("Settings…", {
        onClick: () => {
          hideMenu();
          showSettings();
        },
      })
    );
    if (avatarIPC?.quit) {
      menu.appendChild(menuSep());
      menu.appendChild(
        // accel label MUST match the real registration in shell/main.cjs (Ctrl+SHIFT+Alt — plain
        // Ctrl+Alt IS AltGr on EU layouts, the 2026-06-12 fix). The menu said "Ctrl+Alt+Q" for
        // three weeks; caught in a model-zoo snap 2026-07-02.
        menuRow("Quit avatar", { accel: "Ctrl+Shift+Alt+Q", danger: true, onClick: () => avatarIPC.quit() })
      );
    }
  }
  function showMenu(x, y) {
    rebuildMenu();
    menu.style.display = "block";
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + "px";
    menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + "px";
    menuShown = true;
    api.syncInteractive();
  }
  function hideMenu() {
    if (!menuShown) return;
    menu.style.display = "none";
    menuShown = false;
    api.syncInteractive();
  }

  return {
    showMenu,
    hideMenu,
    showSettings,
    hideSettings,
    showGallery,
    hideGallery,
    refreshModelList,
    getModels: () => MODEL_LIST.slice(), // the live, already-fetched model list (avatar.js startup + number-key hotkeys read this — no extra folder scan)
    isOpen: () => menuShown || settingsShown || galleryShown,
    isSettingsOpen: () => settingsShown,
    containsEvent: (target) =>
      target instanceof Node && (menu.contains(target) || settings.contains(target) || gallery.contains(target)),
  };
}
