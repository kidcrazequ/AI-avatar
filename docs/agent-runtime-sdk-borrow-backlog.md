# Agent Runtime — Claude Agent SDK 借鉴 Backlog

> Updated: 2026-07-01
> 配套文档：`docs/agent-runtime-roadmap.md`
> 定位：Soul 必须保持**多 provider**（DeepSeek / Qwen / Ollama + Anthropic）。所以本文是"借 Claude Agent SDK 的**设计范式**落进 Soul 自己的运行时"，**不是**引入 SDK 这个库（SDK 只认 Anthropic，整体接管即失去多 provider——硬阻碍）。
> 所有结论基于对 live 代码的实读（带 `file:line`），非凭记忆。

---

## 实现状态（2026-07-01 逐项核实后更新）

> 落地过程中逐项实读了 live 代码，**多项发现与最初 backlog 估计不符**——有的已 live、有的冗余、有的 dormant 模块不兑现承诺。真实状态如下：

| ID | 标题 | 状态 | 说明 |
|---|---|---|---|
| **BR-1** | 单轮成本预算上限 | ✅ **已实现** `b9ae22b` | 默认关；`max_budget_usd_per_turn` |
| **BR-2** | 主动上下文压缩 | ✅ **已实现** `f0bc464` | 默认关；新写 tool-call 安全版（`context-compaction.ts`），未硬接 summarizer.ts（它按条数切会拆散 tool 配对） |
| **BR-3** | 权限 + ASK | ✅ **已实现(delta)** `6d70c0f` | **实读发现 ~80% 已 live**（`main.ts:4573` 灰名单原生对话框）；只补了 SDK 的 allow_always（会话级「始终允许」） |
| **BR-4** | 读工具并行 | ⏸️ **暂缓** | 最高风险最低 ROI；工具循环有 cap 计数/converge-flag/顺序 append 等共享状态，安全并行是 L 重构，只利好"多独立读"的偶发场景 |
| **BR-5** | Hook 总线 | ⛔ **撤回** | 边界审查发现现成熔断 hook 挂进程级单例会**永久锁死工具**（PRE deny 后永不再走 POST 清零）；PRE-fire 无消费者，折进 BR-6/未来 |
| **BR-6** | Typed 子 agent | ❌ **评估后不做** | 前提不成立 + 与溯源红线对冲。详见下方「BR-6 决策」。 |
| **BR-7** | Typed 观测面 | ❌ **冗余，不做** | `run-trace.ts` 的 `RunTraceSummary`（`1647b09` 已 live）已聚合 cost/tokens/usage/artifacts/sources，且当前**无 UI 消费方**；再建 ResultMessage 是无读者的重复管线 |
| **BR-8** | 渐进工具披露 | ⏸️ **暂缓** | 弱开源模型（DeepSeek/Qwen/Ollama）工具发现可靠性差，延后长尾工具有真实召回风险 |
| **BR-9** | 会话 fork | ✅ **已存在** | `forkConversation` 全链路已实现（`global.d.ts:833` + preload + `main.ts:2076` + `db.forkConversationFromMessage`，消息树 leaf 指针分叉） |

**结论**：backlog 的**高价值、可干净落地**部分已交付（BR-1/BR-2/BR-3-delta）。其余要么已存在（BR-3 主体/BR-9）、要么冗余（BR-7）、要么高风险低 ROI（BR-4/BR-8）、要么**评估后不做**（BR-6，见下）。**不应为"继续"而机械地接 dormant 模块或建无消费方的管线。** 就 SDK 借鉴而言，本 backlog 视为**收口**：Soul 要的是"更可信的单代理"，不是"更多代理 / 更多治理管线"。

---

## BR-6 决策：评估后不做（2026-07-02）

> 从"Soul 需不需要子代理"的第一性原理评估后结论：**不做 typed 子代理，保留现有 toolless 跨分身委派即可。**

### 实读前提（决定为何不做）

