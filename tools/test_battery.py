"""test_battery.py — the full-system live battery. Drives the RUNNING overlay over the bus:
  1) loads EVERY model in models/ and records: load ok, roles, stance, facial channels,
     skin-weight stats, spring count + a snapshot per model (%TEMP%/battery_<id>.png)
  2) runs the behavior battery on a chosen model (motion layers + per-finger curl + perform,
     outfit round-trip, bone naming/highlight, recolor, mesh toggle, impulse, physics ball,
     movement walls, monitor hop, stillness hash)
Usage:  python tools/test_battery.py [models|behavior|all]   (default all)
Report: prints a table + writes %TEMP%/avatar_battery_report.json
"""

import asyncio, hashlib, json, sys, tempfile, time
from pathlib import Path
import websockets

AV = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.gettempdir())
MESH_EXT = {".glb", ".gltf", ".vrm", ".fbx"}


def discover_models():
    out = []
    mdir = AV / "models"
    for d in sorted(p for p in mdir.iterdir() if p.is_dir() and not p.name.startswith("_")):
        mesh = next((f for f in sorted(d.iterdir()) if f.suffix.lower() in MESH_EXT), None)
        if mesh:
            out.append({"id": d.name, "url": f"./models/{d.name}/{mesh.name}"})
    return out


class Bus:
    def __init__(self):
        self.ws = None
        self.rid = 100

    async def connect(self):
        self.ws = await asyncio.wait_for(websockets.connect("ws://127.0.0.1:8765"), timeout=5)

    async def cmd(self, c):  # fire-and-forget
        await self.ws.send(json.dumps(c))

    async def ask(self, c, timeout=8):  # round-trip on reqId
        self.rid += 1
        c = {**c, "reqId": self.rid}
        await self.ws.send(json.dumps(c))
        end = time.time() + timeout
        while time.time() < end:
            try:
                raw = await asyncio.wait_for(self.ws.recv(), timeout=max(0.1, end - time.time()))
            except asyncio.TimeoutError:
                break
            try:
                m = json.loads(raw)
            except Exception:
                continue
            if m.get("type") == "reply" and m.get("reqId") == self.rid:
                return m.get("result")
        return None

    async def query(self, what, timeout=8):
        return await self.ask({"action": "query", "what": what}, timeout)

    async def snap(self, name):
        await self.cmd({"action": "snap", "name": name})
        await asyncio.sleep(1.2)
        p = TMP / name
        return str(p) if p.exists() else None


async def wait_model(bus, url, timeout=45):
    end = time.time() + timeout
    while time.time() < end:
        m = await bus.query("model", 5)
        if m and m.get("url") == url:
            return True
        await asyncio.sleep(1.5)
    return False


async def model_sweep(bus):
    rows = []
    for m in discover_models():
        await bus.cmd({"action": "load", "url": m["url"]})
        ok = await wait_model(bus, m["url"])
        row = {"id": m["id"], "load": ok}
        if ok:
            await asyncio.sleep(2.5)  # let springs/facial settle
            st = await bus.query("state") or {}
            stance = await bus.query("stance") or {}
            facial = await bus.query("facial") or {}
            w = await bus.query("weights") or {}
            row.update(
                {
                    "roles": len(st.get("procBones") or []),
                    "springs": len(st.get("springBones") or []),
                    "deforming": w.get("deforming"),
                    "unsprungTwins": w.get("unsprungTwinBones"),
                    "mouth": facial.get("mode"),
                    "face": (facial.get("info") or "")[:90],
                    "knee": (stance.get("sides") or {}).get("left", {}).get("knee"),
                    "normalized": "bindKnee" in ((stance.get("sides") or {}).get("left") or {}),
                }
            )
            row["snap"] = await bus.snap(f"battery_{m['id']}.png")
        rows.append(row)
        print(
            ("OK   " if ok else "FAIL ")
            + m["id"]
            + (
                f"  roles={row.get('roles')} springs={row.get('springs')} deform={row.get('deforming')} mouth={row.get('mouth')} knee={row.get('knee')}"
                if ok
                else ""
            )
        )
    return rows


