"""speak.py — Kokoro TTS → avatar lip-sync.

Synthesizes `text` to a WAV using the **voice mod's** Kokoro-82M pipeline
(`mods/voice/voice.py` → `LocalTTS`, Apache-2.0, 100% local) and tells the overlay
to play it over the bus as ``{"action":"say","url":"file:///…wav"}``. The overlay
runs the audio through a Web-Audio AnalyserNode and flaps the jaw / drives the
mouth visemes from the signal's loudness (see avatar.js `speak`).

NO fallback TTS — if Kokoro isn't installed this fails loudly (by design).
Install once (no admin):  python -m pip install --user kokoro

    python mods/avatar/speak.py "hello, I am Enigma"
    python mods/avatar/speak.py --voice af_bella --speed 1.05 "a different voice"
    python mods/avatar/speak.py --no-send "just synthesize, don't play"
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
VOICE_MOD = HERE.parent / "voice" / "voice.py"
OUT_DIR = HERE / "outputs"
URI = "ws://127.0.0.1:8765"


def _load_local_tts():
    """Import LocalTTS from the voice mod by path (no sys.path pollution)."""
    if not VOICE_MOD.exists():
        raise RuntimeError(f"voice mod not found at {VOICE_MOD}")
    spec = importlib.util.spec_from_file_location("_enigma_voice_mod", VOICE_MOD)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod   # MUST register before exec, or voice.py's @dataclass fails
    spec.loader.exec_module(mod)   # (dataclasses resolves types via sys.modules[cls.__module__])
    return mod.LocalTTS


def synth(text: str, voice: str = "af_heart", speed: float = 1.0) -> Path:
    LocalTTS = _load_local_tts()
    tts = LocalTTS(voice=voice, speed=speed)
    if not tts.load():
        raise RuntimeError(
            "Kokoro TTS unavailable - install it (no fallback by design): "
            "python -m pip install --user kokoro")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"speak_{int(time.time() * 1000)}.wav"
    path = tts.generate_to_file(text, out_path=out)
    if not path:
        raise RuntimeError("Kokoro synthesis produced no audio")
    return Path(path)


async def _send_say(url: str) -> None:
    import websockets
    async with websockets.connect(URI, open_timeout=3) as ws:
        await ws.send(json.dumps({"action": "say", "url": url}))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Kokoro TTS -> avatar lip-sync")
    ap.add_argument("text", help="text to speak")
    ap.add_argument("--voice", default="af_heart", help="Kokoro voice (af_heart, af_bella, am_adam, ...)")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--no-send", action="store_true", help="synthesize only; don't play on the avatar")
    args = ap.parse_args(argv)

    try:
        wav = synth(args.text, args.voice, args.speed)
    except Exception as exc:
        print(f"TTS failed: {exc}", file=sys.stderr)
        return 1
    print(f"synthesized: {wav}")
    if args.no_send:
        return 0
    try:
        asyncio.run(_send_say(wav.as_uri()))   # file:///C:/…/speak_123.wav
        print(f"sent: say -> {wav.as_uri()}")
        return 0
    except Exception as exc:
        print(f"could not reach the avatar bus at {URI} "
              f"(is the overlay / bus.py running?): {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
