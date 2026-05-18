# Agent Runtime 演进计划

> 把 Claude Code / Agent SDK 与 power-agent-platform（PAP）的架构经验吸收进 soul，
> 升级 `packages/core` 的 agent runtime 治理层，同时把文档解析重构为显式 pipeline。
>
> 不破坏现有桌面端，按 Phase 增量推进，每个 Phase 通过 feature flag 与旧路径并行。

---

## 1. 背景与目标

soul 现有 agent 架构已经覆盖 Claude Code 70% 的核心机制（tool-router、sub-agent-manager、skill-reranker、memory + life、conversation-router、MCP、tool-permission-policy、tool-budget 等）。

但相比 Claude Code 与 PAP，**缺的是机制层，不是模块**：
- 没有声明式 AgentBlueprint，soul.md / skill-index / 配置散落多处
- 没有 Hook 总线，CLAUDE.md 里"修改前先读"、"3 轮熔断"、"任务拆分"靠 LLM 自觉
- Prompt cache 未分段，pre-message RAG 把变化内容塞进前缀，cache 利用率低
- Sub-agent 同质化，没有类型 + 能力降级守卫
- 没有显式上下文压缩，长会话依赖手动新开
- 文档解析 1140 行一锅端，没有 pipeline / 一致性自检 / 学习笔记 / 产物布局规范

目标：用 6 个核心 Phase 把上述短板补齐，达到 Claude Code + PAP 的治理水位。

## 2. 借鉴来源

| 来源 | 借鉴内容 |
|---|---|
| Claude Code / Agent SDK | Hook 切入点、类型化 subagent、Plan Mode、Prompt cache 分段、上下文压缩、Slash command（仅理念） |
| power-agent-platform (PAP) | IdentityCard + AgentBlueprint、AgentLoop 内置治理、SpawnGuard、PermissionEnforcer 三态、AuditTrail、3 层 Memory、PromptRegistry、EvalHarness、A2A AgentCard、6 步 ingestion pipeline、双轨 Vision、一致性自检、学习笔记产物、产物布局规范 |

## 3. 概念映射表

| 新概念（借鉴） | soul 现有对应 | 差距 |
|---|---|---|
| AgentBlueprint（声明式） | soul.md + skill-index + 散落 config | 无统一 frozen 对象 |
| AgentLoop 内置治理 | tool-router 直跑 | 无统一 loop |
| Hook 总线（13 切入点） | — | 完全缺失 |
| 类型化 subagent + SpawnGuard | sub-agent-manager（同质 delegate） | 缺类型 + 能力降级守卫 |
| PermissionEnforcer 三态 | tool-permission-policy（二态） | 缺 ASK 态 + 通知接入 |
| AuditTrail | logger（散落） | 无结构化审计 |
| Prompt cache 分段 + PromptRegistry | prompt-builder（一次性拼） | 无分段 + 无版本化 |
| Plan Mode | — | 完全缺失 |
| 上下文压缩 | 提示用户新开会话 | 完全缺失 |
| Memory 3 层（short/episodic/semantic） | memory + life + structured-memory | 维度不同，需归一 |
| EvalHarness | batch-regression / test-runner / manual-qa | 未归一 |
| A2A AgentCard | — | 完全缺失 |
| 文档 ingestion 6 步 pipeline | document-parser.ts 1140 行一锅端 | 无 pipeline / 自检 / 学习笔记 |
| 双轨 Vision（OCR + caption） | 截图 → Vision 单轨 | 缺 OCR 独立 track |
| 产物布局（原文.md/_tables/_assets/学习笔记.md） | 直接塞 knowledge/ | 无分层契约 |

## 4. 通用约束

1. **新代码落在 `packages/core/src/agent-runtime/` 命名空间**，旧路径保持工作
2. **feature flag**：`SOUL_USE_NEW_RUNTIME`、`SOUL_USE_NEW_INGEST` 等，默认关
3. **每个 Phase PR diff ≤ 800 行**，超出必须拆
4. **任何 Phase 跑挂 desktop-app `npm run quality` 或 `test:qa-gate` → 立即回滚**
5. **Phase 之间松耦合**，可独立交付与回滚
6. **单 Phase 超期 50% 停下评估**

