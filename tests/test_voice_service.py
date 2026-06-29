"""Resident voice-service (voice/voice.py `Voice`) <-> `speak.py` client round-trip.

#6 (long-lived TTS): `speak.py` now routes synthesis through the resident service so the
Kokoro model loads ONCE instead of per utterance. This guards the wire contract on BOTH ends
WITHOUT loading Kokoro — a stub TTS provider is injected, so the test runs anywhere:

  * the length-prefixed response framing (the `_handle_client` fix — it used to send the
    response with no length prefix, which a client could not frame reliably), and
  * the per-request voice/speed pass-through added to `generate_audio`.

NOTE: this proves the PROTOCOL. The actual model-load-once latency win is unverified here
(needs a live Kokoro install) — by design, per the build decision.
"""

from __future__ import annotations

import importlib.util
import socket
import sys
import threading
import time
from pathlib import Path

import pytest

AVATAR_DIR = Path(__file__).resolve().parents[1]  # repo root (standalone Enigma Avatar repo)
if str(AVATAR_DIR) not in sys.path:
    sys.path.insert(0, str(AVATAR_DIR))

import speak  # the thin client under test (no Kokoro import at module load)


def _load_voice_module():
    """Import voice/voice.py by path (mirrors how speak.py loads it) to reach the `Voice` class."""
    spec = importlib.util.spec_from_file_location("_enigma_voice_test", AVATAR_DIR / "voice" / "voice.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


class _StubTTS:
    """Stand-in for LocalTTS: records calls, writes a tiny placeholder wav, never touches Kokoro."""

    def __init__(self):
        self.voice = "af_heart"
        self.speed = 1.0
        self.calls = []

    def load(self):
        return True

    def set_voice(self, v):
        self.voice = v
        return True

    def set_rate(self, r):
        self.speed = float(r)
        return True

    def generate_to_file(self, text, out_path=None):
        self.calls.append((text, self.voice, self.speed, str(out_path)))
        p = Path(out_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"RIFF\x00\x00\x00\x00WAVEstub")  # not real audio — the test never plays it
        return p

    def unload(self):
        pass


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture()
def voice_server():
    voice_mod = _load_voice_module()
    svc = voice_mod.Voice()
    stub = _StubTTS()
    svc.pipeline.tts = stub  # inject: _ensure_loaded sees a non-None tts and skips the real Kokoro load
    svc.pipeline.stt = _StubTTS()  # non-None so _ensure_loaded passes (unused by generate_audio)
    port = _free_port()
    threading.Thread(target=svc.run_standalone, kwargs={"port": port}, daemon=True).start()
    for _ in range(200):  # wait for the listener to bind
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.02)
    try:
        yield port, stub
    finally:
        svc.shutdown()


def test_speak_client_synth_via_service_roundtrip(voice_server):
    port, stub = voice_server
    wav = speak.synth_via_service("hello world", voice="am_adam", speed=1.2, port=port)
    assert wav.exists(), "the service must return a real on-disk wav path"
    # the per-request voice/speed reached the resident pipeline -> generate_audio param pass-through works
    assert stub.calls, "stub TTS was never asked to synthesize"
    text, voice, speed, _out = stub.calls[-1]
    assert text == "hello world"
    assert voice == "am_adam"
    assert speed == pytest.approx(1.2)


def test_request_unknown_command_reports_available(voice_server):
    port, _stub = voice_server
    payload = speak._request("does_not_exist", {}, port=port)
    assert payload.get("success") is False
    assert "available" in payload  # the service lists its commands back on an unknown action
