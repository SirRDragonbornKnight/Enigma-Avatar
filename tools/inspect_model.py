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

KW = re.compile(r"breast|boob|bust|oppai|nip|butt|glute|ass|hip|thigh|belly|tummy|"
                r"dick|penis|cock|balls|testicl|futa|genital|pussy|vagin|cloth|skirt|"
                r"dress|hair|tail|ear|physbone|pb_|dynamic|jiggle|spring", re.I)

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
        print(f"  skin[{i}] {s.get('name','')} joints={len(s.get('joints',[]))}")

    meshes = g.get("meshes") or []
    print("\n== MESHES:", len(meshes))
    for i, m in enumerate(meshes):
        names = morph_names(g, m)
        print(f"  mesh[{i}] {m.get('name','')}  prims={len(m.get('primitives') or [])}  morphs={len(names)}")
        for nm in names:
            print(f"       ~ {nm}")

    mats = g.get("materials") or []
    print("\n== MATERIALS:", len(mats))
    for i, mt in enumerate(mats):
        print(f"  [{i}] {mt.get('name','')}")

    # VRM specifics — these carry the avatar's own toggle menu + spring config
    ext = g.get("extensions") or {}
    for key in ("VRM", "VRMC_vrm", "VRMC_springBone", "VRMC_vrm_animation"):
        if key in ext:
            print(f"\n== EXTENSION {key} — keys:", list(ext[key].keys()))
            blob = json.dumps(ext[key])
            print(f"   (size {len(blob)} chars)")
            v = ext[key]
            # VRM 0.x expression/blendshape menu
            bsm = v.get("blendShapeMaster") if isinstance(v, dict) else None
            if bsm and bsm.get("blendShapeGroups"):
                print("   blendShapeGroups (avatar's own toggle/expression menu):")
                for grp in bsm["blendShapeGroups"]:
                    print(f"     - {grp.get('presetName','')}/{grp.get('name','')} binds={len(grp.get('binds') or [])}")
            # VRM 1.0 expressions
            expr = v.get("expressions") if isinstance(v, dict) else None
            if expr:
                preset = (expr.get("preset") or {})
                custom = (expr.get("custom") or {})
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