1. **`task` 工具没有 agentType 参数**（`src/stores/chatStore.ts` AVATAR_TOOLS：仅 `task` / `target_avatar` / `expected_output`）。
2. **Soul 子代理是"单发、无工具"的文本补全**：`task` → `SubAgentManager` → `callLLM = createLLMFn(...)`，而 `createLLMFn`（`electron/llm-factory.ts:90`）的请求体是 `{ model, messages:[system,user], stream:false, max_tokens }`——**没有 `tools` 字段**，子代理压根不能调工具。
3. dormant 的 `typed-sub-agent-manager.ts` / `governance/spawn-guard.ts` **只做 system-prompt 提示文字 + blueprint rank 校验**，`callLLM(systemPrompt, task)` 不把受限工具集传进去——**不真正 gate 子代理工具**。

### 为何不做（三条理由）

1. **核心卖点是空的**：BR-6/spawn-guard 的设计是"限制子代理的工具子集"，但 Soul 子代理**没有工具可限**（toolless 单发）。要 gate 的东西不存在。
2. **与溯源红线对冲**：让子代理"能自己调工具"会把它的检索/取数证据链埋进**不透明的子 transcript**，主代理只拿摘要——**溯源变难**，直接戳中 Soul 第一红线（每个数字定位到原始 sheet / md 路径）。现有 toolless 设计不是能力缺失，而是**刻意的安全约束**（便宜、有界 30s、不制造不可溯源检索）。
3. **产品定位不匹配**：Soul = 桌面端、交互式、单分身知识库问答/交付。多代理编排的收益（隔离 + 最小权限 + 深度并行）更适合后台/批处理，不适合同步聊天；且上下文压力已由 **BR-2 压缩**更直接地解决。

### 现有能力已够用

现有 toolless 跨分身委派已很好地服务两个真实场景，且都不需要工具型子代理：
- **跨分身借专长**（`target_avatar`，差异化卖点，已 work）；
- **上下文隔离的自成一体子任务**。

### 唯一例外及其更优替代

四类角色里只有 **verifier 复核**与溯源红线同频。但要真复算数字，verifier 得能"读"（query_excel/read_file）→ 又变回工具型子代理，把溯源矛盾请回来。**更优路径 = 在主循环内联跑一遍复核 pass**：主循环本就有工具 + 完整溯源上下文，证据链全程留在同一条 transcript 里，比派子代理更简单、更守红线。Soul 已有复核原语（`verifyAgentAnswer` 启发式 + `fork_verifier_agent` HTML 截图复核）可在此基础上扩展。

### 若未来确实要重启 BR-6

前置是**产品决策**（"要不要让子代理能调工具"），不是写代码；且真做是 L/XL：点亮 blueprint-loader + 从零建 sub-agent 工具循环 + 按类型 gating + DB `agent_type` 迁移（走 sqlite-migration-reviewer）+ `task` 工具加 agentType 参数。届时必须先给出溯源红线的保全方案。

---

## 0. 现状核对（deep-read 结论）

### 0.1 Live 主循环 = 真·多轮 tool loop（不是单发）

全部在 `src/stores/chatStore.ts` 的 `sendMessage`（~2000 行）里：

- 真正的多轮循环：`runRound`（`chatStore.ts:4559`）流式出模型响应 → 若带 `tool_calls` 则 append assistant 轮 + 逐个执行 → append `role:'tool'` 结果 → 再进一轮，直到模型不再出工具或触顶。循环条件在 `chatStore.ts:4814`。
- 轮数上限：`SOFT_WARN_ROUNDS=8` / `HARD_MAX_ROUNDS=25`（`chatStore.ts:2424`），触顶后强制收敛一轮（`5206-5223`）。
- 工具声明：静态 `AVATAR_TOOLS`（OpenAI function 数组，内联在 `chatStore.ts` ~745–1751），按 mode / 图片 / 网络开关过滤后作为 `ChatOptions.tools` 下发（`4704`）。
- 工具执行：默认走 `window.electronAPI.executeToolCall` IPC → `electron/main.ts:5285` → `ToolRouter.execute`；`todo_write` / `query_excel` / `load_skill` 有渲染进程侧包装。
- 子 agent **是真的**：`task` 工具 → `tool-router.ts:1343 delegateTask` → `SubAgentManager.runTask`（`sub-agent-manager.ts:209`，`Promise.race([callLLM, 30s超时])`）。`fork_verifier_agent` 也是真的（`main.ts:4720` 多视口浏览器截图校验 HTML 交付物）。
- 校验：`verifyAgentAnswer`（`verifier.ts:49`）是**同步正则启发式**，只 log/emit trace，**不阻断、不改写**。

