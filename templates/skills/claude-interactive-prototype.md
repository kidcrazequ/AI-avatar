---
name: claude-interactive-prototype
description: 生成可交互原型页面并在预览窗口可操作
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

