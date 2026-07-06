// profiles.js — the per-avatar profile STORE.
//
// The store owns the ONE mutable `profiles` object —
// every outside consumer goes through profileFor(); nothing else may touch the raw map.
//
// A profile is per-model durable setup keyed by model URL: attachments (by category), tuned
// spring/facial physics, colors, rotation, region weights. profiles.json (written by the shell over
// IPC) is the durable store; a localStorage mirror is only the no-IPC (plain browser) fallback.
//
// createProfileStore(deps) — everything impure is INJECTED (the closure-thunk pattern the control
// plane uses), so the store runs headless under node --test:
//   readJson()        -> Promise<object|null>   read profiles.json off the bundle
//   saveIpc(data)     -> Promise<{ok}|{error}>|undefined   persist via the shell (absent in browser)
//   isWriter()        -> bool   the ONE-writer rule: peers apply relayed mutations in-memory only —
//                       a peer's partial copy must never clobber profiles.json
//   mirror            -> localStorage-shaped {getItem,setItem} or null
//   logError(msg)     -> loud persistence-failure channel (console + main-process log)
//   getKey()          -> current model key   ·   getAttachments() -> live attachment list
export const PROFILE_KEY = "enigmaAvatar.profiles";

export function createProfileStore({ readJson, saveIpc, isWriter, mirror, logError, getKey, getAttachments }) {
  let profiles = {};
  let _timer = 0;
  const ok = (p) => p && typeof p === "object" && !Array.isArray(p); // a non-object blob would round-trip garbage into every profileFor()

  const profileFor = (key) => profiles[key] || (profiles[key] = {});

  async function loadProfiles() {
    const j = await readJson();
    if (ok(j)) {
      profiles = j;
      return;
    }
    try {
      const l = JSON.parse(mirror?.getItem(PROFILE_KEY));
      profiles = ok(l) ? l : {};
    } catch {
      profiles = {};
    }
  }

  function saveProfileSoon() {
    // debounced persist of the whole profiles object (no attachment snapshot)
    if (!isWriter()) return;
    clearTimeout(_timer);
    _timer = setTimeout(() => {
      const data = JSON.stringify(profiles, null, 2);
      // LOUD degrade: saveIpc returns {ok}|{error} — swallowing a failed write loses the user's
      // tuned attachments/physics on the next launch with zero trace (the bone_limits lesson:
      // a silent persistence failure can hide for weeks).
      Promise.resolve(saveIpc(data))
        .then((r) => {
          if (r && r.error) logError("[avatar] profiles.json save FAILED: " + r.error);
        })
        .catch((e) => logError("[avatar] profiles.json save FAILED: " + e));
      try {
        mirror?.setItem(PROFILE_KEY, data);
      } catch {}
    }, 400);
  }

  // Snapshot the CURRENT model's live attachments into its profile — called ONLY by attach
  // mutations, never by recolor/tune. So a recolor fired mid-restore (while props are still
  // async-loading) can't truncate the saved list. Transient blob: urls are
  // never persisted (a restored blob URL is a dead pointer).
  function commitAttachments() {
    profileFor(getKey()).attachments = getAttachments()
      .filter((a) => !String(a.url).startsWith("blob:"))
      .map((a) => ({
        id: a.id,
        category: a.category,
        url: a.url,
        bone: a.bone,
        pos: a.pos,
        rot: a.rot,
        scale: a.scale,
      }));
  }

  return { profileFor, loadProfiles, saveProfileSoon, commitAttachments };
}
