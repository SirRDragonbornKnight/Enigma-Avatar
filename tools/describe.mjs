// describe.mjs — name-AGNOSTIC capability profiler for a 3D avatar model.
//
// Why this exists: every model comes from a different pipeline (FNAF rip, MMD export,
// VRM, Blender/Rigify) with NO shared naming, and some have outright corrupted bone
// names (grace_howard's are U+FFFD mojibake). So an AI must NOT drive a model off
// guessed names. This tool reads a model's glTF/GLB JSON (no WebGL, no mesh decode) and
// reports what's actually there, addressed by STABLE HANDLES the driver can trust:
//   • rig parts  → our 19 canonical ROLES, resolved by rig.js's structural cascade
//   • materials  → array INDEX (recolor target)
//   • morphs     → (mesh, index)
//   • VRM faces  → standardized PRESET names (the one naming scheme that IS reliable)
// The model's own `name` strings are returned as opaque labels — show them, never branch
// on them. The hard part (bone identification) is reused wholesale from rig_report.mjs.
//
//   node tools/describe.mjs                 # brief menu of every installed model
//   node tools/describe.mjs <model|id>      # full capability profile (JSON) for one
//
// Output is JSON on stdout (the avatar_describe MCP tool consumes it). Static glTF parse
// is the "scan before loading" path; the live overlay's self-report (future) is ground truth.
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  readGltfJson, buildSnapshot, runCascade,
  discoverModels, urlKeyFor, MODELS,
} from "./rig_report.mjs";
import { ROLES } from "../rig.js";

const REPLACEMENT = "�"; // baked-in mojibake marker (lost Shift-JIS, etc.)

// ── glTF sub-readers — all defensive: a missing block yields empty, never throws ──

// Materials: the recolor surface. Handle = index. baseColor/metallic/roughness are
// structural facts the AI can reason about ("index 3 is reddish, low-metal") without
// trusting the name. glTF spec defaults: factors are 1.0 when a pbr block omits them.
function materialList(gltf) {
  const mats = gltf.materials || [];
  const seen = new Map();
  const list = mats.map((m, index) => {
    const pbr = m.pbrMetallicRoughness || null;
    const name = m.name ?? null;
    if (name != null) seen.set(name, (seen.get(name) || 0) + 1);
    return {
      index,
      name,                                   // OPAQUE — for display only
      baseColor: pbr?.baseColorFactor ?? null,
      metallic: pbr ? (pbr.metallicFactor ?? 1) : null,
      roughness: pbr ? (pbr.roughnessFactor ?? 1) : null,
      emissive: m.emissiveFactor ?? null,
      alphaMode: m.alphaMode || "OPAQUE",
    };
  });
  const duplicateNames = [...seen.values()].some((c) => c > 1);
  return { count: list.length, recolorBy: "live avatar_status index (these static indices are a PREVIEW — the running overlay is the authority; see addressing)", duplicateNames, list };
}

// Morph targets (blendshapes): per-mesh count + names if the exporter wrote them
// (glTF convention: mesh.extras.targetNames). Names OPAQUE; handle = (mesh, index).
function morphInfo(gltf) {
  const meshes = gltf.meshes || [];
  const byMesh = [];
  let total = 0;
  meshes.forEach((mesh, mi) => {
    const prim = (mesh.primitives || []).find((p) => Array.isArray(p.targets));
    const count = prim ? prim.targets.length : 0;
    if (!count) return;
    total += count;
    const names = Array.isArray(mesh.extras?.targetNames) ? mesh.extras.targetNames : null;
    byMesh.push({ mesh: mi, count, names });   // names: OPAQUE or null
  });
  return { total, byMesh };
}

// VRM facial expressions — the ONE trustable naming scheme: presets are spec-defined
// (aa/ih/ou/ee/oh visemes, blink, happy/angry/sad...). Read both VRM 0.x and 1.0.
function vrmExpressions(gltf) {
  const ex = gltf.extensions || {};
  const out = [];
  const g0 = ex.VRM?.blendShapeMaster?.blendShapeGroups;      // VRM 0.x
  if (Array.isArray(g0)) for (const g of g0) { const p = (g.presetName || g.name || "").toLowerCase(); if (p && p !== "unknown") out.push(p); }
  const e1 = ex.VRMC_vrm?.expressions;                        // VRM 1.0
  if (e1?.preset) out.push(...Object.keys(e1.preset));
  if (e1?.custom) out.push(...Object.keys(e1.custom));
  return [...new Set(out)];
}

