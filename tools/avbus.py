"""avbus.py — tiny avatar-bus client for driving / inspecting the live overlay from the shell.

Sends a batch of commands (a JSON array on argv[1]) to ws://127.0.0.1:8765; for any command
carrying a "reqId" it collects the overlay's {type:"reply",reqId,result} and prints it. This is
how we drive actions the MCP avatar_command schema doesn't expose (regionWeight, query regions/
morphs, rotateMode, morph, setMesh, rename...).

  python tools/avbus.py "[{\"action\":\"query\",\"what\":\"regions\",\"reqId\":1}]"
"""
import asyncio, json, os, sys
import websockets

async def main():
    arg = sys.argv[1]
    if os.path.isfile(arg):                      # a .json file of commands (avoids shell quoting hell)
        with open(arg, encoding="utf-8-sig") as f:   # utf-8-sig tolerates the BOM PowerShell writes
            cmds = json.load(f)
    else:
        cmds = json.loads(arg)
    if isinstance(cmds, dict):
        cmds = [cmds]
    want = {c["reqId"] for c in cmds if isinstance(c, dict) and "reqId" in c}
    results = {}
    try:
        ws = await asyncio.wait_for(websockets.connect("ws://127.0.0.1:8765"), timeout=5)
    except Exception as e:
        print("CONNECT FAILED:", repr(e)); return
    async with ws:
        async def reader():
            try:
                while want:
                    raw = await asyncio.wait_for(ws.recv(), timeout=6)
                    msg = json.loads(raw)
                    if msg.get("type") == "reply" and msg.get("reqId") in want:
                        results[msg["reqId"]] = msg.get("result"); want.discard(msg["reqId"])
            except Exception:
                pass
        rt = asyncio.create_task(reader())
        for c in cmds:
            await ws.send(json.dumps(c)); await asyncio.sleep(0.4)
        if want:
            await rt
    for c in cmds:
        if isinstance(c, dict) and "reqId" in c:
            tag = f'{c.get("action","")}/{c.get("what","")}'.strip("/")
            print(f"--- reqId {c['reqId']} ({tag}):")
            print(json.dumps(results.get(c["reqId"], "NO REPLY"))[:2400])

asyncio.run(main())
