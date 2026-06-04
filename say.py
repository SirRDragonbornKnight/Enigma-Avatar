"""say.py — fire one command at the avatar bus (mods/avatar/bus.py).

    python mods/avatar/say.py wag                 # emote (tail wag)
    python mods/avatar/say.py talk 4              # 'talk' body language for 4s
    python mods/avatar/say.py model mal0          # switch model (roxanne / toothless / glados / mal0 / spyro)
    python mods/avatar/say.py say file:///C:/tmp/speech.wav   # play a WAV + lip-sync the jaw/mouth
    python mods/avatar/say.py move 300 400        # move to screen x,y (pixels)
    python mods/avatar/say.py size 0.8            # resize
    python mods/avatar/say.py --raw '{"action":"load","url":"./models/glados/scene.gltf"}'

Emotes: happy talk wag nod alert sad shake. Any other lone word is treated as an
emote too, so new emotes added to procedural.js just work. This is how Enigma /
Odysseus (or you) drive the avatar — same commands the bus relays to it.
"""
from __future__ import annotations

import asyncio
import json
import sys

import websockets

URI = "ws://127.0.0.1:8765"
MODELS = {
    "roxanne": "./models/roxanne_wolf/scene.gltf", "rox": "./models/roxanne_wolf/scene.gltf", "1": "./models/roxanne_wolf/scene.gltf",
    "toothless": "./models/toothless/scene.gltf", "nightfury": "./models/toothless/scene.gltf", "fury": "./models/toothless/scene.gltf", "2": "./models/toothless/scene.gltf",
    "glados": "./models/glados/scene.gltf", "3": "./models/glados/scene.gltf",
    "mal0": "./models/mal0/SCP.fbx", "spyro": "./models/spyro/scene.gltf",
}


def _parse(argv: list[str]) -> dict | None:
    if not argv:
        return None
    head = argv[0].lower()
    if head == "--raw":
        return json.loads(argv[1])
    if head == "size":
        return {"action": "size", "value": float(argv[1])}
    if head == "move":
        return {"action": "moveTo", "px": float(argv[1]), "py": float(argv[2])}
    if head == "model":
        key = argv[1].lower().replace(" ", "")
        return {"action": "load", "url": MODELS.get(key, argv[1])}
    if head == "say":                                    # play a speech WAV + lip-sync: `say file:///abs/path.wav`
        return {"action": "say", "url": argv[1]}
    if head == "attach":                                 # attach a prop to a bone: `attach ./models/mal0/Pole.fbx righthand`
        c = {"action": "attach", "url": argv[1]}
        if len(argv) > 2:
            c["bone"] = argv[2]
        return c
    if head == "detach":                                 # detach by id, or all props if no id
        return {"action": "detach", "id": argv[1] if len(argv) > 1 else None}
    if head == "recolor":                                # tint a material: `recolor hair #3366ff`
        return {"action": "recolor", "name": argv[1], "color": argv[2]}
    if head in ("express", "emote"):                     # explicit form: `express happy [dur]`
        c: dict = {"action": "express", "name": argv[1]}
        if len(argv) > 2:
            c["dur"] = float(argv[2])
        return c
    cmd: dict = {"action": "express", "name": head}      # bare form: a lone emote name
    if len(argv) > 1:
        cmd["dur"] = float(argv[1])
    return cmd


async def _send(cmd: dict) -> None:
    async with websockets.connect(URI, open_timeout=3) as ws:
        await ws.send(json.dumps(cmd))


def main() -> int:
    cmd = _parse(sys.argv[1:])
    if not cmd:
        print(__doc__)
        return 1
    try:
        asyncio.run(_send(cmd))
        print(f"sent: {cmd}")
        return 0
    except Exception as exc:
        print(f"could not reach the avatar bus at {URI} "
              f"(is the overlay / bus.py running?): {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
