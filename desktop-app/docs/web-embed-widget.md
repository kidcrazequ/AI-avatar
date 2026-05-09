<!--
 Web Embed Widget 用户指南

 @author zhi.qu
 @date 2026-05-09
-->

# Web Embed Widget 用户指南

> **作者**：zhi.qu  
> **日期**：2026-05-09  
> **配套主计划**：`.cursor/plans/对手对比融合执行计划_2026-05.plan.md` §4.13  
> **适用版本**：Soul Desktop（Electron）2026-05-09 之后；任何能挂 `<script>` 的网页（个人博客 / 企业官网 / Notion 公开页 / Hugo / Jekyll …）  
> **读者**：想把 Soul 分身嵌入到自己网页的产品 / 内容创作者 / 运维  

---

## 1. 30 秒预览

Web Embed widget 让 Soul 分身可以嵌入到任何网页（个人博客、企业官网、Notion 公开页），访客在右下角的对话框里直接和分身对话；流量经鉴权代理后路由到本机 Soul，**不暴露任何 API token**、**不修改宿主页面 CSS**（Shadow DOM 隔离）、**不依赖外部 CDN**（widget bundle 由 Soul 本机托管）。

最终嵌入到网页里的代码长这样：

```html
<script src="http://localhost:3211/embed.js"
        data-embed-id="emb_1715257812345_abc123"
        data-server="http://localhost:3211"
        defer></script>
<soul-embed></soul-embed>
```

打开网页，右下角会浮现一颗气泡，点击展开对话框 → 输入 → 看到分身的流式回复。

```
┌─────────────────────────────┐                ┌──────────────────────────┐
│  myblog.com / Notion / etc. │  embed.js +    │  Soul Desktop (本机)     │
│                             │  fetch /api/.. │                          │
│   ┌────────────────────┐    │ ─────────────► │  widget-server :3211     │
│   │  访客与 widget 对话 │   │                 │      │  (鉴权 + Origin)  │
│   └────────────────────┘    │ ◄───────────── │      ▼                  │
│   (Shadow DOM 隔离 CSS)     │  Anthropic SSE │  proxy-server :18888    │
│                             │                │      │                  │
└─────────────────────────────┘                │      ▼                  │
                                                │  分身 / 工具 / 知识     │
                                                └──────────────────────────┘
```

---

## 2. 前置条件

| 项 | 要求 |
|---|---|
| Soul Desktop | 2026-05-09 之后版本（含 Proxy + Web Embed widget 子任务 1–4） |
| 分身 | 至少 1 个已创建并跑得通的分身（在 Soul UI 内能正常对话） |
| **Proxy API Server** | **必须先启用**（widget-server 透传到 proxy-server，proxy 关着 widget 一定 503） |
| `proxy_api_token` | 已在「设置 → TOOLS → Proxy API」配置（widget-server 服务端持有，前端不暴露） |
| Node.js | 用于构建 widget bundle，>= 18（仅首次 build 需要，运行时不依赖 Node） |
| 网络 | 仅嵌入到本机 / 局域网网页：无需公网；嵌入到公网网页：需 §4 Cloudflare Tunnel |

> **重要**：Web Embed widget 是**独立 HTTP 服务**（默认 `:3211`），不和 Proxy（`:18888`）共用端口。但底层对话能力依赖 Proxy —— Proxy 不开 widget 用不了。

---

## 3. 5 步上手（核心流程）

### 3.1 启动 widget-server

打开 Soul Desktop → **设置（Settings）→ TOOLS Tab → Web Embed widget 子区** → 点 **「启动服务」**。

启动后状态条显示 `RUNNING http://localhost:3211`。

| 设置项 | Setting Key | 默认值 | 说明 |
|---|---|---|---|
| 启用 | `widget_server_enabled` | `false` | 显式开关，opt-in（默认关） |
| 端口 | `widget_server_port` | `3211` | 1–65534；改完需点「重启服务」 |

> **隔离原则**：widget-server 与 proxy-server 是两个独立 HTTP server / 两个独立端口 / 两套独立鉴权（widget 用 `embed_id` + Origin 白名单 + 限流；proxy 用 Bearer Token）。互不影响开关。

### 3.2 build widget bundle（首次必做）