---

## 5. Phase 列表

### Phase 0 — 准备（0.5 天）

- 新建 `packages/core/src/agent-runtime/` 目录占位 + README 说明新旧并行策略
- 加 `SOUL_USE_NEW_RUNTIME` env flag，默认关
- **交付**：空目录 + README
- **验证**：desktop-app `npm run quality` 全绿
- **回滚**：删目录

### Phase 1 — AgentBlueprint 声明式定义（1-2 天，核心）

- 新增 `agent-runtime/blueprint.ts`：Zod schema 定义 IdentityCard / Permission / Budget / KBScope / ToolRef / SkillRef / MemoryPolicy
- `avatar-manager` 增加 `toBlueprint(avatarId)`：装配 soul.md + skill-index + knowledge config → frozen Blueprint
- 老路径不变，新路径 import Blueprint
- **交付**：`blueprint.ts` + `avatar-manager.toBlueprint` + 单测
- **验证**：9 个 expert-pack 全部 `toBlueprint` + Zod parse 通过
- **回滚**：删 `agent-runtime/blueprint.ts`，无影响

### Phase 2 — Hook 总线 + AuditTrail（2-3 天，核心）

- `agent-runtime/hooks/registry.ts`：13 个 HookPoint 枚举（PRE/POST_TOOL_USE、PRE/POST_LLM_CALL、ON_STOP、ON_HANDOFF、ON_SPAWN、ON_COMPACTION 等）+ 注册/触发 API
- `agent-runtime/audit-trail.ts`：JSONL 落盘到 `~/.soul/audit/<date>.jsonl`，复用 `conversation-jsonl-appender` 模式
- 改造 `tool-router.execute()` 前后插 fire(PRE_TOOL_USE) / fire(POST_TOOL_USE)
- 改造 `llm-service.call()` 前后插 fire(PRE_LLM_CALL) / fire(POST_LLM_CALL)
- 把 CLAUDE.md 里"修改前先读"、"3 轮熔断"实现成两个内置 Hook
- **交付**：Hook 系统 + 2 个内置 hook + audit JSONL
- **验证**：现有回归测试跑一次，audit 文件能复现完整 trace
- **回滚**：Hook 注册表清空

### Phase 3 — 类型化 subagent + SpawnGuard（1-2 天，核心）

- 扩展 `SubAgentTask`：增加 `agentType: 'explore' | 'plan' | 'worker'`
- 每种类型绑定 tool 白名单：Explore 只读 / Plan 无写工具 / Worker 继承父
- `agent-runtime/governance/spawn-guard.ts`：delegate 前检查子 permission ⊆ 父 permission
- 触发 `ON_SPAWN` hook
- **交付**：3 类型化子代理 + SpawnGuard + 测试
- **验证**：手动让 Explore 子代理尝试写文件 → 被拒
- **回滚**：`agentType` 默认 'worker'，老行为兼容

### Phase 4 — PermissionEnforcer 三态 + Plan Mode（2 天，重要）

- `agent-runtime/governance/permission-enforcer.ts`：DENY / ASK / ALLOW 三态
- ASK 走桌面端 toast 通知，复用 `schedule-trigger-handler` 的 IPC 通道
- 新增 `PlanMode`：进入后所有写工具临时 DENY，对应 Claude Code 的 EnterPlanMode
- 桌面端 UI 加 "进入计划模式 / 退出计划模式" 按钮
- **交付**：三态 PermissionEnforcer + Plan Mode + UI 按钮
- **验证**：Plan Mode 下让分身写文件 → 被拒并友好提示
- **回滚**：Plan Mode 默认关，PermissionEnforcer 退化为二态

### Phase 5 — Prompt cache 分段 + PromptRegistry（2 天，核心，立刻省钱）

- 改造 `prompt-builder.ts`：输出 4 段 + 每段带 `cacheable: boolean`
  - 段 1：soul.md + skill-index（永久 → cache_control）
  - 段 2：knowledge index 摘要（日级 → cache_control）
  - 段 3：RAG hits（每次变 → 不 cache）
  - 段 4：对话历史
