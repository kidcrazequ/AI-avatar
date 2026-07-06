#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "src/assets/office/character/soul-pig"
SOURCE_DIR = OUT_DIR / "frames-prototype"
SHEET_PATH = OUT_DIR / "soul-pig-office-standard-64.png"
META_PATH = OUT_DIR / "soul-pig-office-standard-64.meta.json"

FRAME_W = 64
FRAME_H = 64
SOURCE_W = 48
SOURCE_H = 64
FRAMES = 4
STABLE_LOOP = [0, 1, 3, 1]

OUTLINE = (42, 35, 31, 255)
OUTLINE_SOFT = (75, 61, 51, 255)
SKIN = (241, 160, 137, 255)
SKIN_LIGHT = (255, 191, 170, 255)
SKIN_SHADOW = (211, 117, 102, 255)
SNOUT = (255, 184, 164, 255)
SNOUT_SHADOW = (225, 124, 113, 255)
TEE = (226, 224, 208, 255)
TEE_DARK = (58, 74, 70, 255)
PANTS = (92, 86, 55, 255)
PANTS_DARK = (58, 62, 46, 255)
SHOE = (50, 52, 48, 255)
SOLE = (80, 83, 74, 255)
BAG = (44, 37, 31, 255)
HEADPHONE = (38, 47, 55, 255)
BADGE = (235, 213, 160, 255)
MUG = (239, 233, 211, 255)
WATER = (116, 165, 185, 255)
PAPER = (239, 227, 190, 255)
SCREEN = (34, 47, 57, 255)
SCREEN_GLOW = (79, 139, 150, 255)

ACTIONS = [
    ("idle_front", "idle"),
    ("walk_se", "walk"),
    ("walk_sw", "walk"),
    ("walk_ne", "walk"),
    ("walk_nw", "walk"),
    ("sit_work", "sit_work"),
    ("stand_drink", "drink"),
    ("sit_sofa", "sit_sofa"),
    ("sit_rest", "sit_rest"),
    ("sit_meeting", "meeting"),
    ("stand_research", "research"),
    ("stand_file", "file"),
]


def source_frame(prefix: str, frame: int) -> Image.Image:
    return Image.open(SOURCE_DIR / f"soul-pig-{prefix}-{frame + 1}-48-prototype.png").convert("RGBA")


def anchored(source: Image.Image, *, anchor_x: int = 32, anchor_y: int = 63, dx: int = 0, dy: int = 0) -> Image.Image:
    frame = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    bbox = source.getbbox()
    if not bbox:
        return frame
    source_anchor_x = round((bbox[0] + bbox[2]) / 2)
    source_anchor_y = bbox[3]
    frame.alpha_composite(source, (anchor_x + dx - source_anchor_x, anchor_y + dy - source_anchor_y))
    return frame


def copy_source(prefix: str, frame: int, *, mirror: bool = False, dx: int = 0, dy: int = 0) -> Image.Image:
    source = source_frame(prefix, STABLE_LOOP[frame])
    if mirror:
        source = ImageOps.mirror(source)
    return anchored(source, dx=dx, dy=dy)


def without_lower_furniture(source: Image.Image, cutoff_y: int) -> Image.Image:
    result = Image.new("RGBA", source.size, (0, 0, 0, 0))
    result.alpha_composite(source.crop((0, 0, SOURCE_W, cutoff_y)), (0, 0))
    return result


def rect(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], fill: tuple[int, int, int, int], outline: tuple[int, int, int, int] = OUTLINE) -> None:
    draw.rectangle(xy, fill=outline)
    x0, y0, x1, y1 = xy
    if x1 - x0 > 2 and y1 - y0 > 2:
        draw.rectangle((x0 + 1, y0 + 1, x1 - 1, y1 - 1), fill=fill)


def ellipse(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], fill: tuple[int, int, int, int], outline: tuple[int, int, int, int] = OUTLINE) -> None:
    draw.ellipse(xy, fill=outline)
    x0, y0, x1, y1 = xy
    if x1 - x0 > 2 and y1 - y0 > 2:
        draw.ellipse((x0 + 1, y0 + 1, x1 - 1, y1 - 1), fill=fill)


