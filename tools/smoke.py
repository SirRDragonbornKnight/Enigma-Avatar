"""smoke.py -- drive the REAL overlay over the bus and demand numeric receipts.

This is the live-drive harness the 2026-07 audits ran by hand, as one command:

    npm run smoke        (or: python tools/smoke.py [--keep])

SCOPE (stated honestly, zero-trust audit 2026-07-02): this proves the chain
bus -> strict wire -> registry -> compositor -> live joint state -> capturePage.
It does NOT prove pixels reached the glass -- the repo's known present-bug class
("capturePage works but the screen is blank", the DComp detach) passes 6/6 here.
Judging the glass still needs eyes (or the tray reload + a look).

Checks (each a targeted FAIL with a diagnostic -- mutation-tested):
  1. BOOT            the overlay answers `query model` within 45s
  2. LIMITS          capabilities reports the full bone_limits table (the
                     system that was silently inert for weeks on file://)
  3. STRICT          a garbage action gets a NAMED error reply, never silence
  4. VISIBLE         the model measures a sane world height (normalization
                     didn't shrink her to a speck) AND her anchor sits on the
                     glass (2026-07-04: ryuri booted 0.42 units tall at
                     y=2016 -- invisible -- while every other receipt passed)
  5. MOTION bend     a flex layer bends the left elbow >30 deg through the
                     live compositor + speed clamp
  6. MOTION release  clearing the layer eases the arm back to its base
  7. SNAP            a capture written DURING THIS RUN lands on disk with
                     plausible size/dimensions (mtime-checked)

If an overlay is ALREADY RUNNING, the harness ATTACHES to it instead of
launching a second instance (a second instance would trigger the single-
instance lock and yank the live overlay to the primary display). Attached
runs still pose/clear her layers -- expect her arm to move. Nothing already
running is ever killed. One smoke at a time (fixed log names, one bus port).

Default kills only what it STARTED; --keep leaves that running too.
Exit code 0 = all pass. ASCII output only (cp1252 console).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import websockets

REPO = Path(__file__).resolve().parents[1]
URI = "ws://127.0.0.1:8765"
ELECTRON = REPO / "node_modules" / "electron" / "dist" / "electron.exe"
TMP = Path(os.environ.get("TEMP", "/tmp"))

_seq = 0


def _rid() -> str:
    global _seq
    _seq += 1
    return f"smoke:{_seq}"


def port_listening(port: int = 8765) -> bool:
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


async def rpc(ws, cmd: dict, timeout: float = 8.0):
    """Send one command; if it carries a reqId, wait for OUR reply (the hub
    routes replies back with our own id restored, so filtering is exact)."""
    await ws.send(json.dumps(cmd))
    if "reqId" not in cmd:
        return None
    deadline = time.monotonic() + timeout
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError(f"no reply to {cmd.get('action')}")
        m = json.loads(await asyncio.wait_for(ws.recv(), left))
        if m.get("type") == "reply" and m.get("reqId") == cmd["reqId"]:
            return m.get("result")


async def wait_boot(timeout: float = 45.0) -> dict:
    """Retry until the overlay answers a model query (bus up != overlay up)."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            async with websockets.connect(URI, open_timeout=3) as ws:
                r = await rpc(ws, {"action": "query", "what": "model", "reqId": _rid()}, timeout=4)
                if isinstance(r, dict) and r.get("url"):
                    return r
        except Exception as e:  # bus not up yet / overlay not connected yet
            last = e
        await asyncio.sleep(1.5)
    raise TimeoutError(f"overlay never answered (last: {last})")


async def elbow(ws) -> float:
    r = await rpc(ws, {"action": "query", "what": "joints", "reqId": _rid()})
    return float(r["leftElbow"])


