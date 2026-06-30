// settings.test.js — exercises the actual Settings/menu DOM that ui.js builds, headless via
// jsdom. These lock the wiring the user hit as "some settings just do not work": every toggle
// must flip its flag, every material (incl. UNNAMED) must be recolorable BY INDEX, the hex field
// must recolor, Reset must reset, and Add-model's Remove counterpart must delete the right model.
import { test } from "node:test";
import assert from "node:assert";
import { installDOM, fire, makeApi } from "./dom.js";
import { createUI } from "../src/ui/ui.js";

const S = () => document.getElementById("avsettings");
const M = () => document.getElementById("avmenu");
function checkboxByLabel(text) {
  for (const lab of S().querySelectorAll("label"))
    if (lab.textContent.includes(text)) return lab.querySelector("input[type=checkbox]");
  return null;
}
function pointer(el, type, x, y) {
  const W = el.ownerDocument.defaultView;
  const e = new W.Event(type, { bubbles: true });
  e.clientX = x;
  e.clientY = y;
  e.pointerId = 1;
  e.buttons = type === "pointerup" ? 0 : 1; // primary button held during down + move (a real drag)
  el.dispatchEvent(e);
}

test("every flag-backed checkbox toggles its flag (no dead toggles)", () => {
  const dom = installDOM();
  try {
    const { api, flags } = makeApi();
    createUI(api).showSettings();
    const cases = [
      ["Spring physics", "springOn"],
      ["Look at cursor", "lookOn"],
      ["Face (blink", "facialOn"],
      ["Lock in place", "locked"],
    ]; // ("Idle motion" checkbox removed 2026-06-12 with the whole idle system; the random-emotes checkbox went 2026-06-11 — nothing fires by itself)
    for (const [label, flag] of cases) {
      const cb = checkboxByLabel(label);
      assert.ok(cb, `checkbox "${label}" exists`);
      const before = flags[flag];
      cb.checked = !before;
      fire(cb, "change");
      assert.strictEqual(flags[flag], !before, `"${label}" must flip flags.${flag}`);
    }
  } finally {
    dom.cleanup();
  }
});

test("Show skeleton + Show info panel are wired", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    const sk = checkboxByLabel("Show skeleton");
    assert.ok(sk, "Show skeleton checkbox exists");
    sk.checked = true;
    fire(sk, "change");
    assert.ok(
      calls.some((c) => c[0] === "showSkeleton" && c[1] === true),
      "→ api.showSkeleton(true)"
    );
    const info = checkboxByLabel("Show info panel");
    const uiEl = document.getElementById("ui");
    info.checked = true;
    fire(info, "change");
    assert.ok(!uiEl.classList.contains("hidden"), "info panel ON → #ui visible");
    info.checked = false;
    fire(info, "change");
    assert.ok(uiEl.classList.contains("hidden"), "info panel OFF → #ui hidden");
  } finally {
    dom.cleanup();
  }
});

test("color list has a row per material INDEX, including the UNNAMED one (old name-list bug)", () => {
  const dom = installDOM();
  try {
    createUI(makeApi().api).showSettings();
    const swatches = S().querySelectorAll("input[type=color]");
    assert.strictEqual(swatches.length, 2, "named + UNNAMED both get a color row");
    assert.ok(S().textContent.includes("#0"), "shown by index #0");
    assert.ok(S().textContent.includes("#1"), "unnamed material shown by index #1 (not dropped)");
  } finally {
    dom.cleanup();
  }
});

test("typing an #rrggbb code recolors that part BY INDEX", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    const texts = [...S().querySelectorAll("input[type=text]")];
    assert.ok(texts.length >= 2, "each color row has a hex field");
    texts[1].value = "#ff0000";
    fire(texts[1], "input"); // the UNNAMED material → index 1
    assert.deepStrictEqual(
      calls.find((c) => c[0] === "recolor"),
      ["recolor", 1, "#ff0000"],
      "recolor fires with INDEX, not name"
    );
  } finally {
    dom.cleanup();
  }
});

