"""say.py - fire one command at the avatar bus (enigma-avatar/bus.py).

    python enigma-avatar/say.py model mal0          # switch model (roxanne / toothless / glados / mal0 / spyro / ...)
    python enigma-avatar/say.py default             # show the zero-asset procedural placeholder (works with no model installed)
    python enigma-avatar/say.py size 0.8            # resize
    python enigma-avatar/say.py move 300 400        # move to screen x,y (pixels)
    python enigma-avatar/say.py goto center         # ease to a named anchor (center / topleft / cursor / ...)
    python enigma-avatar/say.py monitor next        # hop the overlay to the next monitor (or `monitor 1`)
    python enigma-avatar/say.py look 800 400        # aim her gaze at a screen point
    python enigma-avatar/say.py fingers R 1         # curl the right hand to a fist (0 = open, `none` = release to grip)
    python enigma-avatar/say.py perform "Hi! [pose:right_arm=1.0]"   # drive motion from inline-tagged speech (the AI's channel)
    python enigma-avatar/say.py say file:///C:/tmp/speech.wav        # play a WAV + lip-sync the jaw/mouth
    python enigma-avatar/say.py snap                # capture her to a transparent PNG to inspect
    python enigma-avatar/say.py --raw '{"action":"pose","flex":{"right_arm":[1.0]},"dur":2}'   # any handleCommand action

Motion is composed from PRIMITIVES - there is no emote/gesture catalog. The avatar moves
via `pose` / `layer` motion layers + per-finger `fingers`, or via `perform` (inline-tagged
speech). The lower-level compositor actions (`pose`, `layer`, `conjure`) take structured
args - send those with `--raw`. This is the same channel Enigma / Odysseus drive her over.
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
    "roxanne": "./models/roxanne_wolf/scene.gltf",
    "rox": "./models/roxanne_wolf/scene.gltf",
    "1": "./models/roxanne_wolf/scene.gltf",
    "toothless": "./models/toothless/scene.gltf",
    "nightfury": "./models/toothless/scene.gltf",
    "fury": "./models/toothless/scene.gltf",
    "2": "./models/toothless/scene.gltf",
    "glados": "./models/glados/scene.gltf",
    "3": "./models/glados/scene.gltf",
}
# Friendly short name -> models.json id. The model PATHS now live ONLY in models.json
# (the user-added manifest) - a single source of truth, so paths can't drift between here
# and the overlay. Models added via the UI are reachable here by their id automatically.
ALIASES = {
    "mal0": "mal0_scp-1471",
    "spyro": "spyro",
    "grace": "grace_howard",
    "fexa": "fexa_-_fnaf__cryptiacurves",
    "lolbit": "fnaf_help_wanted__lolbit",
    "chica": "love-taste-toy-chica",
    "mangle": "glamrock_mangleupdated",
    "51dc": "51dc47334dee42b9bb8e53ee07aa8006",
}


def _models_json() -> dict:
    """{id: url} from the mod's models.json (user-added models)."""
    try:
        data = json.loads((HERE.parent / "models.json").read_text(encoding="utf-8"))
        return {m["id"]: m["url"] for m in data.get("models", []) if m.get("id") and m.get("url")}
    except Exception:
        return {}


