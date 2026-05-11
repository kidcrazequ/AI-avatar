# 小堵分身 PDF 文档模板

本目录提供小堵分身在调用 `generate_document` 工具生成 PDF/HTML 时可选用的 CSS 模板。

> 由 `template-loader.ts` 通过 `loadTemplateCss(avatarRoot, name)` 加载，最终注入到 `html-renderer` 的 `<style>` 段，叠加在内置基础样式之上。

## 模板清单

| 模板名 (`template_name` 参数) | 适用场景 | 视觉特征 |
| --- | --- | --- |
| `default` | 通用文档（FAQ、笔记、备忘录等） | 中性灰色调，GitHub 风格表格，A4 18mm 边距 |
| `solution-report` | 储能项目方案报告、产品方案 | 远景品牌深蓝 #1A3A6E，居中页眉「远景能源 · 工商业储能」，右下页码 |
| `income-calculation` | 收益测算 / IRR / 现金流文档 | 数字表格优化（右对齐 + 等宽字体），关键指标高亮 |

## 用法约定（给 LLM）

- 调用 `generate_document` 时传 `template_name: 'solution-report'` 或 `'income-calculation'` 选用专题模板
- 不传 `template_name` 默认走 `default`
- 模板缺失时降级使用内置基础样式（不会报错）

## 设计约束

- 字体：`PingFang SC > Microsoft YaHei > Hiragino Sans GB > Noto Sans CJK SC > sans-serif`
- 页眉页脚通过 `@page` 规则实现（仅 PDF 渲染时生效）
- 远景品牌色：深蓝 `#1A3A6E`（一级标题、表头）/ 浅蓝 `#E3EDF7`（callout 背景）
- 收益测算模板的「关键指标高亮」由 LLM 主动用 `:::success` / `:::danger` callout 表达