widget 前端是一个独立 Preact 包（位于仓库 `widget/` 目录），需先构建产物再让 widget-server 静态托管。**首次部署必须做这一步**；之后每次升级 widget 代码也需要重做。

```bash
cd /path/to/soul/widget
npm install
npm run build
# build 后产物：widget/dist/soul-embed.js（约 26KB minified / 10KB gzipped）

# 复制到 desktop-app 静态托管目录：
mkdir -p ../desktop-app/electron/widget-static
cp dist/soul-embed.js ../desktop-app/electron/widget-static/soul-embed.js
```

> **为什么手动 cp**：本期保留显式步骤让你掌控版本；未来若加 npm script 自动化（如 `npm run build:widget` 一键）会移除手工 cp 步骤。

### 3.3 创建第一个 Embed

回到 Soul 设置面板「Web Embed widget」子区，点 **「+ 新建 Embed」**：

| 字段 | 必填 | 说明 |
|---|---|---|
| 名称 | ✅ | 自己识别用的标签，如「我的博客」「公司官网」 |
| 分身 | ✅ | 从下拉选择；**一个 embed 静态绑定一个分身**（详见 §7 Q4） |
| Origin 白名单 | ✅ | 每行一个 origin，**严格字符串匹配**（见下方示例） |
| Rate Limit | — | 默认 30 次/分钟（范围 5–300，按 `embed_id × Origin` 独立计数） |
| Greeting | — | 欢迎语，最多 500 字；首次打开对话框时由 widget 直接渲染 |
| Enabled | ✅ | 勾选才生效 |

Origin 白名单示例：

```
http://localhost:3000
http://localhost:8080
https://myblog.com
https://www.myblog.com
```

> **严格匹配**：`https://myblog.com` ≠ `https://www.myblog.com` ≠ `http://myblog.com`，每一种实际访问 origin 都必须显式列出。**禁止** `*` wildcard（DAO 层硬阻断，保存会报错）。

保存后获得 **embed_id**，形如 `emb_1715257812345_abc123`，是公开值，用于把网页流量映射到这个 embed 配置。

### 3.4 复制嵌入码

在 embed 列表点 **「复制嵌入码」**，剪贴板里得到的模板：

```html
<script src="http://localhost:3211/embed.js"
        data-embed-id="emb_1715257812345_abc123"
        data-server="http://localhost:3211"
        defer></script>
<soul-embed></soul-embed>
```

字段含义：

- `src`：widget bundle 的 URL（来自你刚启的 widget-server）
- `data-embed-id`：哪个 embed 配置
- `data-server`：widget 运行时调用的 API 根路径（与 `src` 同源即可）
- `<soul-embed></soul-embed>`：渲染挂载点（widget 找不到这个标签会 fallback 到 body 末尾插入）

### 3.5 在自己网页嵌入

把上面整段嵌入码粘贴到目标网页 HTML `<body>` 的**最末**（推荐，最不影响首屏渲染）。

打开网页，期望看到：

1. 加载完成后右下角出现一颗对话气泡
2. 点击气泡 → 弹出对话框 → 显示 Greeting（如有）
3. 输入消息回车 → 看到流式打字效果的分身回复
4. F12 控制台无 CORS / 403 / 网络错误

至此 5 步流程结束，**本机网页已可与 Soul 分身对话**。

---

## 4. 公网穿透（用 Cloudflare Tunnel）

> ⚠️ widget-server 默认监听 `0.0.0.0:3211`（与 proxy-server 仅 `127.0.0.1` 不同，但仍是本机 + 局域网，**不直连公网**）。如果你的网页跑在公网域名（如 `https://myblog.com`）上，访客浏览器无法连到 `http://localhost:3211`。需要一条 Tunnel 把 widget-server 暴露成公网 HTTPS 域名。

### 4.1 选择方案

| 方案 | 优点 | 缺点 | 适合 |
|---|---|---|---|
| **Cloudflare Tunnel**（推荐） | 免费、HTTPS、域名稳定、有 DDoS 防御 | 需注册并接管自己的域名 | 自有域名 + 公网博客 |
| ngrok 免费版 | 一键起，零配置 | 域名每次重启变化、有访问限制 | 临时演示 |
| frp / rathole 自建 | 完全自控 | 需自己有公网中转服务器 | 高阶运维 |
| Tailscale Funnel | 简单且 HTTPS | 仅 100 名义用户上限 | 个人 / 小圈子分享 |