// Spring/dynamic bones — where "wag" (tail), hair sway, GLaDOS's wires live. VRM declares
// them explicitly (reliable count). For non-VRM, the static file can't say for sure which
// leaf chains are springy — rig.js decides that at load — so we report a COARSE signal and
// low-confidence name hints, and defer the truth to the live self-report.
function springInfo(gltf, snap) {
  const ex = gltf.extensions || {};
  const vrm0 = ex.VRM?.secondaryAnimation?.boneGroups?.length || 0;
  const vrm1 = ex.VRMC_springBone?.springs?.length || 0;
  const vrmSpringGroups = vrm0 + vrm1;
  // name hints (LOW confidence — names are untrusted): bones that look dangly.
  const DANGLE = /hair|tail|skirt|cloth|ear|wire|string|ribbon|cloak|cape|antenna|fin|wing|breast|chain|rope|tassel/i;
  const danglerNameHints = snap.filter((b) => DANGLE.test(b.name)).map((b) => b.name).slice(0, 24);
  return { vrmSpringGroups, danglerNameHints, hasVrmSprings: vrmSpringGroups > 0 };
}

// ── derive the driver-facing summary from the structural facts above ──────────────
function deriveType(snap, cascade, health) {
  if (!snap.length) return "static";
  if (!health.ok) return "broken";
  const r = new Set(cascade.matched);
  const arms = r.has("left_arm") && r.has("right_arm");
  const legs = r.has("left_leg") && r.has("right_leg");
  if (arms && legs) return "biped";
  if (r.has("head") && cascade.matched.length <= 3) return "head-only";
  if (cascade.matched.length === 0) return "creature";   // bones but no humanoid roles (a dragon, etc.)
  return "partial-biped";
}

// What this model can actually be driven to DO. Motion is composed from PRIMITIVES (pose/flex
// layers + per-finger curl) — there is NO emote/gesture catalog — so this reports the drivable
// CHANNELS by resolved role, not a fixed action list. Final FEEL still needs a live look (STATUS.md).
function supportedActions(cascade, face, mats, springs) {
  const r = new Set(cascade.matched);
  const motion = {
    poseRoles: cascade.matched.slice(),                 // drive any of these via `pose` / `layer` motion layers
    look: r.has("head") ? "head + eyes track a screen point (lookAt)" : "no head role — no look",
    fingers: (r.has("left_hand") || r.has("right_hand"))
      ? "per-finger curl via `fingers` (if the resolved hand carries finger bones)"
      : "no hand role — no finger control",
    "blink (eyes)": face.blink.viable
      ? `${face.blink.system} — lids close ONLY on a real blink event (speech onset / AI tag / held setBlink); no autonomous blinking`
      : "no blink channel — eyes stay open",
    note: "no canned gestures/emotes — author movement as weighted pose/flex layers, or via `perform` (inline-tagged speech)",
  };
  const sayNote = (face.lipSyncViable ? "lip-sync ON — " : "lip-sync OFF — ") + face.lipSyncNote;
  const attach = ["left_hand", "right_hand", "head", "chest", "hips"].filter((b) => r.has(b));
  return {
    motion,
    say: sayNote,
    recolor: mats.count ? `by material index 0..${mats.count - 1}` : "none — model has no materials",
    attach,
  };
}

