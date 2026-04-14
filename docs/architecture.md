# Soul Desktop 架构设计文档

> **版本**: v1.2  
> **作者**: zhi.qu  
> **日期**: 2026-04-10  
> **范围**: 桌面端架构设计，涵盖整体工程结构、进程模型、数据流、核心模块及技术选型  
> **更新**: v1.2 同步代码实际状态：新增提示词模板/用户画像/定时任务/数据备份/对话导出/多分身提及/子代理委派；DB schema 更新至 v4；工具列表扩展至 8 个

---

## 一、项目概览

Soul 是一个 **AI 分身专家系统**，每个"分身"是一个独立的 AI 角色，拥有自己的人格（Soul）、知识库（Knowledge）、技能树（Skills）、长期记忆（Memory）和测试体系（Tests）。

桌面端应用（`desktop-app/`）是 Soul 的主要交互入口，目标是让非技术用户也能通过图形界面创建、管理和对话 AI 分身。

### 1.1 技术栈总览

| 层级 | 技术选型 | 版本 |
|------|---------|------|
| 桌面框架 | Electron | ^41.1.0 |
| 前端框架 | React + TypeScript | React ^19.2, TS ^6.0 |
| 构建工具 | Vite（渲染进程）+ esbuild（主进程） | Vite ^8.0, esbuild ^0.27 |
| UI 样式 | Tailwind CSS | ^4.2 |
| 状态管理 | Zustand | ^5.0 |
| 本地数据库 | better-sqlite3 | ^12.8 |
| Markdown 渲染 | react-markdown + remark-gfm + react-syntax-highlighter | — |
| 代码编辑器 | Monaco Editor (@monaco-editor/react) | ^4.7 |
| SSE 解析 | eventsource-parser | ^3.0 |
| 文档解析 | pdf-parse ^2.4 + mammoth ^1.12 | — |
| 核心 SDK | @soul/core（本地 file: 引用） | 1.0.0 |
| 中文分词 | segmentit（BM25 检索用） | — |
| 打包发布 | electron-builder | ^26.8 |
| E2E 测试 | Playwright | ^1.58 |

---

## 二、整体工程结构

```
soul/
├── desktop-app/                 ← 桌面应用（Electron + React）
│   ├── electron/                ← Electron 主进程代码
│   │   ├── main.ts              ← 主进程入口、IPC 注册、窗口管理
│   │   ├── preload.ts           ← 预加载脚本（contextBridge）
│   │   ├── database.ts          ← SQLite 数据库管理（会话/消息/设置/提示词模板）
│   │   ├── document-parser.ts   ← 文档解析（PDF/Word/图片/文本）
│   │   ├── test-manager.ts      ← 测试用例管理（读写 Markdown 测试文件）
│   │   ├── scheduled-tester.ts  ← 定时自检调度器
│   │   ├── cron-scheduler.ts    ← 通用定时任务调度器（记忆整理/知识检查/定时自检）
│   │   └── logger.ts            ← 文件日志系统
│   ├── src/                     ← 渲染进程（React 前端）
│   │   ├── App.tsx              ← 应用根组件、路由调度
│   │   ├── main.tsx             ← ReactDOM 入口
│   │   ├── stores/              ← 状态管理（Zustand）
│   │   │   └── chatStore.ts     ← 对话状态 + 工具调用循环
│   │   ├── services/            ← 业务服务
│   │   │   ├── llm-service.ts   ← 统一 LLM 服务（OpenAI 兼容接口）
│   │   │   ├── test-runner.ts   ← 测试执行器
│   │   │   ├── test-generator.ts← 测试用例自动生成
│   │   │   ├── soul-validator.ts← 人格校验
│   │   │   └── soul-step-generator.ts ← 分身创建步骤生成
│   │   ├── components/          ← UI 组件
│   │   │   ├── ChatWindow.tsx   ← 对话窗口（流式输出 + 工具调用可视化）
│   │   │   ├── Sidebar.tsx      ← 侧边栏（会话列表）
│   │   │   ├── KnowledgePanel.tsx ← 知识库管理面板
│   │   │   ├── KnowledgeTree.tsx  ← 知识库文件树
│   │   │   ├── KnowledgeEditor.tsx← 知识编辑器（Monaco）
│   │   │   ├── KnowledgeViewer.tsx← 知识预览
│   │   │   ├── SkillsPanel.tsx  ← 技能管理面板
│   │   │   ├── SkillProposalCard.tsx ← 技能创建建议确认卡片
│   │   │   ├── TestPanel.tsx    ← 测试管理面板
│   │   │   ├── MemoryPanel.tsx  ← 记忆管理面板
│   │   │   ├── UserProfilePanel.tsx ← 用户画像管理面板
│   │   │   ├── SoulEditorPanel.tsx ← 人格编辑器面板
│   │   │   ├── PromptTemplatePanel.tsx ← 提示词模板库面板
│   │   │   ├── SettingsPanel.tsx← 设置面板
│   │   │   ├── AvatarSelector.tsx ← 分身切换器
│   │   │   ├── CreateAvatarWizard.tsx ← 分身创建向导
│   │   │   ├── MessageBubble.tsx← 消息气泡（含 SAVE 答案沉淀按钮）
│   │   │   ├── MessageList.tsx  ← 消息列表
│   │   │   ├── MessageInput.tsx ← 消息输入框（支持图片粘贴 + 模板填充）
│   │   │   ├── ConversationList.tsx ← 会话列表（含搜索）
│   │   │   ├── ConversationItem.tsx ← 会话列表项（含导出）
│   │   │   └── shared/          ← 共享组件（Toast, Modal, IconButton, PanelHeader）
│   │   └── global.d.ts          ← 全局类型定义（ElectronAPI 接口）
│   ├── electron-builder.yml     ← 打包配置
│   ├── vite.config.ts           ← Vite 配置
│   └── package.json             ← 依赖与脚本
│
├── packages/core/               ← @soul/core 核心 SDK
│   └── src/
│       ├── index.ts             ← 聚合导出
│       ├── soul-loader.ts       ← 分身配置加载（→ systemPrompt）
│       ├── avatar-manager.ts    ← 分身生命周期管理
│       ├── knowledge-manager.ts ← 知识库文件 CRUD
│       ├── knowledge-retriever.ts← 知识检索引擎（BM25 + 向量 RRF 融合）
│       ├── knowledge-indexer.ts ← 离线索引构建（上下文摘要 + 向量嵌入）
│       ├── skill-manager.ts     ← 技能管理（启用/禁用/解析）
│       ├── tool-router.ts       ← LLM 工具调用路由
│       ├── template-loader.ts   ← 模板加载与 prompt 构建
│       ├── document-formatter.ts← 文档格式化（逐章 LLM 重排版）
│       ├── rag-answerer.ts      ← RAG 增强（多跳检索 + prompt 构造）
│       ├── wiki-compiler.ts     ← 知识百科编译器（Karpathy 融合层）
│       ├── memory-manager.ts    ← 记忆管理（容量统计/LLM 整理/阈值判断）
│       ├── sub-agent-manager.ts ← 子代理管理（任务委派与并行执行）
│       └── utils/
│           ├── markdown-parser.ts   ← Markdown 解析工具
│           ├── ocr-html-cleaner.ts  ← OCR/HTML/PDF 文本清洗
│           └── path-security.ts     ← 路径安全校验（防路径遍历）
│
├── avatars/                     ← 分身数据目录
│   └── 小堵-工商储专家/          ← 示例分身「小堵」
│       ├── CLAUDE.md            ← 入口配置文件
│       ├── soul.md              ← 人格定义
│       ├── knowledge/           ← 知识库（.md 文件）
│       ├── skills/              ← 技能定义（.md 文件）
│       ├── memory/MEMORY.md     ← 长期记忆
│       ├── memory/USER.md       ← 用户画像
│       └── tests/               ← 测试用例与报告
│
├── templates/                   ← 分身创建模板
├── shared/knowledge/            ← 共享知识（所有分身可引用）
├── deploy/wechat-bot/           ← 微信机器人部署（Python）
└── docs/                        ← 文档
```

---

## 三、进程架构

Soul Desktop 采用 Electron 双进程架构，通过 IPC（进程间通信）实现主进程与渲染进程的解耦。

```
┌────────────────────────────────────────────────────────────────────┐
│                      Electron 主进程 (Main)                        │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │  SoulLoader   │  │ AvatarManager│  │ SkillManager │             │
│  │  (加载 prompt)│  │  (分身 CRUD) │  │ (技能管理)   │             │
│  └──────────────┘  └──────────────┘  └──────────────┘             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │KnowledgeMgr  │  │  ToolRouter  │  │TemplateLoader│             │
│  │(知识库 CRUD) │  │ (工具路由)   │  │ (模板管理)   │             │
│  └──────────────┘  └──────────────┘  └──────────────┘             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │DatabaseManager│  │ TestManager  │  │DocumentParser│             │
│  │  (SQLite)     │  │ (测试管理)  │  │ (文档解析)   │             │
│  └──────────────┘  └──────────────┘  └──────────────┘             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │   Logger      │  │ScheduledTest│  │CronScheduler │             │
│  │ (文件日志)    │  │  (定时自检) │  │ (定时任务)   │             │
│  └──────────────┘  └──────────────┘  └──────────────┘             │
│                                                                    │
│  IPC Handler（wrapHandler）统一注册 + 日志包装                      │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ IPC (contextBridge)
                              │ contextIsolation: true
                              │ nodeIntegration: false
┌─────────────────────────────┴──────────────────────────────────────┐
│                    Electron 渲染进程 (Renderer)                     │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │                    React 应用 (Vite)                      │     │
│  │                                                          │     │
│  │  ┌─────────┐  ┌─────────────┐  ┌────────────────┐      │     │
│  │  │  Zustand │  │  LLMService │  │   TestRunner   │      │     │
│  │  │(chatStore)│ │(OpenAI 兼容)│  │ (测试执行器)   │      │     │
│  │  └─────────┘  └─────────────┘  └────────────────┘      │     │
│  │                                                          │     │
│  │  ┌─────────────────────────────────────────────────┐    │     │
│  │  │               UI 组件层                          │    │     │
│  │  │  ChatWindow | Sidebar | KnowledgePanel | ...    │    │     │
│  │  └─────────────────────────────────────────────────┘    │     │
│  └──────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────┘
                              │ HTTPS (fetch)
┌─────────────────────────────┴──────────────────────────────────────┐
│                        LLM API 服务 (云端)                         │
│  DeepSeek / 通义千问 / OpenAI / Ollama（OpenAI 兼容接口）          │
└────────────────────────────────────────────────────────────────────┘
```

