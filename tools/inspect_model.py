# inspect_model.py — dump the real structure of a GLB/GLTF avatar so we design
# against what is ACTUALLY in the file, not the names people gave parts.
# Surfaces: glTF extensions (VRM / springbone), node/bone names (physbones, "dick"),
# meshes + their morph-target (blendshape) names, materials, skins.
import sys, json, struct, re


def load_gltf_json(path):
    if path.lower().endswith(".glb"):
        with open(path, "rb") as f:
            magic, ver, length = struct.unpack("<III", f.read(12))
            if magic != 0x46546C67:
                raise SystemExit("not a glb: " + path)
            clen, ctype = struct.unpack("<II", f.read(8))
            data = f.read(clen)
            return json.loads(data.decode("utf-8", "replace"))
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


KW = re.compile(
    r"breast|boob|bust|oppai|nip|butt|glute|ass|hip|thigh|belly|tummy|"
    r"dick|penis|cock|balls|testicl|futa|genital|pussy|vagin|cloth|skirt|"
    r"dress|hair|tail|ear|physbone|pb_|dynamic|jiggle|spring",
    re.I,
)


def morph_names(g, m):
    prims = m.get("primitives") or []
    if not prims:
        return []
    names = (m.get("extras") or {}).get("targetNames")
    if names:
        return names
    # fall back to count
    t = prims[0].get("targets") or []
    return [f"<morph {i}>" for i in range(len(t))]


FACE_RE = re.compile(
    r"jaw|eye(?!brow)|lid|blink|mouth|lip|teeth|tongue|brow|cheek|"
    r"face|head",
    re.I,
)


def node_name(nodes, i):
    try:
        return nodes[i].get("name", f"<node {i}>") or f"<node {i}>"
    except Exception:
        return f"<node {i}>"


def report_animations(g):
    nodes = g.get("nodes") or []
    accs = g.get("accessors") or []
    anims = g.get("animations") or []
    print("\n== ANIMATIONS:", len(anims))
    if not anims:
        print("  (none baked in -- body is posed by OUR procedural rig only)")
        return
    for ai, a in enumerate(anims):
        chans = a.get("channels") or []
        samps = a.get("samplers") or []
        paths = {}
        targets = set()
        face_targets = set()
        weights_anim = False
        dur = 0.0
        for c in chans:
            t = c.get("target") or {}
            p = t.get("path", "?")
            paths[p] = paths.get(p, 0) + 1
            if p == "weights":
                weights_anim = True
            ni = t.get("node")
            if ni is not None:
                nm = node_name(nodes, ni)
                targets.add(nm)
                if FACE_RE.search(nm):
                    face_targets.add(nm)
        # duration = max input-accessor time across samplers (accessor.max[0])
        for s in samps:
            ia = s.get("input")
            if ia is not None and ia < len(accs):
                mx = accs[ia].get("max") or [0]
                if mx and mx[0] and mx[0] > dur:
                    dur = mx[0]
        nm = a.get("name", f"<anim {ai}>")
        print(f'  anim[{ai}] "{nm}"  ~{dur:.2f}s  channels={len(chans)}  paths={paths}  bones_animated={len(targets)}')
        if weights_anim:
            print("       *** MORPH-WEIGHT animation present (baked FACIAL/blendshape motion) ***")
        if face_targets:
            print(f"       face/head bones animated ({len(face_targets)}): {sorted(face_targets)[:12]}")


def report_face_rig(g):
    nodes = g.get("nodes") or []
    skins = g.get("skins") or []
    joint_ids = set()
    for s in skins:
        for j in s.get("joints") or []:
            joint_ids.add(j)
    face_bones = [node_name(nodes, j) for j in joint_ids if FACE_RE.search(node_name(nodes, j))]
    print("\n== FACE-RIG SCAN (bones in skins matching jaw/eye/lid/mouth/brow/head):", len(face_bones))
    for b in sorted(set(face_bones)):
        print(f"    + {b}")
    # total morph channels across all meshes
    total_morphs = 0
    for m in g.get("meshes") or []:
        prims = m.get("primitives") or []
        if prims:
            total_morphs += len(prims[0].get("targets") or [])
    print(f"  total morph targets across all meshes: {total_morphs}")


def main(path):
    g = load_gltf_json(path)
    ext_used = g.get("extensionsUsed") or []
    ext_req = g.get("extensionsRequired") or []
    top_ext = list((g.get("extensions") or {}).keys())
    print("== FILE:", path)
    print("generator:", (g.get("asset") or {}).get("generator"))
    print("extensionsUsed:", ext_used)
    print("extensionsRequired:", ext_req)
    print("top-level extensions:", top_ext)

    nodes = g.get("nodes") or []
    print("\n== NODES:", len(nodes))
    hits = [(i, n.get("name", "")) for i, n in enumerate(nodes) if KW.search(n.get("name", "") or "")]
    print("  keyword-matching node names (boob/dick/cloth/physbone/etc):", len(hits))
    for i, nm in hits:
        print(f"    [{i}] {nm}")

    skins = g.get("skins") or []
    print("\n== SKINS:", len(skins))
    for i, s in enumerate(skins):
        print(f"  skin[{i}] {s.get('name', '')} joints={len(s.get('joints', []))}")

    meshes = g.get("meshes") or []
    print("\n== MESHES:", len(meshes))
    for i, m in enumerate(meshes):
        names = morph_names(g, m)
        print(f"  mesh[{i}] {m.get('name', '')}  prims={len(m.get('primitives') or [])}  morphs={len(names)}")
        for nm in names:
            print(f"       ~ {nm}")

    mats = g.get("materials") or []
    print("\n== MATERIALS:", len(mats))
    for i, mt in enumerate(mats):
        print(f"  [{i}] {mt.get('name', '')}")

    report_face_rig(g)
    report_animations(g)

    # VRM specifics — these carry the avatar's own toggle menu + spring config
    ext = g.get("extensions") or {}
    for key in ("VRM", "VRMC_vrm", "VRMC_springBone", "VRMC_vrm_animation"):
        if key in ext:
            print(f"\n== EXTENSION {key} -- keys:", list(ext[key].keys()))
            blob = json.dumps(ext[key])
            print(f"   (size {len(blob)} chars)")
            v = ext[key]
            # VRM 0.x expression/blendshape menu
            bsm = v.get("blendShapeMaster") if isinstance(v, dict) else None
            if bsm and bsm.get("blendShapeGroups"):
                print("   blendShapeGroups (avatar's own toggle/expression menu):")
                for grp in bsm["blendShapeGroups"]:
                    print(
                        f"     - {grp.get('presetName', '')}/{grp.get('name', '')} binds={len(grp.get('binds') or [])}"
                    )
            # VRM 1.0 expressions
            expr = v.get("expressions") if isinstance(v, dict) else None
            if expr:
                preset = expr.get("preset") or {}
                custom = expr.get("custom") or {}
                print("   expressions preset:", list(preset.keys()))
                print("   expressions custom:", list(custom.keys()))

    if "VRMC_springBone" in ext or (isinstance(ext.get("VRM"), dict) and ext["VRM"].get("secondaryAnimation")):
        print("\n== SPRINGBONE config present (avatar ships its own jiggle setup)")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        try:
            main(p)
        except Exception as e:
            print("ERROR on", p, "->", repr(e))
        print("\n" + "=" * 70 + "\n")
