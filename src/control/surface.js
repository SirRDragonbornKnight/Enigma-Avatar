// surface.js — the AI/host control surface `EnigmaAvatar` (extracted from avatar.js, Phase 3 carve 3).
//
// This is the public object every driver talks to: the bus (src/control/bus.js) dispatches onto it,
// the query reporter (src/control/query.js) reads through it, devtools/globals poke it, and it owns
// `connect()` (the WebSocket bus loop). It is a FACADE — most methods delegate to engine functions
// or read engine state; the real work lives in the modules it calls. Co-locating it here puts the
// whole AI control plane (surface + bus + query) in one folder.
//
// WIRING: avatar.js calls createControlSurface(engine, services) once, after the engine functions
// exist. Two arguments keep it correct:
//   * `engine` — the live STATE CONTAINER (engine/state.js). MUTABLE state (proc/facial/spring/model/
//     vrm/sizeScale/... — all reassigned over the avatar's life) is read through it as engine.proc,
//     engine.model, … so a method always sees current truth without snapshotting a frozen value. The
//     two look primitives the render loop reads are written back (engine.cursorIdle / engine.forceLookUntil),
//     and the stable in-place objects (pos/cursor/LOOK/eyeCfg/CONJURE_ASSETS) are shared off it too.
//     Things defined LATER in avatar.js (ui, handleCommand, the ui* relays) are live accessors on
//     engine — only ever read at runtime (settings/state/connect), never at build.
//   * `services` — the stable delegate functions/behavior (glideTo, applySize, recolor, onAiCommand, …).
import * as THREE from "three";

