// surface.js — the AI/host control surface `EnigmaAvatar` (extracted from avatar.js, Phase 3 carve 3).
//
// This is the public object every driver talks to: the bus (src/control/bus.js) dispatches onto it,
// the query reporter (src/control/query.js) reads through it, devtools/globals poke it, and it owns
// `connect()` (the WebSocket bus loop). It is a FACADE — most methods delegate to engine functions
// or read engine state; the real work lives in the modules it calls. Co-locating it here puts the
// whole AI control plane (surface + bus + query) in one folder.
//
// WIRING: avatar.js calls createControlSurface(api) once, after the engine functions exist. Because
// it is the hub of the closure, the api is large. Two rules keep it correct:
//   * MUTABLE engine state (proc/facial/spring/model/vrm/sizeScale/... — all reassigned over the
//     avatar's life) is read through getter thunks, snapshotted at the TOP of each method so the body
//     stays verbatim and always sees current truth; never frozen values.
//   * Things defined LATER in avatar.js (ui at ~3047, handleCommand at ~3117) come in as getters too
//     (getUi/getHandleCommand) — only ever called at runtime (settings/state/connect), never at build.
//   * `pos`/`cursor`/`LOOK`/`eyeCfg`/`CONJURE_ASSETS` are stable objects mutated in place, passed
//     directly. `lookAt` also WRITES two primitives the render loop reads (_cursorIdle/_forceLookUntil)
//     — those come in as setter thunks (setCursorIdle/setForceLookUntil).
import * as THREE from "three";