test("bare 'rrggbb' is normalized to '#rrggbb'; junk is ignored", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    const t = S().querySelector("input[type=text]");
    t.value = "00ff00";
    fire(t, "input");
    t.value = "zzz";
    fire(t, "input");
    const recolors = calls.filter((c) => c[0] === "recolor");
    assert.strictEqual(recolors.length, 1, "only the valid hex recolors");
    assert.deepStrictEqual(recolors[0], ["recolor", 0, "#00ff00"]);
  } finally {
    dom.cleanup();
  }
});

test("Reset button calls resetColors", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    let btn = null;
    for (const b of S().querySelectorAll("button")) if (b.textContent === "Reset") btn = b;
    assert.ok(btn, "Reset button exists");
    btn.click();
    assert.ok(
      calls.some((c) => c[0] === "resetColors"),
      "Reset → api.resetColors()"
    );
  } finally {
    dom.cleanup();
  }
});

function numInRow(text) {
  // match the LEAF label span (not an ancestor container), then the number input in its own row
  for (const span of S().querySelectorAll("span")) {
    if (span.textContent.includes(text) && span.parentElement) {
      const n = span.parentElement.querySelector("input[type=number]");
      if (n) return n;
    }
  }
  return null;
}

test("hair physics fields call springTune", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    const num = numInRow("Hair stiffness");
    assert.ok(num, "Hair stiffness field exists");
    num.value = "0.3";
    fire(num, "input");
    assert.ok(
      calls.some((c) => c[0] === "springTune"),
      "hair field → springTune"
    );
  } finally {
    dom.cleanup();
  }
});

test("Rotate X/Y/Z fields call setRotAxis per axis (all 3 axes)", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    let row = null;
    for (const span of S().querySelectorAll("span"))
      if (span.textContent.includes("Rotate °") && span.parentElement) {
        row = span.parentElement;
        break;
      }
    assert.ok(row, "Rotate row exists");
    const nums = [...row.querySelectorAll("input[type=number]")];
    assert.strictEqual(nums.length, 3, "three axis fields (X/Y/Z)");
    nums[1].value = "180";
    fire(nums[1], "input"); // Y = yaw
    assert.ok(
      calls.some((c) => c[0] === "setRotAxis" && c[1] === "y" && c[2] === 180),
      "Y field → setRotAxis('y',180)"
    );
    nums[0].value = "30";
    fire(nums[0], "input"); // X = pitch
    assert.ok(
      calls.some((c) => c[0] === "setRotAxis" && c[1] === "x" && c[2] === 30),
      "X field → setRotAxis('x',30)"
    );
  } finally {
    dom.cleanup();
  }
});

test("Rotate fields go BOTH directions: signed display + a negative min (rotate her the other way)", () => {
  const dom = installDOM();
  try {
    // A saved 345°/15° left/right turn must read back as the SIGNED -15 / +15 the user can dial down past 0.
    const { api } = makeApi({ getRot: () => ({ x: 345, y: 15, z: 0 }) });
    createUI(api).showSettings();
    let row = null;
    for (const span of S().querySelectorAll("span"))
      if (span.textContent.includes("Rotate °") && span.parentElement) {
        row = span.parentElement;
        break;
      }
    assert.ok(row, "Rotate row exists");
    const nums = [...row.querySelectorAll("input[type=number]")];
    assert.strictEqual(nums[0].value, "-15", "X 345 stored → shown as -15 (the OTHER direction), not 345");
    assert.strictEqual(nums[1].value, "15", "Y 15 stays +15");
    assert.strictEqual(nums[0].min, "-180", "min is negative so the spinner can rotate left/down past 0");
    assert.strictEqual(nums[0].max, "180", "max 180");
  } finally {
    dom.cleanup();
  }
});

test("Rotate ↺ reset calls setRot(0,0,0)", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    let btn = null;
    for (const b of S().querySelectorAll("button")) if (b.textContent === "↺") btn = b;
    assert.ok(btn, "rotation reset (↺) button exists");
    btn.click();
    assert.ok(
      calls.some((c) => c[0] === "setRot" && c[1] && c[1].x === 0 && c[1].y === 0 && c[1].z === 0),
      "↺ → setRot({0,0,0})"
    );
  } finally {
    dom.cleanup();
  }
});

