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
import sys
from pathlib import Path

import pytest

AVATAR_DIR = Path(__file__).resolve().parents[1]  # repo root (standalone Enigma Avatar repo)
if str(AVATAR_DIR) not in sys.path:
    sys.path.insert(0, str(AVATAR_DIR))

websockets = pytest.importorskip("websockets")
from websockets.exceptions import InvalidHandshake

import bus


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
        (None, True),  # native client (overlay / say.py / avbus) sends no Origin
        ("file://", True),  # Electron's file-loaded page
        ("null", True),  # the opaque origin some browsers use for file pages
    ],
)
def test_origin_gate(origin: str | None, accepted: bool) -> None:
    assert asyncio.run(_handshake_accepted(origin)) is accepted


def test_allowlist_carries_no_web_origin() -> None:
    """A cheap structural backstop: the allow-list must never contain an http(s) origin."""
    assert not any(isinstance(o, str) and o.startswith(("http://", "https://")) for o in bus.ALLOWED_ORIGINS)