下面**只**展开 Cloudflare Tunnel 步骤（外部新同事 30 分钟内能照抄跑通）。

### 4.2 Cloudflare Tunnel 步骤

**1. 准备**

注册 Cloudflare 账号 → 添加自己的域名（如 `myblog.com`）→ 在 DNS 面板把域名 NS 切到 Cloudflare 给的两条 NS（这一步通常在域名注册商面板做，等 24 小时内生效）。

**2. 安装 cloudflared CLI**

```bash
# macOS
brew install cloudflared

# Linux (Debian/Ubuntu)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
  -o cloudflared.deb && sudo dpkg -i cloudflared.deb

# Windows: 下载 https://github.com/cloudflare/cloudflared/releases/latest 的 .msi
```

**3. 登录 Cloudflare**

```bash
cloudflared tunnel login
# 浏览器会弹出授权页面，选中你刚加的域名 → 授权
```

**4. 创建隧道**

```bash
cloudflared tunnel create soul-widget
# 输出形如：Created tunnel soul-widget with id 7e9b3a12-...
# 同时会在 ~/.cloudflared/<tunnel-id>.json 写入凭据
```

**5. 写配置文件 `~/.cloudflared/config.yml`**

```yaml
tunnel: 7e9b3a12-xxxx-xxxx-xxxx-xxxxxxxxxxxx
credentials-file: /Users/<你的用户名>/.cloudflared/7e9b3a12-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json

ingress:
  - hostname: widget.myblog.com
    service: http://localhost:3211
  - service: http_status:404
```

**6. 关联域名**

```bash
cloudflared tunnel route dns soul-widget widget.myblog.com
# 自动在 Cloudflare DNS 创建一条 CNAME widget → <tunnel-id>.cfargotunnel.com
```

**7. 启动 Tunnel**

```bash
cloudflared tunnel run soul-widget
# 看到 "Connection ... registered" 就成功了
# 保持这个进程常驻；要后台跑可用 `cloudflared service install`
```

**8. 改嵌入码用公网域名**

把 §3.4 的嵌入码替换为：

```html
<script src="https://widget.myblog.com/embed.js"
        data-embed-id="emb_xxx"
        data-server="https://widget.myblog.com"
        defer></script>
<soul-embed></soul-embed>
```

**9. 关键收尾：把使用嵌入码的网页 origin 加进白名单**

回到 Soul 设置面板编辑该 embed，把使用嵌入码的页面 origin（如 `https://www.myblog.com`、`https://myblog.com`）加进 **Origin 白名单**，否则 widget 会被 CORS / 403 拒绝。

### 4.3 Tunnel 安全提醒

- ❌ **不要**把 widget-server 直接绑 `0.0.0.0:3211` + 路由器端口转发暴露公网 IP（无 CDN/WAF 防御，等于裸奔）
- ✅ **要**用 Cloudflare / Tailscale / frp + 反代 一类有 HTTPS + 访问控制 + DDoS 防御的方案
- ✅ Origin 白名单要严格（每加一个 origin 等于多开一扇门）
- ✅ 公网场景把 Rate Limit 从默认 30/min 下调到 **10/min** 或更低
- ✅ 定期检查嵌入页是否还在使用该 embed；不用了**立即停用**

---

## 5. 配置项参考

| 配置 | Setting Key | 默认 | 范围 / 类型 | 说明 |
|---|---|---|---|---|
| widget-server 启用 | `widget_server_enabled` | `false` | `'true'` / `'false'` | 显式 opt-in |
| widget-server 端口 | `widget_server_port` | `3211` | 1–65534 | 改完需点「重启服务」 |
| proxy-server 启用 | `proxy_server_enabled` | `false` | `'true'` / `'false'` | **widget-server 强依赖；proxy 关着 widget 用不了** |
| proxy-server 端口 | `proxy_server_port` | `18888` | 1–65534 | 仅 widget-server 内部访问，无需公网 |
| proxy Bearer Token | `proxy_api_token` | (空) | 32+ 字符 | **服务端持有；前端永远见不到** |
| Embed 名称 | (DAO `embeds.name`) | — | string ≤ 64 | 自己识别用 |
| 关联分身 | (DAO `embeds.avatar_id`) | — | 必填 | 每个 embed 静态绑一个分身 |
| Origin 白名单 | (DAO `embeds.allowed_origins`) | — | string[]，每行 1 个 | 严格匹配；禁 `*` |
| Rate Limit | (DAO `embeds.rate_limit_per_min`) | 30 | 5–300 | 滑动窗口 60s，按 `embed_id × Origin` 计 |
| Greeting | (DAO `embeds.greeting`) | (空) | ≤ 500 字 | 首次打开对话框由 widget 直接渲染 |
| Enabled | (DAO `embeds.enabled`) | `true` | bool | 一键失效开关 |