- `llm-service.call` 转换 cacheable 标记为 Anthropic `cache_control: {type: 'ephemeral'}`
- `agent-runtime/prompts/registry.ts`：每段 prompt 有 id + version + body
- **交付**：分段 prompt + cache_control + PromptRegistry
- **验证**：对照测试，cache hit rate 提到 >50%（看 API 返回的 `cache_read_input_tokens`）
- **回滚**：PromptBuilder 走 legacy 分支

### Phase 6 — Memory 3 层归一（2-3 天，可延后）

- `agent-runtime/memory/{short_term,episodic,semantic}.ts`
- 映射现有：life → episodic（衰减实现）/ structured-memory → semantic / 对话窗口 → short_term
- 每层独立 TTL，配置来自 `Blueprint.memory_policy`
- **交付**：3 层抽象 + 现有 memory 迁移
- **验证**：life-density / life-forgetter 测试全绿
- **风险**：迁移面较大，放最后做

### Phase 7 — EvalHarness 归一（1-2 天，可延后）

- `agent-runtime/eval/{unit,integration,regression,benchmark}.ts`
- 收口 `batch-regression-runner` / `test-runner` / `manual-qa-scenarios` / `reference-simulation`
- 统一 `EvaluationStore` JSONL 输出
- **交付**：归一 EvalHarness + 入口脚本
- **验证**：`npm run test:qa-gate` 走新入口仍全绿

### Phase 8 — A2A AgentCard 暴露（1 天，可选）

- `IdentityCard.toA2A()` 序列化器
- desktop-app 起内嵌 HTTP server（复用 `widget-server.ts` 思路）暴露 `/.well-known/agent.json`
- **价值**：soul 分身可被外部 agent 平台（包括 PAP）发现和调用

### Phase 9 — 上下文压缩（1-2 天，核心）

- `agent-runtime/compaction/summarizer.ts`：监测 ConversationContext token 占用，超阈值（如上下文窗 80%）触发
- 压缩策略：保留 system + 最近 N 轮原文 + 中间段由 LLM 摘要替换
- 在 `chatStore` 和 `prompt-builder` 之间插入压缩层
- 触发 `ON_COMPACTION` hook（Phase 2 已预留枚举）
- 桌面端 UI 显示"已压缩 X 条历史"提示，允许查看原始
- **交付**：自动压缩 + UI 可见性
- **验证**：构造 200 轮长对话，压缩后仍能正确回答历史问题
- **回滚**：feature flag 关闭即回退

### Phase 10 — 文档解析 pipeline 重构（3-4 天，重要）

借鉴 PAP `pap/knowledge_ingest/` 的 6 步 pipeline，把 `document-parser.ts` 1140 行从「一锅端」重构为显式状态机。

子步骤：

1. 抽 `agent-runtime/ingest/pipeline.ts` 编排器（6 步状态机）
2. 拆 `agent-runtime/ingest/extractors/{pdf,word,excel,pptx,html,image}.ts`（保留现有 pdf-parse / mammoth / SheetJS / JSDOM 实现，不重写）
3. 新增 `agent-runtime/ingest/vision-track.ts`：Tesseract（tesseract.js）+ 现有 Vision LLM 双轨，结果并行落盘到 `_assets/`
4. 新增 `agent-runtime/ingest/consistency-checker.ts`：行数对齐、图片数对齐、页数对齐 → 不一致写 `_conflicts.md`
5. 新增 `agent-runtime/ingest/learning-notes.ts`：可选 LLM 学习笔记（validation_level A=单模型 / B=跨模型互校），接 `llm-factory`
6. 产物落盘到 `avatars/<id>/knowledge/<topic>/{原文.md, _tables/*.json, _assets/*, 学习笔记.md, README.md}`
7. 更新 `knowledge-indexer.ts` 适配新布局

6 步 pipeline 对应：
1. 确定性提取（无 LLM）
2. 图像处理（双轨）
3. 一致性自检（无 LLM）
4. 学习笔记（可选 LLM）
5. 产物落盘
6. 索引重建

- **交付**：新 pipeline + 老 parser 通过 adapter 兼容
- **feature flag**：`SOUL_USE_NEW_INGEST`
- **验证**：把 `testdocs/` 下样本文件跑一遍，新旧产出 diff 可解释；批量导入 300+ 文件场景压测通过
- **回滚**：flag 关闭
- **风险**：高——批量导入是用户重度使用面，必须并行验证一段时间再切默认值

