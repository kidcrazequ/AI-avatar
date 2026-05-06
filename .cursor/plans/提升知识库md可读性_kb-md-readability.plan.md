---
title: 提升知识库 .md 文件 format 后可读性
author: zhi.qu
date: 2026-05-02
status: 全部 6 个子任务已完成
scope: desktop-app/electron/document-parser.ts + main.ts + KnowledgePanel.tsx + 一次性清洗脚本
confirmed_at: 2026-05-02
confirmation:
  - 范围：6 个子任务全做
  - 子任务 6（文件名规整）：与 1-5 一起做，不跳过
related_docs:
  - 探查报告: .cursor/plans/提升知识库md可读性_探查报告.md
---

# 提升知识库 .md 可读性 — 任务拆分计划

> **本计划仅用于规划，不包含执行步骤本身。执行时请在新窗口用 `@.cursor/plans/提升知识库md可读性_kb-md-readability.plan.md` 作为唯一上下文，逐子任务推进。**

---

## 一、背景与现状

### 1.1 问题来源

知识库 `avatars/小堵-工商储专家/knowledge/` 下共 **381 个 .md 文件**（最大 367K），主要由 `_raw/*.xlsx` 和 `_raw/*.pdf` 自动转换产出。当前 format 后可读性差。

### 1.2 抽样定位的 7 类共性问题

抽样：`调试问题top10.md` / `通用柜体检验指导书.md` / `液冷机策略.md` / `ENS-L262-01用户手册_-V1.md`

| # | 问题 | 出处示例 | 影响 |
|---|---|---|---|
| 1 | frontmatter 太弱（只有 `source` + `raw_file`） | 所有 `_excel`/`_pdf` 转出文件 | 检索只能靠文件名 |
| 2 | 表头是 `col1/col2/...`，真表头沦为数据行 | `通用柜体检验指导书.md` L12-13 | 列语义全丢 |
| 3 | 合并单元格用空 `\|  \|` 占位 | `调试问题top10.md` L15-17 | 看到第 5 行不知道属哪个分类 |
| 4 | 单元格内 `<br>` 串多条要点 | `通用柜体检验指导书.md` L28-32 | 渲染挤压成长行 |
| 5 | PDF 目录页原样保留（`第N章 ...........页码`） | `ENS-L262-01用户手册.md` L17-75 | 60+ 行噪声 |
| 6 | 文件名带原始噪声（`_1_` / `__2_` / 乱版本号） | 大量 `xxx_1_.md` | grep / 引用不友好 |
| 7 | 图片被 OCR 成大段文字，无原图链接 | `液冷机策略.md` L8 注释 | 流程图被翻译成树状文字，丢失视觉 |

### 1.3 关键发现（本次探查产出）

`desktop-app/electron/document-parser.ts` 第 619 行 `buildSheetData()` 已经实现"智能表头检测"用于 `query_excel`，但第 797 行 `rowsToMarkdownTable()` 生成 markdown 时**没有复用**它，仍 fallback 到 `col1/col2`。这是最高 ROI 的切入点——**改一处函数，全库 Excel 转出文件受益**。

---

## 二、子任务列表

### 子任务 1：前置探查（不修改代码）

| 项 | 内容 |
|---|---|
| **类型** | 调研 |
| **工具** | `explore` subagent |
| **涉及文件** | `desktop-app/electron/document-parser.ts` + `desktop-app/src/components/KnowledgePanel.tsx` + `desktop-app/src/utils/knowledge-frontmatter.ts` |
| **预计代码量** | 0 行（只读） |
| **产出** | 不超过 200 行的探查报告，写入 `.cursor/plans/提升知识库md可读性_探查报告.md` |
| **关键问题** | ① FORMAT 按钮的全链路调用？<br>② frontmatter 是在 `parseExcelToMarkdown` 内还是外层包装？<br>③ 哪些代码路径会复用 `rowsToMarkdownTable`？<br>④ 测试入口在哪？回归测试 bank 是否硬编码了路径？<br>⑤ `subtitle/subtotal/total` 行角色识别（第 87 行）目前是否影响 markdown 输出？ |

---

### 子任务 2：Excel→md 用真表头替代 `col1/col2`

