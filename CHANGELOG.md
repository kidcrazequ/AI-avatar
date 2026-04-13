# 更新日志

## v0.5.1 (2026-04-13)

### Bug 修复

- **`query_excel` 返回值大小硬限制（防 context 炸）** — 用户问"215 机型..."报 187k token 错误（context 上限 131k）。诊断后发现 system prompt 实际只有 41k 字符 ≈ 10k token（rag_only 工作正常），187k 是因为 LLM 多次调 `query_excel` 不带 filter dump 出大量数据进 chat history 累积起来。修复：
  - 默认 limit `100 → 50`，硬上限 `1000 → 200`
  - 新增**返回内容字符数硬上限 8000 字符**（约 2k token），超出按行二次截断，附 `truncated_by_size: true` 和明确提示
  - 不传 filter + 不传 columns + 不传 limit 时 → **直接拒绝执行**并报错"会一次性返回整张表 N 行污染 context"
  - 工具描述强化警告：「**Excel 数据必须用此工具，禁止用 search_knowledge**」「必须用 filter 把结果缩小到几行到几十行」「画图通常 12-30 行就够了」
  - 三个新常量集中在 tool-router.ts 顶部：`QUERY_EXCEL_DEFAULT_LIMIT` / `QUERY_EXCEL_HARD_LIMIT` / `QUERY_EXCEL_MAX_CONTENT_CHARS`

