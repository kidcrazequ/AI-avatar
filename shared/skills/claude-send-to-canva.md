---
name: claude-send-to-canva
description: 当用户要求把制品发送 / 导入 / 上传到 Canva，说「send to canva」「放进 Canva 改」「导到 Canva」时使用。桌面端无 Canva 直连 API，走导出后手动上传的半自动流程。
---

## 技能说明

Canva 当前不支持桌面端直接 API 推送，采用「导出 + 打开 Canva + 手动上传」流程。

## 标准流程

1. 先导出目标格式（PPTX/PDF/HTML）。
2. 调 `present_fs_item_for_download` 提供下载。
3. 打开 Canva 导入页。
4. 用户拖拽文件到 Canva 完成导入。

## 工具调用

- `export_pptx`
- `save_as_pdf`
- `save_as_html`
- `present_fs_item_for_download`

