# 方案：Soul 桌面端接入 wigolo（新增 cn_web_search 工具）

> 状态：**已实施**（2026-07-20，commit def1ba9 / 4d1adca / 8ceb098）。实施决定与遗留见文末。

## 目标

分身获得 **$0、免 API key、带字节级溯源（citation_id + source_span）、本地缓存**的中文 web 检索能力。
不改动现有 `web_search`（Tavily）链路 —— wigolo 以**新工具 `cn_web_search`** 形式接入，跑一段时间后对比质量再决定 Tavily 去留。

## 架构决策（已定）

| 决策 | 选择 | 理由 |
|---|---|---|
| 接入方式 | wigolo 边车进程（`wigolo serve`，回环端口）+ REST | 原生依赖（better-sqlite3/playwright）按系统 Node ABI 编译，嵌入 Electron 会碎；重内存组件隔离在边车，避开主进程 4GB 堆顶；AGPL 进程边界干净 |
| 国内引擎 | wigolo 官方插件机制（`~/.wigolo/plugins`，`{name, search()}` 契约） | 不 fork 源码，无需跟上游 rebase；插件结果进同一条融合/重排管线 |
| 工具形态 | tool-router 新注册 `cn_web_search`，与 `web_search` 并存 | 工具描述分工：中文/国内站点 → cn_web_search；英文/国际 → Tavily |
| 引擎一期 | 必应中国 + 知乎（低反爬、直连可用） | 百度（验证码风控）、搜狗/微信（反爬最强）放二期，视一期召回缺口决定 |

## 子任务列表

- [ ] 子任务 1：边车生命周期模块 → 新文件 `desktop-app/electron/wigolo-sidecar.ts`（约 150 行）
  - 懒启动（首次调用 cn_web_search 时 spawn `wigolo serve`）、健康检查（`GET /openapi.json`）、app 退出回收
  - 运行时探测：优先系统 Node ≥ 20，缺失时提示安装 wigolo 单文件二进制（不打包进 Soul）
- [ ] 子任务 2：`cn_web_search` 工具注册 → `packages/core/src/tool-router.ts`（约 100 行）
  - 工具 schema + 执行分支：`POST /v1/search` → 结果映射，透传 `citation_id` / `source_span` / `evidence_score`，沿用 `WEB_SEARCH_HARD_MAX` 类截断纪律
  - 降级如实标注：边车未就绪 / 引擎失败列表原样带给分身（契合"宁拒答不占位"）
- [ ] 子任务 3：插件 bing-cn → 新目录 `scripts/wigolo-plugins/bing-cn/`（约 100 行，独立 Node 模块）
- [ ] 子任务 4：插件 zhihu → 新目录 `scripts/wigolo-plugins/zhihu/`（约 100 行）
- [ ] 子任务 5：配置与开关 → 全局默认关闭，按分身 `avatar.config.json` 启用；代理（`USE_PROXY/PROXY_URL`）与 `HF_ENDPOINT=hf-mirror.com` 写入边车 env
- [ ] 子任务 6：测试 → tool-router 单测（mock REST 响应：正常/降级/边车离线三态）；插件 `wigolo plugin validate` 冒烟
- [ ] 子任务 7：文档 → CHANGELOG + 本文档更新为"已实施"

## 执行顺序

1 → 2 → 6（先打通边车 + 工具主链路并测通）→ 3 → 4（插件可独立并行）→ 5 → 7

依赖：2 依赖 1 的边车句柄；3/4 只依赖 wigolo 本体装好，可与 2 并行。

## 风险提示

- **首次安装 ~1.5GB**（Playwright 浏览器 + 模型），慢网下必须 `--no-warmup` + 代理跑 `wigolo warmup --all`（支持续传）
- **默认 18 个海外引擎国内裸连大半失败**：不影响正确性（wigolo 如实标注失败引擎），但有超时噪音；挂代理可消除。文档未见按引擎启停开关，实施时读一遍 config 源码确认，若有白名单则收紧
- **插件反爬维护是长期成本**：bing-cn/zhihu 一期风险低；百度/搜狗二期需专门评估
- **AGPL 边界**：不改 wigolo 源码 + 本地个人使用 = 无义务；若将来对外分发 Soul，插件目录建议单独 AGPL 开源，Soul 主体因进程边界不受影响

## 实施决定（2026-07-20）

1. 工具名定为 `cn_web_search`（用户确认执行时未提异议）
2. **第二插件由知乎改为 CSDN**：实测知乎 search_v3 API 无登录态返回空结果（`{"HitLabels":null}`）；CSDN `so.csdn.net/api/v3/search` 公开可用
3. **子任务 5 简化**：未做按分身 `avatar.config.json` 启用——cn_web_search 已有双层闸门（`web_search_enabled` 全局开关 + 边车未安装时诚实降级），按分身粒度的收益低于其复杂度；HF 镜像已在 main.ts 边车 env 注入；代理透传依赖边车继承 process.env
4. **必应风控实录**：本机 IP 下 bing 间歇返回 Turnstile 验证墙（插件抛诊断错）或"罐头结果页"（结构完整但内容无关、插件层无确定性判据，交 wigolo 融合层稀释；smoke.mjs 有查询词 token 兜底检测）

## 遗留（待用户环境就绪后一次性完成）

- 本机未安装 wigolo：`npx wigolo init --no-warmup`，慢网挂代理跑 `wigolo warmup --all`（~1.5GB，支持续传）
- 插件安装：`cp -r scripts/wigolo-plugins/{bing-cn,csdn} ~/.wigolo/plugins/` 后 `wigolo plugin validate`
- 端到端真机验证：设置里开启联网 → 分身对话调 `cn_web_search`（此前一切失败路径均已有单测钉死）
