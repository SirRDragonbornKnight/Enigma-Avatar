// gallery.test.js — exercises the visual model gallery (ui.js) headless via jsdom: it renders a
// card per discovered model + an Add card, lets you pick by clicking, protects built-ins from
// removal, and gates delete behind a two-step inline confirm that calls avatarIPC.removeModel.
// The mock api.listModels() returns one built-in (Roxanne) + one user model (C za).
import { test } from "node:test";
import assert from "node:assert";
import { installDOM, makeApi } from "./dom.js";
import { createUI } from "../ui.js";

const grid = () => document.getElementById("avgrid");
const cardById = (id) => [...grid().children].find((c) => c.dataset && c.dataset.id === id);

async function openGallery() {
  const made = makeApi();
  const ui = createUI(made.api);
  await ui.refreshModelList();   // pulls MODEL_LIST from avatarIPC.listModels()
  ui.showGallery();
  return { ui, ...made };
}

test("gallery renders a card per model + an Add card; current model highlighted", async () => {
  const dom = installDOM();
  try {
    await openGallery();
    assert.strictEqual(grid().querySelectorAll("[data-id]").length, 2, "two model cards (built-in + user)");
    assert.ok(document.getElementById("avadd"), "an Add-model card is present");
    assert.ok(cardById("roxanne_wolf"), "built-in card rendered");
    assert.ok(cardById("c_za"), "user card rendered");
  } finally { dom.cleanup(); }
});

test("every model has a remove ✕ (no special / undeletable models)", async () => {
  const dom = installDOM();
  try {
    await openGallery();
    assert.ok(cardById("roxanne_wolf").querySelector(".gx"), "model has a remove ✕");
    assert.ok(cardById("c_za").querySelector(".gx"), "model has a remove ✕");
  } finally { dom.cleanup(); }
});

test("clicking a card loads that model", async () => {
  const dom = installDOM();
  try {
    const { calls } = await openGallery();
    cardById("c_za").click();
    assert.ok(calls.some((c) => c[0] === "loadModel" && c[1] === "./models/c_za/c_za.glb"), "card → api.loadModel(url)");
  } finally { dom.cleanup(); }
});

test("remove is a TWO-STEP confirm → avatarIPC.removeModel", async () => {
  const dom = installDOM();
  try {
    const { calls } = await openGallery();
    cardById("c_za").querySelector(".gx").click();               // step 1: arm the inline confirm
    assert.ok(!calls.some((c) => c[0] === "removeModel"), "✕ alone does NOT delete");
    const yes = cardById("c_za").querySelector(".gyes");          // re-query: grid was rebuilt
    assert.ok(yes, "a confirm button appears after ✕");
    yes.click();                                                 // step 2: confirm
    await Promise.resolve(); await Promise.resolve();
    assert.ok(calls.some((c) => c[0] === "removeModel" && c[1] === "c_za"), "confirm → removeModel('c_za')");
  } finally { dom.cleanup(); }
});

test("rename is an inline editor → avatarIPC.renameModel (folder/files untouched)", async () => {
  const dom = installDOM();
  try {
    const { calls } = await openGallery();
    cardById("c_za").querySelector(".ged").click();              // step 1: arm the inline rename
    assert.ok(!calls.some((c) => c[0] === "renameModel"), "✎ alone does NOT rename");
    const inp = cardById("c_za").querySelector(".grename");       // re-query: grid was rebuilt
    assert.ok(inp, "an inline rename field appears after ✎");
    inp.value = "My Bunny";
    cardById("c_za").querySelector(".gsave").click();             // step 2: save
    await new Promise((r) => setTimeout(r, 30));                  // let renameModel + refreshModelList fully settle
    assert.ok(calls.some((c) => c[0] === "renameModel" && c[1] === "c_za" && c[2] === "My Bunny"), "save → renameModel('c_za','My Bunny')");
  } finally { dom.cleanup(); }
});

test("Add-model card calls importModel", async () => {
  const dom = installDOM();
  try {
    const { calls } = await openGallery();
    document.getElementById("avadd").click();
    await Promise.resolve();
    assert.ok(calls.some((c) => c[0] === "importModel"), "Add card → avatarIPC.importModel()");
  } finally { dom.cleanup(); }
});

test("empty library shows an empty-state message + the Add card (no models left)", async () => {
  const dom = installDOM();
  try {
    const made = makeApi();
    made.api.avatarIPC.listModels = async () => [];   // every model deleted
    const ui = createUI(made.api);
    await ui.refreshModelList();
    ui.showGallery();
    assert.strictEqual(grid().querySelectorAll("[data-id]").length, 0, "no model cards");
    assert.ok(document.getElementById("avadd"), "Add card still present");
    assert.ok(grid().textContent.toLowerCase().includes("no models"), "shows empty-state guidance");
  } finally { dom.cleanup(); }
});
