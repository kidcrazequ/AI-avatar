# 飞书适配器构建规格（⑦ 第一个真实适配器）

soul 是 Electron 桌面 app。**飞书选长连接（WebSocket）模式**：bot 主动拨出连飞书、事件从长连接推下来，**不需要公网 URL**，正适合桌面。（企微收消息主要靠回调 webhook，需公网可达 URL → 桌面端 NAT 后收不到，除非配公网中转，本规格不含。）

## 架构：薄桥复用 proxy

飞书适配器 = 主进程一个模块，**复用已有 proxy-server 的无头发送链路**，不碰渲染层/核心 sendMessage：

```
飞书群消息
   │  im.message.receive_v1（长连接推下来）
   ▼
[飞书适配器·主进程]  lark.WSClient + EventDispatcher
   │  转成 Anthropic /v1/messages 请求
   ▼
soul proxy-server（127.0.0.1:18888，已存在）
   │  run-request → 渲染进程 sendMessage → SSE 回流
   ▼
[飞书适配器] 收齐回复文本
   │  lark client.im.message.reply()
   ▼
飞书群（分身回复）
```

为什么走 proxy HTTP 而不是直接 run-request：隔离、复用现成鉴权/协议、适配器完全自包含、proxy 挂了不影响 UI。

## 你需要在飞书侧做的（前置，代码测不了这步）

1. [开放平台](https://open.feishu.cn) 创建**企业自建应用** → 拿 `App ID` / `App Secret`。
2. 开权限：`im:message`（收发消息）、`im:message.group_at_msg`（群里被 @ 收消息）等。
3. 事件订阅 → **选「使用长连接接收事件」** → 订阅 `im.message.receive_v1`。
4. 把机器人加进一个测试群，@ 它发消息。

## 依赖 + 构建约束

- SDK：`@larksuiteoapi/node-sdk`（纯 JS，`lark.WSClient` / `lark.EventDispatcher` / `client.im.message`）。
- 装：`npm i @larksuiteoapi/node-sdk`；在 `build-electron.js` 里**externalize**（同 better-sqlite3 等 node 依赖，不进 esbuild bundle）。
- 跑在**主进程**（长连接生命周期 + 拨出网络）。

## 代码模块（signatures）

`desktop-app/electron/feishu-adapter.ts`：
```ts
export interface FeishuAdapterDeps {
  getDb: () => { getSetting: (k: string) => string | undefined }
  proxyBaseUrl: string        // http://127.0.0.1:<proxy_server_port>
  proxyToken: string          // proxy 鉴权 token
  logger?: Logger | null
}
export function startFeishuAdapter(deps: FeishuAdapterDeps): void  // 读 feishu_enabled，未开则跳过
export function stopFeishuAdapter(): void                          // 关长连接
```
内部：
- `new lark.WSClient({ appId, appSecret })` + `EventDispatcher.register({ 'im.message.receive_v1': onMessage })` + `wsClient.start(...)`。
- `onMessage`：解析 text → `fetch(proxyBaseUrl + '/v1/messages', {Anthropic 格式, Authorization: proxyToken})` → 收 SSE/JSON → 拼回复 → `client.im.message.reply({ message_id, content })`。
- 会话映射：飞书 `chat_id` ↔ soul conversation（用 `x-soul-conversation-id` 头，proxy 已支持）。
- 幂等/去重：飞书事件可能重推，按 `message_id` 去重。

## 配置（settings keys）

`feishu_enabled` / `feishu_app_id` / `feishu_app_secret` / `feishu_bound_avatar`（哪个分身应答）。Settings UI 一个「飞书机器人」页（同工具集成那批开关的写法）。**这些 key 由适配器读，不做死 UI**——适配器和 UI 同一 PR 落，避免"开关无效"。

## 分期（每期可独立验证）

- **P-a**：settings keys + UI + `startFeishuAdapter` 骨架（读配置、日志、生命周期 start/stop 挂到 app ready / 设置变更）。**可验证**（不连飞书也能起停、日志正确）。
- **P-b**：接 SDK 长连接 + `onMessage` → 打 proxy → 收回复 → reply。**需你的飞书应用联调**（收发真实消息）。
- **P-c**：会话映射、去重、重连、@ 触发过滤、错误/限流处理。
- **P-d（可选）**：把"驱动 proxy 收全回复"抽成 `runViaSoulProxy()`，未来别的适配器（Discord/Telegram 长连接类）复用 → 落成正式 `MessageSource`。

## 现在就能做 vs 需要你

- **我现在能做**：P-a（settings + 骨架 + proxy 调用 helper），SDK 无关、可 typecheck/lint 验证。
- **需要你**：飞书侧建应用（上面 4 步）→ 给我 app_id/secret（或你本地填设置）→ 我写 P-b 并和你联调真实收发。

> 诚实边界：P-b 起没有你的飞书应用 + 网络就无法端到端验证；不联调硬写 SDK 代码只是"看着像对"。
