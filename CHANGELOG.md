# 更新日志

## Unreleased

### 新增

- **知识检索链路补齐** — 项目知识目录、`@excel` / `@会话` 引用与来源引用链路。
- **任务/项目管理与交互增强** — 新增任务/项目管理面板、制品副面板、Slash 命令、`@` 上下文引用、全局搜索、拒答卡片，并修复信息图校验。
- **grill 技能 + 三专家包挂载** — 补充 `grill-me` / `grill-against-knowledge` 两技能；品研 / 项枢 / 小堵三专家包已挂载，用于「拷打需求 → 对齐知识库 → 沉淀 ADR」。
- **小凯分身** — 新增电气工程师「小凯」分身，完成 小凯 12G 知识内容学习并进行总结归纳。
- **分身包导入 / 导出入口** — 桌面端加 `.soulpack.json` 导入（安装别人的分身）与导出（分享分身给别人）入口，打通 soul-pack 的 UI 闭环。
- **bundle @vscode/ripgrep** — 内置 ripgrep 二进制供知识库 grep 使用（含 win64 跨编译），不再依赖系统 `rg`。

### 修复

- **修复轮污染治理** — 修复工具调用时间线、regenerate、附件上传与 `@` 引用竞态，避免修复轮污染对话历史和计费链路。
- **全量代码审查修复** — 修复全量代码审查确认的 37 处缺陷。

### 安全加固

- **本地文件与恢复链路加固** — 加固 `read_user_file`、SkillRouter、分身包 restore / sync，提升本地文件和恢复链路安全性。

### 工程

- **回归测试补强** — 新增 DB migration / fresh install / restore / MCP / SSRF 等回归测试用例。
- **Excel 解析迁到 worker_threads** — 文档解析的 Excel 核心抽为独立模块并下沉 worker 线程，避免大表解析阻塞主线程（含手动验证脚本）。
- **脚本与 gitignore** — 加 opus staging worklist + pptx 提取脚本；忽略 `.cursor/plans` 草稿与 `_trash-*` 回收站。

## v0.18.1 (2026-06-02)

### 新增

- **`@web` 改为内联提及** — message-input 里 `@web` 作为内联 token，发送时注入联网指令，不再是独立开关态。
- **web_fetch fake-ip 代理放宽开关** — 修 SSRF 防护对正常 `web_fetch` 的误杀（合法外链被当成内网拦截）。
- **已格式化文件隐藏 FORMAT 按钮** — 知识库中已 LLM 格式化（`source: enhanced`）的文件不再显示 FORMAT 按钮，避免重复格式化。
- **THINKING 段流式自动展开** — 回答流式生成时 THINKING 段默认展开并显示「思考中…」，完成后自动折叠。

### 性能

- **soul-loader system prompt 砍半** — 大知识库的可检索索引改为顶层领域摘要，显著压缩 system prompt 体积。
- **knowledge_grep 改用 ripgrep** — tool-router 知识检索优先走 `rg`，Node 扫描作回退。

### 修复

