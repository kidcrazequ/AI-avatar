---
name: claude-handoff-to-code
description: 当用户要求把设计结果交给开发 / 前端 / Claude Code 落地实现，提到「交接」「handoff」「开发交付」「给开发的文档」「切图交付」时使用，产出开发可直接使用的交付包。
---

## 技能说明

将设计结果整理成开发可直接落地的交付包。

## 交付内容

1. 设计 token（颜色/字号/间距/圆角）。
2. 页面结构与组件清单。
3. 交互规则与状态说明。
4. 资源引用与文件树。

## 工具调用

- `write_file`
- `register_assets`
- `present_fs_item_for_download`

