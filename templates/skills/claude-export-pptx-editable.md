---
name: claude-export-pptx-editable
description: 导出可编辑 PPTX
---

## 技能说明

将 deck 结构导出为可编辑 PPTX（文本/形状可编辑）。

## 执行要点

1. 优先从结构化页面（section）导出。
2. 导出后提示用户检查字体替换与布局偏移。

## 工具调用

- `export_pptx`
- `present_fs_item_for_download`

