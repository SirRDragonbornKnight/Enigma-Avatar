// contract.test.js — hand-maintained cross-file constants that MUST match, checked mechanically.
// Each of these pairs is kept in sync by comment-discipline alone everywhere else; a drift is
// silent at runtime (an uncapped bone, a blank overlay), so the suite pins them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ROLES } from "../src/rig/rig.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the 19-role canon: rig.js ROLES === bone_limits.json bones keys (a role missing from limits runs UNCAPPED)", () => {
  const limits = JSON.parse(readFileSync(path.join(ROOT, "bone_limits.json"), "utf8"));
  assert.deepEqual(
    [...ROLES].sort(),
    Object.keys(limits.bones).sort(),
    "rig.js ROLES and bone_limits.json 'bones' drifted — add/rename the role in BOTH (procedural.js treats a missing limits entry as no joint/speed caps, silently)"
  );
});

test("index.html's CSP allows exactly the live importmap bytes (a drift blanks the overlay at runtime)", () => {
  const html = readFileSync(path.join(ROOT, "index.html"), "utf8");
  // strip HTML comments FIRST — the CSP explainer comment mentions the literal tag text, and a
  // naive first-match regex would capture from inside the comment instead of the real script
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(live);
  assert.ok(map, "inline importmap <script> present");
  const digest = createHash("sha256").update(map[1]).digest("base64");
  const allowed = /script-src[^;]*'sha256-([^']+)'/.exec(live);
  assert.ok(allowed, "CSP script-src sha256 allowance present");
  assert.equal(
    digest,
    allowed[1],
    "the importmap text changed without recomputing its CSP hash — set the meta's sha256- value to this digest or three.js/VRM/rapier fail to import"
  );
});
