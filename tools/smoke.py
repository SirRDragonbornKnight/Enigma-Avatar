"""smoke.py -- launch the REAL overlay and prove the whole pipeline end to end.

This is the live-drive harness the 2026-07 audits ran by hand, as one command:

    npm run smoke        (or: python tools/smoke.py [--keep])

It starts the bus if none is listening, launches Electron detached (output to
%TEMP%/enigma_smoke.*.log -- never a blocking pipe, the documented footgun),
then proves over the bus, with NUMERIC receipts rather than pixel-matching:

  1. BOOT      the overlay connects and answers `query model`
  2. LIMITS    capabilities reports the full bone_limits table (the system
               that was silently inert for weeks on the file:// page)
  3. STRICT    a garbage action gets a NAMED error reply, never silence
  4. MOTION    a flex layer bends the left elbow >30 deg through the live
               compositor + speed clamp, and clearing it releases the arm
  5. SNAP      a capture lands on disk with plausible size/dimensions

--keep leaves the overlay running afterwards; default kills what it started
(and ONLY what it started -- a bus that was already serving stays untouched).
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


async def run_checks(results: list) -> None:
    def check(name: str, ok: bool, detail: str) -> None:
        results.append((name, ok, detail))
        print(("PASS  " if ok else "FAIL  ") + name + " -- " + detail, flush=True)

    model = await wait_boot()
    check("BOOT", True, f"model {model['url']}")

    async with websockets.connect(URI, open_timeout=5) as ws:
        caps = await rpc(ws, {"action": "capabilities", "reqId": _rid()})
        lim = (caps or {}).get("limits") or {}
        head = lim.get("head") or {}
        check(
            "LIMITS",
            len(lim) >= 19 and isinstance(head.get("speed_limit"), (int, float)),
            f"{len(lim)} roles, head speed_limit={head.get('speed_limit')}",
        )

        bad = await rpc(ws, {"action": "smoke_bogus_verb", "reqId": _rid()})
        check(
            "STRICT",
            isinstance(bad, dict) and "unknown action" in str(bad.get("error", "")),
            f"reply: {bad}",
        )

        base = await elbow(ws)
        await rpc(ws, {"action": "pose", "flex": {"left_forearm": [1.5]}, "dur": 10, "id": "smoke"})
        await asyncio.sleep(2.5)  # the speed clamp EASES motion -- give it time to arrive
        bent = await elbow(ws)
        check("MOTION bend", base - bent > 30, f"leftElbow {base:.1f} -> {bent:.1f} deg")
        await rpc(ws, {"action": "pose", "clear": True})
        await asyncio.sleep(2.5)
        released = await elbow(ws)
        check("MOTION release", abs(released - base) < 25, f"leftElbow back to {released:.1f} (base {base:.1f})")

        snap = await rpc(ws, {"action": "snap", "name": "smoke.png", "reqId": _rid()}, timeout=15)
        p = Path(snap.get("path", "")) if isinstance(snap, dict) else Path()
        size = p.stat().st_size if p.is_file() else 0
        check(
            "SNAP",
            bool(snap and snap.get("ok")) and size > 10_000 and snap.get("width", 0) > 50,
            f"{p} ({size} bytes, {snap.get('width')}x{snap.get('height')})" if snap else "no reply",
        )


def kill_tree(pid: int) -> None:
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="end-to-end smoke of the live overlay")
    ap.add_argument("--keep", action="store_true", help="leave the overlay (and any bus we started) running")
    args = ap.parse_args()

    if not ELECTRON.is_file():
        print("FAIL  SETUP -- electron not installed (run npm install)")
        return 1

    started_bus = None
    if not port_listening():
        started_bus = subprocess.Popen(
            [sys.executable, str(REPO / "python" / "bus.py")],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        print("INFO  started a bus (none was listening)")
        time.sleep(1.2)

    out = open(TMP / "enigma_smoke.out.log", "w", encoding="utf-8")
    err = open(TMP / "enigma_smoke.err.log", "w", encoding="utf-8")
    overlay = subprocess.Popen([str(ELECTRON), "."], cwd=str(REPO), stdout=out, stderr=err)
    print(f"INFO  overlay launched (pid {overlay.pid}); logs in {TMP}\\enigma_smoke.*.log")

    results: list = []
    try:
        asyncio.run(run_checks(results))
    except Exception as e:
        results.append(("HARNESS", False, f"{type(e).__name__}: {e}"))
        print(f"FAIL  HARNESS -- {type(e).__name__}: {e}")
    finally:
        if not args.keep:
            kill_tree(overlay.pid)
            if started_bus:
                kill_tree(started_bus.pid)
            print("INFO  cleaned up (use --keep to leave her running)")
        out.close()
        err.close()

    failed = [r for r in results if not r[1]]
    print(f"\nSMOKE: {len(results) - len(failed)}/{len(results)} passed" + ("" if not failed else "  <-- FAILURES ABOVE"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