---

## 6. 安全模型（重要）

### 6.1 Token 不暴露

| 位置 | 持有什么 |
|---|---|
| 嵌入页 / 浏览器 / widget 前端 | **只**持有 `embed_id`（公开值；泄露最坏后果是别人用你的 embed 配置发对话，受 §6.3 限流约束） |
| widget-server（主进程） | 同时持有 `proxy_api_token` 与 embed 配置 |
| proxy-server（主进程） | 真正的 Bearer Token 校验 + 转 chatStore.sendMessage |

> **流程**：widget → widget-server 用 `embed_id` 鉴权 → widget-server 用真 Bearer Token 调 proxy-server → proxy-server 校验 Token → 进入分身对话循环。`proxy_api_token` 全程在主进程内部流转，**不**进网络可见层。

### 6.2 Origin 白名单（核心防线）

- 浏览器端：CORS preflight + 实际请求时携带 `Origin` header
- 服务端：严格字符串匹配 `embeds.allowed_origins` 列表
- 缺 `Origin` header（如 curl / Postman 直接调）→ 拒绝（除非白名单显式包含 `null`，而我们**禁止**这么做）
- 大小写敏感、协议敏感、端口敏感

```
✅ 配置 https://myblog.com → 浏览器 origin https://myblog.com 通过
❌ 配置 https://myblog.com → 浏览器 origin https://www.myblog.com 拒绝
❌ 配置 https://myblog.com → 浏览器 origin http://myblog.com 拒绝
❌ 配置 *                  → DAO 层保存阶段直接报错
```

### 6.3 限流（防滥用）

- 内存级 LRU 滑动窗口，60 秒为窗口宽度
- 默认 30 次/分钟（每个 `embed_id × Origin` 独立计数；同一 embed 嵌到 3 个 origin → 3 个独立桶）
- 超限 HTTP **429**，响应体含 `retry_after` 秒数；widget 前端默认指数退避 1s/2s/4s 三次后向访客显示「请稍后再试」
- 单进程内存（重启 Soul 清零，**不持久化**；不跨设备同步）

### 6.4 Embed 一键失效

| 触发方式 | 生效时机 | 是否可恢复 |
|---|---|---|
| 设置面板点 **「停用」** | 立即（下一个请求即被拒绝） | ✅ 点「启用」即恢复 |
| 设置面板点 **「删除」** | 立即 | ❌ 不可恢复（embed_id 永久作废） |
| Soul 整个退出 | 立即（widget-server 进程退出） | ✅ 启动 Soul + 启 widget-server 即恢复 |

> 删除一个 embed 后，嵌入到任何网页里的旧嵌入码都会立刻收到 403 `embed_disabled_or_not_found`，无须改动网页。这是「一键拔线」语义。

---

## 7. FAQ

**Q1：widget bundle 多大？影响网页性能吗？**  
A：约 **26KB minified / 10.28KB gzipped**。Preact + Shadow DOM + 极简 markdown 渲染，无外部依赖。`defer` 加载不阻塞首屏；DOM 注入只在用户滚动 / 点击触发后才发生。

**Q2：能不能不用 widget bundle，自己写前端？**  
A：可以，widget-server 暴露的是 HTTP API，bundle 只是默认 UI 实现。直接调 API：

```bash
# 1) 拿配置（含 greeting / 分身名 / 头像 等展示信息）
curl 'http://localhost:3211/embed/emb_xxx/config' \
  -H 'Origin: https://myblog.com'

# 2) 发消息（SSE 流）
curl -N 'http://localhost:3211/api/embed/emb_xxx/messages' \
  -H 'Origin: https://myblog.com' \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"你好"}],"stream":true}'
```

