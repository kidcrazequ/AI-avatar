# wigolo 国内搜索引擎插件

配合 `docs/wigolo-cn-search-plan.md`（子任务 3/4）的 wigolo 搜索引擎插件，为 Soul 的
`cn_web_search` 边车提供国内引擎召回：

| 插件 | 数据源 | 方式 |
|---|---|---|
| `bing-cn/` | 必应中国 `cn.bing.com/search` | HTML 解析（`b_algo` 结果块） |
| `csdn/` | CSDN `so.csdn.net/api/v3/search` | 公开 JSON 接口 |

> 计划文档一期第二引擎原写"知乎"，实测其 API 无登录态返回空结果，已改为 CSDN。

每个插件是零依赖的独立 ESM 模块（Node >= 20，全局 fetch + AbortSignal.timeout），
按 wigolo `docs/plugins.md` 契约导出 `searchEngine = { name, search(query, options) }`。
失败语义：网络错误 / 非 200 / 结构大变 → 抛错（wigolo 在 engine_telemetry 里如实标注
该引擎失败）；真的无结果才返回 `[]`。

## 本地安装

wigolo 的 `plugin add` 只接受 git 仓库。本地插件直接把目录复制或软链到
`~/.wigolo/plugins/` 后验证：

```bash
cp -r scripts/wigolo-plugins/bing-cn ~/.wigolo/plugins/
cp -r scripts/wigolo-plugins/csdn ~/.wigolo/plugins/
# 或软链：ln -s "$(pwd)/scripts/wigolo-plugins/bing-cn" ~/.wigolo/plugins/

wigolo plugin validate
```

## 冒烟测试（真实联网）

```bash
node scripts/wigolo-plugins/smoke.mjs "储能 电池"   # 省略查询词时默认"储能 电池"
```

两个引擎都返回 >= 1 条相关结果时 exit 0；任一引擎抛错 / 0 结果 / 疑似罐头结果时
打印诊断并 exit 1。

### 已知：bing 风控行为（2026-07-20 实测）

被风控的 IP 访问 bing 会出现两种响应，插件/冒烟分别处理：

1. **Turnstile 验证墙**：200 但无任何 `b_algo` 块，页面含
   `challenges.cloudflare.com/turnstile` + `bing.com/challenge/verify` 配置
   → 插件按契约抛带诊断信息的错；
2. **罐头结果页**：结构完整（含 `b_algo` 块）但内容与查询完全无关（如中文查询
   返回西语 Bing 宣传页）。插件层无法与真实结果区分（结构未变，不符合抛错语义，
   质量判断交给 wigolo 融合/重排管线）；冒烟脚本用"结果不含查询词任一 token"
   兜底判为失败，不把罐头当通过。
