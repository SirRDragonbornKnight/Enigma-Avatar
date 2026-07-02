"""Regression guard for the avatar bus CSWSH (cross-site WebSocket hijacking) gate.

The bus (``enigma-avatar/bus.py``) is a local relay on ``ws://127.0.0.1:8765`` that can
load models, toggle meshes, and read query replies. Binding to localhost stops the
*network*, but a web page the user happens to visit can still open a WebSocket to
127.0.0.1 from their browser — so the bus refuses any handshake carrying an http(s)
``Origin`` and accepts only native clients (no Origin) and Electron's file page
("file://" / the opaque "null").

That defense is one ``origins=`` kwarg on one line; a refactor could silently drop it
and nothing else would notice. This test exercises the REAL ``bus.serve()`` so it fails
loudly if the gate ever regresses.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

AVATAR_DIR = Path(__file__).resolve().parents[1]  # repo root (standalone Enigma Avatar repo)
PY_DIR = AVATAR_DIR / "python"  # bus.py / say.py / speak.py live under python/
if str(PY_DIR) not in sys.path:
    sys.path.insert(0, str(PY_DIR))

websockets = pytest.importorskip("websockets")
from websockets.exceptions import InvalidHandshake  # noqa: E402  (after importorskip guard)

import bus  # noqa: E402  (importable only after PY_DIR is on sys.path above)


async def _handshake_accepted(origin: str | None) -> bool:
    """Start the real origin-gated server on an ephemeral port, attempt one handshake with
    the given Origin, and report whether the server accepted it."""
    async with bus.serve(host="127.0.0.1", port=0) as server:
        port = server.sockets[0].getsockname()[1]
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port}", origin=origin, open_timeout=3):
                return True
        except InvalidHandshake:
            return False


@pytest.mark.parametrize(
    "origin,accepted",
    [
        ("http://evil.example", False),  # a drive-by web page MUST be refused (CSWSH)
        ("https://attacker.test", False),  # https is no safer than http here
        ("http://127.0.0.1:7000", False),  # even a same-host web origin is still a browser
        (None, True),  # native client (say.py / avbus / any local driver) sends no Origin
        ("app://enigma", True),  # the overlay page (served by the shell's app:// protocol handler)
        ("file://", False),  # the file:// era ended with the app:// cutover — no longer valid
        ("null", False),  # ditto the opaque file-page origin
    ],
)
def test_origin_gate(origin: str | None, accepted: bool) -> None:
    assert asyncio.run(_handshake_accepted(origin)) is accepted


def test_allowlist_carries_no_web_origin() -> None:
    """A cheap structural backstop: the allow-list must never contain an http(s) origin."""
    assert not any(isinstance(o, str) and o.startswith(("http://", "https://")) for o in bus.ALLOWED_ORIGINS)


async def _drain(sock, secs: float = 0.7) -> list:
    """Collect every message on `sock` until `secs` of silence."""
    out = []
    try:
        while True:
            out.append(json.loads(await asyncio.wait_for(sock.recv(), secs)))
    except asyncio.TimeoutError:
        return out


async def _routing_scenario() -> None:
    """Two drivers use the SAME reqId (avbus.py's documented convention is `"reqId": 1`) — the hub
    must rewrite ids so each driver gets ONLY its own answer, with its own id restored. Before the
    rewrite this cross-delivered: A's 'matched' reply carried B's payload (probe-proven)."""
    async with bus.serve(host="127.0.0.1", port=0) as server:
        port = server.sockets[0].getsockname()[1]
        uri = f"ws://127.0.0.1:{port}"
        async with (
            websockets.connect(uri) as drv_a,
            websockets.connect(uri) as drv_b,
            websockets.connect(uri) as overlay,
        ):
            await drv_a.send(json.dumps({"action": "query", "what": "model", "reqId": 1}))
            req_a = json.loads(await asyncio.wait_for(overlay.recv(), 3))
            await drv_b.send(json.dumps({"action": "query", "what": "bones", "reqId": 1}))
            req_b = json.loads(await asyncio.wait_for(overlay.recv(), 3))
            # requests still broadcast, but with hub-unique ids on the wire
            assert req_a["reqId"] != req_b["reqId"]
            # the overlay answers both, echoing the ids it saw (as the real overlay does)
            await overlay.send(json.dumps({"type": "reply", "reqId": req_a["reqId"], "result": "ANSWER-A"}))
            await overlay.send(json.dumps({"type": "reply", "reqId": req_b["reqId"], "result": "ANSWER-B"}))
            # ...and one reply nobody asked for: must fall back to broadcast
            await overlay.send(json.dumps({"type": "reply", "reqId": "never-asked", "result": "STRAY"}))
            got_a = await _drain(drv_a)
            got_b = await _drain(drv_b)
            # each driver gets exactly its own answer, under its OWN original reqId...
            assert [(m["reqId"], m["result"]) for m in got_a if m.get("type") == "reply" and m["result"] != "STRAY"] == [
                (1, "ANSWER-A")
            ]
            assert [(m["reqId"], m["result"]) for m in got_b if m.get("type") == "reply" and m["result"] != "STRAY"] == [
                (1, "ANSWER-B")
            ]
            # ...and the unregistered reply reached both (broadcast fallback intact)
            assert any(m.get("result") == "STRAY" for m in got_a)
            assert any(m.get("result") == "STRAY" for m in got_b)


def test_reply_routing_no_crosstalk() -> None:
    asyncio.run(_routing_scenario())
