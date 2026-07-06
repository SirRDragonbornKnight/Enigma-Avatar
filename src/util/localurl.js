// localurl.js — map external local references onto the app:// origin.
//
// The overlay page is served from app://enigma (shell/main.cjs protocol handler), so the renderer
// cannot load file:// URLs any more (cross-origin to a standard scheme). Everything LOCAL the bus
// or a profile hands us — file:///C:/...  or a raw Windows path C:\... — is rewritten to the
// handler's /@fs/ form, which serves exactly that absolute path. Relative refs, blob:, data:, and
// app:// pass through untouched. This is the ONE place that mapping lives; the loader and the
// voice player both call it at their boundary.
export function toAppUrl(u) {
  const s = String(u);
  if (/^(blob:|data:|app:|https?:)/i.test(s)) return s; // handled (or rejected) elsewhere
  if (/^file:\/\//i.test(s)) {
    // file:///C:/Users/... -> /@fs/C:/Users/...  (strip the scheme + an optional "localhost"
    // authority + leading slashes, keep the already-percent-encoded path as-is)
    const p = s.replace(/^file:\/\/(localhost)?/i, "").replace(/^\/+/, "");
    return "app://enigma/@fs/" + p;
  }
  if (/^[A-Za-z]:[\\/]/.test(s)) {
    // Raw Windows drive path -> forward slashes under /@fs/, percent-encoded PER SEGMENT so a
    // filename's #, ?, or % can't be eaten as a fragment/query or break the handler's decode
    // (encodeURI leaves #/?/% alone). The drive colon is restored for readability.
    // (UNC \\server\... is deliberately NOT mapped — never exercised here; it fails honestly.)
    const enc = s.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/%3A/gi, ":");
    return "app://enigma/@fs/" + enc;
  }
  return s; // relative to the bundle (./models/..., ./assets/...) — resolves against app://enigma
}