### 3.1 安全模型

- `contextIsolation: true`：渲染进程无法直接访问 Node.js API
- `nodeIntegration: false`：禁止渲染进程加载 Node 模块
- 所有主进程能力通过 `preload.ts` 的 `contextBridge.exposeInMainWorld` 精确暴露
- API Key 存储在 SQLite 的 `settings` 表中（由主进程管理）

### 3.2 IPC 通信设计

所有 IPC 调用采用 `invoke/handle` 模式（请求-响应），主进程通过 `wrapHandler` 函数统一包装：

```typescript
function wrapHandler(channel: string, handler: Function): void
```

`wrapHandler` 的职责：
- 自动记录操作日志（高频通道如 `save-message` 仅精简记录）
- 统一捕获异常并写入错误日志
- 将错误 re-throw 给渲染进程处理

**IPC 通道分组（共 80+ 通道/事件）：**

| 分组 | 通道示例 | 数据流向 |
|------|---------|---------|
| 分身管理 | `load-avatar`, `list-avatars`, `create-avatar`, `delete-avatar` | 渲染 → 主 |
| 会话管理 | `create-conversation`, `get-conversations`, `delete-conversation` | 渲染 → 主 |
| 消息管理 | `save-message`, `get-messages` | 渲染 → 主 |
| 知识库 | `get-knowledge-tree`, `read-knowledge-file`, `write-knowledge-file` | 渲染 → 主 |
| 记忆/人格 | `read-memory`, `write-memory`, `read-soul`, `write-soul` | 渲染 → 主 |
| 技能管理 | `get-skills`, `toggle-skill`, `update-skill` | 渲染 → 主 |
| 工具调用 | `execute-tool-call`, `search-knowledge-chunks` | 渲染 → 主 |
| RAG/索引 | `build-knowledge-index`, `rag-retrieve` | 渲染 → 主 |
| 测试管理 | `get-test-cases`, `run-tests`, `save-test-report` | 渲染 → 主 |
| 文档导入 | `show-open-dialog`, `parse-document` | 渲染 → 主 |
| 知识百科 | `compile-wiki`, `get-wiki-status`, `get-concept-pages`, `lint-knowledge`, `save-wiki-answer`, `detect-evolution` | 渲染 → 主 |
| 日志系统 | `log-event`, `get-activity-logs`, `export-error-log`, `open-logs-folder` | 渲染 → 主 |
| 定时自检 | `start-scheduled-test`, `stop-scheduled-test`, `notify-test-result` | 渲染 → 主 |
| 定时任务(Cron) | `schedule-cron`, `cancel-cron`, `get-cron-config` | 渲染 → 主 |
| 用户画像 | `read-user-profile`, `write-user-profile` | 渲染 → 主 |
| 提示词模板 | `create-prompt-template`, `get-prompt-templates`, `update-prompt-template`, `delete-prompt-template` | 渲染 → 主 |
| 数据备份/导出 | `db-backup`, `export-conversation` | 渲染 → 主 |
| 事件推送 | `scheduled-test-trigger`, `test-result-badge`, `cron-memory-consolidate`, `cron-knowledge-check` | 主 → 渲染 |

少量从主进程推送到渲染进程的通知使用 `webContents.send` + `ipcRenderer.on` 模式（如定时自检触发、测试结果红点）。

---

## 四、核心模块设计

### 4.1 @soul/core — 环境无关的核心 SDK

`@soul/core` 是整个系统的领域逻辑层，**不依赖 Electron**，可在 Node.js / CLI / 测试 等任意环境运行。桌面端通过 `file:../packages/core` 本地引用。

#### 模块依赖关系

```
                    ┌──────────────┐
                    │TemplateLoader│
                    └──────┬───────┘
                           │ 模板文本
                           ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ AvatarManager│───▶│  SoulLoader  │◀───│ SkillManager │
│ (创建/删除)  │    │ (→ prompt)   │    │ (启用/禁用)  │
└──────────────┘    └──────┬───────┘    └──────────────┘
                           │ 读取 knowledge/ + memory/
                           ▼
                    ┌──────────────┐
                    │KnowledgeMgr  │
                    │ (文件 CRUD)  │
                    └──────┬───────┘
                           │ 知识文件
                           ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│KnowledgeIndex│───▶│KnowledgeRetr │◀───│ RAGAnswerer  │
│ (离线建索引) │    │ (BM25+向量)  │    │ (多跳检索)   │
└──────────────┘    └──────┬───────┘    └──────────────┘
                           │ 检索结果
                           ▼
                    ┌──────────────┐    ┌──────────────┐
                    │  ToolRouter  │    │ WikiCompiler  │
                    │ (工具分发)   │    │ (百科编译)    │
                    └──────────────┘    └──────────────┘
```

#### 各模块职责

