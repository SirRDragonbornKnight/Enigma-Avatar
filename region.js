// region.js — PURE bone-name → region classifier (no three.js import, so it's unit-testable
// under `node --test`). spring.js imports this to tag each sprung bone with a region, and the
// Settings panel gives each region its own jiggle weight. TRUST NO NAMES still holds: this maps
// a name to a structural ROLE only as a heuristic — the weight is applied to whatever bones
// actually carry that role, addressed by the spring, never by a single trusted name.
//
// FIRST match wins, so order matters: body / NSFW regions are checked before the generic dangly
// ones. Guards that bite real rigs (each has a unit test):
//   butt(?!on|er) → "Button"/"Butterfly" aren't butts;  fin(?!ger) → fingers aren't fins;
//   ear: standalone-or-left/right-prefixed only → "Gear"/"Linear"/"REARshoulder"/"hEARt" aren't ears;
//   knot needs no top/hair/rope/bow prefix → "TopKnot"/"HairKnot" are buns, "KnotBase" still counts;
//   (?<![a-z])anal(?!og) → "Canal"/"banal"/"AnalogStick" aren't;  (?<![a-z])cock(?!pit|tail|atoo) →
//   "Peacock"/"Cockpit" aren't;  (?<![a-z])ass(?![a-z]) → "Bass"/"Assistant" aren't.
// "dick" carries NO word boundary on purpose — Mal0's bone is "DE-Dick1" (k runs straight into 1).
export const REGIONS = [
  // distinct NSFW areas get their OWN region (→ their own weight slider) — Mal0 carries all three as
  // separate chains (Pussy*, AssHole*, DE-Dick*) and lumping them under one "genital" weight meant the
  // user couldn't tune/disable them individually ("we are missing a few weights").
  ["dick",      /penis|dick|sheath|(?<!top[_ ]{0,2})(?<!hair[_ ]{0,2})(?<!rope[_ ]{0,2})(?<!bow[_ ]{0,2})(?<!braid[_ ]{0,2})(?<!bun[_ ]{0,2})knot|testicl|scrotum|futa|(?<![a-z])cock(?!pit|tail|atoo|le|er)/i],   // NO "bulge": muscle/eye correctives (Bicep_Bulge, EyeBulge) are far commoner than NSFW bulge bones (audit regression)
  ["anus",      /asshole|anus|(?<![a-z])anal(?!og|y)/i],
  ["genital",   /pussy|vagin|genital|crotch|vulva|(?<![a-z])clit(?!ell)|groin/i],
  ["breast",    /breast|boob|bust|oppai|nipple|titty|(?<![a-z])tits?(?![a-z])/i],
  ["butt",      /butt(?!on|er)|glute|booty|(?<![a-z])ass(?![a-z])/i],
  ["belly",     /belly|tummy|stomach|abdomen/i],
  ["hair",      /hair|ponytail|twintail|pigtail|bangs?|fringe|ahoge|strand|braid/i],
  ["tail",      /tail/i],
  ["ear",       /(?<![a-z])ear(?!t|l)|(?<=left)ear|(?<=right)ear|(?<=(?<![a-z])h)ear(?!t|i|d|s)/i],   // standalone (not Early), Left/Right-prefixed, or "Hear" (Mal0's spelling) — not Gear/Linear/heart/forearm/Hearing/Heard/Shears
  ["wing",      /wing|fin(?!ger)/i],
  ["cloth",     /cloth|skirt|dress|cape|cloak|scarf|frill|tassel|ribbon|coat|robe|sleeve|apron|kilt/i],
  ["accessory", /fluff|whisker|antenna|horn|chain|wire|cable|\brope\b|string/i],
];
const GENERIC_JIGGLE = /jiggle|bounce|wobble|sway|dangle|soft|squish/i;

// → region name, or null if the name doesn't read as a sprung (dangly / soft-body) part.
export function classifyBone(name) {
  const s = String(name || "");
  for (const [region, re] of REGIONS) if (re.test(s)) return region;
  return GENERIC_JIGGLE.test(s) ? "jiggle" : null;
}

// Regions a user typically thinks of as "NSFW" — surfaced together so they can be tuned / hidden.
export const NSFW_REGIONS = new Set(["breast", "butt", "genital", "dick", "anus"]);