- **`MAX_TOOL_ROUNDS` 5 → 10** — 修复用户提问 "215 机型 2026 年 1~3 月设备侧效率折线图" 后看到 `[系统提示] 工具调用轮数达到上限，已提前结束本轮` 但没有真正的图表回答。`query_excel` + `draw-chart` 这类组合流程典型需要 5+ 轮（load_skill 1-2 轮 + query_excel 1-2 轮 + 容错修正 1-2 轮 + 最终带 ```chart 代码块的回答），原来 5 轮上限留 0 容错就被吃完。改为 10 轮给探索和容错留余量，仍能兜底防真死循环（`chatStore.ts:MAX_TOOL_ROUNDS`）。

- **Excel 导入后 UI 卡死 / 上下文未刷新** — 修复 v0.5.0 方案 C 落地后用户反馈的 3 个连锁问题：
  - 导入大 Excel（250 KB+ 含 1000+ 行 markdown 表格）后**无法关闭知识库面板**
  - 同一文件**无法编辑**
  - 立刻发问 "生成 215 机型 2026 年 1~3 月设备侧效率折线图" **仍报 context 超限错误**

  根因：导入完成后 `handleSelectFile` 自动加载 250 KB 的 .md 到 `KnowledgeViewer`，react-markdown 渲染巨型表格阻塞渲染器 → UI 操作全部卡死；同时 `onSaved?.()` 是 fire-and-forget，没等 `loadAvatarConfig` 重建 system prompt 就返回，用户立刻发问会用旧的 stale system prompt（仍含 248k 字符的旧 Excel 内容）。

  修复（4 个文件）：
  - **`KnowledgePanel.tsx`** Excel 快速路径不再 `handleSelectFile`，且改为 `await onSaved?.()` 等 system prompt 刷新完成才返回，状态文案改为 "✓ 已导入并刷新上下文"
  - **`KnowledgeViewer.tsx`** 新增 frontmatter 解析 + 检测 `source: excel` / `rag_only: true` → 显示 Excel 数据源摘要卡片（sheets 标签 + 使用 `query_excel` 的提示），不再 react-markdown 渲染原表；同时为任何 > 50k 字符的普通文件显示截断警告 + 纯文本预览（不走 markdown 解析）
  - **`KnowledgeEditor.tsx`** Excel 文件 / > 100k 字符文件 → 显示只读提示卡片，不加载 Monaco（避免"无法编辑"问题），文案明确告知 Excel 文件应"编辑源 .xlsx 后重新导入"
  - **`document-parser.ts`** 智能表头检测：扫描前 5 行选最像表头的一行（评分 = `字符串单元格 ×2 − 数字单元格 − 空格 ×0.3`，要求填充率 ≥50% 且字符串多于数字），跳过表头行之前的所有合并标题/空行；多行 merged 表头里的 `\n` 替换为空格；同名列加 `_2`/`_3` 后缀去重。修复 v0.5.0 导入的 5 sheets 中有 4 个变成 `col1..colN` 的问题（合并单元格让 row 0 留空导致原检测失败）

### 关于"不要直接编辑 Excel 自动文件"

Excel 导入产生两份资产：`knowledge/<name>.md`（可视化）+ `knowledge/_excel/<name>.json`（结构化）。**手动编辑 .md 不会同步到 .json**，且会被下次重新导入覆盖。Viewer 和 Editor 都已加提示。如需修改数据，请编辑源 .xlsx 后重新导入。

---

## v0.5.0 (2026-04-13)

### 新功能

- **Excel / CSV 知识库导入** — 知识库现在吃 `.xlsx` 和 `.csv` 文件；每个 sheet 自动转 GFM markdown 表格（表头识别、5000 行/sheet 截断、单元格 `|` 换行转义），写入 `avatars/<id>/knowledge/<name>.md`。Excel 导入绕过 LLM 重格式化管线，因为源数据已是结构化。依赖：SheetJS (`xlsx` 0.20.3) 纯 JS 无原生模块（`document-parser.ts`：`parseExcel()` + `rowsToMarkdownTable()`）。
- **批量 / 归档导入** — KnowledgePanel 新增 `FOLDER` 和 `ARCHIVE` 按钮：
  - **文件夹** — 选一个文件夹后 BFS 递归遍历，自动过滤支持的扩展名、跳过 `node_modules`/`.git`/`.DS_Store` 等噪声、硬上限（深度 8、文件数 500、总字节 2 GB、单文件 80 MB），一把梭式在主进程批量 parse + 写入，渲染进程通过 `knowledge-import-progress` 事件实时收进度
  - **归档** — 自动识别 `.zip` / `.tar.gz` / `.tgz` / `.7z` / `.rar`，解压到 `$TMPDIR/soul-import-<uuid>`，`try/finally` 清理 temp，全链路 zip 炸弹防护（解压后总大小 > 1 GB 拒绝）和 zip slip 防护（`..`/绝对路径拒绝）
  - 批量结果抽屉展示每个文件的成功/跳过/失败明细，继续执行不因单文件失败中断
  - 批量导入跳过 LLM 格式化（保证速度，单文件导入仍享受完整管线）
  - 依赖：`adm-zip`（zip，纯 JS）、`tar`（tar.gz，纯 JS）、`node-7z` + `7zip-bin`（7z，平台二进制 asar 外打包）、`node-unrar-js`（rar，WASM 端口）
  - 新模块：`desktop-app/electron/folder-importer.ts`
- **ECharts 图表技能（draw-chart）** — 聊天中直接内联渲染高级感图表：
  - 新增 `templates/skills/draw-chart.md`，含 UED 设计硬约束（禁 3D、Y 轴从 0、标题副标题必填、系列 ≤5 色、X 类目 >12 改横向、不得硬编码颜色、KPI 单值必须带对比）+ 3 组 few-shot 示例（月度折线、品类饼图、站点横向对比）
  - 新增 `templates/skills/chart-from-knowledge.md` 串联 `search_knowledge` + `draw-chart` 的高阶技能
  - 自动安装到**所有现有分身**（通过 `scripts/retrofit-skills.ts` 幂等回填）和**未来分身**（`create-avatar` IPC 自动调 `installDefaultSkillsSync` 复制模板）
  - LLM 输出 ` ```chart ` 代码块（JSON 格式 ECharts option）由 `MessageBubble.tsx` 的 `ChartCodeBlock` 拦截，JSON 解析后交给 `ChartRenderer.tsx` 懒加载 `echarts/core` + `charts` + `components` + `renderers` 子模块渲染（首次加载后缓存）
  - 新增 `src/lib/echarts-pixel-theme.ts` — 从 tailwind `px` 色板构建 ECharts 主题（暖金/薄荷/绿/红/灰 5 色 60-30-10 palette、像素方块 symbol、暗底透明背景、color-decal 色盲友好）
  - 错误处理：JSON 解析失败降级为带红框的原 `<pre>`；渲染异常由 ErrorBoundary 兜底
  - 依赖：`echarts` 5.5 + `echarts-for-react` 3.0
- **对话消息折叠** — 助手消息超过 600 字符时自动显示 `[▼] 收起` / `[▶] 展开` 按钮，折叠态只展示前 ~300 字符（按段落/行/中文标点优先次序智能断开），附字数统计。用户消息通常较短不折叠；折叠状态放在 `chatStore` 的 `collapsedMessageIds: Set<string>`，跨 react-virtuoso 卸载/重新挂载持久（`MessageBubble.tsx` + `chatStore.ts`）。

