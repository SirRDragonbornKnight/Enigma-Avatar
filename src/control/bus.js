// bus.js — the AI bus command registry (extracted from avatar.js, Phase 3 carve 1).
//
// One declarative table instead of a 38-branch if/else chain: action name -> handler(c).
// Handlers that RETURN a value answer the bus caller (results relay back over the socket);
// void handlers (block body, no return) reply `undefined` — this split is load-bearing, so it
// mirrors the original chain exactly. Guards that gated a branch (e.g. `load` needs `url`) live
// INSIDE the handler as an early return. Aliases are wired after the table (snap/screenshot, etc.).
// (Removed bus actions stay removed: `express`, `anim` — the AI authors emotion via pose/flex.)
//
// WIRING: avatar.js calls createBusRegistry(api) AFTER every dependency exists (the control
// surface, the ui object, the ui* relays). State the handlers read LIVE (facial / spring /
// springOn / bonesShown / rotateMode / platforms / curDisp are reassigned over the avatar's
// life) is passed as getter thunks, never frozen values, so a handler always sees current truth.
export function createBusRegistry(api) {
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
    uiSetLookMode,
    uiSetBoneLabel,
    uiHighlightBone,
    uiDeleteOutfit,
    uiSaveOutfit,
    uiWearOutfit,
    uiSetPlatforms,
    uiHueShift,
    // live-state getters (read at handler-call time, never captured)
    getFacial,
    getSpring,
    getSpringOn,
    getBonesShown,
    getRotateMode,
    getPlatforms,
    getCurDisp,
  } = api;

  const COMMANDS = {
    moveTo: (c) => {
      EnigmaAvatar.moveTo(c.px ?? 0, c.py ?? 0);
    },
    goTo: (c) => EnigmaAvatar.goTo(c.to ?? c.anchor ?? (c.px != null ? { px: c.px, py: c.py } : "center")), // by name ("center"/"cursor"/…) or {px,py}
    size: (c) => {
      EnigmaAvatar.setSize(c.value ?? 1);
    },
    load: (c) => {
      if (c.url) EnigmaAvatar.load(c.url);
    },
    ball: (c) => EnigmaAvatar.ball(c.name ?? c.value), // rapier ball toy: throwball / dropball / clearballs
    say: (c) => {
      if (c.url) EnigmaAvatar.say(c.url, c); // play speech wav + lip-sync (+talk body language)
    },
    mouth: (c) => {
      EnigmaAvatar.mouth(c.value); // manual jaw drive (testing) — coerced+guarded inside
    },
    blink: (c) => {
      const n = +c.value;
      if (c.value != null && isFinite(n)) getFacial()?.setBlink?.(n);
      else getFacial()?.blink?.();
    }, // finite value HOLDS the lids (wink/squint; <0 resumes auto); no/garbage value = ONE quick blink
    setMorph: (c) => {
      EnigmaAvatar.setMorph(c.index ?? c.idx ?? 0, c.value); // probe a morph by index (transient)
    },
    stop: () => {
      EnigmaAvatar.stopSpeak();
    },
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
    springTune: (c) => {
      const { action, reqId, ...p } = c;
      uiSpringTune(p); // live hair tuning (saved)
    },
    facialTune: (c) => {
      const { action, reqId, ...p } = c;
      uiFacialTune(p);
    },
    showBones: (c) => uiShowSkeleton(c.on ?? c.value ?? !getBonesShown()), // resolved HERE so every window flips in lockstep
    snap: (c) => {
      EnigmaAvatar.snap(c); // capture avatar -> PNG for inspection
    },
    setDisplay: (c) => {
      window.avatarIPC?.monitor?.(c.index ?? c.value ?? "next"); // index or "next"/"prev" — main owns the layout
    },
    settings: (c) => {
      if (c.open === false) ui.hideSettings();
      else ui.showSettings();
    },
    gallery: (c) => {
      if (c.open === false) ui.hideGallery();
      else ui.showGallery();
    },
    recolor: (c) => {
      if (c.index == null && !c.name) return;
      return uiRecolor(c.index != null ? c.index : c.name, c.color || c.hex); // tint by INDEX (authority) or name — relayed
    },
    resetColors: () => uiResetColors(), // restore every part to its loaded color
    setMesh: (c) => uiSetMeshVisible(c.index ?? c.idx ?? 0, c.on ?? c.value ?? false), // show/hide a mesh by index
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
    regionWeight: (c) => {
      if (!c.region) return;
      return uiSetRegionWeight(c.region, c.weight ?? c.value ?? 1); // soft-body jiggle per area (saved)
    },
    impulse: (c) => {
      if (!c.region) return;
      wake(2);
      const spring = getSpring();
      return spring && getSpringOn() && spring.impulse ? spring.impulse(c.region, c, c.dur) : false; // kick an appendage (tail swish / ear flick); no-op while springs off
    },
    morph: (c) => uiSetMorphValue(c.index ?? c.idx ?? 0, c.value), // drive + SAVE a morph (vs 'setMorph' = transient)
    rotateMode: (c) => uiSetRotateMode(c.on ?? c.value ?? !getRotateMode()), // drag-to-spin on/off (lockstep)
    lookMode: (c) => uiSetLookMode(c.mode ?? c.value), // cursor-look: head / eyes / both
    lookAt: (c) => EnigmaAvatar.lookAt(c.px, c.py), // force gaze at a screen point — returns {drove}
    nameBone: (c) => {
      if (!c.bone) return;
      return uiSetBoneLabel(String(c.bone), c.label ?? ""); // label a bone in plain words (saved; empty clears)
    },
    highlightBone: (c) => {
      if (!c.bone) return;
      return uiHighlightBone(String(c.bone), c.dur); // flash a marker on a bone (point AT a part)
    },
    outfit: (c) => {
      if (!c.name) return;
      return c.delete ? uiDeleteOutfit(c.name) : c.save ? uiSaveOutfit(c.name) : uiWearOutfit(c.name); // wear / {save} / {delete}
    },
    platform: (c) => {
      // AI effect surfaces: {px,py,w} adds one (screen px on her monitor); {clear:true} wipes all
      if (c.clear) return uiSetPlatforms([]);
      const platforms = getPlatforms();
      if (isFinite(+c.px) && isFinite(+c.py)) {
        const curDisp = getCurDisp();
        return uiSetPlatforms([...platforms, { gx: curDisp.x + +c.px, gy: curDisp.y + +c.py, w: +c.w || 220 }]);
      }
      return platforms.length;
    },
    hue: (c) => {
      if (c.name) uiHueShift(c.name, c.deg ?? c.value ?? 0); // rotate a material's hue — relayed
    },
    pose: (c) => EnigmaAvatar.poseLayer(c), // compositor: set a motion layer {parts,flex,dur,weight,env,id}
    layer: (c) => EnigmaAvatar.layer(c), // compositor: layer-stack op add|clear|clearAll
    fingers: (c) => EnigmaAvatar.fingers(c), // per-finger hand pose (fist / point / count / "no" wag)
    capabilities: () => EnigmaAvatar.capabilities(), // what the brain can drive on THIS model
    conjure: (c) => EnigmaAvatar.conjure(c), // spawn/move/dismiss/clear a conjured prop
    perform: (c) => EnigmaAvatar.perform(c.text), // drive motion from inline-tagged LLM speech; returns the clean line
    query: (c) => answerQuery(c.what), // AI self-report: live ground truth
  };
  // Aliases — same handler under a second name (kept identical to the old `||` branches).
  COMMANDS.screenshot = COMMANDS.snap;
  COMMANDS.monitor = COMMANDS.setDisplay;
  COMMANDS.hand = COMMANDS.fingers;
  COMMANDS.caps = COMMANDS.capabilities;

  function handleCommand(c) {
    const fn = c && typeof c.action === "string" ? COMMANDS[c.action] : null;
    return fn ? fn(c) : undefined; // unknown/garbage action -> silent no-op (matches the old fall-through)
  }

  return { COMMANDS, handleCommand };
}
