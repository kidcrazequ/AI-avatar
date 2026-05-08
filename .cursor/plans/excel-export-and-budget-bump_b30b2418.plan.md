# Excel 导出工具 + query_excel 预算扩容

> **创建日期**：2026-05-08
> **作者**：zhi.qu
> **状态**：等待执行（窗口 A 出 plan，窗口 B 起执行子任务 1）

---

## 一、背景与根因（必读）

用户在生产环境（打包后桌面端）反馈：

> "导入两份 Excel，让分身按不同 sheet 生成有差异化内容的 Excel，分身报错并显示工具配额用尽。"

### 已确认的根因

1. **`packages/core/src/tool-budget.ts:26` `maxQueryExcelCallsPerRequest = 8`**
   - 用户任务最少需要 21 次 query_excel（2 schema + 8 共有 sheet × 2 + 3 独有 sheet）
   - 第 9 次起被 `tryConsume()` 短路，0ms 直接 return → 图2显示"7 失败"
   - LLM 收到守卫 hint 后转述为"工具配额用尽"（图3）

2. **没有"输出 Excel"工具**
   - `tool-router.ts:706-710` 的 switch case 里只有 `query_excel`（只读）
   - LLM 即便预算够，也无法把对比结果落盘成 .xlsx
   - 走 `exec_code` 写脚本理论上可行，但需要 LLM 自己生成 xlsx 序列化代码，且消耗轮次

### 知识库导入侧已验证 100% 正常（无需排查）

- 两份 Excel 都正确生成 `_excel/<basename>.json`
- system prompt 通过 `loadExcelSchemas()` 注入了 19 个 sheet 的列名
- LLM 拿到的"工具弹药"是齐的

---

## 二、已确认的最终决策（用户已 sign-off）

| # | 决策 | 值 |
|---|---|---|
| 1 | `maxQueryExcelCallsPerRequest` | **8 → 24** |
| 2 | `maxRounds`（同步调整避免挤占） | **25 → 30** |
| 3 | 新增工具 | **`export_excel`** |
| 4 | xlsx 依赖位置 | 加到 `packages/core/package.json`（保持 ToolRouter 内聚） |
| 5 | xlsx 版本 | `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`（与 desktop-app 同源） |
| 6 | 落盘位置 | `<avatar>/workspaces/<conversationId>/exports/<filename>.xlsx` |
| 7 | 单文件大小硬上限 | 10 MB |
| 8 | 单 sheet 行数硬上限 | 50_000 行 |

---

## 三、关键事实清单（避免新窗口重新探查）

### 文件位置与现状

| 关键点 | 位置 | 说明 |
|---|---|---|
| 预算定义 | `packages/core/src/tool-budget.ts:16-35` `DEFAULT_TOOL_POLICY` | 同时含 `maxRounds` 和 `maxQueryExcelCallsPerRequest` |
| ToolRouter switch | `packages/core/src/tool-router.ts:666-746` | 加 `case 'export_excel'` 的位置 |
| query_excel 实现参考 | `packages/core/src/tool-router.ts:1697-1874` | 工具方法的写法范本 |
| WorkspaceRoot helper | `packages/core/src/tool-router.ts:376-384` `getWorkspaceRoot()` | 新工具直接复用 |
| 安全工具 | `packages/core/src/utils/path-security.ts` | `assertSafeSegment` + `resolveUnderRoot` |
| BUILTIN_TOOLS 注册 | `desktop-app/src/stores/chatStore.ts:882-916`（query_excel 描述） | export_excel 加在 query_excel 后 |
| Excel 教学位置 | `packages/core/src/soul-loader.ts:248-268` | `# 可查询 Excel 数据源` 段后追加新段 |
| xlsx 在 desktop-app | `desktop-app/package.json` | `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"` |
| xlsx parseFile 用法 | `desktop-app/electron/document-parser.ts:577-642` `parseExcel()` | 写文件用法可参考 SheetJS 文档 `XLSX.utils.json_to_sheet` + `XLSX.writeFile` |

### 数值常量（packages/core/src/tool-router.ts:95-110）