def poly(draw: ImageDraw.ImageDraw, pts: list[tuple[int, int]], fill: tuple[int, int, int, int], outline: tuple[int, int, int, int] = OUTLINE) -> None:
    draw.polygon(pts, fill=outline)
    cx = sum(x for x, _ in pts) / len(pts)
    cy = sum(y for _, y in pts) / len(pts)
    inset = [(round(x + (cx - x) * 0.12), round(y + (cy - y) * 0.12)) for x, y in pts]
    draw.polygon(inset, fill=fill)


def line(draw: ImageDraw.ImageDraw, pts: list[tuple[int, int]], fill: tuple[int, int, int, int] = OUTLINE, width: int = 2) -> None:
    draw.line(pts, fill=fill, width=width)


def ear(draw: ImageDraw.ImageDraw, pts: list[tuple[int, int]]) -> None:
    poly(draw, pts, SKIN)
    cx = sum(x for x, _ in pts) / len(pts)
    cy = sum(y for _, y in pts) / len(pts)
    inner = [(round(x + (cx - x) * 0.25), round(y + (cy - y) * 0.25)) for x, y in pts]
    draw.polygon(inner, fill=SKIN_LIGHT)


def with_mug(img: Image.Image, frame: int) -> Image.Image:
    draw = ImageDraw.Draw(img)
    bob = [0, -1, 0, 1][frame]
    rect(draw, (41, 38 + bob, 47, 47 + bob), MUG, OUTLINE)
    draw.rectangle((42, 38 + bob, 46, 40 + bob), fill=WATER)
    return img


def with_screen(img: Image.Image, frame: int) -> Image.Image:
    draw = ImageDraw.Draw(img)
    bob = [0, -1, 0, 1][frame]
    rect(draw, (39, 31 + bob, 51, 43 + bob), SCREEN, OUTLINE)
    draw.rectangle((41, 33 + bob, 49, 36 + bob), fill=SCREEN_GLOW)
    return img


def with_paper(img: Image.Image, frame: int) -> Image.Image:
    draw = ImageDraw.Draw(img)
    bob = [0, -1, 0, 1][frame]
    rect(draw, (39, 34 + bob, 51, 45 + bob), PAPER, OUTLINE)
    return img


def with_walk_stride(img: Image.Image, frame: int) -> Image.Image:
    draw = ImageDraw.Draw(img)
    back_dx, front_dx = [(-5, 4), (-1, 1), (5, -4), (1, -1)][frame]
    knee_y = 50
    shoe_y = 60

    poly(draw, [(25, 45), (31, 46), (31 + back_dx, 56), (24 + back_dx, 56)], PANTS_DARK, OUTLINE_SOFT)
    poly(draw, [(35, 45), (41, 46), (42 + front_dx, 56), (35 + front_dx, 56)], PANTS, OUTLINE_SOFT)
    rect(draw, (22 + back_dx, shoe_y - 3, 31 + back_dx, shoe_y), SHOE, OUTLINE_SOFT)
    rect(draw, (35 + front_dx, shoe_y - 3, 44 + front_dx, shoe_y), SHOE, OUTLINE_SOFT)
    draw.rectangle((23 + back_dx, shoe_y, 31 + back_dx, shoe_y), fill=SOLE)
    draw.rectangle((36 + front_dx, shoe_y, 44 + front_dx, shoe_y), fill=SOLE)
    line(draw, [(28, 46), (28 + back_dx, knee_y + 8)], OUTLINE_SOFT, 1)
    line(draw, [(38, 46), (39 + front_dx, knee_y + 8)], OUTLINE_SOFT, 1)
    return soften_foot_highlights(img)


def soften_foot_highlights(img: Image.Image) -> Image.Image:
    pixels = img.load()
    for y in range(54, FRAME_H):
        for x in range(FRAME_W):
            r, g, b, a = pixels[x, y]
            if a and r > 175 and g > 175 and b > 160:
                pixels[x, y] = SOLE
    return img