响应是 Anthropic Messages SSE 流（`event: message_start` / `content_block_delta` / `message_stop` …），与 §3.3 LangBot 集成文档的 SSE 协议同源。自定义 UI 完全可行（如 Vue 写、嵌微信小程序等）。

**Q3：Soul 关闭时 widget 显示什么？会污染访客页面吗？**  
A：widget 内部捕获网络错误，显示「服务暂不可用」气泡 + 自动 1s/2s/4s 三次指数退避重连；仍失败显示「连接失败，请稍后再试」。**不**弹原生 alert / 不报 console error / 不修改宿主页面 DOM。访客最坏体验是看到一颗灰色气泡。

**Q4：可以一个 widget 切换多个分身吗？**  
A：**不可以**。每个 `embed_id` 在创建时静态绑定一个 `avatarId`。如果需要多分身（如「客服」「售前」「技术答疑」三个角色），请创建 **3 个 embed**，给访客一个分身切换器（自己写选择 UI 决定挂载哪个 `<script src=".../embed.js" data-embed-id="...">`）。

**Q5：widget 内能上传文件 / 截图 / 调工具吗？**  
A：**不能**。本期 widget 不支持文件上传 / 图片粘贴 / MCP 工具调用界面。原因是嵌入访客无知识库写权限语义，且文件上传会带来安全审计 / 限流 / 病毒扫描等一长串外延。如果你要 **看分身用工具的过程**，请用 Soul 桌面端原生 UI；widget 仅做「访客 ↔ 分身」的纯文本对话。

**Q6：widget 支持 Markdown 吗？**  
A：**部分支持**。极简渲染器，覆盖：

- ✅ 段落（自动 `\n\n` 分段）
- ✅ 行内 `code`
- ✅ 围栏代码块 ` ``` `
- ✅ 链接 `[text](url)`（自动加 `target="_blank" rel="noopener noreferrer"`）

不支持：

- ❌ 表格（GFM table）
- ❌ 列表（`-` / `1.`）
- ❌ 标题（`#` / `##`）
- ❌ 图片（`![]()`）
- ❌ HTML 内联

不支持的语法会按原始字符渲染，避免 XSS。要完整 Markdown 请用桌面端 UI。

**Q7：Origin 白名单写错了会怎么样？**  
A：浏览器 console 会显示 CORS 错误，类似：

```
Access to fetch at 'http://localhost:3211/embed/emb_xxx/config' from origin
'https://myblog.com' has been blocked by CORS policy: No 'Access-Control-Allow-Origin'
header is present on the requested resource.
```

回 Soul 设置 → 编辑该 embed → 在 Origin 白名单加上正确的 origin（注意协议、域名、端口都要严格一致）→ 保存即可（无需重启 widget-server，DAO 即时生效）。

**Q8：和 LangBot / IM 适配（#6）怎么区别？什么时候用哪个？**  
A：

| 场景 | 用谁 | 流量入口 |
|---|---|---|
| 嵌入到自己的**网页**（博客 / 官网 / Notion） | **Web Embed widget**（本节） | widget-server :3211 |
| 接入到 IM 平台（飞书 / 企微 / Slack / 钉钉 / Discord） | **LangBot 互补**（#6） | proxy-server :18888 |
| 既要网页又要 IM | 同时启用，两个独立通道 | 两个端口各自工作 |

两者底层都进入 **同一个 proxy-server `/v1/messages`** + **同一个分身工具循环** + **同一套 trustTier='proxy' 权限** —— 只是入口形态不同。

**Q9：Soul 不在线时，访客的对话会缓存到下次发吗？**  
A：**不会**。widget 是无状态的；访客发出消息时如 widget-server 不通，立即报错并重试 3 次，全部失败则显示错误。这是「在线对话工具」的语义，不是「留言信箱」。

**Q10：换电脑 / 重装 Soul 后，原来网页里嵌的 embed 还能用吗？**  
A：**不行**。`embed_id` 存在 SQLite `embeds` 表里，不跨设备同步（本期不实现 #16 跨设备同步）。换设备后需要重新创建 embed，把网页里的 `data-embed-id` 替换为新值。如果你做迁移，建议先在新设备创建好同名 embed → 拿到新 `embed_id` → 同时改完所有页面再下线老设备的 widget-server。

