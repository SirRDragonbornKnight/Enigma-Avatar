// voice.js — speech playback + amplitude lip-sync.
// We do NOT synthesize speech in the renderer. Modkit's Kokoro TTS writes a WAV and
// sends {action:"say", url} over the bus; here we play it through a Web Audio
// AnalyserNode and drive the facial mouth from the signal's RMS each frame, so the
// jaw/visemes track loudness. No speechSynthesis fallback (by design).
//
// createVoice({ getFacial, onSpeakStart, onEnvelope, onSpeakEnd, setStatus }) → { speak, stop, isSpeaking }
//   getFacial()      → the current facial layer (it changes per model load)
//   onSpeakStart(dur)→ called when playback begins
//   onEnvelope(rms)  → live speech-loudness envelope (drives the co-speech body layer, P2)
//   onSpeakEnd()     → called when playback ends (clears the co-speech layer)
//   setStatus(msg)   → status line for errors
import { toAppUrl } from "../util/localurl.js";

export function createVoice({ getFacial, onSpeakStart, onEnvelope, onSpeakEnd, setStatus } = {}) {
  let audioCtx = null,
    srcNode = null,
    raf = 0,
    seq = 0,
    speaking = false;

  function stop() {
    seq++; // invalidate any in-flight load/playback
    speaking = false;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (srcNode) {
      try {
        srcNode.stop(0);
      } catch {}
      try {
        srcNode.disconnect();
      } catch {}
      srcNode = null;
    }
    const f = getFacial?.();
    if (f) f.setMouth(0);
    onEnvelope?.(0);
    onSpeakEnd?.(); // P2: speech ended -> drop the envelope + clear the co-speech layer
  }

  // Hard cap the read: a malicious/huge WAV off the bus must not be slurped into memory then decoded.
  // The cap is enforced on the actual byteLength (belt) with the Content-Length header as an early
  // abort (braces). XHR rather than fetch only because the streaming abort-at-header is simpler here.
  function loadBytes(url, maxBytes = 64 * 1024 * 1024) {
    // 64 MB — single-user local TTS WAVs are tiny
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 2) {
          const n = +xhr.getResponseHeader("Content-Length");
          if (n > maxBytes) {
            xhr.abort();
            reject(new Error("audio too large (" + n + " bytes)"));
          }
        }
      };
      xhr.onload = () => {
        if (!((xhr.status === 200 || xhr.status === 0) && xhr.response)) return reject(new Error("HTTP " + xhr.status));
        if (xhr.response.byteLength > maxBytes)
          return reject(new Error("audio too large (" + xhr.response.byteLength + " bytes)")); // backstop: file:// gives no Content-Length
        resolve(xhr.response);
      };
      xhr.onerror = () => reject(new Error("could not read audio"));
      xhr.send();
    });
  }

  // Decode to raw samples and play through an AudioBufferSource — NOT a MediaElement:
  // a file:// <audio> routed through Web Audio is treated as cross-origin and tainted,
  // which silences BOTH the sound and the analyser. Raw AudioBuffers never taint.
  async function speak(url, opts = {}) {
    if (/^https?:/i.test(url)) {
      setStatus?.("say blocked: remote URL (local audio only)");
      return;
    } // SECURITY: a bus {action:"say"} must not fetch arbitrary remote audio. Local file:///blob:/data: pass.
    url = toAppUrl(url); // file:///...wav from speak.py rides the app://enigma/@fs/ form (page origin is app://)
    stop();
    speaking = true; // mark NOW so isSpeaking() is true during the async load/decode too
    const myseq = seq; // this call's generation (stop() bumped it)
    const gain = opts.gain ?? 9.0; // RMS is small (~0.05–0.2); scale up to 0..1 mouth
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") {
        try {
          await audioCtx.resume();
        } catch {}
      }
      const bytes = await loadBytes(url);
      if (myseq !== seq) return; // superseded / stopped while loading
      const audioBuf = await audioCtx.decodeAudioData(bytes);
      if (myseq !== seq) return;
      const src = audioCtx.createBufferSource();
      src.buffer = audioBuf;
      const an = audioCtx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      an.connect(audioCtx.destination);
      srcNode = src;
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        if (myseq !== seq) return;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const env = Math.min(1, Math.sqrt(sum / buf.length) * gain);
        const f = getFacial?.();
        if (f) f.setMouth(env);
        onEnvelope?.(env); // P2: the same loudness drives co-speech BODY motion, not just the jaw
        raf = requestAnimationFrame(tick);
      };
      src.onended = () => {
        if (myseq === seq) stop();
      };
      src.start(0);
      onSpeakStart?.(opts.dur); // talking body language alongside the mouth
      tick();
    } catch (e) {
      setStatus?.("say failed: " + (e?.message || e));
      if (myseq === seq) stop();
    }
  }

  return { speak, stop, isSpeaking: () => speaking };
}
