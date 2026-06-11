# audit_faces.py — binary-level FACE audit across every installed model.
#
# The facial fallback ladder (facial.js) was designed around NAMED channels; this
# tool decodes what each GLB ACTUALLY ships so we can see where the ladder lies:
#   - every morph target: name (if any) + GEOMETRIC features (where on the mesh its
#     displaced verts sit, which way they move) -> eye-region / mouth-region guess
#   - every baked animation's morph-WEIGHT tracks: which morph indices the author
#     animated, with what temporal pattern (short pulses = blink-like; sustained =
#     expression/mouth) -> the model's own clip used as LEARNING DATA about its face
#   - face bones in the skin (jaw / eyelid / eye / brow) by name
#   - a simulation of facial.js's CURRENT ladder choice -> which channels get LOST
#
# Output: human table on stdout + tools/face_audit.json for the implementation pass.
# Usage: python tools/audit_faces.py [modelsDir]   (default: ../models relative to this file)
import sys, os, json, struct, re, base64
import numpy as np

# ---- regexes mirrored from facial.js / rig.js (keep in sync when simulating) ----
OPEN_RE  = re.compile(r"jaw.?open|mouth.?open|mouthopen|(^|[._-])aa($|[._-])|vrc\.v_aa|viseme.?aa", re.I)
JAWMORPH_RE = re.compile(r"jaw.?open|mouth.?open|mouthopen", re.I)
BLINK_RE = re.compile(r"blink|eyes?.?clos|wink", re.I)
JAW_RE   = re.compile(r"jaw", re.I)
LID_RE   = re.compile(r"eye.?lid|eyelid|(^|[._-])lid($|[._-])", re.I)
EYE_RE   = re.compile(r"eye", re.I)
EYE_NOT  = re.compile(r"brow|lash|lid|patch|con(troller)?$|eye_?con|aim|target|lookat|socket|shadow", re.I)
BROW_RE  = re.compile(r"brow", re.I)
MOUTHISH_RE = re.compile(r"mouth|lip|smile|frown|tongue|teeth|viseme|vrc\.v_", re.I)

