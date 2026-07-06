---
name: claude-export-pptx-editable
description: 当用户要求把 deck / 幻灯片 / 演示文稿导出为可编辑的 PPTX / PPT / PowerPoint，说「导出 pptx」「给我能改的 PPT」「要可编辑版本」时使用（文本与形状保持可编辑）。
---

## 技能说明

将 deck 结构导出为可编辑 PPTX（文本/形状可编辑）。

## 执行要点

1. 优先从结构化页面（section）导出。
2. 导出后提示用户检查字体替换与布局偏移。

## 工具调用

- `export_pptx`
- `present_fs_item_for_download`