```ts
const QUERY_EXCEL_DEFAULT_LIMIT = 50
const QUERY_EXCEL_HARD_LIMIT = 200
const QUERY_EXCEL_MAX_CONTENT_CHARS = 8000
```

新增 export_excel 常量（写在同一节）：

```ts
const EXPORT_EXCEL_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  // 10 MB
const EXPORT_EXCEL_MAX_ROWS_PER_SHEET = 50_000
const EXPORT_EXCEL_MAX_SHEETS = 50
```

---

## 四、子任务清单（按依赖顺序）

### 子任务 1：xlsx 依赖加到 @soul/core

**文件**：`packages/core/package.json`
**改动量**：1 行新增 + `npm install`
**新窗口推荐 prompt**：

> 在 `packages/core/package.json` 的 `dependencies` 里加一行：
> ```json
> "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
> ```
> 与 `desktop-app/package.json` 同源同版本。然后在 `packages/core` 目录跑 `npm install`，验证 `node_modules/xlsx` 存在。
> 验收：`require('xlsx')` 在 packages/core 内可用，`npm run typecheck` 通过。

---

### 子任务 2：调预算上限

**文件**：`packages/core/src/tool-budget.ts`
**改动量**：2 个数值 + 注释更新
**新窗口推荐 prompt**：

> 修改 `packages/core/src/tool-budget.ts:16-35` `DEFAULT_TOOL_POLICY`：
> - `maxRounds: 25 → 30`
> - `maxQueryExcelCallsPerRequest: 8 → 24`
> - 同步更新两处的 doc 注释，加一条"v0.9.3 调整理由：用户反馈双 Excel 多 sheet 对比任务（21+ 次 query_excel）触底"
> 验收：`packages/core/src/tests/tool-budget.test.ts` 仍通过；测试里如有写死 8 的断言要相应更新（极不可能，但要扫一眼）。

---

### 子任务 3（核心）：实现 exportExcel() 工具方法

**文件**：`packages/core/src/tool-router.ts`
**改动量**：~120 行新增 + 1 行 switch case
**新窗口推荐 prompt**：

> 在 `packages/core/src/tool-router.ts` 实现 `private exportExcel()`，位置放在 `queryExcel()`（约 1697 行）后面。
>
> **签名**：
> ```ts
> private exportExcel(
>   avatarId: string,
>   conversationId: string | undefined,
>   args: Record<string, unknown>
> ): ToolCallResult
> ```
>
> **入参（args）结构**：
> ```ts
> {
>   filename: string,           // 必填，不含 .xlsx 后缀；中文/英文/数字/-/_合法
>   sheets: Array<{
>     name: string,             // 必填，sheet 名
>     rows: Array<Record<string, string | number | null>>  // 必填，与 query_excel 返回的 rows 同结构
>   }>,
>   overwrite?: boolean         // 可选，默认 false；同名文件存在时是否覆盖
> }
> ```
>
> **行为**：
> 1. 校验 filename：`assertSafeSegment(filename, 'filename')` + sanitize：`filename.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')`
> 2. 校验 sheets：非空数组、长度 ≤ `EXPORT_EXCEL_MAX_SHEETS = 50`
> 3. 每个 sheet：name 非空且去重；rows 长度 ≤ `EXPORT_EXCEL_MAX_ROWS_PER_SHEET = 50_000`
> 4. 落盘路径：通过 `getWorkspaceRoot(avatarId, conversationId)` 拿到 workspace，在下面建 `exports/` 子目录，写入 `<filename>.xlsx`
> 5. 用 `XLSX.utils.json_to_sheet(rows)` + `XLSX.utils.book_append_sheet` + `XLSX.writeFile` 写盘
> 6. 写盘后 `fs.statSync` 检查大小，超 `EXPORT_EXCEL_MAX_FILE_SIZE_BYTES = 10 MB` 立即删除并返回错误
> 7. 不允许覆盖已有同名文件（除非 `overwrite: true`）
>
> **返回 content（JSON 字符串）**：
> ```json
> {
>   "success": true,
>   "file_path": "exports/对比结果.xlsx",
>   "absolute_path": "/Users/.../workspaces/<convId>/exports/对比结果.xlsx",
>   "sheet_count": 3,
>   "total_rows": 27,
>   "file_size_bytes": 12480,
>   "_usage": "文件已落盘到当前对话工作区。在主回答末尾告知用户文件路径，用户可在桌面端「设置 → 打开工作区目录」中查看。"
> }
> ```
>
> **switch case 注册**（在 ~707 行附近）：
> ```ts
> case 'export_excel':
>   result = this.exportExcel(avatarId, conversationId, args); break
> ```
>
> **常量**（加到 `tool-router.ts:95-110` 的 query_excel 常量节附近，与之并列）：
> ```ts
> const EXPORT_EXCEL_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024
> const EXPORT_EXCEL_MAX_ROWS_PER_SHEET = 50_000
> const EXPORT_EXCEL_MAX_SHEETS = 50
> ```
>
> **xlsx import**：在 `tool-router.ts` 顶部加 `import * as XLSX from 'xlsx'`（确保子任务 1 已完成）。
>
> **JSDoc 头**：写明 @author zhi.qu @date 2026-05-08，方法 doc 解释为什么需要这个工具（query_excel 只读，对比/分析输出需要落盘）。

