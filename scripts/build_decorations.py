"""Generate feathered + glowing decoration sprites for the archive site.

Reads validated 32x32 item icon PNGs from public/images/2d/item_icons/,
upscales to 96x96 with NEAREST (keeps pixel-art look), feathers the alpha,
adds a soft outer glow and a tasteful drop shadow, and writes the result
to public/decorations/.

Each output PNG is 128x128 (96 sprite + 16px halo padding each side) so the
glow and shadow have room to bleed without clipping.
"""

from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "public" / "images" / "2d" / "item_icons"
OUT = REPO / "public" / "decorations"

# (item_icon index, output slug). All hand-picked from validated set.
PICKS: list[tuple[int, str]] = [
    (184, "butterfly-yellow"),
    (188, "butterfly-dark"),
    (192, "dragonfly"),
    (221, "turtle"),
    (232, "beetle"),
    (261, "pie"),
    (300, "lemon"),
    (301, "apple-red"),
    (302, "peach"),
    (303, "grapes"),
    (304, "apple-yellow"),
    (305, "ice-cream-cone"),
    (306, "parfait"),
    (354, "jelly"),
    (419, "ham"),
    (423, "pizza"),
    (424, "burger"),
    (440, "crown"),
    (449, "key"),
    (455, "magic-lamp-gold"),
    (456, "magic-lamp-crystal"),
    (430, "quill-pen"),
    (431, "magic-lamp-tall"),
    (395, "donut"),
]

# Tunables.
UPSCALE = 96            # final sprite size before halo padding (3x of 32)
PAD = 16                # extra padding around sprite (canvas = UPSCALE + 2*PAD)
FEATHER_RADIUS = 0.9    # alpha softening on the sprite edge
GLOW_RADIUS = 7         # outer glow blur
GLOW_STRENGTH = 0.55    # 0..1 multiplier on alpha for glow intensity
GLOW_COLOR = (255, 240, 250)  # warm-white pastel
SHADOW_OFFSET = (0, 5)  # drop-shadow displacement (x, y)
SHADOW_RADIUS = 5       # shadow blur
SHADOW_COLOR = (155, 123, 217)  # site purple
SHADOW_ALPHA = 70       # 0..255


def build_one(src_index: int, slug: str) -> Path:
    src_path = SRC / f"{src_index}.png"
    if not src_path.exists():
        raise FileNotFoundError(src_path)

    sprite_small = Image.open(src_path).convert("RGBA")
    # Upscale with NEAREST so pixel art stays crisp before feathering.
    sprite = sprite_small.resize((UPSCALE, UPSCALE), Image.NEAREST)

    canvas_size = UPSCALE + PAD * 2
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))

    # Soften the sprite alpha (feather edges).
    r, g, b, a = sprite.split()
    a_feather = a.filter(ImageFilter.GaussianBlur(radius=FEATHER_RADIUS))
    feathered = Image.merge("RGBA", (r, g, b, a_feather))

    # Build drop shadow from the feathered alpha.
    shadow_alpha = a_feather.point(lambda v: int(v * (SHADOW_ALPHA / 255)))
    shadow_alpha = shadow_alpha.filter(ImageFilter.GaussianBlur(radius=SHADOW_RADIUS))
    shadow_layer = Image.new("RGBA", (UPSCALE, UPSCALE), SHADOW_COLOR + (0,))
    shadow_layer.putalpha(shadow_alpha)

    # Build outer glow from the alpha.
    glow_alpha = a_feather.point(lambda v: int(v * GLOW_STRENGTH))
    glow_alpha = glow_alpha.filter(ImageFilter.GaussianBlur(radius=GLOW_RADIUS))
    glow_layer = Image.new("RGBA", (UPSCALE, UPSCALE), GLOW_COLOR + (0,))
    glow_layer.putalpha(glow_alpha)

    # Composite in this order: shadow (offset, below) -> glow -> sprite.
    canvas.alpha_composite(shadow_layer, (PAD + SHADOW_OFFSET[0], PAD + SHADOW_OFFSET[1]))
    canvas.alpha_composite(glow_layer, (PAD, PAD))
    canvas.alpha_composite(feathered, (PAD, PAD))

    out_path = OUT / f"{slug}.png"
    OUT.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, optimize=True)
    return out_path


def main() -> None:
    written = []
    for index, slug in PICKS:
        path = build_one(index, slug)
        written.append((slug, path.name))
    print(f"wrote {len(written)} decoration sprites to {OUT}")
    for slug, name in written:
        print(f"  {slug:<24} -> {name}")


if __name__ == "__main__":
    main()
