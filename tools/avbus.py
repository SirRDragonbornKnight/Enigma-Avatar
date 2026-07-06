"""avbus.py — tiny avatar-bus client for driving / inspecting the live overlay from the shell.

Sends a batch of commands (a JSON array on argv[1]) to ws://127.0.0.1:8765; for any command
carrying a "reqId" it collects the overlay's {type:"reply",reqId,result} and prints it. This is
how we drive actions the MCP avatar_command schema doesn't expose (regionWeight, query regions/
morphs, rotateMode, morph, setMesh, rename...).

  python tools/avbus.py "[{\"action\":\"query\",\"what\":\"regions\",\"reqId\":1}]"
"""

import asyncio
import json
import os
import sys
import websockets


async def main():
    if len(sys.argv) < 2:
        print(
            'usage: python tools/avbus.py \'[{"action":"query","what":"regions","reqId":1}]\'  (or a path to a .json file)'
        )
        return
    arg = sys.argv[1]
    if os.path.isfile(arg):  # a .json file of commands (avoids shell quoting hell)
        with open(arg, encoding="utf-8-sig") as f:  # utf-8-sig tolerates the BOM PowerShell writes
            cmds = json.load(f)
    else:
        cmds = json.loads(arg)
    if isinstance(cmds, dict):
        cmds = [cmds]
    for c in cmds:  # a sleep step is consumed locally, never sent — a reqId on one can NEVER be answered
        if isinstance(c, dict) and "sleep" in c and "action" not in c and "reqId" in c:
            print(f"ERROR: a sleep step cannot carry a reqId ({json.dumps(c)}) -- it is not sent to the overlay")
            return
    want = {c["reqId"] for c in cmds if isinstance(c, dict) and "reqId" in c}
    results = {}
    try:
        ws = await asyncio.wait_for(websockets.connect("ws://127.0.0.1:8765"), timeout=5)
    except Exception as e:
        print("CONNECT FAILED:", repr(e))
        return
    async with ws:
        # The reader's silence budget is a SHARED DEADLINE the send loop extends past every
        # send/sleep -- a fixed per-recv timeout starved on stacked sleeps (>30s of quiet wire
        # killed the reader SILENTLY and every later reqId printed NO REPLY though answered).
        loop = asyncio.get_running_loop()
        deadline = [loop.time() + 35.0]  # 35s past the LAST step: `load` replies when the model is BUILT (big models >6s)

        async def reader():
            try:
                while want:
                    left = deadline[0] - loop.time()
                    if left <= 0:
                        print(f"READER TIMEOUT: no reply for reqIds {sorted(want, key=str)}")
                        return
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=min(30.0, max(0.1, left)))
                    except asyncio.TimeoutError:
                        continue  # re-check the deadline (a sleep step may have extended it)
                    msg = json.loads(raw)
                    if msg.get("type") == "reply" and msg.get("reqId") in want:
                        results[msg["reqId"]] = msg.get("result")
                        want.discard(msg["reqId"])
            except Exception as e:
                print(f"READER DIED: {type(e).__name__}: {e}")  # loud, never a silent pass

        rt = asyncio.create_task(reader())
        for c in cmds:
            if isinstance(c, dict) and "sleep" in c and "action" not in c:
                # {"sleep": ms} pseudo-command: deterministic settle inside ONE batch (glides,
                # mouth smoother, reloads) instead of a PowerShell round-trip per pause.
                await asyncio.sleep(min(30.0, max(0.0, float(c["sleep"]) / 1000)))
                deadline[0] = loop.time() + 35.0
                continue
            await ws.send(json.dumps(c))
            deadline[0] = loop.time() + 35.0
            await asyncio.sleep(0.4)
        if want:
            await rt
    for c in cmds:
        if isinstance(c, dict) and "reqId" in c:
            tag = f"{c.get('action', '')}/{c.get('what', '')}".strip("/")
            print(f"--- reqId {c['reqId']} ({tag}):")
            body = json.dumps(results.get(c["reqId"], "NO REPLY"))
            if len(body) <= 2400:
                print(body)
            else:
                # NEVER truncate silently -- a silently cut mass-sorted bones reply loses every small
                # face bone below the cut and produces a false "no lip bones" conclusion.
                import tempfile

                fd, path = tempfile.mkstemp(prefix=f"avbus_reply_{c['reqId']}_", suffix=".json")
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(body)
                print(body[:2400])
                print(f"...TRUNCATED at 2400 of {len(body)} chars -- full reply: {path}")


if __name__ == "__main__":
    asyncio.run(main())