// Part rows: an exact "#<index>" span, a show/hide checkbox, and a rename field — all in one row.
function partRow(index) {
  for (const span of S().querySelectorAll("span"))
    if (span.textContent.trim() === "#" + index && span.parentElement) return span.parentElement;
  return null;
}
// NO SLIDERS (hard rule): every "how much" control is a number input, never a range slider.
// This finds the number field in the row whose label contains `text`.
function weightInRow(text) {
  for (const span of S().querySelectorAll("span"))
    if (span.textContent.includes(text) && span.parentElement) {
      const n = span.parentElement.querySelector("input[type=number]");
      if (n) return n;
    }
  return null;
}

test("Parts list shows each mesh by index; toggling calls setMeshVisible (even an unnamed one)", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    const row = partRow(2); // the UNNAMED, hidden mesh — addressed by index
    assert.ok(row, "mesh #2 row present (addressed by index, even unnamed)");
    const cb = row.querySelector("input[type=checkbox]");
    assert.ok(cb, "mesh #2 has a show/hide checkbox");
    cb.checked = true;
    fire(cb, "change");
    assert.ok(
      calls.some((c) => c[0] === "setMeshVisible" && c[1] === 2 && c[2] === true),
      "toggle → setMeshVisible(2, true)"
    );
  } finally {
    dom.cleanup();
  }
});

test("Part rename field calls setMeshLabel(index, name)", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    const tx = partRow(2).querySelector("input[type=text]");
    assert.ok(tx, "mesh #2 has a rename field");
    tx.value = "Booty shorts";
    fire(tx, "change");
    assert.ok(
      calls.some((c) => c[0] === "setMeshLabel" && c[1] === 2 && c[2] === "Booty shorts"),
      "rename → setMeshLabel(2, 'Booty shorts')"
    );
  } finally {
    dom.cleanup();
  }
});

test("NO SLIDERS anywhere in Settings (hard rule): every weight/morph/region is a number input", () => {
  const dom = installDOM();
  try {
    createUI(makeApi().api).showSettings();
    const ranges = S().querySelectorAll("input[type=range]");
    assert.strictEqual(ranges.length, 0, "Settings contains ZERO range sliders");
    // and the weight controls that USED to be sliders are now number fields
    assert.ok(weightInRow("Breast"), "Breast jiggle is a number field");
    assert.ok(weightInRow("Cloth sway"), "Cloth sway is a number field");
    assert.ok(weightInRow("#1 · smile"), "a normal morph is a number field");
  } finally {
    dom.cleanup();
  }
});

test("Jiggle region number field calls setRegionWeight (NSFW areas are first-class)", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    const n = weightInRow("Breast");
    assert.ok(n, "Breast jiggle number field exists");
    assert.strictEqual(n.type, "number", "it is a number input, not a slider");
    n.value = "1.6";
    fire(n, "input");
    assert.ok(
      calls.some((c) => c[0] === "setRegionWeight" && c[1] === "breast" && Math.abs(c[2] - 1.6) < 1e-6),
      "→ setRegionWeight('breast', 1.6)"
    );
  } finally {
    dom.cleanup();
  }
});

test("chain on/off checkbox: set a CUSTOM weight, uncheck → 0, recheck → restores the CUSTOM weight", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    const n = weightInRow("Breast");
    assert.ok(n, "Breast chain row exists");
    assert.strictEqual(n.type, "number", "the chain weight is a number input, not a slider");
    const cb = n.parentElement.querySelector("input[type=checkbox]");
    assert.ok(cb, "the chain row has an on/off checkbox");
    assert.ok(cb.checked, "weight 1 → starts ON");
    // set a CUSTOM weight (not the default 1) so "restores previous" is a real assertion
    n.value = "1.6";
    fire(n, "input");
    assert.ok(
      calls.some((c) => c[0] === "setRegionWeight" && c[1] === "breast" && Math.abs(c[2] - 1.6) < 1e-6),
      "typing 1.6 → setRegionWeight('breast', 1.6)"
    );
    cb.checked = false;
    fire(cb, "change");
    assert.ok(
      calls.some((c) => c[0] === "setRegionWeight" && c[1] === "breast" && c[2] === 0),
      "uncheck → setRegionWeight('breast', 0)"
    );
    cb.checked = true;
    fire(cb, "change");
    const last = calls.filter((c) => c[0] === "setRegionWeight" && c[1] === "breast").at(-1);
    assert.ok(last && Math.abs(last[2] - 1.6) < 1e-6, "recheck → restores the CUSTOM weight (1.6, NOT the default 1)");
    n.value = "0";
    fire(n, "input");
    assert.ok(!cb.checked, "typing 0 also UNchecks the box (one source of truth)");
  } finally {
    dom.cleanup();
  }
});

