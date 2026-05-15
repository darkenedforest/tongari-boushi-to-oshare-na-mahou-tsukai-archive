"""Build the site's public/images/ + manifest.json from validated source PNGs.

Single source of truth for what images ship on the archive site. Run anytime
the source images or DB labels change — this regenerates everything
deterministically and idempotently. No hand-copies, no one-off scripts.

USAGE
    python scripts/build_site_assets.py

WHAT IT DOES
    1. For each CATEGORY below, finds matching source PNGs.
    2. Copies them into public/images/2d/<category>/<id>.png with stable ids.
    3. Looks up the JP/EN label from the translation project's DB where applicable.
    4. Rewrites public/data/manifest.json with one record per shipped image.

CATEGORIES
    Only includes categories whose source PNGs have been visually validated.
    To add a new category later: add an entry to CATEGORIES, ensure the source
    folder exists, re-run. Do NOT hand-edit public/images/ or manifest.json.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

SITE = Path(__file__).resolve().parent.parent
TRANSLATION_REPO = SITE.parent / "Tongari boushi translation app claude"
DB_PATH = TRANSLATION_REPO / "extracted" / "scratch" / "db" / "translation.sqlite"
SITE_BASE = "/tongari-boushi-to-oshare-na-mahou-tsukai-archive"
IMAGES_ROOT = SITE / "public" / "images" / "2d"
MANIFEST_PATH = SITE / "public" / "data" / "manifest.json"


def load_tile_labels(conn) -> dict[int, tuple[str | None, str | None]]:
    rows = conn.execute(
        "SELECT slot_index, jp_name, en_name FROM magic_glyphs"
    ).fetchall()
    return {r[0]: (r[1], r[2]) for r in rows}


def load_item_labels(conn) -> dict[int, tuple[str | None, str | None]]:
    rows = conn.execute(
        "SELECT item_id, jp_name, en_name FROM item_names"
    ).fetchall()
    return {r[0]: (r[1], r[2]) for r in rows}


def build_language_tiles(records: list[dict]) -> int:
    """Category 1: magic-glyph keyboard buttons. Source = mgcall.ofs NCGR
    inner index N maps 1:1 to language_tiles.slot_index N (verified)."""
    # Source: 2d/inputmagic/mgcall.ofs renders. Filename is mgc01_id<asset_id>_ncgr<N>.png.
    # The ncgr number maps 1:1 to language_tiles.slot_index. Validated 2026-05-15.
    src_dir = TRANSLATION_REPO / "notes" / "2d_assets_v2" / "magic_glyphs" / "2d" / "inputmagic"
    dst_dir = IMAGES_ROOT / "language_tiles"
    dst_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    labels = load_tile_labels(conn)
    conn.close()
    # 8 prefixes in this folder (mgc01, mgc02, ..., mgc09b). Each is a
    # separate page of glyphs and each independently numbers from idx 0.
    # The DB labels were validated against mgc01 only — other prefixes get
    # neutral page-tagged labels.
    pattern = re.compile(r"^(mgc[0-9a-z]+)_id\d+_ncgr(\d+)\.png$")
    added = 0
    for fn in sorted(os.listdir(src_dir)):
        m = pattern.match(fn)
        if not m:
            continue
        prefix, idx = m.group(1), int(m.group(2))
        if prefix == "mgc01":
            jp, en = labels.get(idx, (None, None))
            if en is None:
                en = f"Tile #{idx}"
        else:
            jp, en = None, f"Tile ({prefix} #{idx})"
        out_name = f"{prefix}_{idx}.png"
        dst = dst_dir / out_name
        shutil.copyfile(src_dir / fn, dst)
        records.append({
            "png_path": f"{SITE_BASE}/images/2d/language_tiles/{out_name}",
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


def build_item_icons(records: list[dict]) -> int:
    """Category 2: item icons from itemicon.ofs. NCGR index -> item_id mapping
    is NOT yet known (investigation pending), so labels are generic 'Item #N'."""
    # Source filename is itemicon_<3-digit-N>.png where N is the NCGR inner index.
    src_dir = TRANSLATION_REPO / "notes" / "2d_assets_v2" / "item_icons"
    dst_dir = IMAGES_ROOT / "item_icons"
    dst_dir.mkdir(parents=True, exist_ok=True)
    pattern = re.compile(r"^itemicon_(\d+)\.png$")
    added = 0
    for fn in sorted(os.listdir(src_dir)):
        m = pattern.match(fn)
        if not m:
            continue
        idx = int(m.group(1) or m.group(2))
        dst = dst_dir / f"{idx}.png"
        shutil.copyfile(src_dir / fn, dst)
        records.append({
            "png_path": f"{SITE_BASE}/images/2d/item_icons/{idx}.png",
            "source_container": "item/itemicon.ofs",
            "category": "item_icon",
            "ncgr_inner_index": idx,
            "label_en": f"Item #{idx}",
            "label_jp": None,
            "palette_strategy": "external_item_icon",
            "needs_remap": True,
        })
        added += 1
    print(f"  item_icon: {added}")
    return added


def build_title_castles(records: list[dict]) -> int:
    """Category 3: 5 title-screen castle BGs from title_pack.ofs sub-blobs.
    sub0=day, sub1=dawn, sub2=dusk, sub3=night, sub4=stylised."""
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
        dst = dst_dir / f"{name}.png"
        shutil.copyfile(src, dst)
        records.append({
            "png_path": f"{SITE_BASE}/images/2d/title_castle/{name}.png",
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


def build_classroom_cards(records: list[dict]) -> int:
    """Category 4: classroom / pic2d tutorial cards. These were re-validated
    after the agent's earlier fix (NCGR-NSCR pairing across the full container).
    Source filename pattern: pic2d__ncgr<N>_nclr<M>_nscr<K>.png."""
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
        dst = dst_dir / f"{idx}.png"
        shutil.copyfile(src_dir / fn, dst)
        records.append({
            "png_path": f"{SITE_BASE}/images/2d/classroom_card/{idx}.png",
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

    # Clean slate — wipe and regenerate everything under public/images/2d/
    if IMAGES_ROOT.exists():
        shutil.rmtree(IMAGES_ROOT)
    IMAGES_ROOT.mkdir(parents=True)

    records: list[dict] = []
    print("Building site assets:")
    build_language_tiles(records)
    build_item_icons(records)
    build_title_castles(records)
    build_classroom_cards(records)

    # Sort by category then index for stable manifest
    records.sort(key=lambda r: (r["category"], r.get("page_prefix", ""), r["ncgr_inner_index"]))

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)

    print(f"\nTotal manifest records: {len(records)}")
    print(f"Wrote: {MANIFEST_PATH}")


if __name__ == "__main__":
    main()
