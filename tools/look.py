"""look.py - let the AI SEE the avatar's current state, on demand.

Drives an optional command first, then captures a FRONT snap (eyes) AND prints a compact
numeric pose summary (numbers) - the spec's "verify by numbers first, eyes second". The snap
lands at %TEMP%\\<name> so the caller can read it back; --angles adds 3/4 + side views
(rotate -> snap -> restore the original rotation, no lasting change).

  python tools/look.py                                   # snap + summarize current state
  python tools/look.py --do '{"action":"pose","id":"t","dur":8,"parts":{"left_arm":[1,0,0]}}'
  python tools/look.py --name tune_03.png                # name the snap
  python tools/look.py --angles                          # front + 3/4 + side (restores facing)

Requires the overlay running (Start-Avatar.ps1). Throwaway/operational, not shipped behavior.
"""

from __future__ import annotations
import argparse
import asyncio
import json
import os
import sys
import tempfile
import websockets

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
from protocol import BUS_URI as URI  # the ONE endpoint truth (python/protocol.py)


async def _req(ws, cmd, rid, timeout=2.0):
    """Send a command tagged with reqId; return the matching {result} or None."""
    cmd = {**cmd, "reqId": rid}
    await ws.send(json.dumps(cmd))
    t = asyncio.get_event_loop().time()
    while asyncio.get_event_loop().time() - t < timeout:
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=0.4))
        except asyncio.TimeoutError:
            continue
        except Exception:
            break
        if msg.get("reqId") == rid:
            return msg.get("result")
    return None


async def _snap(ws, name, rid):
    """Snap via the reqId reply: the overlay answers {ok, path} only when the PNG is WRITTEN.
    Returns (path, verified) - verified=False means no reply came back, so an existing file at
    the guessed path may be a stale leftover from an earlier run (never label it [OK])."""
    res = await _req(ws, {"action": "snap", "name": name}, rid, timeout=6.0)
    if isinstance(res, dict) and res.get("path"):
        return res["path"], True
    return os.path.join(tempfile.gettempdir(), os.path.basename(name)), False


def _asc(s):
    """The Windows cp1252 console can't print non-ASCII (the avatar's facial.info carries a '.')."""
    return str(s).encode("ascii", "replace").decode("ascii")


def _summary(state):
    if not state:
        return "  (no state reply - is the overlay up?)"
    L = state.get("layers")
    lay = ", ".join(L) if isinstance(L, list) else "n/a (reload the overlay for live layers)"
    return _asc(
        f"  dims (w x h): {state.get('dims')}   pos: {state.get('pos')}   size: {state.get('size')}\n"
        f"  active layers: [{lay}]\n"
        f"  facial: {(state.get('facial') or {}).get('info')}\n"
        f"  toggles: {state.get('toggles')}"
    )


async def go(args):
    paths = []
    async with websockets.connect(URI, open_timeout=4) as ws:
        if args.do:
            await ws.send(
                args.do if args.do.strip().startswith("{") else json.dumps({"action": "perform", "text": args.do})
            )
            await asyncio.sleep(0.8)  # let env-in / the move settle before we look
        state = await _req(ws, {"action": "query", "what": "state"}, "state")
        stance = await _req(ws, {"action": "query", "what": "stance"}, "stance", timeout=1.5)
        base, _, ext = args.name.rpartition(".")
        base = base or args.name
        ext = ext or "png"
        paths.append(await _snap(ws, f"{base}.{ext}", "snap0"))
        if args.angles:
            r0 = await _req(ws, {"action": "query", "what": "rotation"}, "r0", timeout=1.5)
            saved = (r0 or {}).get("saved") if isinstance(r0, dict) else None
            base_rot = saved if isinstance(saved, dict) else {"x": 0, "y": 0, "z": 0}
            gx, gy, gz = base_rot.get("x", 0), base_rot.get("y", 0), base_rot.get("z", 0)
            for label, yaw in (("34", 40), ("side", 90)):
                await ws.send(
                    json.dumps({"action": "rotate", "x": gx, "y": gy + yaw, "z": gz})
                )  # add yaw, keep her pitch/roll
                await asyncio.sleep(0.5)
                paths.append(await _snap(ws, f"{base}_{label}.{ext}", f"snap_{label}"))
            await ws.send(
                json.dumps({"action": "rotate", "x": gx, "y": gy, "z": gz})
            )  # restore her ORIGINAL facing (rotate persists, so do not assume front)
            await asyncio.sleep(0.3)
    print("SNAPS (read these):")
    for p, verified in paths:
        if not os.path.exists(p):
            print("  " + p + "  [MISSING]")
        elif verified:
            print("  " + p + "  [OK]")
        else:
            print("  " + p + "  [UNVERIFIED - no snap reply; the file may be a stale leftover]")
    print("POSE BY NUMBERS:")
    print(_summary(state))
    if stance:
        print("  stance:", _asc(json.dumps(stance)[:600]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--do", default=None, help="a JSON handleCommand action (e.g. a pose layer) to send before looking")
    ap.add_argument("--name", default="look.png", help="snap filename (lands in %TEMP%)")
    ap.add_argument("--angles", action="store_true", help="also capture 3/4 + side (restores facing)")
    args = ap.parse_args()
    try:
        asyncio.run(go(args))
        return 0
    except Exception as exc:
        print(f"could not reach the avatar bus at {URI} (overlay/bus running?): {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