test("Cloth has its OWN weight section (fabric is separate from the body jiggle)", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    assert.ok(S().textContent.includes("Cloth / fabric"), "a Cloth / fabric section exists");
    const n = weightInRow("Cloth sway");
    assert.ok(n, "cloth weight number field exists");
    assert.strictEqual(n.type, "number", "cloth weight is a number input, not a slider");
    n.value = "0.4";
    fire(n, "input");
    assert.ok(
      calls.some((c) => c[0] === "setRegionWeight" && c[1] === "cloth" && Math.abs(c[2] - 0.4) < 1e-6),
      "→ setRegionWeight('cloth', 0.4)"
    );
  } finally {
    dom.cleanup();
  }
});

test("rotate-by-drag is a TOGGLE (arms setRotateMode) and the Idle section is GONE (idle deleted 2026-06-12)", () => {
  const dom = installDOM();
  try {
    const m = makeApi();
    createUI(m.api).showSettings();
    // The toggle is back (user request 2026-06-30: "make rotate a toggle instead of the Alt button").
    // Safe because hideSettings() auto-disarms it — see the disarm-on-close test below.
    const cb = checkboxByLabel("Rotate by dragging her");
    assert.ok(cb, "rotate-by-drag toggle exists");
    cb.checked = true;
    fire(cb, "change");
    assert.ok(
      m.calls.some((c) => c[0] === "setRotateMode" && c[1] === true),
      "ticking it → setRotateMode(true)"
    );
    // Alt+drag still works too, so the hint mentions it.
    assert.ok(
      [...document.querySelectorAll("div")].some((d) => /hold Alt and drag/i.test(d.textContent || "")),
      "Alt+drag hint still shown"
    );
    // The whole idle system was deleted (user order 2026-06-12) — NO idle UI may exist.
    assert.ok(
      ![...document.querySelectorAll("div,span,button")].some((d) =>
        /Idle —|Re-seed|Liveliness/i.test(d.textContent || "")
      ),
      "no Idle section / sliders / re-seed button anywhere"
    );
    assert.ok(!checkboxByLabel("Idle motion"), "the Idle motion toggle is gone (nothing to toggle)");
  } finally {
    dom.cleanup();
  }
});

test("Look-with dropdown (head/eyes/both) calls setLookMode when the model has eyes", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    let sel = null;
    for (const span of S().querySelectorAll("span"))
      if (span.textContent.includes("Look with") && span.parentElement) {
        sel = span.parentElement.querySelector("select");
        break;
      }
    assert.ok(sel, "Look-with dropdown present (model has eyes)");
    sel.value = "eyes";
    fire(sel, "change");
    assert.ok(
      calls.some((c) => c[0] === "setLookMode" && c[1] === "eyes"),
      "→ setLookMode('eyes')"
    );
  } finally {
    dom.cleanup();
  }
});

test("Morph number field drives a shape key BY INDEX (the avatar's own toggles)", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    const n = weightInRow("#1 · smile");
    assert.ok(n, "morph #1 number field exists");
    assert.strictEqual(n.type, "number", "morph control is a number input, not a slider");
    n.value = "0.8";
    fire(n, "input");
    assert.ok(
      calls.some((c) => c[0] === "setMorphValue" && c[1] === 1 && Math.abs(c[2] - 0.8) < 1e-6),
      "→ setMorphValue(1, 0.8)"
    );
  } finally {
    dom.cleanup();
  }
});

test("a lip-sync-driven (auto) morph is labeled, not a dead control", () => {
  const dom = installDOM();
  try {
    const { api } = makeApi();
    createUI(api).showSettings();
    assert.ok(S().textContent.includes("auto"), "auto morph carries an 'auto · lip-sync' tag");
    assert.ok(!weightInRow("jawOpen"), "auto morph (#2 jawOpen) has NO input (it would just snap back)");
    assert.ok(weightInRow("#1 · smile"), "a normal morph still has its number field");
  } finally {
    dom.cleanup();
  }
});

