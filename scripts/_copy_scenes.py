"""One-shot copier: pulls 6 categories of 2D assets from the translation repo
into public/scenes/<slug>/ with web-safe filenames, and writes per-category
manifest JSONs to public/data/scenes_<slug>.json.

Run from the archive repo root. Idempotent — overwrites destination.
"""
import json
import shutil
import sys
from pathlib import Path

SRC_ROOT = Path(r"C:/Users/Tyler/Documents/Repos/Tongari boushi translation app claude/notes/2d_assets_v3")
DST_PUBLIC = Path(__file__).resolve().parent.parent / "public"
DST_SCENES = DST_PUBLIC / "scenes"
DST_DATA = DST_PUBLIC / "data"           # for client-fetched (lazy) manifests
DST_DATA_SRC = Path(__file__).resolve().parent.parent / "src" / "data"  # for build-time imports
DST_DATA.mkdir(parents=True, exist_ok=True)
DST_DATA_SRC.mkdir(parents=True, exist_ok=True)

SKIP_NAMES = {".DS_Store", "Thumbs.db", "__pycache__"}


def web_safe(name: str) -> str:
    """Lowercase, underscores to hyphens. Preserve numeric prefix order."""
    return name.replace("_", "-").lower()


def copy_files(src_dir: Path, dst_dir: Path, exts: tuple[str, ...]) -> list[str]:
    """Copy files with given extensions into dst_dir, web-safe names.
    Returns list of destination filenames (relative)."""
    dst_dir.mkdir(parents=True, exist_ok=True)
    out = []
    for p in sorted(src_dir.iterdir()):
        if not p.is_file():
            continue
        if p.name in SKIP_NAMES or p.name.startswith("."):
            continue
        if p.suffix.lower() not in exts:
            continue
        safe = web_safe(p.name)
        dst = dst_dir / safe
        shutil.copy2(p, dst)
        out.append(safe)
    return out


