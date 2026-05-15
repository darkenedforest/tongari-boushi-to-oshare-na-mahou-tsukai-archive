"""Build the site's public/images/2d/ + public/data/manifest.json from
the translation repo's v4 ingest manifest.

V4 manifest is the single source of truth — it has health scores,
plausibility, winner-deduplication, validation source per record. This
script consumes it, applies a category whitelist (visually validated),
copies PNGs into the public tree with stable ids, joins on DB labels
where available, and writes one manifest.json the AssetGallery reads.

USAGE
    python scripts/build_site_assets.py

DEFERRED categories (not yet shipped — pending agent corrections):
    item_icon       (raw tilesheets, needs NCER cell decomposition +
                     cracked-formula item-name lookup)
    magazine_page   (needs visual validation of agent's 526 composed pages)
    npc_sprite      (agent corrected 141 to 32x32; ingestion pending)
    clothing        (mixed quality, per-state palette renders pending)
    ucc, horse_event, global_ui, other, event_list (not yet validated)
"""
from __future__ import annotations

import json
import os
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
V4_ROOT = TRANSLATION_REPO / "notes" / "2d_assets_v4"
V4_MANIFEST = V4_ROOT / "_INGEST_MANIFEST.json"
DB_PATH = TRANSLATION_REPO / "extracted" / "scratch" / "db" / "translation.sqlite"

SITE_BASE = "/tongari-boushi-to-oshare-na-mahou-tsukai-archive"
IMAGES_ROOT = SITE / "public" / "images" / "2d"
MANIFEST_PATH = SITE / "public" / "data" / "manifest.json"

# Categories validated visually and ready to ship. See file docstring for
# what's deferred and why.
CATEGORIES_SHIP = {
    "magic_glyph",
    "hair_catalog",
    "bg_screen",
    "animation",
    "design_tool",
    "charmake",
    "title_screen",
    "shop",
    "minigame",
    "ui_window",
}

# ui_window contains a lot of raw tilesheets that look bad as 100px
# thumbnails. Filter to roughly-square or rectangular tiles only.
ASPECT_CAP_CATEGORIES = {"ui_window", "minigame"}


def load_magic_glyph_labels(conn) -> dict[int, tuple[str | None, str | None]]:
    rows = conn.execute(
        "SELECT slot_index, jp_name, en_name FROM magic_glyphs"
    ).fetchall()
    return {r[0]: (r[1], r[2]) for r in rows}


def stable_id(rec: dict) -> str:
    """Generate a stable filename id from element_key + stem."""
    stem = rec["stem"]
    key = rec.get("element_key") or []
    # element_key is [sub, ncgr, nclr, ncer, cell]
    parts = []
    for v in key:
        if v is None:
            parts.append("x")
        else:
            parts.append(str(v))
    return f"{stem}__{'_'.join(parts)}"


def acceptable_aspect(w: int, h: int) -> bool:
    if w <= 0 or h <= 0:
        return False
    ratio = max(w, h) / min(w, h)
    return ratio <= 6.0


def main():
    if not V4_MANIFEST.exists():
        sys.exit(f"V4 manifest not found at {V4_MANIFEST}")
    if not DB_PATH.exists():
        sys.exit(f"DB not found at {DB_PATH}")

    records_v4 = json.loads(V4_MANIFEST.read_text(encoding="utf-8"))
    print(f"V4 manifest: {len(records_v4)} records")

    conn = sqlite3.connect(DB_PATH)
    glyph_labels = load_magic_glyph_labels(conn)
    conn.close()

    # Clean slate
    if IMAGES_ROOT.exists():
        shutil.rmtree(IMAGES_ROOT)
    IMAGES_ROOT.mkdir(parents=True)

    out_records: list[dict] = []
    counts: dict[str, int] = {}
    skipped: dict[str, int] = {}

    for r in records_v4:
        cat = r.get("category")
        if cat not in CATEGORIES_SHIP:
            skipped[cat or "?"] = skipped.get(cat or "?", 0) + 1
            continue
        if not r.get("is_winner"):
            continue
        if not r.get("ship_by_default"):
            continue
        if cat in ASPECT_CAP_CATEGORIES and not acceptable_aspect(
            r.get("w", 0), r.get("h", 0)
        ):
            continue

        src_rel = r["png_path"]  # relative inside V4_ROOT
        src_abs = V4_ROOT / src_rel
        if not src_abs.exists():
            continue

        sid = stable_id(r)
        dst_dir = IMAGES_ROOT / cat
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / f"{sid}.png"
        shutil.copyfile(src_abs, dst)

        # Labels
        label_jp = None
        label_en = None
        if cat == "magic_glyph" and "mgcall" in (r.get("source_container") or ""):
            key = r.get("element_key") or []
            ncgr_idx = key[1] if len(key) > 1 and isinstance(key[1], int) else None
            if ncgr_idx is not None and ncgr_idx in glyph_labels:
                label_jp, label_en = glyph_labels[ncgr_idx]

        out_records.append({
            "png_path": f"{SITE_BASE}/images/2d/{cat}/{sid}.png",
            "source_container": r.get("source_container", ""),
            "category": cat,
            "ncgr_inner_index": (
                (r.get("element_key") or [None, None])[1]
                if isinstance((r.get("element_key") or [None, None])[1], int)
                else 0
            ),
            "label_en": label_en,
            "label_jp": label_jp,
            "width": r.get("w"),
            "height": r.get("h"),
            "palette_strategy": r.get("validation_source") or "v4_ingest",
        })
        counts[cat] = counts.get(cat, 0) + 1

    out_records.sort(key=lambda r: (r["category"], r["png_path"]))
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(
        json.dumps(out_records, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"\nWrote {len(out_records)} records to {MANIFEST_PATH.name}")
    print("\nShipped by category:")
    for c, n in sorted(counts.items(), key=lambda x: -x[1]):
        print(f"  {c}: {n}")
    print(f"\nDeferred categories (skipped):")
    for c, n in sorted(skipped.items(), key=lambda x: -x[1]):
        print(f"  {c}: {n}")


if __name__ == "__main__":
    main()
