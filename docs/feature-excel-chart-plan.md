# Soul: Excel + 批量/压缩导入 + 图表技能

## Context

Soul 项目（Electron 桌面应用，AI 分身知识库）当前只支持单文件手选导入 pdf/docx/txt/md/图片，没有表格数据能力，也没有可视化能力。用户希望：

1. **知识库可吃 Excel**，并且当用户提问涉及数据可视化时，分身能产出"高级感"的图表，图表能力必须作为 Soul **skill**（markdown 技能文件）实现，视觉遵循 `/Users/cnlm007398/.cursor/agents/ued-expert.md` 的设计原则。
2. **知识库可批量导入**：支持直接选一个文件夹把里面所有支持的文件全导入，也支持选一个压缩包自动解压后把里面所有文件导入。

根据用户答复，v1 范围：
- Excel 格式：`.xlsx` + `.csv`（不支持老的 `.xls` 二进制）
- 压缩格式：`.zip` + `.tar.gz/.tgz` + `.7z` + `.rar`（全都要）
- 图表技能：安装到**所有现有 + 未来分身**（模板 + 一次性回填）
- 容量上限：档案 500 MB / 文件夹 2 GB / 单文件 80 MB / 最多 500 文件 / 最深 8 层

关键现状（来自 Phase 1 探索）：
- 知识库是**纯文件系统**，不走 DB — 放到 `avatars/{id}/knowledge/*.md` 就会被 BM25+向量 RRF 自动检索到（`packages/core/src/knowledge-retriever.ts`），**不需要改检索层**。
- 技能系统是**纯 markdown**，`SkillManager` 自动扫 `avatars/{id}/skills/`，通过 `load_skill` LLM tool 按需拉取。**不需要改 tool-router**。
- 聊天渲染 `MessageBubble.tsx` 用 `<ReactMarkdown>`，**目前没有 `components` prop**，加 `components={{code}}` 即可拦截特殊代码块。
- UI 主题是像素风（`px-bg` `px-primary` `font-game`），图表必须用 CSS 变量读色，不能硬编码。
- `desktop-app/electron/*.ts` 用 CommonJS `require()`，新依赖必须兼容 CJS 且**纯 JS**（或平台二进制可通过 electron-builder extraResources 打包）。

---

## Approach

### 1. Excel 导入

**库**：`xlsx`（SheetJS 社区版，pin `>=0.20.3`），纯 JS 无原生依赖，同时支持 `.xlsx` 和 `.csv`。

**集成点**：`desktop-app/electron/document-parser.ts`
- 在 `parseFile` 的 extension switch（~line 75）加 `case '.xlsx'` / `case '.csv'` → `parseExcel()`。`.csv` 从 `parseText` 路径改道到 `parseExcel`，这样 csv 也享受 sheet-like 结构化处理（表头 + 表格）。
- 新私有方法 `parseExcel(filePath, fileName)`：
  1. `XLSX.readFile(filePath, { cellDates: true, cellNF: false })`
  2. 对每个 `workbook.SheetNames` 里的 sheet：
     - `sheet_to_json(sheet, { header: 1, defval: '' })` 拿二维数组
     - 第一行当表头（若全为字符串）否则生成 `col1..colN`
     - 生成 GFM markdown 表格（不额外依赖，自己写 10 行 helper）
     - 行数 > 5000 时截断并在末尾追加 `> ⚠️ 已截断至 5000 行（原 N 行）`
  3. 组装单个 markdown：
     ```
     > 导入自 Excel: {fileName} | {N} sheets | {totalRows} rows
     
     ## {sheet1Name}
     
     | col1 | col2 | ... |
     |---|---|---|
     | ...  | ...  | ... |
     
     ## {sheet2Name}
     ...
     ```
  4. 返回 `{ text, images: [], fileName, fileType: 'excel' }`
- 扩展 `ParsedDocument.fileType` 联合类型（line 12）加 `'excel'`。