test("Model repair: expanding shows the role summary + a Fix-names button that calls repairModel", async () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    // expand the "Model repair" section
    let header = null;
    for (const span of S().querySelectorAll("span"))
      if (span.textContent.includes("Model repair")) {
        header = span.parentElement;
        break;
      }
    assert.ok(header, "Model repair section present (desktop api)");
    header.click();
    await new Promise((r) => setTimeout(r, 5)); // let the async diagnose resolve
    assert.ok(
      calls.some((c) => c[0] === "diagnoseModel" && c[1] === "roxanne_wolf"),
      "diagnoses the CURRENT model by id"
    );
    assert.ok(S().textContent.includes("17 / 19"), "shows live role resolution (17/19, 2 missing)");
    let fixBtn = null;
    for (const b of S().querySelectorAll("button")) if (/Fix \d+ broken bone name/.test(b.textContent)) fixBtn = b;
    assert.ok(fixBtn, "a Fix-broken-names button appears (mock reports 5 broken)");
    fixBtn.click();
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(
      calls.some((c) => c[0] === "repairModel" && c[1]?.id === "roxanne_wolf" && c[1]?.ops?.repairMojibake === true),
      "→ repairModel({id, ops:{repairMojibake:true}})"
    );
  } finally {
    dom.cleanup();
  }
});

test("Model repair: a missing role offers a bone dropdown that renames a bone to a canonical name", async () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    createUI(api).showSettings();
    let header = null;
    for (const span of S().querySelectorAll("span"))
      if (span.textContent.includes("Model repair")) {
        header = span.parentElement;
        break;
      }
    header.click();
    await new Promise((r) => setTimeout(r, 5));
    // find the select whose row labels the missing 'left arm' role
    let sel = null;
    for (const span of S().querySelectorAll("span"))
      if (span.textContent === "left arm" && span.parentElement) {
        sel = span.parentElement.querySelector("select");
        break;
      }
    assert.ok(sel, "missing role 'left arm' has a bone-picker dropdown");
    sel.value = "L_fluffShoulder";
    fire(sel, "change");
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(
      calls.some((c) => c[0] === "repairModel" && c[1]?.ops?.renames?.L_fluffShoulder === "LeftUpperArm"),
      "→ renames the picked bone to the canonical 'LeftUpperArm'"
    );
  } finally {
    dom.cleanup();
  }
});

// #35 — the attach "Bone" picker is CAPABILITY-DRIVEN: it lists the roles THIS body resolved
// (getRoleInfo) + "(world / no bone)", NOT a hardcoded human-bone list. A missing role must not
// appear; a role the body has must.
function fitBoneSelect() {
  for (const span of S().querySelectorAll("span"))
    if (span.textContent.trim() === "Bone" && span.parentElement) {
      const s = span.parentElement.querySelector("select");
      if (s) return s;
    }
  return null;
}

test("attach Bone picker reflects RESOLVED roles + (world / no bone), not a hardcoded list", () => {
  const dom = installDOM();
  try {
    // missing: left_arm/right_arm -> they must be ABSENT; head/right_hand are resolved -> present
    const { api } = makeApi({
      getAttachObjs: () => [
        {
          id: "a1",
          category: "prop",
          url: "./props/wand.glb",
          bone: "right_hand",
          pos: [0, 0, 0],
          rot: [0, 0, 0],
          scale: 1,
          obj: null,
        },
      ],
    });
    createUI(api).showSettings();
    const bsel = fitBoneSelect();
    assert.ok(bsel, "attach Bone <select> exists");
    const vals = [...bsel.options].map((o) => o.value);
    assert.ok(vals.includes("head"), "a resolved role (head) is offered");
    assert.ok(vals.includes("right_hand"), "a resolved role (right_hand) is offered");
    assert.ok(!vals.includes("left_arm"), "a MISSING role (left_arm) is NOT offered (capability-driven)");
    assert.ok(!vals.includes("right_arm"), "a MISSING role (right_arm) is NOT offered");
    assert.ok(vals.includes(""), "the (world / no bone) option is present");
    assert.strictEqual(
      [...bsel.options].find((o) => o.value === "").textContent,
      "(world / no bone)",
      "no-bone option labeled"
    );
    assert.strictEqual(bsel.value, "right_hand", "current saved bone is selected");
  } finally {
    dom.cleanup();
  }
});