---

### 子任务 4：BUILTIN_TOOLS 注册 export_excel 描述

**文件**：`desktop-app/src/stores/chatStore.ts`
**改动量**：~40 行新增
**新窗口推荐 prompt**：

> 在 `desktop-app/src/stores/chatStore.ts` 的 `BUILTIN_TOOLS` 列表里 `query_excel`（约 882-916 行）后面加 `export_excel` 描述。
>
> **关键描述措辞**（直接写进 description）：
> ```
> 把 query_excel 查到的数据 / 对比结果 / 分析结论落盘为 .xlsx 文件，供用户下载。
>
> 何时用：用户明确要求"输出 Excel / 导出 Excel / 生成 Excel 报告 / 把对比结果存成文件"时。
> 何时不用：单纯展示对比结论用 markdown 表格就够，不要为了用而用。
>
> 与 query_excel 的关系：本工具不读数据，只写。rows 必须由你从 query_excel 结果里整理出来。
>
> 落盘位置：当前对话的工作区 exports/ 目录，文件名你自己起（中文/英文/数字/-/_合法）。
> 调用后请在主回答末尾用一句话告知用户文件路径。
> ```
>
> **parameters schema**：与子任务 3 的入参定义保持完全一致（filename / sheets / overwrite）。
> 验收：在 desktop-app 里 `npm run typecheck` 通过。

---

### 子任务 5：system prompt 教学

**文件**：`packages/core/src/soul-loader.ts`
**改动量**：~15 行新增
**新窗口推荐 prompt**：

> 在 `packages/core/src/soul-loader.ts` 的 `# 可查询 Excel 数据源` 段（约 248-268 行）后面新加一节：
>
> ```markdown
> ## Excel 输出工作流
>
> 当任务包含「对比 / 差异 / diff / 输出 Excel / 导出 Excel / 生成 Excel 报告」时，按此流程执行：
> 1. 先用 `query_excel({mode:"schema", file, sheet})` 拿到所有相关 sheet 的列结构（schema 不计入 24 次精确查询预算的"试探"，但仍占预算 1 次）
> 2. 用 `query_excel`（不带 mode）做精确查询，把要对比的行拉下来（注意预算 24 次/轮）
> 3. 在主回答中先用 markdown 表格展示对比结论，让用户先看到答案
> 4. 调 `export_excel({filename, sheets:[{name, rows}, ...]})` 把结构化结果落盘
> 5. 在回答末尾告知用户："已输出到 workspaces/<conversationId>/exports/<filename>.xlsx，可在桌面端「设置 → 打开工作区目录」查看"
>
> 严禁：跳过 export_excel 直接说"我已生成 Excel 文件"——没调工具就是没生成，属于幻觉。
> ```
>
> 注入位置在 `stableParts` 的拼接末尾（与现有 `# 可查询 Excel 数据源` 同级）。
> 验收：手动 grep `Excel 输出工作流` 出现在生成的 system prompt 里；现有 soul-loader 测试不破坏。

