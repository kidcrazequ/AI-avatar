---
name: claude-send-to-canva
description: Send to Canva 半自动导入流程
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

