"""Avatar bus — a tiny local WebSocket relay so anything on the machine can drive
the on-screen avatar: Enigma/Odysseus (via the modkit MCP tool ``avatar_express``)
or the ``say.py`` CLI.

It is a dumb hub on ``ws://127.0.0.1:8765``. The avatar
(``mods/avatar/avatar.js`` → ``EnigmaAvatar.connect()``) joins as a *consumer*;
*producers* connect, send one JSON command, and the hub relays it to every
connected avatar. Commands are exactly the objects ``avatar.js`` ``handleCommand``
understands, e.g.::

    {"action": "express", "name": "wag", "dur": 2.5}
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
            if not isinstance(cmd, dict) or "action" not in cmd:
                continue                       # ignore anything that isn't a command
            data = json.dumps(cmd)
            for c in list(CLIENTS):
                if c is ws:
                    continue                   # don't echo back to the producer
                try:
                    await c.send(data)
                except Exception:
                    CLIENTS.discard(c)
    except Exception:
        pass                                   # a dropped client must not crash the hub
    finally:
        CLIENTS.discard(ws)
        print(f"avatar bus: client left ({len(CLIENTS)} now)", file=sys.stderr, flush=True)


async def main(host: str = HOST, port: int = PORT) -> None:
    async with websockets.serve(_handler, host, port):
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
              f"another instance is serving — exiting.", file=sys.stderr, flush=True)