**UI**：`desktop-app/src/components/KnowledgePanel.tsx` line ~192-196
- 主 filter 加 `xlsx, csv`
- 新增 filter 分组 `{ name: 'Excel 表格', extensions: ['xlsx', 'csv'] }`
- Line ~319 fileType 展示 label 增加 `'excel' → 'Excel'` 分支

**无需改动**：检索器、`formatDocument()`（Excel 已是结构化 markdown，不走 LLM 格式化）。
> 例外：`KnowledgePanel.tsx` 导入管线里现在默认对所有文件走 `formatDocument()`（LLM 重写），Excel 需要**绕过**这一步，直接写 `parsed.text` 到 `.md`。在导入管线里对 `fileType === 'excel'` 加早退分支。

### 2. 批量 / 压缩导入

**库选择**：

| 格式 | 库 | 策略 |
|---|---|---|
| `.zip` | `adm-zip` | 纯 JS，同步 API 易封装，内存占用高但 500 MB cap 内可接受 |
| `.tar.gz` / `.tgz` | `tar` (npm) + Node 内置 `zlib` | 纯 JS，流式 |
| `.7z` | `node-7z` + `7zip-bin` | 通过 `7zip-bin` 平台二进制（electron-builder `extraResources` 打包，+20 MB/平台）；node-7z spawn 子进程解压到 temp dir |
| `.rar` | `node-unrar-js` | 纯 JS WASM 端口（~400 KB），兼容 LGPL 的 unrar 源码 |

> **权衡**：.7z 为最大成本（每平台 +20 MB）。如果未来发现用户根本不用，可用"按需下载"策略替代。v1 先直接 bundle。

**新模块**：`desktop-app/electron/folder-importer.ts`（新建）
- `walkFolder(root, opts)` — BFS 遍历，硬上限：深度 8 / 文件数 500 / 总字节 2 GB / 单文件 80 MB
- Skip 列表：`node_modules`, `.git`, `.DS_Store`, `__MACOSX`, dotfiles, 未支持扩展名
- `extractArchive(archivePath, destDir)` — 按扩展名 dispatch 到 4 个解压函数
- **zip 炸弹防护**：解压前遍历 entries 累加 uncompressed size，超 1 GB 直接拒绝
- 临时目录：`app.getPath('temp') + '/soul-import-{uuid}'`，`try/finally` 里 `fs.rm({recursive, force})` 清理

**新 IPC 处理器** `desktop-app/electron/main.ts`（沿用 `wrapHandler` 模式，注册在现有 `parse-document` 附近）：
- `import-folder(avatarId, folderPath)` → `{ imported, skipped, failed }`
- `import-archive(avatarId, archivePath)` → 同上
- 进度事件：`mainWindow.webContents.send('knowledge-import-progress', { current, total, fileName, phase })`
- **主进程一把梭**：batch import 整个循环（walk → per file parse → write md → 收集结果）都在主进程，避免 N 次 IPC 往返。写完后统一触发**一次** README/retrieval index 重建。

**preload 暴露** `desktop-app/electron/preload.ts`：
- `importFolder(avatarId, folderPath): Promise<BatchResult>`
- `importArchive(avatarId, archivePath): Promise<BatchResult>`
- `onImportProgress(cb): Unsubscribe`

**UI** `KnowledgePanel.tsx`：在现有"导入文档"旁加两个按钮 — "导入文件夹"（`showOpenDialog({ properties: ['openDirectory'] })`）和 "导入压缩包"（filter 为 zip/tar.gz/7z/rar）。共用现有 `setImportProgress({ current, total, phase })`，订阅 `onImportProgress`。结果用非阻塞 toast + "查看日志" 抽屉展示每个文件的成功/跳过/失败。

### 3. 图表渲染（MessageBubble 扩展）

**库**：`echarts` + `echarts-for-react`，lazy import 以免冷启动回归。
- 纯 JS Canvas 渲染，不受 Tailwind 影响
- chart 种类最全、动画精致
- 主题对象可由 JS 构建并 `echarts.registerTheme`，完美配合 CSS 变量

