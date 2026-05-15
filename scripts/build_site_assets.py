"""Build the site's public/images/2d/ + public/data/manifest.json.

Four categories with their established labels (don't break what works):

  language_tile    823 mgcall keyboard buttons. JP/EN labels come from the
                   translation DB's `magic_glyphs` table by slot_index. 377
                   real labels + 446 fallback "Tile #N". Source folder:
                   notes/2d_assets_v2/magic_glyphs/2d/inputmagic/

  item_icon        656 item icons from itemicon.ofs renders. Generic
                   "Item #N" labels for now — the runtime ItemNoList.itnt
                   mapping is cracked but the full item-name join isn't
                   wired up yet (TODO). Source folder:
                   notes/2d_assets_v2/item_icons/

  title_castle     5 title-screen castle variants (day/dawn/dusk/night/
                   stylised). Hand-named. Source folder:
                   notes/2d_assets/2d/mainmenu/

  classroom_card   450 pic2d backgrounds (classroom UI, sign-design tool,
                   spell-name title cards). Generic "Classroom card #N"
                   labels. Source folder: notes/2d_assets/2d/

Cache-busting: every png_path carries ?v=<build_timestamp>; manifest.json
itself is fetched with ?cb=Date.now() by the AssetGallery component so
it's never served stale.

Run anytime source images or DB labels change:
    python scripts/build_site_assets.py

Do NOT hand-edit public/images/ or manifest.json — they're regenerated.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

SITE = Path(__file__).resolve().parent.parent
TRANSLATION_REPO = SITE.parent / "Tongari boushi translation app claude"
DB_PATH = TRANSLATION_REPO / "extracted" / "scratch" / "db" / "translation.sqlite"
SITE_INGEST = TRANSLATION_REPO / "notes" / "2d_assets_v4" / "_SITE_INGEST.json"
SITE_BASE = "/tongari-boushi-to-oshare-na-mahou-tsukai-archive"
IMAGES_ROOT = SITE / "public" / "images" / "2d"
MANIFEST_PATH = SITE / "public" / "data" / "manifest.json"


def load_item_label_map() -> dict[int, tuple[str | None, str | None]]:
    """Map icon_idx -> (label_jp, label_en) using the visual-grading agent's
    _SITE_INGEST.json, which joined icon_idx -> item_id -> item_names DB.
    Returns {} if file missing."""
    if not SITE_INGEST.exists():
        return {}
    data = json.loads(SITE_INGEST.read_text(encoding="utf-8"))
    out: dict[int, tuple[str | None, str | None]] = {}
    for r in data:
        if r.get("category") != "item_icon":
            continue
        ek = r.get("element_key")
        if not ek or len(ek) < 2 or not isinstance(ek[1], int):
            continue
        idx = ek[1]
        jp = (r.get("label_jp") or "").strip() or None
        en = (r.get("label_en") or "").strip() or None
        if jp or en:
            out[idx] = (jp, en)
    return out


def load_glyph_labels(conn) -> dict[int, tuple[str | None, str | None]]:
    rows = conn.execute(
        "SELECT slot_index, jp_name, en_name FROM magic_glyphs"
    ).fetchall()
    return {r[0]: (r[1], r[2]) for r in rows}


def build_language_tiles(records: list[dict], v: str) -> int:
    """Category 1: 823 mgcall keyboard tiles. 8 prefixes in this folder.
    `mgcall` is the full keyboard — its NCGR inner index maps 1:1 to the
    magic_glyphs DB slot_index (377 rows have labels; the rest fall back to
    'Tile #N'). The other 7 prefixes are sub-pages and ship as 'Tile
    (mgcXX #N)' without DB labels."""
    src_dir = TRANSLATION_REPO / "notes" / "2d_assets_v2" / "magic_glyphs" / "2d" / "inputmagic"
    dst_dir = IMAGES_ROOT / "language_tile"
    dst_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    labels = load_glyph_labels(conn)
    conn.close()
    pattern = re.compile(r"^(mgc[0-9a-z]+)_id\d+_ncgr(\d+)\.png$")
    added = 0
    for fn in sorted(os.listdir(src_dir)):
        m = pattern.match(fn)
        if not m:
            continue
        prefix, idx = m.group(1), int(m.group(2))
        if prefix == "mgcall":
            jp, en = labels.get(idx, (None, None))
            if en is None:
                en = f"Tile #{idx}"
        else:
            jp, en = None, f"Tile ({prefix} #{idx})"
        out_name = f"{prefix}_{idx}.png"
        shutil.copyfile(src_dir / fn, dst_dir / out_name)
        records.append({
            "png_path": f"{SITE_BASE}/images/2d/language_tile/{out_name}?v={v}",
            "source_container": f"2d/inputmagic/{prefix}.ofs",
            "category": "language_tile",
            "ncgr_inner_index": idx,
            "page_prefix": prefix,
            "label_en": en,
            "label_jp": jp,
            "palette_strategy": "external_language_tile",
        })
        added += 1
    print(f"  language_tile: {added}")
    return added


def build_item_icons(records: list[dict], v: str) -> int:
    """Category 2: 656 item icons. Source filename: itemicon_<3-digit>.png
    where N is the NCGR inner index = icon_idx. Real JP/EN names come from
    the visual-grading agent's _SITE_INGEST.json which joined icon_idx ->
    item_id via the cracked ItemNoList.itnt formula -> item_names DB. 454
    of 656 get proper names; the rest fall back to 'Item #N'."""
    src_dir = TRANSLATION_REPO / "notes" / "2d_assets_v2" / "item_icons"
    dst_dir = IMAGES_ROOT / "item_icon"
    dst_dir.mkdir(parents=True, exist_ok=True)
    pattern = re.compile(r"^itemicon_(\d+)\.png$")
    label_map = load_item_label_map()
    labeled = 0
    added = 0
    for fn in sorted(os.listdir(src_dir)):
        m = pattern.match(fn)
        if not m:
            continue
        idx = int(m.group(1))
        shutil.copyfile(src_dir / fn, dst_dir / f"{idx}.png")
        jp, en = label_map.get(idx, (None, None))
        if en is None:
            en = f"Item #{idx}"
        else:
            labeled += 1
        records.append({
            "png_path": f"{SITE_BASE}/images/2d/item_icon/{idx}.png?v={v}",
            "source_container": "item/itemicon.ofs",
            "category": "item_icon",
            "ncgr_inner_index": idx,
            "label_en": en,
            "label_jp": jp,
            "palette_strategy": "external_item_icon",
        })
        added += 1
    print(f"  item_icon: {added} ({labeled} with real item names from ItemNoList.itnt join)")
    return added


def build_title_castles(records: list[dict], v: str) -> int:
    """Category 3: 5 title-screen castle BGs. sub00..sub04 = day, dawn,
    dusk, night, stylised."""
    src_dir = TRANSLATION_REPO / "notes" / "2d_assets" / "2d" / "mainmenu"
    dst_dir = IMAGES_ROOT / "title_castle"
    dst_dir.mkdir(parents=True, exist_ok=True)
    variants = [
        ("day", "title_pack_sub00__ncgr3_nclr4_nscr5.png"),
        ("dawn", "title_pack_sub01__ncgr3_nclr4_nscr5.png"),
        ("dusk", "title_pack_sub02__ncgr3_nclr4_nscr5.png"),
        ("night", "title_pack_sub03__ncgr3_nclr4_nscr5.png"),
        ("stylised", "title_pack_sub04__ncgr3_nclr4_nscr5.png"),
    ]
    added = 0
    for name, fn in variants:
        src = src_dir / fn
        if not src.exists():
            continue
        shutil.copyfile(src, dst_dir / f"{name}.png")
        records.append({
            "png_path": f"{SITE_BASE}/images/2d/title_castle/{name}.png?v={v}",
            "source_container": "2d/mainmenu/title_pack.ofs",
            "category": "title_castle",
            "ncgr_inner_index": 3,
            "label_en": f"Title screen ({name})",
            "label_jp": None,
            "palette_strategy": "sibling",
        })
        added += 1
    print(f"  title_castle: {added}")
    return added


def build_btx0_clothing(records: list[dict], v: str) -> int:
    """Category 5: clothing textures decoded from BTX0 (NSBTX) — the
    same texture that wraps the 3D mannequin IS the 2D inventory icon.
    Source: notes/2d_assets_v3/clothing_textures/<subcat>/<NNNN>__<src>.png.
    Subcategories: plcloth_u (tops), plcloth_d (bottoms), plhat, plshoes,
    plglasses, plhair, plface."""
    src_root = TRANSLATION_REPO / "notes" / "2d_assets_v3" / "clothing_textures"
    if not src_root.exists():
        print("  clothing: source folder missing, skipping")
        return 0
    subcats = {
        "plcloth_u": ("clothing_top", "Top"),
        "plcloth_d": ("clothing_bottom", "Bottom"),
        "plhat":     ("clothing_hat", "Hat"),
        "plshoes":   ("clothing_shoes", "Shoes"),
        "plglasses": ("clothing_glasses", "Glasses"),
        "plhair":    ("clothing_hair", "Hair"),
        "plface":    ("face_texture", "Face"),
    }
    total = 0
    pat = re.compile(r"^(\d+)__(.+)\.png$")
    for subdir, (cat, label_word) in subcats.items():
        src_dir = src_root / subdir
        if not src_dir.exists():
            continue
        dst_dir = IMAGES_ROOT / cat
        dst_dir.mkdir(parents=True, exist_ok=True)
        added = 0
        for fn in sorted(os.listdir(src_dir)):
            m = pat.match(fn)
            if not m:
                continue
            idx, src_tag = int(m.group(1)), m.group(2)
            out_name = f"{src_tag}_{idx:04d}.png"
            shutil.copyfile(src_dir / fn, dst_dir / out_name)
            records.append({
                "png_path": f"{SITE_BASE}/images/2d/{cat}/{out_name}?v={v}",
                "source_container": f"model/player/tex/{subdir}.ofs",
                "category": cat,
                "ncgr_inner_index": idx,
                "label_en": f"{label_word} #{idx}",
                "label_jp": None,
                "palette_strategy": "btx0_decoded",
            })
            added += 1
        if added:
            print(f"  {cat}: {added}")
        total += added
    return total


def build_btx0_explicit_icons(records: list[dict], v: str) -> int:
    """Category 6: developer-named inventory icons (icon_* / item_*) from
    BTX0 texture dicts. 413 textures the devs explicitly designated as
    inventory icons (icon_gomi=trash, icon_tane=seed, icon_kessyo=crystal,
    etc.)."""
    src_root = TRANSLATION_REPO / "notes" / "2d_assets_v3" / "inventory_icons_explicit"
    if not src_root.exists():
        print("  inventory_icon: source folder missing, skipping")
        return 0
    dst_dir = IMAGES_ROOT / "inventory_icon"
    dst_dir.mkdir(parents=True, exist_ok=True)
    added = 0
    # Each subdir matches the source-container origin (Tshop, Troom, etc.)
    for subdir in sorted(p for p in src_root.iterdir() if p.is_dir()):
        for fn in sorted(os.listdir(subdir)):
            if not fn.endswith(".png"):
                continue
            # Filename pattern: <NNNN>__<texname>.png
            base = fn.removesuffix(".png")
            if "__" not in base:
                continue
            idx_s, texname = base.split("__", 1)
            try:
                idx = int(idx_s)
            except ValueError:
                continue
            out_name = f"{subdir.name}_{texname}_{idx:04d}.png"
            shutil.copyfile(subdir / fn, dst_dir / out_name)
            records.append({
                "png_path": f"{SITE_BASE}/images/2d/inventory_icon/{out_name}?v={v}",
                "source_container": f"model/.../{subdir.name}.ofs",
                "category": "inventory_icon",
                "ncgr_inner_index": idx,
                "label_en": texname,  # Developer's own designation
                "label_jp": None,
                "palette_strategy": "btx0_decoded",
            })
            added += 1
    print(f"  inventory_icon: {added}")
    return added


def build_magazine_pages(records: list[dict], v: str) -> int:
    """Category: 513 in-game magazine pages with proper BG composition.
    Source: notes/2d_assets_v4/__magazine_pages_v3/MG<NN>/page_<NN>.png.
    Each MG##.ofs is one magazine issue (61 issues total), each holds
    multiple pages composited with magpage.ofs master NSCRs."""
    src_root = TRANSLATION_REPO / "notes" / "2d_assets_v4" / "__magazine_pages_v3"
    if not src_root.exists():
        print("  magazine_page: source folder missing, skipping")
        return 0
    dst_dir = IMAGES_ROOT / "magazine_page"
    dst_dir.mkdir(parents=True, exist_ok=True)
    added = 0
    issue_pat = re.compile(r"^MG(\d+)$")
    page_pat = re.compile(r"^page_(\d+)\.png$")
    for issue_dir in sorted(src_root.iterdir()):
        if not issue_dir.is_dir():
            continue
        m = issue_pat.match(issue_dir.name)
        if not m:
            continue
        issue_num = int(m.group(1))
        for fn in sorted(os.listdir(issue_dir)):
            pm = page_pat.match(fn)
            if not pm:
                continue
            page_num = int(pm.group(1))
            out_name = f"MG{issue_num:02d}_page_{page_num:02d}.png"
            shutil.copyfile(issue_dir / fn, dst_dir / out_name)
            records.append({
                "png_path": f"{SITE_BASE}/images/2d/magazine_page/{out_name}?v={v}",
                "source_container": f"magazine/MG{issue_num:02d}.ofs + magpage.ofs",
                "category": "magazine_page",
                "ncgr_inner_index": issue_num * 100 + page_num,
                "label_en": f"Magazine {issue_num} — page {page_num}",
                "label_jp": None,
                "palette_strategy": "nscr_composited",
            })
            added += 1
    print(f"  magazine_page: {added}")
    return added


def build_classroom_cards(records: list[dict], v: str) -> int:
    """Category 4: 450 pic2d backgrounds (classroom UI, sign-design tool,
    spell-title cards). Generic 'Classroom card #N' labels."""
    src_dir = TRANSLATION_REPO / "notes" / "2d_assets" / "2d"
    dst_dir = IMAGES_ROOT / "classroom_card"
    dst_dir.mkdir(parents=True, exist_ok=True)
    pattern = re.compile(r"^pic2d__ncgr(\d+)_nclr\d+_nscr\d+\.png$")
    added = 0
    for fn in sorted(os.listdir(src_dir)):
        m = pattern.match(fn)
        if not m:
            continue
        idx = int(m.group(1))
        shutil.copyfile(src_dir / fn, dst_dir / f"{idx}.png")
        records.append({
            "png_path": f"{SITE_BASE}/images/2d/classroom_card/{idx}.png?v={v}",
            "source_container": "2d/pic2d.ofs",
            "category": "classroom_card",
            "ncgr_inner_index": idx,
            "label_en": f"Classroom card #{idx}",
            "label_jp": None,
            "palette_strategy": "sibling",
        })
        added += 1
    print(f"  classroom_card: {added}")
    return added


def main():
    if not DB_PATH.exists():
        sys.exit(f"DB not found at {DB_PATH}")

    v = str(int(time.time()))
    print(f"Build version: {v}")

    # Clean slate
    if IMAGES_ROOT.exists():
        shutil.rmtree(IMAGES_ROOT)
    IMAGES_ROOT.mkdir(parents=True)

    records: list[dict] = []
    print("Building site assets:")
    build_language_tiles(records, v)
    build_item_icons(records, v)
    build_title_castles(records, v)
    build_classroom_cards(records, v)
    build_magazine_pages(records, v)
    build_btx0_clothing(records, v)
    build_btx0_explicit_icons(records, v)

    records.sort(key=lambda r: (r["category"], r.get("page_prefix", ""), r.get("ncgr_inner_index", 0)))

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(
        json.dumps(records, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (MANIFEST_PATH.parent / "version.json").write_text(
        json.dumps({"version": v, "built": int(time.time())}),
        encoding="utf-8",
    )

    print(f"\nTotal manifest records: {len(records)}")
    print(f"Wrote: {MANIFEST_PATH}")


if __name__ == "__main__":
    main()