export function createControlSurface(api) {
  const {
    // delegate functions (stable)
    glideTo,
    nudge,
    goTo,
    whereAmI,
    applySize,
    springTune,
    facialTune,
    throwBall,
    dropBall,
    physics,
    setStatus,
    voice,
    tuneAttachment,
    showSkeleton,
    snapshot,
    allMaterialsInfo,
    recolor,
    hueShift,
    resetColors,
    profileFor,
    allMeshesInfo,
    setMeshVisible,
    setMeshLabel,
    setBoneLabel,
    setRot,
    setYaw,
    setRotAxis,
    getRot,
    springRegions,
    setRegionWeight,
    allMorphsInfo,
    setMorphValue,
    setRotateMode,
    posScreen,
    conjurer,
    resolvePropName,
    parseControlTags,
    parseTagArg,
    lookTarget,
    wake,
    setLookMode,
    hasEyes,
    // stable objects (mutated in place)
    pos,
    cursor,
    LOOK,
    eyeCfg,
    CONJURE_ASSETS,
    // live-state getters (read at call time)
    getProc,
    getFacial,
    getSpring,
    getModel,
    getVrm,
    getSizeScale,
    getHeld,
    getModelDims,
    getSpringOn,
    getFacialOn,
    getLookOn,
    getLocked,
    getRotateMode,
    getBonesShown,
    getCurKey,
    getWeightMass,
    getAttachObjs,
    getLookMode,
    getRoleBones,
    getUi,
    getHandleCommand,
    // ui* relays are defined LATER in avatar.js (~2964) than this factory's call site (~2446), so they
    // come in as getters too — only ever invoked at runtime (load/attach/detach), never at build.
    getUiLoadModel,
    getUiAttach,
    getUiDetach,
    getUiClearAttachments,
    // setter thunks (lookAt writes primitives the render loop reads)
    setCursorIdle,
    setForceLookUntil,
  } = api;

  const EnigmaAvatar = {
    // (clip-playback API — actions / play / loopClip / playAnim / stopAnim — removed with the clip-library purge 2026-06-25)
    moveTo(px, py) {
      glideTo(px, py);
    }, // smooth-glide to screen px,py (stays there)
    nudge: (dx, dy) => nudge(dx, dy), // move by a fraction of the screen (arrow keys)
    glideTo: (px, py) => glideTo(px, py),
    goTo: (target) => goTo(target), // move by NAME ("center","topleft","cursor",…) — AI movement without pixel math
    where: () => whereAmI(), // her screen-px position + screen size + cursor (AI spatial awareness)
    setSize: (s) => applySize(s),
    size: () => getSizeScale(),
    load(url) {
      getUiLoadModel()(url, url);
    }, // relayed — a devtools/global load must reach every window like any other
    matched: () => {
      const proc = getProc();
      return proc ? proc.matched : [];
    },
    state: () => {
      const proc = getProc(),
        spring = getSpring(),
        facial = getFacial(),
        vrm = getVrm();
      return {
        held: getHeld(),
        size: +getSizeScale().toFixed(2),
        dims: [+(getModelDims().w || 0).toFixed(2), +(getModelDims().h || 0).toFixed(2)],
        pos: [+pos.x.toFixed(2), +pos.y.toFixed(2)],
        screen: [innerWidth, innerHeight],
        screenPos: posScreen(),
        cursorPx: [cursor.x | 0, cursor.y | 0],
        over: cursor.over,
        vrm: !!vrm,
        procBones: proc ? proc.matched : [],
        layers: proc && proc.layerIds ? proc.layerIds() : [],
        springBones: spring ? spring.names : [],
        facial: facial ? { mode: facial.mode, info: facial.info } : null,
        attachments: getAttachObjs().map((a) => ({ id: a.id, category: a.category, attachedTo: a.attachedTo })),
        toggles: {
          spring: getSpringOn(),
          facial: getFacialOn(),
          look: getLookOn(),
          locked: getLocked(),
          rotateMode: getRotateMode(),
          menu: getUi().isOpen(),
        },
      };
    },
    springTune: (p) => springTune(p), // saved per-avatar (hair flow, etc.)
    ball: (action) => {
      // rapier ball-physics toys: throw / drop / clear. NOT a gesture catalog (purged) — body motion is AI-authored via pose / flex / perform.
      const n = String(action || "")
        .toLowerCase()
        .replace(/[ _-]/g, "");
      if (n === "throwball" || n === "throw") {
        throwBall();
        return "throwball";
      } // rigid-body toy (rapier) — she hurls the baseball
      if (n === "dropball" || n === "drop") {
        dropBall();
        return "dropball";
      } // a ball drops onto her -> bounces off (she's solid)
      if (n === "clearballs" || n === "clearball") {
        physics.clearProps();
        setStatus("balls cleared");
        return "clearballs";
      }
      setStatus("no such ball action: " + n);
      return { error: `'${n}' is not a ball action — use throwball / dropball / clearballs` };
    },
    poseLayer: (c = {}) => {
      // AI compositor: set ONE motion layer {parts,flex,dur,weight,env,id}; {clear:true} removes it
      const proc = getProc();
      if (!proc?.setLayer) return { error: "no procedural rig on this model" };
      const id = String(c.id || "ai_pose");
      if (c.clear) {
        proc.clearLayer(id);
        return { cleared: id };
      }
      if (!c.parts && !c.flex)
        return { error: "pose needs parts:{role:[pitch,yaw,roll]} and/or flex:{role:[ang,abd]}" };
      proc.setLayer(id, {
        parts: c.parts,
        flex: c.flex,
        weight: c.weight,
        amp: c.amp,
        speed: c.speed,
        dur: c.dur,
        env: c.env,
      });
      wake((+c.dur > 0 ? +c.dur : 1.6) + 0.4);
      return {
        posed: id,
        roles: [...Object.keys(c.parts || {}), ...Object.keys(c.flex || {})],
        layers: proc.layerIds(),
      };
    },
    layer: (c = {}) => {
      // AI compositor: manage the layer stack — op add|clear|clearAll
      const proc = getProc();
      if (!proc?.setLayer) return { error: "no procedural rig on this model" };
      const op = String(c.op || (c.clear ? "clear" : "add")).toLowerCase();
      if (op === "clearall") {
        proc.clearLayers();
        return { layers: [] };
      }
      if (op === "clear") {
        if (!c.id) return { error: "layer clear needs id" };
        proc.clearLayer(String(c.id));
        return { layers: proc.layerIds() };
      }
      if (!c.parts && !c.flex) return { error: "layer add needs parts and/or flex (fn layers are code-only)" };
      const id = String(c.id || "L" + (proc.layerIds().length + 1));
      proc.setLayer(id, {
        parts: c.parts,
        flex: c.flex,
        weight: c.weight,
        amp: c.amp,
        speed: c.speed,
        dur: c.dur,
        env: c.env,
      });
      wake((+c.dur > 0 ? +c.dur : 1.6) + 0.4);
      return { added: id, layers: proc.layerIds() };
    },
    fingers: (c = {}) => {
      // AI per-finger hand pose: {side:"L"|"R"|"both", curl: number(all) | {thumb|index|…|0..N: 0..1, default?} | null(release to grip)}
      const proc = getProc();
      if (!proc?.setFingers) return { error: "no procedural rig on this model" };
      const side = c.side || "R";
      proc.setFingers(side, c.curl !== undefined ? c.curl : c.spec);
      wake(2);
      return { side, fingers: proc.fingerNames(side) };
    },
    capabilities: () => {
      const proc = getProc();
      return proc ? proc.capabilities() : null;
    }, // what the brain can drive on THIS model (roles, flex-able limbs, fingers, channels, limits)
    layers: () => {
      const proc = getProc();
      return proc ? proc.layerIds() : [];
    },
    conjure: (c = {}) => {
      // P3: make an object appear and move it (transform-based)
      if (c.clear) {
        conjurer.clear();
        return { conjured: [] };
      }
      if (c.dismiss) {
        conjurer.dismiss(String(c.dismiss));
        return { dismissed: c.dismiss, ids: conjurer.ids() };
      }
      if (c.move && c.to) {
        conjurer.moveTo(String(c.move), c.to, { dur: c.dur });
        return { moved: c.move };
      }
      const url = resolvePropName(c.url, CONJURE_ASSETS);
      if (!url)
        return { error: "conjure needs a .glb path or a known prop name (e.g. 'ball') | move+to | dismiss | clear" };
      const id = conjurer.spawn(url, { id: c.id, size: c.size, at: c.at, bone: c.bone, dur: c.dur, float: c.float });
      wake(2);
      return { conjured: id, ids: conjurer.ids() };
    },
    perform: (text) => {
      // P4 substrate: tagged speech -> motion + the clean line to TTS
      const proc = getProc();
      const { clean, tags } = parseControlTags(text);
      const did = [];
      for (const { type, arg } of tags) {
        if (type === "conjure" && arg) {
          const url = resolvePropName(arg, CONJURE_ASSETS);
          if (url) {
            conjurer.spawn(url, { bone: "right_hand", dur: 8, float: 0.05 });
            wake(2);
            did.push("conjure:" + arg);
          } else did.push("conjure-skip:" + arg + " (unknown prop - pass a .glb path or a known name)");
        } else if (type === "dismiss") {
          arg ? conjurer.dismiss(arg) : conjurer.clear();
          did.push("dismiss");
        } else if (type === "pose") {
          const f = parseTagArg(arg);
          if (f && typeof f === "object" && proc?.setLayer) {
            const parts = {};
            for (const k in f) parts[k] = Array.isArray(f[k]) ? f[k] : [+f[k] || 0, 0, 0];
            proc.setLayer("ai_pose", { parts, dur: 2.5, env: [0.25, 0.5] });
          }
          wake(3);
          did.push("pose");
        } else if (type === "look") {
          const lt = lookTarget(arg, innerWidth, innerHeight); // pure resolver (exported + regression-tested): named dir OR explicit px,py with minus signs preserved
          if (lt) {
            EnigmaAvatar.lookAt(lt.x, lt.y);
            did.push("look:" + lt.label);
          } else did.push("look-skip:" + arg); // unrecognized -> HONEST no-op, not a false 'look:'+arg success
        } else did.push("skip:" + type); // an [emotion]/unknown tag: body expressions were purged — the AI authors emotion via pose/flex layers now
      }
      return { say: clean, performed: did };
    },
    lookTune: (p) => Object.assign(LOOK, p), // tune/flip cursor-look (gainX/Y, flipX/Y, maxX/Y)
    lookMode: (m) => setLookMode(m),
    getLookMode: () => getLookMode(),
    hasEyes: () => hasEyes(), // head / eyes / both
    eyeTune: (p) => Object.assign(eyeCfg, p), // adjust eye-look feel live (gain/flip/max — flip if eyes point wrong). Global now; not persisted per-model.
    lookAt: (px, py) => {
      // force gaze at a screen point (AI / test). #18: opens a short forced channel so it drives even with cursor-follow off, and reports whether the gaze ACTUALLY drove.
      cursor.x = px == null || !Number.isFinite(+px) ? innerWidth / 2 : +px; // coerce: a bus lookAt with NaN/Infinity/string must not poison the look smoother (would freeze cursor-look until reload)
      cursor.y = py == null || !Number.isFinite(+py) ? innerHeight / 2 : +py;
      cursor.seen = true;
      setCursorIdle(0);
      setForceLookUntil(performance.now() + 1200);
      wake(2);
      const proc = getProc();
      const drove = !!(proc && proc.setLook); // a model with no head/eye look channel can't gaze — say so honestly instead of faking success
      return { lookAt: [Math.round(cursor.x), Math.round(cursor.y)], drove, channel: getLookMode() };
    },
    facialTune: (p) => facialTune(p), // saved per-avatar (jaw axis/open)
    mouth: (a) => {
      const facial = getFacial();
      const n = +a;
      if (facial && isFinite(n)) facial.setMouth(n);
    }, // 0..1 jaw/mouth open — coerce + guard (the bus is stringly-typed; a NaN would freeze the smoother)
    setMorph: (i, v) => {
      const model = getModel();
      const amt = v == null ? 1 : +v;
      if (!isFinite(amt)) return 0;
      let n = 0;
      model?.traverse((o) => {
        if (o.isMesh && o.morphTargetInfluences && i < o.morphTargetInfluences.length) {
          o.morphTargetInfluences[i] = amt;
          n++;
        }
      });
      setStatus(`morph #${i} → ${amt} on ${n} mesh(es)`);
      return n;
    }, // probe morphs BY INDEX (name-free) to find the mouth; NaN never reaches the GPU
    morphCount: () => {
      const model = getModel();
      let n = 0;
      model?.traverse((o) => {
        if (o.isMesh && o.morphTargetInfluences) n = Math.max(n, o.morphTargetInfluences.length);
      });
      return n;
    }, // how many morph targets to probe across
    say: (url, opts) => voice.speak(url, opts), // play speech audio + lip-sync
    stopSpeak: () => voice.stop(),
    attach: (url, opts) => getUiAttach()(url, opts), // prop/accessory → bone (opts: bone,pos,rot,scale) — relayed (consistent ids + every window's copy)
    detach: (id) => getUiDetach()(id),
    clearAttachments: () => getUiClearAttachments()(),
    attachments: () =>
      getAttachObjs().map((a) => ({
        id: a.id,
        category: a.category,
        url: a.url,
        bone: a.bone,
        attachedTo: a.attachedTo,
        pos: a.pos,
        rot: a.rot,
        scale: a.scale,
      })),
    tuneAttachment: (id, opts) => tuneAttachment(id, opts), // live placement: {bone,pos:[x,y,z],rot:[deg],scale}
    showSkeleton: (on) => showSkeleton(on), // overlay the rig to inspect bones; persists
    bonesShown: () => getBonesShown(),
    snap: (opts) => snapshot(opts || {}), // capture the avatar in isolation → PNG (inspect)
    settings: (open) => {
      if (open === false) getUi().hideSettings();
      else getUi().showSettings();
    }, // open/close Settings — tray escape hatch (reach it when she can't be clicked) + AI
    materials: () =>
      allMaterialsInfo().map(({ m, mesh }, index) => ({
        index,
        name: m.name || null,
        mesh,
        hex: m.color ? "#" + m.color.getHexString(THREE.SRGBColorSpace) : null,
      })), // recolorable parts BY INDEX (live authority); name+mesh are hints only
    recolor: (target, hex) => recolor(target, hex), // tint a part by INDEX (live authority) or name; saved per avatar
    hueShift: (name, deg) => hueShift(name, deg), // rotate a part's hue (keeps detail); saved
    resetColors: () => resetColors(), // restore every part's original loaded color (+ clear saved tints/hue)
    meshes: () => {
      const lab = profileFor(getCurKey()).meshLabels || {};
      return allMeshesInfo().map(({ mesh, name }, index) => ({
        index,
        name: name || null,
        label: lab[index] || null,
        visible: mesh.visible,
      }));
    }, // sub-objects BY INDEX (+ user label)
    setMeshVisible: (i, on) => setMeshVisible(i, on), // show/hide a mesh by index; saved per avatar
    setMeshLabel: (i, label) => setMeshLabel(i, label), // give a part a legible name (saved per avatar)
    bones: () => {
      // every bone: raw name + user label + resolved role + REAL mesh influence (Settings naming / AI addressing)
      const lab = profileFor(getCurKey()).boneLabels || {};
      const roleBones = getRoleBones();
      const model = getModel();
      const _weightMass = getWeightMass();
      const roleOf = {};
      for (const r in roleBones) if (roleBones[r]) roleOf[roleBones[r].name] = r;
      const out = [];
      model?.traverse((o) => {
        if (!o.isBone) return;
        const mass = _weightMass ? +(_weightMass.get(o) || 0).toFixed(1) : null;
        out.push({
          name: o.name,
          label: lab[o.name] || null,
          role: roleOf[o.name] || null,
          mass,
          deforms: mass == null ? null : mass > 0.5,
        });
      });
      out.sort((a, b) => (b.role ? 1 : 0) - (a.role ? 1 : 0) || (b.mass || 0) - (a.mass || 0)); // the bones that MATTER first: roles, then by how much mesh they really move ("the bone system seems bad" = 593 soup rows; user 2026-06-12)
      return out;
    },
    setBoneLabel: (n, l) => setBoneLabel(n, l), // name a bone (saved per avatar)
    rotate: (r) => (r && typeof r === "object" ? setRot(r) : setYaw(r)), // {x,y,z}° (all axes) or a bare yaw number; saved
    setRotAxis: (axis, deg) => setRotAxis(axis, deg),
    rotation: () => getRot(), // per-axis turn (pitch X / yaw Y / roll Z)
    springRegions: () => springRegions(), // [{region,count,weight,nsfw}] — soft-body areas present
    setRegionWeight: (region, w) => setRegionWeight(region, w), // how much an area jiggles (0=rigid..>1 bouncy); saved
    morphs: () => allMorphsInfo(), // [{index,name,value}] — the model's own shape keys (toggles/expressions)
    setMorphValue: (i, v) => setMorphValue(i, v), // drive a morph by index 0..1; saved (vs setMorph = transient probe)
    rotateMode: (on) => setRotateMode(on),
    getRotateMode: () => getRotateMode(), // drag-to-spin mode on/off
    connect(url = "ws://127.0.0.1:8765") {
      try {
        const ws = new WebSocket(url);
        ws.onopen = () => setStatus("AI bus connected");
        ws.onmessage = (e) => {
          let c;
          try {
            c = JSON.parse(e.data);
          } catch {
            return;
          }
          if (!c || c.type === "reply") return;
          let result;
          try {
            result = getHandleCommand()(c);
          } catch (err) {
            result = { error: String((err && err.message) || err) };
          }
          if (c.reqId != null) {
            try {
              ws.send(JSON.stringify({ type: "reply", reqId: c.reqId, action: c.action, result }));
            } catch {}
          }
        };
        ws.onclose = () => setTimeout(() => EnigmaAvatar.connect(url), 4000);
        ws.onerror = () => ws.close();
      } catch (err) {
        console.error(err);
      }
    },
  };

  return EnigmaAvatar;
}
