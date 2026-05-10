# LangBot ↔ Soul 对接说明书

> **作者**：zhi.qu  
> **日期**：2026-05-09  
> **配套主计划**：`.cursor/plans/对手对比融合执行计划_2026-05.plan.md` §4.7  
> **适用版本**：Soul Desktop（Electron）2026-05-09 之后；LangBot 任意支持 Anthropic 兼容 provider 的版本  
> **读者**：想用 LangBot 把 Soul 分身接入飞书 / 企微 / Discord / Slack / 钉钉 / Telegram 等 IM 的运维或开发者
>
> **核心约定（Soul 侧）**：  
> Soul 不在仓库内实现任何 IM 平台的 Adapter。任何 IM 平台的对接都通过 **LangBot 作为入站编排器** → 调用 Soul 的 **`POST /v1/messages`**（Anthropic 兼容 Proxy）→ Soul 内部走 `chatStore.sendMessage`（与 UI 同源工具循环、同源权限 `trustTier: 'proxy'`）。

---

## 0. 30 秒预览：能做什么

```
┌─────────────┐   IM 消息    ┌──────────┐  HTTP /v1/messages  ┌─────────────────┐
│ 飞书 / 企微 / │ ──────────→ │ LangBot   │ ───────────────────→│ Soul Desktop     │
│ Slack / Disc │             │ (容器/进程)│                     │ (Electron + UI) │
│  ord / 钉钉  │ ←────────── │           │ ←─────────────────  │  分身 / 工具 /   │
└─────────────┘   IM 回复    └──────────┘   Anthropic SSE      │  知识 / 权限     │
                                                                └─────────────────┘
```

- **Soul 不感知 IM 平台**，只暴露一个 Anthropic 兼容的本机 HTTP 接口
- **LangBot 不感知 Soul 内部细节**，只把它当成一个本机 Anthropic provider
- **工具调用 / 知识检索 / 权限审批 / 审计日志全部在 Soul 内闭环**，与桌面 UI 完全同源（参见主计划 §4.6 / §4.9 / `tool-permission-policy`）

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| Soul Desktop | 已安装并能正常启动 UI；2026-05-09 之后版本（含 Proxy + Permission Mode + 双写） |
| LangBot | 任意能配置「自定义 Anthropic provider base URL」的版本；如不支持自定义 Header，需配合「侧车反代」（见 §6.2） |
| 网络拓扑 | LangBot 与 Soul 在**同一台机器**，或 LangBot 能通过本机回环 / 内网 / SSH 隧道访问 Soul 的 `127.0.0.1:18888` |
| 鉴权材料 | Soul 设置内**手动生成**的 `proxy_api_token`（Bearer Token） |
| Soul 会话 ID | LangBot 调用前必须知道目标会话的 Soul 内部 `conversationId`（由 Soul UI 创建会话后从设置/对话面板拷贝）|

> **重要**：Soul Proxy **仅监听 `127.0.0.1`**，不会绑定到 `0.0.0.0`。如果 LangBot 跑在另一台机器，必须自行通过 frp / ngrok / SSH 隧道暴露，**Soul 不内置任何远程暴露能力**（避免误把本地 LLM 暴露到公网）。

---

## 2. Soul 端配置（5 步）

### 2.1 启动 Soul Desktop

正常启动 UI；Proxy 默认**关闭**（opt-in）。

### 2.2 进入「设置 → Proxy API（Cursor / Claude Code）」

设置面板代码位置：`desktop-app/src/components/SettingsPanel.tsx`「Proxy API」区块。  
持久化键（写入 `settings` 表）：

| Setting Key | 含义 | 默认值 |
|---|---|---|
| `proxy_server_enabled` | 是否启用 Proxy（`'true'` / `'false'`） | `'false'` |
| `proxy_server_port` | 监听端口（1–65534） | `18888` |
| `proxy_api_token` | Bearer Token（启用时必填） | （空） |

### 2.3 生成 Token

点击「生成 Token」按钮（IPC：`proxy-api-generate-token`）→ 自动填入 Token 输入框；**复制并妥善保管**，丢失只能重新生成。

### 2.4 保存设置

点击「保存 Proxy 设置」按钮：