test("attach Bone picker keeps a non-role bone the AI named (e.g. 'tail') as the selection", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi({
      getAttachObjs: () => [
        {
          id: "a1",
          category: "prop",
          url: "./props/bow.glb",
          bone: "tail",
          pos: [0, 0, 0],
          rot: [0, 0, 0],
          scale: 1,
          obj: null,
        },
      ],
    });
    createUI(api).showSettings();
    const bsel = fitBoneSelect();
    assert.ok(bsel, "attach Bone <select> exists");
    const vals = [...bsel.options].map((o) => o.value);
    assert.ok(vals.includes("tail"), "the active non-role bone 'tail' is kept in the list (not silently dropped)");
    assert.strictEqual(bsel.value, "tail", "'tail' stays selected");
    bsel.value = "head";
    fire(bsel, "change");
    assert.ok(
      calls.some((c) => c[0] === "tuneAttachment" && c[1] === "a1" && c[2]?.bone === "head"),
      "changing the bone -> tuneAttachment({bone:'head'})"
    );
  } finally {
    dom.cleanup();
  }
});

test("attach Bone picker offers only (world / no bone) when no roles resolve", () => {
  const dom = installDOM();
  try {
    const { api } = makeApi({
      getRoleInfo: () => ({
        matched: 0,
        total: 19,
        missing: [
          "hips",
          "spine",
          "chest",
          "neck",
          "head",
          "left_shoulder",
          "left_arm",
          "left_forearm",
          "left_hand",
          "right_shoulder",
          "right_arm",
          "right_forearm",
          "right_hand",
          "left_leg",
          "left_shin",
          "left_foot",
          "right_leg",
          "right_shin",
          "right_foot",
        ],
      }),
      getAttachObjs: () => [
        {
          id: "a1",
          category: "furniture",
          url: "./props/chair.glb",
          bone: "",
          pos: [0, 0, 0],
          rot: [0, 0, 0],
          scale: 1,
          obj: null,
        },
      ],
    });
    createUI(api).showSettings();
    const bsel = fitBoneSelect();
    assert.ok(bsel, "attach Bone <select> exists");
    const vals = [...bsel.options].map((o) => o.value);
    assert.deepStrictEqual(vals, [""], "no resolved role -> only the world/no-bone option");
  } finally {
    dom.cleanup();
  }
});

test("menu has a single 'Choose model…' entry that opens the gallery (no inline list)", () => {
  const dom = installDOM();
  try {
    const { api } = makeApi();
    const ui = createUI(api);
    ui.showMenu(10, 10);
    assert.ok(M().textContent.includes("Choose model"), "menu opens the gallery, doesn't list models inline");
  } finally {
    dom.cleanup();
  }
});

test("closing Settings disarms drag-to-spin (setRotateMode(false) fires iff it was on)", () => {
  const dom = installDOM();
  try {
    // rotate mode ON → closing must turn it off
    const a = makeApi({ getRotateMode: () => true });
    const uiA = createUI(a.api);
    uiA.showSettings();
    uiA.hideSettings();
    assert.ok(
      a.calls.some((c) => c[0] === "setRotateMode" && c[1] === false),
      "armed spin is disarmed on close"
    );
    // rotate mode already OFF → closing must NOT churn a redundant call
    const b = makeApi({ getRotateMode: () => false });
    const uiB = createUI(b.api);
    uiB.showSettings();
    uiB.hideSettings();
    assert.ok(!b.calls.some((c) => c[0] === "setRotateMode"), "no redundant disarm when it was never on");
  } finally {
    dom.cleanup();
  }
});

