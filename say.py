"""say.py — fire one command at the avatar bus (mods/avatar/bus.py).

    python mods/avatar/say.py wag                 # emote (tail wag)
    python mods/avatar/say.py talk 4              # 'talk' body language for 4s
    python mods/avatar/say.py model mal0          # switch model (roxanne / toothless / glados / mal0 / spyro)
    python mods/avatar/say.py default             # show the zero-asset procedural placeholder (works with no model installed)
    python mods/avatar/say.py say file:///C:/tmp/speech.wav   # play a WAV + lip-sync the jaw/mouth
    python mods/avatar/say.py move 300 400        # move to screen x,y (pixels)
    python mods/avatar/say.py monitor next        # hop the overlay to the next monitor (or `monitor 1` / right-click → Move to monitor / Ctrl+Alt+M)
    python mods/avatar/say.py size 0.8            # resize
    python mods/avatar/say.py --raw '{"action":"load","url":"./models/glados/scene.gltf"}'
    python mods/avatar/say.py demo                # paced hello: a timed emote/size sequence (live-control demo)

Emotes: happy talk wag nod alert sad shake. Any other lone word is treated as an
emote too, so new emotes added to procedural.js just work. This is how Enigma /
Odysseus (or you) drive the avatar — same commands the bus relays to it.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import websockets

URI = "ws://127.0.0.1:8765"
HERE = Path(__file__).resolve().parent

# The 3 built-in models (committed in code; NOT in models.json), with their aliases.
BUILTINS = {
    "roxanne": "./models/roxanne_wolf/scene.gltf", "rox": "./models/roxanne_wolf/scene.gltf", "1": "./models/roxanne_wolf/scene.gltf",
    "toothless": "./models/toothless/scene.gltf", "nightfury": "./models/toothless/scene.gltf", "fury": "./models/toothless/scene.gltf", "2": "./models/toothless/scene.gltf",
    "glados": "./models/glados/scene.gltf", "3": "./models/glados/scene.gltf",
}
# Friendly short name -> models.json id. The model PATHS now live ONLY in models.json
# (the user-added manifest) — a single source of truth, so paths can't drift between here
# and the overlay. Models added via the UI are reachable here by their id automatically.
ALIASES = {
    "mal0": "mal0_scp-1471", "spyro": "spyro", "grace": "grace_howard",
    "fexa": "fexa_-_fnaf__cryptiacurves", "lolbit": "fnaf_help_wanted__lolbit",
    "chica": "love-taste-toy-chica", "mangle": "glamrock_mangleupdated",
    "51dc": "51dc47334dee42b9bb8e53ee07aa8006",
}


def _models_json() -> dict:
    """{id: url} from the mod's models.json (user-added models)."""
    try:
        data = json.loads((HERE / "models.json").read_text(encoding="utf-8"))
        return {m["id"]: m["url"] for m in data.get("models", []) if m.get("id") and m.get("url")}
    except Exception:
        return {}


def _resolve_model(key: str) -> str:
    """Built-ins → short alias → models.json id → raw path/url passthrough."""
    k = key.lower().replace(" ", "")
    if k in BUILTINS:
        return BUILTINS[k]
    mj = _models_json()
    if k in ALIASES and ALIASES[k] in mj:
        return mj[ALIASES[k]]
    if k in mj:
        return mj[k]
    return key


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
        return {"action": "load", "url": _resolve_model(argv[1])}
    if head in ("default", "placeholder", "blank"):      # the built-in zero-asset procedural figure (no model file needed)
        return {"action": "load", "url": "__default__"}
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
    if head in ("settings", "panel"):                    # open/close the Settings panel: `settings` / `settings off`
        return {"action": "settings", "open": (len(argv) < 2 or argv[1].lower() not in ("off", "hide", "close", "0"))}
    if head in ("snap", "screenshot", "shot"):           # capture the avatar (isolated, transparent bg) to a PNG to inspect
        c = {"action": "snap"}
        if len(argv) > 1 and argv[1].lower() in ("full", "all", "window"):
            c["full"] = True
        return c
    if head in ("reloadrig", "reload"):                  # re-read rig_overrides.json + re-resolve the current model live
        return {"action": "reloadRig"}
    if head in ("monitor", "display", "screen"):         # move the overlay between screens: `monitor next` (cycle L→R) or `monitor 1`
        arg = argv[1].lower() if len(argv) > 1 else "next"   # no arg → just hop to the next monitor
        if arg in ("next", "prev", "cycle"):
            return {"action": "setDisplay", "index": "prev" if arg == "prev" else "next"}
        return {"action": "setDisplay", "index": int(arg)}   # explicit screen.getAllDisplays() index (use the menu to see which is which)
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


# A short, paced "hello" — a timed sequence of emotes/size changes so the avatar reacts
# fluidly (vs one-off commands). Folded in from the old greet.py. Run: `say.py demo`.
DEMO_SEQUENCE = [
    (0.0, {"action": "express", "name": "happy", "dur": 2.0}),
    (1.7, {"action": "express", "name": "talk", "dur": 2.6}),
    (3.2, {"action": "express", "name": "wag"}),
    (4.4, {"action": "size", "value": 1.15}),
    (5.4, {"action": "express", "name": "nod"}),
    (6.4, {"action": "size", "value": 0.7}),
    (7.0, {"action": "express", "name": "alert"}),
]


async def _run_demo_async() -> None:
    async with websockets.connect(URI, open_timeout=3) as ws:
        t = 0.0
        for at, cmd in DEMO_SEQUENCE:
            if at > t:
                await asyncio.sleep(at - t)
                t = at
            await ws.send(json.dumps(cmd))
            print("sent", cmd, flush=True)
        await asyncio.sleep(1.0)


def _run_demo() -> int:
    try:
        asyncio.run(_run_demo_async())
        return 0
    except Exception as exc:
        print(f"could not reach the avatar bus at {URI}: {exc}", file=sys.stderr)
        return 2


def main() -> int:
    argv = sys.argv[1:]
    if argv and argv[0].lower() == "demo":      # paced greeting sequence (folded in from greet.py)
        return _run_demo()
    cmd = _parse(argv)
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
