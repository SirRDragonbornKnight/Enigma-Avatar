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
    "mal0": "./models/mal0_scp-1471/mal0_scp-1471.glb", "spyro": "./models/spyro/scene.gltf",
    "grace": "./models/grace_howard/grace_howard.glb", "fexa": "./models/fexa_-_fnaf__cryptiacurves/fexa_-_fnaf__cryptiacurves.glb",
    "lolbit": "./models/fnaf_help_wanted__lolbit/fnaf_help_wanted__lolbit.glb",
    "chica": "./models/love-taste-toy-chica/love-taste-toy-chica.glb",
    "mangle": "./models/glamrock_mangleupdated/glamrock_mangleupdated.glb",
    "51dc": "./models/51dc47334dee42b9bb8e53ee07aa8006/51dc47334dee42b9bb8e53ee07aa8006.glb",
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
    if head == "drift":                                  # idle liveliness: 0=stiff, 1=default, 1.6=livelier
        return {"action": "tune", "drift": float(argv[1])}
    if head == "tune":                                   # tune any procedural idle param: `tune armSwing 0.2`
        return {"action": "tune", argv[1]: float(argv[2])}
    if head == "bones":                                  # show/hide the skeleton overlay: `bones on|off`
        on = argv[1].lower() not in ("off", "0", "false", "hide", "no") if len(argv) > 1 else True
        return {"action": "showBones", "on": on}
    if head in ("play", "clip", "anim"):                 # play a model's baked clip ONCE (partial name ok): `play idle`
        return {"action": "play", "name": argv[1]}
    if head == "loop":                                   # loop a baked clip: `loop walk`
        return {"action": "loop", "name": argv[1]}
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