- **时效问答日期臆测** — 注入真实当前日期到动态系统段，修分身对「今天/最近」类问题臆测日期。
- **soul-loader prompt 预算** — 识别 `source_type`，加 prompt 硬预算与深度上限，防大库撑爆上下文。
- **分身简介裸 markdown** — 分身简介预览去除内联 markdown 标记（`**` / `` ` `` / 链接等）。

### 工程

- **frontmatter 重命名** — 知识 `rag_only` → `prompt_excluded`（向后兼容旧字段）。
- **opus 重摄取工作清单脚本** `scripts/build-reingest-worklist.py` — 按 frontmatter 分流知识 .md 生成重摄取工作清单。
- **release 构建改为仅手动触发** — 移除 tag 自动触发 CI 构建，发包走 `workflow_dispatch` 或本地出包。

## v0.18.0 (2026-06-02)

> 自 v0.17.0 以来 139 个 commit（含 108 个 fix）。本版核心：会话树多分支重答、对话一键导出可分享 HTML、桌面端集成 skills.sh 社区技能市场、Soul MCP server 对外暴露分身资源，并完成大批安全加固（SSRF / 路径穿越 / zip 炸弹 / DNS rebinding）。

### 新增

- **会话树（session-tree）多分支对话** — DB 层 `parent_id` / leaf / active-path 模型；「换个思路重答」对同一问题生成多个回答版本 + version switcher 切换；fork primitive 与 active-path 读取。
- **对话导出为可分享 HTML** — 单文件自包含导出，chart / mermaid 离屏渲染为 SVG 内联。
- **桌面端集成 skills.sh 社区技能市场** — 技能面板内搜索 / 安装 / 更新 / 卸载社区技能，带进度、加载更多、打开技能主页、已安装状态稳健匹配。
- **Soul MCP server** — 把分身资源（soul / knowledge / skills）read-only 暴露给外部 Claude Code 等 MCP 客户端；并一键生成 MCP server 配置片段。
- **RAG 知识策略增强** — 渐进式披露（progressive-disclosure）知识策略决策 + flag；知识检索召回完整度信号 + `search_knowledge` 工具决策树。
- **专家包版本管理** — version pin + 可发现性 + 更新检查。
- **上下文溢出自愈** — 超长上下文自动 compact 并重试一次。
- **分身自我介绍快路径** — 无需 LLM 的 avatar self-description fast path。
- **source-anchor 强制 hook** — 工具调用链路接入来源锚点校验（flag-gated，软告警）。
- **案例视频离线内联工具** `scripts/embed-case-videos.py` + 案例截图资产 `assets/case-screenshots/`（base64 内联 CASE mp4 生成离线单文件 HTML）。

### 修复与加固（108 个 fix，节选核心）

- **安全**：web_fetch SSRF 按 IANA special-purpose 表收紧 + IPv6 literal 处理；多处 IPC 路径穿越 / 越界加固；zip / 7z 炸弹解压前预检体积；DNS rebinding 防护；日志密钥脱敏扩面。
- **会话 / 聊天**：切换会话不再串线污染、后台触发按目标会话拉历史、hidden repair 不再占锁 / 重复计费 / 污染外层状态。
- **MCP**：启动自动连接已保存 server、写 DB 前校验配置跳过坏行、连接超时泄漏修复。
- **分身包 / 技能**：soul-pack import 前完整 preflight + 内容指纹防 TOCTOU；community 技能源校验。

### 工程

- **`.gitignore` 加固** — 忽略本机模型与编译产物（`scripts/models/`、`scripts/vision-ocr`）、CodeGraph 本机数据（`.codegraph/`）、备份文件（`*.bak`）。
- **release 前回归 gate** — `test:qa-gate` 与 expert-packs 结构 lint 接入 quality 链路。
- **prompt-cache** — 集中稳定前缀 + byte-identity 测试。
- **package-lock 版本同步** — 修正长期停留在 0.14.0 的滞后，对齐 0.18.0。

## v0.17.0 (2026-05-19)

> 第四波「2026 LLM 工具链借鉴」：Inspect AI / mitmproxy / LiteLLM 三件套落地。补 Soul 评测框架抽象不清晰、proxy 流量无法回放、跨 provider 成本不可见三个工程短板。`batch-regression-runner` 不动，新抽象并行落点。

### 新增（外部借鉴）

- **Inspect-AI 风格 Task / Solver / Scorer 评测抽象（UK AISI `inspect_ai` 借鉴）** — 新模块 `desktop-app/src/services/eval/`（types / solvers / scorers / task / eval-log / adapter / dataset-from-flows / index）。三层抽象把 `batch-regression-runner.ts` 的"题库→断言"硬绑解开：`Sample(input, target, metadata)` + `Solver`（默认 `makeChatSolver` 走真实 chatStore 工作流；`staticSolver` 走查表回放） + `Scorer * N`（红线 2 + expectedTools / Skills / Value / mustContain / mustNotContain + citation + persona 共 7 个内置，组合自由）。`runEval(task)` 单入口，逐题写 JSONL eval log（header + sample * N + summary），与 Inspect `.eval` log 结构对齐。`questionsToSamples` 桥让老 `GeneratedQuestion[]` 不迁移即用。
- **mitmproxy 风格 flow record / replay（mitmproxy `addon + flow` 借鉴）** — 新增 `desktop-app/electron/flow-recorder.ts`，模块级 `flowRecorder` 单例，默认 disabled emit 是 O(0)。`proxy-server.ts` 加 2 行 hook：onRequest 时缓冲 / onFinish 时合并为一行 JSONL append（含 request body / response.kind=json|sse|error / durationMs / conversationId）。`src/services/eval/dataset-from-flows.ts` 把录制流转 `Sample[]` 喂 `runEval` —— 直接解决离线/弱网回放 + 真实流量自动转回归题库两个场景。**v1 不录 SSE chunk**（reassemble 后续按需），不录 Authorization 头（防 token 泄漏）。
- **LiteLLM 风格 cost-tracker（LiteLLM `model_prices.json` 借鉴）** — 新增 `desktop-app/src/services/llm-providers/cost-tracker.ts`。内置定价表 `DEFAULT_PRICING` 覆盖 Claude Opus/Sonnet/Haiku 4.x + DeepSeek chat/reasoner 共 5 个型号，单位 USD per 1M tokens，cache_read / cache_creation 单独价位（贴合 Anthropic prompt cache 10× 折扣 / +25% 加价）。API: `costTracker.record(avatarId, model, usage)` / `summary(avatarId?)` / `totalUsd()` / `setPricing(model, p)` / `reset()`。未知模型 token 仍计入、cost=0、按 model 名 dedupe warn 一次。`runEval(task, { trackCostsAs })` 一行接入。
- **usage telemetry 端到端链路（接通上述三件套）** — `regression-telemetry.ts` 加 `UsageEvent` 类型（model + NormalizedUsage + round）。`ChatDoneCallback` 第四参数 `usage`（向后兼容可选）。`claude.ts` 在 message_delta 阶段把已计算的 input/output/cacheRead/cacheCreation 归一化透传；`openai-compat.ts` 把 prompt_tokens 拆成 cacheRead(hit) + inputTokens(miss)，贴合 LiteLLM 计价语义。`chatStore.ts` round 结束 emit UsageEvent。`eval/solvers.ts` 新 `defaultExtractUsage` 累加多轮 usage、取最后一轮 model，`makeChatSolver` 默认接入零配置。

### 不做（speculative，按 simplicity 原则砍掉）

- **LiteLLM Router YAML**：Soul 当前只有 claude + openai-compat 两个 provider，远未到痛点；等接第 3 个 provider 再做。
- **mitmproxy SSE chunk 重组**：录制只存 request + 终态（json / error / sse-ok），增量 chunk 重组需 Anthropic SSE parser，v1 不做。
- **batch-regression-runner 原地重写**：596 行业务耦合较深，新 eval 模块并行落点，老代码继续工作；后续按需迁移。

### 测试

- **24 新单测覆盖 3 个模块**：`src/services/eval/eval.test.ts` 15 个（含 2 个 defaultExtractUsage 用例 + 8 个 runEval/scorer + 2 个 adapter + 3 个 dataset-from-flows）+ `src/services/llm-providers/cost-tracker.test.ts` 6 个（含价位换算 / 累加分桶 / 未知模型 warn 去抖 / setPricing / undefined noop / DEFAULT_PRICING 覆盖断言）+ `electron/flow-recorder.test.ts` 5 个（disabled 零副作用 / JSON 响应 / error 分支 / SSE 分支 / 未对齐 finish 静默忽略）。
- **0 回归**：老 telemetry + batch-regression-runner + manual-qa 等测试套件 50/50 全绿。
- **tsc clean**：`npx tsc --noEmit` 零错误。

## v0.16.0 (2026-05-19)

> Letta `.af` 借鉴落地：分身可移植打包格式 **soul-pack**。

### 新增

- **soul-pack：分身可移植打包格式（Letta `.af` 借鉴）** — 单 JSON 文件含分身所有文本类资产 inline + 二进制 sha256 ref + 外部技能引用，支持跨用户分发 / 备份回滚 / 版本管理（git diff 直观）。补 Soul 长期没有「分身一键 export / import」的明确短板。
  - **新模块** `packages/core/src/soul-pack/`（manifest.ts / export.ts / import.ts / index.ts）
  - **格式**：`SOUL_PACK_SCHEMA_VERSION=1`；inline 文本类（.md/.yaml/.yml/.json/.txt/.csv/.html/.css/.svg），单文件 ≤ `INLINE_MAX_BYTES=256KB`；二进制（.xlsx/.pdf/.png 等）只列 path + sha256 + size + mime，不内联防 JSON 膨胀。
  - **完整性**：`manifest_sha256` 是除自身字段外稳定序列化（键名按字母序）的 sha256；每个 file 的 sha256 单独校验。parse 时双重校验，篡改 / 损坏拒绝。
  - **默认安全**：memory（含对话历史 / standing orders）/ life（想象人生）/ wiki/concepts（derived）默认**不打包**；显式 `--include-memory` / `--include-life` / `--include-wiki` 才纳入。_index/ 和 workspaces/ 永远跳过。
  - **import 安全**：targetAvatarId 走 `assertSafeSegment` 校验；每个 file path 校验不含 `..` / 绝对路径；目标 avatar 已存在默认拒绝，`force=true` 才覆盖（先清空原目录）。
  - **外部技能引用**：解析 `skills/skill-index.yaml` 提取 `shared_skills` + `community_skills`，pack 里只列 name/repo/ref（不打包本体）；import 端 shared 走自动 fallback，community 提示跑 `scripts/soul-sync.sh`。

- **soul-pack CLI** `scripts/soul-pack-cli.ts` — 不进桌面端也能跑：
  - `npx tsx scripts/soul-pack-cli.ts export <avatar-id> <output.json> [--include-memory]`
  - `npx tsx scripts/soul-pack-cli.ts import <input.json> [--target <id>] [--force] [--no-memory]`
  - `npx tsx scripts/soul-pack-cli.ts preview <input.json>` — 看 manifest 元数据不实际导入

- **新 IPC（3 个）** — `soul-pack:export-to-file` / `soul-pack:import-from-file` / `soul-pack:preview`。preload 暴露 `soulPackExportToFile` / `soulPackImportFromFile` / `soulPackPreview`，global.d.ts 加完整类型。UI 接入留 follow-up（当前 CLI + IPC 已可用）。

### 测试

`packages/core/src/tests/soul-pack.test.ts`：20 个新单测覆盖
- manifest serialize-parse roundtrip / sha256 完整性校验 / file content 篡改拒绝 / schema 版本不匹配拒绝 / 损坏 JSON 抛错 / 缺必填字段抛错
- export 默认跳过敏感目录 / includeMemory 完整打包 5 类记忆 / 二进制 ref 含 mime / external_skills 解析 / avatarId 路径穿越拒绝 / 按 path UTF-16 字节序排序（与 git diff 一致）
- import 不覆盖默认 / force 清空再写 / file path 含 `..` 拒绝 / memory restore on/off / binary_refs + warnings 报告
- 端到端 export → serialize → parse → import 在另一目录还原

689/689 core 单测通过（669 既有 + 20 新增）；desktop typecheck 通过。

### 已知限制 / 后续

- **UI 接入留待 follow-up**：当前 export/import 需走 CLI 或前端代码手动调 IPC；桌面端 SettingsPanel / AvatarPanel 加一对按钮（带 dialog 选路径）是 v1 之后的事。
- **soulpack-pack-and-go**：如果未来需要"打包 + 二进制内嵌"全功能版（一文件包括 xlsx），可加 base64 inline 模式，但 JSON 会膨胀 33%，目前不做。

## v0.15.0 (2026-05-19)

> 第三波「2026 GitHub trending 借鉴 + 工程治理」：基于 v0.14.1 之上的近 1-3 个月开源主流 top 50 调研，挑出 6 个真正补 Soul 短板的借鉴点落地——SillyTavern Lorebook / Letta 自编辑记忆 / anthropics-skills SKILL.md 标准 / CrewAI Task 输出契约 / OpenClaw Standing Orders / OpenHuman Memory Tree。同步治理 lint / 测试基础设施，让 `npm run quality` 可用 + 测试默认覆盖。

### 新增（外部借鉴）

- **Lorebook keyword-trigger 注入（SillyTavern 借鉴）** — `avatars/<id>/knowledge/_triggers.yaml` 配 keyword → knowledge 映射；chatStore 装配 prompt 时按 user message 命中 keyword 后被动注入对应知识片段到 dynamic 段。补 BM25/向量召回漏 + `knowledge_grep` 需 LLM 主动调用的最后短板，对小模型场景尤其友好。新工具：`lorebookMatchAndBuild` IPC。新模块 `packages/core/src/lorebook-trigger.ts`，22 单测覆盖载入 / 匹配 / 拼装 / 截断 / 容错。
- **Agent 自编辑记忆 pin_episode + add_episode_note（Letta core memory 借鉴）** — 让 LLM 在对话中主动管理 episode：`pin_episode` 显式标记关键 episode 永不衰减（salience +50 BONUS、recency 强制 1.0、跳过 forgetter）；`add_episode_note` 补抽 LLM 抽取漏掉的事实。**不提供 unpin 工具**防自我审查；MAX_PINNED=20 / MAX_NOTES_PER_EPISODE=5 / MAX_NOTE_LENGTH=500 三层上限。
- **anthropics/skills SKILL.md 标准目录格式兼容** — SkillManager 双格式并存：Soul 原生单 .md 向后兼容 + 新支持目录形式 `<id>/SKILL.md + scripts/ + references/ + assets/`（spec 来自 https://agentskills.io/specification）。frontmatter `name` 字段必填且必须匹配目录名（不匹配时 warn + 仍按目录名加载，容错过渡）。接通 anthropics + Claude Code + Codex + Cursor 跨平台 658+ 社区技能生态；community/ 通道仍走 soul-sync.sh 独立链路。
- **task 工具 expected_output schema（CrewAI 借鉴）** — 调枢 orchestrator 派单从 free-form 文本交接升级到结构化契约：`task({ task, target_avatar, expected_output })`。expected_output 注入到子代理 userPrompt 末尾【输出格式约束】段，不动 systemPrompt 保 prompt cache 命中。空白 expectedOutput 自动 trim 视为不传。SubAgentTask 上 expectedOutput 透传可查。
- **Standing Orders 永久工作流规则（OpenClaw 借鉴 + ReMeV2 分类摘要思路）** — 补 Soul 之前没有"长期工作流约定"channel 的痛点。两条写入路径：(a) LLM 在回复里写 `[STANDING_ORDER]...[/STANDING_ORDER]` 标签（MEMORY_NUDGE 扩展第 4 类引导）；(b) `add_standing_order` 工具主动调用。落盘 `memory/standing-orders.md`，SoulLoader 紧挨 soul.md 注入，优先级介于 HARD_RULES 与 MEMORY.md 之间。**不提供 remove 工具**防自我审查；MAX_STANDING_ORDERS=50 / MAX_ORDER_LENGTH=500。
- **Daily Summary 时间维度聚合（OpenHuman Memory Tree 借鉴）** — Soul 之前对话记忆只有实体维度（per-episode + WikiCompiler per-entity 聚合），补**时间维度**：每日 0:40 cron 把当天 episode 机械合并成 `memory/daily-summaries/<YYYY-MM-DD>.md`。零 LLM 成本（v1 纯函数合并 title + theme + clipped summary，forgotten 自动剔除，pinned 标 📌）。两个新工具 `list_daily_summaries(start?, end?, limit?)` + `read_daily_summary(date)`，时间锚定召回对偶 `recall_conversation` 的 query 召回。

### 修订

- **MEMORY_NUDGE_TEXT 扩展** — 从 3 类记忆类型扩到 4 类，加 `[STANDING_ORDER]` 引导：用户明确表达"以后所有 X 都要 Y"类长期约定时单独走该通道，不混入 MEMORY_UPDATE；标签内只写一条规则；规则会注入 system prompt 永久生效；提示用户"添加前确认是真'以后都要'而不是这次特例"。
- **SoulLoader system prompt 装配** — 紧挨 soul.md 之后注入「Standing Orders 永久规则」段（带使用守则："如认为某条规则与当前任务冲突，先按规则执行 + 用 [UNCERTAIN] 提示用户"）。

### 工具 / IPC

- **新 IPC（4 个）** — `lorebook:match-and-build` / `standing-orders:append` / `standing-orders:read` / `standing-orders:count`
- **新工具调用 schema（6 个）注册到 AVATAR_TOOLS** — `pin_episode` / `add_episode_note` / `add_standing_order` / `list_daily_summaries` / `read_daily_summary` / 扩展 `task` 加 `expected_output` 参数
- **新 daily cron** — `daily-summary-all` 每日 0:40（在 episode-forgetting 0:35 之后 5 分钟）

### 工程治理（fix / chore）

- **core test 脚本动态发现** — 从硬编码 14 文件改为 `find dist/tests -name '*.test.js' ! -name 'journey.test.js'`，把漏跑的 37 个单测（含 episode-forgetter / salience / conversation-episode / tool-result-* / tool-router-knowledge-grep / chunk-cache 等）全部纳入默认；分离 `test:integration` 跑 e2e journey。跑全量立刻揪出 chunk-cache.test.ts:70 的 v1 flat-map 格式过期断言（实现 2026-05-12 已升 v2 schema），同步修。
- **packages/core/eslint.config.mjs 之前完全缺失** — `npm run lint` / `npm run quality` 100% 报错。补一份 Node target 简化版，保留核心规则（no-console / eqeqeq / no-var / no-debugger / toISOString-slice 禁令）。
- **desktop-app lint ignore 修 widget-static minified bundle** — `electron/widget-static/soul-embed.js` 是 minified 265 行单行 JS 被当源码扫，产生 144 个假阳性 errors（line 1 col 1000+）。`ignores: ['*.js']` 只匹配 root 一级，改为 `**/*.js` 递归 + 显式加 `electron/widget-static/**`。效果：246 → 100 problems。
- **空 catch 规则改用 ESLint 内置** — 自定义 `no-restricted-syntax CatchClause[body.body.length=0]` 的 AST 选择器不识别注释，把全部 64 处合理的"有意识 + 已注释静默"误报为 error。改用 `no-empty: ['error', { allowEmptyCatch: true }]`，约定层面要求 catch body 写注释。core 130→81 / desktop 100→63 problems。
- **core 清零 lint errors** — 修 11 处 regex character class 多余转义（`[\/\\]` → `[/\\]` 等，注意 `\]` 中间位置仍需保留）+ 3 处 no-useless-assignment（重构 readSoulExcerpt early-return / `let markdown: string` narrowing / `let hits: number`）+ document renderer 加 default + assertNever 兜底 + 合并 4 处分行 type import + 7 处 catch 重抛加 `{ cause: err }`（preserve-caught-error）+ ocr-html-cleaner emoji character class 拆分。
- **CHANGELOG v0.14.1 补写** — 上版漏写，本期开头补回。

### 测试

core 单测：**580 → 669（+89 个新单测）**，全部 0 回归：
- 22 `lorebook-trigger`：载入 / 匹配排序 / max_entries / 截断 / 文件读不到容错
- 17 `agent-self-edit-memory`：pin 幂等 / 上限 / reason 截断 / note 多条累加 + 上限 / salience pinned 行为 / forgetter 跳过 pinned
- 9 `skill-manager-skill-md`：单文件 vs 目录形式 / 同名优先级 / SKILL.md 缺失跳过 / community 子目录排除
- 8 `sub-agent-expected-output`：注入位置 / cache 友好 / 空白 trim / 透传
- 10 `standing-orders`：首次建 header / 累加 / 空白拒绝 / 上限拒绝 / 单条换行清洗 / source 注释格式
- 23 `daily-summary`：本地时区 / 按日期分组 / forgotten 跳过 / clipping / write-read roundtrip / start-end-limit / 端到端

desktop-app：typecheck + qa-gate 通过。

### 关于 RRF fusion 调研发现

调研报告原建议加 ReMeV2 的 hybrid retrieval fusion（0.3 BM25 + 0.7 vector 加权），实测发现 Soul 已在 `knowledge-retriever.ts:543` `rrfFusion` 实现了 Reciprocal Rank Fusion（k=60，Cormack et al. 2009 经典公式 `score = 1/(k+rank_bm25) + 1/(k+rank_vector)`）——比 ReMeV2 的 weighted-sum 更先进，不需要分数归一化、对 outlier 鲁棒。无需新代码。Follow-up：rrfFusion 是 private method 未直接单测覆盖，作为 backlog。

### 项目治理

- `@soul/core` 新增模块：`lorebook-trigger.ts` / `memory/standing-orders.ts` / `memory/daily-summary.ts`
- `SubAgentManager` 扩展：`SubAgentTask.expectedOutput` 字段 + `SubAgentDelegateOptions` 参数 + runTask 注入逻辑
- `SkillManager` 扩展：`loadSkillFromDir` 私有方法 + `getSkill` fallback 目录形式 + `getAvailableSharedSkills` 双格式
- `ToolRouter` 扩展：6 个新工具 method（pinEpisodeTool / addEpisodeNoteTool / addStandingOrderTool / listDailySummariesTool / readDailySummaryTool + task 透传 expected_output）
- `SoulLoader` 扩展：Standing Orders 注入段
- 依赖：零外部新增

### 已知限制 / 后续

- **rrfFusion 单测缺位**：抽公开 pure function + 加单测，是 1-2 小时小事但跟 rerank 模块耦合，留后续。
- **Daily Summary v1 是机械合并**：未来如果用户实战感觉"机械版不如 LLM 摘要"，再加 feature-flagged 二次 LLM 摘要路径。当前优先零成本 + 可预期。
- **Lorebook trigger 当前 substring 匹配**：未来若发现 keyword 命中精度差（如"铜铝"误命中"铜母线铝箔"），加更严格的 word-boundary 选项。
- **Standing Orders unset 缺失是设计选择**：参考 pin_episode，防 LLM 自我审查。如果用户实战中觉得不便（例如规则改主意），改成"加 deprecated 标记"而不是 remove。

---

## v0.14.1 (2026-05-18)

> 第二波「Context Engineering」扩展（2026-05-18，并入 Phase 1+2 之后）：借鉴 OpenHuman / TDAI / PAP / Anthropic Claude Skills 四个外部项目的核心思想，给分身加**联网开关 + 引用铁律 / 工具结果压缩 + 离线 lazy / 知识库精确 grep + glob / wiki 概念页 LLM 直读 / emoji → inline icon**。完整方案与决议见 `.cursor/plans/openhuman-借鉴_2026-05-18.plan.md`。

### 新增（第二波 Context Engineering）

- **联网功能总开关（默认关）** — 「设置 → 工具集成」加 `WEB_ENABLED` toggle，控制 `web_search` / `web_fetch` 是否对 LLM 可见。**三层防御**：(1) `soul-loader.ts` 不在 toolsNote 列工具；(2) `chatStore.ts` 从 LLMTool[] 数组过滤；(3) `tool-router.ts` 入口闸门拒绝调用。关闭时强制提示分身「答复事实根基只能来自知识库 + soul + 人生 + 附件，禁止编造时效性数据」。
- **联网引用铁律（联网开启时）** — 任何来自 `web_search` / `web_fetch` 的事实必须挂可点击 URL + 访问日期（`[来源: https://... · 访问 2026-05-18 · web_search]`），描述性出处（`[来源: 国网上海电力公司电价表]`）一律视为伪造。强制「联网搜索摘要」开篇可见：调过 web_search 的回答必须以 `## 联网搜索摘要` 子章节列 query + 命中 URL + 未命中说明。堵推断漏洞：「我预期 / 推测 / 估计」配具体数字时必须同句标注推断基础。
- **公共技能浏览 + 一键启用 UI（PAP 借鉴）** — `SharedSkillTab` 从"仅显示已引用"重写为"列出 `shared/skills/*.md` 全部公共技能 + checkbox 切换启用"。新增 IPC `get-available-shared-skills` + `toggle-shared-skill`：扫文件 frontmatter（name / description / domain）+ 读 `skill-index.yaml` 标 enabled 状态；切换时按 `name` 增删 `shared_skills` 段（保留注释与其他段）。
- **emoji → inline SVG icon 扩展** — `emoji-icon-map.tsx` 新增 9 个 SVG（📊 chart-bar / 📈 trend-up / 📉 trend-down / 🎯 target / 🔥 fire / ⭐🌟 star / 📝 note / 🚀 rocket）。配 prompt #5「段落标题不要用装饰 emoji 当章节前缀，用 markdown heading / **加粗**；有语义的（⚠️✅❌🔴🟢🔵🟡）可用，桌面端自动渲染为项目风格 inline icon；禁止堆叠装饰 emoji 让回答花哨」。
- **Tool Result 压缩层 / P1 v1（TokenJuice 启发）** — 新建 `packages/core/src/tool-result-compressor.ts`：在 ToolRouter.execute 出口对工具返回的 `content` 应用**无损 + 可还原**压缩。操作：(a) 通用无损（strip ANSI / 去尾空白 / ≥3 连续空行折叠为 2）；(b) `search_knowledge` 风格章节去重（sha256 严格相同，≥100 字符才参与）。**严格透传白名单**（红线）：`query_excel` / `read_knowledge_file` / `read_attachment` / `read_file` / `eval_js` / `exec_shell` / `exec_code` / `git_status` / `git_diff` 等事实根基类工具 byte-for-byte 透传。env `SOUL_TOOL_COMPRESSION=off` 一键回退。
- **Tool Result Lazy Store / P1.5（TDAI symbolic memory 启发）** — 新建 `packages/core/src/tool-result-lazy-store.ts` + tool-router 集成 + 新工具 `read_tool_ref(call_id, offset?, limit?)`。`web_fetch` 返回 body ≥ 4000 字符时**离线落盘**到 `workspaces/<convId>/tool-refs/<call_id>.md`，prompt 里只保留元数据（url/status/char_count）+ `body_lazy_ref: {call_id, char_count, hint, source_url}` 标记。LLM 看 lazy_ref 后用 `read_tool_ref` 按需取正文，单次硬上限 8000 字符，支持 offset 分页。env `SOUL_TOOL_LAZY_RETRIEVAL=on` 启用（默认关）。**v1 严格只对 web_fetch 启用**。实测：fgw.sh.gov.cn 政策列表页 5393 → 454 chars，节省 91%；LLM 主动调 `read_tool_ref` 取回正文后生成完整答复。
- **knowledge_grep + knowledge_glob 工具（PAP 借鉴）** — 与 `search_knowledge`（BM25 + 向量）互补：(a) `knowledge_grep(pattern, scope?, max_per_file?, max_total?)` 在 `knowledge/*.md|.txt|.json|.yaml` 文件按正则精确匹配，返回 `{file, line, text}[]`，纯 JS（无 ripgrep 依赖），跨平台稳定。硬上限：单文件 50 / 总 200（可调 max=200/500），scope 经 `assertSafeSegment` 校验防穿越；(b) `knowledge_glob(pattern)` 用既有 `globToRegExp` 列文件路径。**search_knowledge 召回不全时的兜底**：prompt #7 引导分身在精确关键词场景主动改用 grep——直接消除小堵"铜铝对比 / 土壤密实度"类漏召回回归风险。
- **list_wiki_concepts + read_wiki_concept 工具（PAP 学习笔记借鉴）** — Soul 已有 `WikiCompiler` 编译实体聚合页（`wiki/concepts/*.md`），但 SoulLoader 不读 wiki/，LLM 不知道有这层。本期把 wiki 路径暴露为 LLM 工具：`list_wiki_concepts(query?, top_n?)` 有 query 时扫所有概念页正文做关键词模糊匹配（entity 命中 +10 / name 命中 +5 / 正文每次命中 +1 上限 20），返回 top_n + 200 字符预览，绕开 WikiCompiler 实体提取阶段 name 字段污染问题。`read_wiki_concept(name)` 读全文 + **fallback 反查**：name 直读失败时遍历 `getConceptPages()` 按 entity 字段反查，找到对应文件后透明返回 + hint 告知 LLM 正确字段。
- **wiki/concepts 自动重编译开关** — 「设置 → 知识库」加 toggle「导入知识后自动重编译概念页」（默认关，标 LLM 调用约 100K tokens/次成本提示）。开启时 `buildIndexAfterBatchImport` 末尾 fire-and-forget 调 `WikiCompiler.compileConceptPages`；失败仅 warn 不阻塞 import。

### 修订（第二波）

- **`soul-loader.ts` 「回答规则」段大幅扩展** — 在原有 1-4 条后追加：(#5) 段落标题与排版（emoji 限制）；(#6) 文件类型与引用优先级（实体类查询优先 list_wiki_concepts；数字 / 政策来自 knowledge 原文 + query_excel；图像识别只看意图禁取精确数字；跨章节关系来自 wiki + memory + recall_conversation）；(#7) search_knowledge 召回不全的 grep 兜底策略。
- **联网未启用 / 启用两套指引互斥注入** — `soul-loader.ts` 按 `webEnabled` 参数走分支：启用时注入「3 维度判断 + 融合答复 + 引用铁律」；未启用时注入「答复事实根基只在知识库 / soul / 人生 / 当前上下文，禁止从训练数据推时效性事实」。`loadAvatar(avatarId, projectId, webEnabled)` 新增第三个参数，main.ts 调前从 settings 读 `web_search_enabled` 注入。

### 修复（第二波）

- **Web search 推断漏洞** — DeepSeek 把 prompt 解读为「事实要标来源 → 推断/预测不是事实，所以不用标」，导致带数字的预测裸奔。补「关于推断 / 预测 / 分析的特别约束」段：出现"我预期/预计/推测"+具体数字时必须同句标注推断基础。
- **WikiCompiler 概念页 name / entity 字段错配的工具层兜底** — `read_wiki_concept` 加 fallback：name 直读失败时按 entity 反查，让 LLM 即使传错（小堵 wiki name=`__` / entity=`**` 这类污染）也能拿到内容，并附 hint 引导下次正确调用。

### 测试（第二波）

- **3 个新单测文件 / 46 个用例**，全部 `node:test`：
  - `tool-result-compressor.test.ts`：17 用例，覆盖透传白名单（红线）/ env 关闭 identity / ANSI 剥离 / 空行折叠 / 短内容短路 / 章节去重正确 + 不去重不同 header / 异常容错不抛 / 统计字段。
  - `tool-result-lazy-store.test.ts`：18 用例，覆盖 env 开关红线（默认 off）/ 工具白名单（仅 web_fetch）/ web_fetch JSON 结构识别 / body 字段替换 / 落盘文件 / call_id 格式严格校验（防路径穿越）/ readToolRef 分页 + 硬上限 / 文件不存在错误 / 端到端 lazy → readToolRef 取回完整内容。
  - `tool-router-knowledge-grep.test.ts`：11 用例，覆盖 grep 命中 .md / 跳过二进制后缀 / 缺 pattern 报错 / 非法正则降级 / scope 路径穿越拒绝 / max_per_file + max_total 硬上限触发 truncated / 空知识库优雅返回 / glob `**` 跨目录 / 文件名匹配 `*.md`。
- 既有 109/109 core 测试零回归（含 soul-loader 10 / tool-router 各类 91 / skill-reranker 8）。

### 工具 / 维护（第二波）

- **新增 IPC（2 个）** — `get-available-shared-skills` / `toggle-shared-skill`；新工具不暴露 IPC（LLM 直接通过 tool dispatch 调用）。
- **新增 setting key（2 个）** — `web_search_enabled`（默认 `false`）、`wiki_auto_compile_on_import`（默认 `false`）。
- **新增 env vars（2 个）** — `SOUL_TOOL_COMPRESSION`（默认 `on`，设 `off` 一键禁用压缩层）、`SOUL_TOOL_LAZY_RETRIEVAL`（默认 `off`，设 `on` 启用 lazy-store）。
- **新增工具调用 schema（5 个）注册到 `AVATAR_TOOLS`** — `read_tool_ref`（lazy-store 取回正文）、`knowledge_grep` / `knowledge_glob`、`list_wiki_concepts` / `read_wiki_concept`。
- **新增持久化目录** — `avatars/<id>/workspaces/<convId>/tool-refs/`（lazy-store 离线 body 落盘点；conversation 删除时整目录一起清）。

### 项目治理（第二波）

- **`@soul/core` 新增模块** — `tool-result-compressor.ts`、`tool-result-lazy-store.ts`。
- **`SkillManager` 扩展** — 新增 `AvailableSharedSkill` 接口 + `getAvailableSharedSkills` + `toggleSharedSkill` + 私有 `readSharedSkillNamesFromIndex` + `removeSharedSkillEntry`（yaml 文本剪枝，保留注释与其他段）。
- **`ToolRouter` 扩展** — `listKnowledgeRoots` / `knowledgeGrep` / `knowledgeGlob` / `listWikiConcepts` / `readWikiConcept` / `readToolRefTool` 五个新私有方法 + `compressConfig` / `lazyStoreConfig` 两个 env-derived 类属性。
- **依赖** — 零外部新依赖（OpenDataLoader PDF 评估后明确不引入：硬依赖 JRE 11+ 与 Soul 单一 Electron 运行时定位严重冲突；详见 plan §6 决策档案）。

### 已知限制 / 后续（第二波）

- **WikiCompiler 实体提取质量低** — 把 markdown 加粗符号 `**` / 高频通用词「明确」/「数值」识别成实体，导致小堵 `wiki/concepts/` 文件名 `__.md` / `明确.md`。本期工具层加 fallback 反查容错，未修底层；治本需在实体提取阶段加 stop-words 过滤（1-2 天工程，触发条件：用户实战中明显感觉 wiki 路径价值受限再做）。
- **lazy-store 不是"自动省 token 神器"** — 实测单次 fetch + LLM 读页面场景：LLM 看到 lazy_ref 后立即 read_tool_ref 取回，反而多 1 轮工具调用（+token）。真正价值场景是「LLM 仅看 metadata 即可回答」（验证 URL 可访问 / 批量比对标题 / 状态码查询）+ 「多轮对话历史里旧 web_fetch 永远以 lazy_ref 形式驻留 history」。建议跑 1-2 周收数据决定是否调高阈值或加 LLM-side 提示。
- **OpenHuman 系列其他借鉴点暂缓**（详见 plan §3 + §6 + §7）：118 OAuth 连接器、桌面吉祥物 + lip-sync TTS、加入 Google Meet 当真人参与者、20 分钟全局 auto-fetch loop。
- **TDAI L1 Atom 严格摘要暂缓** — 跟 P2 Memory Tree 的「不 LLM 二次摘要 episode」红线冲突；触发重审条件：用户实战反馈"分身记不住关键事实" + P2 Memory Tree v1 机械合并版无法解决。

---

> 第一波"人类认知层"扩展（Phase 1 + 2 全套）：让分身**表达犹豫 / 记住过往对话 / 按 salience 调用回忆 / 渐进式遗忘**。借鉴 Anthropic Managed Agents 的 session-as-event-log + Life Experience 已有的 sigmoid 遗忘曲线；不引入额外服务，全部在主进程纯函数 + cron。

### 新增

- **Deliberation 表达（Phase 1）** — 分身可在真实犹豫 / 改主意时用 `[UNCERTAIN]...[/UNCERTAIN]` 或 `[RECONSIDER]...[/RECONSIDER]` 标记。`DELIBERATION_GUIDE` 软指引注入 `stableSystemText`（HARD_RULES 之后、人格之前）告诉分身只在真实情境用，禁止稀释每个判断的确信度。`chatStore` 在 `extractMemoryUpdates` 之后串行抽取，从展示文里抽掉，原话进 chip。`MessageBubble` 在消息泡下方渲染 🤔 / ↻ 颜色徽章（border + 软色 + title 完整文本提示），含截断 60 字 + 鼠标悬停展开。
- **对话情景记忆 / Episodic Memory（Phase 2a）** — 每次成功 assistant 回复后，chatStore 触发 fire-and-forget 抽取：把整段对话浓缩成一条 `ConversationEpisode`（title / theme / 200-500 字第一人称 summary / 3-5 条 keyQuotes / themes / valence -10~+10 / emotionType / importance 0-10 / consolidationStatus）。落盘到 `avatars/<id>/memory/episodes/<conv-id>.json`，一会话一文件。`shouldExtractEpisode` 做幂等：消息条数没变就跳过，避免每轮都重抽。
- **`recall_conversation` 工具（Phase 2b）** — 与 `read_life_episode` 对偶，分身在被问"上次/之前/那次聊过 X"时调用。query 拆 2-3 字 n-gram + 空白切，命中 title/theme/keyQuotes/summary 后按命中次数 + importance 加成排序，返回 top 1-3 条的完整 summary + keyQuotes。无命中时直接承认遗忘，prompt 守则禁止编造。注册到 `AVATAR_TOOLS`，在 plan/ask 模式按 read-only 默认放行（不在 `PLAN_MODE_BLOCKED_TOOL_NAMES`）。
- **「我和你的过去」system prompt 章节（Phase 2b）** — `soul-loader` 同步读 `memory/episodes/*.json`，按 salience desc 排序，注入 system prompt（在「我的人生」之后）。配 prompt 守则三条："不主动展开过去对话 / 被问起时调 `recall_conversation` 工具取细节 / 工具空返回时承认遗忘"。
- **Salience 评分引擎（Phase 2c）** — `packages/core/src/memory/salience.ts`：`computeSalience(importance, emotionMagnitude, recencyFactor, status, weights)`。Forgotten → 0；blurred 乘 0.6 penalty。Recency 由调用方按系统类型预计算：`computeWallClockRecencyFactor`（对话用 wall-clock 半衰期，默认 30 天）+ `computeAgeGapRecencyFactor`（人生事件用 age_gap 年级衰减）。配 17 个单测覆盖加权、forgotten 归零、NaN/clamp、半衰期数学、排序不变量。
- **二段式注入（Phase 2d，`SOUL_TWO_TIER_INJECTION` flag-gated）** — 启用后 system prompt「我和你的过去」改成：「## 当前焦点」3 条带 200 字 summary clip + 「## 长期仓库」剩余条目压缩为标题列表。flag OFF（默认）保留 flat 注入避免破坏现有行为；OFF 也已用 salience 排序，比之前的 importance-only 排序更贴近"想起什么"。
- **对话情景记忆遗忘 / Episode Forgetter（本期新增）** — `packages/core/src/memory/episode-forgetter.ts`：复用 Life sigmoid 算法但用月单位（α=0.10/月 vs life α=0.05/年），默认权重让"普通重要性的对话 12 月 → blurred / 24 月 → forgotten"，重要 + 高情感的 12 月内仍 remembered。每日 0:35 cron（life-advance-all 0:30 之后 5 分钟）跑 `runEpisodeForgettingAllAvatars`，逐分身重算 status，**仅写回变化的条目**（changedIds）减少磁盘写。`apply-episode-forgetting` IPC 提供手动触发，返回 R/B/F 计数便于调试。
- **Soul system prompt 引用 + recall 守则** — 详见上述章节注入。
- **会话 JSONL 事件流升级 / Event Viewer（前置基础设施）** — `<userData>/conversations/<conv>.jsonl` 现含 6 类事件：legacy message（无 type）、`conversation_started`、`memory_update`、`model_switch`、`mode_switch`、`sub_agent_task`。`ChatWindow` 顶栏 `◊ 事件` 按钮打开 EventViewer 模态，按类型过滤 chip + 时间线展示。
- **子分身派发持久化 / Managed-Agents Inspiration**（前置基础设施）— `SubAgentManager` + `TypedSubAgentManager` 都 fire `onChange` 回调；desktop sink 镜像到 sqlite `sub_agent_tasks` 表（v15 + v16 `agent_type` 列）+ JSONL。`markOrphanRunningAsLost` 在应用启动时清理上次崩溃留下的孤儿 running 任务。

### 修订

- **system prompt 装配主链路**（`packages/core/src/soul-loader.ts`）— 在「我的人生（出厂记忆）」之后新增「我和你的过去」章节。`readConversationEpisodesSafe` 同步读 episodes 目录（单 avatar 预期 <50 文件 × <5KB，全部 readSync 可接受）。损坏 / 不合法 JSON 文件被跳过仅 console.warn，不阻塞整体拼装。Forgotten 状态在本层就剔除，不进 system prompt。
- **`stableSystemText` 拼装**（`chatStore.ts`）— 现在是 `HARD_RULES + '\n\n' + DELIBERATION_GUIDE + '\n\n' + systemPrompt`，三段全部 cacheable。
- **chatStore 在 assistant 回复后**（chatStore.ts）— 增加 lazy episode 抽取触发（fire-and-forget，凭据缺失时静默跳过）；增加事件流写入（model_switch / mode_switch / memory_update / conversation_started）。

### 修复

- **`recall_conversation` 工具的 `top_k` 参数 NaN 边界** — 当 LLM 传 NaN 时之前会让 `Math.floor(NaN)` 一路传播到 `slice(0, NaN)` 返回空数组，静默失败。现在用 `Number.isFinite` 守卫，NaN 时回退到默认 `top_k=3`。

### 测试

- 新增 4 个独立单测文件，全部 node:test：
  - `salience.test.ts`：17 用例，覆盖加权 / forgotten 归零 / blurred penalty / NaN/clamp / 半衰期数学 / 年龄差衰减窗口 + 保底 / 排序不变量
  - `conversation-episode.test.ts`：15 用例，覆盖 store CRUD + 路径安全 + 解析容错 + 抽取 schema 校验 + 越界 clamp + emotionType 白名单 + code-fence 剥离 + 空 transcript 拒绝 + LLM 失败传播
  - `episode-forgetter.test.ts`：10 用例，覆盖 1 月内 remembered / 12 月 blurred / 24 月 forgotten / 高重要性高情感的 12 月仍 remembered / `|valence|` 等同性 / 异常未来时间 clamp / changedIds 增量 / 幂等回归 / 纯函数不变形 / 默认权重稳定点
  - `deliberation-extractors.test.ts`：8 用例，覆盖单/多/跨行 marker、空 marker、过长截断、两类不串扰、无 marker 正交、cleanText 移除
- 既有 `tool-router-delegate` / `sub-agent-manager` / `typed-sub-agent-manager-sink` / `spawn-guard` / `soul-loader` 测试零回归（241/241 core test + 25 desktop electron test 通过）。

### 工具 / 维护

- **每日 0:35 cron `episode-forgetting-all`** — 在 `life-advance-all`（0:30）之后 5 分钟跑。空分身列表 / 无 episodes 目录 / 单分身写盘失败 都不阻塞其他分身。
- **新增 IPC** — `extract-conversation-episode` / `list-conversation-episodes` / `read-conversation-episode` / `delete-conversation-episode` / `apply-episode-forgetting` / `record-memory-update-event` / `record-model-switch-event` / `record-mode-switch-event` / `read-conversation-events`。

### 项目治理

- **sqlite schema v15 → v16 → v17**：
  - v15：新增 `sub_agent_tasks` 表（子分身派发持久化）
  - v16：`sub_agent_tasks` 加 `agent_type` 列（承载 TypedSubAgentManager 的 explore/plan/worker）
  - v17：`messages` 表加 `uncertain_markers` + `reconsider_markers` 列（JSON 数组，承载 Deliberation 标记）
- **新增持久化目录** — `avatars/<id>/memory/episodes/` 每会话一 .json 文件
- **`@soul/core` 新增模块** — `memory/{episode-types,episode-store,episode-prompts,episode-extractor,salience,episode-forgetter}.ts`
- **依赖** — 零外部新依赖（全部在现有依赖里）

### 已知限制 / 后续

- **Life Experience 注入未做二段式** — `consolidated.md` 是 8K-cap curated 叙事，结构和 episodes 异质；本期 Salience + 两段式只覆盖 conversation episodes。若 Life timeline.json 想走同一 salience pool，留给后续 iteration。
- **`SOUL_TWO_TIER_INJECTION` 默认关闭** — 灰度策略：先用 flat 注入跑稳，观察 token 增长后再翻默认。环境变量 `SOUL_TWO_TIER_INJECTION=true` 启用。
- **Episode 浏览 UI 未做** — v1 让分身能自己用就够；UI 类似 LifePanel 留作后续。
- **抽取 latency**：每次回复后异步调一次 LLM 抽取 episode；用 chat slot 凭据，不会阻塞主回复。无凭据时静默跳过。
- **chat slot 没配时 episode 不会自动抽**：用户用 Claude（anthropic_api_key）但没配 chat_api_key（DeepSeek）时，每日 cron 仍会跑（不需要 LLM）但抽取永远不触发。可手动改 `extract-conversation-episode` IPC 走 anthropic 凭据。
- **Recall 的命中算法是简单 keyword + n-gram**：足够日常的"我们聊过 X"召回；如果将来要做语义召回，是嵌入 + ANN 的另一条路径。
- **Forgetter 默认权重 30-天月**：精度足够 conversation 衰减但不精确到日历月长度差异；权重对外暴露在 `DEFAULT_EPISODE_FORGETTING_WEIGHTS`，可单独调。

## v0.14.0 (2026-05-15)

> 引入 LLM Provider 抽象层与 Anthropic Claude 路径；新增对话级模型切换器与 system prompt 结构化分段（cache_control 准备就绪），为大体积 system prompt 做 Anthropic prompt cache 命中铺路。

### 新增

- **LLM Provider 抽象层（`desktop-app/src/services/llm-providers/`）** — 把原 `LLMService` 拆出 `LLMProvider` 接口 + 两个实现：`OpenAICompatProvider`（保留 DeepSeek / Qwen / OpenAI / Ollama 等 OpenAI 兼容协议，逐行迁移现有逻辑）与 `ClaudeProvider`（基于 `@anthropic-ai/sdk` 0.96.0，处理消息/工具/图片协议转换、流式 SSE、错误归一化）。`LLMService` 退化为 dispatcher，按 model 名前缀 `claude-*` 路由；非 Claude 模型仍走 OpenAI 兼容路径，行为零变化。
- **Anthropic API 凭据配置** — 设置面板「外部 API 凭据」tab（原「工具集成」）新增 Anthropic Claude 卡片，独立于 chat/creation/vision/ocr slot 体系；存为 sibling key `anthropic_api_key` / `anthropic_base_url`（默认 `https://api.anthropic.com`，支持改走 CF / Bedrock / 自建代理）。
- **对话级模型切换器** — ChatWindow 顶栏新增循环按钮（默认 / Opus 4.7 / Sonnet 4.6 / Haiku 4.5 / DeepSeek），写入 chatStore 的 `conversationModelOverrides` map。优先级：会话覆盖 > chat slot（避免分身 `defaultModel` 静默绕过用户设置的意外路径）。
- **结构化 system prompt 分段（`SystemBlock[]`）** — `ChatOptions.systemBlocks` 让上层声明哪些段落 `cacheable`。`ClaudeProvider.buildSystemBlocks()` 把 cacheable 段尾部插入 `cache_control: ephemeral`（最多 4 个 breakpoint，超出降级 + 警告）；`OpenAICompatProvider` 拍平成单条 system message，由 DeepSeek 自动 prefix cache 命中。
- **chatStore system 分层** — `sendMessage` 把 system prompt 拆成 `stableSystemText`（HARD_RULES + 分身 systemPrompt，cacheable）和 `dynamicSystemText`（@mentions intro / attachment guide / snipNoticeBlock，每轮变化不进 cache），按 SystemBlock[] 发送。
- **expert pack 推荐模型元数据** — 9 个 expert-pack.json 加 `defaultModel` 字段（电图 → claude-opus-4-7 推理重；其它 8 个 → claude-sonnet-4-6）。安装时通过 `writeInstalledAvatarConfig` 写入 `avatar.config.json#defaultModel`，与 `get-avatar-default-model` IPC 配套，为后续"推荐模型 hint" UI 留口。

### 修订

- **HARD_RULES XML 化 + 前置** — 9 条硬性应答规则用 `<critical_rules priority="highest" violation="人格失败">` 包裹，从 stable system 末尾挪到**最前面**。XML 标签语义保证权重不因位置变化丢失，且整块进入 prompt cache 前缀，Claude 路径上每轮节省同等 token。
- **Cache 命中日志规范化** — `OpenAICompatProvider` 与 `ClaudeProvider` 的 `[llm-cache]` 行统一带 `provider=` 标签和 `hit_ratio=` 字段；Anthropic 的 `cache_creation_input_tokens` / `cache_read_input_tokens` 与 DeepSeek 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 在 console 端形成对比基线。

### 修复

- **LLMService 构造抛错不阻塞 UI** — 选用 claude-* 模型但未配 Anthropic key 时，原本会让 `isLoading` 卡在 true 致 UI 永远「思考中」。chatStore.sendMessage 现在用 try/catch 包住 `new LLMService(...)`，构造期错误转为可见的 assistant 消息（含「请在设置 → 外部 API 凭据 → Anthropic Claude 填写 API Key」指引）+ `isLoading: false` 解锁。

### 工具

- **`desktop-app/scripts/rebuild-raw-from-source.ts`** — 新增 `_raw/` 重建工具。`avatars|expert-packs/*/knowledge/_raw/` 因 .gitignore 排除（单文件常 >100MB 超 GitHub 限制），本地清理后无法从仓库恢复，需要按 .md frontmatter 的 `raw_file:` 引用从外部源材料目录精准回填。脚本四阶段 CLI：`scan`（扫 .md → 引用清单）→ `match`（源目录递归 basename 匹配）→ `copy`（拷贝到 expert-packs/_raw/ 主存储 + 硬链接到 avatars/_raw/ 镜像）→ `verify`（双边断链校验 + 整合 match-report 写 REBUILD_LOG.md）。首次用于小堵-工商储专家：376 引用 → 359 命中 / 17 未命中（dashboard / EM-EHS / TS-002xxxx / 消防类，已在 `_raw/BACKLOG-NOTES.md` 留指引）。

### 项目治理

- **`desktop-app/package.json`** — 0.13.1 → 0.14.0
- **`desktop-app/package-lock.json`** — 同步根包版本字段
- **`@anthropic-ai/sdk`** — 新增依赖 ^0.96.0

### 已知限制 / 后续

- ClaudeProvider 不支持 thinking 多轮 round-trip：thinking content block 需要服务端 signature，无法从纯字符串 `reasoning_content` 重建。当前 thinking 文本仅作为 reasoning 显示，下一轮不回传 API。建议先不要给 Claude 分身指定 `*-thinking` 系列模型。
- avatar.defaultModel 字段已保留但不自动应用，作为推荐元数据等待未来 UI（如"推荐 Opus"badge）使用。
- 创作 / 视觉 / OCR 模型仍走 OpenAI-compat 路径——若要把这些 slot 也切 Claude，需要在 `test-generator.ts` / `soul-step-generator.ts` 等 caller 注入 Anthropic 凭据。

## v0.13.1 (2026-05-15)

> 修复 v0.13.0 Windows 安装版「点开后窗口不出现」的启动崩溃。

### 修复

- **Windows 启动崩溃（nodejieba 词典路径穿越 asar）** — `packages/core/src/knowledge-retriever.ts`：
  - **根因**：生产环境 `require.resolve('nodejieba/package.json')` 返回 `…/resources/app.asar/node_modules/nodejieba/…`，词典文件 `jieba.dict.utf8` 等由 cppjieba C++ 用 `fopen` 读取，无法穿透 asar 虚拟路径；cppjieba 在文件缺失时走 native `FATAL` 直接 `abort()` 进程。崩溃发生在主进程顶层 `import` 阶段，早于 `registerProcessCrashHandlers()` 注册，所以 Windows 上表现为「点开 exe 后窗口不出现，无任何日志」。
  - **修复**：新增 `resolveAsarUnpacked()`，把模块目录里的 `app.asar` 显式替换为 `app.asar.unpacked`（`electron-builder.yml` 的 `asarUnpack` 已经把 nodejieba 解出来）；同时在调 `jiebaBinary.load()` 之前用 `fs.existsSync` 预检 5 个词典文件，缺失即跳过 load 走降级，避免 native abort。
  - **降级路径**：`tokenize()` 增加 `jiebaLoaded` 标志，false 时改走 CJK 2-gram 滑窗切分，BM25 仍有可用 token，检索质量降级但应用可启动。

### 内部观测

- **`desktop-app/scripts/after-pack.js`** — 注释纠偏：明确说明 nodejieba 3.5.8 是 N-API 模块（`napi_register_module_v1`），上游官方只发 `node-v127` win32 prebuild，N-API 跨 ABI 兼容，Electron 41（真实 ABI 145）可加载；避免后续维护者按旧注释「electron 41 内嵌 Node 22 → 127」的错误推理把 `nodeAbi` 改成 `node-v145` 导致 404。

### 项目治理

- **`desktop-app/package.json`** — 0.13.0 → 0.13.1
- **`desktop-app/package-lock.json`** — 同步根包版本字段（v0.13.0 漏更新，本版顺带补齐 0.12.4 → 0.13.1）

## v0.13.0 (2026-05-14)

> 答案缓存终结 DeepSeek 同问不同答，并落地 agent-runtime 治理层与 decision-trace 决策回溯技能。

### 新增

- **答案缓存（cache_key 含 conversationId）** — SQLite schema v14 新增 `answer_cache` 表；同 user content + 同对话上下文命中即跳过 LLM 调用直接返回上次答案。`↻ AGAIN` 按钮可在 assistant 气泡 hover 时点击 bypass cache 重新生成（不写新 cache，保留稳定档）。`ENABLE_ANSWER_CACHE` 可关闭。
- **决策回溯技能 decision-trace** — 公共版进 `shared/skills/`；工商储版作为 local 覆写保留在 `expert-packs/小堵/skills/` 含 262 ODM2.0 / L05Pack 案例样例；8 个 expert-pack 的 skill-index 统一注册 shared 引用。HARD_RULES 同步加规则 8（决策回溯必须含具体料号/人名/原文）、规则 9（spool 必须 read_tool_result）。
- **read_tool_result 工具** — 专门读 ToolResultSpool 落盘的工具结果文件；解决 read_lines 因路径不在 workspace 被路径校验拒绝（"路径穿越"）导致中段证据丢失的问题。
- **agent-runtime 治理层（feature-flagged）** — `packages/core/src/agent-runtime/` 28 个文件 + 84 单元测试，覆盖 Phase 0-10 共 11 个机制（AgentBlueprint / Hook 总线 / AuditTrail / 类型化 subagent + SpawnGuard / PermissionEnforcer 三态 + PlanMode / 分段 prompt + cache_control / Memory 3 层 / EvalHarness / A2A AgentCard / 上下文压缩 / Ingest pipeline）。默认 SOUL_USE_NEW_RUNTIME=false 不影响旧路径。
- **agent-runtime 桥接观测** — 桌面端 `[agent-runtime] prompt cache stats`（理论 cacheable 占比）+ `[llm-cache] prompt_tokens=… cache_hit=…`（DeepSeek 真实 prefix cache 命中数）。实测小堵单条对话 cache_hit=99.8%，相比假想无缓存省 ~74% 输入 token。

### 修订

- **HARD_RULES 规则 7** — reasoning_content / Chain-of-Thought 必须用简体中文输出。
- **HARD_RULES 规则 8** — 决策回溯类问题必须给具体料号 / 人名 / 项目阶段 / 原文片段；禁用"产品定位""侧重""兼顾"等泛词；至少 3 个考量点；来源用原文件名（禁 `_excel/*.json`）。
- **HARD_RULES 规则 9** — spool 落盘的工具结果必须用 `read_tool_result` 读取，禁用 `read_lines / read_file`（会路径穿越失败）。
- **来源 chip normalize** — `[来源: knowledge/_excel/X.json#sheet=…]` 在 SourceCitation 渲染前自动映射为 `knowledge/X.xlsx#sheet=…`，仅作用于 anchor 块内，不影响 LLM 叙述。
- **设置面板模型 slot helpText** — "默认 XXX" → "建议使用公司提供的 GPT / Claude / 多模态 / OCR 模型；如需使用外部模型，请先报备，确保数据不外泄"。

### 内部观测

- LLM SSE 解析现在捕获 `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，按 `[llm-cache]` 行输出到 DevTools console，方便长期观察 prompt 设计变化对 DeepSeek 自动 prefix cache 命中率的影响。
- 端到端模拟脚本：`desktop-app/scripts/agent-runtime-simulate.ts`（9 expert-pack 批量算 cacheable 占比）、`agent-runtime-dev-trace.ts`（模拟桌面端 console 输出）、`anthropic-cache-pilot.ts`（备用，等未来切 Claude SDK 时启用）。

## v0.12.4 (2026-05-13)

> RAG 改为纯 agentic 检索；修复切换会话导致答复消失；工具路径与小表 Excel 查询护栏；主进程分词 OOM 修复；Emoji / 思考过程持久化等对话体验修补。

### RAG 与检索

- **Agentic-only 检索** — 移除发消息前的 BM25 预注入；由 LLM 按需调用 `search_knowledge`（工具说明强化红线：专业事实须调用，寒暄与格式偏好等禁止调用）。新增 Phase 0.5 埋点（调用次数、结果体量、TTFT、总延迟）写入活动日志，供后续成本与行为回溯。
- **主进程分词** — 以 `nodejieba` 替代 `segmentit`，消除主进程 OOM。

### 对话与 UI

- **切换会话不中断后台流** — `resetTransientState` 不再 `abort` 正在进行的 LLM 流；`sendMessage` 内以「当前查看的会话」闸门更新 UI，答复照常落库，避免切走再切回时「回答消失」。
- **Emoji → 内联 SVG**、**`reasoning_content` 持久化**（DB schema v13）、**引用展示回退** 等聊天区小修复。

### 工具路由

- **`read_knowledge_file`** — 自动剥掉 `knowledge/`、`./knowledge/` 等前缀，与 `search_knowledge` 返回锚点路径对齐，避免拼出重复 `knowledge/knowledge/`。
- **`query_excel`** — 对行数 ≤50 的小表放宽「必须 filter / columns / limit」护栏，减少无意义重试；大行数表行为不变。

### 项目治理

- **`desktop-app/package.json`** — 0.12.3 → 0.12.4
- **`desktop-app/package-lock.json`** — 同步根包版本字段

## v0.12.3 (2026-05-11)

> 知识库回答规则细化（解决「所有回答必须基于知识库」过严问题）+ Windows 安装版「窗口直接消失」无日志可查的崩溃诊断兜底。

### 行为准则升级：知识库回答规则细化

**旧规则痛点**：`templates/agent-template.md` 旧版规则「所有回答必须基于知识库」过于绝对，导致寒暄、确认、需求澄清、格式偏好确认等非知识类问题也强行触发知识库检索，回答冗长且失去对话节奏。

#### 区分「检索」与「不检索」（`AGENTS.md` / `CLAUDE.md` / `templates/agent-template.md`）

- **必须检索**：专业事实、参数、数据、方案取舍、工程决策、评审结论
- **不检索**：寒暄、确认、需求澄清、对话承接、格式偏好确认、开放式头脑风暴

#### 知识库事实问答 / 工程决策类回答稳定规则（`templates/agent-template.md` +49 行）

**适用范围**：仅强制适用于基于本地 `knowledge/` 的事实问答、产品参数解释、BOM / 物料 / 供应商 / 成本 / 评审结论查询，以及"为什么选择 / 为什么没有采用 / 方案取舍"等工程决策类回答。

**固定五段式回答结构**（可按复杂度压缩为「结论 + 来源」）：
1. **结论先行** — 一句明确结论，标注「已确认事实」与「判断方向」
2. **依据** — 按证据强度组织（不按检索片段随机顺序）
3. **判断** — 区分事实与推断
4. **不确定项 / 需核对项** — 版本 / 口径 / 命名 / 成本范围不一致时单列
5. **一句话总结** — 用业务方能理解的话收束，不新增未引用事实

**证据优先级**（多文件命中时按此组织）：
1. 评审结论 / 决策文件
2. BOM / 物料表 / 技术协议
3. 产品信息输入清单 / 确认清单
4. 图纸 / 规格书 / 过程材料
5. 会议纪要 / 零散备注

**事实归并要求**：先归并为「已确认事实 / 基于事实的判断 / 不确定项 / 最终建议」四块，再组织语言；同一事实多来源时优先引用高优先级来源。

**表达强度约束**：
- 原文明确写到的才能作事实陈述；从多条事实推出的内容必须用「说明 / 意味着 / 倾向于 / 风险在于」等判断措辞
- 禁止把「需确认」写成「已经确定」
- 禁止把「技术可评估但风险高」写成「完全不能用」
- 禁止把不同来源的料号 / 成本 / 版本混写成同一来源

**一致性自检**（最终回答前默念）：是否结构匹配复杂度 / 是否优先引高优先级证据 / 是否区分事实与推断 / 是否存在与证据不一致的绝对化表述。

#### 全局核心约束补强（`AGENTS.md` / `CLAUDE.md`）

- 知识库优先约束细化为「专业问题检索 / 寒暄类不检索」
- 新增「**稳定回答**」核心约束：知识库事实问答 / 工程决策类回答先归并事实判断与不确定项再按复杂度组织；简单查询可压缩为「结论 + 来源」

### 修复

- **`desktop-app/electron/main.ts`** (+87 行) — 主进程崩溃诊断兜底：
  - **解决问题**：Windows 安装版偶发「窗口直接消失」，但因为崩溃发生在 `initManagers` 之前或 Logger 自身不可用时，旧实现 `console.error` 无任何持久化痕迹，用户无从排查
  - **`writeCrashDiagnostic(source, detail)`** — 兜底诊断写入：优先走 Logger，Logger 失效时直接 `appendFileSync` 到 `app.getPath('userData')/logs/error-YYYY-MM-DD.log`；本身被 try/catch 包裹防二次异常吞掉真正的崩溃原因
  - **`registerProcessCrashHandlers()`** — 注册三类崩溃处理：
    - `process.on('uncaughtException')` — 弹窗（`dialog.showErrorBox`）+ 写日志
    - `process.on('unhandledRejection')` — 静默写日志
    - `app.on('child-process-gone')` — GPU 进程 / 渲染进程崩溃记录 details

### 项目治理

- **`desktop-app/package.json`** — 0.12.2 → 0.12.3
- **`desktop-app/package-lock.json`** — 同步版本号传播（注：上一版漏更新 lockfile，本版补齐 0.11.0 → 0.12.3）

## v0.12.2 (2026-05-11)

> **架构里程碑**：分身体系正式从 `avatars/` 迁移到 `expert-packs/`。`expert-packs/` 成为唯一的「分身分发源」，`avatars/` 退化为运行时安装目录。同步发布「设计大师」专家包，并新增 G3.3 反结构错位幻觉规则。

### 架构变更：分身分发源迁移到 `expert-packs/`

**变更动机**：v0.12.0 引入 `expert-packs/` 时只放了 7 个占位脚手架，真实分身（小堵）仍住在 `avatars/`，造成「分发源」与「运行时数据」混在同一个目录的歧义。本版本完成清晰分层：

- **`expert-packs/<id>/`** = 分身的**分发源**（含完整 `expert-pack.json` + soul.md + AGENTS.md / CLAUDE.md + 完整 knowledge/ + skills/ + 测试用例）
- **`avatars/<id>/`** = 用户安装后的**运行时数据**（由 expert-pack 复制而来，加上用户自己的 memory / life / workspaces 等运行时产物）

**首发的两个含真实知识的专家包**：

- **`expert-packs/小堵-工商储专家/`** — 工商业储能产品解决方案专家「小堵」正式作为开源专家包发布：含 382 个真实知识库 .md（产品质量 dashboard / BOM / 认证报告 / 技术协议 / 电气原理图等）+ life/ 出厂记忆 + memory/ + skills/（chart-from-knowledge / draw-chart / query-product-quality 等）+ document-templates/ + 5 个测试用例
  - 红线：「提供方案与测算草案；不替代正式商务报价、合同条款或施工签证；友商比价禁止报任何数字。」
- **`expert-packs/design-master/`** — 「设计大师」专家包首次公开发布：基于 `shared/design-systems/` 73 套品牌语料的设计系统 / 品牌 / 信息架构 / 交互设计专家

**`avatars/` 目录改造**：
- 仓库内 `avatars/` 目录用 `.gitkeep` 占位保留，实际分身数据全部迁出
- 旧的 `avatars/小堵-工商储专家/{CLAUDE.md, soul.md, skills/, memory/, wiki/, ...}` 等已跟踪文件全部 `git rm`（迁移到 `expert-packs/小堵-工商储专家/` 对应路径）

**文档同步**：
- **`AGENTS.md`** / **`CLAUDE.md`** — 「当前可用分身」表格全部指向 `expert-packs/` 路径，新增「所有分身均以专家包形式存放在 `expert-packs/` 下，安装后会被复制到 `avatars/<id>/`」说明，并补齐 8 个分身（含 design-master）
- **`desktop-app/electron/kb-question-generator.ts`** — JSDoc 路径示例从硬编码 `avatars/` 改为 `<avatarRoot>`，明确「dev 工作区为 `avatars/`，出厂分发为 `expert-packs/`」
- **`desktop-app/src/services/raw-file-resolver.ts`** + **`src/types/raw-file-anchor.ts`** — `avatarId` JSDoc 更新为「分身 ID（专家包或 avatars 目录名）」

### 新增反幻觉规则

- **`templates/agent-template.md`** — 新增 **G3.3 结构错位禁令**（"标题先写数字、正文再说没有"反模式）：
  - **真实事故触发**：用户问"土壤密实度 / 桥架管 / 间距 / 排水"四项施工要求，分身在「❌ 土壤密实度 ≥98%」标题里直接写了 ≥98%（知识库实际无此数据），后文才说"知识库未提供"。用户第一眼看到带数字的标题就被误导
  - **5 条硬性约束**：
    1. 禁止在结构骨架的「标识位」（章节标题 / 表头 / 卡片标题 / 列表项首句 / 总结表数值列）出现具体数字 / 型号 / 单位，除非该数字已被本轮工具真实返回
    2. 禁止「先写数字标题，后写未查到正文」（用户读不到第二行）
    3. 没有数据的项：标题/表头格只允许写 `❓ <项目名>（知识库未提供）` 或 `<项目名> — 待补充`，禁止数值 / 单位 / 范围 / 比较符号
    4. 总结表「数值」列未命中填 `—` 或「未提供」，禁止「≥98%」「约 X 米」「通常为 Y」等占位数字
    5. 部分命中只写工具真实返回的部分，禁止补齐（如「地面坚实平坦」不得升级成「地面密实度 ≥X%」）
  - 等同 G3.2 红线，违反按编造数据处理
  - 配套回答前自检默念句 + 反面示范 + 正面示范

### 小型改动

- **`desktop-app/scripts/batch-enhance-frontmatter.ts`** / **`batch-reparse-excel.ts`** / **`knowledge-inspect.ts`** / **`regression-prepare-table.ts`** — 路径与文档微调（适配 `expert-packs/` 安装路径）
- **`desktop-app/src/App.tsx`** / **`index.css`** — UI 小调整
- **`testdocs/dry-run-format.ts`** / **`test-draw-chart-template.ts`** / **`knowledge-standard-gate-baseline.json`** — 测试基线更新

### 项目治理

- **`desktop-app/package.json`** — 0.12.1 → 0.12.2

## v0.12.1 (2026-05-11)

> Life 模块完善 + UI 优化的聚焦补丁版。核心是「**人生姓名三态体系**」，禁止 AI 在用户未确认前自行编造真实姓名；同时新增骨架编辑 / 重新生成能力，与 Stage 0 质量硬校验。

### 新功能

#### 人生姓名三态体系（防 AI 自行编造真实姓名）

- **`packages/core/src/life/types.ts`** — `LifeManifest` 引入 4 个新字段：
  - `displayName` — 分身展示名（来自 `avatar.config.json` / 创建向导）
  - `personaName` — 人生经历使用名（**未获用户确认时必须等于 displayName**）
  - `realNameConfirmed: boolean` — 用户是否已显式确认真名
  - `nameSource: LifePersonaNameSource` — `'avatarName' | 'user' | 'aiSuggested'` 三态来源
- **`packages/core/src/life/generator.ts`** — `resolvePersonaName()` 在 Stage 0 决定 personaName，未确认时强制回退到 displayName；`ensureManifestIdentity()` 兼容 v0.11/v0.12.0 旧 manifest 在 Stage 1+ 续跑时补齐三态字段
- **`packages/core/src/life/prompts.ts`** — Stage 0 manifest prompt 增加：
  - 上下文段：`人生经历使用名` + `姓名是否已由用户确认`
  - 硬规则 #8：「如果姓名未由用户确认，不得自行创造真实姓名；所有自述和家庭背景都围绕「{personaName}」展开」
  - JSON Schema：`personaName` 字段值固定为传入的 personaName，重要提示禁止改名
- **`desktop-app/src/components/wizard/LifeScriptStep.tsx`** — 创建向导第 5 步「人生剧本」新增姓名输入项 + 「使用分身名」/「自定义姓名」切换 + 确认勾选
- **`desktop-app/src/components/LifePanel.tsx`** — `handleStartGeneration` / `handleRetry` 全链路传递 `personaName / personaNameConfirmed / nameSource`

#### Manifest 编辑 + 重新生成

- **`packages/core/src/life/store.ts`** — 新增 2 个 API：
  - `updateLifeManifest(avatarsRoot, avatarId, patch)` — 用户在 UI 编辑骨架字段（displayName / personaName / gender / birthplace / familyBackground / personalityArc / professionalSpine / majorRelationships），不动 timeline / episodes
  - `resetGeneratedLife(avatarsRoot, avatarId, now, options)` — 清空 timeline / progress / consolidated / episodes/，**保留 manifest** 作为下一次重生成的骨架；统计字段重置为 pending
- **`packages/core/src/life/types.ts`** — `LifeManifestUpdate` 新类型，明确允许 UI 编辑的字段白名单（生成器统计字段不暴露）
- **`packages/core/src/index.ts`** — 公开导出 `updateLifeManifest` / `resetGeneratedLife` / `LifePersonaNameSource` / `LifeManifestUpdate`
- **`desktop-app/electron/main.ts`** — 新增 IPC `life:update-manifest` / `life:reset-and-regenerate`，配套 `preload.ts` + `global.d.ts` 暴露 API
- **`desktop-app/src/components/LifePanel.tsx`** — 新增「编辑骨架」弹窗与「重置并重新生成」确认弹窗：
  - **智能 retry**：如果 `completedEpisodes === 0`（从未生成成功），调用 `resetAndRegenerate` 清空失败骨架；否则走断点续传 `retryGeneration`
  - 骨架编辑界面允许微调 personaName / familyBackground / arc 等设定，保存后下次重生成基于新设定

### 修复

- **`packages/core/src/life/generator.ts`** — Stage 0 manifest 质量硬校验 `validateGeneratedManifestSkeleton()`：
  - `familyBackground` 不能为空
  - `personalityArc` ≥ 4 项 / `professionalSpine` ≥ 3 项 / `majorRelationships` ≥ 3 项
  - 任一不达标抛出明确错误信息，让用户重试或补充更明确的 soul.md / 额外要求（之前 LLM 偷懒输出空骨架时会无声写入 manifest，导致 Stage 1 outline 失败原因不清晰）
- **`packages/core/src/life/generator.ts`** — `sanitizeAvatarBrief()` 过滤桌面端默认头像哨兵字符串（如 `default:avatar-007`）；之前会被当作角色简介塞进 prompt，污染 manifest 生成
- **`packages/core/src/life/generator.ts`** — `normalizeArcItems()` 对 trim 后为空的文本项直接跳过；之前会写入 `{ age: N, shift: '' }` 造成时间轴展示空白条目
- **`packages/core/src/life/generator.ts`** — manifest 续跑逻辑收紧：之前 `progress.stage === 'idle'` 也会重跑 Stage 0，可能让已生成的 episodes 与新 manifest 严重不一致；现在仅在 `manifest === null` 或显式 `stage === 'manifest'` 时才重跑
- **`desktop-app/src/services/raw-file-resolver.ts`** + 测试 — 原始文件解析微调

### UI 改进

- **`desktop-app/src/components/LifePanel.tsx`** (+528 行) — 编辑骨架 / 重置确认 / 姓名展示等大量 UI 完善
- **`desktop-app/src/components/PixelNavBar.tsx`** (+77 行) — 像素风导航栏视觉与交互优化
- **`desktop-app/src/components/SettingsPanel.tsx`** (+38 行) — 设置面板调整
- **`desktop-app/src/components/Sidebar.tsx`** / **`App.tsx`** / **`CreateAvatarWizard.tsx`** / **`life/LifeTimeline.tsx`** — 配套 props / 状态联动
- **`desktop-app/src/index.css`** (+50 行) — 像素风样式补充

### 测试

- **`packages/core/src/tests/life-store.test.ts`** (+62 行) — 新增 `updateLifeManifest` / `resetGeneratedLife` 双向校验
- **`packages/core/src/tests/life-generator.test.ts`** (+118 行) — 新增 personaName 三态分支 / Stage 0 质量校验抛错 / sanitizeAvatarBrief / normalizeArcItems 空文本过滤
- **`packages/core/src/tests/life-forgetter.test.ts`** / **`life-grower.test.ts`** — 跟随 manifest 三态字段的小幅适配
- **`desktop-app/electron/asr-session.test.ts`** + **`asr-session.ts`** — ASR 会话生命周期微调

### 项目治理

- **`desktop-app/package.json`** — 0.12.0 → 0.12.1
- **`expert-packs/finance-expert/avatar.txt`** — 简介微调

## v0.12.0 (2026-05-10)

> **重大里程碑**：本次发布跨越 ISS #2 / #3 / #4 / #5.5 / #7 / #8 / #11 / #13 / #14 / #15 / #16 共 11 个迭代单（指挥官-W19 周期），并新增 ASR 流式语音、Anthropic 兼容 Proxy、LangBot 集成、专家分身包、复合知识检索等多项 P0+ 能力。版本号 0.11.0 → 0.12.0。

### 数据持久化与一致性

- **#2 SQLite + JSONL 双写架构** — 对话与消息从纯 JSONL 升级为 SQLite 主库 + JSONL 影子日志双写：SQLite 提供 O(1) 查询和事务，JSONL 保留人类可读 / 可手动恢复的 fallback。
- **#5.5 全新安装时补建 `mcp_servers` 表** — DB schema migration 修复，避免新机器首启 schema 不一致。
- **#4 ToolRouter workspace paths 与 WorkspaceManager 对齐** — 修复 `query_excel` / `read_knowledge_file` 等工具在引入 WorkspaceManager 后路径解析不一致的回归。
- **`scripts/migrate-workspaces-to-default-layout.mjs`** — 历史 workspaces 一次性迁移到 `<avatarRoot>/projects/default/workspaces/` 二级分区结构。
- **`packages/core/src/avatar-project.ts`** — 引入 `DEFAULT_AVATAR_PROJECT_ID = 'default'` 常量，为「分身 → 项目（二级分区）→ 会话」三级数据模型奠基。

### 知识与 RAG

- **#13 `knowledge-inspect` CLI** — 新增 `scripts/knowledge-inspect.mjs`，命令行直接诊断分身知识库的 chunk 切分、embedding 命中、source-anchor 覆盖。
- **#14 模板化文档分块（Template-based chunking）** — `document-parser` 新增 PDF 页 heading 与 Word 标题层级感知，长文档分块更贴合人类目录结构，检索召回提升。
- **ISS #3 工具列表 embedding 重排** — LLM 调用前对工具描述按 query 做 embedding rerank，热点工具优先曝光（详见 `tool-embedding-rerank` 模块）。
- **`packages/core/src/composite-knowledge-retriever.ts`** — RRF（Reciprocal Rank Fusion）合并「分身全局知识」与「`projects/<id>/knowledge` 项目级知识」检索结果，为多项目多知识源场景做检索融合（`RRF_K = 60` 经典参数）。

### 记忆系统

- **#8 结构化白盒记忆条目** — `memory/MEMORY.entries.json` 取代纯文本 `MEMORY.md`，每条记忆带 id / type / source / timestamp / confidence / tags 等结构化字段，支持「白盒检索 + 黑盒回放」双模式。

### 自动化

- **#11 用户自定义定时任务（cron expressions）** — 用户可在桌面端配置 cron 触发的定时任务（如「每天 9 点汇报昨日工作」「每周一推送本周计划」），与 Phase 2 持续生长 cron 共用调度框架。

### 集成 / 互操作

- **#15 Web Embed widget 双进程双端点架构** — 独立 `widget-server` 进程 + Preact bundle（gzip 仅 10KB），可嵌入任意网页与分身对话，与桌面端共用 SQLite 数据库。
- **#16 WebDAV 跨设备同步（指挥官-W19）** — 通过任意 WebDAV 服务（坚果云 / Nextcloud / 自建）实现分身、对话、记忆、知识库的跨设备增量同步，冲突自动按 mtime 取较新版本。
- **Anthropic 兼容 Proxy 服务（P0+ 方案 A）** — `desktop-app/electron/proxy-server.ts` + `src/lib/anthropic-proxy-protocol.ts` + `src/services/proxy-api-bridge.ts`：本地 `127.0.0.1:18888` 暴露 Anthropic Messages API 兼容端点（鉴权 + 协议转换），让 Claude Code / Cursor / 任何 Anthropic SDK 客户端可直接把分身当作 LLM 后端调用。业务对话仍由渲染进程 `sendMessage` 同源链路执行（避免双重路由）。
- **LangBot 集成** — `desktop-app/docs/langbot-integration.md` 完整接入指南，覆盖 OneBot / 微信 / QQ / 钉钉等多平台机器人通过 Anthropic Proxy 调用分身。

### 语音

- **豆包流式 ASR（Doubao ASR Streaming）**：
  - `packages/core/src/audio/doubao-asr-protocol.ts` — 协议帧编解码（FullClientRequest / AudioOnlyRequest / parseDoubaoAsrServerResponse）
  - `desktop-app/electron/asr-session.ts` — 主进程 WebSocket 鉴权与协议帧收发，渲染进程只上传 16kHz PCM 分片（无浏览器侧鉴权暴露）
  - `desktop-app/electron/asr-session.test.ts` + `packages/core/src/tests/doubao-asr-protocol.test.ts` — 协议解析与 session 生命周期单测
  - `desktop-app/docs/doubao-asr-streaming.md` — 接入文档与配置说明

### 权限 / 模式

- **ISS #7 会话级 Permission Mode（Ask / Plan / Agent）+ 工具灰名单**：
  - `packages/core/src/tool-permission-policy.ts` — 纯函数门禁，按会话模式 + 信任层（`ui` / `proxy`）双维度评估每次工具调用
  - Plan 模式下自动禁用写操作类工具（`PLAN_MODE_BLOCKED_TOOL_NAMES`），与会话侧边栏 badge 对齐
  - `desktop-app/electron/conversation-tool-mode-registry.ts` — 主进程会话模式注册表
  - `packages/core/src/tests/tool-permission-policy.test.ts` — 模式 × 信任层全矩阵覆盖

### 分身工程化

- **专家分身包（Expert Packs）`expert-packs/`** — 7 套开箱即用的专科分身脚手架（含 `expert-pack.json` 清单 + `soul.md` + `AGENTS.md` / `CLAUDE.md` + `knowledge/` 占位 + `skills/skill-index.yaml` + `tests/cases/`：红线 2 + 知识库约束 1 + 数据溯源 1 + 人格 1）：
  - `electrical-engineer-expert` — 电气工程专家
  - `finance-expert` — 财务分析专家
  - `hr-expert` — 人力资源专家
  - `legal-expert` — 法律合规专家
  - `market-analyst-expert` — 市场分析专家
  - `product-manager-expert` — 产品经理
  - `project-manager-expert` — 项目经理
- **`desktop-app/src/components/ExpertPackPanel.tsx`** — 桌面端专家包安装/管理 UI
- **`packages/core/src/avatar-quality-scores.ts`** + 测试 — 分身质量评分模型（红线通过率 + 知识库覆盖 + 人格一致性等多维度）
- **`templates/avatar-project-layout.md`** — 二级分区目录结构规范文档

### 桌面端 UI / 主进程改动

- `desktop-app/electron/main.ts` — 新增大量 IPC（asr / proxy / 专家包 / 项目分区 / 定时任务等）
- `desktop-app/electron/preload.ts` / `desktop-app/src/global.d.ts` — API + 类型同步
- `desktop-app/electron/connectors/github-connector.ts` — GitHub 连接器修复
- `desktop-app/electron/test-manager.ts` + `desktop-app/src/services/test-runner.ts` — 测试管理器与 runner 升级
- `desktop-app/electron/workspace/WorkspaceManager.test.ts` — WorkspaceManager 测试补强
- `desktop-app/electron-builder.yml` — 打包配置更新（新增 widget-server / asr 相关 native deps）
- `desktop-app/src/App.tsx` — 注册 ExpertPackPanel + Anthropic Proxy 状态显示
- `desktop-app/src/components/AvatarSelector.tsx` / `ConversationList.tsx` / `MessageInput.tsx` / `SettingsPanel.tsx` / `Sidebar.tsx` / `TestPanel.tsx` — UI 多处升级（项目分区切换、ASR 麦克风入口、Permission Mode badge、Proxy 端口配置等）
- `desktop-app/src/stores/chatStore.ts` — 接入 SQLite 双写、Permission Mode 守卫、composite knowledge retriever
- `packages/core/src/browser.ts` / `index.ts` — 公开导出 audio / avatar-project / composite-knowledge-retriever / tool-permission-policy 等新模块

### 文档与项目治理

- **`AGENTS.md` / `CLAUDE.md`** — 根目录全局规则同步：补充 expert-packs、Permission Mode、Anthropic Proxy 章节
- **`.gitignore`** — 新增大文件资产排除规则（`assets/*.mp4` / `*.mov` / `归档.zip` / `AI分身提效案例.*`）防止误提交超过 GitHub 100MB 限制的素材
- **`desktop-app/package.json`** — 0.11.0 → 0.12.0
- **`desktop-app/package-lock.json`** — 同步新依赖（`ws` / `webdav-client` 等）

## v0.11.0 (2026-05-09)

### 新功能：AI 分身「人生经历」系统（Phase 1-6 完整落地）

让每个分身在「灵魂 + 知识库 + 技能」之外，再拥有一段 **完整可生长的人生**。生成的人生由「出厂记忆」（≤ 8K 字 consolidated.md，注入 system prompt）+ **60-100 个 episode 全文**（按需通过 `read_life_episode` 工具读取）组成；支持真实时间映射（1×/12×/52× 或冻结），cron 自动推进，遵循「不主动展开往事 / 被问起再翻日记 / 风格沉淀不背诵 / 不剧透未来」四条人生使用守则。

#### Core 模块（`packages/core/src/life/`）

- **`types.ts`** — `LifeManifest` / `LifeTimelineEntry` / `LifeEpisode` / `LifeProgress` / `LifeFailedEpisode` 完整 schema，与 plan 1.1/1.2 节字段一一对应
- **`store.ts`** — `life/` 目录读写纯函数：`getLifeDir` / `readLifeManifest` / `writeLifeTimeline` / `appendLifeTimelineEntry` / `readLifeEpisode` / `writeLifeEpisode` 等 20+ 个，所有写操作走 `atomicWrite`（临时文件 + rename）防进程崩溃损坏；`avatarId` / `episodeId` 经 `assertSafeSegment` + 拒 `.` 开头 + 拒扩展名三重校验
- **`generator.ts`** — 4 Stage Pipeline：
  - Stage 0 `generateManifest` — 角色名 / 出生地 / 家庭背景 / personalityArc / professionalSpine / majorRelationships
  - Stage 1 `generateOutline` — 按年龄段（婴幼/童年/青少年/青年/壮年/中年/老年）分配事件配额（`DEFAULT_OUTLINE_TARGET_COUNTS`）
  - Stage 2 `generateEpisode` — 逐事件生成 2-5K 字传记正文，断点续传 + `failedEpisodes` 跳过
  - Stage 3 `applyAlgorithmicForgetting` + `generateConsolidated` — 双重遗忘：算法初筛（重要性 + 情感强度 + 类别 / `DEFAULT_FORGETTING_WEIGHTS`）→ LLM 写 ≤ 8K 字 consolidated.md（`CONSOLIDATED_MAX_CHARS`）
- **`grower.ts`** — Phase 2 持续生长（cron Stage 4）：`advanceLife` / `advanceAllAvatars` / `computeAvatarDeltaMonths`（按 timeScale 算时间增量）/ `samplePendingMonths` / `shouldReconsolidate`（每 +5 个事件触发一次重整）；进程内锁 `__clearGrowthLocksForTesting` 防 cron 与初始化生成冲突
- **`density.ts`** — 事件密度算法（按年龄分布 + `DEFAULT_DENSITY_WEIGHTS`），决定每月该新增几个事件
- **`forgetter.ts`** — 算法遗忘 + consolidated 触发条件
- **`prompts.ts`** — 4 套 system prompt：`MANIFEST_SYSTEM_PROMPT` / `OUTLINE_SYSTEM_PROMPT` / `EPISODE_SYSTEM_PROMPT` / `CONSOLIDATED_SYSTEM_PROMPT`，配套 `buildXxxPrompt()` 模板拼装函数

#### 桌面端面板（`desktop-app/src/components/`）

- **`LifePanel.tsx`** — 「人生」主面板，5 态状态机：`no-life` / `generating` / `failed` / `ready` / `growing`，订阅 `life:progress` 事件实时刷新进度条
- **`life/LifeTimeline.tsx`** — 时间轴展示，按年龄分组，区分 `remembered` / `blurred` / `forgotten` 三种 consolidationStatus
- **`life/LifeEpisodeViewer.tsx`** — 单事件正文阅读器（react-markdown + remark-gfm）
- **`life/LifeTimeScaleModal.tsx`** — 时间速率切换弹窗（1×/12×/52×/冻结）
- **`wizard/LifeScriptStep.tsx`** — 创建向导新增第 5 步「人生剧本」（默认勾选 + 30 岁 + 1× 真实同步）

#### Electron 主进程（`desktop-app/electron/`）

- **`main.ts`** — 注册全套 `life:*` IPC handler（+337 行）：`start-generation` / `read-bundle` / `read-episode` / `cancel` / `retry` / `update-time-scale` / `delete` 等，所有 handler 走 `wrapHandler` 统一错误处理
- **`preload.ts`** — `window.electronAPI.life.*` API 暴露（+42 行）
- **`cron-scheduler.ts`** — 注册「人生持续生长」cron 任务（+130 行），调用 `advanceAllAvatars` 推进所有启用 `growthEnabled` 的分身，与初始化生成共享进程内锁
- **`global.d.ts`** — 渲染端 `LifeManifest` / `LifeTimelineEntry` / `LifeProgress` 平行类型声明 + life IPC API 类型（+244 行）

#### Soul 注入（`packages/core/src/soul-loader.ts`）

- 启动时读取 `avatars/<id>/life/consolidated.md`，注入到 system prompt 的「知识库之后、工具说明之前」位置，标题为「# 我的人生（出厂记忆）」
- 同步注入「人生使用守则」4 条：
  1. **不主动展开往事**：除非用户明确问起，否则不要在日常回答中讲人生故事
  2. **被问起时再翻日记**：用 `read_life_episode(id)` 取完整正文
  3. **风格沉淀，不直接背诵**：判断 / 隐喻 / 价值偏好可以从经历"长"出来
  4. **不剧透未来**：视角停在当前年龄
- 工具说明区新增 `read_life_episode(id)` 行

#### 工具层（`packages/core/src/tool-router.ts`）

- 新增 `read_life_episode(id)` 工具：让分身在用户问起具体往事时"翻日记"读取 episode 全文（2-5K 字 × 60-100 个，不进 prompt 仅按需读取，节省 token）
- 路径安全：`avatarId` 在外层 execute 已经过 `assertSafeSegment`，`episodeId` 通过 `getLifeEpisodePath` → `assertSafeEpisodeId` 三重校验

#### 共享 UI（`desktop-app/src/components/shared/`）

- **`Toast.tsx`** — 新增可选 `onClick` 回调：传入时切换为 `<button>` 角色 + `cursor-pointer`，用于"点击 Toast 跳转面板"场景（如分身创建后提示去 LifePanel 看进度）

#### 渲染端粘合（`desktop-app/src/`）

- **`App.tsx`** — 注册「人生」面板 Tab（图标 ❀）+ `showClickableToast()`（5s 显示，点击关闭并触发回调）+ `handleAvatarCreated` 新增 `lifeStarted` 参数
- **`CreateAvatarWizard.tsx`** — 5 步 → 6 步向导（插入「人生剧本」），创建成功后异步触发 `window.electronAPI.life.startGeneration()`（fire-and-forget，失败仅 logEvent 不阻塞向导）；fallback 黄色提示「→ 去设置配置」
- **`services/life-service.ts`** — 渲染端 service 封装 + `LifeBundle` / `LifePanelMode` / `VALID_TIME_SCALES` 等纯函数

### 测试（`packages/core/src/tests/`）

- **`life-store.test.ts`** — 路径安全 + atomicWrite 原子性 + 读写双向一致性
- **`life-forgetter.test.ts`** — 算法遗忘权重 + consolidated 触发阈值
- **`life-generator.test.ts`** — 4 Stage Pipeline 各阶段独立性 + 断点续传 + failedEpisodes 跳过
- **`life-density.test.ts`** — 年龄段事件密度分布
- **`life-grower.test.ts`** — `computeAvatarDeltaMonths` / `samplePendingMonths` / `shouldReconsolidate` + 进程内锁防并发
- **`soul-loader.test.ts`** — consolidated.md 注入位置 + 4 条使用守则注入 + 文件不存在时不阻塞

### 工具脚本（`scripts/`）

- **`backfill-life.ts`** — 历史分身回填扫描脚本：扫描 `avatars/` 下所有分身，分入 `ok` / `generating` / `failed` / `missing` 四类
  - **不自动调 LLM**（每分身约 50 万 tokens，必须用户在桌面端手动触发）
  - 支持 `--root` / `--json` 参数，存在 missing/failed 时退出码 2（CI 友好）

### 项目治理

- **`desktop-app/package.json`** — 0.10.1 → 0.11.0
- **`packages/core/package.json`** — `test` / `test:all` 脚本加入 6 个新测试文件
- **`packages/core/src/index.ts`** — 公开导出整套 life 模块 API（types / store / generator / grower / density / prompts），共 100+ 个新导出

## v0.10.1 (2026-05-08)

### 新功能

- **桌面端「打开工作区目录」按钮** — 设置面板新增按钮，一键定位到当前分身的 `workspaces/` 根目录，方便用户按会话查看 `exports/` 下生成的 PDF / Excel / Word 文件，目录不存在时自动创建。
  - `desktop-app/electron/main.ts` — 新增 `open-avatar-workspaces-folder` IPC（`assertSafeSegment` 校验 + 自动建目录）
  - `desktop-app/electron/preload.ts` / `desktop-app/src/global.d.ts` — 暴露 `openAvatarWorkspacesFolder(avatarId)` API
  - `desktop-app/src/components/SettingsPanel.tsx` — 在「打开日志目录」上方新增按钮 + handler

- **历史会话文件卡片回显** — 重启应用或切换会话后，历史回答下方的 Excel / Word / PDF 文件卡片不再丢失。
  - `desktop-app/src/components/ChatWindow.tsx` — 新增 `collectDocumentAttachmentsByAssistantId()`，扫描 DB 历史 messages 中的 tool 消息，提取 `export_excel` / `generate_document` 落盘附件并挂回到下一条 assistant 消息
  - `desktop-app/src/stores/chatStore.ts` — `tryExtractDocumentAttachment()` 改为 named export 供 ChatWindow 直接复用，避免双份解析逻辑

### 修复

- **`packages/core/src/document/ir-parser.ts`** — 兼容模型把 callout / cite 容器误写成 markdown blockquote 的情况：
  - 现象：LLM 偶尔输出 `> :::callout warning\n> 文本\n> :::`，旧解析器把整个块识别为普通 blockquote 段落，PDF 渲染时 callout 样式完全失效
  - 修复：`RE_DIRECTIVE_OPEN` / `RE_DIRECTIVE_CLOSE` 允许行首可选 `>` 引用前缀，并新增 `stripDirectiveQuoteMarker()` 在采集容器内容时统一剥离 `> ` 前缀，最终与顶格写法行为一致

- **`packages/core/src/document/renderers/html-renderer.ts`** — 段落 / 列表 / 表格单元 / callout / cite 中的 `**加粗**` 与 `` `行内代码` `` 之前会被原样转义显示，不出现 `<strong>` / `<code>`：
  - 新增 `renderInlineMarkdown()` 仅支持加粗 + 行内代码两种安全语法，先 `escapeHtml` 再注入 `<strong>` / `<code>`，原始 HTML 标签依然严格转义，XSS 防护不变

- **`desktop-app/src/stores/chatStore.ts`** — 工具调用循环里检测到落盘附件时，立即把 `documentAttachments` 写回当前 assistant 气泡（之前只 push 到本地数组，依赖下一次 upsert 才能渲染，导致用户感知到的「文件卡片出现延迟」）

### 调优

- **`desktop-app/src/stores/chatStore.ts`** — LLM 单轮超时阈值上调，缓解重任务（PDF 报告生成 / 收益测算等长上下文）误触超时：
  - `ROUND_TIMEOUT_MS`：180s → 300s（5 分钟）
  - `ROUND_FIRST_TOKEN_TIMEOUT_MS`：60s → 120s（重任务模型思考期较长）
  - `ROUND_STREAM_IDLE_TIMEOUT_MS`：45s → 90s（已开始输出后流空闲容忍度提升）
- **`desktop-app/src/stores/chatStore.ts`** — 每轮 LLM 调用增加诊断日志，`logPerf` + `logEvent` 同步输出 `model / bodyChars / systemChars / msgCount / toolCount / baseUrl`，便于定位「请求超大 / system prompt 过长 / 工具数量异常」等慢链路问题
- **`desktop-app/src/stores/chatStore.ts`** — `generate_document` 工具描述补强 IR 语法说明：
  - 明确支持的行内 Markdown 子集（`**加粗**` / `` `行内代码` `` / 禁止 HTML）
  - 强调 callout / cite 容器必须顶格书写，禁止用 `> :::callout` 形式

### UI 微调

- **`desktop-app/src/components/FileCard.tsx`** — 「在文件夹中显示」按钮文案：图标 `▣` → 文字「目录」，title 同步改为「打开所在目录」，可读性更好

### 测试

- **`packages/core/src/tests/document-ir.test.ts`** — 新增 2 个用例：
  - 兼容模型误输出的 `> :::callout` blockquote 包裹容器
  - 行内 Markdown：段落 / 列表 / 表格 / callout 中加粗与行内代码被渲染，原始 HTML 仍被转义

### 项目治理

- **`desktop-app/package.json`** — 0.10.0 → 0.10.1

## v0.10.0 (2026-05-08)

### 新功能

- **文档生成（PDF / Word / Markdown）+ FileCard UI** — LLM 可一次输出统一中间表示（IR），落盘为三种格式之一，桌面端用文件卡片直接展示并支持「打开 / 显示在文件夹」操作。
  - **`packages/core/src/document/`** — 全新 IR 体系（约 800 行新代码）：
    - `ir-schema.ts` — `DocumentIR` / `DocumentBlock`（9 种块类型：heading/paragraph/list/table/code/callout/cite/image/divider）/ `validateIR()`（宽进严出，错误聚合）
    - `ir-parser.ts` — 行驱动状态机，支持 frontmatter + ATX 标题 + GFM 表格 + 围栏代码块 + `:::callout/cite` 自定义容器，永不抛错
    - `renderers/markdown-renderer.ts` — IR → markdown，与 parser 严格对应满足 roundtrip
    - `renderers/html-renderer.ts` — IR → 完整 HTML 文档（XSS 安全），内置基础样式 + 模板 CSS 注入
    - `renderers/template-loader.ts` — 加载 `<avatarRoot>/document-templates/<name>.css`，路径安全双重防护
  - **`desktop-app/electron/exporters/`** — Electron 主进程渲染器：
    - `document-pdf-renderer.ts` — 隐藏 BrowserWindow 加载 HTML → `webContents.printToPDF`，30s 超时与失败回滚
    - `document-docx-renderer.ts` — 基于 `docx@^9.5.0`（实测 9.6.1）的 IR → DOCX 转换，Heading / Paragraph / Table / TextRun / 平台中文字体
  - **`packages/core/src/tool-router.ts`** — 新增 `generate_document` 工具：
    - 全 6 步参数校验（format / ir 长度 ≤ 200K / filename + assertSafeSegment / templateName / 同名覆盖 / 注入器存在）
    - IR 解析 + 校验 + 渲染分发（md 走 core / pdf 走 html-renderer + 主进程 printToPDF / docx 走主进程 docx 库）
    - 输出文件 > 20MB 自动 unlink + error；渲染失败半成品自动清理
    - **决策 A1**：跨进程渲染用依赖注入 `DocumentRendererHook`，desktop-app 启动时注入主进程渲染器，避免 IPC 桥往返
  - **`desktop-app/src/components/FileCard.tsx`** — 新建文件卡片组件（约 165 行），4 种格式（md/pdf/docx/xlsx）图标 + 大小 + 「打开 / 显示在文件夹」+ 引用来源折叠区，像素游戏风格
  - **`desktop-app/src/stores/chatStore.ts`** — `tryExtractDocumentAttachment()` 从 ToolResult 中识别 `success && file_path 含 exports/`，统一附件链路
  - **决策 B3**：`export_excel` 同步改造，返回值补 `format: 'xlsx'` + `_usage` 文案对齐，让 Excel 输出也走 FileCard 通路（无新增分支）
  - **`avatars/小堵-工商储专家/document-templates/`** — 3 套专属 CSS 模板：`default` / `solution-report`（远景品牌深蓝 + 居中页眉 + 自动页码）/ `income-calculation`（数字表格右对齐 + 等宽字体 + 关键指标高亮）
  - **`packages/core/src/soul-loader.ts`** — 注入「文档输出工作流」教学段（所有分身通用，4 步流程 + 2 条严禁），告知 LLM 何时调 `generate_document` 与如何构造 IR

- **社区技能市场（三级技能体系 + 桌面端 UI）** — 支持从 GitHub 安装社区开源技能，分身可覆写任何公共或社区技能。
  - **`packages/core/src/community-skill-types.ts`** — 社区技能类型定义（SkillSource / SkillManifest / CommunitySkillMeta）
  - **`packages/core/src/skill-router.ts`** — SkillIndexEntry 新增 `source`（local/shared/community）和 `origin` 字段，解析器适配
  - **`desktop-app/electron/community-skill-manager.ts`** — 社区技能管理器（约 530 行）：sources.yaml 读写、Git clone/pull 同步、技能安装/卸载/升级、manifest 解析
  - **`desktop-app/src/components/SkillsPanel.tsx`** — 新增三 Tab 切换栏（本地技能 / 公共技能 / 社区技能）
  - **`desktop-app/src/components/SharedSkillTab.tsx`** — 公共技能展示 Tab（只读浏览 `shared/skills/`）
  - **`desktop-app/src/components/CommunitySkillTab.tsx`** — 社区技能 Tab（约 330 行）：源管理 + 技能列表 + 安装/卸载/更新操作
  - **`desktop-app/electron/main.ts`** — 注册 `community:*` IPC 通道（list-sources / add-source / remove-source / sync / install-skill / uninstall-skill / list-installed / list-shared）
  - **`scripts/soul-sync.sh`** — CLI 同步脚本（约 315 行）：从 sources.yaml 批量 clone/pull 社区技能仓库到 `shared/skills/community/`
  - **`shared/skills/`** — 首批 14 个公共技能（chart-from-knowledge / draw-chart / draw-infographic / draw-mermaid / claude-animated-video / claude-design-system / claude-frontend-design 等）
  - **`templates/skill-manifest-template.yaml`** — 社区技能发布清单模板

### 调优

- **`packages/core/src/tool-budget.ts`** — 工具循环硬上限 25 → 30（query_excel 上限提高后避免挤掉收尾工具）；单次 query_excel 调用上限 8 → 24（覆盖双 Excel 多 sheet 对比任务）

### 测试

- **`packages/core/src/tests/document-ir.test.ts`** — IR 与渲染器单元测试（约 380 行 / 42 个 test 子项）：validateIR / parseIR / renderMarkdown roundtrip / escapeHtml / renderHtml（含 XSS 防护 / 块覆盖 / 模板加载）/ template-loader 路径安全
- **`packages/core/src/tests/tool-router.generate-document.test.ts`** — `generate_document` 集成测试（约 410 行 / 16 个 case）：md/pdf/docx 三格式正常路径、format 非法、ir 超限、路径穿越、覆盖策略、IR 校验失败、渲染失败回滚、超大文件回滚、cite sources 回收、与 export_excel 文案对齐
- **测试结果**：cd packages/core && npm run test → **99 tests pass / 0 fail**（含原 41 + 新增 58）

### 模板

- **`templates/agent-template.md`** — 新增 G4 文档输出反幻觉规则 + 工作流自检清单扩展为 6 项
- **`templates/skill-template.md`** — 补充 source / origin 字段说明与社区发布指引

### 项目治理

- **`desktop-app/package.json`** — 0.9.2 → 0.10.0，docx 依赖加入 dependencies
- **`packages/core/package.json`** — 测试脚本加入两个新测试文件
- **`packages/core/src/index.ts`** — 公开导出文档生成模块的所有类型与函数（DocumentBlock / DocumentIR / parseIR / validateIR / renderMarkdown / renderHtml / escapeHtml / loadTemplateCss / DocumentRendererHook 等）+ 社区技能类型

## v0.9.2 (2026-05-07)

### 修复

- **`packages/core/src/tool-router.ts`** — 空知识库时 LLM 反复检索导致流式响应中断：
  - 现象：分身 `knowledge/` 目录无任何 `.md` 文件时，`search_knowledge` 仅返回 `"未找到相关知识内容。"`、`mode='list'` 返回空字符串、`read_knowledge_file` 抛 `ENOENT`；LLM 无法区分「关键词没命中」与「整库为空」，反复换 query 重试 5+ 次，最终触发 `ROUND_STREAM_IDLE_TIMEOUT_MS = 45_000` 流式静默超时报错
  - 修复：新增私有方法 `isKnowledgeBaseEmpty(avatarId)` + `buildEmptyKnowledgeBaseHint()`，在 `search_knowledge`（mode=search）/ `read_knowledge_file` / `listKnowledgeFiles` 三个工具入口前置短路；空库时统一返回 `[KNOWLEDGE_BASE_EMPTY]` 信号词 + 显式停止指令 + 给用户的兜底话术
  - 边界：仅在 `listFiles().length === 0` 触发；有任何 `.md` 文件（含 README）的分身完全保持原行为

- **`desktop-app/electron/main.ts`** — Windows 安装版启动后按钮点击无响应：
  - `createWindow()` 主窗口和 `open_for_print` 打印窗口默认 `show: true` 时窗口立即可见，但 WebContents 尚未完成首屏渲染和合成器初始化，OS 输入派发链未建立；用户立即点击会被合成层吞掉（hover 正常但 click 静默失败），打开 DevTools 才能恢复（DevTools attach 强制 reflow + 重建 input handler）
  - 按 Electron 官方推荐的优雅显示模式修复：`show: false` + `backgroundColor` + `ready-to-show` 钩子里再 `show()` + `focus()`，等首屏渲染完成、合成器就绪后再显示窗口；同时避免 Windows 启动时白底闪烁

### 项目治理

- **`desktop-app/package.json`** — 0.9.1 → 0.9.2

## v0.9.1 (2026-05-06)

### 打包与分发

- **`desktop-app/electron-builder.yml`** — Windows 中文路径安装兼容性修复：
  - `nsis.unicode: true` — NSIS 启用 Unicode，避免安装路径含中文时安装脚本异常
  - `nsis.runAfterFinish: true` — 安装完成可选直接运行应用
  - `asarUnpack` 增加 `node_modules/better-sqlite3/**/*` — afterPack 交叉编译时依赖此路径替换 `better_sqlite3.node`
  - `files` 排除非 win32 平台的 napi-rs 原生绑定（`lightningcss-darwin/linux/freebsd-*` / `@tailwindcss/oxide-darwin/linux/freebsd/wasm32-*`），仅构建期使用，运行时不依赖，减小安装包体积
- **`desktop-app/scripts/after-pack.js`** — 严格化 better-sqlite3 prebuild 替换：未找到 unpack 目录时直接抛错并提示在 `electron-builder.yml` 的 `asarUnpack` 中包含对应路径，避免静默漏配置导致运行时崩溃

### 源文件引用增强

- **`raw-file-resolver.ts` / `raw-file-resolver.test.ts`** — 重构定位逻辑（115 行实现 + 251 行测试），按 frontmatter `raw_file` 锚点稳定定位 Excel / Word / PPT 原文
- **`SourceCitation.tsx` / `source-citation-utils.tsx`** — 源引用组件渲染路径优化（246 行变更），支持更细粒度的 sheet / row 锚点跳转
- **`raw-file-anchor.ts` / `chatStore.ts`** — 类型与状态层对齐源引用新链路

### 项目治理

- **`.gitignore`** — 新增分身运行时产物排除：`avatars/*/_cache/`、`avatars/*/workspaces/`、`avatars/*/wiki/evolution-report.json`，避免图表 cache、回归 workspace、动态报告污染版本库
- **`desktop-app/package.json`** — 0.9.0 → 0.9.1

## v0.9.0 (2026-05-06)

### 新功能

- **对话框附件扩展** — 桌面端消息输入支持图片 / 文件附件全链路：
  - 主进程：新增 `electron/attachment-store.ts`（存储与生命周期管理）+ `database-attachments.test.ts` 持久化绑定
  - 渲染层：`MessageInput` / `MessageBubble` / `ChatWindow` 改造，新增 `LightboxModal` 图片大图查看
  - 类型沉淀：`@soul/core` 抽取 `utils/attachment-types.ts` 复用类型，浏览器与主进程共用
- **数据溯源（源文件引用）** — 答案可一键追溯到原始 Excel / Word / PPT：
  - 服务：`src/services/raw-file-resolver.ts`（含测试），按 frontmatter `raw_file` 锚点定位
  - 组件：`SourceCitation` + `source-citation-utils` + `src/types/raw-file-anchor.ts`
- **工具调用时间线** — 新增 `ToolCallTimeline` 组件，可视化 LLM 多轮工具调用链路与耗时
- **渲染器工具栏与导出** — 新增统一 `RendererToolbar` 与 `utils/export-image.ts`，Chart / Mermaid / Infographic 三类渲染器接入复制 / 下载 / 全屏
- **知识库治理脚本套件** — `desktop-app/scripts/`：
  - `batch-enhance-frontmatter.ts` — 批量补全 frontmatter（标题、来源、raw_file 等）
  - `batch-reparse-excel.ts` — 全量重解析 Excel，统一 JSON 结构
  - `cleanup-br-tags.ts` — 清理历史 `<br>` 标签
  - `cleanup-pdf-toc-pages.ts` — 删除 PDF 目录占位页
  - `normalize-knowledge-filenames.ts` — 文件名规范化（拼音 + 编号）
  - `regression-prepare-table.ts` — 回归题库表格化预处理

### 优化

- **`@soul/core/utils/knowledge-frontmatter.ts`** — frontmatter 解析工具从 desktop 抽到 core，浏览器入口统一导出，避免重复实现
- **`document-parser` 与测试** — 文档解析路径与边界修正，新增 `document-parser.test.ts` 覆盖 PDF / Excel / Word 主分支
- **`kb-question-generator`** — 知识库问答生成器与测试同步增强，覆盖更全面的回归题型
- **`batch-regression-runner` / `batch-report-generator`** — 回归运行器与报告生成器配套测试补齐，回归面板（`BatchRegressionPanel`）展示更细颗粒度
- **`chatStore`** — 与附件 / 工具时间线 / 源引用三大新链路对齐，重构发送与渲染流程
- **`llm-service`** — 透传字段对齐附件与工具调用上下文

### 模板与项目治理

- **`templates/agent-template.md` / `templates/soul-template.md`** — 与新版分身工作流（任务拆分触发判定 / 知识库纪律 / 第一性原理）同步
- **根目录 `AGENTS.md`** — 新增，与 `CLAUDE.md` 形成 Codex / Claude 双 agent 入口，规则一致
- **`.cursor/rules/efficient-workflow.mdc`** — 沉淀「主窗口指挥 + Subagent 执行 + Plan 文件落地」高效工作流约定
- **`.cursor/plans/`** — 沉淀 13 个迭代计划文件（回归 5 类根因修复 / 分身对话九层重构 / 对话框附件扩展 / 知识库可读性 phase2 等），便于跨窗口接力

### 测试与基准

- **`testdocs/`** — 纳入导入性能验证、知识质量评分、桌面格式仿真等回归基准与产物（`import-perf-sim.ts` / `knowledge-quality-rescore.js` / `simulate-desktop-format.ts` 等）

## v0.8.0 (2026-05-01)

### 新功能

- **桌面端完整实现** — Electron 桌面应用全量上线，主进程模块全部就位：
  - **主进程**：`main.ts` / `preload.ts` / `database.ts` / `logger.ts` / `cron-scheduler.ts` / `test-manager.ts` / `scheduled-tester.ts` / `kb-question-generator.ts` / `tool-result-spool.ts` / `folder-importer.ts` / `llm-factory.ts` / `skill-generator-prompt.ts`
  - **子模块**：`connectors/github-connector.ts`、`exporters/`（HTML→PPTX、内联 HTML、本地静态文件服务）、`preview/`（PreviewManager、tweaks-writer、preview-preload）、`verifier/VerifierAgent.ts`、`workspace/WorkspaceManager.ts`、`__smoke__/`（静态与 verifier 烟囱测试）
  - **渲染层**：`App.tsx` + 35+ 组件（ChatWindow / MessageBubble / KnowledgeTree / KnowledgeEditor / KnowledgeViewer / SkillsPanel / SoulEditorPanel / TestPanel / BatchRegressionPanel / PreviewPane / SettingsPanel / UserProfilePanel / PromptTemplatePanel / MemoryPanel / SkillProposalCard / AssetReviewPanel / ChartRenderer / MermaidRenderer / InfographicRenderer / FormMessage / AskQuestionCard / L3EventsPanel / TaskListPanel 等），共享原子组件 IconButton / Modal / PanelHeader / Toast
  - **服务层**：`llm-service`、`batch-regression-runner`、`batch-report-generator`、`regression-telemetry`、`reference-simulation`、`source-anchor-resolver`、`soul-step-generator`、`soul-validator`、`test-generator`、`test-runner`，配套测试覆盖
  - **状态与工具**：`stores/chatStore` + `themeStore`、`utils/pixelate` + `knowledge-frontmatter`、`lib/echarts-pixel-theme` + `tool-name-map`、像素字体（中文 + 拉丁）
  - **工程化**：Vite + Tailwind + PostCSS + TS 配置、ESLint flat config、Playwright（journey / demo / e2e）三套配置、`scripts/`（图标生成 / Excel JSON 回填 / 知识索引重建 / tokens 预热 / Win 构建脚本）、`electron-builder.yml` + `after-pack` / `after-sign` 钩子

- **核心九层路由架构** — `@soul/core` `tool-router.ts` 扩展为九层路由（+2882 行），支持工具裁决、委托、阶段化检索；新增模块：
  - `browser.ts` — 受控浏览器抽象
  - `mcp-client-manager.ts` — MCP 客户端连接与生命周期
  - `utils/local-date.ts` — 本地时区日历日格式化（替代 `toISOString().slice(0,10)`）
  - `utils/query-hash.ts` — 查询规范化与稳定 hash
  - 新测试：`tool-router-delegate.test.ts` / `tool-router-stage2.test.ts` / `tool-router-stage9.test.ts`

- **设计系统资源库** — `shared/design-systems/` 收录 70+ 知名品牌设计指南（Apple / Stripe / Linear / Vercel / Notion / Figma / Tesla / Spotify 等），分类至 AI 平台、汽车、后端 / DevOps、设计工具、IDE、电商、金融加密、媒体消费科技、生产力 SaaS 等领域，含统一 `INDEX.md` 与 `claude-design-sys-prompt-adapted.md`
- **Starter 组件包** — `shared/starter-components/` 提供 macOS / iOS / Android / 浏览器机框、动效预设、画布与 deck 舞台等 React / JSX 起步组件

- **Claude 技能模板矩阵** — `templates/skills/claude-*.md` 覆盖动画视频、设计系统、PPT 导出（可编辑 / 截图）、前端设计、handoff、交互原型、Deck、Tweakable、PDF 保存、Standalone HTML、Canva 投递、线框图等 13 个技能，配套 `templates/prompts/claude-design-system.md`
- **`templates/skill-index.yaml`** — 新增 115 行 skill 路由索引，支持桌面端 Skill 路由系统按需注入

### 文档

- **AI 分身使用介绍** — 新增 `docs/ai-avatar-introduction.md` + 10 张产品截图（首页 / 回答 / 知识 / 记忆 / 提示模板 / 设置 / 技能 / 灵魂 / 用户画像 / Electron 主屏）
- **CLAUDE.md（根）** — 任务拆分规则引入「触发判定」前置流程，明确 ✅ / ⛔ 两类场景，避免对调研 / 知识检索类问题误触拆分

### 修复与优化

- **`document-parser.ts`** — 文档解析路径与边界修正
- **`manual-qa-scenarios`** — 用例与实现同步，覆盖更全面的 QA 场景
- **`conversation-router` / `soul-loader` / `knowledge-retriever`** — 与九层路由架构对齐
- **`tool-budget` / `chart-cache` / `common`** — 与新路由 / 缓存路径对齐
- **`agent-template`** — 与新版 CLAUDE.md 拆分规则同步

## v0.7.3 (2026-04-17)

### 修复与优化

- **FORMAT 按钮与 Excel 数据源** — v0.5.x 起约定「Excel / PPT 隐藏 FORMAT」依赖 `raw_file` 扩展名，但 Excel/PPTX **快速导入**的 `.md` 只写 `source: excel` / `source: pptx`（无 `raw_file`），导致 FORMAT 误显。现根据 frontmatter 的 `source` / `excel_json` 一并隐藏；`parseFrontmatter` 抽到 `desktop-app/src/utils/knowledge-frontmatter.ts` 与 Viewer 共用。
- **缺失的 knowledge/README.md** — 清空知识库等操作删掉 `README.md` 后，`read-knowledge-file` / `read_knowledge_file` 会 ENOENT。`KnowledgeManager.readFile` 在根路径 `README.md` 缺失时用父目录名调用 `updateReadme` 自动补空库索引；`KnowledgeRetriever.readFile` 同步委托，避免工具链与 UI 双失败。
- **query_excel 零行诊断** — 模拟「215 + 2026 年 1～3 月设备侧效率图」三种典型 LLM 过滤策略（错列名、ISO 月与 YYMM 数字比较、正确 $in）；零命中时在 JSON 中附带 `zero_match_hint` 与 `invalid_filter_keys`，便于首轮自愈。回归：`testdocs/test-query-excel-215-chart-simulation.ts`（`desktop-app` 下 `tsx` 运行）。
- **Excel .md 不参与 search_knowledge** — `rag_only`+`source:excel`（或 `excel_json:`）的表格导出 `.md` 仍被全文切片进 BM25，RAG 易命中 Summary 等片段，模型编造「2026 未收录/只有 2024-2025」。现 `KnowledgeRetriever.buildChunks` 跳过此类文件；`soul-loader` Excel 纪律新增第 7 条：行级数值以 `query_excel` JSON 为准，禁止仅凭 RAG 片段下结论。

## v0.7.2 (2026-04-17)

### 新功能

- **chart cache 接入发送链路** — `sendMessage` 路径接入图表答案缓存命中/写入；Excel 相关请求支持 **basename 扫描**，提升同问同答命中与复用体验。

## v0.7.1 (2026-04-16)

### 新功能

- **图表答案持久化 cache** — `@soul/core` 存储层 + 主进程 IPC（`get-chart-cache-hit` / `save-chart-cache-entry`），`preload` 暴露给渲染进程，为同图复用打基础。
- **同问同答确定性** — 聊天与 `draw-chart` 参数模板等基础设施；LLM 服务透传 **`seed`**；`ChartRenderer` 注册 **GaugeChart**。
- **Skill 路由图表二次裁决** — `chart-from-knowledge` 与 `draw-chart` 场景智能再选路。

### 修复与优化

- **知识检索排序稳定性** — 五处 `sort` 补全 `(file, heading)` 二级键，结果顺序可复现。
- **Electron** — `^41.1.0` → `^41.2.0`。

### 文档与工程

- **架构文档** — README / CONVENTIONS 与主题系统对齐（`cc39b92`）。
- **分身与 CI** — 小堵知识 README / wiki 元数据；`.github/workflows/desktop-build-win.yml`；`desktop-app/scripts/build-win.bat`。

## v0.7.0 (2026-04-16)

### 新功能

- **主题系统** — 支持运行时切换 81 个电影风格主题（9 个浅色 + 72 个暗色）。设置面板新增「THEME / 外观主题」标签页，一键切换，选择持久化到 localStorage。
  - 色彩体系全面变量化（CSS Custom Properties），Tailwind 配置、组件样式、ECharts 图表、Mermaid 图表、Markdown 渲染均通过 `--px-*` 变量驱动。
  - 覆盖赛博朋克、太空史诗、犯罪惊悚、文艺浪漫、动画奇幻、韦斯安德森等电影美学流派。
  - 新增 `themeStore.ts`（Zustand）管理主题状态。

### 构建

- **afterPack 交叉编译修复** — macOS 打 Windows 包时自动下载 win32 版 better-sqlite3 prebuild（延续 v0.6.18 修复）。


## v0.6.18 (2026-04-16)

### 构建

- **afterPack 交叉编译 Windows 时拉取正确 better-sqlite3 prebuild** — 在 macOS 上执行 `electron-builder --win` 时，`@electron/rebuild` 只会产出当前宿主平台的 `.node`，安装包内的 `better_sqlite3.node` 可能仍是 Mach-O。`afterPack` 在检测到交叉编译目标为 Windows 时，使用 `prebuild-install` 下载对应平台的预编译二进制并替换，避免 Windows 用户安装后加载 native 模块失败。

## v0.6.17 (2026-04-16)

### 新功能

- **Skill 路由系统 v1.0** — `skill-index.yaml` + `SkillRouter`（分词 / bigram / keyword 反向索引），命中时把完整 `SKILL.md` 注入 RAG，减少一次 `load_skill` 的 LLM 往返。

### 修复

- **tokens 持久化与预热** — `rag-retrieve` 结束后写入 `_index/tokens.json`；`loadIndex` 返回 null 时仍独立加载 tokens 缓存，避免每次全量 segmentit（`searchChunks` 路径实测由约 260s 降至百毫秒级）。
- **批量导入产物运行时 `rag_only`** — `SoulLoader` 对带 `source:` frontmatter 的导入产物按 rag_only 处理，避免超大 system prompt 撑爆上下文。
- **ECharts 像素主题** — 图表标题与图例重叠、markLine 右侧标签截断。

### 文档

- **CHANGELOG / README** — 与本轮 Skill 路由与检索性能修复对齐。

## v0.6.16 (2026-04-16)

### 新功能

- **✨ Skill 路由系统 v1.0** — 三层架构（索引 + grep 路由 + 按需注入）。skill-index.yaml 定义 4 个内置 skill 的 name / keywords / when / priority，SkillRouter 用 segmentit 分词 + bigram 提取 + keyword 反向索引在 < 1ms 内路由到最合适的 skill，命中时把完整 SKILL.md 注入 RAG 结果，省去 load_skill 工具调用的一次 LLM 往返
- **✨ 内置 `draw-infographic` 技能** — 集成 @antv/infographic（84+ 信息图模板：列表/对比/SWOT/序列阶梯/金字塔/词云），`InfographicRenderer.tsx` 懒加载 + 错误边界，`MessageBubble.tsx` 加 `language-infographic` 代码块分支
- **✨ 技能 CRUD UI + AI 自然语言生成** — SkillsPanel 支持新建/删除技能，内置技能不可删除（`[BUILTIN]` 标签），新建对话框默认 AI 辅助模式（用户一段话描述 → LLM 基于 templates/skill-template.md + 现有 skill few-shot 生成草稿 → 自动切到手动模式编辑）
- **✨ Mermaid 图表渲染器** — 支持甘特/流程/时序/思维导图/看板/状态机/ER/类/Git 等 14+ 种 mermaid 语法，LED 粉 × void-black 像素主题，draw-mermaid skill + CLAUDE.md 技能导航
- **RAG 检索优化三件套** — 实体提取 30s 软超时 + 数字密集查询快通（≥4 数字 token 跳过实体提取）+ UI 阶段进度条（替代彩虹伞）

### 修复

- **🔥 searchChunks 260s → 155ms (1677x)** — `loadIndex` 在 contexts.json 不存在时 return null → `setTokens` 永远不执行 → 全量 segmentit 分词。修复：`tool-router.getRetriever` 独立调 `loadTokensCache`，不依赖 loadIndex 的前置检查
- **🔥 rag-retrieve 后保存 tokens 到 _index/tokens.json** — 此前只有 executeToolCall 路径会保存 tokens，rag-retrieve 路径漏了 → 每次重启都在 rag-retrieve 阶段重新分词
- **🔥 纯图片 / 图片型 docx 的 OCR 结果被静默丢弃** — main.ts 三处 merge 分支 `parsed.perPageChars` 判断只对 PDF 有效，parseImage / parseWord 不设此字段 → Vision OCR 结果整段跳过
- **🔥 LLM 请求超时不生效** — fetchWithTimeout 的 clearTimeout 在 response headers 到达后 finally 立即触发，body 读取无保护。llm-factory 改用 fetchJsonWithTimeout 覆盖 fetch + json 全周期
- **🔥 formatDocument 表格型章节跳过 LLM** — isTableLikeContent 预检测（Tab > 3% 或短行 > 45%），避免 LLM 卡 32 分钟。实测 2591 字 .doc 表单：32 分钟 → 2ms
- **批量导入产物运行时 rag_only** — SoulLoader 把有 `source:` frontmatter 的文件（批量导入产物）运行时当 rag_only 处理，不塞 system prompt
- **rag-retrieve 实体提取模型** — qwen-plus → qwen-turbo，177s → 预期 < 30s
- **ECharts 像素主题 3 处视觉修复** — grid.top 100 / yAxis.scale:true / stripExplicitSeriesColors 强制主题 palette + forceLegendBottom 防图例重叠标题 + grid.right 96 防 markLine 截断
- **parser setTimeout 泄漏** — parseFile 的超时保护未 clearTimeout，批量 300+ 文件后 CLI 进程不退出
- **docx 表格 fallback** — mammoth 提取过短时从 word/document.xml 直抽 `<w:t>` 节点
- **docx 图片提取** — parseWord 补充 word/media/* 图片提取为 base64 dataURL
- **PDF 分页 fallback** — parsePdf 分页信息缺失时 fallback 截图前 N 页
- **pdfjs 批量 flake 缓解** — parsePdf 末尾调 destroy() 释放 document 引用
- **章节切分 6 处 regex + 早 return bug + MAX_CHAPTER_CHARS 6000→3000 + embedding slice 500→3000**

### 测试

- **格式化样本测试** — testdocs/format-samples.ts 覆盖 10 种格式端到端
- **Mermaid e2e 测试** — testdocs/test-mermaid-e2e.ts 3 用例（gantt/flowchart/mindmap）3/3 通过
- **Token cache 预热验证** — testdocs/warm-tokens.ts + diag-cache.ts
- **dry-run 递归脚本** — testdocs/dry-run-format-product.ts 支持归档解压 walk + 7 类分类

## v0.6.15 (2026-04-15)

### 新功能

- **✨ 内置技能保护 + AI 自然语言生成技能草稿** — 用户体验大幅升级：
  - **draw-mermaid 加入 `templates/skills/`** —— 此前 mermaid skill 只在小堵分身的 `skills/` 里，现在所有新分身创建时都会自动获得 mermaid 能力（和 draw-chart / chart-from-knowledge 并列）
  - **`Skill.isBuiltin` 字段** —— `SkillManager` 在 parse 时检查 `templates/skills/` 是否存在同名 .md，结果缓存到 `builtinSkillIdsCache` 集合，每个 Skill 对象返回时附 `isBuiltin: boolean`
  - **`SkillManager.deleteSkill` 拒绝内置技能** —— 服务端兜底，错误信息提示用"禁用"开关停用而非删除
  - **前端 `SkillsPanel.tsx` 隐藏内置技能的 `DELETE` 按钮** —— 改为显示灰色 `[BUILTIN]` 标签 + tooltip
  - **AI 自然语言生成技能草稿** —— 新建对话框默认进入"AI 辅助"模式：
    * 用户用一段话描述他想要的技能（例如"我要一个把会议纪要里 open 任务输出甘特图的技能"）
    * 后端 `generate-skill-draft` IPC 调用 LLM，**meta-prompt 自动注入 `templates/skill-template.md` 格式规范 + `templates/skills/*.md` 作为 few-shot 示例**
    * LLM 返回完整的 skill markdown 草稿
    * 前端自动 prefill 到编辑器 + 提取 frontmatter 的 `name` 字段作为 ID
    * 自动切到"手动编写"模式让用户审阅 / 修改 / 创建
  - 新增 `desktop-app/electron/skill-generator-prompt.ts` —— `SKILL_GEN_SYSTEM_PROMPT` + `buildSkillGenUserPrompt(templatesPath, description)`，将模板规范和示例拼成完整 prompt
  - 模式切换 UI：[AI 辅助] [手动编写] 像素风按钮组，AI 模式失败可一键切到手动模式继续编辑

## v0.6.14 (2026-04-15)

### 修复

- **🔥 LLM 请求超时不生效修复** — `llm-factory.ts` 的 `createLLMFn` / `createEmbeddingFn` 此前用 `@soul/core` 的 `fetchWithTimeout`，但后者在 fetch() resolve（response headers 到达）后的 finally 里立即 clearTimeout，**调用方后续 `response.json()` 读 body 不受任何超时保护**。实测见过 LLM 服务端慢吐 8192 tokens 持续 32 分钟不 terminate 的情况。修复：在 `llm-factory.ts` 内部用专用 `fetchJsonWithTimeout` wrapper，单一 AbortController 同时覆盖 fetch 连接阶段 + response.json() body 读取阶段，保证 5 分钟超时对整个请求-响应周期生效

- **🔥 formatDocument 表格型章节跳过 LLM** — 添加 `isTableLikeContent` 预检测：章节内容 Tab 字符 > 3% 或短行（<=20 chars）占比 > 45% 时跳过 LLM 调用，直接用 markdown 代码块包裹原文返回。根因：成品检验报告 .doc / K=V 数据表 PDF / 密集表单等 Tab 分隔 checkbox 内容送给 LLM 时，LLM 要么卡在表格格式化上反复重试要么服务端慢吐到 terminate。实测 `量道-液冷柜检验报告.doc`（2591 字 Tab 分隔表单）格式化耗时 **32 分钟 → 2ms**（加速 ~96 万倍），表单内容完整保留到代码块中，BM25 检索和向量召回都不受影响

### 新功能

- **✨ Mermaid 图表渲染** — 聊天消息里 ```mermaid 代码块会被自动渲染为交互式图表，覆盖**甘特图 / 流程图 / 时序图 / 思维导图 / 看板 / 饼图 / 状态机 / ER 图 / 类图 / Git 图 / 时间线 / 四象限图 / Sankey** 等 10+ 种可视化类型。此前用户需要"生成甘特图"这类需求时没有对应 skill，现在 LLM 只要吐 mermaid 语法就能直接出图。新增 `desktop-app/src/components/MermaidRenderer.tsx`（懒加载 + 错误边界 + 像素暗色主题）+ `MessageBubble.tsx` 的 ChartCodeBlock 增加 `language-mermaid` 分支 + 流式输出检测（未完成的 mermaid 代码块显示 ⏳ 生成中）+ `npm install mermaid`（~800KB gz，动态 import 不打进初始 bundle）

- **✨ Mermaid 主题对齐像素 LED 风格** — `MermaidRenderer.tsx` 的 `themeVariables` 从通用 dark theme 换成对齐 `tailwind.config.js` 的 `px.*` 配色：LED 粉 `#FFB0C8`（节点边框/连线）× void-black `#0A0A0F`（背景）× 薄荷绿 `#50D8A0`（accent/done 任务）× 文字 `#E8E8EC`（LED 白）。甘特图的 active/done/crit 任务、时序图的 actor/signal/note、状态图的 labels 全部细化主题变量。字体切到 `JetBrains Mono`（和项目现有代码块字体一致）

- **✨ 技能 CRUD UI** — SkillsPanel 支持**新建**和**删除**技能（此前只能编辑现有的）。新增：
  - `SkillManager.createSkill(avatarId, skillId, content)` — 严格校验 ID（仅 `[A-Za-z0-9_-]+`）+ 检查重复 + 写入文件 + 返回解析后的 Skill
  - `SkillManager.deleteSkill(avatarId, skillId)` — 物理删除文件 + 清理 `.config.json` 里的 disabledSkills 残留
  - `main.ts` 的 `create-skill` / `delete-skill` IPC handler
  - `preload.ts` 的 `createSkill` / `deleteSkill` 方法暴露到 `window.electronAPI`
  - `global.d.ts` 类型声明
  - `SkillsPanel.tsx` 新增 `[+ NEW]` 按钮（左侧列表头）+ `[DELETE]` 按钮（右侧详情，带内联确认）+ 新建表单视图（ID 输入框 + Markdown 模板编辑器，`{{skillId}}` 占位符会自动替换）

## v0.6.13 (2026-04-15)

### 修复

- **🔥 纯图片 / 图片型 docx 的 OCR 结果被静默丢弃修复** — `main.ts` 批量导入、单文件导入、enhance 补跑 OCR 三处 merge 分支都有同一个 bug：`if (ocrOutcome.results.length > 0 && parsed.perPageChars)` — `parsed.perPageChars` 只对 PDF 有，`parseImage()` 和 `parseWord()` 都不设置此字段。导致**所有 .jpg / .png / .gif / .webp / .bmp 输入，以及图片型 docx** 的 Vision OCR 结果都被整段跳过，最终写入 md 永远是空的 `_（无文本内容）_`。修复：`perPageChars` 不存在时回退到"OCR 结果直接作正文"路径（`ocrTexts.join('\n\n')` 追加到 cleanedText）。此前小堵-工商储专家 knowledge 目录中 19 张 .png / .jpg 图片（OCV-SOC 曲线、电源规格书等）的 md 全部为空，实际 RAG 里完全没有这些图的内容

## v0.6.12 (2026-04-15)

### Process 目录验证 + 追加修复

8. **docx 表格 fallback** — `parseWord()` 当 mammoth 提取字数 < 500 且文件 > 20KB 时，直接解 zip 从 `word/document.xml` 抽 `<w:t>` 节点（按 `</w:p>` / `</w:tr>` / `<w:br/>` 作为块分隔符保留段落结构）。覆盖 mammoth `extractRawText` 不含表格单元格文本、文本框、SDT 内容控件的已知限制

9. **parser setTimeout 泄漏修复** — `parseFile()` 的超时保护用 `setTimeout` 但成功路径未 `clearTimeout`。批量处理 300+ 文件后每个文件留一个 5 分钟的 pending timer，导致 CLI dry-run 跑完后进程不退出。`try/finally` 中加 `clearTimeout` 修复（生产 Electron 长驻进程不受影响）

10. **dry-run 归档解压 walk-through** — `testdocs/dry-run-format-product.ts` 遇到 `.zip` / `.rar` 时解压到临时目录并递归扫描内部文件（含 zip 炸弹防护由 node 自身限制托底），报告路径用 `{archive}!/{inner}` 格式。和生产 folder-importer 行为一致，暴露归档内部的真实文件结构
    - 用 `createRequire('/Users/cnlm007398/AI/soul/desktop-app/package.json')` 解决 dry-run 脚本从 `testdocs/` 跑时 `require('adm-zip')` / `require('node-unrar-js')` 找不到依赖的问题

11. **dry-run 报告命名** — 报告文件名从固定 `dry-run-report-product.json` 改为按目标目录 basename 动态命名（`dry-run-report-{basename}.json`），多个目录跑 dry-run 时互不覆盖

12. **dry-run 清理临时目录** — 归档解压目录在 main 结束时自动 `rm -rf`，避免 /tmp 堆积

**Process 目录 107 文件（含归档内部 11 份）最终结果**：
- 解析失败 **2**（GBK 编码 zip，adm-zip 限制 — 生产 folder-importer 也受影响）
- 真空 **2**（空壳合同模板 `附件六 技术协议.docx`，文档本身只有"甲方/乙方/日期"签名栏，结构性无救）
- 真乱码 0 / 未切分 1（2591 字 `.doc` 检验报告无章节结构，embedding 完整覆盖 RAG 无影响）

## v0.6.11 (2026-04-15)

### 批量导入质量修复 — 章节切分 / 长文档 embedding / docx 图片 / pdfjs flake

经 `testdocs/dry-run-format-product.ts` 对 300 份工商储产品文档跑 4 轮 dry-run 暴露并修复：

1. **章节切分 6 处 regex 修复**
   - 新增 `第X条` / `第X节` 分支（合同/协议类文档）
   - 数字编号后允许可选句号（`1. 化学品...` 类中英混排文档）
   - 标题首字符允许英文大写（编号英文标题）
   - 新增 **英文独立标题分支**：首字母大写 + 前后空行孤立 + 非 key:value，覆盖 `Instructions`、`Round-Trip Efficiency (RTE)` 类裸标题
   - 新增 **孤立 CJK 短标题分支**：首字符 CJK + 前后空行孤立 + 2-30 字符，覆盖 `系统运行模式`、`离网模式` 这类无编号裸中文标题
   - 冒号 `:` / `：` 结尾排除（过滤 `Certificate Number:` 等 key:value 标签）

2. **章节切分早 return bug 修复** — `chapterBreaks.length === 0` 时直接 return 单个"全文"章节，跳过了整个 merge + 超长切分管线。导致 14k BOM / 17k 控制计划等超长单章节文档无法二次切分。改为 fall-through，让无章节文档也走切分逻辑

3. **长文档 embedding 覆盖修复**
   - `knowledge-indexer.ts` embedding 输入从 `slice(0, 500)` 改为 `slice(0, 3000)`
   - `document-formatter.ts` `MAX_CHAPTER_CHARS` 从 6000 改为 3000
   - 两者配合实现"隐式滑窗"：formatter 保证每章节 ≤ 3000 字，indexer 单向量完整覆盖章节语义
   - 修复 1000–6000 字章节的后半段无法向量召回的问题

4. **docx 图片提取** — `parseWord()` 补充 `word/media/*` 图片提取为 base64 dataURL，交给下游 Vision OCR。修复图片型 docx（如 `Test report key pages GB44240.docx`）解析为空的问题

5. **PDF 分页 fallback** — `parsePdf()` 当 `textResult.pages` 缺失或为空，且全文稀疏/乱码时，fallback 截图前 N 页交给 Vision。修复 `2025010041-3 IP 等级防水测试 CNAS.pdf` 这类 pdfjs 拿不到分页信息导致零截图的边界情况

6. **pdfjs 批量 flake 缓解** — `parsePdf()` 末尾调 `parser.destroy()` 释放底层 document 引用，消除批量导入 300+ 文件时 worker 状态累积导致的"0 截图"随机 flake（161 页 PCS 报告从批量 0 截图恢复到正常）

7. **dry-run 脚本升级**（`testdocs/dry-run-format-product.ts`）
   - 递归遍历目录 + 按相对路径显示
   - 新增分类：**Vision 兜底** / **短文档直送** / **表格型 PDF** / **真空** / **真乱码** — 把 dry-run 工件与真问题分离
   - 表格型检测：短行占比 > 45% 时跳过章节切分报警
   - `.dwg` 归入跳过（CAD 图纸 parser 不支持，不算失败）

**Product 目录 300 文件 dry-run 结果（v1 → v4）**：
- 解析失败 3 → **0**
- 真乱码 3 → **0**（全归 Vision 兜底）
- 真空文档 40 → **3**（剩余都是 pdfjs 小概率 flake，生产单文件处理路径不受影响）
- 未切分 38 → **2**（剩余 2 份是 < 3000 字 key:value 证书表单，embedding 完整覆盖 RAG 零影响）

## v0.6.10 (2026-04-15)

### UI 修复 + 乱码检测 + 章节切分优化 + README 增强

1. **移除 ENHANCE 按钮** — 批量导入已不需要补跑 LLM 格式化，清理相关死代码
2. **GEN TEST / FORMAT 按钮样式修复** — 从 `pixel-btn-outline-muted` 改为 `pixel-btn-outline-light`，深色背景下可见
3. **FORMAT 按钮智能显隐** — Excel / PPT / 图片文件自动隐藏 FORMAT 按钮（通过 frontmatter raw_file 扩展名判断）
4. **状态文字可见性** — PanelHeader subtitle 颜色从 `text-px-text-dim` 改为 `text-px-primary`；`isBusy` 时隐藏 subtitle 避免与进度条重复
5. **格式化进度动画** — `isFormatting` 加入 `isBusy`，FORMAT 操作时显示 spinner + 进度条
6. **PDF 乱码检测** — 新增 `isGarbledText()` 检测 CID 字体编码异常，乱码页强制 OCR；FORMAT 乱码内容时给出明确错误提示
7. **章节切分优化（v12）** — 经 35 文件 dry-run 测试验证：
   - 收紧 heading regex：每级最多 2 位数字 + 标题必须以 CJK 字符开头，排除表格数据（`220 94,5`）和列表项（句号结尾的行）
   - 微小章节自动合并：< 500 chars 的章节合并到前一章节
   - 效果：用户手册 130 章节 → 8-12 章节，电气原理图 46 → 1，技术协议 20 → 3
8. **FORMAT 跳过短内容** — 纯图 PDF（cleaned=0）和小文件（<500 chars）给出明确提示而非无效调 LLM
9. **README 增强** — 批量导入首次创建 README 时生成完整模板（使用说明、目录结构、命名规范、质量标准）
10. **LLM 超时调大** — `BACKEND_API_TIMEOUT_MS` 3 分钟 → 5 分钟，减少格式化超时失败
11. **TS 零错误** — 修复 `@soul/core` 缺少 `exports` 字段导致 `callVisionOcr` 在 bundler 模式下找不到的问题

## v0.6.9 (2026-04-15)

### 重构 — 批量导入去掉 LLM 格式化 + 单文件 FORMAT 按钮

#### 1. 批量导入回归快速模式

LLM 逐章格式化占批量导入 99% 耗时（183 文件预估 49 小时 vs 跳过仅 24 分钟），且频繁超时。实测确认格式化不影响检索质量（BM25 + 向量都作用在原始文本上）。

**改动**：批量导入只做解析 + 清洗 + OCR，不做 LLM 格式化。

#### 2. 单文件 FORMAT 按钮

在知识库文件查看器的 EDIT 按钮旁新增 FORMAT 按钮，用户可按需对单个重要文件执行 LLM 结构化格式化（从 _raw/ 重新解析 → OCR → LLM 格式化 → 数值校验 → 写回）。

#### 3. 智能 OCR 页面检测

旧方案（固定 300 字符阈值）导致工程图纸 PDF 只有 25% 的页被 OCR。新方案结合字符数 + 噪音比（单字符行占比）双重判断：
- < 300 chars → OCR（扫描件/纯图）
- 300-1000 chars + 噪音比 > 25% → OCR（工程图纸）
- 其他 → 文字页不 OCR

模拟验证 134 个 PDF：工程图纸全覆盖，文字文档不误触。

## v0.6.8 (2026-04-14)

### 优化 — 批量导入体验 + 格式化加速

1. **每文件完成即刷新文件树** — 不再等整个批量导入结束才显示，每完成一个文件左侧列表立即更新
2. **短章节跳过 LLM 格式化** — < 2000 字符的章节（签字页/目录页/端子图等）直接保留原文，不调 LLM，减少 50-70% API 调用
3. **格式化模型修复** — 优先用 creation 模型（qwen-plus）做格式化，不用 chat 模型（deepseek-chat）
4. **rag_only 按大小判断** — > 50KB 才标记 rag_only，小文件直接进 system prompt，与单文件导入一致
5. **README.md 自动更新** — 批量导入完成后自动更新知识文件索引表
6. **每文件计时统计** — 终端输出分步耗时（解析/OCR/格式化），便于诊断瓶颈

## v0.6.7 (2026-04-14)

### 重构 — 批量导入逐文件完整处理 + 多项修复

#### 1. 批量导入架构重构（中断安全）

之前批量导入只做快速写入（无 LLM 格式化），需要用户手动点 ENHANCE 补跑。ENHANCE 中断后文件处于半成品状态。

**重构**：逐文件完整处理（解析 → 清洗 → OCR → LLM 格式化 → 写入）。每完成一个文件立即可搜索，支持断点续导（跳过已完成文件）。导入完成后自动构建检索索引。无 API Key 时降级为原始文本写入。格式化优先用 creation 模型（qwen-plus），fallback 到 chat 模型。

#### 2. 知识库为空时直接告知用户

RAG 检索无结果时，在 user 消息中附加系统提示引导 LLM 直接回复"知识库中没有相关数据"，不再浪费 10 轮工具调用搜索不存在的数据。

#### 3. 导入进度实时显示

状态栏文字跟随每个文件的处理阶段实时更新（解析中 → OCR → LLM 格式化 → done），不再停在"解压 + 批量导入中..."。

#### 4. unrar.wasm 路径修复

node-unrar-js 的 WASM 文件无法被 esbuild 打包，运行时报 ENOENT。构建时拷贝到 dist-electron/。

#### 5. tempDirs 作用域修复

import-archive 的 finally 块引用了 try 块内的 tempDirs 变量，extractArchive 抛出时报 ReferenceError。

#### 6. 异步预热 chunk 缓存

用 fs.promises.readFile 替代同步 readFileSync 预热 chunks，主线程不阻塞。

## v0.6.6 (2026-04-14)

### 性能 — 启动假死 + 提问卡顿 + 思考动画 + 图表视觉

#### 1. 启动假死修复

批量导入 416 个文件后，`loadAvatar()` 的 `readDirectory()` 同步读取所有 `.md` 文件完整内容（含 rag_only 大文件），阻塞主线程 10+ 秒导致 UI 假死。

**修复**：`readDirectory()` 对每个 .md 文件先读 512 字节探测 frontmatter，`rag_only: true` 的文件只保留头部元数据，跳过可能数 MB 的 body。500+ 文件场景从 10+ 秒降到 < 1 秒。

#### 2. RAG 提问加速

每次提问固定调一次 LLM 做实体提取（多跳检索），即使查询关键词已精准命中也要等 3-5 秒。

**修复**：检查第一跳 BM25 top-1 score，≥ 8 时跳过实体提取直接用第一跳结果。精准查询（如"215 机型设备侧效率"）省 3-5 秒。

#### 3. 思考动画修复

"思考中..."状态只显示一个静态小方块，`animate-pulse-glow` 是未定义的自定义动画类。

**修复**：改为 Tailwind 内置 `animate-bounce` 三点错时跳动，给用户明确的"正在处理"视觉反馈。

#### 4. 图表 markLine 标签截断

参考线末端标签"参考"被 `grid.right: 24` 截断。

**修复**：`grid.right` 24→64；新增 markLine 默认样式（暖黄虚线、无箭头、深底标签）；新增 markPoint 默认样式（LED 粉色）；splitLine 改为更微妙的虚线。

#### 5. warmUp 预热回滚

`setImmediate` 预热 chunk 缓存仍然阻塞主线程。如果用户在预热期间发消息，LLM fetch stream 会断开报 `BodyStreamBuffer was aborted`。

**修复**：回滚 warmUp，chunk 构建由 `searchChunks` 懒加载触发，发生在 async handler 内部不阻塞 UI。

## v0.6.5 (2026-04-14)

### 修复 — PDF Windows 打包兼容 + 批量导入增强

#### 1. PDF Windows 打包兼容

pdf-parse v2 内部通过 `import("./pdf.worker.mjs")` 动态加载 pdfjs worker。在 Windows 打包后 asar 内 `import()` 加载 `.mjs` 文件有兼容性问题，导致所有 PDF 导入失败。

**修复**：构建时把 pdfjs worker 预构建为 CJS（`pdf-worker.cjs`），主进程启动时通过 `require()` 加载到 `globalThis.pdfjsWorker`。pdfjs-dist 检测到后直接使用，跳过有兼容问题的动态 `import()`。

#### 2. 批量导入支持嵌套归档

之前批量导入文件夹时，遇到嵌套的 `.zip` / `.rar` / `.7z` / `.tar.gz` 会跳过并标记 `unsupported extension`。

**修复**：`walkFolder` BFS 遍历时遇到归档文件自动解压到临时目录并加入队列继续遍历。解压产物受原有深度 / 文件数 / 总字节限制约束，完成后自动清理临时目录。

#### 3. 支持 `.doc` 旧版 Word 格式

之前导入 `.doc` 文件直接报错"不支持旧版 .doc 格式"。mammoth 只支持 `.docx`（Office Open XML），无法处理旧版 OLE2 二进制格式。

**修复**：新增 `word-extractor` 依赖（纯 JS，MIT），提取 `.doc` 文件的正文、脚注、尾注。`.doc` 加入 `SUPPORTED_PARSE_EXTENSIONS`。

#### 4. UI 文案优化

"知识库质量优化中（完整管线：OCR → 清洗 → 格式化 → 校验）..." → "知识库质量优化中..."，去掉用户不需要感知的技术细节。

## v0.6.4 (2026-04-14)

### 修复 — `dist:mac` 也加自动 rebuild better-sqlite3

v0.5.13 给 `dist:win` / `dist:linux` / `dist:all` 加了自动 rebuild 兜底（避免跨平台打包污染 dev 环境），但**漏了 `dist:mac`**。当时假设"Mac 打 Mac 不会换 binding"。

实测发现 dist:mac 也会动 binding：当 codesign 失败 / 中途出错 / 目标 arch 和 host 不一致时，`electron-builder install-app-deps` 在打包流程中已经把 binding 换成了目标 arch，但因后续步骤失败没有恢复。重启后 `npm run dev` 报：

```
dlopen failed: incompatible architecture (have 'arm64', need 'x86_64h' or 'x86_64')
```

或者（之前 dist:win 失败遗留的情况）：

```
slice is not valid mach-o file （实际是 PE32+ Windows DLL）
```

**修复**：`desktop-app/package.json` 的 `dist:mac` 末尾追加 `&& npx @electron/rebuild -f -w better-sqlite3`。现在 4 个 dist 命令格式完全一致：打包结束后都自动 rebuild 回 host arch。

`@electron/rebuild` 默认用 host arch（Intel Mac → x64，Apple Silicon Mac → arm64），不需要硬编码 `--arch`。

## v0.6.3 (2026-04-14)

### 修复 — 图表 4 个剩余视觉问题（接 v0.6.2 Chart.js 自动转换）

v0.6.2 让 Chart.js drift 也能渲染了，但**图表本身的视觉质量仍有 4 个问题**（实测 215 机型截图）：

1. **长标题和右上角 legend 撞车** — 标题 `215机型设备侧效率趋势图（2025年7月-12月）` 28 字符，挤进了主题原本预留给 legend 的 right 区域
2. **Y 轴 0-100% 太宽** — 数据集中在 88-92%，0-100 让 4pp 差异看起来像直线
3. **decal pattern 太重** — `aria.decal: { show: true }` 给每个 series 加密集紫红色 dots，整张图 80% 被 pattern 覆盖
4. **多 series 折线图渐变 areaStyle 重叠成浑浊色块** — 主题默认开启 `line.areaStyle` 渐变，2 series 渐变叠加成一片紫红

### 修复 A — 主题（`echarts-pixel-theme.ts`）

| 改动 | 之前 | 之后 |
|---|---|---|
| `legend` 位置 | `top: 12, right: 16`（top-right）| `bottom: 12, left: 'center'`（底部居中）|
| `grid.top` | 72 | 64 |
| `grid.bottom` | 40 | 56（给底部 legend 留空间）|
| `aria.decal.show` | `true` | `false`（保留 aria 给屏幕阅读器，但不渲染视觉 pattern）|
| `line.areaStyle` | 默认渐变 | **删除默认**（多 series 时浑浊；单 series 想要让 LLM 显式 `series[0].areaStyle: {}` 主题会自动注入颜色）|

底部 legend 是更稳的默认，长标题 + 多 series 都不会冲突。

### 修复 B — `draw-chart.md` skill 加 4 条规则

`templates/skills/draw-chart.md` + `avatars/小堵-工商储专家/skills/draw-chart.md` 同步（343 → 357 行）：

#### 规则 3（新）：百分比/效率类数据自适应 Y 轴

```
如果数据是 % 类（设备效率、转化率、SOH、合格率），强制 0-100 会让 4-5pp
差异看起来像直线。规则：
- 计算数据 [min, max]
- yAxis.min: floor((min - 2) / 5) * 5  （向下取整到 5 的倍数，留 2pp buffer）
- yAxis.max: ceil((max + 2) / 5) * 5   （向上取整到 5 的倍数，留 2pp buffer）
- yAxis.axisLabel.formatter: "{value}%"
- 例：数据 88.25-90.6% → yAxis.min: 85, max: 95
```

这是 UED "禁止截断 Y 轴" 的合理例外：百分比本身就是相对量，不会误导。

#### 规则 4（强化）：标题 + 副标题必填，标题 ≤ 20 字符

```
- title.text 简洁（≤ 20 字符），不要把数据范围塞进 text
- title.subtext 必须有，写"数据来源 / 时间范围 / 项目数 / 单位"
- 错误反例：text: "215机型设备侧效率趋势图（2025年7月-12月）"（28 字符）
- 正确：text: "215 机型设备侧效率趋势"
        subtext: "数据源：xxx · 2025-07 至 2025-12 · 单位 %"
```

#### 配合规则 2 更新：areaStyle 默认关闭

```
v0.6.3 起主题不再默认给折线图加渐变 areaStyle。
- 单 series 折线图想要渐变：series[0].areaStyle: {} 显式开启
- 多 series 折线图：严禁 areaStyle
```

#### 高级视觉段同步描述

新增说明 "legend 自动放底部居中（v0.6.3 起）" + "aria 启用但不渲染 decal pattern（v0.6.3 起）"，让 LLM 知道主题已经接管这两件事。

### 验证

- desktop-app typecheck ✅ / lint ✅ / build ✅
- **实际效果需要用户重启 Soul** 让 LLM 看到新 skill 规则 + 重新走主题渲染。预期：
  - 长标题不再撞 legend（legend 在底部）
  - 百分比图表 Y 轴自适应（不再 0-100）
  - 没有紫红色 dots pattern
  - 多 series 折线图不再有重叠面积渐变

### 三轮图表修复进度

| 版本 | 修复 | 解决的问题 |
|---|---|---|
| v0.6.1 | draw-chart 数据守护规则 | < 3 数据点禁折线、markLine 门槛、稀疏告知、emoji legend icon |
| v0.6.2 | Chart.js drift 自动转换 + skill ECharts 警告 | "Cannot create property 'series' on boolean 'true'" 渲染失败 |
| v0.6.3 | 主题视觉打磨 + 百分比 Y 轴 + 标题长度 + decal 关闭 + areaStyle 关闭 | 长标题撞 legend / Y 轴范围浪费 / decal 太重 / 渐变叠加浑浊 |

## v0.6.2 (2026-04-14)

### 修复 — Chart.js 格式 LLM drift 导致渲染失败

**问题**：用户问 "215 机型最近 6 个月设备侧效率折线图"，LLM 输出了 **Chart.js 格式**而非 ECharts 格式：

```json
{
  "type": "line",
  "data": {
    "labels": ["2025年7月", "2025年8月", ...],
    "datasets": [{ "label": "星火项目设备侧效率", "data": [88.25, 88.28, ..., null] }]
  }
}
```

`ChartRenderer.setOption()` 直接喂给 ECharts，ECharts 内部某处做 `xxx.series = ...` 但 xxx 被 type coercion 成 boolean true，抛出 `Cannot create property 'series' on boolean 'true'`。

**根因**：LLM 训练数据里 Chart.js 远比 ECharts 流行，draw-chart skill 虽然有 ECharts 示例但**没明确说"不是 Chart.js"**，LLM 偶尔会下意识 drift 到更熟悉的 Chart.js 格式。

### 双管齐下修复

#### 修复 A — `ChartRenderer.tsx` 防御性 schema 转换

新增 3 个模块级 helper（**提到组件外避免 useEffect closure 问题**）：

- **`detectChartJsFormat(opt)`**: 检测 `{type, data: {labels, datasets}}` 模式 + 验证缺失 `series/xAxis/yAxis`（防 ECharts 误判）
- **`convertChartJsToECharts(opt)`**: 自动转换为 ECharts 等价格式
  - 笛卡尔系（line / bar / scatter / radar）→ `{title, tooltip, xAxis, yAxis, series}`
  - 饼图（pie / doughnut）→ `{title, series: [{type: 'pie', data: [{name, value}]}]}`
  - `null` → `'-'`（ECharts gap marker，折线图缺口正确显示）
  - `options.plugins.title.text` → `title.text`
  - 多 dataset 时自动加 `legend: {}`
- **`normalizeOption(opt)`**: 入口函数，先 detect → 命中则转换 + 控制台 warn 一次（方便排查 LLM drift），最后注入 `withSafeGrid`

`useEffect` 里的 `setOption(withSafeGrid(option))` 改为 `setOption(normalizeOption(option))`。LLM 即使输出 Chart.js 格式，图表仍能正确渲染。

#### 修复 B — `draw-chart.md` skill 顶部加技术栈警告

`templates/skills/draw-chart.md` + `avatars/小堵-工商储专家/skills/draw-chart.md` 同步更新（292 → 343 行），在 `## 技能说明` 段之前插入新段：

```
## ⚠️ 技术栈说明（关键 — 必读，输出前自检）

本项目使用 Apache ECharts 5+，不是 Chart.js / Plotly / Vega-Lite / D3 / Recharts。
LLM 训练数据里 Chart.js 比 ECharts 流行很多，你可能下意识写出 Chart.js 格式，
这会直接导致渲染失败。

❌ Chart.js 格式（绝对不要输出这种）：
{ "type": "line", "data": { "labels": [...], "datasets": [{...}] } }

✅ ECharts 格式（正确）：
{ "title": {...}, "xAxis": {...}, "yAxis": {...}, "series": [...] }

[关键差异对照表 7 行]

[输出前自检清单 4 条]
```

### 三层防御汇总

| 层 | 修复 | 作用 |
|---|---|---|
| **prompt 层** | skill 顶部技术栈警告 + 对照表 + 自检清单 | 让 LLM 知道项目用 ECharts 不是 Chart.js |
| **代码层** | ChartRenderer detectChartJsFormat + convertChartJsToECharts | LLM 即使 drift 也能自动转换不崩 |
| **错误层** | 之前已有的 ChartErrorBoundary（红框 + 原 JSON）| 转换失败时仍能展示原始 JSON 便于调试 |

### 顺带改进

- ChartRenderer 的 `withSafeGrid` 也提到模块级（之前在组件 body 内），消除 ESLint `react-hooks/exhaustive-deps` 警告
- 转换后的图自动加 `tooltip: { trigger: 'axis' }`（Chart.js 默认有 tooltip，转换时保留这个体验）

### 验证

- desktop-app typecheck ✅ / lint ✅（修复了之前 closure 引发的 hooks warning）/ build ✅
- 实际效果：用户重启后下次画图，即使 LLM 仍然写 Chart.js 格式也能正常渲染（控制台会有 warn 提示），同时 LLM 看到新 skill 警告后大概率不会再 drift

## v0.6.1 (2026-04-14)

### 修复 — draw-chart 技能数据守护规则（防丑图）

**问题**：用户问 "215 机型 2026 年 1-3 月设备侧效率折线图"，得到的图：
- 只有 1 个数据点 89.81 在 2026 年 1 月位置（Excel 数据源**实际只到 1 月**）
- LLM 不知道数据稀疏，硬画 3 月的 X 轴占位刻度
- markLine 拉了一条蓝色虚线箭头横穿到右边超出图表区域，标签溢出截断
- legend.icon 是个 emoji "⛑️" 字符（不是主题默认的 roundRect）
- 副标题 "数据来源：xxx" 和右上角 legend 在垂直位置上撞车

**根因不是主题美感**（`echarts-pixel-theme.ts` 已经有完整的 UED 风格 — 5 色板、Inter 字体、细 splitLine、毛玻璃 tooltip、smooth lines + 渐变 area、圆角 bar、aria decal），**是 LLM 不遵守 chart skill 规则**：
1. 不检查数据点数量就画折线图
2. 单点数据 + `markLine.type:'average'` → average 退化为水平线 → 箭头拉到画布外
3. 用 emoji 字符作 legend.icon
4. 手写 `legend.right` / `grid` 等位置参数覆盖主题
5. 数据稀疏不告知用户，硬画一个"看起来像 3 个月"的图

数据本身核实：Excel `00_工商储-产品质量指标dashboard_260303.xlsx` 的 "总原始表" sheet 共 912 行，215 机型 + 设备侧效率非空有 121 行，但**统计周期最大值是 `2601`（YYMM 格式）**—— 即 2026 年 1 月就是数据上限，2602/2603 真的不存在。

### 修复内容

**`templates/skills/draw-chart.md`** + **`avatars/小堵-工商储专家/skills/draw-chart.md`** 同步更新（247 → 292 行），新增 **"数据完整性守护"** 段（4 条强制规则）+ 强化 **"❌ 严禁"** 段（4 条新禁止）：

#### 数据完整性守护（画图前必检）

1. **数据点数量门槛**：

   | N | 允许图表 | 禁止 |
   |---|---|---|
   | N=0 | 不画图，输出文字提示 | 全部 |
   | N=1 | KPI 卡片（标题大字 + 单值 + 副标）| line / scatter / pie |
   | N=2 | bar 对比图（2 柱 + 涨跌幅）| line（折线至少需 3 点形成趋势）|
   | N≥3 | 全部允许 | — |

2. **数据稀疏诚实告知**：query_excel 返回行数远少于用户预期时，文字部分必须明确说"数据源中仅有 N 个月可用"，并改用近 6 个月历史数据补够 ≥3 点，**禁止硬画"看起来像 X 个月"但实际只有 N 个点的图**。

3. **markLine / markPoint 数据点门槛**：
   - `markPoint type: 'max' / 'min'` 仅在 N≥3 时启用
   - `markLine type: 'average'` 仅在 N≥3 时启用
   - **反例**：单点 + average markLine → 水平线 + 箭头拉到画布外（v0.6.0 之前的 215 截图就是这样）

4. **X 轴不补空刻度**：数据只到 1 月，X 轴只显示 1 月，不要写 `xAxis.data: ['2026年1月', '2月', '3月']` 占位。

#### 强化 ❌ 严禁

- **手动写 `legend.right` / `legend.top` / `grid.left` / `grid.top` / `grid.right` / `grid.bottom`** —— 主题已经精确计算了位置，手动覆盖会让 legend 撞副标题、grid 把数据挤出图表。
- **`legend.icon` 用 emoji / 符号字符**（⛑️ 🔵 ▲ 之类）—— 只能用 ECharts 内置形状字符串（`'roundRect' / 'circle' / 'rect' / 'triangle' / 'line' / 'pin' / 'arrow' / 'none'`），最好不写让主题接管为 `roundRect`。
- **`series[].name` 含 emoji** —— 部分渲染器把 series.name 当 legend label 渲染，emoji 污染图例。
- **`markLine` / `markPoint` 不检查数据点数量** —— 见数据完整性守护 §3。

### 验证

无代码改动，纯技能 markdown。typecheck / lint / build 跳过。
**实际效果需要用户重启 Soul（让新 skill 生效）后**重问"215 机型最近 12 个月设备侧效率折线图"（避开"1-3 月"那段稀疏数据）观察。

### 附带：图表问题的真凶不是主题 — 长尾观察

```
当用户感觉"图表不高级"时，先排查：
  1. LLM 是否硬写了 legend.icon / grid / legend.right 等位置参数（覆盖主题）
  2. 数据点数量是否充足（< 3 点就不应该用折线图）
  3. markLine / markPoint 是否合理（单点数据用 average 会拉横线）
  4. 数据真实情况是否和用户预期匹配（数据源缺月份就应该告知，而不是占位）

主题层面 (echarts-pixel-theme.ts) 通常已经够用，问题大多在 LLM 不遵守 skill。
```

## v0.6.0 (2026-04-14)

### 性能 — 知识库检索 BM25 token 持久化缓存

**问题**：批量导入大量知识文件后（实测：233 个 .md / 4.5 MB CJK 文本），**第一次** `search_knowledge` 调用让 Electron main process **单线程 CPU 100% 跑 30-180 秒**，UI 出现 macOS beach ball 看起来像死机。原因是 `KnowledgeRetriever.searchChunks()` 的 lazy tokenize 阶段对所有 chunks 用 `segmentit` 中文分词器跑一遍，每次重启都要重做。

**修复**：把分词结果持久化到 `_index/tokens.json`，跨 session 复用。

#### 三层缓存策略

| 层 | 存储 | 失效条件 |
|---|---|---|
| 1 | `chunk.tokens` 内存缓存 | retriever 实例销毁 |
| 2 | `tokensMap` per-retriever 内存 Map | retriever 实例销毁 |
| 3 | `_index/tokens.json` 磁盘 | 文件删除 / 损坏 / chunk key 变化 |

`searchChunks` 的 lazy tokenize 阶段优先查 `tokensMap`，cache miss 才调 segmentit + 回填 + 标记 `tokensDirty`。`ToolRouter.execute()` 在每次工具调用后检测 `isTokensDirty()`，dirty 时同步落盘到 `_index/tokens.json`。

#### 性能预期

| 场景 | v0.5.15 | v0.6.0 |
|---|---|---|
| 冷启动首查（无 tokens.json，233 文件 / 4.5 MB CJK）| 30-180 秒 | 30-180 秒**首次**+ 自动落盘 |
| 热启动首查（tokens.json 存在）| 30-180 秒 | **< 2 秒** |
| 重启后第二次查询 | 慢 → 快 | 始终快 |
| 增量导入 1 个新文件后查询 | 全部重新分词 | 只分词新增 chunks |

**主要收益**：每次重启 Soul 不再付 30-180 秒分词税。批量导入后第一次查询仍然慢一次（构建初始 cache），但**只需要付一次**。

#### 改动文件

- **`packages/core/src/utils/chunk-cache.ts`**（新建）—— `loadTokensCache` / `saveTokensCache` / `TOKENS_FILE` / `PersistedTokens` interface。原子写入复用 knowledge-indexer 的 `tmpPath + rename` 模式，防止崩溃损坏 tokens.json。损坏 / 类型不合法时静默 fallback 到全量重新分词，不抛错。
- **`packages/core/src/knowledge-retriever.ts`** —— 新增 `tokensMap: Map<string, string[]>` 字段、`setTokens` / `getTokens` / `isTokensDirty` / `clearTokensDirty` 方法。`searchChunks` 的 lazy tokenize 循环从"只查 `chunk.tokens`"扩展为"查 `chunk.tokens` → 查 `tokensMap` → 调 segmentit + 回填 map 标记 dirty"。
- **`packages/core/src/knowledge-indexer.ts`** —— `saveIndex` 新增可选 `tokens?: Map<string, string[]>` 参数，存在时调 `saveTokensCache` 一并写盘。`loadIndex` 返回类型新增 `tokens: Map<string, string[]>` 字段，自动调 `loadTokensCache`，缺失或损坏时返回空 Map（向后兼容旧 `_index/`）。
- **`packages/core/src/tool-router.ts`** —— `getRetriever` 在加载 `index` 后调 `retriever.setTokens(index.tokens)` 注入持久化缓存。新增 `saveRetrieverTokens(avatarId)` 方法封装"检测 dirty → 落盘 → 清 dirty"逻辑。`execute()` 在每次工具调用后调用此方法，覆盖所有可能触发 lazy tokenize 的工具（`search_knowledge` / 内部 wiki 注入 / `compare_products` 等）。
- **`packages/core/src/index.ts`** —— 导出 `loadTokensCache` / `saveTokensCache` / `TOKENS_FILE` / `PersistedTokens`。

#### 单元测试（新建 `chunk-cache.test.ts`，8 cases 全通过）

- ✅ saveTokensCache → loadTokensCache 完整 round-trip（含 CJK 字符串、空数组）
- ✅ 文件不存在返回 null
- ✅ 损坏 JSON 返回 null 而不抛错（静默 fallback）
- ✅ 类型不合法的项被跳过，合法项保留（防御外部篡改）
- ✅ 不残留 `.tmp` 文件（atomic write 验证）
- ✅ 自动创建不存在的 `_index` 目录
- ✅ 覆盖已存在的 tokens.json
- ✅ 空 Map 也能保存和加载

回归：vision-ocr 26/26 测试全部通过，无副作用。

#### 向后兼容

- 旧 `_index/` 目录（无 tokens.json）→ `loadIndex` 返回空 Map → 首次查询走完整 lazy tokenize → 完成后自动落盘
- 旧版本升级到 v0.6.0 后**第一次查询仍慢**（构建初始 cache），**之后所有查询和重启都快**
- `_index/tokens.json` 损坏 / 缺失 / chunk key 不匹配 → 静默 fallback 到重新分词，不影响功能

#### 不在 v0.6.0 范围（推迟到 Phase 2）

- **进度事件反馈**（方案 3）—— 让 UI 显示 "正在索引知识库 N/233" 而非 beach ball。需要扩展 `KnowledgeRetriever.searchChunks` 加 `onProgress` 回调，通过 IPC 转发到渲染进程显示 toast。改动跨 5 个文件，单独立项实施。
- **App 启动后台预热 retriever**（方案 2）—— 方案 1 的 cache 命中后首查已经 < 2 秒，预热边际收益小。视用户反馈再决定。

### 验证

- core build ✅ + chunk-cache tests **8/8 ✅** + vision-ocr tests **26/26 ✅**（无回归）
- desktop-app typecheck ✅ / lint ✅ / build ✅

## v0.5.15 (2026-04-14)

### 修复 — 工具轮数耗尽 regression 根因

**问题**：用户问 "画 215 机型 2026 年 1-3 月设备侧效率折线图" 时，LLM 仍然撞 `MAX_TOOL_ROUNDS = 10` 报错 `[系统提示] 工具调用轮数达到上限，已提前结束本轮。`，v0.5.14 的 Excel 查询纪律没能完全遏制。

**真正根因**（`git blame` 追溯到 `261d629` commit，2026-04-13）：`chatStore.ts` 的 `compressOldToolResults` 函数在压缩旧 tool 结果时，末尾的摘要文字是**诱导性指令**：

```
[... 已压缩，原文 N 字符。如需完整数据请重新调用工具查询]
```

"**如需完整数据请重新调用工具查询**" 对 LLM 来说是一条**反向指令** —— 每压缩一次就明确叫 LLM 重新调用工具。这在 "query_excel → load_skill → draw_chart" 这类多工具流程中触发死循环：

| Round | LLM 动作 | LLM 看到的 |
|---|---|---|
| 1 | `query_excel(机型=215)` → 3 行数据 | 完整数据 ✓ |
| 2 | `load_skill('draw-chart')` | Round 1 结果被压缩 + "请重新调用工具查询" ⚠️ |
| 3 | LLM 看到提示 → 重新 `query_excel` | Round 2 也被压缩 |
| ... | 重复 | **死循环耗尽 10 轮** |

这是 `261d629` 引入的文案错误，当时只测了"两轮简单流程"，没覆盖多工具流程。

### 修复 A — `compressOldToolResults` 压缩文字从"诱导"改"禁止"

`desktop-app/src/stores/chatStore.ts` 压缩摘要末尾文字：

- ❌ 旧：`"如需完整数据请重新调用工具查询"`
- ✅ 新：`"⚠️ 不要因为这段被压缩就重新调用相同参数的工具 —— 这是你之前已经查询过的数据，结果的要点应该还在你的推理链路和最近轮次回答里。仅当你需要不同 filter / sheet / file 的新数据时才调用工具。"`

从"请重新调用"反向改成"**不要**因为压缩就重调相同参数"，消除了 LLM 的死循环诱因。

### 修复 B — `compressOldToolResults` 保留最近 2 轮 tool 结果而非 1 轮

原逻辑：找 **最后一个** assistant 消息，压缩它之前的所有 tool 结果（保留 1 轮）。
新逻辑：找 **倒数第 2 个** assistant 消息，压缩它之前的 tool 结果（保留 2 轮）。

代码改动（`chatStore.ts:compressOldToolResults`）：
- 扫描时计数 `assistantsSeen`，命中 2 个才设 `preserveFromIdx`
- 其他逻辑（压缩阈值 2000 字符、截断长度 500 字符、调用点、函数签名）**完全不变**

**边界情况保证**（所有场景都是旧逻辑的弱化版，永远不会压得比原来更多）：
- 0 个 assistant → 同旧：不压缩
- 1 个 assistant → 旧会压缩前置 tool（但前置本就无 tool，实际等价无操作），新不压缩
- 2+ 个 assistant → 新的永远多保留 1 轮 = ~16KB tool 结果（Excel 场景 1 次 query_excel ≤ 8KB），占 131k tokens context 的 ~6%，安全

### 修复 C — system prompt 加"工具顺序"纪律

`packages/core/src/soul-loader.ts` 的 Excel 查询纪律段新增规则 5：

```
5. 画图/图表需求的工具顺序（关键）：当用户要求生成图表（折线图/柱状图/饼图/趋势对比等），
   必须先 load_skill('draw-chart') 再 query_excel，不要反过来。
   draw-chart 技能内部会告诉你图表 JSON 格式、数据过滤策略、"最多 2 次 query_excel"的纪律。
   - ❌ 错误顺序：query_excel × 多次 → 想起要加载 draw-chart 技能 → 轮数已耗尽
   - ✅ 正确顺序：load_skill('draw-chart') → query_excel × 1-2 次（带精确 filter）→ 输出 chart 代码块
```

**为什么需要 C**：原先 `draw-chart` 技能文件里的 "最多 2 次 query_excel" 纪律只在技能**加载后**才进入 LLM 上下文。LLM 在加载技能前可以自由浪费轮数。这条规则强制 LLM **先** load_skill **再** query_excel，让技能纪律第一时间生效。

### 三项修复的关系

| 修复 | 治什么 |
|---|---|
| A. 压缩文字从"诱导"改"禁止" | **治根因** —— 直接阻断 LLM 看到压缩摘要后重调工具的循环 |
| B. 保留最近 2 轮 tool 结果 | **加缓冲** —— 给 LLM 短期记忆，减少被压缩触发的重调机会 |
| C. 强制 load_skill 先于 query_excel | **防御性前置** —— 让技能纪律第一时间激活，从源头约束 LLM 行为 |

A 是主修，B 和 C 是辅助。即使 A 失效，B 减少触发，C 让技能纪律提前生效。**三层防御**。

### 不影响原有逻辑的保证

- `compressOldToolResults` 函数签名、调用点、阈值、压缩后长度**全部不变**
- 其他压缩机制（`compressedRecentMessages` 的 4 条 assistant 保留）**完全不碰**
- apiMessages 结构、mutation 方式**完全一致**
- 边界情况（0/1 个 assistant）新旧行为**等价**
- 所有场景下新逻辑都是**旧逻辑的弱化版**，永远不会更激进

### 验证

core build ✅ + desktop-app typecheck ✅ / lint ✅ / build ✅。
实际效果需要用户重启应用（让新 system prompt + 新 chatStore 生效）后重试画图请求观察。

## v0.5.14 (2026-04-14)

### 修复 — Excel 查询工具轮数耗尽

**问题**：用户问 "Summary 总表是否有月份数据" 等 schema 类 meta 问题时，LLM 反复调 `query_excel` 试探列名，撞到 `MAX_TOOL_ROUNDS = 10` 上限报错 `[系统提示] 工具调用轮数达到上限，已提前结束本轮。`。

**根因**（排查多轮确认，非代码 bug）：
- `soul-loader.ts:formatExcelSchema` 输出的 Schema 摘要实际非常详尽（列名 / dtype / 唯一值数 / 范围 / 样例），system prompt 里一直完整存在（`compressOldToolResults` 只压缩 `tool` 消息，不动 system prompt）
- 但 LLM **没意识到 Schema 摘要已经能回答 meta 问题**，选择了"用 `query_excel` 去验证"的试探路径
- 用户本次没加载 `draw-chart` 技能，所以"最多 2 次 `query_excel` + 4 轮内必须出图"的纪律没生效，LLM 没有刹车
- 早先的 tool 结果经 `compressOldToolResults` 压缩后，LLM "记忆模糊"又从头探索列名

**修复 A — system prompt 加全局 Excel 查询纪律**（`packages/core/src/soul-loader.ts`）：
在 `# 可查询 Excel 数据源` 段里加入不依赖技能加载的 5 条纪律：
1. schema 相关问题（列名 / 类型 / 是否含月份 / 字段列表 / 数据范围）→ **直接从 Schema 摘要回答，不要调 `query_excel`**
2. 具体数据问题 → 必须带 filter 调 `query_excel`
3. 单次回答**最多 3 次** `query_excel` 调用
4. 禁止"探索式试探"（不带 filter 的 `limit: 5`）
5. 违反纪律会导致工具轮数耗尽

**修复 B — `query_excel` 返回值带精简 Schema**（`packages/core/src/tool-router.ts`）：
`queryExcel` 返回的 payload 新增两个字段：
- `sheet_row_count`: sheet 总行数（原先没返回）
- `schema`: 精简列定义 `Array<{name, dtype}>`，让 LLM 每次查询后都能看到完整列表

这样即使早先的 tool 结果被压缩，LLM 在新一次 query_excel 响应里依然能看到当前 sheet 的所有列名和类型，不会因"记忆模糊"重新试探。不包含 samples / uniqueCount / range（这些在 system prompt Schema 摘要里），避免膨胀 response payload 超过 `QUERY_EXCEL_MAX_CONTENT_CHARS = 8000` 字符上限。

**验证**：core build ✅ + vision-ocr tests 26/26 ✅ + desktop-app typecheck / lint / build 全绿。实际效果需要用户下次问 schema 类 meta 问题时观察 LLM 是否不再调 `query_excel`。

## v0.5.13 (2026-04-14)

### 构建脚本

- **跨平台打包后自动 rebuild better-sqlite3 恢复本机 native binding** — `dist:win` / `dist:linux` / `dist:all` 三个 script 末尾追加 `&& npx @electron/rebuild -f -w better-sqlite3`。**根因**：`electron-builder --win` / `--linux` 会原地 rebuild `node_modules/better-sqlite3/build/Release/better_sqlite3.node` 为目标平台的二进制（为了打进安装包），但打包结束后**不会**恢复本机版本。下次 `npm run dev` 时 Electron 加载的是上一次打包目标平台的 `.node` 文件，macOS 会报 `dlopen failed: slice is not valid mach-o file`（因为实际是 Windows PE32+ DLL 或 Linux ELF）。自动 rebuild 后副作用消除，开发/打包可以自由切换。`dist:mac` 不需要这个步骤（本机打包本机，native binding 不变）。

## v0.5.12 (2026-04-14)

### 修复 — vision-ocr 第四轮代码审查（8 项）

- **Interruptible sleep：overall timeout 升级为硬上限** — 原 `sleep(delayMs)` 不可中断，overall timeout 触发后 worker 仍会等完 retry 退避才 bail，实际 overall 耗时 = `overallTimeoutMs + max_retry_backoff_duration`（最坏可超 10 秒）。新增 `interruptibleSleep(ms, signal)` helper：监听 `signal.abort` 事件立即 resolve（不 reject，让 retry loop 统一走 `overallAborted` 检查）。retry 退避改用 interruptibleSleep，overall timeout 成为真正硬上限。
- **参数校验：`concurrency < 1` / `maxRetries < 0` 抛错** — 原先 `concurrency=0` 静默早退返回空 results（最糟糕组合：既不工作又不报错），`maxRetries=-1` 直接进入 for loop 条件 `attempt <= -1` 为假从不执行。现在两个参数都在开头校验并抛明确的 Error。
- **`callOnce` → `sendRequestOnce` 重命名** — 函数已重构为接收预序列化的 bodyStr，"callOnce" 的旧语义（"调用一次 Vision"）已不精确，新名字更准确反映"发送一次 HTTP 请求"。
- **`buildOpenAICompletionBody` 返回类型收紧** — 从 `object` 改为内部 interface `OpenAIVisionRequestBody`，字段类型安全，未来改协议字段时 TypeScript 能帮忙。
- **`overallController.abort()` 无参数** — 原先传 `new Error('vision-ocr overall timeout')` 作为 abort reason，但实际下游（`fetchWithTimeout` / `interruptibleSleep`）都通过 `overallAborted` 标志和 `classifyError` 统一映射到 `overall-timeout` 类别，不依赖 `signal.reason`。无参数 `abort()` 更简洁，避免 Error 对象在 `signal.reason` 中挂一个永不被读取的字段。
- **`onRetry` / `onProgress` 契约文档完善** — 明确写出两个易踩坑的点：(1) `onProgress.completed` 在多 worker 并发下**顺序非确定**，UI 应按"显示最新值"策略而非假设严格 1,2,3... 递增；(2) `onRetry.nextDelayMs` 是纯退避时间，不含 onRetry 回调自身耗时 —— **实际 retry 间隔 = onRetry 耗时 + nextDelayMs**，回调内部请保持轻量（建议 <10ms）。

### 测试（vision-ocr.test.ts +5 个 case，共 21 → 26）

- **新测试 1：interruptibleSleep 硬上限验证** — `retryBaseMs: 5000`（退避 2500-5000ms）+ `overallTimeoutMs: 200`（200ms overall cap），断言实际耗时 < 1000ms，证明 retry sleep 被 overall timeout 中断唤醒而非等到自然结束。
- **新测试 2：`maxRetries=0` 首次失败立即终态** — 断言 `attempts=1`（无 retry）+ `category='rate-limit'`。
- **新测试 3：`maxRetries=0` 首次成功** — 断言无 failures。
- **新测试 4：`concurrency=0` 抛错** — 验证参数校验。
- **新测试 5：`maxRetries=-1` 抛错** — 验证参数校验。
- **修复 flaky 测试** — "Retry-After: HTTP date 格式" 原先用 `Date.now() + 1500` 偶发失败（HTTP date 精度到秒，toUTCString 丢 ms 后 Date.parse 回来最多少 999ms，实际等待可能低至 501ms）。改为 `+3000ms` 保证最小等待 2001ms，断言 `>= 1900ms` 稳定通过。

## v0.5.11 (2026-04-14)

### 修复 — vision-ocr 第三轮代码审查（12 项）

- **Full jitter → Equal jitter** — 原 `random(0, base * 2^n)` 可能返回 0ms 等于没退避。改为 AWS Architecture Blog 推荐的 Equal Jitter `delay/2 + random(0, delay/2)`，保证最小退避 delay/2（attempt=0 时 500-1000ms），同时保留随机分散 retry 风暴的能力。
- **SyntaxError（畸形 JSON 响应）可重试** — DashScope 偶发返回 HTML 错误页、gzip 解压失败或截断的响应体，`response.json()` 抛 `SyntaxError`。原先归入 `parse-error` 类别后直接终态失败，现在识别为瞬时错误允许 retry。`isRetryable` 对 `SyntaxError` 返回 true。
- **`aborted` 归到 `overall-timeout` 而非 `unknown`** — `classifyError` 对 `HttpError.type === 'aborted'` 原返回 `'unknown'`（callVisionOcr 不接受外部 signal，所有 aborted 都来自 overall timeout，归 unknown 不精确）。改为返回 `'overall-timeout'`。
- **`onRetry` / `onProgress` 回调支持 async** — 返回类型从 `void` 改为 `void | Promise<void>`，回调内部会被 `await`。允许用户做 I/O（如写日志文件）而不产生 fire-and-forget unhandled rejection。文档明确 `completed` 含失败的图、`onRetry.category` 是**上一次失败**的分类。
- **`finalAttempt` 重命名为 `lastAttemptIdx`** — "final" 暗示"决定性的"，实际语义是"循环最后一次执行到的 attempt 编号"。`lastAttemptIdx` 更准确。
- **body 构造在 retry loop 外 once-ify** — 一张图 base64 ~6-7 MB，原代码在 `callOnce` 内 `JSON.stringify(body)`，3 次 retry 重复 stringify 3 次 ~20 MB 字符串。现在 processOne 外 build+stringify once，callOnce 接收 `bodyStr: string`。
- **`VisionOcrKnownError` 内部类注释补全** — 说明这是文件内部类（不导出）、外部消费方通过 `VisionOcrFailure.category` 字符串判断分类。

### 测试（vision-ocr.test.ts +5 个 case，共 21 个）

- **Mock fetch 正确响应 AbortSignal** — 原 `delayMs` 实现傻等 setTimeout，不检查 `init.signal.aborted`，导致 overall timeout 测试**没真正覆盖 abort 中断 in-flight fetch 的路径**（如果代码忘了传 signal 给 fetchWithTimeout，测试依然通过）。现在 mock fetch 监听 `signal.abort` 事件并抛 AbortError，真实反映 fetch 被中断的行为。
- **新测试 1：畸形 JSON 响应 → SyntaxError retry** — 断言第一次返回 `<html>not json</html>` 后第二次返回成功，验证 SyntaxError 被识别为 retryable。
- **新测试 2：`Retry-After: 2` → 实际等待 ≥1900ms** — 原测试只用 `Retry-After: 0` 验证解析代码不抛错，**没验证值真的被用了**。新测试断言 elapsed 实测时间接近 2000ms，证明 Retry-After 值确实驱动了等待。
- **新测试 3：`Retry-After: HTTP date 格式`** — 构造未来 1.5 秒的 HTTP date 字符串，断言实际等待 ≥1000ms，覆盖 `parseRetryAfter` 的 date 解析分支（原先是死代码）。
- **新测试 4：Overall timeout 在 retry sleep 期间触发** — 设置 `retryBaseMs: 2000` 让 retry 退避 1-2 秒、`overallTimeoutMs: 100` 强制 sleep 中触发 abort，验证 for-loop 顶部的 `overallAborted` 检查能正确短路退出。
- **新测试 5：Overall timeout 中断 in-flight fetch** — 单个 fetch 延迟 500ms、overall timeout 100ms，断言 elapsed < 400ms，证明 AbortSignal 确实触达到正在 fly 的 fetch 上（而不是等 fetch 完成后才发现 overallAborted）。

## v0.5.10 (2026-04-14)

### 修复 — vision-ocr 第二轮代码审查（12 项）

- **自定义 Error 类替代 monkey-patch** — 原先在 Error 对象上动态加 `__visionCategory` / `__visionPartial` 属性再强制 cast 读出，是 TypeScript 反模式。现改用 `VisionOcrKnownError` 内部 class，字段类型安全、`instanceof` 检测不需要 cast，日志序列化时也不会泄漏私有字段。
- **empty-response 现在可重试** — 原先 empty content 被当作终态直接失败，但实际可能是 DashScope 瞬时抽风（内部限流返回空、代理吃响应体等）。现设置 `VisionOcrKnownError.retryable=true`，受 `maxRetries` 控制，连续失败才视为真终态。
- **整批 overall timeout cap** — 防御 worst case：单图 3 次 retry × 300s timeout = 15 分钟/图，50 张图理论最坏 4+ 小时。新增 `DEFAULT_VISION_OVERALL_TIMEOUT_MS = 20 * 60 * 1000`（20 分钟）和 `overallTimeoutMs` option。触发后：已完成的保留、进行中的 fetch 被 `AbortSignal` 中断、未启动的 slot 标记为 `overall-timeout` 类别失败提前返回。
- **尊重 `Retry-After` 头** — 429 限流响应通常带 `Retry-After: N` 头告知客户端等多久。原先完全忽略。改造 `fetchWithTimeout`：非 2xx 响应时把 response headers 规范化为小写 key 后附到 `HttpError.headers`；vision-ocr 在 429 retry 时读取 `retry-after`（支持秒数和 HTTP date 两种格式），取服务器建议和本地 full-jitter 退避中的**较大**值作为实际等待时间。
- **Full jitter 指数退避** — 原先公式 `base * 2^attempt + random(0, 500)` 是 "fixed jitter"，当 base delay 较大时打散效果差（attempt=2 时 4000ms delay 只有 12.5% 方差）。改为 AWS 推荐的 full jitter: `random(0, base * 2^attempt)`，更能分散 retry 风暴，避免所有 worker 同时醒来再次打 API。
- **`onRetry` 回调 + retry sleep 期间 UI 反馈** — 新增 `onRetry?: (info) => void` option，每次决定 retry 前触发（在 sleep 之前），info 包含 `index / attempt / category / nextDelayMs`，上层 UI 可以显示 "图 23 正在重试 (第 2 次 / 限流退避 1500ms)"，不再出现进度条无故冻结。
- **`finish_reason === 'length'` 截断检测顺序调整** — 原先先检查 `!text`（空）再检查 truncated，导致"0 tokens 就截断"被归类为 empty 而非 truncated。现调整为先检查 truncated，保证 finish_reason=length 总被正确分类。
- **OpenAI 协议细节抽象** — 把请求体构造（`buildOpenAICompletionBody`）和响应解析（`parseOpenAICompletionResponse`）抽成内部 helper，"协议细节"和"retry 逻辑"解耦。不引入 provider interface（避免过度设计），但未来替换 vision provider 只需换这两个函数。
- **孤儿 JSDoc 搬家** — 上一轮重构把 `callVisionOcr` 主函数的 JSDoc 块留在了中段、与函数本体断联。现整块挪到函数正上方。
- **`while` 循环改 `for`** — retry loop 改用 `for (let attempt = 0; attempt <= maxRetries; attempt++)`，意图更显式、更符合约定。
- **新增单元测试 16 个（覆盖所有 retry 分支）** — `packages/core/src/tests/vision-ocr.test.ts`，用 Node 原生 `node:test` runner + mock `globalThis.fetch`。覆盖：成功路径、429/5xx/network retry、4xx 不重试、连续失败分类、truncated 保留 partial、empty retry、Retry-After 头、onRetry/onProgress 回调、并发 cursor 原子性、overall timeout 触发、参数校验、baseUrl 归一化。
- **`HttpError.headers` 字段（向后兼容）** — `HttpError` 构造函数第 4 参数新增可选 `headers?: Record<string, string>`（小写 key）。所有现有 `new HttpError(...)` 调用无需修改。`fetchWithTimeout` 非 2xx 分支自动填充规范化后的 headers，供上层做智能退避。

## v0.5.9 (2026-04-14)

### 修复

- **Vision OCR 加入 retry + 错误分类** — 批量 ENHANCE 场景下偶发的 OCR 单图失败，根因主要是瞬时错误（DashScope 限流 429、5xx 服务端、网络层抖动、超时），原 `callVisionOcr` 对单图失败只 `logger.error` 后继续下一张、完全不重试。现加入指数退避 retry（默认 2 次 = 最多 3 次 attempt，基数 1000ms + jitter），按 `HttpError.type/status` 分类：`timeout` / `network` / `429` / `5xx` → 可重试；`4xx`（非 429）/ `aborted` → 不重试。预期失败率显著下降。
- **Vision OCR 失败类别化** — `VisionOcrFailure` 新增 `category` 字段（`timeout` / `rate-limit` / `server-error` / `network` / `client-error` / `empty-response` / `truncated` / `parse-error` / `unknown` 共 9 类）、`attempts` 字段（实际尝试次数）、`httpStatus` 字段。上层 UI 和日志可按类别聚合展示，便于排查。
- **Vision OCR 默认参数上调** — `DEFAULT_VISION_TIMEOUT_MS`: 180s → 300s（极端复杂图偶有 180-240s 耗时）；`DEFAULT_VISION_MAX_TOKENS`: 4096 → 8192（密集技术图原常被截断）；新增 `DEFAULT_VISION_MAX_RETRIES` / `DEFAULT_VISION_RETRY_BASE_MS` 常量及 `maxRetries` / `retryBaseMs` options 供上层覆盖。
- **`finish_reason === 'length'` 截断检测** — 原本输出被 `max_tokens` 截断时只返回部分内容不报错，上层拿到残缺数据不知情。现识别此情况记为 `truncated` 类别失败，但 `results` 仍保留已截断的部分内容（供调用方判断是否使用），`failures` 里同时登记。
- **`baseUrl` 归一化** — 去掉尾部斜杠避免拼接出 `//chat/completions` 双斜杠。
- **HTTP `Accept` 头补齐** — 显式 `Accept: application/json`。

## v0.5.8 (2026-04-14)

### 修复与重构

- **抽取共享 Vision OCR 管线到 core** — 新建 `packages/core/src/utils/vision-ocr.ts`，导出 `callVisionOcr(images, options)`。主进程 ENHANCE 路径和渲染进程单文件导入路径原先各自维护一份 Vision 调用（prompt/模型名/参数硬编码、容易漂移），现合并为同一实现，消除重复代码约 80 行。
- **Vision OCR 并发化** — 从串行循环改为 worker-based 并发（默认 3 路），一份 50 图表页 PDF 的 OCR 时间由 5-12 分钟降至约 1/3。单图失败不中断其他图，失败详情通过 `failures` 数组上报。
- **Vision 模型名参数化** — 原先两处硬编码 `qwen-vl-max`，现通过 options 注入，保留默认值。
- **`findRawFile` 脆弱匹配改为 frontmatter 索引** — 批量导入时把 `preserveRawFile` 返回的精确路径写入 `.md` 文件的 `raw_file: _raw/xxx.pdf` 字段，ENHANCE 时直接读取定位原始文件，避免按文件名反查可能命中错误扩展名（`foo.pdf` vs `foo.xlsx`）、基名碰撞、时间戳正则误伤等问题。老文件（无 `raw_file` 字段）自动回退到 `findRawFile` 按名匹配，保证向后兼容。
- **`preserveRawFile` 原子性** — 解析顺序调整为"先 `parseFile` 后 `preserveRawFile`"，解析失败时不再产生 `_raw/` 孤儿文件。
- **`enhance-knowledge-files` 签名 options 化** — 由 7 个位置参数 `(avatarId, apiKey, baseUrl, model, ocrApiKey?, ocrBaseUrl?, targetFiles?)` 改为 `(avatarId, { llm, ocr?, targetFiles? })`，消除 `undefined` 占位，类型更强。返回值从 4 字段扩展到 8 字段：新增 `fabricatedDetails`（每文件的疑似编造值清单）、`ocrFailures`（跨文件 OCR 失败计数）、`indexBuilt` / `contextCount` / `embeddingCount`（索引重建结果）。
- **索引重建挪进主进程 handler** — 原先 ENHANCE 完成后由渲染进程再发起一次 `buildKnowledgeIndex` IPC 调用，有"用户在 ENHANCE 完成前关窗口导致索引漏建"的风险。现改由主进程 handler 在 for-loop 后直接调用 `buildKnowledgeIndex + saveIndex + invalidateRetriever`，原子化 + 减少一次 IPC round trip。
- **OCR 单图失败静默吞掉** — 原先单图调用异常只 `logger.error` 然后继续下一张，前端完全看不见。现通过 `ocrFailures` 返回字段汇总上报，ENHANCE 结束时在 toast 显示 `N 张 OCR 失败`。

## v0.5.7 (2026-04-14)

### 增强

- **批量导入保留原始文件** — `batchImportFiles` 新增 `preserveRawFile` 调用，将原始文件（PDF/Word/图片等）复制到 `knowledge/_raw/`，供 ENHANCE 补跑 OCR / 数值校验时使用。
- **ENHANCE 走完整管线** — `enhance-knowledge-files` 从原来的"仅 LLM 格式化"升级为完整管线：从 `_raw/` 重新解析原始文件 → Vision OCR（图表页识别）→ 文本清洗（cleanPdfFullText / stripDocxToc）→ Vision 结果语义融合（mergeVisionIntoText）→ LLM 逐章格式化 → 数值校验（detectFabricatedNumbers）→ 写回。ENHANCE 完成后自动触发检索索引重建（上下文摘要 + 向量嵌入），确保 RAG 检索使用最新内容。无 `_raw/` 原始文件时自动回退到旧的纯文本格式化模式。

## v0.5.6 (2026-04-14)

### 修复

- **pptx 导入产生 OOXML 乱码** — `parsePptx` 的 `<a:t>` 正则 `<a:t[^>]*>` 会误匹配 `<a:tblPr>`/`<a:tbl>`/`<a:tableStyleId>` 等以 `a:t` 开头的其他 DrawingML 标签，导致导入结果里混入大段 OOXML 样式 XML。改为 `<a:t(?:\s[^>]*)?>`（`a:t` 后必须是空白字符或直接 `>`），并补上 XML 实体反转义（`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`）。
- **Viewer/Editor 把 pptx 误标为 Excel 数据源** — pptx 快速路径写入 `source: pptx` + `rag_only: true`，但 `KnowledgeViewer` 旧逻辑只按 `rag_only` 分支，统一显示 "📊 EXCEL 数据源"，还建议用 `query_excel` 工具（pptx 根本不支持）。现按 `source` 字段分类渲染：excel → 📊 EXCEL 数据源（`query_excel`），pptx → 📽️ POWERPOINT 数据源（`search_knowledge`），其他 `rag_only` → 📄 大文件数据源。`KnowledgeEditor` 的 `detectExcelSource` 同步推广为 `detectAutoSource`，pptx/其他自动生成文件一并进入只读态。

## v0.5.5 (2026-04-13)

### 新功能

- **UI 全面改造：粉色点阵 LED 风格** — 全局色板从暖金像素风 (`#E8A830`) 改为 LED 粉 (`#FFB0C8`) + void-black (`#0A0A0F`)，新增全局 CRT 扫描线纹理叠加层，按钮/导航/输入框 hover 改为粉色 glow 光晕，ECharts 图表配色同步粉色系，Markdown prose 链接/列表符号同步粉色。

- **pptx 快速导入** — pptx 导入走快速路径跳过 LLM 格式化（文本已按幻灯片页分好结构），秒级完成。之前 100 页 pptx 需要 20+ 分钟（每页当作一个章节逐个调 LLM）。

- **ENHANCE 断点续跑** — 格式化中断后重新运行，自动跳过已增强的文件（检测 `source: enhanced` frontmatter），不从头重来。

- **单文件导入 filter 同步** — UI 文件选择器新增 `.pptx`、`.xls`、`.bmp`，去掉不支持的 `.doc`，与后端 `SUPPORTED_PARSE_EXTENSIONS` 保持一致。

### 代码质量（两轮审查 + 14 项修复）

- **CRITICAL 修复**：PDF 截图上限 `Infinity` → 200（防 OOM）；zip/tar/rar slip 检测改用 `path.resolve` 验证目标目录（防路径穿越）；跨轮次 assistant 压缩逻辑重写（用 Set 标记最近 4 条索引）
- **HIGH 修复**：chart JSON 完整性检测改为花括号计数；enhance body 提取改用 `indexOf` 替代脆弱正则；ChartRenderer grid 注入抽取为 `withSafeGrid()` 去重；`promptEnhanceAfterBatch` 加 `.catch()` 防 unhandled rejection
- **MEDIUM 修复**：单轮 LLM 调用加 3 分钟超时 + 超时后 `abort()` 底层 fetch；批量日志成功/跳过/失败列表统一限 50 条 DOM；delete-avatar 时清理 retriever 缓存；大文件解析加 5 分钟超时 + `_aborted` 标志跳过截图操作

### Bug 修复

- **ENHANCE 数量不一致** — 导入 378 个文件但 ENHANCE 显示 424 个。改为传入本次导入文件列表，只处理当前批次。

---

## v0.5.3 (2026-04-13)

### 新功能

- **知识库质量优化（ENHANCE）** — 批量导入完成后自动进入 LLM 格式化优化，逐个对未格式化文件跑 `formatDocument`（章节切分 + 并发 3 路 LLM 排版），质量与单个导入一致。新增 IPC `enhance-knowledge-files` + 进度事件 `knowledge-enhance-progress` + KnowledgePanel `[✨] ENHANCE` 按钮。

- **启动时检查更新** — 启动时静默请求 GitHub Releases 最新版本号，有新版在顶部显示横幅（版本号 + 更新说明 + 下载链接），点击跳转 GitHub Release 页面。网络失败静默不影响使用。

- **新增 .pptx / .xls 文件导入** — `.pptx`：解析 slide XML 提取 `<a:t>` 文本节点，按幻灯片编号组织。`.xls`：SheetJS 已支持旧版 Excel 格式，加入扩展名白名单。

### Bug 修复

- **批量导入默认 rag_only** — 批量导入的文件自动加 `rag_only: true` frontmatter，不再塞进 system prompt（之前 405 个文件 2.9M 字符全部 stuff 进去导致 context 溢出）。
- **zip slip 检测误判** — 文件名中含 `..` 的文件（如 `10..附件十.docx`）被误判为路径穿越攻击。改为按路径段检测，只有段恰好等于 `..` 才拒绝。同步修复 zip/tar/rar 三种格式。
- **归档导入上限调大** — 单文件 500MB → 2GB，解压上限 1GB → 4GB。
- **单文件导入上限调大** — 80MB → 200MB。
- **PDF 图表页截图取消上限** — 不再截取前 20 页，全部图表页都截图。
- **工具调用纪律** — draw-chart / chart-from-knowledge 技能加入"最多 2 次 query_excel + 4 轮内必须出图"约束，防止 LLM 浪费轮数找数据不画图。

---

## v0.5.2 (2026-04-13)

### Bug 修复

- **修复分身"根据我的经验"语气矛盾** — `soul.md` 中定义的口头禅"根据我的经验..."与 `CLAUDE.md` 中"禁止使用根据我的经验"的规则互相矛盾，导致 LLM 回答时随机冒出不可追溯的个人经验措辞。修复：
  - 说话方式从"总是以根据我的经验开头"改为"结论先行 + 基于知识库数据"
  - 3 个好回答示例全部改为知识库溯源风格，带 `[来源:]` 标注
  - 口头禅从"根据我的经验"改为"根据知识库数据"
  - 现在与 CLAUDE.md 的回答规范完全一致（`avatars/小堵-工商储专家/soul.md`）

- **图表视觉升级：融入 UED 高级审美** — 融合 ued-agent 数据可视化规范，全面提升图表视觉品质：
  - ECharts 主题升级（`echarts-pixel-theme.ts`）：折线图平滑曲线 + 渐变面积填充、柱状图圆角顶部、毛玻璃 tooltip（`backdrop-filter: blur(12px)` + 圆角 8px）、配色新增暗底蓝 `#5E9FD6` 和淡紫 `#B89AE8` 冷暖平衡、Y 轴隐藏轴线极简风、圆形 symbol 替代方块、hover 发光效果
  - draw-chart 技能升级：新增"高级视觉"章节，指导 LLM 配合主题内置效果（不手写 areaStyle/borderRadius/tooltip）、饼图默认环形、markPoint 标注极值
  - 模板同步更新

- **修复多轮工具调用时重复输出** — 倒数第 2 轮 LLM 拿到 query_excel 数据后输出半成品分析 + tool_call，最终轮又重复一遍相同分析。修复：工具调用中间轮次不实时显示 assistant 文字，只在最终轮（无 tool_calls）才渲染完整回答，中间轮用 toolCallStatus 指示器代替（`chatStore.ts`）。

- **修复图表流式输出时红框闪烁 + Y 轴标题重叠** — 流式输出 chart 代码块时，JSON 未写完就触发 JSON.parse 导致红框"解析失败"闪烁，完成后又消失。修复：检测到 JSON 未闭合时显示"图表生成中..."加载态，不报错。Y 轴 name 和 title/subtext 重叠：ChartRenderer 注入默认 grid `{top: 80, left: 80}` 防止重叠（`MessageBubble.tsx` + `ChartRenderer.tsx`）。

- **修复图表 JSON 解析失败 + 图表类型不遵从用户指定** — LLM 在 chart JSON 中输出 JavaScript 函数（如 `"color": function()`），导致前端 JSON.parse 失败显示红框。根因是 draw-chart 技能示例中含 `"valueFormatter": "(v) => v + ' 万'"`，LLM 模仿后输出真正的 JS 函数。同时用户明确要"折线图"但 LLM 自行选了柱状图。修复：
  - 删除示例中的 `valueFormatter` 函数字符串
  - 禁止列表新增"严禁 `function` 关键字"，明确 formatter/color 等字段只能用 ECharts 字符串模板
  - 图表类型约束改为"用户指定时必须严格遵从"
  - 同步修复 `templates/skills/draw-chart.md` 模板

- **修复多轮对话 context 爆掉** — 用户多次查询 Excel 数据 + 生成图表后，工具返回值和长回答累积撑爆 LLM context 上限。新增两层压缩机制（`chatStore.ts`）：
  - **同轮工具结果压缩**：每次进入下一轮 LLM 调用前，把更早轮次中超过 2000 字符的 tool 结果截断为 500 字符摘要（`compressOldToolResults`）
  - **跨轮次 assistant 消息压缩**：构建 apiMessages 时，只保留最近 4 条 assistant 消息的完整内容，更早的超过 3000 字符的回答截断为 800 字符摘要
  - 新增常量：`TOOL_RESULT_COMPRESS_THRESHOLD`（2000）、`RECENT_FULL_ASSISTANT_COUNT`（4）、`ASSISTANT_COMPRESS_THRESHOLD`（3000）

---

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