### 0.2 一个必须更正的文档陈述

`desktop-app/CLAUDE.md` 写"知识检索 = BM25 pre-message + agentic 双轨"——**已过时**。当前主聊天链路不做 pre-message 知识注入；检索**只剩** agentic 的 `search_knowledge` / `knowledge_grep` / `query_excel` 工具路径（BM25+vector 在 tool-router 侧）。→ 建议同步更新 `CLAUDE.md` 与全局记忆中的旧知识检索方向记录。

### 0.3 agent-runtime 治理层是"三分"的

`packages/core/src/agent-runtime/`（~40 个导出模块，Phase 1–10）真正跑起来的只有薄薄一片，三个 feature flag 全部**默认 OFF**（`feature-flags.ts:17`）：

| 状态 | 模块 | 说明 |
|---|---|---|
| **live（无 flag 门，每次 send 都跑）** | `behavior-modes`、`guardrails`、`gateway` 的 run-plan builder、`run-trace`、`verifier` | 渲染进程从 `@soul/core/browser` 直接 import 进 `chatStore.ts`（`3485/3500/4862/5472`） |
| **feature-flagged（`SOUL_USE_NEW_RUNTIME=on` 才跑，默认关）** | `hooks`（仅 source-anchor `POST_TOOL_USE`，`main.ts:823`）、`blueprint-loader` + `prompts/segmented-builder`（prompt-cache 分段，`bridge:163` 未开时 early-return） | — |
| **dormant（有代码/有测试，但 live 零调用）** | `typed-sub-agent-manager`、`governance/{permission-enforcer,plan-mode,spawn-guard}`、`compaction/summarizer`、`memory/*`、`a2a/*`、`audit-trail`、`capability-directories`、`skill-draft`、`ingest`、`eval` | 多数只被测试引用；`agent_type` DB 列已迁移但无写入方 |

`electron/agent-runtime-bridge.ts` 本身是**只观测**的（`bridge:71` 包 `RunTraceRecorder`），从不发起模型调用。

**关键含义**：很多"要借鉴"的 SDK 能力，Soul **已经写好了 dormant 版本**，工作量是"接线 + 去 flag"，不是"从零造"。

---

## 1. 借鉴 Backlog（BR-1 … BR-9）

> 字段：**落点** = 具体文件；**工作量** S/M/L；**优先级** P0/P1/P2；**多 provider** = 会不会与多厂商冲突、如何保持中立。

### P0 — 隔离、高安全、依赖已有数据/模块

#### BR-1 · 给 tool loop 加 `maxBudgetUsd` 成本上限 — 工作量 M
- **SDK 范式**：除 `maxTurns` 封轮数外，`maxBudgetUsd` 封累计成本，跨过即停。
- **Soul 现状**：只有轮数上限（`chatStore.ts:2424`）和单工具次数上限（`MAX_QUERY_EXCEL_CALLS_PER_REQUEST=5`）；**无美元上限**，尽管每次调用的成本已在 `cost-tracker.ts` 算好。
- **为何借**：25 轮跑在贵模型 / reasoning 模型上没有金额兜底，单次跑飞可能远超预期成本。是最便宜就能补上的真·loop 缺口，数据现成。
- **落点**：`chatStore.ts`（轮上限区 ~2424 + 内层 loop 4813）读新 `maxBudgetUsd` 设置，每轮 `onDone` 后累加 `cost-tracker` 成本；触顶复用已有强制收敛路径（`5206-5223`）跑最后一轮 tools-off，emit "预算已达上限" trace，~80% 时预警。
- **风险**：成本估算依赖 `cost-tracker` 定价表完整；未定价模型会少算 → 未知价按 0（永不误停）+ 记 warning。
- **多 provider**：无冲突。建在 Soul 已归一化的 usage 上（`claude.ts` 归一 cache_read/creation；`openai-compat` 归一 `prompt_cache_hit_tokens`），**不**用 SDK 的 `total_cost_usd`。Ollama/本地价≈0，上限自然不触发。

