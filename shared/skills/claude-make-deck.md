---
name: claude-make-deck
description: 当用户要做 deck / 幻灯片 / 演示文稿 / slides / PPT / 汇报材料，说「做个 deck」「出一版汇报页」「帮我做演示」时使用。先产出 HTML 版演示，后续可导出 PPTX / PDF。
---

## 技能说明

将需求转成可演示 deck（HTML 版），每个 `section` 代表一页。

## 执行要点

1. 先确认受众、时长、风格。
2. 保持一页一主题，标题 + 关键要点。
3. 产物通过 `show_to_user` 预览，必要时 `export_pptx`。

## 工具调用

- `write_file`
- `show_to_user`
- `export_pptx`
- `save_as_pdf`

