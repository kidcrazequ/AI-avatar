---
name: claude-export-pptx-screenshots
description: 导出截图型 PPTX（像素保真）
---

## 技能说明

当用户强调像素一致性时，优先走截图型 PPTX。

## 执行要点

1. 先固定页面尺寸与背景。
2. 用截图模式导出每一页。
3. 说明该模式文字不可编辑。

## 工具调用

- `gen_pptx`
- `present_fs_item_for_download`