def sit_work(frame: int) -> Image.Image:
    img = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    bob = [0, 0, -1, 0][frame]
    cx = 32

    poly(draw, [(cx - 16, 38), (cx + 16, 38), (cx + 13, 54), (cx - 13, 54)], TEE)
    draw.rectangle((cx - 11, 39, cx + 11, 42), fill=TEE_DARK)
    line(draw, [(cx - 12, 40), (cx + 10, 54)], BAG, 2)
    rect(draw, (cx - 18, 46, cx - 13, 56), SKIN, OUTLINE_SOFT)
    rect(draw, (cx + 13, 46, cx + 18, 56), SKIN, OUTLINE_SOFT)

    ear(draw, [(cx - 13, 18 + bob), (cx - 22, 10 + bob), (cx - 19, 27 + bob), (cx - 10, 26 + bob)])
    ear(draw, [(cx + 13, 18 + bob), (cx + 22, 10 + bob), (cx + 19, 27 + bob), (cx + 10, 26 + bob)])
    ellipse(draw, (cx - 17, 11 + bob, cx + 17, 44 + bob), SKIN)
    draw.rectangle((cx - 9, 15 + bob, cx + 9, 17 + bob), fill=SKIN_LIGHT)
    draw.rectangle((cx - 13, 36 + bob, cx + 13, 38 + bob), fill=SKIN_SHADOW)
    draw.arc((cx - 20, 18 + bob, cx + 20, 49 + bob), 188, 352, fill=HEADPHONE, width=2)
    rect(draw, (cx - 17, 28 + bob, cx - 14, 39 + bob), HEADPHONE, OUTLINE_SOFT)
    rect(draw, (cx + 14, 28 + bob, cx + 17, 39 + bob), HEADPHONE, OUTLINE_SOFT)
    return img


def sit_from_idle(frame: int) -> Image.Image:
    return sit_from_source(frame, cutoff_y=56, dy=1)


def sit_from_source(frame: int, *, cutoff_y: int, dy: int = 0) -> Image.Image:
    source = source_frame("idle", STABLE_LOOP[frame])
    cropped = without_lower_furniture(source, cutoff_y)
    return anchored(cropped, anchor_y=59, dy=dy)


def make_frame(action: str, frame: int) -> Image.Image:
    if action == "idle_front":
        return copy_source("idle", frame)
    if action == "walk_se":
        return with_walk_stride(copy_source("walk", frame), frame)
    if action == "walk_sw":
        return with_walk_stride(copy_source("walk", frame, mirror=True), frame)
    if action == "walk_ne":
        return with_walk_stride(copy_source("walk", frame, dx=-1), frame)
    if action == "walk_nw":
        return with_walk_stride(copy_source("walk", frame, mirror=True, dx=1), frame)
    if action == "sit_work":
        return sit_work(frame)
    if action == "stand_drink":
        return with_mug(copy_source("idle", frame), frame)
    if action in {"sit_sofa", "sit_rest", "sit_meeting"}:
        return sit_from_idle(frame)
    if action == "stand_research":
        return with_screen(copy_source("idle", frame), frame)
    if action == "stand_file":
        return with_paper(copy_source("idle", frame), frame)
    return copy_source("idle", frame)


def build_sheet() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sheet = Image.new("RGBA", (FRAME_W * FRAMES, FRAME_H * len(ACTIONS)), (0, 0, 0, 0))
    actions_meta = {}

    for row, (action, kind) in enumerate(ACTIONS):
        for frame in range(FRAMES):
            sheet.alpha_composite(make_frame(action, frame), (frame * FRAME_W, row * FRAME_H))
        actions_meta[action] = {
            "kind": kind,
            "row": row,
            "frames": FRAMES,
            "anchorX": 32,
            "anchorY": 60,
            "frameClass": f"office-game-sprite--{action}",
        }

    sheet.save(SHEET_PATH)
    META_PATH.write_text(
        json.dumps(
            {
                "version": 1,
                "name": "soul-pig-office-standard-64",
                "frameWidth": FRAME_W,
                "frameHeight": FRAME_H,
                "columns": FRAMES,
                "rows": len(ACTIONS),
                "sheet": SHEET_PATH.name,
                "actions": actions_meta,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    build_sheet()