- 保存后**必须重启 Soul** 监听才会生效（保存按钮提示语：`SAVED — 重启应用后端口与监听生效`）。
- 重启后日志（`logs/main-*.log`）应出现：  
  `[soul-proxy] listening http://127.0.0.1:18888/v1/messages (方案 A → renderer sendMessage)`

### 2.5 准备一个会话用于 LangBot

在 Soul UI 内**先手动创建**一个会话（选好分身、必要时绑定 Project）；记下其 `conversationId`：

- 渠道一：UI 侧边栏右键 → 复制会话 ID（如已实现）
- 渠道二：直接读 SQLite `userData/xiaodu.db` 表 `conversations`，按 `created_at` 取最新一行
- 渠道三：让 Soul 在生成 Token 同时打印一个示例 `conversationId`（见 §8 FAQ）

> 当前版本 **没有「按 IM 频道 ID 自动映射 conversationId」**的能力。映射策略放在 LangBot 配置层完成（即每个 IM 群/频道在 LangBot 配置内固定指向一个 Soul 会话 ID）。详见 §6.1。

---

## 3. HTTP 接口规约（Soul 侧契约）

### 3.1 健康检查

```http
GET /v1/health           HTTP/1.1
Host: 127.0.0.1:18888
```

响应：

```json
{ "ok": true, "service": "soul-proxy", "bind": "127.0.0.1" }
```

> 用于 LangBot / 监控判断 Soul 是否在线。**不需要鉴权**。

### 3.2 主接口：`POST /v1/messages`

```http
POST /v1/messages                              HTTP/1.1
Host: 127.0.0.1:18888
Authorization: Bearer <proxy_api_token>
Content-Type: application/json
x-soul-conversation-id: <conversationId>
anthropic-version: 2023-06-01            ← 任意值，Soul 不做严格校验
```

**请求体**（与官方 Anthropic Messages API 形态兼容）：

```json
{
  "model": "soul-chat",
  "stream": true,
  "messages": [
    { "role": "user", "content": "帮我看一下 280Ah 储能电芯和 315Ah 的能量密度对比。" }
  ]
}
```

**Soul 端实际行为（重要、与官方 Anthropic 有差异）**：

| 字段 | Soul 行为 |
|---|---|
| `model` | **仅作为响应的展示标签**（`message.model`），**不切换** Soul 内真实 Provider；真实模型由 Soul UI 当前会话的设置决定 |
| `stream` | `true` → 返回 Anthropic SSE；`false` → 返回单次 JSON。两种模式都受同样的工具循环约束 |
| `messages` | Soul 仅取**最后一条 `role=user` 的 text 块文本**作为本轮输入。**多轮历史无效**（Soul 内部历史以 `conversationId` 对应的 SQLite 为准）。`tool_result` / `image` 等非 text 块会被拒绝（`暂不支持非 text 的 user 内容块`） |
| `system` / `tools` / `tool_choice` | **被忽略**。Soul 的 system prompt / 可见工具 / 工具选择策略由 SoulLoader + Plan/Ask/Agent mode + ISS 重排自动决定 |
| 多轮 tool_use 协议 | **不暴露**到 HTTP；工具调用全部在 Soul 内闭环。HTTP 上看到的只有最终 assistant 文本 |

### 3.3 SSE 响应（`stream: true`）

Soul 发送的事件（顺序）：

1. `message_start` — 含 `message.id` / `message.model`（= 请求里的 `model` 标签）/ 空 content
2. `content_block_start` — index 0，type=`text`
3. `content_block_delta` ×N — 每段 `text_delta`（由 `chatStore.sendMessage` 的 `onProxyComplete` 触发；当前实现为**整段一次性返回**而非逐 token，未来可能演进）
4. `content_block_stop` — index 0
5. `message_delta` — `stop_reason: 'end_turn'`
6. `message_stop`

> **当前限制**：SSE 流并非真正的"逐 token 流式"，工具循环结束后整段 assistant 文本会一次性写出。LangBot 侧若依赖渐进式打字效果，会看到"卡一下，然后整段出现"。这是 §4.7「方案 A」的已知妥协，与桌面 UI 体感一致。

