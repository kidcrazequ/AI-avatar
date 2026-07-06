---
name: claude-export-pptx-screenshots
description: 当用户要求像素级保真 / 视觉完全一致的 PPTX 导出，说「截图版 PPT」「样式不能跑」「所见即所得」，或可编辑 PPTX 出现布局偏移需要保真替代时使用（该模式文字不可编辑）。
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

