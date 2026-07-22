# AstrBot 借鉴落地路线图

借鉴对象：AstrBot（github.com/AstrBotDevs/AstrBot）。本文只吸收对 soul（单用户 Electron AI 分身桌面端）有实际价值、且与其形态契合的架构，不引入 AstrBot 本体或 IM-bot 的耦合假设。

排除项：⑥知识库稠密向量 + RRF 混合检索——与 soul「BM25 pre-message 刻意选择、去 pre-message RAG 是未来方向」的既定路线冲突，本轮不做（见 memory `soul-rag-architecture-direction`）。

## 为什么要做（当前病灶）

`chatStore.sendMessage` 单函数 **3004 行**（3481–6485），把边界护栏 / 澄清闸门 / palace 召回 / 记忆复盘 / 图表强制 / 上下文压缩等约 91 处关注点全焊死在一起。每加一个行为都要在其中"找缝插针"（本轮 A/B/C 就是活证据）。① 的管线化是解开这一切的地基。

## 依赖顺序（关键）

```
① 消息管线 + 钩子（地基）
   ├─ 解耦出 AgentRunner 接口 ──► ② agent 循环硬化
   │                              ├─► ④ provider 抽象升级
   │                              └─► ⑤ LLMOps 平行 runner（Dify/Coze/百炼）
   ├─ 暴露生命周期钩子 ──────────► ⑧ 代码插件系统
   └─ 独立 stage ────────────────► ③ agent 沙箱（作为工具后端接入）
⑦ 无头 core + IM 适配（最大、最独立，可并行立项）
```

## 分期

### 阶段 1 — 管线地基（①） + agent 循环补丁（②）  ← 先做
- **1a**：新建 `message-pipeline` 原语——`MessageStage` 接口、流动的 `MessageContext`、带 `stop()` 短路的有序 runner（抄 AstrBot `scheduler.py` 洋葱模型 + `event.stop_event()`）。
- **1b**：把**LLM 调用前的拦截器**（边界护栏 / 澄清闸门 / palace 召回 / memory nudge）从 `sendMessage` 内联迁成有序 `preMessageStages`。低风险、可单测、立刻验证模式。
- **1c**：补 agent 循环缺失的鲁棒性（对照 AstrBot `ToolLoopAgentRunner`）：达轮数上限拔工具 + 强制收尾提示、provider fallback 链、重复调用递进警告（缺哪补哪，打补丁级）。
- 验收：preMessageStages 有单测；发送链路行为不回归（A/B/C 仍生效）；typecheck/lint 干净。

### 阶段 2 — 抽出 AgentRunner + provider 抽象（②④）
- 把 `sendMessage` 里的"LLM→工具→再 LLM"循环抽成 `AgentRunner`（`step()/step_until_done()` 状态机，抄 `BaseAgentRunner`），provider 与 tool-executor 用注入解耦。
- provider 抽象升级：跨厂商工具 schema 转换成层；`skills_like` 轻 schema 二段式（省 token，契合 soul 多技能）；STT/TTS 作为一等 provider 类型（为语音分身铺路）。

### 阶段 3 — agent 沙箱（③）
- 抄 `ComputerBooter` 抽象 + 会话级复用；桌面端先做**受限子进程后端**（超时/目录限制/黑名单，比 AstrBot local 更严），后端可换。给财研/小堵一个隔离的"跑代码/数据分析"能力。

### 阶段 4 — LLMOps 平行 runner（⑤）
- Dify/Coze/百炼 作为实现同一 `AgentRunner` 接口的平行 runner（抄 `third_party.py` 按 `agent_runner_type` 分派），让高级用户用自己的工作流驱动一个分身。

### 阶段 5 — 代码插件系统（⑧）
- `Star` 式基类 + 自动注册 + metadata + 热重载 + 幂等重绑；插件可挂 ① 暴露的生命周期钩子（`on_llm_request/response` 等），不改内核扩展行为。补 soul 现有 markdown 技能之不足。

### 阶段 6 — 无头 core + IM 适配（⑦，最大，独立立项）
- soul 已有 proxy/widget server，离"把分身暴露成 QQ/微信/飞书机器人"不远。抄 AstrBot 的平台适配器抽象 + 事件总线。这是产品级方向，单独排期。

## 原则（抄 AstrBot 的 AGENTS.md）
KISS + inline-first：**只在架构接缝处解耦（管线 stage / runner），stage 内部保持内联**。不要把 3004 行拆成一堆碎 helper。soul 更强的地方（soul.md 人格、palace、精读管线、数据溯源红线）不动。
