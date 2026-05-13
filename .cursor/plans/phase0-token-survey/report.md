# Phase 0 Token Survey — 知识库实测 + 三档分类

**生成时间**: 自动生成（见脚本运行时）  
**Tokenizer**: tiktoken `o200k_base` (GPT-4o BPE, ≈ Claude 4 / DeepSeek V3+ ±10%)  
**统计范围**: `expert-packs/*/knowledge/**/*.md` + `_excel/**/*.json`；跳过 `_raw/`、`images/`

## 分档规则

| Tier | 阈值 | Phase 1+ 路由策略 |
|---|---|---|
| small | <500k tokens | 全文塞 system prompt + prompt cache（Phase 2.1） |
| medium | 500k–1M | 边界值，逐个分身决定（Phase 2.3 size guard 触发） |
| large | ≥1M | 保留 BM25 + rerank + agentic search tool（Phase 3） |

## 共享知识库 (shared/knowledge)

- md tokens: **957**
- _excel json tokens: **0**
- 每个分身的 effective 都会加上这部分

## 分身排序（按 effective_full 降序）

| 分身 | 自有 md | _excel json | own total | effective (md only) | effective (full) | tier (md only) | tier (full) |
|---|---:|---:|---:|---:|---:|---|---|
| `小堵-工商储专家` | 3,157,514 | 1,898,455 | 5,055,969 | 3,158,471 | 5,056,926 | **large** | **large** |
| `finance-expert` | 914 | 0 | 914 | 1,871 | 1,871 | **small** | **small** |
| `design-master` | 745 | 0 | 745 | 1,702 | 1,702 | **small** | **small** |
| `electrical-engineer-expert` | 574 | 0 | 574 | 1,531 | 1,531 | **small** | **small** |
| `product-manager-expert` | 412 | 0 | 412 | 1,369 | 1,369 | **small** | **small** |
| `legal-expert` | 317 | 0 | 317 | 1,274 | 1,274 | **small** | **small** |
| `hr-expert` | 312 | 0 | 312 | 1,269 | 1,269 | **small** | **small** |
| `market-analyst-expert` | 262 | 0 | 262 | 1,219 | 1,219 | **small** | **small** |
| `project-manager-expert` | 239 | 0 | 239 | 1,196 | 1,196 | **small** | **small** |

## 分档分布

| Tier | md only | with _excel |
|---|---:|---:|
| small  | 8  | 8 |
| medium | 0 | 0 |
| large  | 1  | 1 |

## 每分身 top-10 大文件

### 小堵-工商储专家

| # | category | tokens | path |
|---:|---|---:|---|
| 1 | excel_json | 543,821 | `_excel/00_工商储-产品质量指标dashboard_260303.json` |
| 2 | excel_json | 259,223 | `_excel/明美-远景工商业_372_液冷1P416S_出货报告.json` |
| 3 | md | 245,037 | `ENS-L562-01_恩玖PCS_125kW新国标报告最终版_-对外完整版带水印.md` |
| 4 | excel_json | 216,113 | `_excel/DFMEA-2024_12_03.json` |
| 5 | md | 150,322 | `明美-远景工商业_372_液冷1P416S_出货报告.md` |
| 6 | md | 147,619 | `00_工商储-产品质量指标dashboard_260303.md` |
| 7 | excel_json | 91,292 | `_excel/DVP-xxxxxx_远景能源工商业储能一体机测试验证大纲_A.json` |
| 8 | md | 89,540 | `远景262KWh户外柜测试报告20250312.md` |
| 9 | md | 88,571 | `储能电池管理系统产品手册_V1_0_20250401.md` |
| 10 | md | 71,695 | `远景262KWh户外柜测试报告20250124.md` |

### finance-expert

| # | category | tokens | path |
|---:|---|---:|---|
| 1 | md | 723 | `README.md` |
| 2 | md | 191 | `示例-报表科目占位.md` |

### design-master

| # | category | tokens | path |
|---:|---|---:|---|
| 1 | md | 745 | `README.md` |