- **Excel 作结构化数据源（query_excel 工具）** — 导入 Excel 时同时产出两份资产：
  - `knowledge/<name>.md` — GFM 表格可视化，顶部加 `rag_only: true` frontmatter，SoulLoader 跳过不拼入 system prompt（避免大 Excel 炸上下文）
  - `knowledge/_excel/<basename>.json` — 结构化数据（schema + 全量行对象数组），供 `query_excel` 工具使用
  - `SoulLoader` 在 system prompt 中只拼入 Excel **schema 摘要**（列名 / 类型 / 范围 / samples），不拼入原始行数据
  - 新增 `query_excel` 工具（`packages/core/src/tool-router.ts`）：支持 MongoDB 风格 filter（`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`）、列选择、行数上限（默认 100，硬上限 1000）
  - `chatStore.ts` 的 `AVATAR_TOOLS` 注册 `query_excel` 为新 LLM tool
  - `templates/skills/draw-chart.md` 与 `chart-from-knowledge.md` 新增 query_excel 用法示例
  - 新增 frontmatter 解析器（`soul-loader.ts` 内联，~40 行，不引 yaml 依赖）
  - 新 IPC：`write-excel-data(avatarId, basename, data)` 把结构化 JSON 落盘到 `knowledge/_excel/`
  - **解决的实际问题**：用户导入 248k 字符的"产品质量指标 dashboard" Excel 后，第一次对话就撞破 Qwen-Plus 131k context 限制（报 173k token invalid_request_error）。方案 C 后，同一份 Excel 在 system prompt 中只占几百字 schema，用户问「215 机型 2026 年 1~3 月设备侧效率折线图」时 LLM 直接 `query_excel` 精确过滤 3 行数据，配合 `draw-chart` 技能生成折线图。

### 改进

- **分身创建流程** — `CreateAvatarWizard` 创建新分身时，`create-avatar` IPC 在写完用户自定义技能后自动把 `templates/skills/*.md` 复制到新分身的 `skills/`，不覆盖同名文件（保护用户自定义）
- **electron-builder 打包配置** — 新增 `asarUnpack` 规则把 `7zip-bin` 平台二进制和 `node-unrar-js` WASM 文件从 asar 包内解出，让运行时可正常执行
- **ESLint 配置修复** — `eslint.config.js` 重命名为 `eslint.config.mjs`，修复 `"type": "commonjs"` 下 ESM import 无法加载的问题，`npm run lint` 现在可以正常运行

### 代码质量

- 新增 IPC 通道：`import-folder` / `import-archive` / `install-default-skills`
- 新增 IPC 事件：`knowledge-import-progress`
- `ParsedDocument.fileType` 扩展 `'excel'` 类型 + 新增 `sheetNames?: string[]` 字段
- `SUPPORTED_PARSE_EXTENSIONS` 从 `document-parser.ts` 导出供 `folder-importer.ts` 复用，作为文件过滤 single source of truth
- `installDefaultSkillsSync()` 幂等：已存在的技能不会被覆盖
- 所有新增 `.ts`/`.tsx` 文件通过 `npm run typecheck` 和 `npm run lint` 零错误零警告
- 修复触及的既有文件中几处历史 lint 问题（`main.ts` 合并 `import type`、空 catch 块加 void 标记；`KnowledgePanel.tsx` 合并 `import type`、补 useEffect 依赖；`MessageBubble.tsx` 合并 react import）

---

## v0.4.0 (2026-04-10)

### 新功能

- **分身头像系统** — 支持预置像素头像和自定义上传头像，创建分身时可选头像，已有分身可通过选择器下拉菜单「换头像」（`AvatarImage`、`AvatarPicker`、`DefaultAvatars`）
- **AI 消息气泡头像** — 对话中 AI 消息左侧显示分身头像和名称，替代原来的"专家"通用标签
- **像素风导航栏** — 顶栏导航重构为 RPG 菜单风格 tab 导航，带图标、光标动画和徽章（`PixelNavBar`）
- **版本号动态注入** — 设置面板底部显示实际版本号（通过 Vite define 注入 `__APP_VERSION__`）

### 改进