#### BR-2 · 主动摘要式 compaction + PreCompact 归档钩子 — 工作量 L
- **SDK 范式**：接近窗口上限时主动把旧历史摘要成 `compact_boundary`，并给 `PreCompact` 钩子在压缩前归档全量。是**阈值驱动的主动**行为，不是失败后重试。
- **Soul 现状**：compaction 是**被动且粗糙**的——逐结果 `truncateToolResultForContext`（`5013`）+ 每轮 `compressOldToolResults`（`5164`）+ 仅在 provider 400 后触发**一次**的 compact-retry（`4759-4782`）；同一轮第二次溢出即硬失败，无主动摘要、无压缩前归档。
- **为何借**：25 轮工具结果的长跑可能二次溢出而死锁，且"lost in the middle"在硬溢出前就已劣化答案。Soul **已备好机器**：`agent-runtime/compaction/summarizer.ts`（`compactIfNeeded`、retain-head/tail、LLM 摘要回调、`ON_COMPACTION` 钩子）**已建成但零 live 调用**。
- **落点**：把 `summarizer.ts` 接进 `chatStore.ts:5164` 后的轮边界；压缩前经 `electron/conversation-jsonl-appender.ts`（事件溯源）归档全量转录。
- **风险**：摘要可能丢掉承重数字/来源——违反 Soul 溯源红线。缓解：慷慨的 retain-head/tail、显式归档（只降级不丢失）、摘要 prompt 里逐字保留工具结果引用。
- **多 provider**：**不要**用 SDK 的服务端自动 compaction + Anthropic token 计数。用 Soul 自己的 token 估算触发，摘要调用走 `LLMService` 打当前 provider（或配一个便宜的 summarizer 模型）。`summarizer.ts` 回调本就 provider 无关。

### P1 — 先建总线，再挂策略

#### BR-5 · 生命周期 Hook 总线（PreToolUse/PostToolUse/Stop/PreCompact）— 工作量 L 【P1 的地基，先做】
- **SDK 范式**：钩子在调用方进程零上下文成本运行，每个可 allow/deny/skip 或返回 `updatedInput` 改写调用。
- **Soul 现状**：只挂了 1 个钩子（source-anchor `POST_TOOL_USE`），且在 `SOUL_USE_NEW_RUNTIME` 后（`main.ts:823`，默认关）。全总线 dormant：`agent-runtime/hooks/{registry,points,built-in}.ts`。等价逻辑现在手写内联在 2000 行 `sendMessage`（guardrail `4862`、trace emit `3533/5049`、memory-write 抽取 `5455-5463`）。
- **为何借**：Hook 总线是 BR-3（PreToolUse=权限）、BR-2（PreCompact=归档）、观测（PostToolUse/Stop）共同的**基座**；它把 gating/trace/memory-write 从单体热路径搬进可测的调用方回调，零 token 成本。
- **落点**：无条件挂 `hooks/registry.ts`（把 `main.ts:823` 的挂载从 source-anchor 泛化），把 `tool-router.ts:1426` 的 PostToolUse 与 `chatStore.ts:4862` 的 pre-tool 决策都路由过去。
- **风险**：热路径逻辑搬进钩子有行为漂移/顺序 bug。缓解：一次迁一个钩子点，旧内联路径保留到 parity 测试通过再删。
- **多 provider**：无冲突，钩子在调用方进程跑、不碰模型线格式。