// ── full profile for one model file ──────────────────────────────────────────────
export function profile(file) {
  const key = urlKeyFor(file);
  let gltf;
  try { gltf = readGltfJson(file); }
  catch (e) { return { model: key, error: e.message }; }

  const snap = buildSnapshot(gltf);

  // health: a structural sanity check that DOESN'T trust names — except to flag when the
  // names themselves are the failure (mojibake makes the name tier useless).
  const corrupt = snap.filter((b) => b.name.includes(REPLACEMENT)).length;
  const notes = [];
  let ok = true;
  if (snap.length && corrupt / snap.length > 0.1) { ok = false; notes.push(`${corrupt}/${snap.length} bone names are corrupted (U+FFFD mojibake) — the name tier can't address them; needs a UTF-8 re-export`); }
  const health = { ok, bones: snap.length, notes };

  if (!snap.length) {
    return { model: key, file: path.basename(file), type: "static", health,
      lacks: ["any rig — a static mesh (load/size/move only; no animation, gestures, or lip-sync)"],
      note: "no skin/joints — a static mesh; load/size/move work, but nothing to animate or lip-sync" };
  }

  const cascade = runCascade(gltf, snap);

  // rig roles, addressed by ROLE (stable); bone name kept only as an opaque reference.
  const roles = {};
  for (const role of cascade.matched) {
    const b = snap[cascade.roleIds[role]];
    roles[role] = { bone: b.name, node: b.node, tier: cascade.source[role] };
  }

  const morphs = morphInfo(gltf);
  const vrmExpr = vrmExpressions(gltf);
  const mats = materialList(gltf);
  const springs = springInfo(gltf, snap);

  // facial system — MIRRORS facial.js's ACTUAL lip-sync ladder so the profile can't
  // promise a mouth the live engine won't move. Order: VRM preset → morph BY NAME
  // (the engine's OPEN_RE) → jaw BONE by /jaw/ → morphs present but UNNAMED (the engine's
  // name picker finds nothing → it falls back to a geometric jaw-drop pick) → none.
  // Mirrors facial.js OPEN_RE verbatim (kept in sync by hand; facial.js doesn't export it).
  const OPEN_RE = /jaw.?open|mouth.?open|mouthopen|(^|[._-])aa($|[._-])|vrc\.v_aa|viseme.?aa|fcl[._-]?mth[._-]?a$|(^|[._-])v[._-]open|あ/i;
  const morphNames = morphs.byMesh.flatMap((m) => m.names || []);
  const namedMouthMorph = morphNames.some((n) => OPEN_RE.test(n));
  const jawBone = snap.some((b) => /jaw/i.test(b.name));
  let system, lipSyncViable, lipSyncNote;
  if (vrmExpr.length) { system = "vrm-expressions"; lipSyncViable = true; lipSyncNote = "VRM 'aa' viseme + blink"; }
  else if (namedMouthMorph) { system = "morph(named)"; lipSyncViable = true; lipSyncNote = "a morph target is named like a mouth-open shape — amplitude-driven"; }
  else if (jawBone) { system = "jaw-bone"; lipSyncViable = true; lipSyncNote = "a /jaw/ bone flaps with audio amplitude"; }
  else if (morphs.total > 0) { system = "morph(unnamed)"; lipSyncViable = false; lipSyncNote = `${morphs.total} morph targets exist but NONE are named like a mouth shape. The live engine runs GEOMETRIC jaw-drop detection at load to find the mouth automatically (name-free) — confirm on the live overlay.`; }
  else { system = "none"; lipSyncViable = false; lipSyncNote = "no facial channel (no VRM expression, no mouth morph, no jaw bone) — speech plays, mouth stays still."; }

  // blink channel — MIRRORS facial.js's BLINK ladder (a SEPARATE channel from mouth since FACIAL v2:
  // VRM 'blink' preset -> named morph (BLINK_RE) -> eyelid BONES (LID_RE, no jaw needed) -> geometric.
  // Reported so the static profile is honest about a channel the engine drives. STRICT blink policy:
  // the engine fires blink ONLY on a real drive (speech onset / AI tag / held setBlink), never free-running.
  const BLINK_RE = /blink|eyes?.?clos|wink|fcl[._-]?eye[._-]?close|まばたき|ウィンク/i;  // == facial.js
  const LID_RE = /eye.?lid|eyelid|(^|[._-])lid($|[._-])|eye.?flap/i;                      // == facial.js (eye.?flap: glados' aperture flaps)
  const namedBlinkMorph = morphNames.some((n) => BLINK_RE.test(n));
  const lidBones = snap.filter((b) => LID_RE.test(b.name)).map((b) => b.name);
  let blinkSystem, blinkViable, blinkNote;
  if (vrmExpr.includes("blink")) { blinkSystem = "vrm-expressions"; blinkViable = true; blinkNote = "VRM 'blink' preset — driven on a real blink event only (no autonomous blinking)."; }
  else if (namedBlinkMorph) { blinkSystem = "morph(named)"; blinkViable = true; blinkNote = "a morph target is named like a blink/eyes-closed shape — driven on a real blink event only."; }
  else if (lidBones.length) { blinkSystem = "lid-bones"; blinkViable = true; blinkNote = `${lidBones.length} eyelid bone(s) close on a real blink event only (no jaw required).`; }
  else if (morphs.total > 0) { blinkSystem = "morph(unnamed)"; blinkViable = false; blinkNote = `${morphs.total} morph targets exist but NONE are named like a blink shape. The live engine runs GEOMETRIC eye-band detection at load to find an unnamed blink (name-free) — confirm on the live overlay.`; }
  else { blinkSystem = "none"; blinkViable = false; blinkNote = "no blink channel (no VRM 'blink', no blink morph, no eyelid bone) — eyes stay open."; }
  const blink = { system: blinkSystem, viable: blinkViable, note: blinkNote, lidBones };

  const face = { system, lipSyncViable, lipSyncNote, vrmExpressions: vrmExpr, morphTargets: morphs, jawBone, blink };

  const type = deriveType(snap, cascade, health);
  // Acknowledge ABSENT capabilities plainly — a model with no mouth / arms / etc. is stated
  // as such, never faked. (The engine already no-ops absent roles; this just surfaces it so
  // the driver knows, instead of trying a gesture that silently does nothing.)
  const rset = new Set(cascade.matched);
  const lacks = [];
  if (face.system === "none") lacks.push("a mouth / lip-sync channel (no jaw bone, no mouth morph, no VRM expression)");
  if (face.blink.system === "none") lacks.push("blink (eyes) — no eyelid bone, no blink morph, no VRM 'blink' (eyes stay open)");
  if (!rset.has("left_arm") && !rset.has("right_arm")) lacks.push("arms (no arm gestures)");
  if (!rset.has("left_leg") && !rset.has("right_leg")) lacks.push("legs");
  if (!rset.has("head")) lacks.push("a drivable head (no nod / shake / look)");
  return {
    model: key,
    file: path.basename(file),
    type,
    health,
    lacks,
    rig: {
      rolesResolved: cascade.matched.length,
      rolesTotal: ROLES.length,
      isVRM: cascade.isVRM,
      bySource: cascade.bySource,             // how each role was found (vrm/name/geometry)
      roles,                                  // role -> {bone(opaque), node, tier}
      unresolved: cascade.unresolved,
    },
    face,
    materials: mats,
    dynamics: { ...springs, note: "precise tail/hair/wire detection is confirmed by the live overlay; static hints are low-confidence" },
    supported: supportedActions(cascade, face, mats, springs),
    addressing: "Drive by ROLE, morph (mesh,index), and VRM PRESET. For MATERIAL recolor, get the index from the LIVE avatar_status (the running overlay is the authority — the material indices below are a static glTF-order PREVIEW that may not match the overlay's traversal order). The 'name'/'bone' strings are the model's own labels — display them if useful, but never match or branch on them; they differ across every model and can be corrupted.",
  };
}

