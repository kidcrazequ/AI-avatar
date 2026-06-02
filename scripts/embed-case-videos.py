"""
@author zhi.qu
@date 2026-05-25

把 CASE 03/04/05/06 的 mp4 视频用 base64 嵌入到 HTML 中，
使 AI 分身提效案例.html 成为可单文件分发的离线版本。

CASE 01 / 02 视频体积大（116MB / 60MB），保持外链不动。
"""

from __future__ import annotations

import argparse
import base64
import sys
from pathlib import Path

# 脚本位于 <repo>/scripts/，仓库根 = 上一级目录。不再硬编码本机绝对路径，
# 便于跨机器 / 任意 checkout 路径运行；HTML / assets 也可用命令行覆盖。
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_HTML_PATH = REPO_ROOT / "AI分身提效案例.html"
DEFAULT_ASSETS_DIR = REPO_ROOT / "assets"

CASES_TO_EMBED = [3, 4, 5, 6]


def encode_video(path: Path) -> str:
    """读取 mp4 并返回 base64 字符串。"""
    if not path.exists():
        raise FileNotFoundError(f"视频文件不存在: {path}")
    data = path.read_bytes()
    return base64.b64encode(data).decode("ascii")


def embed_videos_into_html(html_path: Path, assets_dir: Path, cases: list[int]) -> None:
    """原地替换 HTML 中 case-N.mp4 的 src 为 data URI。"""
    if not html_path.exists():
        raise FileNotFoundError(f"HTML 文件不存在: {html_path}")

    text = html_path.read_text(encoding="utf-8")

    replaced = 0
    skipped: list[int] = []

    for case_num in cases:
        mp4_path = assets_dir / f"case-{case_num}.mp4"
        old_src = f'src="assets/case-{case_num}.mp4"'

        if old_src not in text:
            print(f"  跳过 CASE {case_num:02d}: HTML 中未找到 {old_src}（可能已嵌入）")
            skipped.append(case_num)
            continue

        print(f"  编码 CASE {case_num:02d}: {mp4_path.name} ({mp4_path.stat().st_size / 1024 / 1024:.2f} MB) ...")
        b64 = encode_video(mp4_path)
        new_src = f'src="data:video/mp4;base64,{b64}"'

        text = text.replace(old_src, new_src, 1)
        replaced += 1
        print(f"    -> 已嵌入 data URI (base64 长度 {len(b64):,} 字符)")

    html_path.write_text(text, encoding="utf-8")
    new_size_mb = html_path.stat().st_size / 1024 / 1024
    print(f"\n完成: 共嵌入 {replaced} 个视频, 跳过 {len(skipped)} 个")
    print(f"HTML 新体积: {new_size_mb:.2f} MB")


def main() -> int:
    parser = argparse.ArgumentParser(description="把 CASE mp4 视频 base64 嵌入 HTML，生成离线单文件版本。")
    parser.add_argument("--html", type=Path, default=DEFAULT_HTML_PATH, help=f"目标 HTML 路径（默认 {DEFAULT_HTML_PATH}）")
    parser.add_argument("--assets", type=Path, default=DEFAULT_ASSETS_DIR, help=f"assets 目录路径（默认 {DEFAULT_ASSETS_DIR}）")
    args = parser.parse_args()

    print(f"嵌入视频到 {args.html.name}")
    print(f"目标 CASE: {CASES_TO_EMBED}")
    print()
    try:
        embed_videos_into_html(args.html, args.assets, CASES_TO_EMBED)
    except (FileNotFoundError, OSError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
