"""greet.py — play a short, paced 'hello' on the avatar over the bus.

A single connection that fires a timed sequence of emotes/size changes, so the
avatar reacts fluidly in real time (vs. one-off say.py calls). Handy as a demo of
live control, and as a canned greeting Enigma/Odysseus could trigger.

    python mods/avatar/greet.py
"""
from __future__ import annotations

import asyncio
import json
import sys

import websockets

URI = "ws://127.0.0.1:8765"

# (seconds-from-start, command) — paced so each reaction is distinct.
SEQUENCE = [
    (0.0, {"action": "express", "name": "happy", "dur": 2.0}),
    (1.7, {"action": "express", "name": "talk", "dur": 2.6}),
    (3.2, {"action": "express", "name": "wag"}),
    (4.4, {"action": "size", "value": 1.15}),
    (5.4, {"action": "express", "name": "nod"}),
    (6.4, {"action": "size", "value": 0.7}),
    (7.0, {"action": "express", "name": "alert"}),
]


async def main() -> int:
    try:
        async with websockets.connect(URI, open_timeout=3) as ws:
            t = 0.0
            for at, cmd in SEQUENCE:
                if at > t:
                    await asyncio.sleep(at - t)
                    t = at
                await ws.send(json.dumps(cmd))
                print("sent", cmd, flush=True)
            await asyncio.sleep(1.0)
        return 0
    except Exception as exc:
        print(f"could not reach the avatar bus at {URI}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