**新文件 `desktop-app/src/lib/echarts-pixel-theme.ts`**：
- 读 `getComputedStyle(document.documentElement).getPropertyValue('--px-primary')` 等 5 色生成 palette
- 构建 ECharts 主题对象：`color` 数组、`textStyle`、`title.textStyle`、`xAxis/yAxis.axisLine`、`grid` 等全部用 px-* 变量
- `backgroundColor: 'transparent'`（让像素边框透出）
- `aria: { enabled: true, decal: { show: true } }`（色盲友好）
- 导出 `registerPixelTheme()` 在首次 chart 渲染前调用

**新文件 `desktop-app/src/components/ChartRenderer.tsx`**：
- 包一层像素卡片 `<div class="border-2 border-px-primary bg-px-bg p-3">`
- `React.lazy(() => import('echarts-for-react'))` + `<Suspense fallback={<pre>...</pre>}>`
- Props: `{ option: EChartsOption }`
- 捕获子组件异常（ErrorBoundary）→ fallback 显示原 JSON code block + 红框 + "图表 JSON 解析失败"
- `role="img"` + `aria-label={option.title?.text}`
- 固定 `height: 320px`，`width: 100%`（ECharts 没显式尺寸会出空图）

**`MessageBubble.tsx` 修改**（line ~100）：
```tsx
<ReactMarkdown
  remarkPlugins={REMARK_PLUGINS}
  urlTransform={safeUrlTransform}
  components={{ code: ChartCodeBlock }}  // 新增
>
```
`ChartCodeBlock` 逻辑：
- 检查 `className === 'language-chart'`
- 若是：`JSON.parse(children)` → 成功就 `<ChartRenderer option={parsed} />`；失败回退默认 `<code>`
- 其他 language：走默认渲染（让现有代码高亮不受影响）

### 4. 图表技能（Skill Markdown）

**技能文件来源**：单份 canonical 放在 `templates/skills/draw-chart.md`（新建 `templates/skills/` 目录），外加 `templates/skills/chart-from-knowledge.md`。

**安装策略**（回答用户"所有现有 + 未来分身"）：
1. **未来分身**：改 `desktop-app/src/components/CreateAvatarWizard.tsx`（如果存在）或对应创建流程，在创建新分身时把 `templates/skills/*.md` 复制进 `avatars/{new}/skills/`。*需要先 locate 创建分身的准确代码路径*。
2. **现有分身**：写一个一次性 retrofit 脚本 `scripts/retrofit-skills.ts`（新建）遍历 `avatars/*/`，若 `skills/` 里没有 `draw-chart.md` 则从 templates 复制一份。在 `package.json` 加 `"retrofit:skills": "tsx scripts/retrofit-skills.ts"`，README 提一下。首次运行一次即可。当前仓里只有 1 个分身（小堵），影响面小。

**`draw-chart.md` 内容大纲**（实现时按 `templates/skill-template.md` 的 YAML frontmatter + 章节结构）：
```yaml
---
name: draw-chart
description: 当用户需要数据可视化（柱状图/折线图/饼图/趋势/对比/占比）时生成可直接在聊天中渲染的图表
level: 核心
version: 1.0
enabled: true
---
```
正文章节：
- **触发条件**：列 "用图表"/"可视化"/"画个图"/"趋势"/"对比"/"占比" 等中文触发词
- **数据来源规则**：
  1. 优先从已检索到的知识库上下文取数据（尤其是 Excel 导入的 sheet）
  2. 若无，先调用 `search_knowledge`
  3. 若用户直接贴数据，用用户数据
  4. **严禁编造**数据
- **输出格式硬约束**：必须输出**恰好一个** ` ```chart\n{...}\n``` ` 代码块，内容为合法 ECharts option JSON。解释性文字放代码块**之前**，不得写进 JSON 里。
- **UED 设计规范**（摘自 ued-expert.md）：
  1. 禁止 3D（`series[].type` 不得用 `bar3D`/`line3D`/`surface`）
  2. Y 轴从 0 开始（除非 scatter/candlestick 明确需要）
  3. 标题 + 副标题必填
  4. 系列数不超过 5（主题 palette 只给 5 色）
  5. X 轴类目超过 12 时改用横向柱状图
  6. 颜色字段留空（让主题接管），不得硬编码 hex
  7. KPI 单值展示必须带对比值或趋势
