"""speak.py — Kokoro TTS → avatar lip-sync.

Synthesizes `text` to a WAV with the vendored Kokoro-82M pipeline (`voice/voice.py`,
Apache-2.0, 100% local) and tells the overlay to play it over the bus as
``{"action":"say","url":"file:///…wav"}``. The overlay runs the audio through a
Web-Audio AnalyserNode and flaps the jaw / drives the mouth visemes from the
signal's loudness (see avatar.js `speak`).

By DEFAULT this routes through the **resident voice service** (`voice/voice.py`
`Voice.run_standalone`, 127.0.0.1:9907) so the Kokoro model loads ONCE and serves
every line — no per-utterance model reload. Start it once:

    python enigma-avatar/voice/voice.py --port 9907   # resident TTS daemon (loads Kokoro once)

NO silent fallback — if the service isn't running, this fails loudly and tells you
how to start it (or pass --local for a one-off in-process synth). Kokoro install
(no admin):  python -m pip install --user kokoro

    python enigma-avatar/speak.py "hello, I am Enigma"            # via the resident service
    python enigma-avatar/speak.py --voice af_bella --speed 1.05 "a different voice"
    python enigma-avatar/speak.py --no-send "just synthesize, don't play"
    python enigma-avatar/speak.py --local "no daemon — load Kokoro in this process"
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import socket
import struct
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
VOICE_MOD = HERE / "voice" / "voice.py"  # vendored Kokoro TTS (Apache-2.0) — this repo is standalone
OUT_DIR = HERE / "outputs"
URI = "ws://127.0.0.1:8765"
VOICE_HOST = "127.0.0.1"  # the resident voice service (voice/voice.py Voice.run_standalone)
VOICE_PORT = 9907  # loads Kokoro ONCE and serves every line — no per-utterance model reload


def _load_local_tts():
    """Import LocalTTS from the voice mod by path (no sys.path pollution)."""
    if not VOICE_MOD.exists():
        raise RuntimeError(f"voice mod not found at {VOICE_MOD}")
    spec = importlib.util.spec_from_file_location("_enigma_voice_mod", VOICE_MOD)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod  # MUST register before exec, or voice.py's @dataclass fails
    spec.loader.exec_module(mod)  # (dataclasses resolves types via sys.modules[cls.__module__])
    return mod.LocalTTS


def synth(text: str, voice: str = "af_heart", speed: float = 1.0) -> Path:
    """In-process synthesis (loads the Kokoro model THIS process). Used only by `--local`;
    the default path goes through the resident voice service so the model loads once."""
    LocalTTS = _load_local_tts()
    tts = LocalTTS(voice=voice, speed=speed)
    if not tts.load():
        raise RuntimeError(
            "Kokoro TTS unavailable - install it (no fallback by design): python -m pip install --user kokoro"
        )
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"speak_{int(time.time() * 1000)}.wav"
    path = tts.generate_to_file(text, out_path=out)
    if not path:
        raise RuntimeError("Kokoro synthesis produced no audio")
    return Path(path)


# --- resident voice-service client (length-prefixed JSON, matches voice.py Message framing) ------
def _recv_exact(sock: "socket.socket", n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("voice service closed the connection mid-response")
        buf += chunk
    return buf


def _request(command: str, params: dict, host: str = VOICE_HOST, port: int = VOICE_PORT, timeout: float = 30.0) -> dict:
    """One command round-trip to the resident voice service. Returns the response payload dict.
    Frames: 4-byte big-endian length + a JSON Message {type,payload,id,timestamp}."""
    req = {
        "type": "command",
        "payload": {"command": command, "params": params},
        "id": f"speak-{int(time.time() * 1000)}",
        "timestamp": time.time(),
    }
    data = json.dumps(req).encode("utf-8")
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(struct.pack(">I", len(data)) + data)
        (msg_len,) = struct.unpack(">I", _recv_exact(sock, 4))
        resp = json.loads(_recv_exact(sock, msg_len).decode("utf-8"))
    return resp.get("payload", {})


def synth_via_service(
    text: str, voice: str = "af_heart", speed: float = 1.0, host: str = VOICE_HOST, port: int = VOICE_PORT
) -> Path:
    """Ask the resident voice service to synthesize `text` (Kokoro already loaded there)."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"speak_{int(time.time() * 1000)}.wav"
    payload = _request(
        "generate_audio",
        {"text": text, "voice": voice, "speed": speed, "out_path": str(out)},
        host=host,
        port=port,
    )
    if not payload.get("success"):
        raise RuntimeError(f"voice service synthesis failed: {payload.get('error', 'unknown error')}")
    path = payload.get("path")
    if not path:
        raise RuntimeError("voice service returned no audio path")
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
    ap.add_argument(
        "--local",
        action="store_true",
        help="synthesize IN THIS PROCESS (loads Kokoro here) instead of the resident voice service",
    )
    ap.add_argument("--port", type=int, default=VOICE_PORT, help="resident voice-service port")
    args = ap.parse_args(argv)

    try:
        if args.local:
            wav = synth(args.text, args.voice, args.speed)
        else:
            wav = synth_via_service(args.text, args.voice, args.speed, port=args.port)
    except (ConnectionError, OSError) as exc:
        # No silent fallback (matches this file's "fail loudly" ethos): tell the user how to start the
        # service, or to pass --local for a one-off in-process synth.
        print(
            f"voice service not reachable at {VOICE_HOST}:{args.port} ({exc}).\n"
            f"  start it:  python \"{VOICE_MOD}\" --port {args.port}\n"
            f"  or one-off in-process:  python \"{Path(__file__).name}\" --local \"{args.text}\"",
            file=sys.stderr,
        )
        return 2
    except Exception as exc:
        print(f"TTS failed: {exc}", file=sys.stderr)
        return 1
    print(f"synthesized: {wav}")
    if args.no_send:
        return 0
    try:
        asyncio.run(_send_say(wav.as_uri()))  # file:///C:/…/speak_123.wav
        print(f"sent: say -> {wav.as_uri()}")
        return 0
    except Exception as exc:
        print(f"could not reach the avatar bus at {URI} (is the overlay / bus.py running?): {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
