// control.js — the P4 brain control channel (pure text parsing, no three.js).
// The brain writes motion intent INLINE in its speech as bracketed tags, e.g.
//   "Sure! [happy] let me show you. [conjure:sword] Here it is. [pose:left_arm=0.8]"
// parseControlTags() pulls the tags out (in order) and returns the spoken text with them removed,
// so the avatar drives motion AND speaks the clean line. This satisfies the rule-#1 constraint:
// the whole control surface is plain text an AI can author and a human can read — no opaque policy.

// A tag is [type] or [type:arg]. `type` must start with a letter (so "[1]" or "[note]" numerics
// stay as literal text). arg is everything up to the closing bracket. Returns { clean, tags }.
export function parseControlTags(text) {
  const tags = [];
  const s = String(text == null ? "" : text);
  const clean = s
    .replace(/\[([a-zA-Z][\w-]*)(?::([^\]]*))?\]/g, (_m, type, arg) => {
      tags.push({ type: type.toLowerCase(), arg: arg == null ? null : String(arg).trim() });
      return "";
    })
    .replace(/[ \t]{2,}/g, " ")     // collapse the double-spaces a removed mid-sentence tag leaves
    .replace(/\s+([,.!?;:])/g, "$1") // tidy " ." left when a tag preceded punctuation
    .trim();
  return { clean, tags };
}

// Split an action tag's arg into structured fields. Supports:
//   "left_arm=0.8,head=0.2"      -> { left_arm: [0.8,0,0], head: [0.2,0,0] }  (pitch-only; yaw/roll = 0)
//   "left_arm=0.8/0.2/0"         -> { left_arm: [0.8,0.2,0] }                 (full pitch/yaw/roll triple)
//   "sword"                      -> "sword"                                   (a bare token, for [conjure:sword])
// A numeric role value parses to a [pitch,yaw,roll] triple so the compositor's three rotation axes are all
// drivable: a lone scalar is pitch (yaw/roll default 0), and "p/y/r" fills all three. Missing/blank slots -> 0.
// A non-numeric value stays a string. Pure; the dispatcher in avatar.js feeds the triple straight to setLayer.
export function parseTagArg(arg) {
  if (arg == null || arg === "") return null;
  if (!arg.includes("=")) return arg;
  const out = {};
  for (const pair of arg.split(",")) {
    const [k, v] = pair.split("=");
    if (!k) continue;
    out[k.trim()] = parsePoseValue(v);
  }
  return out;
}

// parsePoseValue — turn a single role value into a [pitch,yaw,roll] triple of finite numbers, or, if it is
// not numeric at all, the trimmed string. "0.8" -> [0.8,0,0]; "0.8/0.2/0" -> [0.8,0.2,0]; "p//r" slots blank
// to 0. Only the first three slash-separated slots are used; non-finite slots fall back to 0.
function parsePoseValue(v) {
  const raw = String(v == null ? "" : v).trim();
  const slots = raw.split("/");
  const nums = slots.map((s) => Number(s.trim()));
  // String value (e.g. a named target) when the single, un-slashed token is not a finite number.
  if (slots.length === 1 && !Number.isFinite(nums[0])) return raw;
  return [0, 1, 2].map((i) => (Number.isFinite(nums[i]) ? nums[i] : 0));
}

// resolvePropName — map a conjure tag's arg to a loadable asset URL. A bare token (letters/digits/_/-)
// is looked up in the known-prop map; anything that looks like a path/URL (has a "." / "/" / ":") is
// used as-is; an unknown bare name returns null so the caller reports it honestly (never spawn a guess).
export function resolvePropName(name, assets = {}) {
  const k = String(name == null ? "" : name).trim();
  if (!k) return null;
  if (/^[\w-]+$/.test(k)) return assets[k.toLowerCase()] || null;   // bare token -> known-asset map
  return k;                                                          // looks like a path/URL -> use as-is
}