---

## 6. 推荐执行路径

按"先解决治理 + 立即省钱 + 解决现有痛点"组合：

**核心路径（约 12-17 天）**：
Phase 0 → 1 → 2 → 3 → 5 → 9 → 10

跑完这条，soul 在 agent 治理 + 文档处理两个维度都达到 Claude Code + PAP 的水位。

**可延后**：Phase 4（Plan Mode UI 改动较大）、Phase 6（Memory 迁移面广）、Phase 7（Eval 归一非紧急）、Phase 8（A2A 暴露视外部诉求）。

总工作量：15-22 天。

---

## 7. 不照搬清单

| 来源 | 不照搬项 | 原因 |
|---|---|---|
| PAP | Temporal Workflow / k8s / Helm / Redpanda / gRPC | soul 是桌面单机 |
| PAP | dataaccess 多协议（Kafka/MQTT/SOAP/FIX） | 电力业务专属 |
| PAP | Sandbox 多 backend | Electron 已是隔离进程 |
| PAP | OTel / Langfuse | 现阶段 console + audit JSONL 足够 |
| PAP | EvolutionEngine | 自动进化太重，先把 Eval 跑稳 |
| PAP | `pap/knowledge/mcp_server.py` 暴露 KB 工具 | tool-router 直调更快，桌面端不需要跨进程 MCP |
| Claude Code | CLI/TUI 渲染层 | 已是 Electron + React |
| Claude Code | Skill frontmatter 关键词触发 | 你的 skill-reranker 向量召回对中文更对路 |
| Claude Code | Slash command 作为 prompt 模板入口 | 桌面端 UI 入口已覆盖 |

---

## 8. 反向：soul 可贡献给 PAP

PAP 目前是骨架阶段，soul 已实现的能力可反向贡献：

- `composite-knowledge-retriever` / `skill-reranker` / `rag-answerer`（PAP `knowledge/` 是空骨架）
- `tool-router` 的工具卡设计与具体工具实现（PAP `tools/` 是骨架）
- `document-parser.ts` 的 PDF 截图回退、Excel structuredData + 行角色识别、Word styleMap → Markdown（PAP `converters/` 多为占位）
- **IR + 三渲染器反向生成链**（docx / pdf / pptx）—— PAP 完全没有"agent 输出文档"路径
- `life` 衰减/生成机制（PAP `evolution/` 还在设计）
- preview/tweaks 系统

---

## 9. 风险与熔断

- 单 Phase 超期 50% → 停下评估是否继续
- 单 PR diff > 800 行 → 必须拆
- 任何 Phase 跑挂现有测试 → 立即回滚
- Phase 6（Memory 3 层）与 Phase 10（ingest 重构）是高风险点，必须并行运行旧路径至少 2 周再切默认值
- Hook 实现禁止在 hot path 做同步 IO（audit 写盘必须异步队列）
- Plan Mode UI 必须可见可退出，避免用户被卡死
- 上下文压缩必须保留原文可查看，避免摘要错误导致信息丢失

---

## 10. 验收标准（全 10 Phase 完成时）

- [ ] 任一分身可用 `avatar-manager.toBlueprint(id)` 装配成 frozen AgentBlueprint
- [ ] 任一 LLM 调用 / 工具调用都有 audit JSONL 记录
- [ ] Explore 子代理无法写文件，被 SpawnGuard 拒绝
- [ ] Plan Mode 下写工具被拒，UI 有清晰提示
- [ ] Prompt cache hit rate 在主要对话路径 > 50%
- [ ] 200 轮长对话不爆 token，自动压缩有 UI 可见提示
- [ ] 6 步 ingestion pipeline 跑通，产物按 `原文.md / _tables / _assets / 学习笔记.md` 布局
- [ ] 一致性自检发现的不一致写入 `_conflicts.md`
- [ ] `/.well-known/agent.json` 可访问（如做了 Phase 8）
- [ ] 现有 desktop-app `npm run quality` 与 `test:qa-gate` 全绿