test("menu 'Ball' submenu lists the ball-physics toys and clicking one fires api.ball", () => {
  const dom = installDOM();
  try {
    const { api, calls } = makeApi();
    const ui = createUI(api);
    ui.showMenu(10, 10);
    const txt = M().textContent;
    for (const label of ["Ball", "Throw ball", "Drop ball on her", "Clear balls"]) {
      assert.ok(txt.includes(label), `menu offers '${label}'`);
    }
    const ball = [...M().querySelectorAll("div")].find((d) => d.textContent === "Throw ball");
    assert.ok(ball, "Throw ball row exists");
    ball.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert.ok(
      calls.some((c) => c[0] === "ball" && c[1] === "throwball"),
      "clicking Throw ball fires api.ball('throwball')"
    );
  } finally {
    dom.cleanup();
  }
});

test("Settings panel header drag moves it by the EXACT pointer delta", () => {
  const dom = installDOM();
  try {
    createUI(makeApi().api).showSettings();
    const panel = S();
    const header = panel.firstChild; // the head div is the drag handle
    // jsdom never lays anything out (getBoundingClientRect is always 0/0), so stub the panel's
    // rect to a KNOWN origin — the drag reads it as the start position. Asserting !='500px'
    // (the old test) passed even if the drag math was wrong; this pins the exact arithmetic.
    panel.getBoundingClientRect = () => ({
      left: 500,
      top: 400,
      right: 768,
      bottom: 600,
      width: 268,
      height: 200,
      x: 500,
      y: 400,
    });
    pointer(header, "pointerdown", 200, 200);
    pointer(header, "pointermove", 280, 260); // drag by (+80, +60)
    pointer(header, "pointerup", 280, 260);
    // start (500,400) + delta (80,60) = (580,460); both well inside the on-screen clamp.
    assert.strictEqual(panel.style.left, "580px", "moved horizontally by exactly +80 (500 -> 580)");
    assert.strictEqual(panel.style.top, "460px", "moved vertically by exactly +60 (400 -> 460)");
  } finally {
    dom.cleanup();
  }
});

test("Bones section: filter narrows the list and the label input fires setBoneLabel", () => {
  const dom = installDOM();
  try {
    const m = makeApi({
      bones: () => [
        { name: "HairBoneL006_0524", label: null, role: null },
        { name: "DEF-spine006_016", label: "head", role: "head" },
        { name: "Shibahu_Tail1_0199", label: null, role: null },
      ],
    });
    m.api.setBoneLabel = (n, l) => m.calls.push(["setBoneLabel", n, l]);
    m.api.highlightBone = (n, d) => m.calls.push(["highlightBone", n, d]);
    let pickCb = null;
    m.api.pickBone = (cb) => {
      pickCb = cb;
      m.calls.push(["pickBone"]);
    };
    createUI(m.api).showSettings();
    const filt = [...document.querySelectorAll("input")].find((i) => /filter bones/i.test(i.placeholder || ""));
    assert.ok(filt, "bone filter input exists");
    filt.value = "tail";
    fire(filt, "input");
    const rows = [...document.querySelectorAll("input")].filter((i) => /name it/i.test(i.placeholder || ""));
    assert.equal(rows.length, 1, "filter narrows to the tail bone");
    rows[0].value = "tail base";
    fire(rows[0], "change");
    assert.ok(
      m.calls.some((c) => c[0] === "setBoneLabel" && c[1] === "Shibahu_Tail1_0199" && c[2] === "tail base"),
      "-> setBoneLabel(raw name, label)"
    );
    // IDENTIFY (2026-06-12): hovering a row's raw name highlights that bone on her body…
    const raw = [...document.querySelectorAll("span")].find((s) => /Shibahu_Tail1_0199/.test(s.textContent || ""));
    assert.ok(raw, "raw bone name span exists");
    fire(raw, "mouseenter");
    assert.ok(
      m.calls.some((c) => c[0] === "highlightBone" && c[1] === "Shibahu_Tail1_0199"),
      "hover -> highlightBone(raw name)"
    );
    // …and the 🎯 pick button arms a click-on-her pick whose result lands in the filter.
    const pk = [...document.querySelectorAll("button")].find((b) => /Pick a bone/i.test(b.textContent || ""));
    assert.ok(pk, "pick button exists");
    pk.click();
    assert.ok(pickCb, "pick armed a callback");
    pickCb("DEF-spine006_016");
    assert.equal(filt.value, "DEF-spine006_016", "picked bone name lands in the filter");
  } finally {
    dom.cleanup();
  }
});
