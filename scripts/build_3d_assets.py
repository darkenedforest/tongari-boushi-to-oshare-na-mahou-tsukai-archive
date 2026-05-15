"""Copy the 3D model agent's outputs (glTF + thumbnails) into the site
public tree and write public/data/3d-manifest.json that the ThreeViewer
component reads.

Source: notes/3d_models_gltf/ in the translation repo, populated by the
NSBMD→glTF agent. Each record has gltf_path + thumb_path pointing into
that source tree; we rewrite both to URL-relative paths under the site
base.

Run anytime the 3D agent has emitted new outputs:
    python scripts/build_3d_assets.py
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
SRC_ROOT = TRANSLATION_REPO / "notes" / "3d_models_gltf"
SRC_MANIFEST = SRC_ROOT / "_SITE_MANIFEST.json"

SITE_BASE = "/tongari-boushi-to-oshare-na-mahou-tsukai-archive"
GLTF_DST = SITE / "public" / "3d"
THUMB_DST = SITE / "public" / "images" / "3d"
MANIFEST_PATH = SITE / "public" / "data" / "3d-manifest.json"


def _rel_under(prefix: str, p: str) -> str:
    """Strip the source-prefix from a path coming out of the agent manifest."""
    p = p.replace("\\", "/")
    if p.startswith(prefix):
        return p[len(prefix):].lstrip("/")
    # Some agent records have the absolute prefix; strip "notes/3d_models_gltf/"
    needle = "notes/3d_models_gltf/"
    i = p.find(needle)
    if i >= 0:
        return p[i + len(needle):]
    return p


def main():
    if not SRC_MANIFEST.exists():
        sys.exit(f"3D site manifest not found at {SRC_MANIFEST}")

    v = str(int(time.time()))
    src_records = json.loads(SRC_MANIFEST.read_text(encoding="utf-8"))
    print(f"Source records: {len(src_records)}")

    # Clean slate
    if GLTF_DST.exists():
        shutil.rmtree(GLTF_DST)
    if THUMB_DST.exists():
        shutil.rmtree(THUMB_DST)
    GLTF_DST.mkdir(parents=True)
    THUMB_DST.mkdir(parents=True)

    out_records = []
    skipped_missing = 0

    for r in src_records:
        gltf_rel = _rel_under("notes/3d_models_gltf/", r.get("gltf_path", ""))
        thumb_rel = _rel_under("notes/3d_models_gltf/", r.get("png_path", "") or r.get("thumb_path", ""))
        if not gltf_rel or not thumb_rel:
            skipped_missing += 1
            continue

        gltf_src = SRC_ROOT / gltf_rel
        thumb_src = SRC_ROOT / thumb_rel
        if not gltf_src.exists() or not thumb_src.exists():
            skipped_missing += 1
            continue

        gltf_dst = GLTF_DST / gltf_rel
        thumb_dst = THUMB_DST / thumb_rel
        gltf_dst.parent.mkdir(parents=True, exist_ok=True)
        thumb_dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(gltf_src, gltf_dst)
        shutil.copyfile(thumb_src, thumb_dst)

        out_records.append({
            "name": r.get("name", ""),
            "category": r.get("category", "uncategorized"),
            "source_container": r.get("source_container", ""),
            "gltf_path": f"{SITE_BASE}/3d/{gltf_rel}?v={v}",
            "thumb_path": f"{SITE_BASE}/images/3d/{thumb_rel}?v={v}",
            "triangle_count": r.get("triangle_count"),
            "bone_count": r.get("bone_count"),
            "texture_count": r.get("texture_count"),
            "has_animations": bool(r.get("has_animations")),
            "label_en": r.get("label_en") or None,
            "label_jp": r.get("label_jp") or None,
        })

    out_records.sort(key=lambda r: (r["category"], r["name"]))

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(
        json.dumps(out_records, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"\nWrote {len(out_records)} records to {MANIFEST_PATH.name}")
    if skipped_missing:
        print(f"  skipped (source missing): {skipped_missing}")
    import collections
    counts = collections.Counter(r["category"] for r in out_records)
    print("By category:")
    for c, n in counts.most_common():
        print(f"  {c}: {n}")


if __name__ == "__main__":
    main()