async def behavior(bus, url):
    r = {}
    await bus.cmd({"action": "load", "url": url})
    await wait_model(bus, url)
    await asyncio.sleep(2)
    # stillness: two snaps 6s apart must hash identical (cursor untouched)
    a = await bus.snap("bat_still_a.png")
    await asyncio.sleep(6)
    b = await bus.snap("bat_still_b.png")
    h = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest() if p else "?"
    r["stillness"] = "IDENTICAL" if a and b and h(a) == h(b) else f"DIFFER {h(a)[:8]} vs {h(b)[:8]}"
    # motion compositor end-to-end: pose/flex layers + per-finger curl (no gesture/emote catalog now)
    await bus.cmd({"action": "pose", "flex": {"right_arm": [1.1], "right_forearm": [0.6]}, "dur": 2.0, "id": "bat"})
    await asyncio.sleep(1.2)
    await bus.cmd({"action": "fingers", "side": "R", "curl": 1.0})
    await asyncio.sleep(0.8)
    await bus.cmd({"action": "fingers", "side": "R", "spec": {"default": 1, "index": 0}})
    await asyncio.sleep(0.8)
    await bus.cmd({"action": "fingers", "side": "R", "curl": None})
    await asyncio.sleep(0.6)
    j = await bus.query("joints") or {}
    r["motion"] = f"end: knee={j.get('leftKnee')} elbow={j.get('leftElbow')}"
    # perform: inline-tagged speech -> motion + the clean line back
    r["perform"] = await bus.ask({"action": "perform", "text": "Watch this! [pose:right_arm=1.0]"}) or "fired"
    # look + highlight + naming
    await bus.cmd({"action": "lookAt", "px": 100, "py": 100})
    await asyncio.sleep(0.6)
    bones = await bus.query("bones") or []
    bn = bones[2]["name"] if len(bones) > 2 else None
    r["highlight"] = (await bus.ask({"action": "highlightBone", "bone": bn, "dur": 1})) if bn else "n/a"
    r["nameBone"] = (await bus.ask({"action": "nameBone", "bone": bn, "label": "battery-test"})) if bn else "n/a"
    if bn:
        await bus.ask({"action": "nameBone", "bone": bn, "label": ""})  # clean up the label
    # outfit round-trip
    await bus.ask({"action": "outfit", "name": "_battery", "save": True})
    r["outfitWear"] = await bus.ask({"action": "outfit", "name": "_battery"})
    await bus.ask({"action": "outfit", "name": "_battery", "delete": True})
    r["outfits"] = (await bus.query("outfits") or {}).get("outfits")
    # recolor + reset, mesh toggle round-trip
    r["recolor"] = await bus.ask({"action": "recolor", "index": 0, "color": "#ff0000"})
    await bus.ask({"action": "resetColors"})
    meshes = await bus.query("meshes") or []
    if meshes:
        i = meshes[0]["index"]
        await bus.ask({"action": "setMesh", "index": i, "on": False})
        m2 = await bus.query("meshes")
        r["meshToggle"] = m2 and not m2[0]["visible"]
        await bus.ask({"action": "setMesh", "index": i, "on": True})
    # impulse (tail/hair kick through the springs)
    r["impulse"] = await bus.ask({"action": "impulse", "region": "tail", "x": 1.2, "dur": 0.5})
    if r["impulse"] is False or r["impulse"] is None:
        r["impulse"] = await bus.ask({"action": "impulse", "region": "hair", "x": 0.8, "dur": 0.4})
    # physics ball (the `ball` action: throwball / dropball / clearballs)
    await bus.cmd({"action": "ball", "name": "throwball"})
    await asyncio.sleep(4)
    r["ball"] = await bus.snap("bat_ball.png")
    await bus.cmd({"action": "ball", "name": "clearballs"})
    await asyncio.sleep(0.5)
    # movement walls: bottom + side, then recenter
    st = await bus.query("state") or {}
    sw, sh = st.get("screen") or [2560, 1440]
    await bus.cmd({"action": "moveTo", "px": sw / 2, "py": sh + 500})
    await asyncio.sleep(2)
    w1 = await bus.query("where") or {}
    await bus.cmd({"action": "moveTo", "px": -500, "py": sh * 0.6})
    await asyncio.sleep(2)
    w2 = await bus.query("where") or {}
    r["walls"] = f"bottom y={w1.get('screenPos', ['?', '?'])[1]}/{sh}  left x={w2.get('screenPos', ['?', '?'])[0]}"
    # monitor hop + peer render + back
    await bus.cmd({"action": "monitor", "value": "next"})
    await asyncio.sleep(2.5)
    r["peerSnap"] = await bus.snap("bat_peer.png")
    await bus.cmd({"action": "monitor", "value": "prev"})
    await asyncio.sleep(1.5)
    await bus.cmd({"action": "goTo", "to": "center"})
    return r


async def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    bus = Bus()
    await bus.connect()
    report = {}
    if mode in ("models", "all"):
        report["models"] = await model_sweep(bus)
    if mode in ("behavior", "all"):
        report["behavior"] = await behavior(bus, "./models/anime_catgirl/anime_catgirl.glb")
        print(json.dumps(report["behavior"], indent=1)[:1800])
    out = TMP / "avatar_battery_report.json"
    out.write_text(json.dumps(report, indent=1), encoding="utf-8")
    print("report:", out)


asyncio.run(main())
