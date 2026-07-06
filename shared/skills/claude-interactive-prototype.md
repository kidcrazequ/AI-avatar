---
name: claude-interactive-prototype
description: 当用户要可点击 / 可操作的交互原型、prototype、demo 页面，说「做个能点的原型」「交互演示一下」「点一下能跳转」，或需要在预览窗口直接操作页面流转时使用。
---

## 技能说明

当用户要求原型时，优先输出单文件 HTML（内联 CSS/JS），可直接交互。

## 执行要点

1. 明确页面流转与状态变更。
2. 先给低保真交互，再补高保真视觉。
3. 产物写入 workspace 后调用 `show_to_user` 预览。

## 工具调用

- `write_file`
- `show_to_user`
- `eval_js_user_view`
- `done`