CT = {5120: ("i1", 1), 5121: ("u1", 1), 5122: ("i2", 2), 5123: ("u2", 2), 5125: ("u4", 4), 5126: ("f4", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

def load_gltf(path):
    """Return (gltf_json, [buffer bytes])."""
    if path.lower().endswith(".glb"):
        with open(path, "rb") as f:
            data = f.read()
        magic, _ver, length = struct.unpack_from("<III", data, 0)
        if magic != 0x46546C67:
            raise ValueError("not a glb")
        off, gjson, bins = 12, None, []
        while off + 8 <= min(length, len(data)):
            clen, ctype = struct.unpack_from("<II", data, off); off += 8
            chunk = data[off:off + clen]; off += clen
            if ctype == 0x4E4F534A: gjson = json.loads(chunk.decode("utf-8", "replace"))
            elif ctype == 0x004E4942: bins.append(bytes(chunk))
        bufs = []
        for b in (gjson.get("buffers") or [{}]):
            uri = b.get("uri")
            if uri is None: bufs.append(bins[0] if bins else b"")
            elif uri.startswith("data:"): bufs.append(base64.b64decode(uri.split(",", 1)[1]))
            else:
                with open(os.path.join(os.path.dirname(path), uri), "rb") as f: bufs.append(f.read())
        return gjson, bufs
    with open(path, "r", encoding="utf-8") as f:
        g = json.load(f)
    bufs = []
    for b in (g.get("buffers") or []):
        uri = b.get("uri") or ""
        if uri.startswith("data:"): bufs.append(base64.b64decode(uri.split(",", 1)[1]))
        else:
            with open(os.path.join(os.path.dirname(path), uri), "rb") as f: bufs.append(f.read())
    return g, bufs

def read_accessor(g, bufs, ai):
    """Decode accessor ai -> float32 ndarray (count, ncomp). Handles strides, sparse, normalized ints."""
    a = g["accessors"][ai]
    n, ncomp = a["count"], NCOMP[a["type"]]
    dt, esz = CT[a["componentType"]]
    if "bufferView" in a:
        bv = g["bufferViews"][a["bufferView"]]
        buf = bufs[bv.get("buffer", 0)]
        start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride") or esz * ncomp
        if stride == esz * ncomp:
            arr = np.frombuffer(buf, dtype=dt, count=n * ncomp, offset=start).reshape(n, ncomp)
        else:  # interleaved
            raw = np.frombuffer(buf, dtype=np.uint8, count=stride * (n - 1) + esz * ncomp, offset=start)
            arr = np.lib.stride_tricks.as_strided(raw[:].view(dt), shape=(n, ncomp), strides=(stride, esz)).copy()
        out = arr.astype(np.float32)
        if a.get("normalized") and dt != "f4":
            out = out / float(np.iinfo(np.dtype(dt)).max)
    else:
        out = np.zeros((n, ncomp), dtype=np.float32)
    sp = a.get("sparse")
    if sp:
        cnt = sp["count"]
        idt, iesz = CT[sp["indices"]["componentType"]]
        ibv = g["bufferViews"][sp["indices"]["bufferView"]]
        ioff = ibv.get("byteOffset", 0) + sp["indices"].get("byteOffset", 0)
        idx = np.frombuffer(bufs[ibv.get("buffer", 0)], dtype=idt, count=cnt, offset=ioff).astype(np.int64)
        vbv = g["bufferViews"][sp["values"]["bufferView"]]
        voff = vbv.get("byteOffset", 0) + sp["values"].get("byteOffset", 0)
        vals = np.frombuffer(bufs[vbv.get("buffer", 0)], dtype=dt, count=cnt * ncomp, offset=voff).reshape(cnt, ncomp).astype(np.float32)
        out = out.copy(); out[idx] = vals
    return out

def morph_names_for(g, mesh):
    prims = mesh.get("primitives") or []
    if not prims: return []
    names = (mesh.get("extras") or {}).get("targetNames") or (prims[0].get("extras") or {}).get("targetNames")
    nt = len(prims[0].get("targets") or [])
    if names and len(names) >= nt: return list(names[:nt])
    return [None] * nt

# ---------- geometric morph features ----------
def morph_features(g, bufs, mesh):
    """For each morph target of mesh: where its displaced verts sit + which way they move."""
    prims = mesh.get("primitives") or []
    if not prims: return []
    prim = prims[0]
    targets = prim.get("targets") or []
    if not targets: return []
    try:
        pos = read_accessor(g, bufs, prim["attributes"]["POSITION"])
    except Exception as e:
        return [{"error": f"base pos: {e!r}"}] * len(targets)
    lo, hi = pos.min(axis=0), pos.max(axis=0)
    size = np.maximum(hi - lo, 1e-9)
    feats = []
    for t in targets:
        if "POSITION" not in t:
            feats.append({"affectedFrac": 0.0, "note": "no POSITION delta"}); continue
        try:
            d = read_accessor(g, bufs, t["POSITION"])
        except Exception as e:
            feats.append({"error": repr(e)}); continue
        mag = np.linalg.norm(d, axis=1)
        mx = float(mag.max()) if len(mag) else 0.0
        if mx <= 1e-9:
            feats.append({"affectedFrac": 0.0, "note": "zero delta"}); continue
        aff = mag > max(mx * 0.05, 1e-7)
        pa, da = pos[aff], d[aff]
        c = pa.mean(axis=0)
        alo, ahi = pa.min(axis=0), pa.max(axis=0)
        mean_dir = (da / np.linalg.norm(da, axis=1, keepdims=True)).mean(axis=0)
        feats.append({
            "affectedFrac": round(float(aff.mean()), 4),
            "centroidFrac": [round(float((c[i] - lo[i]) / size[i]), 3) for i in range(3)],   # x,y,z in 0..1 of mesh bbox
            "regionSizeFrac": [round(float((ahi[i] - alo[i]) / size[i]), 3) for i in range(3)],
            "meanDir": [round(float(v), 3) for v in mean_dir],     # dominant motion direction (mesh-local)
            "maxDelta": round(mx, 5),
        })
    return feats

def guess_region(f, mesh_is_facey):
    """Loose semantic guess from geometry — evidence, not gospel."""
    if not f or f.get("error") or f.get("affectedFrac", 0) <= 0: return ""
    cx, cy, _cz = f["centroidFrac"]
    down = -f["meanDir"][1]
    tags = []
    hi_y = 0.55 if mesh_is_facey else 0.80          # face-only mesh: eyes mid-high; body mesh: face is the top
    if cy >= hi_y and f["affectedFrac"] < 0.35:
        tags.append("eye-region" if down > 0.25 else "upper-face")
    elif f["affectedFrac"] < 0.5:
        tags.append("lower-face" if cy >= (0.3 if mesh_is_facey else 0.65) else "low/other")
    if down > 0.45: tags.append("moves-down")
    if cx < 0.38: tags.append("L-side")
    elif cx > 0.62: tags.append("R-side")
    return "+".join(tags)

# ---------- animation weight-track mining ----------
def mine_weight_tracks(g, bufs):
    """Decode every animation's morph-weight channels -> per-morph activity + temporal pattern."""
    out = []
    nodes = g.get("nodes") or []
    for ai, anim in enumerate(g.get("animations") or []):
        samplers = anim.get("samplers") or []
        for ch in (anim.get("channels") or []):
            tgt = ch.get("target") or {}
            if tgt.get("path") != "weights": continue
            ni = tgt.get("node")
            mesh_i = nodes[ni].get("mesh") if ni is not None and ni < len(nodes) else None
            if mesh_i is None: continue
            nm = len((g["meshes"][mesh_i].get("primitives") or [{}])[0].get("targets") or [])
            if not nm: continue
            s = samplers[ch["sampler"]]
            times = read_accessor(g, bufs, s["input"]).ravel()
            vals = read_accessor(g, bufs, s["output"]).ravel()
            if s.get("interpolation") == "CUBICSPLINE":
                vals = vals.reshape(-1, 3 * nm)[:, nm:2 * nm]     # keep the value, drop tangents
            else:
                vals = vals.reshape(-1, nm)
            if len(times) < 2 or vals.shape[0] != len(times): continue
            dur = float(times[-1] - times[0]) or 1.0
            tracks = []
            for k in range(nm):
                v = vals[:, k]
                mx = float(v.max())
                if mx < 0.05: continue
                # pulse pattern: rises above 60% of max then falls back under 15%
                hi, lo = 0.6 * mx, 0.15 * mx
                pulses, inp, t0 = [], False, 0.0
                for t, x in zip(times, v):
                    if not inp and x >= hi: inp, t0 = True, t
                    elif inp and x <= lo: inp = False; pulses.append(float(t - t0))
                mean_on = float(v[v > lo].mean()) if (v > lo).any() else 0.0
                duty = float((v > lo).mean())
                pat = ("blink-like" if pulses and max(pulses) < 0.6 and len(pulses) >= 1 and duty < 0.5
                       else "sustained" if duty > 0.5 else "pulsed")
                tracks.append({"morph": k, "max": round(mx, 3), "duty": round(duty, 3),
                               "pulses": len(pulses), "pulseWidths": [round(p, 2) for p in pulses[:8]],
                               "meanOn": round(mean_on, 3), "pattern": pat})
            if tracks:
                out.append({"anim": anim.get("name", f"<anim {ai}>"), "mesh": mesh_i,
                            "meshName": g["meshes"][mesh_i].get("name", ""), "dur": round(dur, 2),
                            "keyframes": int(len(times)), "tracks": tracks})
    return out

# ---------- per-model audit ----------
def audit(path):
    g, bufs = load_gltf(path)
    nodes = g.get("nodes") or []
    r = {"file": path, "generator": (g.get("asset") or {}).get("generator", "")}

    ext = list((g.get("extensions") or {}).keys()) + (g.get("extensionsUsed") or [])
    r["vrm"] = any(k in ("VRM", "VRMC_vrm") for k in ext)

    # bones in skins, by face role
    joints = set()
    for s in (g.get("skins") or []):
        joints.update(s.get("joints") or [])
    names = [(j, (nodes[j].get("name") or f"<node {j}>")) for j in sorted(joints) if j < len(nodes)]
    r["jawBones"]  = [n for _j, n in names if JAW_RE.search(n)]
    r["lidBones"]  = [n for _j, n in names if LID_RE.search(n)]
    r["eyeBones"]  = [n for _j, n in names if EYE_RE.search(n) and not EYE_NOT.search(n) and not LID_RE.search(n) and not BROW_RE.search(n)]
    r["browBones"] = [n for _j, n in names if BROW_RE.search(n)]

    # morphs: names + geometry
    meshes = g.get("meshes") or []
    r["meshMorphs"] = []
    total_morphs = named_morphs = 0
    for mi, m in enumerate(meshes):
        mnames = morph_names_for(g, m)
        if not mnames: continue
        total_morphs += len(mnames)
        named = [n for n in mnames if n]
        named_morphs += len(named)
        feats = morph_features(g, bufs, m)
        mesh_name = m.get("name", "")
        # is this mesh face-only? crude: small vert share + face material name, refined by eye
        facey = bool(re.search(r"face|head|cheek", mesh_name, re.I))
        entries = []
        for k, (nm, f) in enumerate(zip(mnames, feats)):
            entries.append({"i": k, "name": nm, **(f or {}), "guess": guess_region(f, facey)})
        r["meshMorphs"].append({"mesh": mi, "meshName": mesh_name, "count": len(mnames), "named": len(named), "morphs": entries})
    r["totalMorphs"], r["namedMorphs"] = total_morphs, named_morphs

    # name-dictionary hits (the ladder's current vocabulary)
    all_named = [(e["name"] or "") for mm in r["meshMorphs"] for e in mm["morphs"]]
    r["openNameHits"]  = [n for n in all_named if n and OPEN_RE.search(n)]
    r["blinkNameHits"] = [n for n in all_named if n and BLINK_RE.search(n)]
    r["mouthishNames"] = [n for n in all_named if n and MOUTHISH_RE.search(n)]

    # animation mining
    r["weightTracks"] = mine_weight_tracks(g, bufs)
    r["animCount"] = len(g.get("animations") or [])

    # ---- simulate facial.js ladder ----
    if r["vrm"]: mode = "vrm"
    elif r["openNameHits"]: mode = "morph"
    elif r["jawBones"]: mode = "bones"
    elif total_morphs: mode = "morph-geom?"     # geometric mouth detector MAY find one (runtime decides)
    else: mode = "none"
    r["ladderMode"] = mode

    lost = []
    if mode == "morph" and not r["blinkNameHits"] and r["lidBones"]:
        lost.append(f"blink: {len(r['lidBones'])} eyelid BONES unused (morph mode has no bones blink)")
    if mode == "bones" and total_morphs:
        lost.append(f"{total_morphs} morphs unused by facial (bones mode)")
    if mode in ("morph-geom?", "none") and total_morphs and not named_morphs:
        lost.append(f"{total_morphs} UNNAMED morphs undetectable by name")
    if r["weightTracks"] and mode in ("morph-geom?", "none"):
        lost.append("baked clip drives morphs the ladder can't identify (learning data unused)")
    if mode == "none" and r["lidBones"]:
        lost.append(f"{len(r['lidBones'])} eyelid bones unused (no jaw -> bones mode never reached)")
    r["lostChannels"] = lost
    return r

def fmt_list(xs, n=4):
    xs = list(xs)
    return (", ".join(xs[:n]) + (f" (+{len(xs)-n})" if len(xs) > n else "")) or "-"

def main():
    base = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "models")
    base = os.path.abspath(base)
    results = []
    for d in sorted(os.listdir(base)):
        if d.startswith(("_", ".")): continue
        full = os.path.join(base, d)
        if not os.path.isdir(full): continue
        cand = [os.path.join(dp, f) for dp, _dn, fn in os.walk(full) for f in fn if f.lower().endswith((".glb", ".gltf"))]
        if not cand: continue
        path = sorted(cand, key=lambda p: -os.path.getsize(p))[0]
        try:
            r = audit(path); r["model"] = d
        except Exception as e:
            r = {"model": d, "file": path, "error": repr(e)}
        results.append(r)

    for r in results:
        print(f"\n=== {r['model']} ===")
        if "error" in r:
            print("  ERROR:", r["error"]); continue
        print(f"  ladder mode: {r['ladderMode']:12s} vrm={r['vrm']}  anims={r['animCount']}  morphs={r['totalMorphs']} ({r['namedMorphs']} named)")
        print(f"  bones: jaw=[{fmt_list(r['jawBones'])}] lids={len(r['lidBones'])} eyes=[{fmt_list(r['eyeBones'])}] brows={len(r['browBones'])}")
        if r["openNameHits"] or r["blinkNameHits"]:
            print(f"  name hits: open=[{fmt_list(r['openNameHits'])}] blink=[{fmt_list(r['blinkNameHits'])}]")
        if r["mouthishNames"]:
            print(f"  mouth-ish names: {fmt_list(r['mouthishNames'], 6)}")
        for wt in r["weightTracks"]:
            print(f"  CLIP \"{wt['anim']}\" mesh[{wt['mesh']}] {wt['meshName']} ({wt['dur']}s, {wt['keyframes']} keys):")
            for t in wt["tracks"]:
                print(f"      morph #{t['morph']}: max={t['max']} duty={t['duty']} pulses={t['pulses']}{t['pulseWidths']} -> {t['pattern']}")
        for mm in r["meshMorphs"]:
            interesting = [e for e in mm["morphs"] if e.get("guess") or e.get("name")]
            if not interesting: continue
            print(f"  morph geometry mesh[{mm['mesh']}] {mm['meshName']} ({mm['count']} morphs, {mm['named']} named):")
            for e in interesting[:24]:
                nm = e.get("name") or f"#{e['i']}"
                cf = e.get("centroidFrac"); md = e.get("meanDir")
                print(f"      {nm:24s} aff={e.get('affectedFrac', 0):6.3f} c={cf} dir={md} {e.get('guess','')}")
            if len(interesting) > 24: print(f"      ... +{len(interesting)-24} more")
        if r["lostChannels"]:
            print("  !! LOST:", " | ".join(r["lostChannels"]))

    out = os.path.join(os.path.dirname(__file__), "face_audit.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=1)
    print(f"\n[json -> {out}]")

if __name__ == "__main__":
    main()