async def run_checks(results: list, run_start: float) -> None:
    def check(name: str, ok: bool, detail: str) -> None:
        results.append((name, ok, detail))
        print(("PASS  " if ok else "FAIL  ") + name + " -- " + detail, flush=True)

    # Each phase is ISOLATED (zero-trust audit finding: one unexpected exception must record ITS
    # check as failed and keep going, never mask the remaining checks' reports).
    async def phase(name, coro):
        try:
            await coro()
        except Exception as e:
            check(name, False, f"{type(e).__name__}: {e}")

    async def p_boot():
        model = await wait_boot()
        check("BOOT", True, f"model {model['url']}")

    await phase("BOOT", p_boot)
    if not results or not results[0][1]:
        return  # nothing to talk to -- the remaining checks would just spam timeouts

    async with websockets.connect(URI, open_timeout=5) as ws:

        async def p_limits():
            caps = await rpc(ws, {"action": "capabilities", "reqId": _rid()})
            lim = ((caps if isinstance(caps, dict) else {}) or {}).get("limits") or {}
            head = lim.get("head") or {}
            check(
                "LIMITS",
                len(lim) >= 19 and isinstance(head.get("speed_limit"), (int, float)),
                f"{len(lim)} roles, head speed_limit={head.get('speed_limit')}",
            )

        async def p_strict():
            bad = await rpc(ws, {"action": "smoke_bogus_verb", "reqId": _rid()})
            check(
                "STRICT",
                isinstance(bad, dict) and "unknown action" in str(bad.get("error", "")),
                f"reply: {bad}",
            )

        async def p_visible():
            st = await rpc(ws, {"action": "query", "what": "state", "reqId": _rid()})
            st = st if isinstance(st, dict) else {}
            dims = st.get("dims") or [0, 0]
            sp = st.get("screenPos") or [-1, -1]
            scr = st.get("screen") or [0, 0]
            # the anchor is her feet on the DECK (work-area bottom, global coords) — legitimately a
            # few px below the window's own height; the bug class this catches is far-off-glass
            # (2016 on a 1392 window), not deck-standing (1432).
            on_glass = -50 <= sp[0] <= scr[0] + 50 and -50 <= sp[1] <= scr[1] + 100
            check(
                "VISIBLE",
                dims[1] > 1.0 and on_glass,
                f"dims {dims[0]:.2f}x{dims[1]:.2f} world, anchor {sp} on screen {scr}"
                + ("" if on_glass else " -- ANCHOR OFF-GLASS"),
            )

        async def p_motion():
            base = await elbow(ws)
            await rpc(ws, {"action": "pose", "flex": {"left_forearm": [1.5]}, "dur": 10, "id": "smoke"})
            await asyncio.sleep(2.5)  # the speed clamp EASES motion -- give it time to arrive
            bent = await elbow(ws)
            check("MOTION bend", base - bent > 30, f"leftElbow {base:.1f} -> {bent:.1f} deg")
            await rpc(ws, {"action": "pose", "clear": True})
            await asyncio.sleep(2.5)
            released = await elbow(ws)
            check("MOTION release", abs(released - base) < 25, f"leftElbow back to {released:.1f} (base {base:.1f})")

        async def p_snap():
            snap = await rpc(ws, {"action": "snap", "name": "smoke.png", "reqId": _rid()}, timeout=15)
            p = Path(snap.get("path", "")) if isinstance(snap, dict) else Path()
            st = p.stat() if p.is_file() else None
            fresh = bool(st) and st.st_mtime >= run_start - 2  # written DURING THIS RUN, not a stale leftover
            check(
                "SNAP",
                bool(snap and snap.get("ok")) and bool(st) and st.st_size > 10_000 and snap.get("width", 0) > 50 and fresh,
                (f"{p} ({st.st_size if st else 0} bytes, {snap.get('width')}x{snap.get('height')}"
                 + ("" if fresh else ", STALE FILE") + ")") if snap else "no reply",
            )

        await phase("LIMITS", p_limits)
        await phase("STRICT", p_strict)
        await phase("VISIBLE", p_visible)
        await phase("MOTION bend", p_motion)
        await phase("SNAP", p_snap)


def kill_tree(pid: int) -> None:
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)


async def overlay_already_up() -> bool:
    """One quick probe: is a live overlay ALREADY answering on the bus? If so we must ATTACH,
    never spawn a second instance (the single-instance lock would make the stub instance fire
    second-instance -> recoverToPrimary, yanking the user's overlay across displays)."""
    if not port_listening():
        return False
    try:
        async with websockets.connect(URI, open_timeout=2) as ws:
            r = await rpc(ws, {"action": "query", "what": "model", "reqId": _rid()}, timeout=2.5)
            return isinstance(r, dict)
    except Exception:
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="end-to-end smoke of the live overlay")
    ap.add_argument("--keep", action="store_true", help="leave the overlay (and any bus we started) running")
    args = ap.parse_args()

    if not ELECTRON.is_file():
        print("FAIL  SETUP -- electron not installed (run npm install)")
        return 1

    run_start = time.time()
    started_bus = None
    overlay = None
    out = err = None
    if asyncio.run(overlay_already_up()):
        print("INFO  attached to the ALREADY-RUNNING overlay (nothing spawned, nothing will be killed;")
        print("INFO  her pose layers WILL be driven and cleared by the MOTION check)")
    else:
        if not port_listening():
            started_bus = subprocess.Popen(
                [sys.executable, str(REPO / "python" / "bus.py")],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            print("INFO  started a bus (none was listening)")
            time.sleep(1.2)
        try:
            out = open(TMP / "enigma_smoke.out.log", "w", encoding="utf-8")
            err = open(TMP / "enigma_smoke.err.log", "w", encoding="utf-8")
            overlay = subprocess.Popen([str(ELECTRON), "."], cwd=str(REPO), stdout=out, stderr=err)
        except Exception as e:
            # a bus we started must not be orphaned by a failed launch (zero-trust audit finding)
            if started_bus:
                kill_tree(started_bus.pid)
            print(f"FAIL  SETUP -- could not launch the overlay: {e}")
            return 1
        print(f"INFO  overlay launched (pid {overlay.pid}); logs in {TMP}\\enigma_smoke.*.log")

    results: list = []
    try:
        asyncio.run(run_checks(results, run_start))
    except Exception as e:
        results.append(("HARNESS", False, f"{type(e).__name__}: {e}"))
        print(f"FAIL  HARNESS -- {type(e).__name__}: {e}")
    finally:
        if not args.keep and overlay:
            kill_tree(overlay.pid)
            if started_bus:
                kill_tree(started_bus.pid)
            print("INFO  cleaned up (use --keep to leave her running)")
        if out:
            out.close()
        if err:
            err.close()

    failed = [r for r in results if not r[1]]
    print(f"\nSMOKE: {len(results) - len(failed)}/{len(results)} passed" + ("" if not failed else "  <-- FAILURES ABOVE"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
