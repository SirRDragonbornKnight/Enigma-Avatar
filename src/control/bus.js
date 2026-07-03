// bus.js — the AI bus command registry (the MOVE SET).
//
// One declarative table instead of a long if/else chain: action name -> handler(c). A driving AI
// sends {action, ...} over the socket and the registry dispatches. Handlers that RETURN a value
// answer the caller (the result relays back over the socket); void handlers (block body, no return)
// reply `undefined` — this split is load-bearing. Guards that gate a branch (e.g. `load` needs `url`)
// live INSIDE the handler as an early return. Unknown/garbage action -> silent no-op (honest absence).
//
// VOCABULARY (2026-06-29 redesign — no backward-compat aliases): one name per concept. Four pairs
// that used to be two verbs for near-the-same thing were merged so a driver never has to guess which:
//   move   (was moveTo + goTo)      — {px,py} exact OR {to:"center"|"cursor"|...} by name
//   morph  (was morph + setMorph)   — drives+SAVES by default; {save:false} = transient probe
//   pose   (was pose + layer)       — set a compositor layer; {clear:"id"} one, {clear:true} all
// and two implementation-y names became intention names: setDisplay->monitor, setMesh->mesh.
// `query:"actions"` self-reports the live verb list (the AI's "what can I send?" — verify by numbers).
//
// WIRING: avatar.js calls createBusRegistry(engine, services) AFTER every dependency exists (the
// control surface, the ui object, the ui* relays). `services` holds the stable verbs (EnigmaAvatar,
// ui, wake, getRot, answerQuery, the ui* relays). `engine` is the live state container (built inline in avatar.js):
// handlers read facial / spring / springOn / bonesShown / rotateMode / platforms / curDisp off it as
// engine.facial, engine.springOn, … so they always see current truth (those are reassigned over the
// avatar's life) without ever capturing a frozen value.
export function createBusRegistry(engine, services) {
  const {
    EnigmaAvatar,
    ui,
    wake,
    getRot,
    answerQuery,
    uiAttach,
    uiDetach,
    uiClearAttachments,
    uiTuneAttachment,
    uiSpringTune,
    uiFacialTune,
    uiShowSkeleton,
    uiRecolor,
    uiResetColors,
    uiSetMeshVisible,
    uiSetRot,
    uiSetRotAxis,
    uiSetRegionWeight,
    uiSetMorphValue,
    uiSetRotateMode,
    uiSetBoneLabel,
    uiHighlightBone,
    uiDeleteOutfit,
    uiSaveOutfit,
    uiWearOutfit,
    uiSetPlatforms,
    uiHueShift,
  } = services;

  const COMMANDS = {
    // Null prototype: action names come off the wire, and a plain object literal inherits
    // Object.prototype — {action:"toString"} would dispatch and {action:"hasOwnProperty"} would
    // throw. With no prototype, every non-verb is the same honest no-op.
    __proto__: null,
    // --- MOTION ------------------------------------------------------------------------------------
    pose: (c) => {
      // compositor: set ONE motion layer {parts,flex,dur,weight,env,id}. Clearing is folded in here
      // (was the separate `layer` verb): {clear:true} wipes ALL layers, {clear:"<id>"} wipes one.
      if (c.clear === true || c.clear === "all") return EnigmaAvatar.layer({ op: "clearAll" });
      if (typeof c.clear === "string") return EnigmaAvatar.poseLayer({ id: c.clear, clear: true });
      return EnigmaAvatar.poseLayer(c);
    },
    fingers: (c) => EnigmaAvatar.fingers(c), // per-finger hand pose (fist / point / count / "no" wag)
    impulse: (c) => {
      if (!c.region) return;
      wake(2);
      const spring = engine.spring;
      return spring && engine.springOn && spring.impulse ? spring.impulse(c.region, c, c.dur) : false; // kick an appendage (tail swish / ear flick); no-op while springs off
    },
    perform: (c) => EnigmaAvatar.perform(c.text), // drive motion from inline-tagged LLM speech; returns the clean line

    // --- VOICE -------------------------------------------------------------------------------------
    say: (c) => {
      if (c.url) EnigmaAvatar.say(c.url, c); // play speech wav + lip-sync (+talk body language)
    },
    stop: () => {
      EnigmaAvatar.stopSpeak();
    },
    mouth: (c) => {
      EnigmaAvatar.mouth(c.value); // manual jaw drive (testing) — coerced+guarded inside
    },
    blink: (c) => {
      const n = +c.value;
      if (c.value != null && isFinite(n)) engine.facial?.setBlink?.(n);
      else engine.facial?.blink?.();
    }, // finite value HOLDS the lids (wink/squint; <0 resumes auto); no/garbage value = ONE quick blink

    // --- CONJURE (prop spawning) + the physics-ball toy (distinct features) -------------------------
    conjure: (c) => EnigmaAvatar.conjure(c), // spawn/move/dismiss/clear a conjured prop (transform-based)
    ball: (c) => EnigmaAvatar.ball(c.name ?? c.value), // rapier ball-physics toy: throwball / dropball / clearballs

    // --- PLACE / TRANSFORM -------------------------------------------------------------------------
    move: (c) => {
      // place her: {px,py} = pixel-exact on her monitor; {to:"center"|"cursor"|"topleft"|...} = by name.
      // {dur} (s) = timed glide. Replies with the ACCEPTED target {px,py,clamped} — never silent.
      const dur = +c.dur > 0 ? +c.dur : undefined;
      if (c.to != null || c.anchor != null) return EnigmaAvatar.goTo(c.to ?? c.anchor, dur);
      if (c.px != null || c.py != null) return EnigmaAvatar.moveTo(c.px ?? 0, c.py ?? 0, dur);
      return EnigmaAvatar.goTo("center", dur);
    },
    size: (c) => EnigmaAvatar.setSize(c.value ?? 1, c.anchor), // optional anchor "hips"|"head" pins that point on screen; replies {size,anchor,anchorClamped}
    rotate: (c) => {
      // turn the avatar — {x,y,z}°, {axis,deg}, or legacy {deg}=yaw
      if (c.x != null || c.y != null || c.z != null) {
        const r = getRot();
        if (c.x != null) r.x = +c.x;
        if (c.y != null) r.y = +c.y;
        if (c.z != null) r.z = +c.z;
        return uiSetRot(r);
      }
      if (c.axis) return uiSetRotAxis(c.axis, c.deg ?? c.value ?? 0);
      return uiSetRotAxis("y", c.deg ?? c.value ?? 0);
    },
    rotateMode: (c) => uiSetRotateMode(c.on ?? c.value ?? !engine.rotateMode), // drag-to-spin on/off (lockstep)
    monitor: (c) => {
      window.avatarIPC?.monitor?.(c.index ?? c.value ?? "next"); // index or "next"/"prev" — main owns the layout (was setDisplay)
    },
    platform: (c) => {
      // AI effect surfaces: {px,py,w} adds one (screen px on her monitor); {clear:true} wipes all
      if (c.clear) return uiSetPlatforms([]);
      const platforms = engine.platforms;
      if (isFinite(+c.px) && isFinite(+c.py)) {
        const curDisp = engine.curDisp;
        return uiSetPlatforms([...platforms, { gx: curDisp.x + +c.px, gy: curDisp.y + +c.py, w: +c.w || 220 }]);
      }
      return platforms.length;
    },

    // --- APPEARANCE --------------------------------------------------------------------------------
    load: (c) => {
      if (c.url) EnigmaAvatar.load(c.url);
    },
    recolor: (c) => {
      if (c.index == null && !c.name) return;
      return uiRecolor(c.index != null ? c.index : c.name, c.color || c.hex); // tint by INDEX (authority) or name — relayed
    },
    resetColors: () => uiResetColors(), // restore every part to its loaded color
    hue: (c) => {
      if (c.name) uiHueShift(c.name, c.deg ?? c.value ?? 0); // rotate a material's hue — relayed
    },
    mesh: (c) => uiSetMeshVisible(c.index ?? c.idx ?? 0, c.on ?? c.value ?? false), // show/hide a mesh by index (was setMesh)
    morph: (c) => {
      // drive a morph by index. Default drives + SAVES (relayed to every monitor); {save:false} is a
      // transient local probe (the old `setMorph` — used to hunt for the mouth morph). (was morph + setMorph.)
      const i = c.index ?? c.idx ?? 0;
      if (c.save === false) return EnigmaAvatar.setMorph(i, c.value);
      return uiSetMorphValue(i, c.value);
    },
    regionWeight: (c) => {
      if (!c.region) return;
      return uiSetRegionWeight(c.region, c.weight ?? c.value ?? 1); // soft-body jiggle per area (saved)
    },
    outfit: (c) => {
      if (!c.name) return;
      return c.delete ? uiDeleteOutfit(c.name) : c.save ? uiSaveOutfit(c.name) : uiWearOutfit(c.name); // wear / {save} / {delete}
    },
    springTune: (c) => {
      const { action, reqId, ...p } = c;
      uiSpringTune(p); // live hair tuning (saved)
    },
    facialTune: (c) => {
      const { action, reqId, ...p } = c;
      uiFacialTune(p);
    },

    // --- PROPS (attachments to bones) --------------------------------------------------------------
    attach: (c) => {
      if (!c.url) return;
      const { action, reqId, ...o } = c;
      return uiAttach(c.url, o); // prop/accessory -> bone — RELAYED to every monitor's copy
    },
    detach: (c) => {
      if (c.id) uiDetach(c.id);
      else uiClearAttachments();
    },
    tuneAttachment: (c) => {
      if (!c.id) return;
      const { action, reqId, ...o } = c;
      return uiTuneAttachment(c.id, o);
    },

    // --- SYSTEM / VERIFY-BY-NUMBERS ----------------------------------------------------------------
    capabilities: () => EnigmaAvatar.capabilities(), // what the brain can drive on THIS model
    query: (c) => (c.what === "actions" ? Object.keys(COMMANDS).sort() : answerQuery(c.what)), // self-report: the move set, or live ground truth
    snap: (c) => EnigmaAvatar.snap(c), // capture avatar -> PNG; returns {ok,path,width,height} so a driver gets the file back (async — the bus reply awaits it)
    showBones: (c) => uiShowSkeleton(c.on ?? c.value ?? !engine.bonesShown), // resolved HERE so every window flips in lockstep
    nameBone: (c) => {
      if (!c.bone) return;
      return uiSetBoneLabel(String(c.bone), c.label ?? ""); // label a bone in plain words (saved; empty clears)
    },
    highlightBone: (c) => {
      if (!c.bone) return;
      return uiHighlightBone(String(c.bone), c.dur); // flash a marker on a bone (point AT a part)
    },
    settings: (c) => {
      if (c.open === false) ui.hideSettings();
      else ui.showSettings();
    },
    gallery: (c) => {
      if (c.open === false) ui.hideGallery();
      else ui.showGallery();
    },
  };

  /**
   * Dispatch one inbound bus command onto its handler. The wire shape is the typed contract in
   * src/control/protocol.js (BusCommand union); an unknown/garbage action is an honest no-op
   * (undefined), never a throw.
   * @param {import("./protocol.js").BusCommand} c
   */
  function handleCommand(c) {
    const fn = c && typeof c.action === "string" ? COMMANDS[c.action] : null;
    return typeof fn === "function" ? fn(c) : undefined; // unknown/garbage action -> silent no-op (matches the old fall-through)
  }

  return { COMMANDS, handleCommand };
}
