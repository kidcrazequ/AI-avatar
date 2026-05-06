---
title: 提升知识库 .md 可读性 — 子任务 1 探查报告
author: zhi.qu
date: 2026-05-02
parent_plan: 提升知识库md可读性_kb-md-readability.plan.md
agent: explore subagent (readonly)
---

# 探查报告

> 本报告为子任务 1 产出，回答 plan 第六节列出的 5 个核心问题。所有引用都带精确行号，便于后续子任务直接定位改动点。

---

## 1. FORMAT 按钮全链路

| 步骤 | 位置 | 说明 |
|------|------|------|
| UI 入口 | `desktop-app/src/components/KnowledgePanel.tsx:954-974` | 预览态下 `button`，`onClick` 调 `await window.electronAPI.formatKnowledgeFile(avatarId, selectedPath)` |
| 显隐 | 同文件 `949-952`、`950-952` | `parseFrontmatter(fileContent)` + `shouldHideKnowledgeFormatButton(meta)` 为真则**不渲染** FORMAT |
| 显隐规则 | `desktop-app/src/utils/knowledge-frontmatter.ts:39-48` | `source === 'excel'` / `'pptx'`、`excel_json` 存在、或 `raw_file` 指向 xlsx/csv/ppt/图片等扩展名 → 隐藏 |
| Preload | `desktop-app/electron/preload.ts:306-307` | `ipcRenderer.invoke('format-knowledge-file', avatarId, relativePath)` |
| IPC | `desktop-app/electron/main.ts:2747-2860` | `wrapHandler('format-knowledge-file', ...)` |
| 是否用解析器 | `main.ts:2786-2789`、`2787` | 若 frontmatter 中 `raw_file` 指向存在文件：`const parsed = await documentParser.parseFile(rawFilePath)` |
| 后续 | `main.ts:2821-2822`、`2839-2840`、`2848-2858` | 对文本做 `cleanPdfFullText` / Word 去目录等；`formatDocument(rawText, ...)`（`@soul/core`）；写回时**重建** frontmatter + LLM 正文 |

**FORMAT 语义（重要）**：不是「仅对当前 .md 做排版美化」，而是从 `_raw/` **重新解析** → 清洗 → **LLM 结构化格式化** → 写回（见 `main.ts:2748-2749` 注释）。无 `raw_file` 时用去掉 frontmatter 后的正文当 `rawText`（`2823-2828`）。

> **对子任务 2/3 的含义**：改 `rowsToMarkdownTable` 后，旧文件**点一次 FORMAT 就会重新走改良后的转换流水线**，无需写额外的"批量重新格式化"脚本。这是 free lunch。

---

## 2. frontmatter 写入位置（共 4 处）

| 场景 | 文件:行号 | 写入字段 |
|------|-----------|----------|
| **批量导入**（含 `source: excel` + `raw_file` 形态） | `main.ts:2545-2551` | `rag_only`、`source: ${sourceTag}`、`raw_file: ${rawRelPath}` |
| **单文件导入 · Excel 快速路径** | `KnowledgePanel.tsx:261-279` | `rag_only`、`source: excel`、`excel_json`、`sheets` （**无 `raw_file`**） |
| **单文件导入 · PPTX** | `KnowledgePanel.tsx:328-331` | `rag_only`、`source: pptx` |
| **单文件导入 · PDF/Word 等非 Excel** | `KnowledgePanel.tsx:407-434` | **无 YAML frontmatter**（仅 markdown 正文） |
| **FORMAT 写回** | `main.ts:2848-2858` | 新建 frontmatter：`rag_only`、`source: enhanced`、仅**若旧 frontmatter 曾含 `raw_file`**则保留该行 |

**`document-parser.ts` 内**：**不写 frontmatter**；只返回 `ParsedDocument.text`（`595-606`）。

**用户手工 frontmatter 保护**：⚠️ **无通用合并机制**。FORMAT 写回时丢弃原 frontmatter 中除 `raw_file` 以外的字段（`2852-2856`）；`source` 强制设为 `enhanced`。**用户手工添加的字段（如 `keywords`、`category`）一点 FORMAT 就会丢失**。

> **对子任务 4 的含义**：
> - frontmatter 增强必须在 **4 处**协调，不能只改一处
> - 必须顺手修这个"FORMAT 写回丢字段"的设计缺陷（合并保留用户字段，而非整段重建）

---

## 3. rowsToMarkdownTable 调用方

