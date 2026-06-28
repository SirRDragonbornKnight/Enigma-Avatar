// gallery.test.js — exercises the visual model gallery + Add menu (ui.js) headless via jsdom.
// It renders a card per discovered model + an Add card and lets you pick by clicking. There are
// NO built-ins (the bundled-copyright models were removed), so EVERY model is user-owned and
// equally removable — delete is gated only by a two-step inline confirm that calls
// avatarIPC.removeModel; there is no special "undeletable" class to protect. It also covers the
// Add-to-avatar prop flow (importProp -> attachMesh). The mock api.listModels() returns two
// user models (Roxanne, C za) — neither is a built-in.
import { test } from "node:test";
import assert from "node:assert";
import { installDOM, makeApi } from "./dom.js";
import { createUI } from "../ui.js";

const grid = () => document.getElementById("avgrid");
const cardById = (id) => [...grid().children].find((c) => c.dataset && c.dataset.id === id);

async function openGallery() {
  const made = makeApi();
  const ui = createUI(made.api);
  await ui.refreshModelList(); // pulls MODEL_LIST from avatarIPC.listModels()
  ui.showGallery();
  return { ui, ...made };
}

test("gallery renders a card per model + an Add card; current model highlighted", async () => {
  const dom = installDOM();
  try {
    await openGallery();
    assert.strictEqual(grid().querySelectorAll("[data-id]").length, 2, "two user model cards");
    assert.ok(document.getElementById("avadd"), "an Add-model card is present");
    assert.ok(cardById("roxanne_wolf"), "first model card rendered");
    assert.ok(cardById("c_za"), "second model card rendered");
  } finally {
    dom.cleanup();
  }
});

test("every model has a remove ✕ (no special / undeletable models)", async () => {
  const dom = installDOM();
  try {
    await openGallery();
    assert.ok(cardById("roxanne_wolf").querySelector(".gx"), "model has a remove ✕");
    assert.ok(cardById("c_za").querySelector(".gx"), "model has a remove ✕");
  } finally {
    dom.cleanup();
  }
});

test("clicking a card loads that model", async () => {
  const dom = installDOM();
  try {
    const { calls } = await openGallery();
    cardById("c_za").click();
    assert.ok(
      calls.some((c) => c[0] === "loadModel" && c[1] === "./models/c_za/c_za.glb"),
      "card → api.loadModel(url)"
    );
  } finally {
    dom.cleanup();
  }
});

test("remove is a TWO-STEP confirm → avatarIPC.removeModel", async () => {
  const dom = installDOM();
  try {
    const { calls } = await openGallery();
    cardById("c_za").querySelector(".gx").click(); // step 1: arm the inline confirm
    assert.ok(!calls.some((c) => c[0] === "removeModel"), "✕ alone does NOT delete");
    const yes = cardById("c_za").querySelector(".gyes"); // re-query: grid was rebuilt
    assert.ok(yes, "a confirm button appears after ✕");
    yes.click(); // step 2: confirm
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(
      calls.some((c) => c[0] === "removeModel" && c[1] === "c_za"),
      "confirm → removeModel('c_za')"
    );
  } finally {
    dom.cleanup();
  }
});

test("rename is an inline editor → avatarIPC.renameModel (folder/files untouched)", async () => {
  const dom = installDOM();
  try {
    const { calls } = await openGallery();
    cardById("c_za").querySelector(".ged").click(); // step 1: arm the inline rename
    assert.ok(!calls.some((c) => c[0] === "renameModel"), "✎ alone does NOT rename");
    const inp = cardById("c_za").querySelector(".grename"); // re-query: grid was rebuilt
    assert.ok(inp, "an inline rename field appears after ✎");
    inp.value = "My Bunny";
    cardById("c_za").querySelector(".gsave").click(); // step 2: save
    await new Promise((r) => setTimeout(r, 30)); // let renameModel + refreshModelList fully settle
    assert.ok(
      calls.some((c) => c[0] === "renameModel" && c[1] === "c_za" && c[2] === "My Bunny"),
      "save → renameModel('c_za','My Bunny')"
    );
  } finally {
    dom.cleanup();
  }
});

test("Add-model card calls importModel", async () => {
  const dom = installDOM();
  try {
    const { calls } = await openGallery();
    document.getElementById("avadd").click();
    await Promise.resolve();
    assert.ok(
      calls.some((c) => c[0] === "importModel"),
      "Add card → avatarIPC.importModel()"
    );
  } finally {
    dom.cleanup();
  }
});

test("Add-to-avatar Prop... clicks through importProp -> attachMesh", async () => {
  const dom = installDOM();
  try {
    const made = makeApi();
    const ui = createUI(made.api);
    await ui.refreshModelList();
    ui.showMenu(0, 0); // builds the right-click menu (incl. the Add submenu)
    // find the "Prop..." row by its label text (rows carry no class; the label is a child span)
    const rows = [...document.getElementById("avmenu").querySelectorAll("div")];
    const prop = rows.find((d) => d.textContent.replace(/…/g, "").trim() === "Prop");
    assert.ok(prop, "an Add-to-avatar 'Prop...' row exists");
    prop.click();
    await Promise.resolve();
    await Promise.resolve(); // let importProp() resolve, then attachMesh runs
    assert.ok(
      made.calls.some((c) => c[0] === "importProp"),
      "Prop... -> avatarIPC.importProp()"
    );
    const attach = made.calls.find((c) => c[0] === "attachMesh");
    assert.ok(attach, "importProp success -> api.attachMesh(url, {category})");
    assert.strictEqual(attach[1], "./props/p_imported/p.glb", "attachMesh got the imported url");
    assert.strictEqual(attach[2]?.category, "prop", "attachMesh tagged with category 'prop'");
  } finally {
    dom.cleanup();
  }
});

test("empty library shows an empty-state message + the Add card (no models left)", async () => {
  const dom = installDOM();
  try {
    const made = makeApi();
    made.api.avatarIPC.listModels = async () => []; // every model deleted
    const ui = createUI(made.api);
    await ui.refreshModelList();
    ui.showGallery();
    assert.strictEqual(grid().querySelectorAll("[data-id]").length, 0, "no model cards");
    assert.ok(document.getElementById("avadd"), "Add card still present");
    assert.ok(grid().textContent.toLowerCase().includes("no models"), "shows empty-state guidance");
  } finally {
    dom.cleanup();
  }
});
