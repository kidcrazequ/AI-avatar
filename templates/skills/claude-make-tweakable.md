---
name: claude-make-tweakable
description: 在设计制品中加入可调参数（Tweaks）
---

## 技能说明

为设计产物添加可调控件（颜色、间距、字号、文案开关），便于快速比对版本。

## 执行要点

1. 只暴露关键 3-8 个参数，避免过度复杂。
2. 参数变更应实时反映在页面。
3. 需要持久化时写入配置 JSON 或页面内常量块。

## 工具调用

- `write_file`
- `show_to_user`
- `eval_js_user_view`

