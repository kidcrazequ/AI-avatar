---
name: claude-animated-video
description: 当用户要「动画视频」、动画演示、动效、时间轴动画、分镜动画、片头动画、motion、keyframes，或说「做个会动的页面 / 会动的演示」时使用。产出可播放的 HTML 动画制品（当前桌面端不导出 mp4 等视频文件）。
---

## 技能说明

用户要「动画视频」时，输出可播放的 HTML 动画页面，不直接生成 mp4。

## 执行要点

1. 先确认时长、节奏、画幅比例（默认 1920x1080）。
2. 用 CSS keyframes 或 JS timeline 组织分镜。
3. 保证可重放（提供 play/pause/replay 控件）。
4. 需要交付时用 `save_as_html` 导出。

## 工具调用

- `write_file`
- `show_to_user`
- `save_as_html`

## 能力边界

- 当前桌面端不直接导出视频文件。
- 如需进 Canva，请先导出 HTML/PDF/PPTX 再上传。

