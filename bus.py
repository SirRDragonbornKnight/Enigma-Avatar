"""Avatar bus — a tiny local WebSocket relay so anything on the machine can drive
the on-screen avatar: Enigma / Odysseus (any LLM that speaks the JSON action
protocol) or the ``say.py`` CLI.

It is a dumb hub on ``ws://127.0.0.1:8765``. The avatar
(``mods/avatar/avatar.js`` → ``EnigmaAvatar.connect()``) joins as a *consumer*;
*producers* connect, send one JSON command, and the hub relays it to every
connected avatar. Commands are exactly the objects ``avatar.js`` ``handleCommand``
understands, e.g.::

    {"action": "pose",    "flex": {"right_arm": [1.0]}, "dur": 2}
    {"action": "load",    "url": "./models/glados/scene.gltf"}
    {"action": "size",    "value": 0.8}

Run standalone (the desktop overlay's Start-Avatar.ps1 launches it for you)::

    python mods/avatar/bus.py
"""
from __future__ import annotations

import asyncio
import json
import sys

import websockets

HOST, PORT = "127.0.0.1", 8765
CLIENTS: set = set()
_CLOSING: set = set()   # hold refs to in-flight close() tasks so the event loop can't GC them mid-close

# Local-trust boundary (CSWSH gate). Native clients (the overlay, avbus.py, modkit) send NO Origin
# header; Electron's file-loaded page sends "file://" or the opaque "null". A web page the user happens
# to visit sends its http(s) origin -> refuse it at the handshake. Keep this list tight: anything that
# allow-lists an http(s) origin re-opens cross-site WebSocket hijacking. (Regression-tested.)
ALLOWED_ORIGINS = [None, "file://", "null"]


async def _handler(ws) -> None:
    """Every client (avatars + producers) lands here. Anything one client sends
    is relayed to all the OTHERS — so a producer's command reaches the avatars."""
    CLIENTS.add(ws)
    print(f"avatar bus: client connected ({len(CLIENTS)} now)", file=sys.stderr, flush=True)
    try:
        async for raw in ws:
            try:
                cmd = json.loads(raw)
            except Exception:
                continue                       # ignore non-JSON
            if not isinstance(cmd, dict):
                continue                       # ignore non-objects; relay any dict — commands
                                               # AND replies (two-way: the overlay answers a
                                               # {"action":"query",...} with {"type":"reply",...})
            data = json.dumps(cmd)
            for c in list(CLIENTS):
                if c is ws:
                    continue                   # don't echo back to the producer
                try:
                    # 1s cap: one stuck consumer (frozen renderer, full TCP buffer) must not
                    # head-of-line-block every other producer/consumer on the hub forever.
                    await asyncio.wait_for(c.send(data), timeout=1.0)
                except Exception:
                    CLIENTS.discard(c)
                    # CLOSE it too — a merely-discarded socket stays open, so the overlay still
                    # believes it's connected and never auto-reconnects (silently severed).
                    try:
                        t = asyncio.ensure_future(c.close())
                        _CLOSING.add(t)                    # keep a ref (else the loop may drop the task)
                        t.add_done_callback(_CLOSING.discard)
                    except Exception:
                        pass
    except Exception:
        pass                                   # a dropped client must not crash the hub
    finally:
        CLIENTS.discard(ws)
        print(f"avatar bus: client left ({len(CLIENTS)} now)", file=sys.stderr, flush=True)


def serve(host: str = HOST, port: int = PORT):
    """The origin-gated relay server. Single source of truth for the handshake config so a test
    can exercise the REAL server (not a copy) — see tests/test_avatar_bus.py. A drive-by site could
    otherwise puppet the avatar (load arbitrary models, toggle meshes, read query replies) through
    ws://127.0.0.1; binding to localhost stops the network, not the browser. Returns the serve()
    async context manager."""
    return websockets.serve(_handler, host, port, origins=ALLOWED_ORIGINS)


async def main(host: str = HOST, port: int = PORT) -> None:
    async with serve(host, port):
        print(f"avatar bus: relaying on ws://{host}:{port}", file=sys.stderr, flush=True)
        await asyncio.Future()                 # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except OSError as exc:
        # Port already bound — another bus already owns it (e.g. a double launch).
        # That's fine: the existing hub serves everyone. Exit quietly, no traceback.
        print(f"avatar bus: {HOST}:{PORT} already in use ({exc}); "
              f"another instance is serving - exiting.", file=sys.stderr, flush=True)