---

### 子任务 6：单元测试

**文件**：`packages/core/src/tests/tool-router.export-excel.test.ts`（新文件）
**改动量**：~150 行新增
**新窗口推荐 prompt**：

> 创建 `packages/core/src/tests/tool-router.export-excel.test.ts`，参考 `packages/core/src/tests/tool-budget.test.ts` 的风格。覆盖：
>
> 1. ✅ 单 sheet 正常导出：rows = 10 条，验证文件存在 + xlsx 反向解析能读回相同数据
> 2. ✅ 多 sheet 导出：3 个 sheet 各 5 条，验证 sheet 名 + 行数正确
> 3. ❌ filename 含路径分隔符（`../etc/passwd`）：抛错被 assertSafeSegment 拦截
> 4. ❌ sheets 为空数组：返回 error
> 5. ❌ 单 sheet 超 50_000 行：返回 error，不写盘
> 6. ❌ sheet 数超 50：返回 error
> 7. ❌ 同名文件存在且未传 overwrite=true：返回 error
> 8. ✅ overwrite=true 时允许覆盖
> 9. ❌ 缺 conversationId：返回 error
> 10. ✅ filename 含中文：sanitize 后落盘成功
>
> 测试用 `node --test`，临时目录用 `os.tmpdir()` + uuid。
> 验收：`npm run test` 全部通过；测试结束后清理临时目录。

---

### 子任务 7：CHANGELOG

**文件**：`CHANGELOG.md`
**改动量**：~15 行新增
**新窗口推荐 prompt**：

> 在 `CHANGELOG.md` 顶部 `## Unreleased` 段下新增一节：
>
> ```markdown
> ## v0.9.3 (2026-05-08)
>
> ### 新功能
>
> - **`packages/core/src/tool-router.ts`** — 新增 `export_excel` 工具：
>   - 把 query_excel 查到的数据/对比结果落盘为 .xlsx，供用户下载
>   - 落盘位置：`<avatar>/workspaces/<conversationId>/exports/<filename>.xlsx`
>   - 单文件硬上限 10 MB，单 sheet 行数上限 50_000，sheet 数上限 50
>   - 解决用户反馈"对比两份 Excel 后无法输出 Excel"的能力缺失
>
> ### 调整
>
> - **`packages/core/src/tool-budget.ts`** — 工具预算扩容：
>   - `maxQueryExcelCallsPerRequest`：8 → 24（用户反馈双 Excel 多 sheet 对比触底）
>   - `maxRounds`：25 → 30（同步扩容，避免 query_excel 占满后挤掉 export_excel / load_skill）
>
> ### 项目治理
>
> - **`desktop-app/package.json`** — 0.9.2 → 0.9.3
> - **`packages/core/package.json`** — 新增 xlsx 依赖（与 desktop-app 同源 `cdn.sheetjs.com/xlsx-0.20.3`）
> ```
>
> 同时把 `desktop-app/package.json` 的 version 0.9.2 → 0.9.3。

---

## 五、执行流（强烈建议遵守）

> ⚠️ **不要在主窗口（plan 窗口）继续执行**，按 efficient-workflow 规则用新窗口逐子任务推进。

```
窗口 A（plan 完成，已交付）
  ↓
窗口 B：执行子任务 1 + 2（依赖+预算调整，最简单先做完）
  ↓ 跑通 typecheck，回写本 plan 的"执行记录"
窗口 C：执行子任务 3（核心 exportExcel 实现）
  ↓ 跑通 typecheck，回写本 plan
窗口 D：执行子任务 4 + 5（前端注册 + system prompt 教学）
  ↓ 跑通 typecheck
窗口 E：执行子任务 6（测试）
  ↓ 跑通 npm run test
窗口 F：执行子任务 7（CHANGELOG）+ 整体回归
```

每个窗口完成后，请在本 plan 文件末尾"## 六、执行记录"里追加一行：

```markdown
- [子任务 X] 窗口 ID xxx，完成时间 2026-05-08 HH:MM，验收：xxx 通过
```

