# analyze_rig.py — study a model's SKELETON properly: the bone hierarchy, each bone's world rest
# position, and the direction it points (parent→child). So motion layers pose the RIGHT bones on the
# RIGHT axes instead of guessing. Usage: python analyze_rig.py <model.glb>
import sys, json, struct, re
import numpy as np

def load_glb(p):
    with open(p, "rb") as f:
        struct.unpack("<III", f.read(12)); clen, ct = struct.unpack("<II", f.read(8))
        return json.loads(f.read(clen).decode("utf-8", "replace"))

def quat_mat(q):
    x, y, z, w = q
    return np.array([
        [1-2*(y*y+z*z), 2*(x*y-z*w),   2*(x*z+y*w),   0],
        [2*(x*y+z*w),   1-2*(x*x+z*z), 2*(y*z-x*w),   0],
        [2*(x*z-y*w),   2*(y*z+x*w),   1-2*(x*x+y*y), 0],
        [0, 0, 0, 1]], float)

def local(n):
    if "matrix" in n: return np.array(n["matrix"], float).reshape(4, 4).T
    T = np.eye(4); R = np.eye(4); S = np.eye(4)
    if "translation" in n: T[:3, 3] = n["translation"]
    if "rotation" in n: R = quat_mat(n["rotation"])
    if "scale" in n: S[0, 0], S[1, 1], S[2, 2] = n["scale"]
    return T @ R @ S

g = load_glb(sys.argv[1]); nodes = g["nodes"]
parent = {}
for i, n in enumerate(nodes):
    for c in n.get("children", []): parent[c] = i
W = {}
def world(i):
    if i in W: return W[i]
    m = local(nodes[i]); W[i] = (world(parent[i]) @ m) if i in parent else m
    return W[i]
def wp(i): return world(i)[:3, 3]
joints = set()
for sk in g.get("skins", []): joints.update(sk.get("joints", []))
name = lambda i: nodes[i].get("name", "") or f"node{i}"

def report(title, pat):
    print(f"\n== {title} ==")
    hits = [i for i in joints if re.search(pat, name(i), re.I)]
    hits.sort(key=lambda i: name(i))
    for i in hits:
        p = wp(i); par = parent.get(i)
        kids = [c for c in nodes[i].get("children", []) if c in joints]
        d = ""
        if kids:
            v = wp(kids[0]) - p; n = np.linalg.norm(v)
            if n > 1e-6: v = v / n; d = f" points=({v[0]:+.2f},{v[1]:+.2f},{v[2]:+.2f}) len={n:.3f}"
        print(f"  {name(i):42s} pos=({p[0]:+.2f},{p[1]:+.2f},{p[2]:+.2f}) parent={name(par) if par is not None else '-':22s}{d}")

print("model:", sys.argv[1], " joints:", len(joints))
report("ARMS / FOREARMS / HANDS / FINGERS", r"arm|hand|finger|thumb|wrist|elbow|palm")
report("HEAD / NECK / EYES", r"head|neck|eye(?!brow)")
report("SPINE / CHEST / HIPS", r"spine|chest|hip|pelvis|spine|torso|root")
report("LEGS / FEET", r"leg|thigh|shin|knee|foot|ankle|toe")