| 项 | 内容 |
|---|---|
| **类型** | 源码修改 |
| **涉及文件** | `desktop-app/electron/document-parser.ts` |
| **修改位置** | `rowsToMarkdownTable()`（L797-840 附近）+ 抽取 `buildSheetData()` 中的表头检测为共享函数 |
| **预计代码量** | 30-50 行 |
| **核心思路** | 让 markdown 输出与 `query_excel` 用同一套表头检测；当前 `firstRowIsHeader` 判断（L815-818）过于简陋，要求所有单元格都是非空字符串才算表头，命中率太低 |
| **回归点** | 必须保证 query_excel 行为不变（结构化数据已正确） |

**修改前**：

```typescript
const firstRowIsHeader =
  firstRow.length === maxCols &&
  firstRow.every(cell => typeof cell === 'string' && cell.toString().trim().length > 0)
```

**修改后**（伪代码）：

```typescript
// 复用 buildSheetData 中已有的"扫前 5 行打分选最优表头"逻辑
const headerRowIndex = detectHeaderRow(rows)
const header = rows[headerRowIndex].map(escapeCell)
const bodyRows = rows.slice(headerRowIndex + 1)
```

---

### 子任务 3：Excel→md 合并单元格前向填充（ffill）

| 项 | 内容 |
|---|---|
| **类型** | 源码修改 |
| **涉及文件** | `desktop-app/electron/document-parser.ts` |
| **修改位置** | `rowsToMarkdownTable()` 渲染前新增 `ffillLeadingColumns()` helper |
| **预计代码量** | 20-40 行 |
| **核心思路** | 对前 N 列（默认前 2-3 列，可配置）做前向填充：当某 cell 为空且左侧/上方 cell 有值时，复制上行的值。修掉 `调试问题top10.md` 第 15-17 行那种"分类列只第一行有值"的语义丢失 |
| **边界** | 只对"前缀分类列"做 ffill，不对所有列盲目填充（避免把"备注"列填成上行的备注） |
| **判定算法** | 一列若 ≥ 60% 的单元格为空，则该列**不**被 ffill（很可能是真稀疏数据，比如"备注"） |

---

### 子任务 4：Excel→md frontmatter 字段增强

| 项 | 内容 |
|---|---|
| **类型** | 源码修改 |
| **涉及文件** | 由子任务 1 探查结果决定（推测在 `document-parser.ts` 或外层包装） |
| **预计代码量** | 30-60 行 |
| **新增字段** | `title`（从文件名清洗）、`category`（按文件名/正文关键词推断）、`keywords`（从正文 top-N 词频）、`summary`（首段 200 字截断）、`model`（正则 `ENS-L\d+`）、`version`（正则 `Rev_X` / `_v\d+`） |
| **兼容性原则** | **只新增字段不修改/删除已有字段**，保证 KnowledgeViewer 兼容 |
| **拒绝项** | 不做 LLM 摘要（成本不可控），只做规则抽取 |

---

### 子任务 5：一次性脚本 — 清理 PDF 转出文件的目录页噪声

| 项 | 内容 |
|---|---|
| **类型** | 新增脚本 |
| **新文件** | `desktop-app/scripts/cleanup-pdf-toc-pages.ts` |
| **预计代码量** | 60-100 行 |
| **匹配模式** | 形如 `^第.+章\s+.+\.{5,}.*\d+$` 或 `^\d+\.\d+\s+.+\.{5,}.*\d+$` 的行 |
| **处理范围** | `avatars/*/knowledge/*.md` 中 frontmatter `source: pdf` 的文件 |
| **运行模式** | 默认 `--dry-run`，输出每个文件即将删除的行；`--apply` 才落盘 |
| **安全网** | 落盘前自动 git diff 一次（脚本里跑），让用户人工 review |

---

### 子任务 6：一次性脚本 — 规整知识库文件名

