// mathutil.js — PURE helper math (no three.js / DOM), so the trickiest logic in avatar.js / spring.js
// is unit-testable under `node --test`. The renderer imports these; tests import them directly.
// (Audit closed a gap: the rotation migration, the spring weight→feel mapping, and the adaptive-FPS
// pick all lived inside three-importing modules and had no coverage.)

// Normalize any angle to [0, 360). Handles negatives, NaN, strings, undefined.
export function norm360(v) { return ((((+v || 0) % 360) + 360) % 360); }

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// (ambientAmp — the ambient-idle depth→amplitude curve — was deleted with the idle system, 2026-06-12.)

// Read a per-avatar profile's rotation as {x,y,z}° — migrating the legacy single-axis `yaw` into the
// Y axis. Pure: takes the profile object, returns a fresh normalized rotation.
export function rotFromProfile(p) {
  if (p && p.rot && typeof p.rot === "object") return { x: norm360(p.rot.x), y: norm360(p.rot.y), z: norm360(p.rot.z) };
  return { x: 0, y: norm360(p && p.yaw), z: 0 };
}

// What to persist for a rotation: the normalized {x,y,z}, or null if it's all-zero (→ caller deletes
// the key so an untouched model doesn't bloat profiles.json). Caller also drops the legacy `yaw`.
export function rotToSave(r) {
  const x = norm360(r && r.x), y = norm360(r && r.y), z = norm360(r && r.z);
  return (!x && !y && !z) ? null : { x, y, z };
}

// Spring soft-body WEIGHT → physics feel. w: per-region jiggle weight (0=rigid/pinned, 1=default,
// up to 2=bouncy). Returns the scalar knobs the Verlet step uses, or {pin:true} to hold at rest.
//   stiff  — pull-to-rest (lower = looser = longer wobble)
//   dragv  — velocity damping (lower = more overshoot/bounce)
//   damp   — for w<1, how far to lerp the tip back toward rest each frame (less jiggle)
export function regionFeel(w, stiffness, drag, isGeo) {
  if (!(w > 0.001)) return { pin: true };
  const bounce = w > 1 ? w : 1;                       // >1 → loosen stiffness + drag for a bouncier feel
  const stiff = (isGeo ? 1.5 : 1) * stiffness / (0.4 + 0.6 * bounce);
  const dragv = clamp(drag / bounce, 0.05, 0.95);
  const damp = w < 1 ? 1 - w : 0;                     // w<1 → damp amplitude toward rest (0 at w≥1)
  return { pin: false, bounce, stiff, dragv, damp };
}

// Adaptive frame-rate pick: full rate when active; settle to IDLE, then REST after `restAfter`s idle.
export function pickFps(active, restClock, ACTIVE, IDLE, REST, restAfter = 6) {
  return active ? ACTIVE : (restClock > restAfter ? REST : IDLE);
}

// --- multi-window coordinate mapping (monitor rewrite) ----------------------
// The avatar has ONE global position in virtual-desktop DIP; each overlay window renders her offset by
// its own display. These map between the global DIP frame and a window's LOCAL CSS px. Mixed-DPI safe:
// the DIP↔CSS ratio uses THIS window's own bounds (never another monitor's scale factor). `bounds` is
// `{width,height}` in DIP (NB: width/height, matching main's init payload — a .w/.h typo here renders
// her ~1000× off-screen, which a from-rest render hides; this is why it's unit-tested).
export function dipToLocalPx(gx, gy, origin, bounds, innerW, innerH) {
  return [(gx - origin.x) * (innerW / (bounds.width || 1)), (gy - origin.y) * (innerH / (bounds.height || 1))];
}
export function localPxToDip(cx, cy, origin, bounds, innerW, innerH) {
  return [origin.x + cx * ((bounds.width || 1) / innerW), origin.y + cy * ((bounds.height || 1) / innerH)];
}