- **唯一调用点**：`document-parser.ts:580`（`parseExcel` 内）；`797` 为方法定义
- **影响范围**：仅 **Excel/CSV → .md** 正文中的 GFM 表格；Word/PPT/PDF/纯文本路径**不调用**
- **测试/脚本间接依赖**：工作区**无**直接 `import` 该函数的单元测试；`grep` 仅命中 `document-parser.ts` 与 `CHANGELOG.md`
- **关键解耦**：`_excel/*.json` 由 `buildSheetData` 生成，与 `rowsToMarkdownTable` **并行但逻辑分离**；改 `rowsToMarkdownTable` **不会自动改变 JSON**（除非主动让二者共享预处理）
- **出题器**：`kb-question-generator.ts` 主要消费 `_excel/*.json` 与 `rowMetaRoles`，**不直接调用** `rowsToMarkdownTable`

> **对子任务 2 的含义**：
> - 改造范围局限于 Excel → md，风险面小
> - 但子任务 2 的核心改动是"让 markdown 与 structured JSON 共享同一套表头检测"，必须同时考虑 JSON 是否一起变（推荐：抽取共享 `detectHeader(rows)` 函数，两路都调用）

---

## 4. 测试与回归入口

| 项 | 结论 |
|----|------|
| **`fix-l*-*.ts`** | 维护 `avatars/小堵-工商储专家/tests/generated/question-bank.json` 的一次性脚本；运行：`npx tsx avatars/小堵-工商储专家/tests/scripts/fix-l*.ts`（见各文件文件头）。**未在 `desktop-app/package.json` 的 `scripts` 里注册** |
| **桌面端 npm 测试** | `desktop-app/package.json:22-42`：`test` / `test:qa-gate` 为 simulation + smoke，**未挂载** `fix-l*` 或"单 xlsx → 对比 md"的 E2E |
| **单 xlsx → 对比预期 .md** | 仓库内**未发现**以固定夹具 xlsx 生成 md 并与 golden 逐字比对的专用 E2E。最接近的是 `kb-question-generator.test.ts`（用 fixtures + `_excel` JSON），**不是** md 表格 golden diff |
| **prompt bank 硬编码** | L6/L7 prompt 内含 `` knowledge/${sourceFile} `` **文件名**与"章节"锚点（`fix-l6-l7-prompts.ts:110-112`、`fix-l6-l7-section-anchor.ts:183-184`），**非** md 行号；`valueExistsInFile` 为整文件粗搜（`fix-l6-l7-prompts.ts:68-79`） |

> **对子任务 2/3 的含义**：
> - **真正受影响的是 L1/L4/L5（Excel 题）**，不是 L6/L7（章节题）
> - 改 **列名/表头** 若导致 `sourceCell.column`、filter 文案与 JSON 不一致，会伤 L1/L4/L5
> - 改 **文件名**（子任务 6）会伤 bank 里的 `sourceFile` 和 prompt 内路径

> **对子任务 6 的含义（确认风险）**：
> - prompt bank 不硬编码 md 行号 ✅（之前担心的问题不存在）
> - 但**硬编码了文件名**，必须脚本里同步替换

---

## 5. 行角色识别（subtitle/subtotal/total）现状

- **定义与推断**：`document-parser.ts:41-50`（设计说明）、`72-99`（`inferRowMetaRole`）、`696-705`（在 `buildSheetData` 内为每行填 `rowMetaRoles`）
- **是否进入 markdown 表格**：❌ **否**。`rowsToMarkdownTable`（`797-841`）不使用角色；`parseExcel` 中表格与结构化数据分两路（`580` vs `587`）
- **runtime query_excel**：`packages/core/src/tool-router.ts:1718-1731` 对 `sheet.rows` 逐行 `matchFilter`，**未按 `rowMetaRoles` 过滤**
- **当前主要用途**：`_excel/*.json` 随结构化数据落盘；`kb-question-generator.ts:423-478`、`626` 等用 `rowMetaRoles` 约束**出题**（如优先 `data` 行）；`backfill-excel-meta-role.ts` 给存量 JSON 补角色
- **子任务 3（ffill）能否复用 `subtitle`？**
  - `inferRowMetaRole` 依赖**已对齐列名的对象行 + `columns` schema**（`72-75`）
  - Markdown 分支当前是原始 `unknown[][]`
  - 若要复用：必须先把二维表归一到对象结构（与 `buildSheetData` 类似的中间形态）
  - **结论**：概念上可复用，工程上**需先做表头对齐**——这正是子任务 2 要做的事