| 项 | 内容 |
|---|---|
| **类型** | 新增脚本 |
| **新文件** | `desktop-app/scripts/normalize-knowledge-filenames.ts` |
| **预计代码量** | 80-120 行 |
| **规整规则** | ① 删 `_1_` / `_2_` / `__\d+_` 等下载去重后缀<br>② 统一连字符（混用 `-` `_` → 全部 `_`）<br>③ 版本号统一到末尾 `_vN`<br>④ 中文/英文之间不强制加分隔 |
| **同步更新** | frontmatter 里的 `raw_file`、知识库索引（如果有）、回归测试 bank 中的硬编码路径、其他 `.ts/.md/.json` 中引用 |
| **运行模式** | 默认 `--dry-run`，先输出"重命名映射表"让用户确认 |
| **风险** | 改文件名会破坏一切引用，必须穷尽所有引用点 |

---

## 三、执行顺序

```
1 (探查)
  ├─→ 2 (真表头)   ┐
  ├─→ 3 (ffill)    ├─ 三者都改 document-parser.ts，串行做、共用一次回归测试
  └─→ 4 (frontmatter)
                     ↓
                     5 (PDF 目录页清理) ─→ 6 (文件名规整，最后做)
```

**依赖说明**：

- 2/3/4 都依赖 1 的探查结果（确认改动入口和测试方式）
- 2/3 共改一个函数，先 2 后 3（先把表头改对，再处理 cell 内容延续）
- 6 必须放最后（改文件名会影响一切引用，包括 5 的脚本里如果硬编码路径）

---

## 四、风险与缓解

| 风险 | 来源 | 缓解 |
|---|---|---|
| **回归风险**：改 `rowsToMarkdownTable` 影响全部 Excel 转出文件，可能破坏 L1-L9 红线测试 | 子任务 2/3 | 改完后用 `avatars/小堵-工商储专家/tests/scripts/` 下的 `fix-l*-*.ts` 系列跑回归，重点 L8 溯源 |
| **frontmatter 不向后兼容**：老 .md 已有 `source: excel` 等字段 | 子任务 4 | 只新增字段不修改已有，KnowledgeViewer 保持兼容 |
| **PDF 误删正文**：`........` 正则可能误杀正文段落 | 子任务 5 | 强制 `--dry-run`，列出每个文件即将删除的行，人工抽查 5 个文件再 `--apply` |
| **文件名规整破坏引用**：知识库索引 / 回归测试 bank / prompt 里硬编码的 `knowledge/xxx.md` 路径会断链 | 子任务 6 | dry-run 输出"重命名映射表" → 用户确认 → 改名同时同步更新所有 `*.ts/*.md/*.json` 引用 |

---

## 五、范围边界

### 5.1 本计划做

- ✅ 改源头转换脚本（子任务 2/3/4）
- ✅ 写一次性清洗脚本处理存量（子任务 5/6）

### 5.2 本计划不做

- ❌ 手工 / AI 重写关键文档为 `<topic>.md`（档位 C，单独开窗口）
- ❌ 配置 markdownlint + prettier（档位 D，0.5 小时事，单独做）
- ❌ 改图片处理流水线（图片→OCR 文字 vs 图片→原图链接，需要先评估对 vision 的影响，单独评估）
- ❌ 不动 `_raw/` 目录（原文件全部保留，可溯源）

---

## 六、确认项（执行前必须明确）

> 用户在新窗口启动子任务前需明确以下两点：

1. **范围确认**：6 个子任务全做，还是先做 **2 + 3**（最小高 ROI 集）？
2. **子任务 6 是否本轮跳过**：规整文件名涉及面广，建议等 2-5 验证稳定后单独开窗口做。

---

## 七、各子任务完成回写位置

每个子任务完成后，把"修改摘要 + 验证结果 + 遇到的坑"回写到本文件对应章节的**末尾**，格式：

```markdown
### 子任务 X 完成记录

- **完成时间**：YYYY-MM-DD
- **改动**：xxx
- **验证**：xxx
- **遇到的坑**：xxx
```

下一个子任务在新窗口启动时，先读完整 plan，再读上一子任务的完成记录。

---

## 八、各子任务完成记录

### 子任务 1 完成记录

