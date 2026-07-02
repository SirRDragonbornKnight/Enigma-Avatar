// localurl.test.js — the one mapping between external local references and the app:// origin.
// Wrong output here = a model/wav that silently fails to load on the live overlay, so every
// shape the bus/profiles actually produce is pinned.
import test from "node:test";
import assert from "node:assert/strict";
import { toAppUrl } from "../src/util/localurl.js";

test("relative bundle refs pass through untouched", () => {
  assert.equal(toAppUrl("./models/makiro/Makiro.glb"), "./models/makiro/Makiro.glb");
  assert.equal(toAppUrl("assets/marker.glb"), "assets/marker.glb");
});

test("blob:, data:, app:, and http(s) pass through (handled or rejected elsewhere)", () => {
  assert.equal(toAppUrl("blob:app://enigma/uuid"), "blob:app://enigma/uuid");
  assert.equal(toAppUrl("data:model/gltf+json;base64,xx"), "data:model/gltf+json;base64,xx");
  assert.equal(toAppUrl("app://enigma/@fs/C:/x.glb"), "app://enigma/@fs/C:/x.glb");
  assert.equal(toAppUrl("https://evil.example/x.glb"), "https://evil.example/x.glb"); // the loader's remote gate rejects it
});

test("file:/// URLs ride /@fs/ with their encoding preserved", () => {
  assert.equal(toAppUrl("file:///C:/Users/x/model.glb"), "app://enigma/@fs/C:/Users/x/model.glb");
  // speak.py produces percent-encoded file URLs (spaces in '3d Avatar')
  assert.equal(
    toAppUrl("file:///C:/Users/SirKn/3d%20Avatar/Avatars/anime_catgirl.glb"),
    "app://enigma/@fs/C:/Users/SirKn/3d%20Avatar/Avatars/anime_catgirl.glb"
  );
});

test("raw Windows drive paths map with backslashes flipped and spaces encoded", () => {
  assert.equal(toAppUrl("C:\\Users\\x\\model.glb"), "app://enigma/@fs/C:/Users/x/model.glb");
  assert.equal(
    toAppUrl("C:\\Users\\SirKn\\3d Avatar\\Avatars\\marie.glb"),
    "app://enigma/@fs/C:/Users/SirKn/3d%20Avatar/Avatars/marie.glb"
  );
});

test("UNC paths are NOT mapped (honest non-support, never a half-right URL)", () => {
  assert.equal(toAppUrl("\\\\server\\share\\m.glb"), "\\\\server\\share\\m.glb");
});