---

## 8. 故障排查

### 错误：`widget_bundle_missing` 503

**原因**：`desktop-app/electron/widget-static/soul-embed.js` 不存在  
**方案**：执行 §3.2 build + 复制步骤；或检查 `widget/dist/soul-embed.js` 是否真的生成了

### 错误：`proxy_token_missing` 503

**原因**：`proxy_api_token` 未配置（widget-server 启动时校验）  
**方案**：设置 → TOOLS → Proxy API → 点「生成 Token」→ 保存 → 重启 widget-server

### 错误：`proxy_disabled` 503

**原因**：proxy-server 未启用（widget-server 强依赖 proxy）  
**方案**：设置 → TOOLS → Proxy API → 勾选「启用 Proxy 服务」→ 保存 → 重启 Soul

### 错误：`origin_not_allowed` 403

**原因**：嵌入页的 `Origin` header 不在该 embed 的白名单内  
**方案**：F12 Network 面板看请求的 `Origin` 实际值 → Soul 设置面板编辑该 embed → 把这个 origin 一字不差加进白名单 → 保存（即时生效）

### 错误：`embed_disabled_or_not_found` 403

**原因**：① `embed_id` 不存在；② embed 已被「停用」；③ embed 已被「删除」  
**方案**：① 检查嵌入码 `data-embed-id` 拼写；② 设置面板点「启用」；③ 重新建 embed 并替换嵌入码

### 错误：`rate_limited` 429

**原因**：超出 `rate_limit_per_min`  
**方案**：等待响应头 `Retry-After` 指示的秒数；或在设置面板把 Rate Limit 调高（最多 300/min）；如果是恶意流量，把对应 origin 从白名单移除即可立即止血

### 错误：访客网页加载 widget 后看不到任何气泡

**排查顺序**：

1. F12 Network 面板看 `embed.js` 是否 200 加载完（没加载到 → §3.5 嵌入码 `src` 错了）
2. F12 Console 看是否有 CORS 报错（有 → §7 Q7 原因）
3. F12 Elements 看是否有 `<soul-embed>` 节点 + Shadow Root（无 → bundle 报错，看 Console error）
4. 检查 `data-embed-id` / `data-server` 拼写
5. `curl http://localhost:3211/embed/<embed-id>/config -H 'Origin: <你的 origin>'` 直连 API 看响应

---

## 9. 已知边界

本期**明确不做**以下事项（与主计划 §4.13 边界一致）：

| 不做项 | 原因 |
|---|---|
| ❌ widget 前端文件上传 / 图片显示 / MCP 工具调用 UI | 嵌入访客无知识库写权限语义；文件上传外延（病毒扫描 / 限流）过大 |
| ❌ widget 持久化对话历史 | 只用 sessionStorage 临时存 `conversationId`；关闭标签即丢，符合「访客对话」隐私语义 |
| ❌ widget-server 限流持久化 | 单进程内存 LRU；重启清零；不跨设备同步 |
| ❌ widget-server 内置公网穿透 | 让 Soul 变成轻量级反代会带来 DDoS / 滥用 / 合规一长串外延；外推 Cloudflare Tunnel 等专业方案 |
| ❌ 一个 embed 内动态切换分身 | embed_id 静态绑定 avatarId；要多分身请建多个 embed |
| ❌ widget 渲染表格 / 列表 / 标题 / 图片 Markdown | 极简渲染器避免 bundle 膨胀（保 10KB gzipped）；要完整 Markdown 用桌面端 |
| ❌ widget-server 绑 `0.0.0.0` + 路由器端口转发 | 缺 HTTPS / WAF / DDoS 防御；公网必走 Tunnel |
| ❌ widget bundle 自动 build / 自动 cp | 本期保留显式步骤让用户掌控版本；未来可加 npm script 自动化 |

---

## 10. 修订记录

| 日期 | 版本 | 修改内容 | 作者 |
|---|---|---|---|
| 2026-05-09 | v1.0 | 初版（#15 Web Embed widget 落地配套用户文档：30 秒预览 / 5 步上手 / Cloudflare Tunnel 全流程 / 配置项 / 安全模型 / 10 条 FAQ / 故障排查 / 已知边界） | zhi.qu |
