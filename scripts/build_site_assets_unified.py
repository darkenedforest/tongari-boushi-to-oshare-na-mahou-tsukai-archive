"""Unified site build script — consumes the grading agent's master manifest
at notes/2d_assets_v4/_site_build_input.json instead of bespoke per-category
functions.

This is the post-master-manifest rewrite (cycle 15+). Replaces the prior
bespoke 4-category build with a manifest-driven ingest that pulls 32,515
records across 64+ categories with 40%+ real-label coverage.

Schema of source:
    { summary: {...},
      records: [
        { id, category, category_display, kind: "2d"|"3d",
          png_path, thumb_path, thumb_path_128,
          label_en, label_jp, label_source,
          gltf_path?, extra: { triangle_count, has_animations, ... } }
      ] }

Outputs:
    public/images/2d/<category>/<id>.png         — 2D originals
    public/images/3d/<category>/<id>.png         — 3D thumbnails
    public/3d/<category>/<id>.gltf               — 3D glTF files
    public/data/manifest.json                    — 2D AssetGallery input
    public/data/3d-manifest.json                 — ThreeViewer input
    public/data/version.json                     — build version sidecar

Cache-busting:
    Every output path carries ?v=<build_ts> in the manifest. Manifest itself
    is fetched with ?cb=Date.now() by the gallery components.
"""
from __future__ import annotations

import json
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
SRC_INPUT = TRANSLATION_REPO / "notes" / "2d_assets_v4" / "_site_build_input.json"
SITE_BASE = "/tongari-boushi-to-oshare-na-mahou-tsukai-archive"
PUBLIC = SITE / "public"


def main():
    if not SRC_INPUT.exists():
        sys.exit(f"Master manifest not found at {SRC_INPUT}")

    v = str(int(time.time()))
    print(f"Build version: {v}")

    data = json.loads(SRC_INPUT.read_text(encoding="utf-8"))
    records = data.get("records") or []
    print(f"Source: {len(records)} records, summary: {data.get('summary', {})}")

    # Clean slate for the asset trees
    for sub in ("images/2d", "images/3d", "3d"):
        p = PUBLIC / sub
        if p.exists():
            shutil.rmtree(p)
        p.mkdir(parents=True)

    out_2d: list[dict] = []
    out_3d: list[dict] = []
    skipped_missing = 0
    skipped_unknown_kind = 0

    for r in records:
        kind = r.get("kind")
        sid = r.get("id")
        cat = r.get("category")
        if not (sid and cat):
            continue

        png_rel = r.get("png_path") or ""
        png_src = TRANSLATION_REPO / png_rel

        if not png_src.exists():
            skipped_missing += 1
            continue

        ext = ".png"
        if kind == "2d":
            dst_dir = PUBLIC / "images" / "2d" / cat
            dst_dir.mkdir(parents=True, exist_ok=True)
            dst = dst_dir / f"{sid}{ext}"
            shutil.copyfile(png_src, dst)
            out_2d.append({
                "png_path": f"{SITE_BASE}/images/2d/{cat}/{sid}{ext}?v={v}",
                "source_container": (r.get("extra") or {}).get("source_container", "") or r.get("source_container", ""),
                "category": cat,
                "category_display": r.get("category_display", cat),
                "ncgr_inner_index": (r.get("extra") or {}).get("ncgr_inner_index", 0),
                "label_en": r.get("label_en") or None,
                "label_jp": r.get("label_jp") or None,
                "label_source": r.get("label_source"),
                "palette_strategy": r.get("label_source"),
            })
        elif kind == "3d":
            # Copy thumbnail (this is the png_path for 3D records)
            thumb_dir = PUBLIC / "images" / "3d" / cat
            thumb_dir.mkdir(parents=True, exist_ok=True)
            thumb_dst = thumb_dir / f"{sid}.png"
            shutil.copyfile(png_src, thumb_dst)
            # Copy glTF if present
            gltf_rel = r.get("gltf_path") or ""
            gltf_url = None
            if gltf_rel:
                gltf_src = TRANSLATION_REPO / gltf_rel
                if gltf_src.exists():
                    gltf_dir = PUBLIC / "3d" / cat
                    gltf_dir.mkdir(parents=True, exist_ok=True)
                    gltf_dst = gltf_dir / f"{sid}.gltf"
                    shutil.copyfile(gltf_src, gltf_dst)
                    gltf_url = f"{SITE_BASE}/3d/{cat}/{sid}.gltf?v={v}"
            extra = r.get("extra") or {}
            out_3d.append({
                "name": sid,
                "category": cat,
                "category_display": r.get("category_display", cat),
                "source_container": extra.get("source_container", ""),
                "gltf_path": gltf_url,
                "thumb_path": f"{SITE_BASE}/images/3d/{cat}/{sid}.png?v={v}",
                "triangle_count": extra.get("triangle_count"),
                "has_animations": extra.get("has_animations", False),
                "label_en": r.get("label_en") or None,
                "label_jp": r.get("label_jp") or None,
                "label_source": r.get("label_source"),
            })
        else:
            skipped_unknown_kind += 1

    out_2d.sort(key=lambda r: (r["category"], r["png_path"]))
    out_3d.sort(key=lambda r: (r["category"], r["name"]))

    (PUBLIC / "data").mkdir(parents=True, exist_ok=True)
    (PUBLIC / "data" / "manifest.json").write_text(
        json.dumps(out_2d, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (PUBLIC / "data" / "3d-manifest.json").write_text(
        json.dumps(out_3d, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (PUBLIC / "data" / "version.json").write_text(
        json.dumps({"version": v, "built": int(time.time())}),
        encoding="utf-8",
    )

    print(f"\n2D records: {len(out_2d)}")
    print(f"3D records: {len(out_3d)}")
    if skipped_missing:
        print(f"Skipped (file missing on disk): {skipped_missing}")
    if skipped_unknown_kind:
        print(f"Skipped (unknown kind): {skipped_unknown_kind}")

    # Breakdown
    import collections
    print("\n2D by category:")
    for k, n in sorted(collections.Counter(r["category"] for r in out_2d).items(), key=lambda x: -x[1])[:30]:
        print(f"  {k}: {n}")
    print("\n3D by category:")
    for k, n in sorted(collections.Counter(r["category"] for r in out_3d).items(), key=lambda x: -x[1])[:30]:
        print(f"  {k}: {n}")

    # Label coverage
    real_sources = {"item_names_db", "magic_glyphs_db", "shopitem_walk_db", "npc_speaker_canonical",
                    "spell_glyph_table", "descriptive_visual", "crosslink_propagated", "sibling_propagated"}
    real_2d = sum(1 for r in out_2d if r.get("label_source") in real_sources)
    real_3d = sum(1 for r in out_3d if r.get("label_source") in real_sources)
    total = len(out_2d) + len(out_3d)
    if total:
        print(f"\nLabel coverage: {real_2d + real_3d}/{total} = "
              f"{(real_2d + real_3d) / total * 100:.1f}% real-source")


if __name__ == "__main__":
    main()
