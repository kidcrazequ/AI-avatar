#!/usr/bin/env python3
"""
将设计稿（图标参考图）规范化为符合 macOS Big Sur+ 标准的应用图标 PNG。

设计目标（参考 Microsoft Word / Apple 自带应用图标的视觉规范）：
  1. 画布: 1024 x 1024 px (RGBA)
  2. 形状: macOS 风格 squircle（superellipse），曲率 n ≈ 5
  3. 内容: 直接使用原图主体内容（含阴影、3D 立体细节），不做颜色抠图
  4. 边缘: 透明 alpha，让 macOS dock / launchpad 自然渲染圆角

工作流程（保持极简：原图基础上做裁剪）：
  1. 读取设计稿（PNG / JPEG）
  2. 检测主体最小外接矩形 bbox，外扩 BBOX_PADDING_RATIO 后扩为正方形
  3. 直接 crop 原图的正方形区域（保留所有像素，含实心阴影）
  4. 缩放到 1024×1024
  5. 生成 macOS squircle alpha 蒙版
  6. 将 squircle 蒙版与原图 alpha 取 min，得到"squircle 内原图、squircle 外透明"
  7. 保存为 PNG (RGBA)

用法:
    python3 scripts/build-icon-from-image.py <source-image> [<output-png>]

默认输出: build/icon.png

@author zhi.qu
@date 2026-04-28
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image


CANVAS_SIZE = 1024
# squircle 占画布比例（每边留白 ~5%，即 ~50px，对齐 Word 图标观感）
SQUIRCLE_PADDING = 50
# squircle 曲率指数。n=4 偏圆，n=5 接近 Apple 实际 (Big Sur+) 的 squircle，
# n=6 棱角更明显。Microsoft Office 系列也大致使用 n≈5。
SQUIRCLE_N = 5.0

# 主体 bbox 的外扩比例：在检测到的最小外接矩形基础上，向四周扩展该比例的
# 边长，以确保机器人下方的阴影、外缘留白都被一并包入正方形区域。
# 0.12 ≈ 主体每边外扩 12%，配合 squircle 后整体留白美观。
BBOX_PADDING_RATIO = 0.12


def detect_subject_bbox(arr: np.ndarray) -> tuple[int, int, int, int]:
    """
    从 RGB 数组里精准抠出"主体"的最小外接矩形。

    判定规则（同时排除两类背景像素）：
      A. 灰白背景: max(R,G,B) >= 200 且 (max-min) < 25
         —— 用于剔除纯白底以及浅灰色卡片描边
      B. 透明像素: alpha < 8

    其余像素视为有色 / 深色主体内容（橙色身体、粉色身体、黑色眼镜等）。
    """
    if arr.shape[2] == 4:
        rgb = arr[..., :3]
        alpha = arr[..., 3]
    else:
        rgb = arr
        alpha = np.full(arr.shape[:2], 255, dtype=np.uint8)

    rgb_max = rgb.max(axis=2)
    rgb_min = rgb.min(axis=2)
    saturation = rgb_max.astype(np.int16) - rgb_min.astype(np.int16)

    # 灰白背景：高亮度 + 低饱和度
    is_grayish_bg = (rgb_max >= 200) & (saturation < 25)
    is_transparent = alpha < 8
    is_subject = ~(is_grayish_bg | is_transparent)

    if not is_subject.any():
        h, w = arr.shape[:2]
        return 0, 0, w, h

    ys, xs = np.where(is_subject)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def expand_to_square(
    bbox: tuple[int, int, int, int],
    img_size: tuple[int, int],
    padding_ratio: float = 0.0,
) -> tuple[int, int, int, int]:
    """
    以 bbox 较长边为基础 side，按 padding_ratio 在四周外扩，再居中扩展为
    正方形（受图像最小边限制）。

    padding_ratio = 0.12 表示：side = max(bw, bh) * (1 + 0.24)
    （即每边各外扩 12%）
    """
    left, top, right, bottom = bbox
    img_w, img_h = img_size
    bw = max(0, right - left)
    bh = max(0, bottom - top)
    raw_side = max(bw, bh)
    padded_side = int(round(raw_side * (1.0 + padding_ratio * 2)))
    side = min(padded_side, min(img_w, img_h))
    if side <= 0:
        s = min(img_w, img_h)
        return 0, 0, s, s
    cx = (left + right) // 2
    cy = (top + bottom) // 2
    half = side // 2
    new_left = max(0, min(img_w - side, cx - half))
    new_top = max(0, min(img_h - side, cy - half))
    return new_left, new_top, new_left + side, new_top + side


def build_squircle_mask(size: int, padding: int, n: float = 5.0) -> np.ndarray:
    """
    生成一个 size×size 的 squircle alpha mask（uint8，0..255）。

    采用 superellipse 公式 |x/r|^n + |y/r|^n <= 1，n=5 接近 Apple Big Sur
    应用图标的曲率。利用 supersampling (2x) + 平均，得到平滑抗锯齿边缘。
    """
    ss = 4  # supersample 倍率（4x 让 squircle 边缘更平滑）
    inner = size - 2 * padding
    big = size * ss
    big_inner = inner * ss
    half = big_inner / 2.0
    cx = cy = big / 2.0

    yy, xx = np.ogrid[0:big, 0:big]
    dx = (xx - cx) / half
    dy = (yy - cy) / half
    norm = np.abs(dx) ** n + np.abs(dy) ** n
    mask_big = (norm <= 1.0).astype(np.float32)

    # 下采样到目标尺寸（线性平均 → 抗锯齿）
    mask = mask_big.reshape(size, ss, size, ss).mean(axis=(1, 3))
    return (mask * 255).astype(np.uint8)


def build_icon(source: Path, output: Path) -> None:
    """
    "原图基础上裁剪 + squircle 蒙版"流程：
      1. 检测主体 bbox 并外扩 BBOX_PADDING_RATIO，扩展为正方形
      2. 直接从原图 crop 出该正方形区域（保留所有像素，含实心阴影）
      3. 缩放到 1024×1024
      4. 用 macOS squircle 形状的 alpha 蒙版替换/合并 alpha 通道
         （squircle 内：原图 RGB 原样；squircle 外：透明）

    不做任何抠图/blur/合成，避免把原图中的实心阴影、3D 高光误模糊化。
    """
    if not source.exists():
        raise FileNotFoundError(f"source image not found: {source}")

    src_img = Image.open(source).convert("RGBA")
    src_arr = np.asarray(src_img)
    print(f"[icon-build] source: {source} ({src_img.size[0]}x{src_img.size[1]})")

    # 1) 检测主体 bbox + 扩展为正方形（外扩 padding 把阴影/边缘留白包入）
    raw_bbox = detect_subject_bbox(src_arr)
    print(f"[icon-build] subject bbox: {raw_bbox}  size={raw_bbox[2]-raw_bbox[0]}x{raw_bbox[3]-raw_bbox[1]}")

    sq_bbox = expand_to_square(raw_bbox, src_img.size, padding_ratio=BBOX_PADDING_RATIO)
    print(f"[icon-build] squared bbox: {sq_bbox}  size={sq_bbox[2]-sq_bbox[0]}x{sq_bbox[3]-sq_bbox[1]}  (padding_ratio={BBOX_PADDING_RATIO})")

    # 2) 直接 crop 原图的正方形区域（不做任何抠图）
    cropped = src_img.crop(sq_bbox)

    # 3) 缩放到画布大小
    resized = cropped.resize((CANVAS_SIZE, CANVAS_SIZE), Image.LANCZOS).convert("RGBA")

    # 4) 用 squircle mask 设置 alpha：squircle 内保留原图像素，外部透明
    print(f"[icon-build] generating squircle mask (size={CANVAS_SIZE}, padding={SQUIRCLE_PADDING}, n={SQUIRCLE_N})")
    sq_mask = build_squircle_mask(CANVAS_SIZE, SQUIRCLE_PADDING, SQUIRCLE_N)

    arr_out = np.asarray(resized).copy()
    # 同时尊重原图自带的 alpha：取与 squircle mask 的 min（按位与的连续版本）
    arr_out[..., 3] = np.minimum(arr_out[..., 3], sq_mask)

    final = Image.fromarray(arr_out, "RGBA")

    output.parent.mkdir(parents=True, exist_ok=True)
    final.save(output, "PNG", optimize=True)
    print(f"[icon-build] saved: {output} ({CANVAS_SIZE}x{CANVAS_SIZE})")


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python3 scripts/build-icon-from-image.py <source-image> [<output-png>]")
        sys.exit(1)

    source = Path(sys.argv[1]).expanduser().resolve()
    if len(sys.argv) >= 3:
        output = Path(sys.argv[2]).expanduser().resolve()
    else:
        repo_root = Path(__file__).resolve().parent.parent
        output = repo_root / "build" / "icon.png"

    build_icon(source, output)


if __name__ == "__main__":
    main()
