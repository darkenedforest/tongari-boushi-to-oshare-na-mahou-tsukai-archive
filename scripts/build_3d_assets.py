"""Copy the v2 3D export (GLB + thumbnails + texture library + animations)
into the site public tree and write the manifests ThreeViewer reads.

Source (translation repo, produced by src/translator/_3d_export_v2.py and
_3d_animations_v2.py):
    notes/3d_models_v2/_INDEX_v2.json      one record per de-duplicated model
    notes/3d_models_v2/_TEXTURES_v2.json   every companion texture, PNG paths
    notes/3d_models_v2/_ANIMATIONS_v2.json animation sets (optional)
    notes/3d_models_v2/<category>/<id>.glb|.png
    notes/3d_models_v2/textures/<container>/<entry>__<name>.png
    notes/3d_models_v2/anim/<set>.glb

Destination:
    public/3d/<category>/<id>.glb            self-contained (textures packed)
    public/images/3d/<category>/<id>.png     192px thumbnail
    public/3d-tex/<container>/<file>.png     texture library (unique pixels)
    public/3d/anim/<set>.glb                 skeleton-only animation sets
    public/data/3d-manifest.json             lean model list for the grid
    public/data/3d-textures.json             texture pools + per-model slots,
                                             loaded when a model is opened

URLs are built client-side from `base`, `version`, category and id, so the
manifests carry no repeated paths.

Run whenever the export changes:
    python scripts/build_3d_assets.py
"""
from __future__ import annotations

import collections
import json
import re
import shutil
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

SITE = Path(__file__).resolve().parent.parent
TRANSLATION_REPO = SITE.parent / "Tongari boushi translation app claude"
SRC_ROOT = TRANSLATION_REPO / "notes" / "3d_models_v2"
SRC_INDEX = SRC_ROOT / "_INDEX_v2.json"
SRC_TEXTURES = SRC_ROOT / "_TEXTURES_v2.json"
SRC_ANIMS = SRC_ROOT / "_ANIMATIONS_v2.json"

SITE_BASE = "/tongari-boushi-to-oshare-na-mahou-tsukai-archive"
GLTF_DST = SITE / "public" / "3d"
THUMB_DST = SITE / "public" / "images" / "3d"
TEX_DST = SITE / "public" / "3d-tex"
MANIFEST_PATH = SITE / "public" / "data" / "3d-manifest.json"
TEX_MANIFEST_PATH = SITE / "public" / "data" / "3d-textures.json"

CATEGORY_TITLES = {
    "clothing": "Player avatars",
    "npc": "Townsfolk",
    "uma": "Statues & guests",
    "item": "Items & furniture",
    "environment": "Environment",
    "shop": "Shops",
    "creature_fish": "Fish",
    "creature_insect": "Insects",
    "meffect": "Magic effects",
    "ucc": "Crafted items",
    "charmake": "Character creation",
    "magazine": "Magazines",
    "minigame": "Minigames",
    "title": "Title screen",
    "dance": "Dance",
    "other": "Other",
}

PLAYER_BONES = {"root", "chest", "l_shoulder", "l_elbow", "neck", "mouse",
                "r_shoulder", "r_elbow", "r_hand", "hip", "l_knee", "r_knee"}

# Containers whose entries are interchangeable for one model (a wardrobe):
# any avatar can wear any top, any room can take any wallpaper, any shop
# front any door or sign. Everywhere else a model's alternatives are the
# textures of its OWN entry (an NPC's eight expressions, an item's LODs),
# not the other models' textures that happen to share the name.
WARDROBE_CONTAINERS = ("model__player__tex__", "Thome.ofs", "pc_kan_door", "pc_kanban_", "Tmanequin")


def pool_key(container: str, name: str, entry) -> str:
    stem = container_stem(container)
    if any(w in stem for w in WARDROBE_CONTAINERS):
        return f"{stem}|{name}"
    return f"{stem}|{name}|{entry}"


def container_stem(container: str) -> str:
    """Same stem the export uses for its textures/<stem>/ folders."""
    s = container.replace("extracted/nds/data/", "").replace("/", "__")
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in s)


def rel_under(prefix: str, p: str) -> str:
    p = p.replace("\\", "/")
    i = p.find(prefix)
    return p[i + len(prefix):] if i >= 0 else p


def player_group(name: str):
    m = re.match(r"^pmd(\d+)_(\d+)_(\d+)$", name)
    if not m:
        return None
    return [int(m.group(1)), int(m.group(2)), int(m.group(3))]


def natural(s: str):
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", s)]