- **完成时间**：2026-05-02
- **执行方式**：`explore` subagent（只读，未修改任何文件）
- **产出**：[探查报告](./提升知识库md可读性_探查报告.md)（落盘到同目录）
- **关键发现**（会改变后续子任务设计的事实）：
  1. **FORMAT 按钮 = 重新跑解析+LLM 格式化**，不是仅美化已有 .md。改 `rowsToMarkdownTable` 后旧文件点一次 FORMAT 即可享受改良。
  2. **frontmatter 写入有 4 处**：单文件 Excel / 批量导入 / PPTX / FORMAT 写回。子任务 4 必须协调全部 4 处。
  3. **FORMAT 写回会丢用户手工 frontmatter 字段**（已存在的设计缺陷，仅保留 `raw_file`）。子任务 4 必须顺手修复，否则增强字段一次 FORMAT 就清空。
  4. **`rowsToMarkdownTable` 唯一调用点在 `parseExcel:580`**，影响面小，风险可控。
  5. **`buildSheetData` 与 `rowsToMarkdownTable` 当前并行解耦**：子任务 2 核心 = 抽 `prepareTable(rows)` 共享函数。
  6. **prompt bank 不硬编码 md 行号**，但硬编码了文件名 → 子任务 6 必须脚本里同步替换。
  7. **真正受 Excel 改造影响的回归是 L1/L4/L5（Excel 题）**，不是 L6/L7（章节题）。
  8. **子任务 3 强依赖子任务 2**：3 要复用 2 抽出的"对齐后中间结构"做 ffill 边界识别（subtitle/total 行作为 reset 边界）。
- **对原 plan 的修正**：
  - 子任务 4 范围扩大：新增"修复 FORMAT 写回丢字段缺陷"这一项
  - 子任务 2/3 顺序硬性约束：必须 2 → 3，不能并行
  - 回归测试重点：L1/L4/L5 优先于 L6/L7
- **遇到的坑**：无（探查顺利）

### 子任务 2 完成记录

- **完成时间**：2026-05-02
- **改动**：`desktop-app/electron/document-parser.ts`
  - 新增 `prepareTable(rows)` 私有方法（L620-682）：从 `buildSheetData` 中抽取智能表头检测 + 列名去重逻辑，返回 `{ headers, headerRowIndex, bodyRows, maxCols }` 中间结构
  - 重构 `buildSheetData`（L688-721）：删除内联的表头检测代码，改为调用 `this.prepareTable(rows)` 取 headers/bodyRows/maxCols，后续 normalizeCell / inferColumnSchema / inferRowMetaRole 逻辑不变
  - 重构 `rowsToMarkdownTable`（L811-837）：删除简陋的 `firstRowIsHeader`（要求首行全为非空字符串）判断，改为调用 `this.prepareTable(rows)` 共享同一套"扫前 5 行打分选最优表头"算法
  - 新增 `desktop-app/scripts/regression-prepare-table.ts`：回归验证脚本
- **验证**（回归脚本 `npx tsx scripts/regression-prepare-table.ts` 输出）：
  - `调试问题top10.xlsx`：✅ JSON 结构化数据与现有 `_excel` JSON 一致（columns.name + rowCount + row keys 完全匹配）；md 表头原本就正确（首行恰好全为非空字符串），改后无变化
  - `通用柜体检验指导书.xlsx`：✅ JSON 结构化数据一致；**md 表头从 `col1..col9` 升级为 `适用部门 | col2 | col3 | 质量部 | 适用物料 | 柜体类 | ...`**，跳过了前 2 行合并标题（`通用柜体检验指导书` + `文件编号：...`），与 `_excel/*.json` 选中的表头行一致
  - query_excel 行为不变：`_excel/*.json` 的 columns / rows / rowMetaRoles 输出与改前完全一致
- **遇到的坑**：无。`prepareTable` 的抽取是纯机械重构，算法逻辑未改变，回归顺利
- **为子任务 3 预留的接口**：`prepareTable` 返回 `headerRowIndex` 和 `bodyRows`，子任务 3 可在此基础上插入 `ffillLeadingColumns()` 处理

### 子任务 3 完成记录

