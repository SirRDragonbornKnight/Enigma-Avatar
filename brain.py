"""brain.py - the avatar's autonomous DRIVER loop (the "mind" that moves the body).

The body (the mods/avatar overlay) is deliberately dumb: it composites the motion layers it
is told to apply over the local bus. brain.py is the loop that decides WHAT to do and proves
it landed:

  1. ask the body what it can do  -> {"action":"capabilities"}  (roles, flex-able limbs, fingers, channels)
  2. author a GROUNDED action     -> only poses/tags the loaded model actually supports (fail honest)
  3. send it over the bus         -> perform / pose / look / fingers
  4. verify by-numbers            -> {"action":"query","what":"joints"|"where"} and read the truth back
  5. loop

This speaks the exact same JSON action protocol as say.py / avbus.py / Odysseus - brain.py just
CLOSES the loop (decide -> act -> SEE the result) instead of firing one command and walking away.

The "author" is pluggable. The default is a deterministic, capability-grounded author, so the
loop runs and verifies TODAY (the from-scratch Enigma model is still mid-train). Point --llm at an
OpenAI-compatible endpoint to let a model write the perform-tagged lines instead; its tags are
validated against the LIVE capabilities before they reach the body, so it can never drive a limb
the model does not have.

  python mods/avatar/brain.py                                  # deterministic loop (overlay + bus must be up)
  python mods/avatar/brain.py --beats 6 --interval 2.5
  python mods/avatar/brain.py --llm http://127.0.0.1:11434/v1 --model qwen3.6:unsloth

Output is ASCII only (the Windows cp1252 console cannot print unicode).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import urllib.request

import websockets

URI = "ws://127.0.0.1:8765"

# Tags the body understands inside a `perform` line. The body parses these (control.js); brain.py
# only needs to know the SHAPE so it can ground/validate them against live capabilities.
_POSE_TAG = re.compile(r"\[pose:([a-z0-9_]+)=([^\]]+)\]", re.I)


# --------------------------------------------------------------------------- bus client (request/reply)


class Bus:
    """A request/reply client for the avatar bus. Same wire protocol as avbus.py: a command may
    carry a reqId, and the overlay answers {"type":"reply","reqId":..,"result":..}."""

    def __init__(self, uri: str = URI):
        self.uri = uri
        self.ws = None
        self._n = (
            os.getpid() % 9000 + 1000
        ) * 100000  # per-process reqId base: don't collide with another producer (avbus) sharing the hub

    async def __aenter__(self):
        try:
            self.ws = await asyncio.wait_for(websockets.connect(self.uri), timeout=5)
        except Exception as exc:  # honest: name why we could not reach the body
            raise SystemExit(
                f"brain: could not reach the avatar bus at {self.uri} (is the overlay + bus.py running?): {exc!r}"
            ) from exc
        return self

    async def __aexit__(self, *exc):
        if self.ws is not None:
            await self.ws.close()

    async def send(self, cmd: dict) -> None:
        """Fire-and-forget (the body applies it; no reply expected)."""
        await self.ws.send(json.dumps(cmd))

    async def request(self, cmd: dict, timeout: float = 6.0):
        """Send a command with a reqId and return the overlay's reply.result (None on timeout)."""
        self._n += 1
        rid = self._n
        cmd = {**cmd, "reqId": rid}
        await self.ws.send(json.dumps(cmd))
        try:
            while True:
                raw = await asyncio.wait_for(self.ws.recv(), timeout=timeout)
                msg = json.loads(raw)
                if msg.get("type") == "reply" and msg.get("reqId") == rid:
                    return msg.get("result")
        except Exception:
            return None


# --------------------------------------------------------------------------- helpers


def _ascii(s) -> str:
    """The Windows cp1252 console cannot print unicode; an LLM-authored line may contain it."""
    return str(s).encode("ascii", "replace").decode("ascii")