def _resolve_model(key: str) -> str:
    """Built-ins -> short alias -> models.json id -> raw path/url passthrough."""
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
    if head in ("default", "placeholder", "blank"):  # the built-in zero-asset procedural figure (no model file needed)
        return {"action": "load", "url": "__default__"}
    if head == "say":  # play a speech WAV + lip-sync: `say file:///abs/path.wav`
        return {"action": "say", "url": argv[1]}
    if head == "attach":  # attach a prop to a bone: `attach ./models/mal0/Pole.fbx righthand`
        c = {"action": "attach", "url": argv[1]}
        if len(argv) > 2:
            c["bone"] = argv[2]
        return c
    if head == "detach":  # detach by id, or all props if no id
        return {"action": "detach", "id": argv[1] if len(argv) > 1 else None}
    if head == "recolor":  # tint a material: `recolor hair #3366ff`
        return {"action": "recolor", "name": argv[1], "color": argv[2]}
    if head == "bones":  # show/hide the skeleton overlay: `bones on|off`
        on = argv[1].lower() not in ("off", "0", "false", "hide", "no") if len(argv) > 1 else True
        return {"action": "showBones", "on": on}
    if head in ("settings", "panel"):  # open/close the Settings panel: `settings` / `settings off`
        return {"action": "settings", "open": (len(argv) < 2 or argv[1].lower() not in ("off", "hide", "close", "0"))}
    if head in ("snap", "screenshot", "shot"):  # capture the avatar (isolated, transparent bg) to a PNG to inspect
        c = {"action": "snap"}
        if len(argv) > 1 and argv[1].lower() in ("full", "all", "window"):
            c["full"] = True
        return c
    if head in (
        "monitor",
        "display",
        "screen",
    ):  # move the overlay between screens: `monitor next` (cycle L->R) or `monitor 1`
        arg = argv[1].lower() if len(argv) > 1 else "next"  # no arg -> just hop to the next monitor
        if arg in ("next", "prev", "cycle"):
            return {"action": "setDisplay", "index": "prev" if arg == "prev" else "next"}
        return {
            "action": "setDisplay",
            "index": int(arg),
        }  # explicit screen.getAllDisplays() index (use the menu to see which is which)
    if head == "goto":  # ease to a named anchor: `goto center` / topleft / topright / cursor ...
        return {"action": "goTo", "to": argv[1] if len(argv) > 1 else "center"}
    if head == "look":  # aim her gaze at a screen point: `look 800 400`
        return {"action": "lookAt", "px": float(argv[1]), "py": float(argv[2])}
    if (
        head == "fingers"
    ):  # curl a hand 0..1, or `none` to release to the reactive grip: `fingers R 1` / `fingers L none`
        side = argv[1].upper() if len(argv) > 1 else "R"
        if len(argv) > 2 and argv[2].lower() in ("none", "release", "off"):
            val = None
        else:
            val = float(argv[2]) if len(argv) > 2 else 1.0
        return {"action": "fingers", "side": side, "curl": val}
    if head == "perform":  # drive motion from inline-tagged speech: `perform "Watch this! [pose:right_arm=1.0]"`
        return {"action": "perform", "text": " ".join(argv[1:])}
    # Unknown verb. Motion is composed from primitives now (no emote catalog), so a lone word
    # is NOT an emote -- fail honestly instead of sending a dead `express`. Author movement with
    # `pose` / `layer` / `fingers` / `perform` (structured layers go via --raw).
    print(f"unknown command: {head!r}\n", file=sys.stderr)
    print(__doc__, file=sys.stderr)
    return None


async def _send(cmd: dict) -> None:
    async with websockets.connect(URI, open_timeout=3) as ws:
        await ws.send(json.dumps(cmd))


# A short, paced showcase built ENTIRELY from the live primitives (perform + pose/flex
# layers + per-finger curl + size), so it reflects how the avatar is actually driven now.
# Run: `say.py demo`. (No emote catalog -- this IS the motion model.)
DEMO_SEQUENCE = [
    (0.0, {"action": "perform", "text": "Hi! Watch this."}),  # speak a line; the motion is the layers below
    (
        0.4,
        {"action": "pose", "flex": {"right_arm": [1.1], "right_forearm": [0.5]}, "dur": 4.5, "id": "demo"},
    ),  # raise the right hand (self-expires)
    (1.6, {"action": "fingers", "side": "R", "curl": 1.0}),  # close it to a fist
    (2.7, {"action": "fingers", "side": "R", "spec": {"default": 1, "index": 0}}),  # hold up one finger
    (4.0, {"action": "fingers", "side": "R", "curl": None}),  # release the hand to the reactive grip
    (4.4, {"action": "size", "value": 1.15}),
    (5.4, {"action": "size", "value": 1.0}),
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
    if argv and argv[0].lower() == "demo":  # paced greeting sequence built from the live primitives
        return _run_demo()
    try:
        cmd = _parse(argv)
    except (IndexError, ValueError) as exc:  # missing/invalid arg for a verb -> honest one-liner, not a raw traceback
        print(f"bad arguments for {argv[0]!r}: {exc}\n", file=sys.stderr)
        print(__doc__, file=sys.stderr)
        return 1
    if not cmd:
        print(__doc__)
        return 1
    try:
        asyncio.run(_send(cmd))
        print(f"sent: {cmd}")
        return 0
    except Exception as exc:
        print(f"could not reach the avatar bus at {URI} (is the overlay / bus.py running?): {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