---

## 六、执行记录

- [子任务 3] 完成时间 2026-05-08 14:38，验收：
  - `packages/core/src/tool-router.ts` 顶部新增 `import * as XLSX from 'xlsx'`
  - `query_excel` 限流常量节后并列新增三个 export_excel 常量：`EXPORT_EXCEL_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024` / `EXPORT_EXCEL_MAX_ROWS_PER_SHEET = 50_000` / `EXPORT_EXCEL_MAX_SHEETS = 50`，附设计动机注释（避免单文件撑爆磁盘 / 序列化阻塞 / Excel 客户端打不开）
  - `execute()` 主 switch 在 `case 'query_excel'` 后新增 `case 'export_excel'`，调用 `this.exportExcel(avatarId, conversationId, args)`
  - `queryExcel()` 后新增 `private exportExcel()` 实现（~140 行）：
    - 入参校验：`filename` 非空字符串 → `assertSafeSegment` 拦截 `/`/`\`/`..` → 正则 sanitize `[^a-zA-Z0-9\u4e00-\u9fa5_-]` → sanitize 后非空校验
    - sheets 校验：非空数组、长度 ≤ 50；每个 sheet：name 非空字符串、≤ 31 字符（Excel 硬上限）、跨 sheet 去重；rows 数组、长度 ≤ 50_000、每个元素必须是对象（拒绝数组/null）
    - 落盘：`getWorkspaceRoot(avatarId, conversationId)` 拿 workspace 根 → `resolveUnderRoot(workspaceRoot, 'exports')` 防穿越 → `mkdirSync({recursive:true})` → `resolveUnderRoot(exportsDir, '<safeFilename>.xlsx')` 二次防穿越
    - 已存在文件：`overwrite !== true` 时返回 error；为 true 时 `XLSX.writeFile` 直接覆盖（xlsx 库行为）
    - 写盘：`XLSX.utils.book_new()` → `XLSX.utils.json_to_sheet(rows)`（空 sheet 走 `aoa_to_sheet([[]])` 兜底防 json_to_sheet 抛错） → `book_append_sheet` → `writeFile`
    - 写盘失败：try/catch 清理半成品（防止下次 overwrite=false 误判）
    - 大小校验：`fs.statSync().size` 超 10 MB 立即 `unlinkSync` 并返回 error
    - 返回：`{success, file_path: 'exports/<name>.xlsx', absolute_path, sheet_count, total_rows, file_size_bytes, _usage}` JSON
    - JSDoc 头标注 `@author zhi.qu @date 2026-05-08`，含设计动机 + 6 层安全模型说明
  - `cd packages/core && npm run typecheck` → exit 0
  - `cd packages/core && npx tsc` 实际编译 → exit 0，`dist/tool-router.js` 生成成功
  - **运行时 smoke test 全部通过**（基于 dist 编译产物 + 真实 xlsx 库 + 临时 workspace）：
    - [1] 基本导出：2 sheet × 2/1 rows（含中文 sheet 名 + 中文列名 + 中文文件名）→ xlsx 反向解析能读回完全相同的数据，sheet 顺序正确
    - [2] 重复写入：未传 overwrite 时返回 `目标文件已存在: exports/对比结果.xlsx（如需覆盖请传 overwrite: true）`
    - [3] overwrite=true：成功覆盖
    - [4] 路径穿越：`filename: "../etc/passwd"` 被 `assertSafeSegment` 拦截，error: `非法filename，不能包含路径分隔符或 ..`
    - [5] sheets 空数组：error: `sheets 必须为非空数组`
    - [6] 缺 conversationId：error: `缺少 conversationId，无法定位 workspace`
  - **未引入新 lint 错误**（ReadLints 干净）；项目级 ESLint v10 缺 `eslint.config.js` 是预存在配置缺失，与本子任务无关，子任务 1/2 验收同样未跑 lint
  - 后续子任务前置条件：子任务 4（chatStore.ts 注册 BUILTIN_TOOLS 描述）、子任务 6（独立单元测试文件）需基于本实现继续推进
- [子任务 3 - 验收复核] 窗口 C，时间 2026-05-08 14:42，按用户更高标准（`npm run quality` 必须 0 警告通过）补充验证：
  - **`npm run quality` 实际无法运行**：`packages/core/package.json` 声明 `eslint@^10.2.0` + `"lint": "eslint src/ --max-warnings 0"`，但仓库根目录、`packages/core/`、HEAD（`git ls-tree HEAD`）均无 `eslint.config.js` / `.eslintrc.*`；ESLint v9+ 强制需要 flat config。`FINAL_EXIT=2`（typecheck OK，lint 阶段失败）。这是 **HEAD 即存在的项目级配置缺失**，不在子任务 3 范围内
  - **借用 desktop-app 同款 flat config 临时跑单文件 lint 检查子任务 3 自身代码质量**（临时 `eslint.config.mjs` 已删除，未污染仓库）：
    - 修复前发现 8 个问题（4 errors + 4 warnings）：其中 7 个全部位于子任务 3 未触碰的代码（`469/582/661/1078/1486/1500/1529` 行，HEAD 已存在），**1 个由子任务 3 引入**：`2040:9 no-useless-assignment - The value assigned to 'fileSizeBytes' is not used`（`let fileSizeBytes = 0` 后立即在 try 中重赋值，初值未读取）
    - **已修复**：`let fileSizeBytes = 0` → `let fileSizeBytes: number`（保持类型推断 + 仅在 try 内首次赋值）
    - 修复后再次 lint：剩余 7 个问题全部为 HEAD 预存在，子任务 3 自身代码 **0 errors 0 warnings**
    - 修复后重跑 smoke test 通过（`file_size_bytes: 15977`，文件正常落盘）
  - **结论**：子任务 3 自身代码已达到 lint 0 警告标准；仓库级 `npm run quality` 阻塞为预存在的 ESLint flat config 缺失，需独立立项修复（建议在 `packages/core/` 添加 `eslint.config.mjs` 并清理 7 个预存在 lint 问题，但属另一子任务，不应在子任务 3 范围内顺手做，会违反"不要修改其他工具的实现"约束）
- [子任务 4] 窗口 D，完成时间 2026-05-08 14:44，验收：
  - `desktop-app/src/stores/chatStore.ts` 在 `query_excel`（约 882-916 行）后追加 `export_excel` 项（46 行新增）
  - description 用模板字面量保留多行排版，逐字采用 plan 子任务 4 给定原文（"何时用 / 何时不用 / 与 query_excel 的关系 / 落盘位置"4 段）
  - parameters schema 与子任务 3 入参完全一致：`filename: string` (required) + `sheets: array<{name, rows}>` (required) + `overwrite: boolean` (optional, default false)；sheet items 用 nested `type:object` schema，rows 用 `array<object>`
  - `npm run typecheck` 通过（exit 0）
  - `npm run quality` 阻塞：仅 typecheck 通过，lint 在 HEAD 已存在 49 errors + 28 warnings；通过 `git stash` 验证：剥离本子任务改动后错误数完全相同（77 problems → 77 problems），本子任务**未引入任何新的 lint 错误**
  - ReadLints 干净（IDE 端 0 警告 0 错误）
  - 项目级 `quality` 通过需先治理 HEAD 预存在的 49 个 lint 错误（涉及 `electron/main.ts` / `electron/document-parser.ts` / `electron/exporters/*` 等多个非本子任务文件的空 catch 块、`require()` 风格 import、`!=` 用法等），属另一子任务范围，不在"不修改其他文件"约束允许范围内
- [子任务 5] 窗口 D，完成时间 2026-05-08 14:44，验收：
  - `packages/core/src/soul-loader.ts` 在 `# 可查询 Excel 数据源` 段（`if (excelSchemas.length > 0)` 块内的 `## 可用 Excel 清单` forEach 末尾）追加 9 行（包含 `## Excel 输出工作流` 标题 + 5 步流程 + 严禁条款），与现有 `## Excel 查询纪律` 同级共享 if 条件（无 Excel 数据源时不注入，避免误导）
  - 内容逐字采用 plan 子任务 5 给定原文（5 步流程：schema → query_excel → markdown 表格 → export_excel → 告知文件路径）
  - grep 验证：`Excel 输出工作流` 在 `soul-loader.ts:267` 命中 1 行（要求 ≥ 1 行）
  - `npm run typecheck` 通过（exit 0）
  - `npm run lint` 阻塞为 ESLint v9 flat config 缺失（与 子任务 3 - 验收复核 同根因，HEAD 预存在），子任务 5 自身代码无 lint 问题
  - ReadLints 干净
- [子任务 6] 窗口 E，完成时间 2026-05-08 14:52，验收：10/10 测试通过
  - 新增 `packages/core/src/tests/tool-router.export-excel.test.ts`（约 360 行）：使用 `node:test` 框架，临时沙盒 `os.tmpdir() + crypto.randomUUID()`，每 case 独立 `setupSandbox()` + `finally { cleanup() }`，不 mock xlsx 走真实 `XLSX.readFile` 反向解析校验
  - 10 个 case 全绿（test 8-17，与 core.test.js 共享同一 `npm run test`）：
    - case 1：单 sheet 10 行 → file_size > 0 + 反向解析数据完全一致
    - case 2：3 个 sheet 各 5 行 → sheet 顺序保持 + 每 sheet 行数与值一致
    - case 3：filename = `../etc/passwd` → 被 `assertSafeSegment` 拦截，error 含 `非法filename`，未副作用创建 exports 目录
    - case 4：sheets = `[]` → error: `sheets 必须为非空数组`
    - case 5：单 sheet 50_001 行 → error: `行数 50001 超过上限 50000`，目标文件不存在（写盘前拦截）
    - case 6：51 个 sheet → error: `sheets 数量 51 超过上限 50`，未落盘
    - case 7：第二次同名写入 → error: `目标文件已存在 ... overwrite`，原文件 size + mtime 完全未变
    - case 8：`overwrite=true` → 成功覆盖，反向解析读到 v2 数据
    - case 9：不传 conversationId → error: `缺少 conversationId`
    - case 10：filename = `对比结果(2026)` → sanitize 为 `对比结果_2026_.xlsx` 落盘，中文 sheet 名 + 中文列名往返一致
  - 同步更新 `packages/core/package.json` 的 `test` / `test:all` 脚本，把新测试文件加入 `node --test` 入参
  - `cd packages/core && npm run build` exit 0，`cd packages/core && npm run test` exit 0：`# tests 41 # pass 41 # fail 0`（含 core.test.js 31 个 + export-excel 10 个）
  - `npm run quality` 中 typecheck 通过；lint 失败为 ESLint flat config 缺失（HEAD 预存在，与子任务 3 验收复核 / 子任务 4 / 子任务 5 同根因，本子任务未引入新 lint 问题）
  - ReadLints 干净（IDE 端 0 警告 0 错误）
  - **未修改 tool-router.ts 实现**（严格遵守"禁止修改实现让测试好过"约束）

---

## 七、回滚方案

- 子任务 2（预算调整）回滚：把数字改回 8 / 25 即可
- 子任务 3 实现回滚：删除 `exportExcel()` 方法 + switch case + 常量；卸载 xlsx 依赖
- 子任务 4 描述回滚：从 BUILTIN_TOOLS 移除 export_excel 项（LLM 看不到工具就不会调）
- 全量回滚：`git revert` 对应 commit

---

## 八、验收 checklist（所有子任务完成后）

- [ ] `cd packages/core && npm run quality` 通过
- [ ] `cd desktop-app && npm run quality` 通过
- [ ] `cd packages/core && npm run test` 通过（含新增 export-excel 测试）
- [ ] 桌面端 dev 启动后，导入两份 Excel，问"对比两份文件并输出差异 Excel"，验证：
  - LLM 调用 export_excel 工具
  - `workspaces/<convId>/exports/` 下出现 .xlsx 文件
  - 用 Excel/Numbers 打开文件，sheet 和行内容符合预期
- [ ] CHANGELOG 更新且 version 号同步