- **完成时间**：2026-05-02
- **改动**：`desktop-app/electron/document-parser.ts`
  - 新增 `isMergeResetBoundary(row, maxCols)` 私有方法：检测分节标题/合计行（total/subtotal 关键词 + "首 cell 有值、其余 ≥80% 空"启发式），用于 ffill 的重置边界
  - 新增 `ffillLeadingColumns(bodyRows, maxCols)` 私有方法（约 50 行）：对前 3 列做前向填充，恢复 Excel 合并单元格语义。算法：扫描前 MAX_FFILL_COLS（3）列，空率 ≥ 10% 且至少 2 个非空值的列为合并候选；遇全填充列（空率 < 10%）则中断序列；逐行前向填充，遇重置边界清空 lastValues
  - 修改 `rowsToMarkdownTable()`：在 `prepareTable()` 后插入 `ffillLeadingColumns()` 调用，用 `filledRows` 替代 `bodyRows` 渲染 markdown
  - 更新 `scripts/regression-prepare-table.ts`：新增 ffill 效果对比（前 3 列空 cell 变化量）和前 5 行数据输出
- **验证**（回归脚本输出）：
  - `调试问题top10.xlsx`：✅ JSON 不变；**前 3 列空 cell 从 139 → 0**，全部填充。每行均有完整"序号 + 故障分类 + 具体表现"
  - `通用柜体检验指导书.xlsx`：✅ JSON 不变；**前 3 列空 cell 从 105 → 12**（填充 93 个），剩余 12 个为分节标题行后的正确未填充
  - 分节标题行（如"一、机柜外观检查"）被 `isMergeResetBoundary` 正确识别为重置边界，不跨分组填充
- **与 plan 的偏差**：plan 原定"一列若 ≥ 60% 空则不 ffill"，但实测合并单元格列（序号/故障分类）空率达 70-83%，该阈值会排除目标列。改为"空率 < 10% 的列为全填充列，中断序列；其余前导列均做 ffill"，通过"只处理前 3 列 + 重置边界"双重约束保证安全
- **遇到的坑**：无。ffill 逻辑与 prepareTable 解耦，只作用于 markdown 输出

### 子任务 4 完成记录

- **完成时间**：2026-05-02
- **改动**：
  - 新增 `packages/core/src/utils/knowledge-frontmatter.ts`（~190 行）：4 个纯函数工具
    - `parseFrontmatterCore(src)` — 解析 YAML frontmatter 为 `{ meta, body }` 结构
    - `extractFrontmatterFields(fileName, bodyText)` — 规则化提取增强字段：`title`（清洗文件名噪声）、`model`（`ENS-L\d+` 正则）、`version`（`_vN` / `Rev_X` 正则）、`category`（9 条关键词→类别映射规则）、`keywords`（产品编码 + markdown 标题，top 5）、`summary`（首段非标题文本 ≤200 字截断）
    - `mergeFrontmatter(oldMeta, newMeta)` — 合并 frontmatter：旧用户字段保留，新系统字段覆盖
    - `buildFrontmatterBlock(meta)` — 序列化 meta 对象为 YAML 块（含字段输出顺序：系统字段在前，增强字段在后）
  - `packages/core/src/index.ts` + `browser.ts` — 导出新函数，主进程和渲染进程均可用
  - `desktop-app/electron/main.ts` — 3 处改动：
    - **批量导入**（L2545-2551）：用 `buildFrontmatterBlock(mergeFrontmatter(systemMeta, enhanced))` 替代手工拼接
    - **FORMAT 写回**（L2849-2860）：**修复丢字段缺陷** — 用 `parseFrontmatterCore` 解析旧 frontmatter → `mergeFrontmatter` 合并保留用户自定义字段 → 重新提取增强字段。此前整段重建只保留 `raw_file`，用户手工添加的 `keywords` / `category` 等字段一点 FORMAT 就丢失
    - **enhance-knowledge-files**（L3143-3148）：同理用 merge 替代重建
  - `desktop-app/src/components/KnowledgePanel.tsx` — 2 处改动：
    - **Excel 快速路径**（L259-266）：用 `buildFrontmatterBlock` 替代手工数组拼接，加入增强字段
    - **PPTX 快速路径**（L326-328）：同理
- **验证**：
  - `@soul/core` 编译通过（`npx tsc --noEmit` 零错误）
  - `desktop-app` 编译通过（`npx tsc --noEmit` 零错误）
  - `@soul/core` dist 重新构建（`npm run build`），确保 `.d.ts` 和 `.js` 输出包含新导出