- **窗口尺寸优化** — 默认窗口调大至 1280×820，最小尺寸提升至 1024×680，适配更多内容
- **提示词模板面板重构** — 从内联弹窗重构为 Modal + PanelHeader 组件化，交互更统一
- **知识面板进度增强** — 异步任务（百科编译、知识自检）增加计时器和不定进度条，操作过程可感知
- **设置面板文案优化** — 用面向用户的友好语言替换技术术语（如"注入百科到 RAG"→"回答时参考百科"）
- **用户画像面板** — PanelHeader 增加 EDIT 按钮，空状态引导文案更清晰
- **设置面板 Tab** — 左侧标签栏支持滚动，修复 Tab 过多时被截断的问题

### 代码质量

- `AvatarManager` 新增 `saveAvatarImage` / `getAvatarImage` 方法和 `parseImageDataUrlBase64` 静态工具
- 新增头像相关单元测试（data URL 解析、头像保存）
- 新增 IPC 通道：`save-avatar-image`、`get-avatar-image`
- CSS 新增像素导航标签组件样式（`.pixel-nav-*`）和不定进度条动画

---

## v0.3.0 (2026-04-10)

### 新功能

- **提示词模板库** — 创建/编辑/填充模板，一键套用到输入框（`PromptTemplatePanel`）
- **用户画像面板** — 管理分身对用户的了解（`UserProfilePanel`）
- **技能建议卡片** — 技能创建建议确认交互（`SkillProposalCard`）
- **定时任务调度器** — 统一调度记忆整理、知识检查、定时自检（`CronScheduler`）
- **LLM 工厂** — 抽取 LLM/Embedding 调用为可复用工厂（`llm-factory.ts`）
- **记忆管理器** — 容量统计、LLM 自动整理、阈值预警（`memory-manager.ts`）
- **子代理管理** — 任务委派与并行执行（`sub-agent-manager.ts`）
- **数据库自动备份** — 定期备份 SQLite 数据文件
- **对话导出** — 支持导出会话为文件
- **消息全文搜索** — SQLite FTS5 全文索引 + 触发器自动同步
- **虚拟滚动** — react-virtuoso 优化长对话渲染性能

### 重构

- 删除 `deepseek.ts`，统一走 LLM Service（OpenAI 兼容接口）
- 面板状态从多个 boolean 重构为单一 `activePanel` 枚举
- Zustand 使用 `useShallow` 避免不必要的重渲染
- DB schema 升级至 v4：预编译 Statement 缓存、提示词模板表、WAL 模式
- 抽取公共工具到 `@soul/core`：`fetchWithTimeout` / `assertSafeSegment` / `resolveUnderRoot` / `localDateString`

### 代码质量

- 新增 ESLint + TypeScript-eslint 配置（`desktop-app` & `packages/core`）
- 新增 `typecheck` / `lint` / `quality` npm scripts
- 新增 `CONVENTIONS.md` 编码约定 + `.cursor/rules` 工作区规则
- IPC 敏感参数日志脱敏（apiKey 等不再写入日志）
- 错误处理增强：初始化失败弹窗提示、统一 Error 类型守卫

### 清理

- 删除 `desktop-app/build/ios-icons/`（Electron 不使用的 iOS 图标）
- 删除 `PHASE*_VERIFICATION_REPORT.md`（5 个过时的阶段验证报告）
- 删除 `TEST_PLAN.md`、`auto-test-fix-loop.js`、`main.d.ts` 等过时文件
- 删除根目录旧版 CLI 测试脚本（`test-avatar.sh` / `generate-knowledge-tests.sh` / `batch-generate-knowledge-tests.sh`），已被桌面端测试系统替代
- 删除 `docs/phases/`（已完成的开发阶段计划）和 `docs/desktop-app-implementation-plan.md`（初始实施方案）
- 删除 `deploy/wechat-bot/`（未完成的企业微信机器人草稿，缺少核心模块）
- 删除 `plans/`（空目录）
- 清理磁盘构建产物：`release/`（2.1 GB）、`dist/`、`dist-electron/`、`test-output/`、`.DS_Store` 等

### 文档

- 架构设计文档更新至 v1.2：同步代码实际状态，补充提示词模板/用户画像/定时任务/数据备份/对话导出/子代理委派等模块

---

## v0.2.0 (2026-04-09)

### 新功能：知识百科融合（Karpathy Wiki 思想）

在保持 Soul 的无损保真和精确溯源优势的前提下，引入 Karpathy LLM Wiki 的知识积累和自演化能力。所有功能默认关闭，通过设置开关或手动触发启用，不影响现有回答结果。