# ─── 1. NPC scenes ────────────────────────────────────────────────────────
def do_npc_scenes():
    src = SRC_ROOT / "npc_scenes"
    dst = DST_SCENES / "npc-scenes"
    files = copy_files(src, dst, (".png",))
    # Build manifest with JP/EN names from source _INDEX.json
    with open(src / "_INDEX.json", encoding="utf-8") as f:
        idx = json.load(f)
    manifest = []
    for scene in idx["scenes"]:
        sid = scene["speaker_id"]
        fname = web_safe(f"speaker_{sid}.png")
        manifest.append({
            "speaker_id": sid,
            "en": scene.get("en_name", ""),
            "jp": scene.get("jp_name", ""),
            "file": fname,
        })
    with open(DST_DATA / "scenes_npc.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return len(files), sum((dst / fn).stat().st_size for fn in files)


# ─── 2. NSBVA previews ────────────────────────────────────────────────────
def do_nsbva():
    src = SRC_ROOT / "nsbva_previews"
    dst = DST_SCENES / "nsbva-previews"
    files = copy_files(src, dst, (".png", ".apng"))
    # Manifest pairs strip + apng by stem
    with open(src / "_NSBVA_INDEX.json", encoding="utf-8") as f:
        idx = json.load(f)
    manifest = []
    for anim in idx["animations"]:
        apng = Path(anim["apng_path"]).name
        strip = Path(anim["strip_path"]).name
        manifest.append({
            "container": anim["container"],
            "entry_idx": anim["entry_idx"],
            "sub_label": anim.get("sub_label", ""),
            "frame_count": anim.get("frame_count"),
            "visible_frames": anim.get("visible_frames"),
            "apng": web_safe(apng),
            "strip": web_safe(strip),
        })
    with open(DST_DATA / "scenes_nsbva.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return len(files), sum((dst / fn).stat().st_size for fn in files)


# ─── 3. Pet aging ─────────────────────────────────────────────────────────
def do_pet_aging():
    src = SRC_ROOT / "pet_aging"
    dst = DST_SCENES / "pet-aging"
    dst.mkdir(parents=True, exist_ok=True)
    out = []
    # Recurse into species_NN/ subdirs
    for species_dir in sorted(src.iterdir()):
        if not species_dir.is_dir():
            continue
        for p in sorted(species_dir.iterdir()):
            if p.is_file() and p.suffix.lower() == ".png":
                safe = web_safe(p.name)
                shutil.copy2(p, dst / safe)
                out.append(safe)
    manifest = [{"file": fn, "species_idx": int(fn.split("-")[1])} for fn in sorted(out)]
    with open(DST_DATA_SRC / "scenes_pet_aging.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return len(out), sum((dst / fn).stat().st_size for fn in out)


# ─── 4. Family showcase (2 specific files) ────────────────────────────────
def do_family():
    src = SRC_ROOT / "family_showcases"
    dst = DST_SCENES / "family-showcase"
    dst.mkdir(parents=True, exist_ok=True)
    mapping = {"hair_catalog.png": "hair-catalog.png", "magazines.png": "magazines.png"}
    out = []
    for orig, safe in mapping.items():
        shutil.copy2(src / orig, dst / safe)
        out.append(safe)
    return len(out), sum((dst / fn).stat().st_size for fn in out)


# ─── 5. Cooking progressions ──────────────────────────────────────────────
def do_cooking():
    src = SRC_ROOT / "cooking_progressions"
    dst = DST_SCENES / "cooking-progressions"
    dst.mkdir(parents=True, exist_ok=True)
    # Filenames have mojibake CJK — rename to "recipe-NN.png" by numeric prefix.
    with open(src / "_INDEX.json", encoding="utf-8") as f:
        idx = json.load(f)
    out = []
    manifest = []
    for entry in idx["entries"]:
        ridx = entry["recipe_index"]
        orig_path = SRC_ROOT.parent.parent / entry["png_path"] if not Path(entry["png_path"]).is_absolute() else Path(entry["png_path"])
        # png_path is relative to repo root
        orig_path = Path(r"C:/Users/Tyler/Documents/Repos/Tongari boushi translation app claude") / entry["png_path"]
        if not orig_path.exists():
            # Fall back: find by prefix
            prefix = f"{ridx:02d}__"
            cands = list(src.glob(f"{prefix}*.png"))
            if not cands:
                print(f"  MISS recipe {ridx}", file=sys.stderr)
                continue
            orig_path = cands[0]
        safe = f"recipe-{ridx:02d}.png"
        shutil.copy2(orig_path, dst / safe)
        out.append(safe)
        manifest.append({"file": safe, "recipe_index": ridx})
    with open(DST_DATA_SRC / "scenes_cooking.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return len(out), sum((dst / fn).stat().st_size for fn in out)


# ─── 6. Composed outfits ──────────────────────────────────────────────────
def do_composed():
    src = SRC_ROOT / "composed_outfits"
    dst = DST_SCENES / "composed-outfits"
    files = copy_files(src, dst, (".png",))
    with open(src / "_INDEX.json", encoding="utf-8") as f:
        idx = json.load(f)
    manifest = []
    for o in idx["outfits"]:
        orig_fname = Path(o["png_path"]).name
        manifest.append({
            "name": o["outfit_name"],
            "file": web_safe(orig_fname),
            "top_idx": o.get("top_idx"),
            "bottom_idx": o.get("bottom_idx"),
            "hat_idx": o.get("hat_idx"),
            "shoes_idx": o.get("shoes_idx"),
        })
    with open(DST_DATA_SRC / "scenes_composed.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return len(files), sum((dst / fn).stat().st_size for fn in files)


def main():
    print("Copying 6 categories of 2D assets…\n")
    results = {}
    for name, fn in [
        ("npc-scenes", do_npc_scenes),
        ("nsbva-previews", do_nsbva),
        ("pet-aging", do_pet_aging),
        ("family-showcase", do_family),
        ("cooking-progressions", do_cooking),
        ("composed-outfits", do_composed),
    ]:
        count, total_bytes = fn()
        mb = total_bytes / 1048576
        results[name] = (count, mb)
        print(f"  {name:24s} {count:4d} files   {mb:6.2f} MB")
    print("\nDone.")
    return results


if __name__ == "__main__":
    main()
