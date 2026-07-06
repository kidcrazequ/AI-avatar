#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OFFICE_DIR = ROOT / "src/assets/office/pixel-office"
SOURCE_PATH = OFFICE_DIR / "soul-pixel-office-1080x780-prototype.png"
FRONT_PATH = OFFICE_DIR / "soul-pixel-office-1080x780-front-layer.png"

# These polygons are map objects, not character masks. They represent furniture
# front edges that should be rendered after NPCs in the game scene.
FRONT_OCCLUDERS = [
    # Workstation chair lower body mask. Keep this tight so walking on the open
    # floor is never swallowed by the desk.
    [(204, 388), (282, 388), (308, 438), (226, 466), (194, 424)],
    # Lounge sofa/table foreground.
    [(216, 592), (438, 592), (468, 650), (184, 650)],
    # Meeting table foreground for the next NPC route expansion.
    [(552, 500), (798, 500), (826, 560), (520, 560)],
    # Low foreground divider / plant board.
    [(606, 606), (842, 548), (904, 594), (672, 668)],
]


def build_front_layer() -> None:
    source = Image.open(SOURCE_PATH).convert("RGBA")
    mask = Image.new("L", source.size, 0)
    draw = ImageDraw.Draw(mask)

    for polygon in FRONT_OCCLUDERS:
        draw.polygon(polygon, fill=255)

    front = Image.new("RGBA", source.size, (0, 0, 0, 0))
    front.alpha_composite(source)
    front.putalpha(mask)
    front.save(FRONT_PATH)


if __name__ == "__main__":
    build_front_layer()