def main() -> None:
    if not SRC_INDEX.exists() or not SRC_TEXTURES.exists():
        sys.exit(f"v2 export not found under {SRC_ROOT}; run _3d_export_v2.py first")
    v = str(int(time.time()))
    index = json.loads(SRC_INDEX.read_text(encoding="utf-8"))
    tex_index = json.loads(SRC_TEXTURES.read_text(encoding="utf-8"))
    anims = json.loads(SRC_ANIMS.read_text(encoding="utf-8")) if SRC_ANIMS.exists() else None
    models = [m for m in index["models"] if not m.get("error")]
    print(f"source: {len(models)} models ({index.get('errors', 0)} export errors skipped), "
          f"{tex_index['texture_count']} textures ({tex_index['unique_png_count']} unique)")

    for d in (GLTF_DST, THUMB_DST, TEX_DST):
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)

    # --- texture library: unique PNGs, pooled by (container, name) ---
    pools: dict[str, list[dict]] = collections.defaultdict(list)
    copied: dict[str, str] = {}      # source rel -> path under 3d-tex/
    for t in tex_index["textures"]:
        src_rel = rel_under("notes/3d_models_v2/", t["png"])
        if src_rel not in copied:
            src = SRC_ROOT / src_rel
            if not src.exists():
                continue
            under = rel_under("textures/", src_rel)
            dst = TEX_DST / under
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            copied[src_rel] = under
        key = pool_key(t["container"], t["name"], t["entry"])
        pools[key].append({"e": t["entry"], "l": t["lod"], "w": t["width"], "h": t["height"],
                           "f": copied[src_rel], "px": t["pixels"]})
    pool_list: list[dict] = []
    pool_index: dict[str, int] = {}
    for key in sorted(pools):
        seen = set()
        items = []
        for it in sorted(pools[key], key=lambda x: (x["e"], x["l"] or 0)):
            if it["px"] in seen:
                continue
            seen.add(it["px"])
            items.append({k: it[k] for k in ("e", "l", "w", "h", "f")})
        pool_index[key] = len(pool_list)
        pool_list.append({"key": key, "items": items})

    # --- models ---
    out = []
    slots_by_id: dict[str, list] = {}
    skipped = 0
    for m in models:
        gltf_rel = rel_under("notes/3d_models_v2/", m["gltf_path"])
        thumb_rel = rel_under("notes/3d_models_v2/", m["thumb_path"])
        gsrc, tsrc = SRC_ROOT / gltf_rel, SRC_ROOT / thumb_rel
        if not gsrc.exists() or not tsrc.exists():
            skipped += 1
            continue
        cat = m["category"]
        gdst = GLTF_DST / cat / f"{m['id']}.glb"
        tdst = THUMB_DST / cat / f"{m['id']}.png"
        gdst.parent.mkdir(parents=True, exist_ok=True)
        tdst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(gsrc, gdst)
        shutil.copyfile(tsrc, tdst)
        slots = []
        for s in m.get("material_slots", []):
            pool = None
            if s.get("source") and s["source"] != "embedded":
                pool = pool_index.get(pool_key(s["source"], s["texture"], s.get("entry")))
            slots.append({"m": s["material"], "t": s["texture"], "w": s["width"], "h": s["height"],
                          "x": 1 if s.get("textured") else 0, "e": s.get("entry"), "l": s.get("lod"),
                          "p": pool})
        slots_by_id[m["id"]] = slots
        aliases = m.get("aliases", [])
        bones = set(m.get("bone_names") or [])
        rec = {
            "id": m["id"],
            "n": m["name"],
            "c": cat,
            "tri": m.get("triangle_count"),
            "b": m.get("bone_count"),
            "tx": m.get("texture_count"),
            "kb": round((m.get("file_bytes") or 0) / 1024),
            "al": len(aliases),
        }
        if aliases:
            rec["an"] = [a["name"] for a in aliases[:12]]
        g = player_group(m["name"])
        if g:
            rec["g"] = g
        if anims and PLAYER_BONES <= bones:
            rec["anim"] = "player"
        out.append(rec)
    order = {c: i for i, c in enumerate(CATEGORY_TITLES)}
    out.sort(key=lambda r: (order.get(r["c"], 99), natural(r["n"])))

    # --- animation sets ---
    anim_sets = []
    if anims:
        (GLTF_DST / "anim").mkdir(parents=True, exist_ok=True)
        for s in anims.get("sets", []):
            src = SRC_ROOT / rel_under("notes/3d_models_v2/", s["glb"])
            if not src.exists():
                continue
            shutil.copyfile(src, GLTF_DST / "anim" / f"{s['id']}.glb")
            anim_sets.append({"id": s["id"], "title": s.get("title", s["id"]), "skeleton": s.get("skeleton", "player"),
                              "clips": s.get("clips", []), "kb": round(src.stat().st_size / 1024)})

    by_cat = collections.Counter(r["c"] for r in out)
    manifest = {
        "version": v,
        "generated": time.strftime("%Y-%m-%d"),
        "base": SITE_BASE,
        "model_count": len(out),
        "alias_count": sum(r["al"] for r in out),
        "categories": [{"id": c, "title": CATEGORY_TITLES.get(c, c), "count": n}
                       for c, n in sorted(by_cat.items(), key=lambda x: order.get(x[0], 99))],
        "anim_sets": anim_sets,
        "models": out,
    }
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    TEX_MANIFEST_PATH.write_text(json.dumps({"version": v, "pools": pool_list, "slots": slots_by_id},
                                            ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"wrote {len(out)} models to {MANIFEST_PATH.name} ({MANIFEST_PATH.stat().st_size // 1024} KB; {skipped} skipped)")
    print(f"wrote {len(pool_list)} texture pools, {len(copied)} PNGs, {len(slots_by_id)} slot lists to "
          f"{TEX_MANIFEST_PATH.name} ({TEX_MANIFEST_PATH.stat().st_size // 1024} KB)")
    print(f"animation sets: {len(anim_sets)}")
    for cat in manifest["categories"]:
        print(f"  {cat['id']}: {cat['count']}")


if __name__ == "__main__":
    main()