#### BR-3 · 确定性分层权限评估 + ASK 三态 — 工作量 L
- **SDK 范式**：一条确定管线按固定顺序评估每个工具调用：hooks → deny → ask → mode → allow → `canUseTool`，三态（allow/ask/deny）+ 交互式 ASK。
- **Soul 现状**：gating 是 6 处散落检查、隐式优先级，全塞在 2000 行 `sendMessage`：runtime guardrail（`4862`）、mode 策略（`4882` + 预过滤 `4361`）、单工具次数上限（`4949/4971`）、网络总开关（`4339-4372`）、trustTier（`3320`）、advisory verifier（`5472`）。**只有 allow/deny 二态，无交互 ASK**。
- **为何借**：散落顺序难推理、无法单测；且缺"不可逆动作先问用户"的 ASK 路径（尽管 guardrails 已建模 `irreversible_action_confirm`）。Soul **已备好 SDK 形状的答案**：`governance/permission-enforcer.ts` 正是 DENY/ASK/ALLOW 三态 + NotificationAdapter，**零 live 调用**。
- **落点**：把散落 gate 收敛到 `permission-enforcer.ts` 一处有序决策，在 `chatStore.ts:4862` 每工具调一次；为 ASK 实现 `ElectronNotificationAdapter`（preload + main IPC）；把 `governance/plan-mode.ts` 并进来。
- **风险**：重构热路径 gating 可能放过原本拦截的工具。缓解：把每个现有检查移植成命名 rule + 表驱动测试断言相同 allow/deny，再切线。
- **多 provider**：无冲突，权限评估是纯 policy（对工具名/参数），完全 provider 无关——**最安全可原样借的一条**。

#### BR-6 · Typed 子 agent（explore/plan/worker）+ 能力子集 SpawnGuard — 工作量 M
- **SDK 范式**：`Agent` 工具在隔离新上下文起子 agent，限定工具子集 + 各自 model/effort/maxTurns（`AgentDefinition`），只回传压缩结果——上下文效率 + 最小权限。
- **Soul 现状**：live 的 `task` 走**普通** `SubAgentManager`（`tool-router.ts:6203` → `sub-agent-manager.ts:209`，真 30s 有界 callLLM）。typed 版（agentType + 能力子集）已存在——`typed-sub-agent-manager.ts` + `governance/spawn-guard.ts`（`SUB_AGENT_PROFILES`）——但**只被测试引用**；`agent_type` DB 列已迁移却无写入。
- **为何借**：现在任何委派都继承全工具面、无收窄，子 agent 能干父的一切。typed profile 给最小权限隔离（explore=只读、worker=限定写），且 DB 列已就位。
- **落点**：把 `tool-router.ts:6203` 的 `delegateTask` 改路由到 `typed-sub-agent-manager.ts`，经 `spawn-guard.ts checkSpawn` 派生子能力子集；`agentType` 落 `agent_type` 列；emit SubagentStart/Stop trace。
- **风险**：profile 过窄会饿死正当子任务。缓解：`SUB_AGENT_PROFILES` 先按当前全集播种，观察真实委派后再逐 profile 收紧。
- **多 provider**：无冲突，子 agent LLM 调用已走多 provider `LLMService.callLLM`；`AgentDefinition.model/effort` 保持 optional，回落到 avatar 配置的 provider，别假设 Anthropic effort 语义。

#### BR-4 · 读工具并行执行（readOnlyHint 注解）— 工作量 M
- **SDK 范式**：给工具注解（readOnlyHint/destructiveHint…），只读工具并行、写工具串行。
- **Soul 现状**：一轮内工具**严格串行**（`chatStore.ts:4833/4957` 的 `for...await`），工具无读/写注解。一轮里 N 个独立 `search_knowledge`/`query_excel`/`read_attachment` 白付串行往返延迟。
- **为何借**：模型常在一轮里出多个独立读调用，串行纯是延迟、无正确性收益。并行读是热路径直接 UX 提升。
- **落点**：`chatStore.ts:4833` 工具执行 loop；加一个按工具名的 readOnly 查表（挨着 `AVATAR_TOOLS` 定义或放 packages/core 工具元数据）。
- **风险**：误标只读却有副作用的工具会 race。缓解：未知工具默认串行（opt-in allowlist），保留单工具次数上限。
- **多 provider**：无冲突。注解放 Soul 侧注册表，**不**进下发给 provider 的工具 JSON（OpenAI schema 无注解字段；Anthropic 忽略未知键）。执行侧并行是 provider 无关的。

