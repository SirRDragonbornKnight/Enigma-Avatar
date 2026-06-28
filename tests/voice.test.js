// voice.test.js — the speech-playback control surface. Headless: we only exercise the bus-gate
// decision (the remote-url reject), which returns before any Web Audio / XHR is touched, so no DOM
// is needed. Locks the audit 2026-06-26 gate: a {action:"say",url} must not fetch remote audio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoice } from "../voice.js";

test("bus gate: voice.speak BLOCKS remote http(s) audio urls (honest status, no fetch)", async () => {
  let status = null;
  const v = createVoice({
    getFacial: () => null,
    setStatus: (m) => {
      status = m;
    },
  });
  await v.speak("https://evil.test/a.wav");
  assert.match(String(status), /say blocked: remote/i, "https say blocked with an honest status");
  status = null;
  await v.speak("http://evil.test/b.wav");
  assert.match(String(status), /say blocked: remote/i, "http say blocked too");
  assert.equal(v.isSpeaking(), false, "blocked say never entered the speaking state");
});
