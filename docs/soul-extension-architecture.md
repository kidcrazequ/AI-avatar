# Soul 统一扩展架构（⑦ 适配器 与 ⑧ 插件 同构）

借鉴 AstrBot：平台适配器与插件不是两套东西，而是**同一套扩展架构**——适配器把消息喂进同一条管线，插件挂在同一批生命周期钩子上。本文定义 soul 把 ⑦（IM 适配器）与 ⑧（代码插件）收敛成一套的目标与分期。

> ⚠ 形态提示：这是把 soul 从「桌面单机分身工作台」推向「可部署、可扩展的分身平台」的**产品级 pivot**，不是单纯工程任务。请确认方向后再逐期推进。

## 一张图

```
 ┌─────────── 适配器（⑦，消息来源） ───────────┐
 │  UI(ChatWindow) · proxy-server(HTTP/SSE) ·  │
 │  未来：QQ / 微信 / 飞书 …                     │
 └───────────────────┬─────────────────────────┘
                     │ 统一 MessageSource 接口
                     ▼
 ┌──────────────── 管线（核心） ────────────────┐
 │  pre-message stages（护栏/澄清/palace/…）    │  ← 短路 outcome
 │        → LLM / 工具循环                       │
 │  post-message stages（记忆复盘/情景抽取/…）   │  ← fire-and-forget
 └───────────────────┬─────────────────────────┘
                     │ 生命周期钩子点
                     ▼
 ┌─────────── 插件（⑧，行为扩展） ──────────────┐
 │  注册进 pre/post/LLM 钩子；不改内核扩展行为    │
 └─────────────────────────────────────────────┘
```

**一致点**：适配器和插件都围绕**同一条管线 + 同一批钩子**。加一个 IM 平台 = 实现一个 MessageSource；加一个行为扩展 = 注册进钩子。二者共用中间的 pipeline，互不重复造。

## soul 已有的三颗种子（不是从零）

1. **适配器种子**：`proxy-server.ts`（`registerSoulProxyIpcHandlers`）—— HTTP API + SSE 流式，已能**无头驱动分身**（`run-request` → sendMessage(proxyOpts)）。即 soul 的第一个"非 UI 适配器"。UI(ChatWindow) 是第二个适配器。
2. **管线种子**：`message-pipeline.ts` —— 已有 pre-message（短路 outcome：护栏/澄清/palace）+ **post-message（fire-and-forget：记忆复盘/情景抽取，本次落地）** 两半。
3. **钩子种子**：`agent-runtime/hooks/`（`HookRegistry` / `HookPoint.POST_TOOL_USE`，tool-router 已 `setHooks`/fire，SOUL_USE_NEW_RUNTIME 门控）—— 工具级钩子已在。

## 分期

- **P0 · 管线双半边**（✅ 本次）：pre + post message stages 落地，soul 自己的护栏/palace/记忆/情景已注册进去。这是钩子地基。
- **P1 · 补钩子点（⑧核心）**：加 `on_llm_request` / `on_llm_response`（改 ProviderRequest / LLMResponse），与已有 `POST_TOOL_USE` 合成一套完整生命周期钩子。soul 自身行为继续内聚进钩子（内部可组合、可开关）。**非投机、纯收益**。
- **P2 · MessageSource 接口（⑦地基）**：把 proxy-server 重构成第一个正式 `MessageSource`，UI 为第二个；`source` 进入管线上下文，stage 可按来源分流（如 IM 无卡片 UI → 跳过澄清）。
- **P3 · 插件加载器（⑧）**：从 `plugins/` 发现并加载扩展，注册进 P1 的钩子；隔离/热重载/metadata（借鉴 AstrBot `Star.__init_subclass__` + watchfiles，但需解决"Electron 里代码插件跑在哪、安全边界"）。
- **P4 · IM 适配器（⑦）**：QQ/微信/飞书 各实现 `MessageSource`，接 P2 接口。每个平台一期（SDK/webhook/鉴权/消息转换/会话映射）。

## 原则
- 对齐 AstrBot AGENTS.md 的 KISS/inline-first：只在接缝处解耦，stage/hook 内部保持内联；不为"将来可能用"提前造投机字段。
- soul 更强的地方不动（soul.md 人格、palace、精读、数据溯源红线）。
- 每期独立可验证、独立提交；P3/P4 是大期，各自再拆。