#### Phase 1 — 百科基础层

- **原始文件保留** — 导入文档时自动将原始 PDF/Word/图片复制到 `knowledge/_raw/`，确保 source of truth 可追溯
- **实体提取** — 基于词频 × 跨文件分布的本地算法，从知识库中识别高频技术实体
- **概念页生成** — 为跨文件实体调用 LLM 生成聚合概念页，保存到 `wiki/concepts/`
- **知识自检（Lint）** — LLM 矛盾检测 + 内容指纹重复检测，报告保存到 `wiki/lint-report.json`
- **知识库面板** — 新增 WIKI 和 LINT 按钮，手动触发编译和自检

#### Phase 2 — 深度融合

- **Wiki 注入 RAG** — 设置中新增 WIKI Tab，启用"注入百科到 RAG"开关后，RAG 检索同时搜索 `wiki/concepts/` 概念页作为补充参考
- **答案手动沉淀** — 助手消息气泡上 hover 显示 SAVE 按钮，一键将优质问答沉淀到 `wiki/qa/`
- **答案自动沉淀** — 设置中开启后，满足启发式规则的高质量回答（长度 > 300 字、含来源引用）自动保存
- **知识演化检测** — 导入新文件后自动检测与已有知识的差异（新增/更新/矛盾），在状态栏显示差异统计
- **概念页交叉引用** — 百科编译后自动为概念页生成 `## 相关概念页` 反向链接段落

### 新增核心模块

- **WikiCompiler** (`packages/core/src/wiki-compiler.ts`) — 知识百科编译器，封装实体提取、概念页生成、交叉引用、知识自检、答案沉淀、知识演化检测全部逻辑
- **KnowledgeRetriever.getFullChunks()** — 提供完整 chunk 数据供外部模块使用

### 改进

- **设置面板** — 新增 WIKI Tab（注入百科到 RAG 开关 + 自动沉淀开关 + 功能说明）
- **消息气泡** — 助手消息支持 hover 显示 SAVE 按钮
- **知识树** — `KnowledgeManager.buildTree` 跳过 `_` 前缀目录（`_index`、`_raw`），知识树更简洁
- **RAG 增强** — `retrieveAndBuildPrompt` 支持可选 `wikiChunks` 参数注入百科参考

### Bug 修复

- 修复 `KnowledgePanel.tsx` 中 `fileType === 'docx'` 类型比较错误（应为 `'word'`）
- 修复 `soul-validator.ts` 中未使用的 `patterns` 变量导致的编译警告
- 修复 `chatStore.ts` 中 `.at()` 方法不可用的 TypeScript 兼容性错误（tsconfig target/lib 升级到 ES2022）

### 文档

- 新增 `docs/architecture.md` 完整架构设计文档（v1.1），涵盖工程结构、进程模型、数据流、RAG Pipeline 全链路、Karpathy 方法对比与融合方案

### 技术细节

- 新增 IPC 通道：`compile-wiki`、`get-wiki-status`、`get-concept-pages`、`read-concept-page`、`lint-knowledge`、`get-lint-report`、`save-wiki-answer`、`get-wiki-answers`、`preserve-raw-file`、`detect-evolution`、`get-evolution-report`
- 变更文件：16 个文件，新增 626 行，其中 `wiki-compiler.ts` 为全新模块（~780 行）
- 安全保证：所有 wiki 数据存放在独立的 `wiki/` 目录，不修改 `knowledge/` 中的任何文件；SoulLoader、KnowledgeRetriever、现有 RAG 完全无感知

---

## v0.1.0 (2026-04-03)

### 初始版本

- Electron + React + TypeScript + Vite 桌面应用
- @soul/core 核心 SDK：SoulLoader、KnowledgeRetriever（BM25 + 向量 RRF 融合）、ToolRouter、DocumentFormatter
- 多模型支持：Chat / Vision / OCR / Creation 四类独立配置
- RAG Pipeline：三通道知识注入（全量 System Prompt + 精准检索 + 工具按需补充）
- 知识导入：PDF/Word/图片解析 → OCR → LLM 格式化 → 数值校验
- Function Calling：6 个工具函数 + 最多 5 轮调用循环
- 分身管理：创建向导、人格编辑、技能管理、记忆系统
- 测试体系：测试用例管理 + AI 评分 + 定时自检
- 像素风 UI 设计语言
