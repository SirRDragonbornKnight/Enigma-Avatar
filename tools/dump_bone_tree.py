"""dump_leg_tree.py — print the leg-related node graph of a GLB: name, parent, children,
whether it's a skin joint (deforms the mesh), and its local rotation (squat-era binds show up
as big quats). Pure stdlib; JSON chunk only. Usage: python dump_leg_tree.py <model.glb> [regex]
"""

import json
import re
import struct
import sys

if len(sys.argv) < 2:
    print("usage: python dump_bone_tree.py <model.glb> [regex]", file=sys.stderr)
    raise SystemExit(2)
path = sys.argv[1]
pat = re.compile(sys.argv[2] if len(sys.argv) > 2 else r"thigh|shin|leg|foot|toe|knee", re.I)

with open(path, "rb") as f:
    magic, ver, total = struct.unpack("<III", f.read(12))
    assert magic == 0x46546C67, "not a GLB"
    clen, ctype = struct.unpack("<II", f.read(8))
    gltf = json.loads(f.read(clen).decode("utf-8"))

nodes = gltf.get("nodes", [])
parent = {}
for i, n in enumerate(nodes):
    for c in n.get("children", []):
        parent[c] = i

joints = set()
for s in gltf.get("skins", []):
    joints.update(s.get("joints", []))


def nm(i):
    return nodes[i].get("name", f"#{i}") if i is not None and 0 <= i < len(nodes) else "(root)"


rows = []
for i, n in enumerate(nodes):
    name = n.get("name", f"#{i}")
    if not pat.search(name):
        continue
    rot = n.get("rotation")
    rot_s = "id" if not rot else "/".join(f"{v:+.2f}" for v in rot)
    kids = [nm(c) for c in n.get("children", [])]
    rows.append((name, nm(parent.get(i)), "SKIN" if i in joints else "    ", rot_s, kids))

rows.sort(key=lambda r: r[0].lower())
for name, par, sk, rot, kids in rows:
    print(f"{sk} {name:<28} parent={par:<28} rot={rot}")
    for k in kids:
        print(f"       -> {k}")
print(f"\n{len(rows)} nodes matched; {len(joints)} skin joints total in file")
