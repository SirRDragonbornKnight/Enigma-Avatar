"""import_unitypackage.py — turn a Unity ``.unitypackage`` into a folder the avatar can load.

No Unity required. A ``.unitypackage`` is a gzipped tar where every asset lives
under a GUID directory::

    <guid>/asset        the file bytes (mesh, texture, …)
    <guid>/pathname     a text file with its original "Assets/…" path
    <guid>/asset.meta   Unity import settings (ignored)

This pulls the *renderable* bits out into a flat folder under ``models/``:

  * **model mode (default)** — the mesh(es) (``.fbx/.gltf/.glb/.obj/.dae``) plus all
    image textures (``.png/.jpg/.tga/.psd/.tif/.bmp/.exr/.webp``), flattened into one
    folder so three.js' ``FBXLoader`` resolves textures by bare filename. FBX embeds
    NO textures (Unity binds them via ``.mat``), so the ``.mat`` files are parsed into a
    ``materials.json`` sidecar that re-binds each material's textures by name (the
    overlay applies it on load). Unity shaders (Poiyomi, ``.cginc/.shader``) are skipped.
  * **--tree** — reconstruct the full ``Assets/`` tree (everything) for inspection.

Usage::

    python import_unitypackage.py "Mal0 PC.unitypackage" --name mal0
    python import_unitypackage.py pkg.unitypackage --tree --out C:\\tmp\\pkg

Notes:
  * ``.tga`` textures load in the overlay via a ``TGALoader`` registered on the
    loader's manager (see avatar.js). ``.psd`` cannot be loaded by a browser/three —
    those are reported so you can convert or ignore them.
  * Prints the mesh path to register; ``--register`` writes it into ``models.json``.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tarfile

MESH_EXT = {".fbx", ".gltf", ".glb", ".obj", ".dae"}
TEX_EXT = {".png", ".jpg", ".jpeg", ".tga", ".psd", ".tif", ".tiff", ".bmp", ".exr", ".webp"}
UNLOADABLE_TEX = {".psd", ".exr", ".tif", ".tiff"}  # browser/three can't decode these directly


def _real_ext(data: bytes, fallback: str) -> str:
    """Unity packages frequently MISLABEL textures (a PNG named .tga, etc.); three's
    loaders trust the extension, so TGALoader chokes on a PNG ('Invalid type 78').
    Detect the real format by magic bytes; real TGA has none → keep the declared ext."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] == b"DDS ":
        return ".dds"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data[:2] == b"BM":
        return ".bmp"
    return fallback

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(HERE, "models")


def _slug(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9._-]+", "_", name.strip()).strip("_.")
    return s.lower() or "model"


def _entries(pkg_path: str):
    """Yield ``(pathname, data_bytes)`` for every asset that has both a pathname
    and an asset blob. Two-pass over the tar: collect the GUID dirs, then read."""
    with tarfile.open(pkg_path, "r:gz") as tar:
        guids: dict[str, dict] = {}
        for m in tar.getmembers():
            if not m.isfile():
                continue
            parts = m.name.split("/")
            if len(parts) < 2:
                continue
            guid, leaf = parts[0], parts[-1]
            slot = guids.setdefault(guid, {})
            if leaf == "pathname":
                raw = tar.extractfile(m)
                if raw is not None:
                    text = raw.read().decode("utf-8", "replace").splitlines()
                    slot["pathname"] = (text[0].strip() if text else "")
            elif leaf == "asset":
                slot["asset"] = m
        for guid, slot in guids.items():
            pn, am = slot.get("pathname"), slot.get("asset")
            if not pn or am is None:
                continue
            blob = tar.extractfile(am)
            if blob is None:
                continue
            yield pn, blob.read()