| 模块 | 职责 | 关键 API |
|------|------|---------|
| **SoulLoader** | 将分身目录拼接为完整 `systemPrompt`（CLAUDE.md + soul.md + knowledge + skills + memory + 回答规则） | `loadAvatar(avatarId) → AvatarConfig` |
| **AvatarManager** | 分身生命周期：列表、创建（含脚手架目录）、删除 | `listAvatars()`, `createAvatar()`, `deleteAvatar()` |
| **KnowledgeManager** | 单个分身 knowledge/ 目录的文件树、CRUD、全文搜索 | `getKnowledgeTree()`, `readFile()`, `writeFile()`, `searchFiles()` |
| **KnowledgeRetriever** | 知识检索引擎：按 `##`/`###` 切块 → 中文分词 → BM25 打分；可选加载向量嵌入做 RRF 融合排序 | `searchChunks(query, topN)` |
| **KnowledgeIndexer** | 离线索引构建：逐 chunk 调 LLM 生成上下文摘要 + 批量 Embedding；持久化到 `_index/` | `buildKnowledgeIndex()`, `saveIndex()`, `loadIndex()` |
| **RAGAnswerer** | 程序化 RAG：query embedding → BM25+向量检索 → LLM 实体抽取 → 多跳检索 → 5 规则 prompt 构造 | `retrieveAndBuildPrompt()` |
| **SkillManager** | 解析 skills/*.md，维护 `.config.json` 中的禁用列表 | `getSkills()`, `toggleSkill()`, `getEnabledSkillsContent()` |
| **ToolRouter** | LLM function calling 的本地执行端，按工具名分发到知识检索/文件读取/领域计算器 | `execute(avatarId, toolCallRequest)` |
| **TemplateLoader** | 读取 templates/ 目录，生成创建用 system prompt | `buildSoulCreationPrompt()`, `buildSkillCreationPrompt()` |
| **DocumentFormatter** | 文档切章 + 逐章 LLM 格式化重排版 | `formatDocument()`, `splitIntoChapters()` |
| **WikiCompiler** | 知识百科编译：实体提取、概念页生成、交叉引用、知识自检、答案沉淀、知识演化检测 | `compileConceptPages()`, `lintKnowledge()`, `detectEvolution()`, `sedimentAnswer()` |
| **MemoryManager** | 记忆容量统计、LLM 整理、阈值判断（是否需要整理/预警） | `consolidateMemory()`, `getMemoryStats()`, `shouldConsolidate()` |
| **SubAgentManager** | 子任务委派与并行执行，使用相同知识库但独立对话上下文 | `delegate()`, `getStatus()` |

### 4.2 主进程模块

| 模块 | 文件 | 职责 |
|------|------|------|
| **DatabaseManager** | `database.ts` | SQLite 数据库管理，含 schema 迁移机制（当前 v4）；管理会话、消息、设置、提示词模板 |
| **TestManager** | `test-manager.ts` | 读写分身 `tests/cases/*.md` 测试用例文件 |
| **DocumentParser** | `document-parser.ts` | 文件解析器：PDF（文字提取 + 图表页截图）、Word、图片、纯文本 |
| **ScheduledTester** | `scheduled-tester.ts` | 定时自检调度：定时触发 IPC 通知渲染进程运行测试 + 系统桌面通知 |
| **CronScheduler** | `cron-scheduler.ts` | 通用定时任务调度：记忆整理、知识检查、定时自检，配置持久化到 settings 表 |
| **Logger** | `logger.ts` | 文件日志系统：操作时间线 + 错误日志（按天轮转）+ 生成文档归档 |

### 4.3 渲染进程模块

| 模块 | 文件 | 职责 |
|------|------|------|
| **LLMService** | `llm-service.ts` | 统一 LLM 客户端，基于 OpenAI 兼容接口，支持流式 SSE + 工具调用增量拼接 |
| **chatStore** | `chatStore.ts` | Zustand 状态管理：消息列表、对话发送（含 RAG 增强 + 工具调用循环 + 记忆/画像自动更新 + 技能建议提取 + 答案自动沉淀） |
| **TestRunner** | `test-runner.ts` | 测试执行器：调用 LLM 获取回复 → 关键词检查 + AI 评分 |
| **App.tsx** | `App.tsx` | 根组件：分身选择/切换、面板路由、模型配置管理、定时任务事件监听 |

---

## 五、数据架构

### 5.1 数据存储分层

```
┌─────────────────────────────────────────────────┐
│                   文件系统                        │
│  avatars/{id}/                                   │
│    ├── soul.md          ← 人格定义               │
│    ├── CLAUDE.md        ← 入口配置               │
│    ├── knowledge/*.md   ← 知识库                 │
│    ├── knowledge/_raw/  ← 原始导入文件           │
│    ├── knowledge/_index/← 检索索引               │
│    │   ├── contexts.json                         │
│    │   └── embeddings.json                       │
│    ├── wiki/            ← 知识百科（Karpathy 融合）│
│    │   ├── _meta.json   ← 编译状态               │
│    │   ├── concepts/    ← 概念聚合页             │
│    │   ├── qa/          ← 沉淀的优质问答         │
│    │   ├── lint-report.json  ← 自检报告          │
│    │   └── evolution-report.json ← 演化报告      │
│    ├── skills/*.md      ← 技能定义               │
│    ├── skills/.config.json ← 技能禁用列表        │
│    ├── memory/MEMORY.md ← 长期记忆               │
│    └── tests/                                    │
│        ├── cases/*.md   ← 测试用例               │
│        └── reports/*.json ← 测试报告             │
│                                                  │
│  templates/*.md         ← 创建模板               │
│  shared/knowledge/*.md  ← 共享知识               │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│                 SQLite 数据库                     │
│  userData/xiaodu.db                              │
│                                                  │
│  conversations (id, title, avatar_id, ...)       │
│  messages (id, conversation_id, role, content,   │
│            tool_call_id, image_urls, ...)         │
│  messages_fts (FTS5 全文搜索虚拟表)               │
│  prompt_templates (id, avatar_id, title, ...)    │
│  settings (key, value)                           │
│  schema_version (version)                        │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│                   日志文件                        │
│  userData/logs/                                  │
│    ├── activity-YYYY-MM-DD.log ← 操作时间线      │
│    ├── error-YYYY-MM-DD.log    ← 错误日志        │
│    └── generated/              ← 生成文档归档     │
│        ├── index.json          ← 归档索引         │
│        └── *.md / *.json       ← 归档副本         │
└─────────────────────────────────────────────────┘
```

### 5.2 数据库 Schema

```sql
-- 会话表
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    avatar_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 消息表（级联删除）
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,           -- 'user' | 'assistant' | 'tool'
    content TEXT NOT NULL,
    tool_call_id TEXT,            -- 工具调用关联 ID
    image_urls TEXT,              -- JSON 数组（图片 base64 URL）
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- 设置表（KV 存储）
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 提示词模板表（v4 新增）
CREATE TABLE prompt_templates (
    id TEXT PRIMARY KEY,
    avatar_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- 全文搜索虚拟表（v3 新增，含同步触发器）
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');

-- Schema 版本（迁移机制）
CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1
);
```

数据库内置增量迁移机制（`runMigrations`），通过 `schema_version` 表追踪版本号（当前 v4），每次有结构变更时递增 `CURRENT_SCHEMA_VERSION` 并添加对应迁移逻辑。迁移链路：v1（基础表）→ v2（avatar_id/tool_call_id/image_urls 列）→ v3（FTS5 全文搜索）→ v4（提示词模板表）。

### 5.3 分身目录结构

```
avatars/{avatar-id}/
├── CLAUDE.md              ← 入口文件（核心约束 + 知识/技能索引）
├── soul.md                ← 人格定义（身份、背景、风格、原则、工作流、承诺）
├── knowledge/             ← 知识库
│   ├── README.md          ← 知识库索引
│   ├── *.md               ← 知识文件（用户自由组织）
│   ├── _raw/              ← 原始导入文件保留（PDF/DOCX/图片，不参与检索）
│   └── _index/            ← 检索索引（自动生成）
│       ├── contexts.json  ← 每个 chunk 的上下文摘要
│       └── embeddings.json← 每个 chunk 的向量嵌入（512 维）
├── wiki/                  ← 知识百科（Karpathy 融合层，不影响 knowledge/）
│   ├── _meta.json         ← 编译状态元数据
│   ├── concepts/          ← 实体概念聚合页（含交叉引用 backlinks）
│   ├── qa/                ← 沉淀的优质问答（手动 SAVE + 自动沉淀）
│   ├── lint-report.json   ← 知识自检报告（矛盾 + 重复）
│   └── evolution-report.json ← 知识演化检测报告（导入时生成）
├── skills/                ← 技能定义
│   ├── *.md               ← 技能文件
│   └── .config.json       ← 禁用列表 {"disabled": ["skill-id"]}
├── memory/
│   ├── MEMORY.md          ← 长期记忆（对话中自动更新 [MEMORY_UPDATE] 标签）
│   └── USER.md            ← 用户画像（对话中自动更新 [USER_UPDATE] 标签）
└── tests/
    ├── cases/*.md         ← 测试用例（Frontmatter + PROMPT/RUBRICS/MUST_CONTAIN）
    └── reports/*.json     ← 测试报告
```

---

## 六、核心数据流

### 6.1 对话流（含 RAG + 工具调用）

```
用户输入
  │
  ▼
[渲染进程] chatStore.sendMessage()
  │
  ├─ 1. 程序化 RAG 增强
  │     │
  │     └─ IPC: rag-retrieve ──▶ [主进程]
  │           │
  │           ├─ KnowledgeRetriever.searchChunks() ← BM25 + 向量 RRF 融合
  │           ├─ LLM 实体抽取 + multiHopSearch
  │           └─ 构造增强后的 user 消息 ◀── 返回
  │
  ├─ 2. 构建 API 消息列表
  │     [system: systemPrompt, ...history, user: enhancedContent]
  │
  ├─ 3. 调用 LLM（流式 SSE）
  │     LLMService.chat() ──▶ DeepSeek / Qwen API
  │     │
  │     ├─ onChunk: 实时更新 UI
  │     └─ onDone: 检查 tool_calls
  │
  ├─ 4. 工具调用循环（最多 5 轮）
  │     │
  │     ├─ 将 tool_calls 追加到消息历史
  │     ├─ 逐个执行：
  │     │   IPC: execute-tool-call ──▶ [主进程] ToolRouter.execute()
  │     │     ├─ search_knowledge    → KnowledgeRetriever
  │     │     ├─ read_knowledge_file → KnowledgeManager
  │     │     ├─ list_knowledge_files→ KnowledgeManager
  │     │     ├─ calculate_roi       → 峰谷套利 + IRR 计算
  │     │     ├─ lookup_policy       → 知识库政策检索
  │     │     └─ compare_products    → 产品对比
  │     ├─ 将工具结果追加到消息历史
  │     └─ 再次调用 LLM → 回到步骤 3
  │
  ├─ 5. 提取标签并处理
  │     ├─ [MEMORY_UPDATE]...[/MEMORY_UPDATE] → 追加写入 MEMORY.md（含容量管理）
  │     ├─ [USER_UPDATE]...[/USER_UPDATE] → 追加写入 USER.md（含容量管理）
  │     └─ [SKILL_CREATE]...[/SKILL_CREATE] → 展示 SkillProposalCard 确认卡片
  │
  ├─ 6. 自动沉淀优质回答（wiki_auto_sediment 开关控制）
  │     └─ shouldSediment() → IPC: save-wiki-answer ──▶ wiki/qa/
  │
  └─ 7. 保存消息到数据库
        IPC: save-message ──▶ DatabaseManager
```

### 6.2 知识导入流

```
用户选择文件
  │
  ▼
IPC: show-open-dialog ──▶ 系统文件选择器
  │
  ▼
IPC: parse-document ──▶ DocumentParser
  │
  ├─ .pdf  → pdf-parse（文字提取 + 图表页截图）
  ├─ .docx → mammoth（文字提取）
  ├─ .jpg  → base64 编码（供 Vision OCR）
  └─ .txt  → 直接读取
  │
  ▼
[渲染进程] KnowledgePanel
  │
  ├─ 文字清洗（cleanPdfFullText / cleanOcrHtml）
  ├─ 图表页 OCR（Vision 模型识别 → mergeVisionIntoText 融入原文）
  ├─ AI 格式化（formatDocument → 逐章 LLM 重排版）
  ├─ 用户预览/编辑
  │
  ▼
IPC: write-knowledge-file ──▶ 保存到 knowledge/
IPC: build-knowledge-index ──▶ 重建检索索引
```

### 6.2b 批量导入 + ENHANCE 补跑流

```
批量导入（快速，跳过 LLM 管线）
  │
  ├─ 用户选择文件夹 / 压缩包
  ├─ 递归扫描文件
  ├─ 逐个 parseFile → 粗文本写入 knowledge/*.md（rag_only: true）
  ├─ 原始文件保留到 knowledge/_raw/（供补跑使用）
  └─ 可选：自动触发 ENHANCE

ENHANCE 补跑（完整管线，等同单文件导入质量）
  │
  ├─ 从 _raw/ 找到原始文件 → DocumentParser.parseFile() 重新解析
  ├─ Vision OCR（图表页识别，需 OCR API Key）
  ├─ 文本清洗（cleanPdfFullText / stripDocxToc）
  ├─ Vision 结果语义融合（mergeVisionIntoText）
  ├─ LLM 逐章格式化（formatDocument）
  ├─ 数值校验（detectFabricatedNumbers 比对原文）
  ├─ 写回 knowledge/*.md（保留 rag_only: true，source: enhanced）
  └─ 统一重建检索索引（buildKnowledgeIndex）

无 _raw/ 原始文件时自动回退到旧模式（仅 LLM 格式化）
```

### 6.3 分身创建流

```
CreateAvatarWizard（向导式表单）
  │
  ├─ 步骤 1: 基本信息（名称、ID）
  ├─ 步骤 2: 人格定义
  │           └─ AI 辅助生成 → IPC: get-soul-creation-prompt
  ├─ 步骤 3: 知识文件上传
  ├─ 步骤 4: 技能定义
  │           └─ AI 辅助生成 → IPC: get-skill-creation-prompt
  │
  ▼
IPC: create-avatar ──▶ AvatarManager.createAvatar()
  │
  ├─ 创建目录结构（knowledge/ skills/ memory/ tests/）
  ├─ 写入 soul.md
  ├─ 写入知识文件
  ├─ 从模板生成 CLAUDE.md
  ├─ 生成 knowledge/README.md
  └─ 创建 memory/MEMORY.md
```

---

## 七、LLM 集成架构

### 7.1 多模型策略

系统支持配置 4 类独立模型，每类有各自的 API Key、Base URL 和模型名称：

| 模型类型 | 用途 | 默认值 |
|---------|------|--------|
| **Chat 模型** | 日常对话 | DeepSeek deepseek-chat |
| **Vision 模型** | 图片理解 | 通义千问 qwen-vl-plus |
| **OCR 模型** | 文字识别 / RAG 辅助 | 通义千问 qwen-vl-ocr |
| **Creation 模型** | 人格/技能/测试用例生成 | 通义千问 qwen-max |

所有模型均使用 **OpenAI 兼容接口**（`/chat/completions`），通过 `LLMService` 统一封装。Creation 模型未配置时自动回退到 Chat 模型。

### 7.2 LLM 调用位置分布

| 调用方 | 进程 | 用途 |
|--------|------|------|
| `LLMService.chat()` | 渲染进程 | 对话（流式 SSE + 工具调用） |
| `LLMService.complete()` | 渲染进程 | 单次请求（OCR、评估） |
| `createLLMFn()` | 主进程 | 索引构建（上下文摘要）+ RAG（实体抽取） |
| `createEmbeddingFn()` | 主进程 | 向量嵌入（text-embedding-v3，512 维） |
| `TestRunner` | 渲染进程 | 测试执行（获取 AI 回复 + 评分） |

### 7.3 Function Calling（工具调用）

系统定义了 8 个工具供 LLM 自主调用：

| 工具名 | 功能 |
|--------|------|
| `search_knowledge` | 知识库全文检索 |
| `read_knowledge_file` | 读取知识文件完整内容 |
| `list_knowledge_files` | 列出所有知识文件路径 |
| `calculate_roi` | 计算储能项目 ROI/IRR |
| `lookup_policy` | 查询省份政策/电价 |
| `compare_products` | 对比多款产品参数 |
| `load_skill` | 加载指定技能的完整定义内容 |
| `delegate_task` | 将子任务委派给独立的子代理并行执行 |

工具调用循环上限为 **5 轮**（`MAX_TOOL_ROUNDS`），防止无限循环。每轮 LLM 可同时发起多个工具调用，系统串行执行后将结果追加到消息历史。

---

## 八、知识检索架构（RAG Pipeline）

本章详细描述从用户导入原始文件，到知识库学习生成知识文件，再到用户问答时基于知识库回答的**完整链路**。

### 8.0 全链路概览

```
                         ┌─────────────────────────────────────────┐
                         │          阶段一：知识导入与学习           │
                         │                                         │
  用户文件               │  解析 → 清洗 → OCR → 格式化 → 校验      │     知识文件
  (PDF/Word/图片)  ────▶ │  DocumentParser → cleanPdf/Ocr →        │ ──▶ knowledge/*.md
                         │  Vision OCR → formatDocument →          │
                         │  detectFabricatedNumbers                │
                         └─────────────────────────────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────────────┐
                         │          阶段二：离线索引构建             │
                         │                                         │
  knowledge/*.md   ────▶ │  切块 → 上下文摘要(LLM) → 向量嵌入      │ ──▶ _index/
                         │  KnowledgeRetriever.buildChunks() →     │     contexts.json
                         │  buildKnowledgeIndex() →                │     embeddings.json
                         │  saveIndex()                            │
                         └─────────────────────────────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────────────┐
                         │          阶段三：在线问答（RAG）          │
                         │                                         │
  用户提问         ────▶ │  queryEmb → BM25 → 向量 → RRF融合 →     │ ──▶ 增强 Prompt
                         │  实体抽取 → 多跳检索 → 5规则构造         │     → LLM 回答
                         │  retrieveAndBuildPrompt()                │
                         └─────────────────────────────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────────────────────┐
                         │   补充路径：工具调用 (Function Calling)          │
                         │                                                 │
  LLM 自主决定     ────▶ │  search_knowledge / read_knowledge_file         │ ──▶ 工具结果
                         │  calculate_roi / lookup_policy 等               │     → 再次 LLM
                         │  ToolRouter.execute()                           │
                         └─────────────────────────────────────────────────┘
```

---

### 8.1 阶段一：知识导入与学习（文件 → 知识文件）

用户导入一份 PDF/Word/图片文件后，系统经过 **6 步处理**将其转化为结构化的 Markdown 知识文件。

#### 8.1.1 完整处理流程

```
用户点击 [IMPORT] 按钮
  │
  ▼
① 文件选择
   IPC: show-open-dialog → 系统文件选择器
   支持: .pdf / .docx / .doc / .txt / .md / .jpg / .png / .gif / .webp
  │
  ▼
② 文件解析 (DocumentParser — electron/document-parser.ts)
   IPC: parse-document → 主进程
   │
   ├─ PDF:  pdf-parse v2
   │   ├─ getText({ parsePageInfo: true }) → 全文 + 每页字符数统计
   │   └─ 图表页检测（页面去空白后文字 < 300 字符）→ getScreenshot(scale:2) → base64 截图
   │
   ├─ Word: mammoth.extractRawText() → 纯文本
   │
   ├─ 图片: fs.readFileSync → base64 data URL
   │
   └─ 文本: fs.readFileSync → 原始文本
   │
   返回: { text, images[], fileName, fileType, perPageChars, imagePageNumbers }
  │
  ▼
③ 图表页 OCR（Vision 模型识别 — 渲染进程）
   仅当文档包含图表页截图 且 配置了 Vision API Key 时执行
   │
   ├─ 使用 qwen-vl-max 模型（非流式调用 LLMService.complete）
   ├─ Prompt 要求识别：尺寸图(标注数值)、布局图(空间位置)、原理图(流向)、表格、接线图
   ├─ 逐张图片调用，每张独立生成 Markdown 格式的结构化数据
   └─ cleanOcrHtml() 清洗返回的 HTML:
       ├─ <table> → Markdown 表格
       ├─ <h1~h6> → # ~ ######
       ├─ <li> → - item
       ├─ <img> → 移除
       └─ 页眉页脚噪音 → 移除
  │
  ▼
④ 文本清洗 (core/src/utils/ocr-html-cleaner.ts)
   │
   ├─ cleanPdfFullText(rawText):
   │   移除 PDF 页眉页脚噪音（©公司名+页码、品牌名、页眉标题行等）
   │
   ├─ stripDocxToc(text):  (仅 Word 文件)
   │   检测并移除目录段落（"第X章 标题\t页码" 格式的行）
   │
   └─ mergeVisionIntoText(cleanedText, visionResults, perPageChars):
       将 Vision OCR 结果插入原文中**语义最匹配的章节位置**
       策略：
       ├─ 根据 perPageChars 定位每页在全文中的字符偏移范围
       ├─ 扫描前一页至当前页的所有带编号的章节标题（如 3.3.1 内部设备布局）
       ├─ 从 Vision 内容提取 CJK 关键词（≥2字的中文词），与候选标题交叉匹配评分
       └─ 得分最高的章节体末尾插入（而非机械追加页末）；未匹配到则退回页末
  │
  ▼
⑤ LLM 逐章格式化 (core/src/document-formatter.ts)
   核心理念：LLM 做"排版员"，不做"提炼者"——保留全文，只做 Markdown 格式转换
   │
   ├─ splitIntoChapters(cleanedText):
   │   程序化识别章节边界，识别三种标题模式：
   │   ├─ 「第X章 标题」/ 「第一章 标题」（中文序数）
   │   ├─ 「X.X.X 标题」（数字编号）
   │   ├─ 「一、标题」（中文序号 + 顿号）
   │   └─ 超长章节（> 6000 字符）按双空行段落二次切分
   │
   ├─ formatChapter(chapter, callLLM):  逐章调用 LLM
   │   使用模型：qwen-plus
   │   FORMAT_SYSTEM_PROMPT 约束：
   │   ├─ 严禁删减内容：原文每一句话、每一个数值都必须保留
   │   ├─ 严禁改写：不修改措辞、数值、单位
   │   ├─ 严禁概括总结
   │   ├─ 允许操作：标记标题层级(##/###)、散落参数→表格、步骤→有序列表、修正 OCR 乱码
   │   └─ maxTokens = 8192
   │
   ├─ cleanLlmOutput(raw): 清理 LLM 输出
   │   ├─ 去除 ```markdown ... ``` 代码围栏
   │   ├─ 去除开头 LLM 自述段落（"根据...规范..."）
   │   ├─ 去除尾部行动建议、签名（"小堵 敬上"、"下一步行动建议"）
   │   ├─ 去除 emoji
   │   └─ 去除 Vision 插入注释标记
   │
   └─ 拼接: header（# 标题 + 来源文档名）+ 各章节用 --- 分隔
  │
  ▼
⑥ 质量校验 + 保存
   │
   ├─ detectFabricatedNumbers(finalContent, rawText + visionText):
   │   提取 LLM 输出中的所有带单位数值（如 180N·m、50mm²、-20℃）
   │   与原始文本逐一比对，不存在的标记为疑似编造
   │   跳过小于 5 的常见数值以减少误报
   │
   ├─ IPC: write-knowledge-file → 保存到 knowledge/{baseName}.md
   │
   ├─ README.md 回填: 自动在知识库索引文件中追加新文件条目
   │
   └─ 自动触发索引构建（见阶段二）
       IPC: build-knowledge-index → 主进程
```

#### 8.1.2 处理示例

```
输入: 《远景ENS-L262用户手册.pdf》(42页)
  │
  ├─ 解析: 提取 42 页文字(~25000字) + 检测出 8 张图表页截图
  ├─ OCR:  8 张图表页 → Vision 识别(尺寸图3张、布局图2张、接线图3张)
  ├─ 清洗: 移除 42 行页眉页脚 + 8 段 Vision HTML→Markdown
  ├─ 融合: 8 段 Vision 数据按语义匹配插入对应章节末尾
  ├─ 格式化: 切成 12 个章节 → 逐章 LLM 排版(qwen-plus) → 拼接全文
  ├─ 校验: 检出 0 个疑似编造数值
  │
  输出: knowledge/远景ENS_L262用户手册.md (~30000字, 结构化 Markdown)
  后续: 自动构建检索索引（上下文摘要 + 向量嵌入）
```

---

### 8.2 阶段二：离线索引构建（知识文件 → 检索索引）

知识文件保存后，系统自动构建检索索引，为在线问答做准备。

#### 8.2.1 索引构建流程

```
knowledge/*.md（所有 .md 文件，递归子目录）
  │
  ▼
① 文档切块 (KnowledgeRetriever.buildChunks)
   │
   ├─ 递归收集 knowledge/ 下所有 .md 文件（跳过 _index/ 目录内文件）
   ├─ 按 ##/### 标题分割每个文件为 chunk
   │   正则: /^#{2,3}\s+/m
   │   无标题的文件整体作为一个 chunk（heading = 文件名）
   ├─ 超长 chunk（> 4000 字符 CHUNK_SPLIT_THRESHOLD）按双空行段落二次切分
   │   标记: heading + "（第N部分）"
   └─ 每个 chunk = { file: 相对路径, heading: 标题, content: 正文 }
  │
  ▼
② 上下文摘要生成 (buildKnowledgeIndex → Phase 1: context)
   逐 chunk 调用 LLM
   │
   ├─ 模型: qwen-turbo（快速、低成本）
   ├─ maxTokens: 100
   ├─ System Prompt (CONTEXT_PROMPT):
   │   "用 1 句话（不超过 60 字）概括本片段主题"
   │   "补充 3-5 个用户可能搜索的同义词/近义词"
   │   "不添加原文没有的数值、结论或建议"
   │
   ├─ User Prompt 包含上下文信息:
   │   文档名、上一节标题、当前标题、下一节标题、前 300 字内容
   │
   ├─ 示例:
   │   输入 chunk: "尺寸参数：高度2470mm、宽度989mm"
   │   输出: "尺寸参数包括高度和宽度数值，外形尺寸，占地面积，体积，长宽高"
   │
   └─ 生成结果注入 retriever.setContexts()
       后续 BM25 检索时，context 拼接在 heading + content 前面参与评分
       相当于为每个 chunk 添加了一层"同义词召回"
  │
  ▼
③ 向量嵌入生成 (buildKnowledgeIndex → Phase 2: embedding)
   批量调用 Embedding API
   │
   ├─ 每批 10 条（batchSize = 10）
   ├─ API: DashScope text-embedding-v3, 输出 512 维向量
   ├─ 输入文本: (context + heading + contentPreview) 截取前 500 字符
   │
   └─ 生成结果注入 retriever.setEmbeddings()
  │
  ▼
④ 持久化 (saveIndex)
   │
   ├─ knowledge/_index/contexts.json
   │   格式: { "products/xxx.md::3.3.1 内部尺寸": "一句话摘要+同义词" }
   │
   └─ knowledge/_index/embeddings.json
       格式: { "products/xxx.md::3.3.1 内部尺寸": [0.12, -0.34, ...] }  (512维)

⑤ 缓存刷新
   toolRouter.invalidateRetriever(avatarId)
   → 清除内存中的旧 retriever，下次访问自动加载新索引
```

#### 8.2.2 Chunk 数据结构

```typescript
interface Chunk {
  file: string       // 知识文件相对路径，如 "products/envision-L262.md"
  heading: string    // 章节标题，如 "3.3.1 内部设备布局"
  content: string    // 章节正文内容
  context?: string   // LLM 生成的上下文索引描述（同义词扩展层）
  tokens?: string[]  // 分词缓存（context + heading + content 的分词结果）
}

// chunk key = "file::heading"，用于索引映射和去重
```

#### 8.2.3 元数据 Chunk 过滤

检索时自动过滤以下无实质内容的 chunk：
- `content.length < 80`（过短，无信息量）
- `isMetadataChunk()` 命中：
  - README.md 文件（知识库索引文件，非专业内容）
  - 包含 ≥3 个元数据关键词（文档标题、版权信息、页码、公司标识等）的 chunk
- 这些 chunk 通常含有产品型号等高频关键词，会在 BM25 中排名虚高

---

### 8.3 阶段三：在线问答（用户提问 → 增强回答）

用户发送消息后，系统在调用 LLM 之前执行程序化 RAG 检索，将相关知识片段注入 Prompt。

#### 8.3.1 三通道知识注入

系统通过**三个互补通道**将知识库注入 LLM：

| 通道 | 注入位置 | 机制 | 特点 |
|------|---------|------|------|
| **A: 全量注入** | System Prompt | `SoulLoader.loadAvatar()` 递归读取所有 knowledge/*.md | LLM 拥有完整知识，但大量文本可能超出窗口或分散注意力 |
| **B: 精准检索** | User Message | `retrieveAndBuildPrompt()` 多跳检索 Top-12 chunk | 让 LLM 聚焦最相关片段，提升回答精准度 |
| **C: 按需补充** | Tool Results | LLM 自主调用 `search_knowledge` / `read_knowledge_file` | 覆盖 RAG 遗漏，按需深入，最多 5 轮 |

#### 8.3.2 RAG 检索详细流程 (retrieveAndBuildPrompt)

```
用户问题: "ENS-L262 的内部尺寸是多少？能放多少个电芯模组？"
  │
  ▼
Step 1: 分词 (tokenize)
   ├─ 按 ASCII/CJK 边界切分（保留型号 ENS-L262 完整不拆）
   ├─ CJK 部分用 segmentit 分词（纯 JS 中文分词器，无 native 依赖）
   ├─ 保留 ≥2 字符的 token
   └─ 结果: ["ENS-L262", "内部", "尺寸", "多少", "电芯", "模组"]
  │
  ▼
Step 2: 生成查询向量
   callEmbedding([question]) → queryEmb (number[512])
   注入 embeddingMap.set("__query__", queryEmb)
   （Embedding 失败时静默退回纯 BM25，不中断流程）
  │
  ▼
Step 3: 第一跳检索 (searchChunks, topN=8)
   │
   ├─ BM25 检索:
   │   对每个 chunk 的 (context + heading + content) 分词
   │   计算 BM25 得分:
   │     IDF = log((N - df + 0.5) / (df + 0.5) + 1)
   │     TF_norm = (tf * (k1+1)) / (tf + k1 * (1 - b + b * dl/avgDl))
   │     score = Σ(IDF * TF_norm)    [k1=1.5, b=0.75]
   │
   ├─ 向量检索（如有 embedding）:
   │   计算每个 chunk 与 __query__ 的 cosine similarity
   │
   └─ RRF 融合排序（如有 embedding）:
       rrfScore = 1/(60 + rank_bm25) + 1/(60 + rank_vector)
       候选窗口: BM25 Top-(N*10) ∪ 向量 Top-(N*10)
       返回 Top-8
  │
  ▼
Step 4: 实体抽取 (LLM)
   取第一跳 Top-5 的前 500 字 → 调用 LLM (ENTITY_EXTRACT_PROMPT)
   │
   ├─ Prompt: "从文档片段中提取所有设备名称、组件名称和技术系统名称"
   │          "只输出名称，每行一个，不加编号，最多 10 个"
   ├─ 过滤: 保留 2~20 字符的实体
   └─ 示例结果: ["电芯模组", "BMS系统", "液冷板", "PCS变流器"]
  │
  ▼
Step 5: 多跳检索 (multiHopSearch)
   │
   ├─ 第一跳: 原始查询（已完成）
   │
   ├─ 第二跳: 对每个实体分别构造查询
   │   query = "{实体} 参数 规格 技术"
   │   每个实体取 Top-5，与第一跳结果去重
   │
   └─ 合并: 第一跳全部 + 第二跳按 score 降序
       最终取 Top-15
  │
  ▼
Step 6: 构造增强 User 消息
   │
   ├─ 取 Top-12 结果，格式:
   │   【参考N·直接匹配/关联参数】来源：{file} > {heading}
   │   {content，截取前 2000 字符}
   │
   ├─ 注入 5 条答题规则 (ANSWER_RULES):
   │   1. 知识库有的数据直接引用并标注来源，不说"未提供"
   │   2. 涉及设备时搜索所有章节，合并分散信息后再判断是否缺失
   │   3. 只有确实不存在的才标注缺失
   │   4. 面积/体积同时计算含安装预留空间的总占地
   │   5. 空间布局问题额外用 ASCII 图展示
   │
   └─ 最终消息结构:
       "用户问题：{原始问题}

        以下检索结果是回答的起点，但不是你的全部知识。
        你的完整知识库在 system prompt 中，
        请同时使用检索结果和 system prompt 中的所有相关章节来回答。

        规则：1... 2... 3... 4... 5...

        检索起点：
        【参考1·直接匹配】来源：products/envision-L262.md > 3.3.1 内部尺寸
        {chunk内容}
        ---
        【参考2·关联参数】来源：products/envision-L262.md > 电芯模组规格
        {chunk内容}
        ..."
```

#### 8.3.3 BM25 算法参数与公式

```
参数:
  k1 = 1.5   (词频饱和系数，越大高频词贡献越多；通常 1.2~2.0)
  b  = 0.75  (文档长度归一化系数，0=不考虑长度，1=完全归一化)

评分公式:
  对查询中的每个词 q:
    IDF(q)      = log( (N - df(q) + 0.5) / (df(q) + 0.5) + 1 )
    TF_norm(q,d)= (tf(q,d) * (k1+1)) / (tf(q,d) + k1*(1 - b + b*|d|/avgDl))
    score      += IDF(q) * TF_norm(q, d)

  其中:
    N       = chunk 总数
    df(q)   = 包含词 q 的 chunk 数
    tf(q,d) = 词 q 在 chunk d 中出现次数
    |d|     = chunk d 的 token 数
    avgDl   = 所有 chunk 平均 token 数
```

#### 8.3.4 RRF 融合排序

当索引包含向量嵌入时，BM25 + 向量 两路结果用 **Reciprocal Rank Fusion** 融合：

```
RRF_score(d) = 1/(k + rank_bm25(d)) + 1/(k + rank_vector(d))     [k = 60]

互补性：
  BM25   → 精确关键词匹配（如型号 ENS-L262）
  向量   → 语义相似匹配（如 "占地面积" 匹配 "外形尺寸"）
  RRF    → 无需调权重即可融合两路优势
```

---

### 8.4 补充路径：工具调用（Function Calling）

RAG 是"预注入"，工具调用是"按需补充"——LLM 在回答中发现需要更多信息时可自主发起。

```
LLM 回复（含 tool_calls）
  │
  ├─ search_knowledge("液冷系统压力参数")
  │   → ToolRouter → KnowledgeRetriever.searchChunks()
  │   → 返回 Top-5 相关 chunk（使用与 RAG 相同的 BM25+向量引擎）
  │
  ├─ read_knowledge_file("products/envision-L262.md")
  │   → ToolRouter → KnowledgeRetriever.readFile()
  │   → 返回文件完整内容
  │
  ▼
工具结果追加到消息历史（role: "tool"）→ LLM 第二轮回复
... 最多 5 轮 (MAX_TOOL_ROUNDS)

ToolRouter 索引加载策略:
  getRetriever(avatarId):
    懒加载 + 缓存 → 首次访问时自动从 _index/*.json 加载 contexts + embeddings
  invalidateRetriever(avatarId):
    知识更新后清除缓存 → 下次自动重新加载
```

---

### 8.5 知识注入到 System Prompt 的完整结构

```
SoulLoader.loadAvatar() 拼接的 system prompt:

┌──────────────────────────────────────────────┐
│ CLAUDE.md  ← 入口配置（核心约束、红线）       │
│ ──────────────────────────────────────────── │
│ soul.md    ← 人格定义（身份、风格、原则）      │
│ ──────────────────────────────────────────── │
│ # 共享知识库                                  │
│ shared/knowledge/*.md（所有分身通用知识）      │
│ ──────────────────────────────────────────── │
│ # 知识库                                      │
│ <!-- 文件: knowledge/products/xxx.md -->       │
│ {完整文件内容}                                 │  ← 通道 A：全量注入
│ <!-- 文件: knowledge/policies/xxx.md -->       │
│ {完整文件内容}                                 │
│ ...（递归读取所有 .md）                         │
│ ──────────────────────────────────────────── │
│ # 长期记忆                                    │
│ memory/MEMORY.md（对话中自动更新）             │
│ ──────────────────────────────────────────── │
│ ## 回答规则（8条强制规则）                     │
│ 来源标注、禁止编造、数值准确、复述校验...       │
│ ──────────────────────────────────────────── │
│ ## 可用工具                                   │
│ search_knowledge / read_knowledge_file / ...  │
│ ──────────────────────────────────────────── │
│ ## 已启用技能                                  │
│ skills/*.md（SkillManager 过滤已禁用的）       │
└──────────────────────────────────────────────┘
```

---

### 8.6 各模块源码位置索引

| 阶段 | 模块 | 文件路径 | 关键函数/类 |
|------|------|---------|------------|
| 导入·解析 | DocumentParser | `desktop-app/electron/document-parser.ts` | `parseFile()`, `parsePdf()` |
| 导入·OCR | LLMService | `desktop-app/src/services/llm-service.ts` | `complete()` (非流式) |
| 导入·清洗 | ocr-html-cleaner | `packages/core/src/utils/ocr-html-cleaner.ts` | `cleanPdfFullText()`, `cleanOcrHtml()`, `mergeVisionIntoText()`, `stripDocxToc()` |
| 导入·格式化 | DocumentFormatter | `packages/core/src/document-formatter.ts` | `formatDocument()`, `splitIntoChapters()`, `formatChapter()` |
| 导入·校验 | ocr-html-cleaner | `packages/core/src/utils/ocr-html-cleaner.ts` | `detectFabricatedNumbers()` |
| 导入·UI 编排 | KnowledgePanel | `desktop-app/src/components/KnowledgePanel.tsx` | `handleImportDocument()` |
| 批量导入 | main.ts | `desktop-app/electron/main.ts` | `batchImportFiles()`, `import-folder`, `import-archive` |
| ENHANCE·完整管线 | main.ts | `desktop-app/electron/main.ts` | `enhance-knowledge-files` handler |
| ENHANCE·UI 编排 | KnowledgePanel | `desktop-app/src/components/KnowledgePanel.tsx` | `handleEnhanceKnowledge()` |
| 索引·切块 | KnowledgeRetriever | `packages/core/src/knowledge-retriever.ts` | `buildChunks()`, `pushChunks()` |
| 索引·摘要 | KnowledgeIndexer | `packages/core/src/knowledge-indexer.ts` | `buildKnowledgeIndex()` Phase 1 |
| 索引·向量 | KnowledgeIndexer | `packages/core/src/knowledge-indexer.ts` | `buildKnowledgeIndex()` Phase 2 |
| 索引·持久化 | KnowledgeIndexer | `packages/core/src/knowledge-indexer.ts` | `saveIndex()`, `loadIndex()` |
| 索引·IPC | main.ts | `desktop-app/electron/main.ts` | `build-knowledge-index` handler |
| 检索·BM25 | KnowledgeRetriever | `packages/core/src/knowledge-retriever.ts` | `searchChunks()`, `bm25Score()`, `tokenize()` |
| 检索·向量 | KnowledgeRetriever | `packages/core/src/knowledge-retriever.ts` | `rrfFusion()`, `cosineSimilarity()` |
| 检索·多跳 | KnowledgeRetriever | `packages/core/src/knowledge-retriever.ts` | `multiHopSearch()` |
| RAG·编排 | RAGAnswerer | `packages/core/src/rag-answerer.ts` | `retrieveAndBuildPrompt()` |
| 工具路由 | ToolRouter | `packages/core/src/tool-router.ts` | `execute()`, `getRetriever()` |
| 全量注入 | SoulLoader | `packages/core/src/soul-loader.ts` | `loadAvatar()` |
| 对话循环 | chatStore | `desktop-app/src/stores/chatStore.ts` | `sendMessage()` |
| 百科·实体提取 | WikiCompiler | `packages/core/src/wiki-compiler.ts` | `extractEntities()` |
| 百科·概念页 | WikiCompiler | `packages/core/src/wiki-compiler.ts` | `compileConceptPages()`, `buildBacklinks()` |
| 百科·自检 | WikiCompiler | `packages/core/src/wiki-compiler.ts` | `lintKnowledge()` |
| 百科·答案沉淀 | WikiCompiler | `packages/core/src/wiki-compiler.ts` | `sedimentAnswer()` |
| 百科·演化检测 | WikiCompiler | `packages/core/src/wiki-compiler.ts` | `detectEvolution()` |
| 百科·IPC | main.ts | `desktop-app/electron/main.ts` | `compile-wiki`, `lint-knowledge`, `detect-evolution` handlers |

---

## 九、前端架构

### 9.1 组件层级

```
App
├── renderAvatarSelectPage()     ← 未选分身时的引导页
│
├── Sidebar                      ← 侧边栏
│   ├── ConversationList         ← 会话列表
│   │   └── ConversationItem     ← 单个会话项
│   └── [NEW CHAT] 按钮
│
├── 顶部操作栏                    ← 分身切换 + 功能导航
│   ├── AvatarSelector           ← 分身切换下拉
│   └── NavButtons               ← [人格|技能|测试|知识库|记忆|用户|模板|设置]
│
├── ChatWindow                   ← 对话窗口
│   ├── MessageList              ← 消息列表
│   │   └── MessageBubble        ← 消息气泡（Markdown 渲染 + SAVE 按钮）
│   ├── MessageInput             ← 输入框（支持图片粘贴 + 模板填充）
│   └── SkillProposalCard        ← 技能创建建议确认卡片
│
├── KnowledgePanel (overlay)     ← 知识库管理
│   ├── KnowledgeTree            ← 文件树
│   ├── KnowledgeViewer          ← 预览
│   └── KnowledgeEditor          ← 编辑（Monaco Editor）
│
├── SkillsPanel (overlay)        ← 技能管理
├── TestPanel (overlay)          ← 测试管理
├── MemoryPanel (overlay)        ← 记忆编辑
├── UserProfilePanel (overlay)   ← 用户画像管理
├── SoulEditorPanel (overlay)    ← 人格编辑
├── PromptTemplatePanel (overlay)← 提示词模板库
├── SettingsPanel (overlay)      ← 设置
├── CreateAvatarWizard (overlay) ← 分身创建向导
└── Toast (global)               ← 全局提示
```

### 9.2 状态管理

采用 **Zustand** 进行轻量状态管理，核心 Store 为 `chatStore`：

```typescript
interface ChatStore {
    messages: ChatMessage[]         // 当前对话消息列表
    isLoading: boolean              // 是否正在等待 AI 回复
    systemPrompt: string            // 当前分身的 system prompt
    chatModel: ModelConfig           // 当前 chat 模型配置
    toolCallStatus: string           // 当前执行的工具名称（UI 状态指示）
    skillProposals: string[]         // 待确认的技能创建建议
}
```

其他状态（会话列表、分身列表、面板开关等）使用 React `useState` 管理，集中在 `App.tsx` 中。对话流程中自动提取 `[MEMORY_UPDATE]`、`[USER_UPDATE]`、`[SKILL_CREATE]` 三种标签并分别处理。

### 9.3 UI 设计风格

采用**像素风/游戏风**视觉设计语言：

- 使用像素字体（fusion-pixel）
- 方角边框（`border-2`，无圆角）
- 自定义色彩体系（`px-primary`, `px-bg`, `px-surface`, `px-border` 等 CSS 变量）
- 像素风按钮样式（`pixel-btn-primary`, `pixel-btn-outline-muted`）
- 像素网格背景（`pixel-grid`）
- 像素辉光阴影（`shadow-pixel-glow`, `shadow-pixel-brand`）

---

## 十、构建与发布

### 10.1 开发环境

```bash
# 启动开发模式（Vite + Electron 并行）
npm run dev
# 内部执行:
# 1. Vite 启动 dev server → http://localhost:5173
# 2. esbuild 编译主进程 → dist-electron/
# 3. Electron 加载 localhost:5173
```

主进程使用 `esbuild` 编译（通过 `build-electron.js` 脚本），不使用 Vite。渲染进程使用 `Vite` 构建。

### 10.2 生产构建

```bash
npm run build   # Vite 构建渲染进程 → dist/ + esbuild 编译主进程 → dist-electron/
npm run dist    # build + electron-builder 打包安装包
```

### 10.3 多平台打包

| 平台 | 格式 | 架构 | 命令 |
|------|------|------|------|
| macOS | .dmg | x64 + arm64 | `npm run dist:mac` |
| Windows | .exe (NSIS) | x64 | `npm run dist:win` |
| Linux | .AppImage | x64 | `npm run dist:linux` |

打包配置要点：
- `extraResources` 将 `templates/` 和 `shared/` 打入安装包
- `npmRebuild: true` 确保 native 模块（better-sqlite3）正确重编译
- 生产环境路径：分身数据存储在 `userData/avatars/`，模板在 `resourcesPath/templates/`

### 10.4 测试

- **E2E 测试**：Playwright（`playwright.config.ts`），覆盖完整用户旅程
- **单元测试**：Node 内置 `node:test`（@soul/core 包内），覆盖核心模块
- **AI 自检**：分身内置测试用例，支持定时/手动运行，使用 LLM 评分

---

## 十一、环境路径策略

| 路径 | 开发环境 | 生产环境 |
|------|---------|---------|
| 分身目录 | `{repo}/avatars/` | `userData/avatars/` |
| 模板目录 | `{repo}/templates/` | `resourcesPath/templates/` |
| 数据库 | `userData/xiaodu.db` | `userData/xiaodu.db` |
| 日志目录 | `userData/logs/` | `userData/logs/` |

`userData` 路径由 `app.getPath('userData')` 获取，不同平台位置不同：
- macOS: `~/Library/Application Support/soul-desktop/`
- Windows: `%APPDATA%/soul-desktop/`
- Linux: `~/.config/soul-desktop/`

---

## 十二、扩展点

| 扩展方向 | 切入点 |
|---------|--------|
| 新增 LLM 供应商 | `LLMService` 已兼容 OpenAI 接口，只需修改 `baseUrl` + `model` |
| 新增工具函数 | 在 `chatStore.ts` 的 `AVATAR_TOOLS` 添加定义 + `ToolRouter` 添加实现（当前 8 个） |
| 新增分身类型 | 在 `templates/` 添加模板文件 |
| 本地模型支持 | 指向 Ollama 的 `http://localhost:11434/v1` 即可 |
| 新增部署渠道 | 参考 `deploy/wechat-bot/`，复用 `@soul/core` SDK |
| 新增文档格式 | 在 `DocumentParser` 添加解析方法 |

---

## 附录：Soul RAG Pipeline 与 Karpathy LLM Wiki 方法对比

> Karpathy 于 2026 年 4 月发布了 [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 方法论，主张用 LLM 将原始文档"编译"成结构化 Wiki，替代传统 RAG。本节将 Soul 的 RAG Pipeline 与该方法做架构级对比。

### A.1 方法论核心差异

```
Karpathy LLM Wiki:
  原始文档 ──LLM 编译──▶ 结构化 Wiki（摘要、实体页、概念页、交叉引用）
                         └─ LLM 直接读取 Wiki 回答问题（依赖长上下文窗口）

Soul RAG Pipeline:
  原始文档 ──LLM 格式化──▶ 知识文件（保留全文，仅排版）
                          └─ 切块 + BM25/向量索引 ──▶ 检索注入 Prompt
```

| 维度 | Karpathy LLM Wiki | Soul RAG Pipeline |
|------|-------------------|-------------------|
| **核心理念** | LLM 是"编译器"：将原始材料编译成精炼的结构化知识 | LLM 是"排版员"：保留全文原貌，只做格式化，信息零丢失 |
| **知识表示** | 精炼的 Wiki 页面（摘要、实体页、概念页、交叉引用） | 格式化的完整 Markdown 文件 + BM25/向量检索索引 |
| **查询机制** | LLM 读 index.md → 找到相关页面 → 直接读取 Wiki 全文 | 三通道并行：全量 System Prompt + RAG 精准检索 + 工具按需补充 |
| **知识积累** | 有状态：每次查询的好答案可反写入 Wiki，知识复利增长 | 部分有状态：记忆系统（MEMORY.md）积累对话经验，但知识库本身不自动演化 |
| **维护机制** | Lint 操作：LLM 定期扫描 Wiki 发现矛盾、填补空白、更新交叉引用 | 无自动维护：知识文件导入后保持原样，需用户手动更新或重新导入 |
| **信息保真度** | 有损：LLM 编译过程中会提炼、概括、合并，原始细节可能丢失 | 无损：明确禁止删减/改写，保留原文每个数值和措辞 |
| **技术依赖** | 依赖长上下文窗口（100K+ tokens），无需向量数据库 | 不依赖长上下文：BM25 + 向量检索定位相关片段，兼容短窗口模型 |
| **规模适用** | 中等规模（~100 个源、~400K 词），超出后需引入搜索 | 可扩展：向量检索不受文档总量限制，知识库可无限增长 |
| **源文件处理** | 原始文件只读，LLM 永不修改（source of truth） | 原始文件解析后转换为 .md 存入 knowledge/，原始文件不保留 |

### A.2 详细架构对比

#### 文档导入阶段

| 对比项 | Karpathy LLM Wiki | Soul RAG Pipeline |
|--------|-------------------|-------------------|
| 输入保留 | `raw/` 目录保持原始文件不动，永远可追溯 | 原始文件解析后转换，不保留原始 PDF/Word |
| 处理方式 | LLM "编译"：提取关键信息 → 生成摘要页、实体页、概念页 | LLM "格式化"：全文保留 → 识别标题 → 参数整理为表格 → 步骤整理为列表 |
| 图表处理 | 依赖 LLM 多模态能力读取图片 | 专门的 Vision OCR 流程：截图 → qwen-vl-max 识别 → 按语义位置插入原文 |
| 质量校验 | 依赖 Lint 操作后续发现问题 | 即时校验：detectFabricatedNumbers 比对原文中每个数值 |
| 交叉引用 | 自动生成 Wiki 页面间的 backlinks | 无自动交叉引用，知识文件相互独立 |

#### 知识组织阶段

| 对比项 | Karpathy LLM Wiki | Soul RAG Pipeline |
|--------|-------------------|-------------------|
| 索引方式 | `index.md`：一行一条的页面摘要列表（LLM 自行浏览） | `_index/contexts.json`：每个 chunk 的上下文摘要 + `embeddings.json`：512 维向量 |
| 知识粒度 | 页面级（一个概念 = 一个 .md 页面） | Chunk 级（按 ##/### 标题切块，~4000 字符/chunk） |
| 知识关联 | 显式：Wiki 页面间通过 backlinks 互相引用 | 隐式：BM25 + 向量检索自动发现语义相关 chunk |
| 知识演化 | 支持：新源加入后 LLM 更新已有页面、增加新页面 | 不支持：新文件导入后与旧文件独立存在，不自动合并或更新 |

#### 查询阶段

| 对比项 | Karpathy LLM Wiki | Soul RAG Pipeline |
|--------|-------------------|-------------------|
| 查询流程 | LLM 读 index.md → 选择相关页面 → 读取 → 回答 | tokenize → queryEmb → BM25+向量 RRF 融合 → 实体抽取 → 多跳检索 → 5 规则 Prompt |
| 上下文占用 | 整个 Wiki 内容需放入上下文窗口 | 仅 Top-12 chunk 注入 user 消息，节省上下文空间 |
| 跨文档综合 | 天然支持：Wiki 编译时已完成跨文档综合 | 通过多跳检索（multiHopSearch）+ 实体抽取实现跨文档关联 |
| 答案复用 | 好答案可反写入 Wiki，下次直接引用 | 不反写知识库，但通过 MEMORY.md 记录关键决策和纠偏 |

### A.3 各自的优势

#### Karpathy LLM Wiki 的优势

1. **知识复利**：每次导入和查询都让 Wiki 更丰富、更关联，知识随时间指数增长
2. **跨文档综合天然强**：编译阶段已完成信息合并，无需实时做多跳检索
3. **架构极简**：无向量数据库、无 BM25 引擎、无 Embedding API 调用，只有 Markdown 文件
4. **人类可读可编辑**：Wiki 就是 Obsidian 可以浏览的 Markdown 文件，所见即所得
5. **自愈能力**：Lint 操作让 Wiki 自动发现矛盾、填补空白、保持一致性
6. **查询答案可固化**：好的回答可以变成 Wiki 页面，避免重复推理

#### Soul RAG Pipeline 的优势

1. **信息零丢失**：格式化而非提炼，原始文档的每个数值、每句话都完整保留——这对工程技术文档（如产品手册中的尺寸参数、接线规格）至关重要
2. **数值精确可溯源**：每个关键数据都要求标注来源文件和章节，并执行"引用-复述-校对"三步校验
3. **不依赖长上下文窗口**：BM25 + 向量检索只注入相关片段，兼容 DeepSeek 等 32K/64K 窗口模型
4. **规模可扩展**：向量索引不受文档总量限制，100 个文件和 10000 个文件的检索成本差异不大
5. **图表专项处理**：PDF 图表页自动截图 → Vision OCR → 按语义位置融入原文，Karpathy 方案未专门处理
6. **数值校验机制**：detectFabricatedNumbers 自动比对 LLM 输出与原文的每个技术数值，防止幻觉
7. **多通道冗余**：全量 System Prompt + RAG 精准检索 + 工具按需补充，三重保障不遗漏

### A.4 各自的劣势

#### Karpathy LLM Wiki 的劣势

1. **信息有损**：编译过程中 LLM 必然丢失细节，对需要精确数值的工程场景（如 "高度 2470.5mm"）有风险
2. **规模瓶颈**：Karpathy 自述适用于 ~100 个源/~400K 词，超出后需引入搜索——但一个产品手册就可能 30K 词
3. **编译成本高**：每个新源都要 LLM 完整阅读并更新多个 Wiki 页面，Token 消耗远大于格式化
4. **幻觉风险**：LLM 编译时可能"创造性地"推断、概括、合并信息，难以区分原始事实和 LLM 推断
5. **缺乏离线校验**：没有 detectFabricatedNumbers 这类程序化校验手段
6. **长上下文依赖**：需要 100K+ token 的模型才能一次读取整个 Wiki，限制了模型选择

#### Soul RAG Pipeline 的劣势

1. **无知识演化**：知识文件导入后是"死的"，不会随新文件的加入自动更新已有知识
2. **无交叉引用**：不同文件之间没有显式关联，跨文档综合完全依赖实时检索
3. **检索可能遗漏**：BM25 + 向量不是万能的，如果问题表述与知识文件差异太大，可能检索不到
4. **无知识复利**：每次查询的好答案不会自动沉淀为知识，下次提同样的问题仍需重新检索和推理
5. **索引构建成本**：每个 chunk 需要 LLM 生成上下文摘要 + Embedding API 调用，知识库更新后需重建全量索引
6. **全量注入冗余**：System Prompt 塞入所有知识文件，在知识库很大时既浪费 token 又可能超窗口

### A.5 适用场景对比

| 场景 | 更适合的方案 | 原因 |
|------|------------|------|
| 个人研究/学习笔记 | **Karpathy Wiki** | 知识需要跨文档综合、长期积累、不断演化 |
| 工程技术文档问答 | **Soul RAG** | 需要精确数值、来源可溯、零信息丢失 |
| 产品手册/用户手册 | **Soul RAG** | 包含大量图表、参数表、接线图，需 Vision OCR + 数值校验 |
| AI 领域研究综述 | **Karpathy Wiki** | 需要综合 50+ 论文的趋势、对比、演进脉络 |
| 企业知识库（多人协作） | **两者都不够** | Wiki 缺少并发控制，RAG 缺少知识演化 |
| 政策法规查询 | **Soul RAG** | 需要精确引用原文条款，不容忍任何改写 |
| 竞品分析/市场研究 | **Karpathy Wiki** | 需要跨多份报告综合对比、发现趋势 |

### A.6 融合方向

两种方法并非互斥，Soul 项目可以借鉴 Karpathy 的思路做以下改进：

| 改进方向 | 具体做法 | 复杂度 |
|---------|---------|--------|
| **知识演化** | 新文件导入后，LLM 自动检查与已有知识的关联，更新已有文件中的过时信息 | 中 |
| **答案沉淀** | 高质量对话回答自动归纳为知识 FAQ 页面，下次直接引用 | 低 |
| **Lint 自检** | 定期让 LLM 扫描知识库，发现矛盾（如不同文件的同一参数值不同）、标注冲突 | 中 |
| **概念索引页** | 导入文件后自动生成实体页面（如"BMS 系统"概念页，聚合所有文件中提到 BMS 的段落） | 中 |
| **保留原始文件** | 参考 Karpathy 的 `raw/` 目录，保留原始 PDF/Word，格式化后的 .md 作为 Wiki 层 | 低 |
| **查询结果反写** | 用户标记某个回答"很好"时，自动整理为 knowledge/qa/ 下的文件 | 低 |

核心原则：**在保持 Soul 的无损保真和精确溯源优势的前提下，引入 Karpathy 的知识积累和自演化能力**。

### A.7 Phase 1 融合实现（已完成）

> 实现日期：2026-04-09 | 作者：zhi.qu

以下改进已在 Phase 1 中实现，**确保不影响现有回答结果**：

#### 目录结构

```
avatars/{id}/
  knowledge/           ← 现有不动
    _raw/              ← 【新增】保存原始导入文件（PDF/DOCX/图片）
    _index/            ← 现有：BM25 + 向量索引
    *.md               ← 现有：LLM 格式化的知识文件
  wiki/                ← 【新增】知识百科（Karpathy 融合层）
    _meta.json         ← 编译状态
    concepts/          ← 实体概念页（自动生成）
    qa/                ← 沉淀的优质问答
    lint-report.json   ← 自检报告
```

#### 安全保证

| 现有模块 | 是否受影响 | 原因 |
|---------|----------|------|
| SoulLoader | 不受影响 | 只读 `knowledge/*.md`，`wiki/` 在 avatar 根目录下，不被扫描 |
| KnowledgeRetriever | 不受影响 | 只索引 `knowledge/*.md`，`_raw/` 中是非 .md 文件（PDF/DOCX） |
| RAG Pipeline | 不受影响 | 依赖 KnowledgeRetriever，不接触 `wiki/` |
| KnowledgeManager.buildTree | 改进 | 跳过 `_` 前缀目录，知识树更简洁 |

#### 已实现的功能

| 功能 | 模块 | 说明 |
|------|------|------|
| **保留原始文件** | `WikiCompiler.preserveRawFile()` | 导入文档时自动复制原始文件到 `knowledge/_raw/` |
| **实体提取** | `WikiCompiler.extractEntities()` | 基于词频 × 跨文件分布，从标题和内容中识别高频技术实体 |
| **概念页生成** | `WikiCompiler.compileConceptPages()` | 为跨文件实体生成聚合概念页（LLM 驱动） |
| **知识自检** | `WikiCompiler.lintKnowledge()` | LLM 矛盾检测 + 内容指纹重复检测 |
| **答案沉淀** | `WikiCompiler.sedimentAnswer()` | 保存优质问答到 `wiki/qa/` |
| **UI 触发** | KnowledgePanel `WIKI` / `LINT` 按钮 | 手动触发编译和自检 |

#### 数据流

```
                        Phase 1 融合（不影响现有回答）
                        ═══════════════════════════

导入文档 → ┬→ 原始文件 → knowledge/_raw/xxx.pdf    ← 可追溯
           └→ 格式化 .md → knowledge/xxx.md         ← 现有流程不变
                              │
                              ▼
                    构建检索索引（现有流程）
                              │
                              ▼
                    knowledge/_index/                ← 现有流程不变
                              │
    ┌─────────────────────────┤
    ▼                         ▼
  WIKI 按钮               LINT 按钮
    │                         │
    ▼                         ▼
 实体提取（本地）          矛盾检测（LLM）
    │                    重复检测（指纹）
    ▼                         │
 概念页生成（LLM）            ▼
    │                    wiki/lint-report.json
    ▼
 wiki/concepts/*.md

                    ↑ 以上均不改变 knowledge/ 中的任何 .md 文件
                    ↑ SoulLoader / RAG 完全无感知
```

#### Phase 2 融合实现（已完成）

> 实现日期：2026-04-09 | 作者：zhi.qu

所有功能默认关闭，通过设置开关或手动触发启用。不修改现有 RAG 流程的默认行为。

##### 功能 1：Wiki 内容可选注入 RAG

设置开关 `wiki_inject_rag` 启用后，`rag-retrieve` 在检索 `knowledge/` 的同时，创建第二个 `KnowledgeRetriever` 指向 `wiki/concepts/`，用 BM25 搜索概念页并作为"百科参考"追加到增强 Prompt 末尾（不参与多跳检索，不建独立向量索引）。

```
用户问题 → rag-retrieve
  ├── KnowledgeRetriever(knowledge/)  → 检索起点
  └── [wiki_inject_rag=true]
      KnowledgeRetriever(wiki/concepts/) → 百科参考（Top-3，截取 1500 字符）
  → 合并注入 user 消息
```

改动点：
- `rag-answerer.ts` — `retrieveAndBuildPrompt` 新增可选参数 `wikiChunks`
- `main.ts` — `rag-retrieve` handler 读取设置，创建 wiki retriever
- `SettingsPanel.tsx` — 新增 **WIKI Tab** 含"注入百科到 RAG"开关

##### 功能 2：答案手动沉淀 + 可选自动沉淀

手动入口：`MessageBubble` 上 hover 显示 SAVE 按钮，点击将问答对沉淀到 `wiki/qa/`。

自动入口：设置开关 `wiki_auto_sediment` 启用后，`chatStore.sendMessage` 在最终回复处用启发式规则判断（长度 > 300 字符、含来源引用、非错误消息），自动沉淀到 `wiki/qa/`。

```
LLM 完成回答
  ├── 手动: MessageBubble [SAVE] → saveWikiAnswer()
  └── 自动: [wiki_auto_sediment=true + shouldSediment()] → saveWikiAnswer()
  → wiki/qa/{id}.md
```

改动点：
- `MessageBubble.tsx` — 助手消息增加 SAVE 按钮（hover 显示）
- `MessageList.tsx` — 传递 `onSaveAnswer` 和 `previousUserMessage`
- `ChatWindow.tsx` — 实现 `handleSaveAnswer` 回调
- `chatStore.ts` — `sendMessage` 末尾添加自动沉淀逻辑 + `shouldSediment()` 启发式函数
- `SettingsPanel.tsx` — WIKI Tab 增加"自动沉淀优质回答"开关

##### 功能 3：知识演化检测

导入新文件后自动检测与已有知识的演化差异（新增/更新/矛盾），仅报告不修改。

```
导入新文件 → LLM 格式化 → 新文件内容
  → 提取实体(tokenize + 频率>2) → 搜索已有 chunks 中同名实体
  → [有重叠] → LLM 对比 → EvolutionReport(new/updated/contradiction)
  → wiki/evolution-report.json → statusMsg 显示差异统计
```

改动点：
- `wiki-compiler.ts` — 新增 `EvolutionDiff` / `EvolutionReport` 类型和 `detectEvolution()` / `getEvolutionReport()` 方法
- `main.ts` — 新增 `detect-evolution` / `get-evolution-report` IPC handler
- `preload.ts` / `global.d.ts` — 暴露新 IPC 通道和类型
- `KnowledgePanel.tsx` — 导入流程末尾调用演化检测并显示结果
- `index.ts` — 导出新类型

##### 功能 4：概念页交叉引用（Backlinks）

`compileConceptPages` 完成概念页生成后执行第二遍扫描，为每个概念页生成 `## 相关概念页` 反向链接段落。纯本地操作，不调用 LLM。

改动点：
- `wiki-compiler.ts` — `buildBacklinks()` 私有方法

##### 更新后的目录结构

```
avatars/{id}/
  knowledge/           ← 现有不动
    _raw/              ← 保存原始导入文件
    _index/            ← BM25 + 向量索引
    *.md               ← LLM 格式化的知识文件
  wiki/                ← 知识百科（Karpathy 融合层）
    _meta.json         ← 编译状态
    concepts/          ← 实体概念页（自动生成，含交叉引用 backlinks）
    qa/                ← 沉淀的优质问答（手动 + 自动）
    lint-report.json   ← 自检报告
    evolution-report.json ← 知识演化检测报告
```

##### 完整数据流

```
                  Phase 2 融合（所有功能默认关闭，开关控制）
                  ═══════════════════════════════════════

导入文档 → ┬→ 原始文件 → knowledge/_raw/xxx.pdf       ← 可追溯
           └→ 格式化 .md → knowledge/xxx.md            ← 现有流程不变
                              │
                              ├→ 构建检索索引（现有流程）
                              │     └→ knowledge/_index/
                              │
                              └→ 知识演化检测（功能 3）
                                    │ detectEvolution()
                                    └→ wiki/evolution-report.json
                                       statusMsg 显示差异统计

  WIKI 按钮 → 实体提取 → 概念页生成 → 交叉引用扫描（功能 4）
                                       └→ wiki/concepts/*.md
                                          每页含 ## 相关概念页

  LINT 按钮 → 矛盾检测 + 重复检测 → wiki/lint-report.json

  RAG 检索（功能 1，wiki_inject_rag=true）:
    用户问题 → knowledge/ 检索 + wiki/concepts/ BM25 检索
            → 合并为 "检索起点" + "百科参考" → LLM 回答

  答案沉淀（功能 2）:
    手动 SAVE / 自动判断（wiki_auto_sediment=true）→ wiki/qa/*.md

              ↑ 功能 1~4 均不改变 knowledge/ 中的任何 .md 文件
              ↑ 功能 1 和 2 需要设置开关开启才生效
```

##### 文件变更汇总

| 文件 | 功能 1 | 功能 2 | 功能 3 | 功能 4 |
|------|--------|--------|--------|--------|
| `packages/core/src/rag-answerer.ts` | 改 | - | - | - |
| `packages/core/src/wiki-compiler.ts` | - | - | 改 | 改 |
| `packages/core/src/index.ts` | - | - | 改 | - |
| `desktop-app/electron/main.ts` | 改 | - | 改 | - |
| `desktop-app/electron/preload.ts` | - | - | 改 | - |
| `desktop-app/src/global.d.ts` | - | - | 改 | - |
| `desktop-app/src/components/SettingsPanel.tsx` | 改 | 改 | - | - |
| `desktop-app/src/components/MessageBubble.tsx` | - | 改 | - | - |
| `desktop-app/src/components/MessageList.tsx` | - | 改 | - | - |
| `desktop-app/src/components/ChatWindow.tsx` | - | 改 | - | - |
| `desktop-app/src/stores/chatStore.ts` | - | 改 | - | - |
| `desktop-app/src/components/KnowledgePanel.tsx` | - | - | 改 | - |
