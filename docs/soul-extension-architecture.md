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

- **P0 · 管线双半边**（✅ 已落地）：pre + post message stages，soul 自己的护栏/palace/记忆/情景已注册进去。这是钩子地基。
  - **重要澄清**：pre-message 管线（LLM 前改 systemBlocks/content、可短路）≈ `on_llm_request`；post-message 管线（回复后）≈ `on_llm_response` 的会话级等价。**消息粒度的 LLM 请求/响应钩子，P0 已覆盖。**
- **P1 · per-round 钩子（⑧·低优先，暂缓）**：在工具循环里每轮 LLM 调用前后的钩子。**降级为暂缓**——它深缠在流式 `runRound` 闭包里、无现成 soul 行为可迁、且少有插件需要每轮拦截；现在加 = 造没消费者的投机基建。**待某个具体插件确实需要每轮拦截时再做。**
- **P2 · MessageSource 接口（⑦地基）**：把 proxy-server 重构成第一个正式 `MessageSource`，UI 为第二个。**注意**：只有一个真实非 UI 适配器（proxy）时，这个接口也偏投机——最好由"要接第一个 IM 平台"驱动设计（有真实客户端才能把接口设计对）。
- **P3 · 插件加载器（⑧）**：从 `plugins/` 发现并加载扩展、注册进钩子；隔离/热重载/metadata（借鉴 AstrBot `Star.__init_subclass__` + watchfiles，需先定"Electron 里代码插件跑在哪、安全边界"）。
- **P4 · IM 适配器（⑦）**：QQ/微信/飞书 各实现 `MessageSource`，接 P2。每平台一期。

## 关键工程原则：先有扩展、再造扩展点

P0 之所以非投机，是因为它**迁移了 soul 已有行为**（palace/记忆），有真实内容。P1/P2 及以后若在**没有具体消费者**时先造钩子点/接口，容易把接口设计错（有真实客户端才能设计对）。因此**下一步不该是继续造空基建，而是选一个具体消费者端到端做出来**——它自然会把 P1/P2 的设计逼成对的。

## 原则
- 对齐 AstrBot AGENTS.md 的 KISS/inline-first：只在接缝处解耦，stage/hook 内部保持内联；不为"将来可能用"提前造投机字段。
- soul 更强的地方不动（soul.md 人格、palace、精读、数据溯源红线）。
- 每期独立可验证、独立提交；P3/P4 是大期，各自再拆。