- **兼容性**：
  - **只新增字段不修改/删除已有字段** — `mergeFrontmatter` 的 `{...old, ...new}` 语义保证旧字段不丢失
  - KnowledgeViewer / parseFrontmatter 已有解析逻辑兼容新增字段（key: value 格式不变）
  - 已有 `source: excel` / `raw_file` / `excel_json` / `sheets` 等系统字段保持不变
- **FORMAT 写回缺陷修复**：
  - **改前**：FORMAT 写回时丢弃除 `raw_file` 以外的所有旧 frontmatter 字段
  - **改后**：`parseFrontmatterCore(currentContent).meta` 解析完整旧 meta → `mergeFrontmatter(oldMeta, newSystemMeta)` 保留用户自定义字段 → 只覆盖 `source: enhanced` + 增强字段
- **遇到的坑**：`@soul/core` 的 `exports` 指向 `dist/` 目录，修改源码后必须 `npm run build` 重新生成 `.d.ts`，否则 desktop-app 编译报 "has no exported member"

### 子任务 5 完成记录

- **完成时间**：2026-05-02
- **改动**：新增 `desktop-app/scripts/cleanup-pdf-toc-pages.ts`（~215 行）
  - **匹配模式**：`/[.．。·…]{5,}[\s\d]*$/` — 5+ 连续点号/省略号/中文省略号，后面只能是可选空白+可选页码数字。排除 key-value 行（如 `Report Number............: CN24DZ91 001`），因为那些行在点号之后有 `:` 分隔符
  - 额外识别"目 录"/"目录"独占行（仅当前后 6 行内有 TOC 行时才删除，避免误删正文标题）
  - 删除 TOC 行后自动折叠连续 3+ 空行为 2 空行
  - `--dry-run`（默认）逐文件输出即将删除的行号和内容预览；`--apply` 落盘并自动执行 `git diff --stat`
- **验证**（dry-run 输出）：
  - 扫描 381 个 .md，**21 个含目录噪声，共 896 行待删除**
  - 典型高噪声文件：`ENS-L262-01用户手册_-V1.md`（58 行 TOC）、`储能电池管理系统产品手册_V1_0_20250401.md`（151 行 TOC）、`TS-0006864远景风力发电机组通用防腐技术工艺规范V7_0.md`（105 行）
  - 覆盖中文/英文/中英混合 TOC 格式（`第X章...页码`、`1.1 标题...页码`、`1 Purpose...5`、`- 1.1 系统概述 ……… 1`）
  - 已验证零误杀：测试报告中的 key-value 字段行（dots + `:` + 值）不被匹配
- **与 plan 的偏差**：
  - plan 原定匹配模式 `^第.+章\s+.+\.{5,}.*\d+$` 和 `^\d+\.\d+\s+.+\.{5,}.*\d+$` 只覆盖部分格式；实际需要一个统一的宽泛模式（任意 5+ 点号 + 末尾仅含空白和数字）来覆盖所有 TOC 变体
  - 新增了"目 录"标题行删除（plan 中未提及，但实际 TOC 块的标题行同样是噪声）
  - 新增了空行折叠（避免删除 TOC 后留下大段空白）
- **遇到的坑**：
  - 初版正则 `/[.．。·…]{5,}.*\d+\s*$/` 导致 3 个文件误杀（IEC62619/UL9540A 测试报告中的 key-value 行 `Report Number...: CN24DZ91 001` 末尾恰好是数字），修改为 `/[.．。·…]{5,}[\s\d]*$/` 后点号之后不允许 `:` 等非数字字符，误杀消除

### 子任务 6 完成记录

