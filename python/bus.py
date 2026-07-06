"""Avatar bus — a small local WebSocket hub so anything on the machine can drive
the on-screen avatar: Enigma / Odysseus (any LLM that speaks the JSON action
protocol) or the ``say.py`` CLI.

It serves ``ws://127.0.0.1:8765``. The avatar (``src/avatar.js`` →
``EnigmaAvatar.connect()``) joins as a *consumer*; *producers* connect and send
JSON commands. COMMANDS still broadcast to every other client, but requests
carrying a ``reqId`` get it REWRITTEN to a unique hub id, and the matching
``{"type":"reply",...}`` is routed back to the asker alone with its original id
restored — so two concurrent drivers can never consume each other's answers
(avbus.py's documented convention is literally ``"reqId": 1``). Replies matching
no pending hub id fall back to broadcast. Commands are exactly the objects
``src/control/bus.js`` ``handleCommand`` understands, e.g.::

    {"action": "pose",    "flex": {"right_arm": [1.0]}, "dur": 2}
    {"action": "load",    "url": "./models/glados/scene.gltf"}
    {"action": "size",    "value": 0.8}

Run standalone (the desktop overlay's Start-Avatar.ps1 launches it for you)::

    python python/bus.py
"""

from __future__ import annotations

import asyncio
import json
import sys

import websockets

HOST, PORT = "127.0.0.1", 8765
CLIENTS: set = set()
_CLOSING: set = set()  # hold refs to in-flight close() tasks so the event loop can't GC them mid-close

# Reply routing: reqIds are producer-chosen, so two overlapping drivers can collide (avbus.py's
# documented convention is literally "reqId": 1) and a broadcast reply would let them consume each
# other's answers. The hub REWRITES every request's reqId to a unique hub id before relaying and
# rewrites it back on the matching reply, delivering it ONLY to the asker — collisions are
# structurally impossible, and both ends still see their own ids. Replies whose reqId matches no
# pending hub id fall back to broadcast. Trade-off (deliberate): a promiscuous bus monitor sees
# every REQUEST and unrouted replies, but not routed replies. Bounded FIFO so abandoned ids can't
# grow forever.
PENDING: dict = {}  # hub reqId -> (requesting client, its original reqId); insertion order = FIFO
PENDING_MAX = 512
_req_seq = 0  # hub reqId counter

# Local-trust boundary (CSWSH gate). Native clients (say.py, avbus.py, any local driver) send NO
# Origin header; the overlay page is served from app://enigma (shell/main.cjs protocol handler) and
# sends exactly that. A web page the user happens to visit sends its http(s) origin -> refuse it at
# the handshake. Keep this list tight: anything that allow-lists an http(s) origin re-opens
# cross-site WebSocket hijacking. (Regression-tested; the file://-era "file://"/"null" entries died
# with the app:// cutover.)
ALLOWED_ORIGINS = [None, "app://enigma"]


async def _handler(ws) -> None:
    """Every client (avatars + producers) lands here. Commands broadcast to all the
    OTHERS (with reqIds rewritten to hub ids); replies route back to the asker alone."""
    CLIENTS.add(ws)
    print(f"avatar bus: client connected ({len(CLIENTS)} now)", file=sys.stderr, flush=True)
    try:
        async for raw in ws:
            try:
                cmd = json.loads(raw)
            except Exception:
                continue  # ignore non-JSON
            if not isinstance(cmd, dict):
                continue  # ignore non-objects; relay any dict — commands
                # AND replies (two-way: the overlay answers a
                # {"action":"query",...} with {"type":"reply",...})
            req_id = cmd.get("reqId")
            if cmd.get("type") == "reply" and req_id is not None:
                hit = PENDING.pop(req_id, None) if isinstance(req_id, str) else None
                if hit is not None:
                    target, orig = hit
                    if target in CLIENTS and target is not ws:
                        cmd["reqId"] = orig  # hand the asker back its OWN id
                        await _send(target, json.dumps(cmd))
                    continue  # routed (or the asker already left) — nobody else gets it
                # reply to no pending hub id -> fall through to broadcast
            elif req_id is not None:
                global _req_seq
                _req_seq += 1
                hub_id = f"hub:{_req_seq}"
                PENDING[hub_id] = (ws, req_id)  # route the matching reply back here
                while len(PENDING) > PENDING_MAX:
                    PENDING.pop(next(iter(PENDING)))
                cmd["reqId"] = hub_id
            data = json.dumps(cmd)
            for c in list(CLIENTS):
                if c is ws:
                    continue  # don't echo back to the producer
                await _send(c, data)
    except Exception as e:
        # a dropped client must not crash the hub — but a HUB LOGIC bug must not hide as a
        # normal disconnect either (fail honestly: normal closes are ConnectionClosed)
        if type(e).__name__ not in ("ConnectionClosed", "ConnectionClosedOK", "ConnectionClosedError"):
            print(f"avatar bus: client pump error: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
    finally:
        CLIENTS.discard(ws)
        for k in [k for k, v in PENDING.items() if v[0] is ws]:
            PENDING.pop(k, None)  # a leaving client's pending replies have nowhere to go
        print(f"avatar bus: client left ({len(CLIENTS)} now)", file=sys.stderr, flush=True)


async def _send(c, data: str) -> None:
    """Send with the 1s cap: one stuck consumer (frozen renderer, full TCP buffer) must not
    head-of-line-block every other producer/consumer on the hub forever."""
    try:
        await asyncio.wait_for(c.send(data), timeout=1.0)
    except Exception:
        CLIENTS.discard(c)
        # CLOSE it too — a merely-discarded socket stays open, so the overlay still
        # believes it's connected and never auto-reconnects (silently severed).
        try:
            t = asyncio.ensure_future(c.close())
            _CLOSING.add(t)  # keep a ref (else the loop may drop the task)
            t.add_done_callback(_CLOSING.discard)
        except Exception:
            pass


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
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except OSError as exc:
        # Port already bound — another bus already owns it (e.g. a double launch).
        # That's fine: the existing hub serves everyone. Exit quietly, no traceback.
        print(
            f"avatar bus: {HOST}:{PORT} already in use ({exc}); another instance is serving - exiting.",
            file=sys.stderr,
            flush=True,
        )