### P2 — 整合 / nice-to-have

#### BR-7 · 归一化 usage 之上的 typed 单轮观测面（cost/token/cache）— 工作量 M
- **SDK 范式**：typed 消息流每条带 `total_cost_usd` + token/cache usage，是设计出来的观测面而非零散 log。
- **Soul 现状**：观测分裂且部分 dormant：`cost-tracker.ts` 算成本、`run-trace.ts` 记事件、verifier 记 advisory。没有单一 typed "本轮 ResultMessage" 聚合 cost+token+cache+tool 数供 UI/eval 消费。
- **为何借**：统一 typed result 让 cost 上限（BR-1）、eval 回归、UI cost 徽标读同一契约；是在已归一化数据上的小整合。
- **落点**：在 `chatStore.ts` 末轮 `onDone` emit provider 中立的 `ResultMessage{costUsd,inputTokens,outputTokens,cacheRead,cacheCreation,rounds,toolCalls}`，聚合 `cost-tracker` + run-trace summary，经 bridge 暴露。
- **风险**：低（增量遥测）。避免双记成本 → ResultMessage 读 cost-tracker 而非重算。
- **多 provider**：定义 Soul 自己的 `ResultMessage`（基于已归一化 usage），别 import SDK 消息类型。

#### BR-8 · ToolSearch 式渐进工具披露 — 工作量 M
- **SDK 范式**：`ToolSearch` 把完整工具 schema 延后，in-context 只留名字/摘要，用时才取。
- **Soul 现状**：~700 行 `AVATAR_TOOLS` schema 每次 send 全量下发（`chatStore.ts:4352-4374` 只按 mode/图片/网络过滤）。Soul **已对技能证明了这个范式**——`getSkillsSummary` 只注入摘要、`load_skill` 按需取全文（`soul-loader.ts:227`）——但工具本身仍全量展开。
- **为何借**：静态工具数组是每轮固定上下文税；把长尾工具 schema 延后（藏在 `search_tools`/`load_tool` 后）像技能那样缩小 prompt，给检索结果腾预算。
- **落点**：`tool-router.ts` 加工具目录 + `search_tools`/`load_tool`（照抄 `loadSkill`），`chatStore.ts` 常开集缩到核心子集 + 摘要。
- **风险**：弱开源模型（DeepSeek/Qwen/Ollama）工具调用可靠性差，可能发现不了看不见的工具。缓解：保留 mode 过滤的静态数组作 fallback，只延后真长尾，**按模型档位**（`llm-service getModelTier`）门控而非假设 Anthropic 级发现力。
- **多 provider**：机制 provider 无关，但弱非 Anthropic 工具调用是真风险 → 静态数组路径常备。

#### BR-9 · 会话 fork/resume 分支 — 工作量 M
- **SDK 范式**：会话是 JSONL 转录，`resume=id` / `continue:true` / `fork_session`，`listSessions`/`getSessionMessages` + 可插拔 SessionStore。
- **Soul 现状**：已 SQLite + JSONL 双写（`conversation-jsonl-appender.ts`，v17 事件溯源），resume/list 实质已有。缺的是 **fork**——在某点分支探索另一方向而不改原对话。
- **为何借**：fork 让用户从会话中途试另一走向（不同 plan 回答、不同工具路径）而不毁历史，天然契合已有事件溯源 JSONL。
- **落点**：在 `conversation-jsonl-appender.ts` 上加 fork 操作（复制到 cutoff 的事件进新 conversation id），走新 IPC + chatStore action。
- **风险**：低（增量）。确保 `attachments/<convId>/` 引用被复制或只读共享，别让分支悬挂。
- **多 provider**：无冲突，会话/转录在 provider 层之下、Soul JSONL+SQLite 本就中立。

---

## 2. 不借鉴清单（given Soul 约束，明确不做）