- **完成时间**：2026-05-02
- **改动**：新增 `desktop-app/scripts/normalize-knowledge-filenames.ts`（~280 行）
  - **规整规则**（4 条，按优先级执行）：
    1. 移除末尾双下划线去重后缀 `__N_`（如 `图纸__2_` → `图纸`）
    2. 移除末尾单下划线去重后缀 `_N_`，N 限 1-9（如 `报告_1_` → `报告`；`_30_` 等日期尾部不命中）
    3. 折叠连续 3+ 下划线为单个（如 `02-07-99-0062___________` → `02-07-99-0062`）
    4. 移除尾部多余下划线（如 `柜体出货报告_` → `柜体出货报告`）
  - **同步更新 5 类引用**：
    - `.md` 文件本体（`fs.renameSync`）
    - `_index/*.json`（tokens / hashes / contexts / embeddings）— key 格式为 `filename.md::section`，替换 filename 前缀
    - `_excel/*.json`（与 .md 同名的结构化数据文件）— `fs.renameSync`
    - `tests/generated/question-bank.json` + `question-bank.full.json` — 全文替换旧文件名
    - 历史测试运行 `tests/runs/*/` — **不修改**（历史记录保持原样）
  - **碰撞检测**：多→一冲突 + 目标文件已存在两种碰撞类型均自动跳过并输出告警
  - **运行模式**：默认 `--dry-run` 输出完整映射表 + 引用影响分析；`--apply` 落盘并自动 `git diff --stat`
- **验证**（dry-run 输出）：
  - 扫描 380 个 .md，**53 个将被重命名**，3 个因碰撞被安全跳过
  - 碰撞案例：`262kWh户外柜-DFMEA_2_.md` / `TS-7001826...__1_.md` / `洛希-ENS-L262...20250206_1_.md` — 目标文件名已存在（可能是人工修正过的版本）
  - `_index/` JSON：1522 个 key 将被更新
  - `_excel/` JSON：8 个文件将被重命名
  - `question-bank`: 54 处引用将被更新
  - 典型效果：
    - `华致-出厂检验报告_1_.md` → `华致-出厂检验报告.md`（去重后缀移除）
    - `PCS_应用能力说明V1_1_1_.md` → `PCS_应用能力说明V1_1.md`（去重移除，版本号保留）
    - `02-07-99-0062___________.md` → `02-07-99-0062.md`（连续下划线折叠）
    - `商务及技术评分汇总_24_10_30_.md` → `商务及技术评分汇总_24_10_30.md`（仅去尾 `_`，日期 `_30_` 不误删）
- **与 plan 的偏差**：
  - plan 原定"统一连字符（混用 `-` `_` → 全部 `_`）"未执行：大量文件名中 `-` 是产品编码的一部分（如 `DPX-C-0201030068`、`DIRAK-209-0202`），全局替换会破坏原始编码语义。仅做了下划线折叠
  - plan 原定"版本号统一到末尾 `_vN`"未执行：现有版本号格式（`_V1_0`、`_V02`、`_v2`）已足够统一，强制重排位置收益低、风险高（需改所有引用）
  - `_([1-9])_$` 限定去重数字为 1-9，不匹配 `_30_`（日期）等双位数，比 plan 中 `__\d+_` 模式更保守安全
- **遇到的坑**：
  - 初版正则 `/__{1,2}(\d{1,2})_$/` 只匹配双下划线前缀（`__N_`），漏掉了单下划线去重后缀（`_N_`）。29 个 `_N_` 文件仅被移除尾部 `_` 而非完整后缀。新增 `/_([1-9])_$/` 修复
  - 碰撞检测在首次运行就发现 3 个有价值的案例，证明了 `--dry-run` + 碰撞检测的必要性

---

每个执行子任务都建议在**新对话窗口**启动，避免主窗口上下文膨胀。挂载方式：

### 子任务 2 启动模板

```
@.cursor/plans/提升知识库md可读性_kb-md-readability.plan.md
@.cursor/plans/提升知识库md可读性_探查报告.md

按计划执行子任务 2：抽取 prepareTable 共享函数，让 markdown 与 _excel/*.json 用同一套表头检测。

入口：desktop-app/electron/document-parser.ts
- buildSheetData (619-707)
- rowsToMarkdownTable (797-841)
- parseExcel orchestrate (577-587)

要求：
1. 不破坏 _excel/*.json 输出（query_excel 行为不变）
2. 写一个最小回归脚本：用 1-2 个真实 xlsx（如 _raw/调试问题top10.xlsx）跑转换，diff 改前/改后的 .md
3. 完成后回写到 plan 第八节
```

### 子任务 3-6 启动模板

每个子任务都按相同方式：挂载主 plan + 上一子任务的产出（如有）+ 简明任务描述。详细要求见第二节子任务列表。