### 3.4 非流响应（`stream: false`）

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "<assistant 整段文本>" }],
  "model": "<请求中的 model 标签>",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 0, "output_tokens": <length / 4 估算> }
}
```

> `usage` 是**估算值**，不是真实 token 计数。如果 LangBot 用 usage 做计费，请在 LangBot 侧另行核算。

### 3.5 错误码

| HTTP | 错误体 | 触发条件 |
|---|---|---|
| 400 | `{"error":"missing_header","message":"必须提供请求头 x-soul-conversation-id..."}` | 缺 `x-soul-conversation-id` |
| 400 | `{"error":"bad_body","message":"<原因>"}` | body 读取失败 / 超过 8MB |
| 400 | `{"error":"invalid_json"}` | body 非合法 JSON |
| 401 | `{"error":"invalid_token","message":"Authorization: Bearer 与设置中的 Proxy Token 不一致"}` | Bearer 缺失或不匹配 |
| 404 | `Not Found` | 路径不是 `/v1/messages` 也不是 `/v1/health` |
| 500 | `{"error":"dispatch_failed","message":"<原因>"}` | IPC 转发到渲染进程失败 |
| 500 | （SSE 内 `event: error`） | 渲染进程链路失败（`renderer_unavailable` / 会话不存在 / `isLoading` 冲突 等）|
| 503 | `{"error":"proxy_api_token 未配置"}` | Token 未在设置内填写 |
| 503 | `{"error":"renderer_unavailable"}` | Soul 主窗口不存在或已销毁（启动中/已退出）|
| —   | （桥接层）`Soul 正有一条对话进行中（isLoading），请稍后再试 Proxy 请求` | UI 当前正在处理一条消息；**单会话串行**，需要 LangBot 侧排队/退避 |
| —   | （桥接层）`会话不存在: <id>` | `x-soul-conversation-id` 在 SQLite 中查不到 |

---

## 4. LangBot 端配置（推荐路径）

### 4.1 首选：把 Soul 当成"本机 Anthropic provider"

在 LangBot 的「Provider / Model 配置」中：

| LangBot 配置项 | 值 |
|---|---|
| Provider 类型 | `Anthropic` / `Claude` |
| API Base URL | `http://127.0.0.1:18888`（不带 `/v1/messages` 后缀，路径由 SDK 拼） |
| API Key | Soul 设置里生成的 `proxy_api_token`（LangBot 内填写到对应 Anthropic key 字段） |
| 模型名 | 任意（如 `soul-chat`、`claude-soul-bridge`），**仅作展示**，Soul 不据此选模 |
| 自定义 Header | **必须**追加 `x-soul-conversation-id: <Soul 会话 ID>` |

### 4.2 极简 `curl` 验证（推荐先用 curl 走通再配 LangBot）

健康检查：

```bash
curl -s http://127.0.0.1:18888/v1/health
# 预期：{"ok":true,"service":"soul-proxy","bind":"127.0.0.1"}
```

非流式（最简单）：

```bash
curl -s -X POST http://127.0.0.1:18888/v1/messages \
  -H "Authorization: Bearer <你的 proxy_api_token>" \
  -H "Content-Type: application/json" \
  -H "x-soul-conversation-id: <你的 Soul 会话 ID>" \
  -d '{
    "model": "soul-chat",
    "stream": false,
    "messages": [
      { "role": "user", "content": "帮我做一句话自我介绍" }
    ]
  }'
```

流式（验证 SSE）：

```bash
curl -N -X POST http://127.0.0.1:18888/v1/messages \
  -H "Authorization: Bearer <你的 proxy_api_token>" \
  -H "Content-Type: application/json" \
  -H "x-soul-conversation-id: <你的 Soul 会话 ID>" \
  -d '{
    "model": "soul-chat",
    "stream": true,
    "messages": [
      { "role": "user", "content": "讲个 50 字的笑话" }
    ]
  }'
```

---

## 5. LangBot 配置 UI 不支持自定义 Header 时的兜底（侧车反代）

如果你用的 LangBot 版本只能配置 `Authorization` 而**不能附加 `x-soul-conversation-id`**，请用一个极小的反代在 LangBot 与 Soul 之间注入 Header。两条推荐路径：

### 5.1 Caddy 一键反代（最简）