> **对子任务 2/3 的含义（强依赖）**：
> - 子任务 2 改完后会留下"对齐后的 bodyRows + columns"中间结构
> - 子任务 3 在该中间结构上做 ffill，并用 `inferRowMetaRole` 识别 `subtitle/total` 作为 ffill 边界
> - 因此 **子任务 2 必须先于子任务 3**，且 2 要预留共享中间结构

---

## 6. 推荐改动入口（汇总）

| 子任务 | 建议入口 | 实施要点 |
|--------|----------|----------|
| **子任务 2**（真表头） | `document-parser.ts`：抽取共享函数 `prepareTable(rows): { headers, bodyRows, headerRowIndex }` 给 `buildSheetData`（`619-707`）和 `rowsToMarkdownTable`（`797-841`）共用 | `parseExcel` 调用点 `577-587` 做 orchestrate；保证 `_excel/*.json` 与 `.md` 用同一套表头 |
| **子任务 3**（ffill + 边界） | `document-parser.ts`：在子任务 2 抽出的 `prepareTable` 之后、生成 `bodyLines` 之前插入 `ffillLeadingColumns()` | 用与 `inferRowMetaRole`（`72-99`）一致的规则识别边界；遇到 `subtitle/total/subtotal` 时 **reset 填充段** |
| **子任务 4**（frontmatter 增强 + 修缺陷） | 4 处协调：`main.ts:2545-2550`、`KnowledgePanel.tsx:261-268`、`KnowledgePanel.tsx:407-434`、`main.ts:2848-2858` | 抽取 `mergeFrontmatter(oldMeta, newMeta)`：保留用户字段，只覆盖系统字段。修复 FORMAT 丢失用户字段的缺陷 |
| **子任务 5**（PDF 目录页清理） | 独立 `desktop-app/scripts/cleanup-pdf-toc-pages.ts` | 与本探查无强耦合 |
| **子任务 6**（文件名规整） | 独立 `desktop-app/scripts/normalize-knowledge-filenames.ts` | 必须同步更新 question-bank.json 中 `sourceFile` 和 prompt 内 `knowledge/xxx.md` 路径 |

---

## 关键发现汇总（对原 plan 的修正建议）

> 这一节是探查的"增量价值"——发现了 plan 写时未知的事实，需要纳入后续执行。

### ✅ 好消息

1. **改 `rowsToMarkdownTable` 是 free lunch**：用户对存量文件点 FORMAT 就会重新跑改良后的流水线，无需写"批量重新转换"脚本
2. **rowsToMarkdownTable 调用面极小**：仅 `parseExcel` 内部使用，改起来风险可控
3. **prompt bank 不硬编码 md 行号**：之前担心子任务 6 会破坏 L6/L7 测试，实际只硬编码了文件名（脚本里替换即可）

### ⚠️ 警告

1. **FORMAT 写回会丢用户手工 frontmatter 字段**（已存在的设计缺陷）：子任务 4 应顺手修复，不然 frontmatter 增强等于白做
2. **frontmatter 写入有 4 处**：单文件 Excel / 批量 / FORMAT / PPTX，子任务 4 必须协调全部
3. **子任务 2 必须先于子任务 3**：3 要复用 2 抽出的"对齐后中间结构"做 ffill 边界识别
4. **真正受 Excel 改造影响的是 L1/L4/L5（Excel 题）**而非 L6/L7：回归测试重点在前者
5. **`buildSheetData` 与 `rowsToMarkdownTable` 当前是并行解耦**：子任务 2 的核心是把它们用同一套表头检测函数串起来，这本身是个"小重构"

### 📌 子任务 4 要做但 plan 没写的事

新增一项：**修复 FORMAT 写回丢失用户 frontmatter 字段的缺陷**——这是子任务 4 的隐性前置，否则增强后的 frontmatter 字段会被一次 FORMAT 清空。

---

## 报告产出后续步骤

按 plan 执行顺序：

```
1 (本报告) ✅
  ├─→ 2 (真表头) ─→ 3 (ffill)  ┐
  └─→ 4 (frontmatter, 含修缺陷) ┴─ 三者改 document-parser.ts + main.ts + KnowledgePanel.tsx
                                   ↓
                                   5 (PDF 目录页清理) ─→ 6 (文件名规整)
```

**新窗口启动子任务 2 时**，挂载本报告 + 主 plan 即可：

```
@.cursor/plans/提升知识库md可读性_kb-md-readability.plan.md
@.cursor/plans/提升知识库md可读性_探查报告.md

按计划执行子任务 2：抽取 prepareTable 共享函数，让 markdown 与 _excel/*.json 用同一套表头检测。
```