| SDK 东西 | 为何不借 |
|---|---|
| **整体接管 SDK 的自治 loop** | Soul 已有真·多 provider 多轮 loop（`chatStore.ts:4813`）。接管 = 接受 Anthropic-only 驱动，正是多 provider 硬阻碍。**借缺的旋钮（预算/压缩），不借 loop 本身。** |
| **把 Anthropic `cache_control` 断点当跨 provider 缓存抽象** | ephemeral 断点是 Anthropic 专有；openai-compat 靠前缀稳定缓存（DeepSeek `prompt_cache_hit_tokens`）。Soul 的 stable/dynamic system-prompt 拆分（`soul-loader.ts:678`）已映射到两边。把断点 API 当抽象会把 Anthropic 语义泄漏进 DeepSeek/Qwen/Ollama 路径。segmented-builder 保持为 Claude-only 优化即可。 |
| **内置文件/编码工具（Read/Write/Edit、Glob/Grep、Bash）** | Soul 是知识/分身桌面 app，工具集是策展且权限门控的（search_knowledge/query_excel/generate_document/task），不是编码 agent。给终端用户分身开 Bash/Edit 是范围与安全错配；`tool-router.ts:1252` 的硬编码 switch 是刻意最小权限。 |
| **每个自定义工具包成进程内 MCP server（`tool()`/`@tool` + `mcpServers`）** | ToolRouter 硬编码 switch 已能用，且 Soul 已有 MCP passthrough（`list_mcp_tools`/`call_mcp_tool`）。给本地函数调用再套 MCP 序列化/注册层无收益。 |
| **`bypassPermissions` 权限模式** | 面向终端用户桌面 app，一个关掉全部 deny/ask 的模式很危险，会架空整个 guardrail/permission-enforcer（BR-3）。保留 default/acceptEdits/plan，不暴露全局 bypass。 |

---

## 3. 执行顺序

**P0 先做**（隔离、高安全、依赖现成数据/模块）：
1. **BR-1 预算上限** — 近乎独立的增量，建在现成轮上限 + cost-tracker 上，即刻买到成本安全。
2. **BR-2 摘要 compaction** — 用已建成的 `summarizer.ts` 硬化脆弱的一次性溢出重试。

**P1 先建地基再挂策略**：
3. **BR-5 Hook 总线（先）** — 后面全插在它上：权限=PreToolUse、压缩归档=PreCompact、观测=PostToolUse/Stop。
4. **BR-3 权限 enforcer（PreToolUse，加 ASK）** + **BR-6 typed 子 agent + SpawnGuard** — 纯 policy、低 provider 风险。
5. **BR-4 并行读** — 独立延迟优化，P1 内任意时点可插。

**P2 整合/锦上添花**：
6. **BR-7 typed 观测**（BR-1 的上限随后可读它）→ **BR-8 渐进工具披露**（按模型档位门控）→ **BR-9 会话 fork**。

依据：每阶段为下阶段去风险——hooks 先于 permissions；归一化 usage 先于精确预算上限；无 P2 阻塞真·loop 缺口。

---

## 4. 待确认问题（落地前需拍板）

1. `activeBehaviorModeIds` / `activeGuardrailIds` 在**哪里按 avatar 解析**？（expert-pack.json？skill-index.yaml？settings？）BR-3 的 rule 输入与 BR-5 的钩子注册都需要知道。
2. `cost-tracker.ts` 是否对所有在售 DeepSeek/Qwen 模型有完整定价行（Ollama/本地为合理 0）？BR-1 精度依赖它。
3. gateway `RunPlan`（`buildAgentGatewayRunPlan`，热路径）是**纯遥测**还是有下游消费其 detected-guardrails？若已治理执行，BR-3 应扩展它而非另起一条权限管线。
4. compaction（BR-2）与预算上限（BR-1）是否也覆盖**子 agent 跑**（SubAgentManager 30s race）？子 agent 现有超时但无 cost/context 记账。
5. compaction（BR-2）跨 provider 该信哪个 **token 计数源**——本地估算器（tiktoken 式）还是各 provider 上报 usage？usage 只在一轮后才知，主动触发很可能需要本地预估。
6. `agent_type` DB 列（BR-6）是否有下游读者（sync/UI/eval），还是接线 TypedSubAgentManager 纯增量、无需 schema/消费方协调？