- **Few-shot 示例**（3 组）：
  - 折线图（月度销售）
  - 饼图（品类占比）
  - 横向对比柱状图（同比）
- **失败回退**：数据不足时输出文字解释缺什么，不要输出空图表

**`chart-from-knowledge.md`** 是 thin wrapper：引用 `draw-chart`，强调 "先 search_knowledge 再 draw-chart" 的链式模式。

---

## Critical Files & Changes

| 文件 | 类型 | 变更要点 |
|---|---|---|
| `desktop-app/package.json` | 改 | 新增 `xlsx`, `adm-zip`, `tar`, `node-7z`, `7zip-bin`, `node-unrar-js`, `echarts`, `echarts-for-react`；devDeps 加 `@types/adm-zip`；electron-builder `extraResources` 引用 7zip-bin |
| `desktop-app/electron/document-parser.ts` | 改 | 第 12 行联合类型加 `'excel'`；第 ~75 行 switch 加 `.xlsx/.csv` case；新方法 `parseExcel()`；sheet→markdown helper |
| `desktop-app/electron/folder-importer.ts` | 新建 | `walkFolder`, `extractArchive`, 4 种归档 dispatch，深度/文件数/字节 cap，temp dir 生命周期 |
| `desktop-app/electron/main.ts` | 改 | 新 IPC `import-folder`, `import-archive`；进度 `webContents.send`；调用 folder-importer |
| `desktop-app/electron/preload.ts` | 改 | 暴露 `importFolder` / `importArchive` / `onImportProgress` |
| `desktop-app/src/components/KnowledgePanel.tsx` | 改 | filter 加 xlsx/csv；加两个按钮 "导入文件夹" "导入压缩包"；订阅进度事件；`fileType === 'excel'` 时绕过 `formatDocument()`；log 抽屉 |
| `desktop-app/src/components/MessageBubble.tsx` | 改 | `<ReactMarkdown>` 加 `components={{ code: ChartCodeBlock }}`；同文件或旁边新增 `ChartCodeBlock` 组件 |
| `desktop-app/src/components/ChartRenderer.tsx` | 新建 | lazy ECharts 包装 + 像素卡片 + ErrorBoundary + aria |
| `desktop-app/src/lib/echarts-pixel-theme.ts` | 新建 | CSS 变量 → ECharts theme object |
| `templates/skills/draw-chart.md` | 新建 | YAML + 6 设计规范 + 3 few-shot |
| `templates/skills/chart-from-knowledge.md` | 新建 | thin wrapper，引用 draw-chart |
| `scripts/retrofit-skills.ts` | 新建 | 一次性把 templates/skills/* 回填到所有 `avatars/*/skills/` |
| `package.json` (root or desktop-app) | 改 | 加 `retrofit:skills` script |
| `desktop-app/src/components/CreateAvatarWizard.tsx` (或等价创建流程) | 改 | 创建新分身时从 `templates/skills/` 复制技能 |

**无需改动**：`packages/core/src/knowledge-retriever.ts`、`packages/core/src/skill-manager.ts`、`desktop-app/electron/tool-router.ts`、`desktop-app/electron/database.ts`。

---

## 复用的现有代码

- `DocumentParser.parseFile` 的 switch 模式（只需加 case）
- `wrapHandler` IPC 错误封装（main.ts:93 附近）
- `KnowledgePanel.tsx` 的 `setImportProgress({ current, total, phase })` state 和 UI（line 42）
- `formatDocument()` from `@soul/core`（Excel 跳过，其他格式沿用）
- `preserveRawFile()` 用于批量导入时保留原文件
- `write-knowledge-file` IPC 写入路径
- `MAX_PARSE_FILE_BYTES` 常量（80 MB）复用于批量单文件 cap
- `REMARK_PLUGINS` / `safeUrlTransform` 继续作用于 ReactMarkdown
- `SkillManager` 自动扫描 skills/，技能文件进去就生效

---

## Verification

**手动 E2E**：

1. **Excel 单文件**：准备 `test-sales.xlsx`（2 sheets: `月度` `品类`，各 30 行），点"导入文档"选它 → 确认 `avatars/小堵-工商储专家/knowledge/test-sales.md` 被创建，含两个 `##` sheet section + GFM 表格。问分身 "12 月销售多少" → 确认从知识库命中。