export function createControlSurface(engine, services) {
  const {
    // delegate functions + behavior (stable — the engine's verbs)
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
    onAiCommand, // notified with the action name of each ACCEPTED command (drives the activity flash)
  } = services;
  // Stable in-place state objects (mutated, never reassigned) — read straight off the live container.
  const { pos, cursor, LOOK, eyeCfg, CONJURE_ASSETS } = engine;

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
    size: () => engine.sizeScale,
    load(url) {
      engine.uiLoadModel(url, url);
    }, // relayed — a devtools/global load must reach every window like any other
    matched: () => {
      const proc = engine.proc;
      return proc ? proc.matched : [];
    },
    state: () => {
      const proc = engine.proc,
        spring = engine.spring,
        facial = engine.facial,
        vrm = engine.vrm;
      return {
        held: engine.held,
        size: +engine.sizeScale.toFixed(2),
        dims: [+(engine.modelDims.w || 0).toFixed(2), +(engine.modelDims.h || 0).toFixed(2)],
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
        attachments: engine.attachObjs.map((a) => ({ id: a.id, category: a.category, attachedTo: a.attachedTo })),
        toggles: {
          spring: engine.springOn,
          facial: engine.facialOn,
          look: engine.lookOn,
          locked: engine.locked,
          rotateMode: engine.rotateMode,
          menu: engine.ui.isOpen(),
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
      const proc = engine.proc;
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
      const proc = engine.proc;
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
      const proc = engine.proc;
      if (!proc?.setFingers) return { error: "no procedural rig on this model" };
      const side = c.side || "R";
      proc.setFingers(side, c.curl !== undefined ? c.curl : c.spec);
      wake(2);
      return { side, fingers: proc.fingerNames(side) };
    },
    capabilities: () => {
      const proc = engine.proc;
      return proc ? proc.capabilities() : null;
    }, // what the brain can drive on THIS model (roles, flex-able limbs, fingers, channels, limits)
    layers: () => {
      const proc = engine.proc;
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
      const proc = engine.proc;
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
    getLookMode: () => engine.lookMode,
    hasEyes: () => hasEyes(), // head / eyes / both
    eyeTune: (p) => Object.assign(eyeCfg, p), // adjust eye-look feel live (gain/flip/max — flip if eyes point wrong). Global now; not persisted per-model.
    lookAt: (px, py) => {
      // force gaze at a screen point (AI / test). #18: opens a short forced channel so it drives even with cursor-follow off, and reports whether the gaze ACTUALLY drove.
      cursor.x = px == null || !Number.isFinite(+px) ? innerWidth / 2 : +px; // coerce: a bus lookAt with NaN/Infinity/string must not poison the look smoother (would freeze cursor-look until reload)
      cursor.y = py == null || !Number.isFinite(+py) ? innerHeight / 2 : +py;
      cursor.seen = true;
      engine.cursorIdle = 0;
      engine.forceLookUntil = performance.now() + 1200;
      wake(2);
      const proc = engine.proc;
      const drove = !!(proc && proc.setLook); // a model with no head/eye look channel can't gaze — say so honestly instead of faking success
      return { lookAt: [Math.round(cursor.x), Math.round(cursor.y)], drove, channel: engine.lookMode };
    },
    facialTune: (p) => facialTune(p), // saved per-avatar (jaw axis/open)
    mouth: (a) => {
      const facial = engine.facial;
      const n = +a;
      if (facial && isFinite(n)) facial.setMouth(n);
    }, // 0..1 jaw/mouth open — coerce + guard (the bus is stringly-typed; a NaN would freeze the smoother)
    setMorph: (i, v) => {
      const model = engine.model;
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
      const model = engine.model;
      let n = 0;
      model?.traverse((o) => {
        if (o.isMesh && o.morphTargetInfluences) n = Math.max(n, o.morphTargetInfluences.length);
      });
      return n;
    }, // how many morph targets to probe across
    say: (url, opts) => voice.speak(url, opts), // play speech audio + lip-sync
    stopSpeak: () => voice.stop(),
    attach: (url, opts) => engine.uiAttach(url, opts), // prop/accessory → bone (opts: bone,pos,rot,scale) — relayed (consistent ids + every window's copy)
    detach: (id) => engine.uiDetach(id),
    clearAttachments: () => engine.uiClearAttachments(),
    attachments: () =>
      engine.attachObjs.map((a) => ({
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
    bonesShown: () => engine.bonesShown,
    snap: (opts) => snapshot(opts || {}), // capture the avatar in isolation → PNG (inspect)
    settings: (open) => {
      if (open === false) engine.ui.hideSettings();
      else engine.ui.showSettings();
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
      const lab = profileFor(engine.curKey).meshLabels || {};
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
      const lab = profileFor(engine.curKey).boneLabels || {};
      const roleBones = engine.roleBones;
      const model = engine.model;
      const _weightMass = engine.weightMass;
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
    getRotateMode: () => engine.rotateMode, // drag-to-spin mode on/off
    connect(url = "ws://127.0.0.1:8765") {
      try {
        const ws = new WebSocket(url);
        ws.onopen = () => setStatus("AI bus connected");
        ws.onmessage = async (e) => {
          let c;
          try {
            c = JSON.parse(e.data);
          } catch {
            return;
          }
          if (!c || c.type === "reply") return;
          // Kill-switch: while AI control is paused, NOTHING the bus sends runs — drop it before
          // dispatch (queries included: paused means fully inert, revealing nothing). A reqId driver
          // still gets an honest "paused" reply so it isn't left hanging.
          if (engine.aiPaused) {
            if (c.reqId != null) {
              try {
                ws.send(
                  JSON.stringify({
                    type: "reply",
                    reqId: c.reqId,
                    action: c.action,
                    result: { error: "ai control paused" },
                  })
                );
              } catch {}
            }
            return;
          }
          let result;
          try {
            if (onAiCommand) onAiCommand(c.action); // surface the accepted command (no-surprises indicator)
            result = engine.handleCommand(c);
            // A few handlers are async (e.g. `snap` resolves the written PNG's path); await before we
            // reply so a reqId driver gets the real result, not a serialized Promise. Sync handlers
            // return non-thenables and are untouched. Dispatch already ran synchronously above, so
            // command-application order is preserved; only this reqId reply is deferred to the resolve.
            if (result && typeof result.then === "function") result = await result;
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
