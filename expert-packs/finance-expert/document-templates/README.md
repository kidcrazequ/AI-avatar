# 财务专家 — PDF/HTML 文档模板

> **作者**：zhi.qu  
> **日期**：2026-05-09  

本分身调用 `generate_document` 时可选用下列 CSS（由桌面端加载并叠加内置基础样式）。

## 模板清单

| templateName | 适用场景 |
|--------------|----------|
| `default` | 备忘录、分析报告、会议纪要（中性版式） |

## 用法约定

- 调用 `generate_document` 时可省略 `templateName`，默认等价于 `default`。  
- 若后续增补 `financial-memo`、`audit-readout` 等专题样式，请在 `document-templates/` 放入对应 `.css` 并在此处登记。  