### electrical-engineer-expert

| # | category | tokens | path |
|---:|---|---:|---|
| 1 | md | 453 | `README.md` |
| 2 | md | 121 | `示例-符号表占位.md` |

### product-manager-expert

| # | category | tokens | path |
|---:|---|---:|---|
| 1 | md | 345 | `README.md` |
| 2 | md | 67 | `示例-术语表占位.md` |

### legal-expert

| # | category | tokens | path |
|---:|---|---:|---|
| 1 | md | 257 | `README.md` |
| 2 | md | 60 | `示例-引用锚点占位.md` |

### hr-expert

| # | category | tokens | path |
|---:|---|---:|---|
| 1 | md | 266 | `README.md` |
| 2 | md | 46 | `示例-制度主题占位.md` |

### market-analyst-expert

| # | category | tokens | path |
|---:|---|---:|---|
| 1 | md | 201 | `README.md` |
| 2 | md | 61 | `示例-指标占位.md` |

### project-manager-expert

| # | category | tokens | path |
|---:|---|---:|---|
| 1 | md | 203 | `README.md` |
| 2 | md | 36 | `示例-阶段标签占位.md` |

## 关键发现：当前 9 个分身呈"1 满 8 空"分布

> **8 个 small-tier 分身的 token 数其实是 README + 占位 .md 的体量**，每个分身 knowledge/ 下只有 1-2 个文件，
> 全部小于 1k tokens。也就是说：**当前只有「小堵」一个分身装了真正的知识库，其他 8 个还是 expert-pack 模板状态**。

这把整个 plan 的优先级重新洗牌：

| 原 plan 假设 | 实际情况 | 影响 |
|---|---|---|
| 三档 routing 是多分身均匀分布 | 一个 large + 八个 empty | Phase 2 (prompt cache full-context) 当前**无对象**，因为没有任何分身真在 small 档运行有意义内容 |
| 不同分身用不同策略 | 实际只服务一个 large 分身 | Phase 3 BM25 路径本来就是小堵的现状 |
| 寒暄不该检索是次级优化 | 这条对所有分身都成立 | Phase 1（agentic-only，让 LLM 决定要不要 call search_knowledge）变成 **唯一立刻有价值** 的子项 |

## 建议的 plan 调整

- ✅ **Phase 1 仍然要做**（agentic-only on top of pre-message RAG）：解决"寒暄也检索"、对所有分身都有效，与库规模无关
- ⏸ **Phase 2 暂搁置**：当前没有 small 档分身有真知识库需要塞 prompt cache；等任一新分身知识库做到 100k+ tokens 再启动
- ⏸ **Phase 3 暂搁置**：BM25 + agentic 已经是小堵的现状（nodejieba 修复后稳定运行），没有新工作要做
- 🆕 **新增：Phase 0.5**（小工作量）—— 给 conversation-router 加 query 维度埋点（query 长度、是否走 RAG、是否命中、首 token 延迟），跑 2 周补 Phase 0.3 缺的数据

## 输入到 Phase 1 的决策（更新版）

1. 不需要按分身做 routing 差异化——所有分身都切到 agentic 路径
2. 小堵保留 search_knowledge tool（已有），description 加强约束（"涉及参数/数据/政策/标准/电气规范必须 call"）
3. 8 个空分身切到 agentic 后，tool description 也要写"调用前先评估问题是否在知识范围"，避免 LLM 对空库瞎 call

## _excel/ 数据观察（针对小堵）

- excel json 总量 1.9M tokens（占小堵 own_total 的 37.5%）
- top 1 单文件 `00_工商储-产品质量指标dashboard_260303.json` 一个就 544k tokens
- 当前是通过 `query_excel` tool 按 sheet/filter 查询，**没有被一次性塞进 prompt** —— 这条路径是对的，Phase 1 不需要动
- 但说明：未来如果给小堵做 prompt cache，要明确**只 cache md 部分**，excel 永远走 tool 路径