```caddyfile
:18889 {
    handle /v1/* {
        request_header x-soul-conversation-id "<固定的 Soul 会话 ID>"
        reverse_proxy 127.0.0.1:18888
    }
    handle /health {
        reverse_proxy 127.0.0.1:18888
    }
}
```

LangBot 把 API Base URL 指向 `http://127.0.0.1:18889` 即可。

### 5.2 LangBot 插件路径（理论，未实测）

LangBot 若提供「请求拦截/出站修改」类插件 API，可在插件内对**所有**出站到 `127.0.0.1:18888` 的请求注入 `x-soul-conversation-id`。**Soul 不维护此插件**，由 LangBot 用户自行编写或寻找现成插件。

> ⚠️ 不要把会话 ID 注入策略写进 Soul 仓库 — 这会逼迫 Soul 维护 IM 频道映射逻辑，违背 §4.7 边界。

---

## 6. 高级话题

### 6.1 IM 频道 ↔ Soul 会话 ID 映射策略

**Soul 不内置映射**。推荐两种模式：

| 模式 | 适用 | 落地方式 |
|---|---|---|
| **静态绑定** | 个人 / 小团队，每个 IM 群固定服务一个分身 | LangBot 侧配置：群 A → conversationId X，群 B → conversationId Y；用 §5 的 Caddy 多 location 或 LangBot 多 provider 实例 |
| **动态映射** | 多人多群、希望每群独立上下文 | 在 LangBot 侧维护 `imChannelId → conversationId` 映射表（KV / SQLite），首次接收消息时通过 Soul UI 或一个外置脚本预创建会话；超出本期范围 |

> 如果未来 Soul 真要内置「按 LangBot session ID 解析 conversationId」的能力，须按主计划 §4.7 子任务 3「（可选）会话映射辅助」单独立项，并在 `main.ts` / `database.ts` 加一张映射表 — **本期明确不做**。

### 6.2 单会话串行 / `isLoading` 冲突

`proxy-api-bridge.ts` 在收到 Proxy 请求时会先检查 `useChatStore.isLoading`：

```ts
if (useChatStore.getState().isLoading) {
  await api.soulProxyApiFinish(jobId, {
    error: 'Soul 正有一条对话进行中（isLoading），请稍后再试 Proxy 请求',
  })
  return
}
```

**含义**：

- Soul 单会话**串行处理**，UI 正在和 LLM 交互时，Proxy 请求会被立即拒绝（不排队）
- LangBot 侧需要**自行排队 / 指数退避**（建议 1s → 2s → 4s，最多 3 次）
- 如果一个 Soul 会话被多个 IM 群共用（不推荐），冲突频率会很高 → 改用「每群一个 conversationId」

### 6.3 工具调用与权限层（与 #7 同源）

LangBot 触发的请求会以 `trustTier: 'proxy'` 进入 Soul 工具循环（参见 `tool-permission-policy`）：

- **白名单工具**：直接执行
- **灰名单工具**：在 `proxy` trustTier 下**默认拒绝**（远程触达不弹窗审批）
- **黑名单工具**：硬拒绝
- **Plan mode**：blocked 工具集（`PLAN_MODE_BLOCKED_TOOL_NAMES`）在主进程被拒，与 UI 同源
- **审计**：所有工具调用写入 `logs/tool-calls/<date>.jsonl`，包含 `trustTier` 字段

> **预期可见的副作用**：在 IM 里让分身"删除文件 / 执行 shell"等灰名单操作，会失败并返回错误文案。这是设计如此（远程安全层），不是 bug。

### 6.4 知识检索 / 长期记忆 / Project 隔离

完全继承 Soul UI：

- 当前会话绑定的分身（avatar）+ Project（如有）→ 决定可见知识库
- `MEMORY.md` + `MEMORY.entries.json` 都会被注入（参见 §4.8）
- 引用溯源 `[来源: file#Lx-Ly]` 会出现在 assistant 文本里；LangBot 把它原样转发给 IM，IM 用户看到的是文本而非可点击 chip（chip UI 仅桌面渲染）

### 6.5 流式协议的退化模式

如果 LangBot 不支持 SSE 解析（极少见），改用 `stream: false`，Soul 会一次性返回 JSON。功能等价，IM 端只是失去打字效果。

---

## 7. Soul → LangBot 出站（Outbound）设计草案