// brief one-line-per-model menu (no-arg mode): enough for the AI to choose what to load.
function brief(file) {
  const p = profile(file);
  if (p.error) return { model: p.model, error: p.error };
  return {
    id: path.basename(path.dirname(file)),
    file: p.file,
    type: p.type,
    rolesResolved: p.rig?.rolesResolved ?? 0,
    rolesTotal: ROLES.length,
    materials: p.materials?.count ?? 0,
    morphs: p.face?.morphTargets?.total ?? 0,
    face: p.face?.system ?? "static",
    lipSync: p.face?.lipSyncViable ?? false,
    blink: p.face?.blink?.system ?? "static",
    lacks: p.lacks || [],
    healthy: p.health.ok,
  };
}

// resolve a CLI arg to a model file: an explicit path, or a model id/dir under models/.
function resolveTarget(arg) {
  const direct = path.resolve(arg);
  const all = discoverModels();
  if (all.some((f) => path.resolve(f) === direct)) return direct;
  const byId = all.find((f) => path.basename(path.dirname(f)).toLowerCase() === arg.toLowerCase()
    || path.basename(path.dirname(f)).toLowerCase().includes(arg.toLowerCase()));
  if (byId) return byId;
  return direct; // let readGltfJson surface a clear error if it doesn't exist
}

function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!arg) {
    const models = discoverModels();
    const menu = models.map((f) => brief(f));
    process.stdout.write(JSON.stringify({ models: menu, hint: "call avatar_describe with a model id for the full capability profile" }, null, 2) + "\n");
    return;
  }
  const file = resolveTarget(arg);
  process.stdout.write(JSON.stringify(profile(file), null, 2) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