def _numbers(obj) -> list[float]:
    """Flatten every number in a JSON-ish value (for shape-agnostic 'did it move' diffs)."""
    out: list[float] = []
    if isinstance(obj, bool):
        return out
    if isinstance(obj, (int, float)):
        return [float(obj)]
    if isinstance(obj, dict):
        for v in obj.values():
            out += _numbers(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            out += _numbers(v)
    return out


def _motion_delta(before, after) -> float:
    """Total absolute change across paired numeric fields of two query snapshots. >0 == the body moved."""
    a, b = _numbers(before), _numbers(after)
    n = min(len(a), len(b))
    return sum(abs(a[i] - b[i]) for i in range(n))


def sanitize_perform(text: str, caps: dict) -> tuple[str, list[str]]:
    """Strip [pose:ROLE=..] tags whose ROLE is not in the live capabilities. Returns (clean_text,
    dropped_roles). [look:..] and plain text are kept (the look channel is always present)."""
    roles = set(caps.get("roles") or []) | set(caps.get("flexRoles") or [])
    dropped: list[str] = []

    def keep(m: re.Match) -> str:
        role = m.group(1).lower()
        if role in roles:
            return m.group(0)
        dropped.append(role)
        return ""  # drop the tag, keep the speech

    return _POSE_TAG.sub(keep, text).replace("  ", " ").strip(), dropped


# --------------------------------------------------------------------------- the deterministic author


def ground_author(caps: dict, beat: int) -> dict:
    """Pick the next behavior using ONLY what `caps` advertises. Returns a behavior dict:
        { name, speech, commands:[bus dicts], verify:("joints"|"where"|"reply"), expect:str }
    Never authors a tag/pose for a role the loaded model lacks - that is the whole point."""
    flex = set(caps.get("flexRoles") or [])
    roles = set(caps.get("roles") or [])
    fingers_r = ((caps.get("channels") or {}).get("fingers") or {}).get("R") or []

    repertoire: list[dict] = []

    # 1) Greet + gaze. The look channel is always present, so this works on every model.
    repertoire.append(
        {
            "name": "greet",
            "speech": "Hi! Let me show you what I can do.",
            "commands": [{"action": "perform", "text": "Hi! [look:up-right]"}],
            "verify": "reply",
            "expect": "applied a look tag",
        }
    )

    # 2) Wave - ONLY if the right arm can flex (otherwise we honestly do not claim it).
    if "right_arm" in flex:
        flexspec = {"right_arm": [1.1]}
        if "right_forearm" in flex:
            flexspec["right_forearm"] = [0.5]
        cmds = [{"action": "pose", "flex": flexspec, "dur": 3.0, "id": "brain_wave"}]
        if fingers_r:
            cmds.append({"action": "fingers", "side": "R", "curl": 0.0})  # open the hand for the wave
        repertoire.append(
            {
                "name": "wave",
                "speech": "Look, I can wave with this arm.",
                "commands": cmds,
                "verify": "joints",
                "expect": "the right elbow angle changes",
            }
        )

    # 3) Nod - only if there is a head role to drive.
    if "head" in roles:
        repertoire.append(
            {
                "name": "nod",
                "speech": "Yes, mhm.",
                "commands": [{"action": "perform", "text": "Mhm. [pose:head=0.18/0/0]"}],
                "verify": "reply",
                "expect": "applied a head pose tag",
            }
        )

    # 4) Look around - a small gaze sweep, always available.
    sweep = ["left", "right", "up", "center"][beat % 4]
    repertoire.append(
        {
            "name": "look",
            "speech": f"Looking {sweep}.",
            "commands": [{"action": "perform", "text": f"[look:{sweep}]"}],
            "verify": "reply",
            "expect": f"applied look:{sweep}",
        }
    )

    # 5) Relax - release the wave so the loop returns to rest (only meaningful if we can wave).
    if "right_arm" in flex:
        relax = [{"action": "pose", "flex": {"right_arm": [0.0]}, "dur": 1.5, "id": "brain_wave"}]
        if fingers_r:
            relax.append({"action": "fingers", "side": "R", "curl": None})  # release to the reactive grip
        repertoire.append(
            {
                "name": "relax",
                "speech": "And relax.",
                "commands": relax,
                "verify": "joints",
                "expect": "the elbow returns toward rest",
            }
        )

    return repertoire[beat % len(repertoire)]


# --------------------------------------------------------------------------- the LLM author (optional)


def llm_author(endpoint: str, model: str, caps: dict, beat: int) -> dict:
    """Ask an OpenAI-compatible endpoint to write ONE short perform-tagged line, then sanitize its
    tags against live capabilities before it can reach the body."""
    flex = sorted(set(caps.get("flexRoles") or []))
    roles = sorted(set(caps.get("roles") or []))
    sys_prompt = (
        "You drive an on-screen avatar by writing ONE short, friendly spoken line with inline motion "
        "tags. Tags: [look:left|right|up|down|center|up-left|...] and [pose:ROLE=pitch/yaw/roll] in "
        "radians. You may ONLY use these ROLE names: "
        + ", ".join(roles)
        + ". Flex-able limbs: "
        + ", ".join(flex)
        + ". Keep it under 16 words. Reply with the line only, no quotes."
    )
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": f"Beat {beat + 1}: do one natural little gesture."},
            ],
            "temperature": 0.8,
            "stream": False,
        }
    ).encode()
    req = urllib.request.Request(
        endpoint.rstrip("/") + "/chat/completions", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        raw = data["choices"][0]["message"]["content"]
        raw = re.sub(
            r"<think>.*?</think>", "", raw, flags=re.S | re.I
        )  # drop reasoning blocks (qwen3.x etc. emit them)
        text = next((ln.strip() for ln in raw.splitlines() if ln.strip()), "")  # first non-empty line
    except Exception as exc:
        # Fail honest: no fabricated motion. Fall back to the grounded author for this beat.
        print(f"  [llm] endpoint failed ({exc!r}); using the grounded author this beat", flush=True)
        return ground_author(caps, beat)
    clean, dropped = sanitize_perform(text, caps)
    if dropped:
        print(f"  [llm] dropped tags for roles the model lacks: {', '.join(dropped)}", flush=True)
    return {
        "name": "llm",
        "speech": clean,
        "commands": [{"action": "perform", "text": clean}],
        "verify": "reply",
        "expect": "applied the authored tags",
    }


# --------------------------------------------------------------------------- the loop


async def run(uri: str, beats: int, interval: float, author, settle: float = 0.6) -> int:
    async with Bus(uri) as bus:
        caps = await bus.request({"action": "capabilities"})
        if not caps or not caps.get("roles"):
            print("brain: the body reports NO drivable rig (no model loaded, or a static model).")
            print("       Load a model first:  python mods/avatar/say.py model <name>")
            return 2
        flex = caps.get("flexRoles") or []
        fr = ((caps.get("channels") or {}).get("fingers") or {}).get("R") or []
        print(
            f"brain: connected. body can drive {len(caps['roles'])} roles, "
            f"{len(flex)} flex-able limbs, {len(fr)} right-hand fingers."
        )
        print(f"       flex limbs: {', '.join(flex) if flex else '(none)'}")

        moved = 0
        for beat in range(beats):
            b = author(caps, beat)
            print(f'\n[beat {beat + 1}/{beats}] {b["name"]}: "{_ascii(b["speech"])}"')

            before = (
                await bus.request({"action": "query", "what": b["verify"]})
                if b["verify"] in ("joints", "where")
                else None
            )
            reply = None
            for cmd in b["commands"]:
                reply = await bus.request(cmd)  # reqId -> the body returns what it actually did
            await asyncio.sleep(settle)

            if b["verify"] in ("joints", "where"):
                after = await bus.request({"action": "query", "what": b["verify"]})
                if before is None or after is None:
                    print(f"  verify[{b['verify']}]: NO REPLY from the body -> UNVERIFIED")
                else:
                    delta = _motion_delta(before, after)
                    ok = delta > 1e-4
                    moved += ok
                    print(
                        f"  verify[{b['verify']}]: motion delta {delta:.4f} -> "
                        f"{'MOVED (' + b['expect'] + ')' if ok else 'no measurable change in tracked joints'}"
                    )
            elif reply is None:
                print("  verify[reply]: NO REPLY from the body -> UNVERIFIED")
            else:
                # perform returns { say:<clean line>, performed:[<applied tags>] } (avatar.js EnigmaAvatar.perform)
                performed = reply.get("performed") if isinstance(reply, dict) else None
                spoke = reply.get("say") if isinstance(reply, dict) else None
                applied = isinstance(performed, list) and any(
                    not str(x).startswith(("skip", "look-skip", "conjure-skip")) for x in performed
                )
                moved += applied
                detail = json.dumps(performed) if performed is not None else json.dumps(reply)
                print(
                    f"  verify[reply]: body performed {detail}"
                    + (f' (says: "{_ascii(spoke)}")' if spoke else "")
                    + f" -> {'APPLIED (' + b['expect'] + ')' if applied else 'no tag applied (honest no-op)'}"
                )

            if beat < beats - 1:
                await asyncio.sleep(max(0.0, interval - settle))

        print(f"\nbrain: loop done. {moved}/{beats} beats verified as real motion/effect on the live body.")
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Autonomous driver loop for the avatar overlay.")
    ap.add_argument("--uri", default=URI, help="avatar bus websocket (default %(default)s)")
    ap.add_argument("--beats", type=int, default=5, help="how many decide->act->verify beats to run")
    ap.add_argument("--interval", type=float, default=2.5, help="seconds between beats")
    ap.add_argument(
        "--llm", default=None, help="OpenAI-compatible endpoint to author lines (e.g. http://127.0.0.1:11434/v1)"
    )
    ap.add_argument("--model", default=None, help="model name for --llm")
    args = ap.parse_args()

    if args.llm:
        if not args.model:
            print("brain: --llm needs --model", file=sys.stderr)
            return 1

        def author(caps, beat):
            return llm_author(args.llm, args.model, caps, beat)
    else:
        author = ground_author

    try:
        return asyncio.run(run(args.uri, args.beats, args.interval, author))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