def extract_tree(pkg_path: str, out_dir: str) -> int:
    n = 0
    for pathname, data in _entries(pkg_path):
        dest = os.path.join(out_dir, pathname.replace("\\", "/"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(data)
        n += 1
    return n


def extract_model(pkg_path: str, out_dir: str) -> dict:
    """Flatten mesh + texture assets into ``out_dir``. Returns a summary dict."""
    os.makedirs(out_dir, exist_ok=True)
    meshes: list[tuple[str, bytes, str]] = []
    textures: list[tuple[str, bytes, str]] = []
    for pathname, data in _entries(pkg_path):
        ext = os.path.splitext(pathname)[1].lower()
        base = os.path.basename(pathname.replace("\\", "/"))
        if ext in MESH_EXT:
            meshes.append((base, data, pathname))
        elif ext in TEX_EXT:
            textures.append((base, data, pathname))

    written: list[str] = []
    collisions: list[str] = []
    renamed: dict[str, str] = {}   # original basename -> written basename (corrected extension)
    seen: dict[str, str] = {}      # written basename -> source pathname (first wins)
    tex_set = {t[0] for t in textures}
    for base, data, pn in meshes + textures:
        final = base
        if base in tex_set:                            # fix mislabeled texture extensions
            ext = os.path.splitext(base)[1].lower()
            real = _real_ext(data, ext)
            if real != ext:
                final = os.path.splitext(base)[0] + real
        renamed[base] = final
        if final in seen:
            collisions.append(f"{pn}  (collides with {seen[final]}; kept first)")
            continue
        seen[final] = pn
        with open(os.path.join(out_dir, final), "wb") as f:
            f.write(data)
        written.append(final)
        if final != base:                              # drop a stale wrong-extension copy from a prior import
            stale = os.path.join(out_dir, base)
            if os.path.exists(stale):
                try:
                    os.remove(stale)
                except OSError:
                    pass

    # Pick the primary mesh: prefer .fbx/.glb/.gltf by rank, then the LARGEST file
    # (the avatar body almost always dwarfs props like a pole / weapon / base).
    sizes = {m[0]: len(m[1]) for m in meshes}

    def mesh_key(b: str):
        e = os.path.splitext(b)[1].lower()
        rank = {".fbx": 0, ".glb": 1, ".gltf": 2, ".obj": 3, ".dae": 4}.get(e, 9)
        return (rank, -sizes.get(b, 0))

    mesh_names = sorted({m[0] for m in meshes}, key=mesh_key)
    primary = mesh_names[0] if mesh_names else None
    final_tex = sorted({renamed.get(t[0], t[0]) for t in textures})
    unloadable = sorted({t for t in final_tex if os.path.splitext(t)[1].lower() in UNLOADABLE_TEX})
    return {
        "out_dir": out_dir,
        "primary": primary,
        "meshes": mesh_names,
        "textures": final_tex,
        "unloadable_textures": unloadable,
        "collisions": collisions,
        "written": written,
        "renamed": renamed,
    }


def _register(name: str, mesh_rel: str) -> None:
    """Append/update an entry in models.json so the overlay lists this model."""
    path = os.path.join(HERE, "models.json")
    try:
        manifest = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    except Exception:
        manifest = {}
    if not isinstance(manifest, dict):
        manifest = {}
    models = manifest.setdefault("models", [])
    models[:] = [m for m in models if isinstance(m, dict) and m.get("id") != name]
    models.append({"id": name, "label": name.replace("_", " ").title(), "url": mesh_rel})
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"registered '{name}' -> {mesh_rel} in {path}")


# Unity material texture-property → three.js material slot.
_MAT_SLOTS = {"_MainTex": "map", "_BumpMap": "normalMap", "_NormalMap": "normalMap"}


def _package_materials(pkg_path: str):
    """One tar pass → (guid->basename, [(matName, {prop: texGuid})]) from .mat files."""
    guid_base: dict[str, str] = {}
    mats: list[tuple[str, dict]] = []
    with tarfile.open(pkg_path, "r:gz") as tar:
        slots: dict[str, dict] = {}
        for m in tar.getmembers():
            if not m.isfile():
                continue
            parts = m.name.split("/")
            if len(parts) < 2:
                continue
            slots.setdefault(parts[0], {})[parts[-1]] = m
        for guid, slot in slots.items():
            if "pathname" not in slot:
                continue
            raw = tar.extractfile(slot["pathname"])
            lines = raw.read().decode("utf-8", "replace").splitlines() if raw else []
            pn = lines[0].strip() if lines else ""
            guid_base[guid] = os.path.basename(pn.replace("\\", "/"))
            if pn.lower().endswith(".mat") and "asset" in slot:
                body = tar.extractfile(slot["asset"]).read().decode("utf-8", "replace")
                nm = re.search(r"m_Name:\s*(.+)", body)
                texs = re.findall(r"-\s*(_\w+):\s*\n\s*m_Texture:\s*\{fileID:\s*\d+(?:,\s*guid:\s*([0-9a-f]+))?", body)
                name = nm.group(1).strip() if nm else os.path.basename(pn)[:-4]
                mats.append((name, {p: g for p, g in texs if g}))
    return guid_base, mats


def _fbx_material_names(fbx_bytes: bytes) -> list[str]:
    """FBX7 binary stores object names as ``Name\\x00\\x01Class`` — pull the Materials."""
    names: list[str] = []
    for n in re.findall(rb"([A-Za-z0-9_. :-]{1,64})\x00\x01Material", fbx_bytes):
        s = n.decode("ascii", "ignore").strip()
        if s and s not in names:
            names.append(s)
    return names


def build_material_map(pkg_path: str, fbx_bytes: bytes, rename: dict | None = None):
    """Map each FBX material name → {map, normalMap} texture basenames using the Unity
    .mat files. FBX materials carry NO textures (Unity binds them by name via .mat);
    a name that matches no .mat (often "body") gets the most-referenced color map as a
    best-guess skin. Returns (map, guessed_names)."""
    rename = rename or {}
    guid_base, mats = _package_materials(pkg_path)

    def res(guid):                       # texture guid -> final (corrected-extension) basename
        b = guid_base.get(guid)
        return rename.get(b, b) if b else None

    by_name: dict[str, dict] = {}
    main_use: dict[str, int] = {}
    pair_normal: dict[str, str] = {}
    for mname, props in mats:
        slots: dict[str, str] = {}
        for prop, guid in props.items():
            slot = _MAT_SLOTS.get(prop)
            base = res(guid)
            if slot and base:
                slots.setdefault(slot, base)
        if slots:
            by_name[mname.lower()] = slots
        main = res(props.get("_MainTex", ""))
        if main:
            main_use[main] = main_use.get(main, 0) + 1
            bm = res(props.get("_BumpMap", "")) or res(props.get("_NormalMap", ""))
            if bm:
                pair_normal.setdefault(main, bm)
    default_map = max(main_use, key=main_use.get) if main_use else None
    result: dict[str, dict] = {}
    guessed: list[str] = []
    for fmat in _fbx_material_names(fbx_bytes):
        hit = by_name.get(fmat.lower())
        if hit:
            result[fmat] = dict(hit)
        elif default_map:
            d = {"map": default_map}
            if pair_normal.get(default_map):
                d["normalMap"] = pair_normal[default_map]
            result[fmat] = d
            guessed.append(fmat)
    return result, guessed


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Extract a Unity .unitypackage into a loadable model folder.")
    ap.add_argument("package", help="path to the .unitypackage")
    ap.add_argument("--name", help="model id / folder name under models/ (default: from package name)")
    ap.add_argument("--out", help="output dir (default: models/<name>)")
    ap.add_argument("--tree", action="store_true", help="reconstruct the full Assets/ tree instead of a flat model")
    ap.add_argument("--register", action="store_true", help="add the result to models.json")
    args = ap.parse_args(argv)

    pkg = args.package
    if not os.path.isfile(pkg):
        print(f"not a file: {pkg}", file=sys.stderr)
        return 2

    name = _slug(args.name or os.path.splitext(os.path.basename(pkg))[0])
    out = args.out or os.path.join(MODELS_DIR, name)

    if args.tree:
        n = extract_tree(pkg, out)
        print(f"extracted {n} assets -> {out}")
        return 0

    info = extract_model(pkg, out)
    print(f"\nmodel '{name}' -> {info['out_dir']}")
    print(f"  meshes ({len(info['meshes'])}): {', '.join(info['meshes']) or '(none!)'}")
    print(f"  textures ({len(info['textures'])}): {', '.join(info['textures']) or '(none)'}")
    if info["unloadable_textures"]:
        print(f"  ! cannot load in-browser (convert to png): {', '.join(info['unloadable_textures'])}")
    if info["collisions"]:
        print(f"  ! {len(info['collisions'])} basename collision(s):")
        for c in info["collisions"]:
            print(f"      {c}")
    if not info["primary"]:
        print("  ! no mesh found — is this an avatar package?", file=sys.stderr)
        return 1
    mesh_rel = f"./models/{name}/{info['primary']}"
    print(f"\n  -> load with: {mesh_rel}")
    if info["primary"].lower().endswith(".fbx"):
        # FBX carries no embedded textures (Unity binds them via .mat) → emit a
        # sidecar so the overlay re-attaches them by material name.
        try:
            fbx_bytes = open(os.path.join(out, info["primary"]), "rb").read()
            mat_map, guessed = build_material_map(pkg, fbx_bytes, info.get("renamed"))
            if mat_map:
                with open(os.path.join(out, "materials.json"), "w", encoding="utf-8") as f:
                    json.dump(mat_map, f, indent=2)
                msg = f"  materials.json: bound {len(mat_map)} material(s) from .mat files"
                if guessed:
                    msg += f"; guessed skin for {guessed} (edit materials.json if wrong)"
                print(msg)
        except Exception as exc:
            print(f"  (materials.json skipped: {exc})")
    if args.register:
        _register(name, mesh_rel)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