2. **CSV 单文件**：导入一个 10 行 csv → 确认走 `parseExcel` 路径（生成单 sheet markdown），**不是**走老的 parseText。

3. **文件夹导入**：准备 `mixed-docs/` 含 1 pdf、1 docx、1 xlsx、1 png、1 txt、1 `.DS_Store`、1 `.exe`、1 `node_modules/` 子目录。点"导入文件夹"选它 → 确认 5 个有效文件成功导入，`.DS_Store`/`.exe`/`node_modules` 被 skip，进度条 1/5→5/5，结果抽屉列出每个文件状态。

4. **深度 cap**：构造嵌套 10 层深目录 → walker 在第 8 层停，skipped 列表含 "depth > 8"。

5. **zip 归档**：把 mixed-docs zip 起来导入 → 同 #3 的结果，且 `$TMPDIR/soul-import-*` 在导入后已被清空。

6. **tar.gz 归档**：同 zip 方式。

7. **7z 归档**：同 zip 方式。确认 7zip-bin 的平台二进制正确打包进 electron-builder 输出 (`npm run dist:mac` / `dist:win` 两平台各测一次)。

8. **rar 归档**：同 zip 方式。

9. **zip 炸弹**：构造一个 uncompressed 总和 > 1 GB 的压缩包 → 导入拒绝，temp dir 清洁，错误提示明确。

10. **坏 zip**：故意损坏一个 zip → finally 块仍清 temp dir，UI 显示用户可读错误。

11. **Chart skill happy path**：导入 Excel 后问 "用图表显示 2024 年各月销售额" → LLM 调 `load_skill('draw-chart')` → 输出 ` ```chart ` 代码块 → MessageBubble 内联渲染 ECharts 折线图，Y 轴从 0 开始，颜色为 `--px-primary`，标题/副标题齐全。

12. **Chart 格式错误**：手动给 LLM 一个坏 JSON → ErrorBoundary 接住，显示原 code block + 红框，不 crash。

13. **Chart 技能回填脚本**：`npm run retrofit:skills` → `avatars/小堵-工商储专家/skills/` 新增 `draw-chart.md` + `chart-from-knowledge.md`。

14. **未来分身**：通过 CreateAvatarWizard 创建一个新 avatar `test-avatar` → 确认新分身的 `skills/` 里自动有 draw-chart.md。

15. **回归**：既有 PDF / docx 单文件导入未被破坏；分身普通对话未被破坏；`npm run typecheck`、`npm run lint`、`npm run build` 全绿；冷启动时间回归 < 300 ms。

**风险 & 开放项**：

- 7zip-bin 给 electron-builder 打包加 ~20 MB/平台。若拒绝可降级为 "用户需先安装 7z CLI" + 运行时检测。
- LLM 对 ` ```chart ` 语言标签的服从性：小模型可能输出 ` ```json `。v1 严格只接受 `language-chart`；后续可加 "首字符是 `{` 且含 `series` 字段时 fallback" 的宽松检测。
- 批量导入期间每个文件都触发 `formatDocument()`（LLM 格式化）会非常慢，且可能触发限速。v1 可选策略：批量导入跳过 LLM 格式化（直接存原文），只对单文件保留 LLM 格式化管线。这个决定会影响用户体验，需要在实现时确认。
- `CreateAvatarWizard.tsx` 可能不存在或路径不同 — 实现时需要先 grep 确认分身创建的实际代码位置。
- `xlsx` 库有历史 CVE 噪音，务必 pin `>=0.20.3`。
