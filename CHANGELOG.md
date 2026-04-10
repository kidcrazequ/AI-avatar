# 更新日志

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