> **状态**：本期**仅出设计稿**，**不写代码**。本节占位，等下次评审决定是否实施。

### 7.1 场景示例

- Soul 内分身在跑「夜间巡检」定时任务（#11 Scheduled Tasks），完成后想推送结果到飞书群
- Soul 内有人手动触发「分享给团队」按钮，希望分身的回复同步到 IM

### 7.2 设计草案（不进代码，仅命名占位）

| 配置键 / 接口 | 用途 | 备注 |
|---|---|---|
| `outbound_webhook_url`（settings） | LangBot 提供的入站 webhook URL | 由 LangBot 侧暴露；Soul 不实现 |
| `outbound_webhook_secret`（settings） | 共享密钥，Soul 出站时签名 | HMAC-SHA256(body, secret) |
| `outbound_retry_max`（settings） | 失败重试次数 | 默认 3 |
| `outbound_idempotency_header`（约定） | 幂等键 | `X-Soul-Idempotency-Key: <uuid>` |
| 出站载荷 | `{ conversationId, avatarId, kind: 'broadcast' \| 'task_result', text, metadata }` | 不含工具中间结果 |

### 7.3 不在出站做什么

- ❌ 不实现 IM 平台原生协议（飞书 webhook / 企微机器人 token 等）— 由 LangBot 维护
- ❌ 不与 Proxy（入站）共用 HTTP server — 即使要做，也用独立 HTTP 客户端 / 独立设置面板
- ❌ 不接管 Soul 内"工具调用过程"的实时推送 — 出站只发"最终结论"，不发中间帧

> **决策**：本节的实现拆到 follow-up；当前阶段如确需 Soul 主动推 IM，**临时方案**是 LangBot 侧定时拉 Soul（用 Proxy `POST /v1/messages` 拉一句"有什么新结果吗"），或者直接用 IM 平台的机器人 SDK 在 LangBot 内实现。

---

## 8. 明确不做项（与 §4.7 边界一致）

| 不做项 | 原因 |
|---|---|
| ❌ 在 Soul 仓库内实现飞书 / 企微 / 钉钉 / Discord / Slack / Telegram 等任何 IM Adapter | LangBot 已覆盖 12+ IM 平台，重复造轮子破坏 §1.4 战略（Provider Adapter 借力对手） |
| ❌ 在 `proxy-server.ts` 内增加第二条主对话 HTTP 协议（如 OpenAI `/v1/chat/completions` 兼容） | 单一 HTTP 语义原则；如必需 OpenAI 兼容，请走**独立侧车**（OpenAI → Anthropic 形态转发到本机 18888），**不**合并进 desktop-app |
| ❌ 在 Soul 内维护 IM 频道 ID → 会话 ID 的全局映射表 | 映射策略由 LangBot 维护；Soul 仅认 `conversationId`（参见 §6.1） |
| ❌ 把 Proxy 监听绑定到 `0.0.0.0` 或暴露到公网 | 本地 LLM / 知识 / 凭据安全层；远程暴露请用 frp / ngrok / SSH 隧道（运维侧负责） |
| ❌ 在 Proxy 上同步暴露多轮 Anthropic `tool_use` / `tool_result` 协议 | 工具循环在 Soul 内闭环；HTTP 上仅暴露最终 assistant 文本（与 UI 体感一致） |

---

## 9. 回归手工 Checklist（验收 #6 是否落地正确）

> 本期**无自动化测试**；以下 5 步是 LangBot 集成场景的人工 smoke 测试。每完成一项打勾。

- [ ] **步骤 1：Soul 启动 + Proxy 开**
  - 启动 Soul Desktop UI 正常进入
  - 设置 → Proxy API：勾「启用 Proxy 服务」+ 端口默认 18888 + 点「生成 Token」+ 保存
  - **重启** Soul，日志（`logs/main-*.log`）出现 `[soul-proxy] listening http://127.0.0.1:18888/v1/messages`

- [ ] **步骤 2：健康检查 200**
  - `curl -s http://127.0.0.1:18888/v1/health` 返回 `{"ok":true,"service":"soul-proxy","bind":"127.0.0.1"}`

- [ ] **步骤 3：非流式直连**
  - 在 Soul UI 内创建一个分身会话，记下 `conversationId`
  - 用 §4.2 的非流式 `curl` 命令调用，返回 200 JSON 且 `content[0].text` 非空
  - 在 Soul UI 切到那个会话，能看到刚才 LangBot 视角发的 user 消息和 assistant 回复（与桌面 UI 同源）

- [ ] **步骤 4：权限层（trustTier: 'proxy'）行为正确**
  - 在 user 文本里诱导触发灰名单工具（如让分身写文件 / 跑 shell）
  - 预期：assistant 回复里说"该操作在远程上下文被拒绝"或类似，**不**出现实际的副作用（不写文件、不执行 shell）
  - 检查 `logs/tool-calls/<date>.jsonl`，相关条目应含 `trustTier: 'proxy'` 且 `decision: 'denied'`（或同义字段，以 #7 实现为准）

- [ ] **步骤 5：LangBot 端到端**
  - LangBot 配置 Anthropic provider 指向 `http://127.0.0.1:18888` + Token + 自定义 Header（或 §5 Caddy 反代注入）
  - 在 LangBot 任意 IM 平台（飞书 / Slack 任选其一）@ 机器人发一句问题
  - IM 内看到 Soul 分身的回复（含引用溯源文本块）
  - Soul UI 同会话能看到对应的 user / assistant 历史

---

## 10. FAQ

**Q1：为什么 Soul Proxy 不像官方 Anthropic 那样支持完整多轮 `messages` 历史？**  
A：因为 Soul 的对话历史以 `conversationId` 对应的 SQLite 为准（含工具中间结果、知识检索引用、记忆等）。如果允许 LangBot 传完整历史，会和 Soul 内部历史出现不一致或绕过权限层。所以约定"LangBot 只传最后一条 user 文本，历史由 Soul 自管"。

**Q2：为什么 `model` 字段不切换 Soul 内真实模型？**  
A：Soul 的模型选择由分身 / 会话 / 用户偏好决定，LangBot 视角的 `model` 字段语义是"我希望走哪个 provider"，对 Soul 没有意义。保留它仅是兼容 Anthropic 协议形态。如果你需要让 LangBot 切换 Soul 的真实模型，请改 Soul UI 设置或开新会话，**不要**通过 HTTP `model` 字段绕过。

**Q3：`renderer_unavailable` 怎么解决？**  
A：Soul 主窗口被关闭或正在重启。重新打开 Soul UI 即可。如果你希望 Soul 后台常驻（关窗口不退出），请改 Soul 启动行为（与本任务无关，单独立项）。

**Q4：怎么从 SQLite 找到 `conversationId`？**  
A：

```bash
# macOS
sqlite3 ~/Library/Application\ Support/<Soul Bundle>/xiaodu.db \
  "SELECT id, avatar_id, title, created_at FROM conversations ORDER BY created_at DESC LIMIT 5;"
```

记下最近一条的 `id`。Windows / Linux 替换为相应 userData 路径。

**Q5：能否让多个 IM 群共用同一个 conversationId？**  
A：技术上可以，但不推荐：① 单会话串行（§6.2），并发会大量失败；② 多群上下文交叉污染分身判断。**推荐每群一个 conversationId**，在 LangBot 配置层映射。

**Q6：Soul 升级后 Proxy 协议会变吗？**  
A：本期协议形态以本文档 §3 为准。如未来调整，会在主计划 §4.7 追加版本号注释，并在本文档 § 0 顶部注明 break / non-break。LangBot 侧请固定到一个 Soul 版本测试通过后再升级。

**Q7：能否通过 Proxy 触发 Soul 的定时任务（#11）/ 跨设备同步（#16）？**  
A：不能，本接口只走对话语义。定时任务由 #11 实施时单独提供 IPC / 配置；跨设备同步由 #16 提供独立机制。Proxy **只做** Anthropic Messages API 兼容入口。

---

## 11. 修订记录

| 日期 | 版本 | 修改内容 | 作者 |
|---|---|---|---|
| 2026-05-09 | v1.0 | 初版（W14-#6 落盘）：Soul 端配置 / HTTP 接口契约 / LangBot 配置 / 侧车 Header 注入 / 出站设计草案 / 不做项 / 验收 checklist / FAQ | zhi.qu |
