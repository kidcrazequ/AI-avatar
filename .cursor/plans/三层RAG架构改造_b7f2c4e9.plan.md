---
name: 三层RAG架构改造
overview: 把当前"每条消息强制 pre-message BM25 RAG"改造为按知识库规模分层的三层架构——agentic 检索 + 小库 prompt cache + 大库 BM25 + rerank。目标是省 cost、降延迟、提召回质量，并根本消除"每条消息冷分词"导致的 OOM 类问题。本计划仅做架构方案与决策点对齐，不涉及今天的 OOM 紧急修复（那个走独立通道先合）。
status: completed-with-deferrals
owner: kian
created: 2026-05-12
closed: 2026-05-13
closed_reason: |
  Phase 0 调研 + Phase 1 (agentic-only) + Phase 0.5 (埋点) 已落地 (commit 7871259)。
  Phase 2 / Phase 3 主动搁置，原因：Phase 0 token 实测发现 9 个 expert-pack 里
  1 满（小堵 5.06M tokens）+ 8 空（README/占位），三层分档假设当前不成立。
  - Phase 2 (prompt cache 全文) 没有优化对象，需要空分身先装 ≥100k tokens 才有意义
  - Phase 3 (BM25 split) 已经是小堵现状，nodejieba 修复后稳定
  重启条件见 [[soul-rag-architecture-direction]] memory。
  调研产出在 .cursor/plans/phase0-token-survey/。
related:
  - 分身对话九层重构_e3ae6199.plan.md   # conversation-router 是本计划的执行入口
  - OOM-修复（独立任务，先合）
todos:
  - id: phase0-baseline
    content: "Phase 0.1: 采集每个分身的知识库大小（tokens 实测，非 word count）、平均日 QPS、平均对话间隔时长"
    status: completed-partial   # tokens 完成；QPS / 对话间隔因 DB 历史不足 24h 改由 phase05 埋点 2 周后补
  - id: phase0-classify
    content: "Phase 0.2: 按 tokens 把分身划入三档：<500k / 500k–1M / >1M，输出 routing-table.yaml"
    status: completed   # 见 .cursor/plans/phase0-token-survey/routing-table.yaml
  - id: phase0-cost
    content: "Phase 0.3: 算 3 套 cost 模型——当前 BM25+rerank、Claude cache、Gemini full-context——按真实 QPS 给出月度成本对比"
    status: deferred   # 待 phase05-query-summary 2 周后聚合
  - id: phase1-agentic-tool
    content: "Phase 1.1: 把 search_knowledge 定义成 LLM 可调用的 tool（schema + description），description 必须强约束\"涉及参数/数据/政策/标准时必须 call\""
    status: completed   # commit 7871259
  - id: phase1-router-update
    content: "Phase 1.2: conversation-router 去掉 pre-message RAG 注入，改为只在 system prompt 暴露 tool"
    status: completed   # 实际改在 chatStore.ts (router 早已 agentic-only)；commit 7871259
  - id: phase1-cache
    content: "Phase 1.3: 同一轮对话内复用上一轮 search_knowledge 结果（命中相同 query/相同分身），避免 agentic 每轮都 call"
    status: deferred   # 验证显示 LLM 多轮 query 是分解子问题，不是重复 call，缓存命中率会很低
  - id: phase1-eval
    content: "Phase 1.4: 跑回归题库验证——红线题（不该检索的）不再触发 search、专业题（该检索的）100% 触发"
    status: completed   # 手动验证 4/4 通过：寒暄 searchCalls=0/0, 专业题 searchCalls=3/2
  - id: phase2-cache-small
    content: "Phase 2.1: <500k token 库走 Claude/Gemini full-context + prompt cache，把整个知识库塞进 system prompt"
    status: deferred   # 8 个空 pack 没真内容可 cache；重启条件：任一 pack ≥100k tokens
  - id: phase2-ttl
    content: "Phase 2.2: 评估 cache TTL 策略——5min（0.1×）vs 1h（贵 2× 但跨对话保活），按 phase0 的对话间隔分布选档"
    status: deferred   # blocked by phase2-cache-small
  - id: phase2-size-guard
    content: "Phase 2.3: 加保护——库 > 阈值（默认 450k）自动降级到 phase3 的 BM25 路径，防 cache miss 后裸调成本爆炸"
    status: deferred   # blocked by phase2-cache-small
  - id: phase3-bm25-keep
    content: "Phase 3.1: >1M token 库保留 BM25 + rerank 路径（小堵、电图）；索引常驻进程，不再每条消息冷分词"
    status: already-shipped   # nodejieba 持久化 tokens.json (commit c556442) 已实现"索引常驻"
  - id: phase3-threshold-config
    content: "Phase 3.2: 切档阈值改为 routing-table.yaml 可配置，不硬编码（库会长大）"
    status: deferred   # 当前只有 1 个分身在 large 档，硬编码足够；多分身满载后再做
  - id: phase4-rollout
    content: "Phase 4.1: 灰度发布——按分身逐个切换，每切一个跑一遍该分身的回归题库"
    status: not-applicable   # Phase 1 是全局开关，无需逐分身灰度
  - id: phase4-cost-verify
    content: "Phase 4.2: 上线 2 周后对账实际 cost vs phase0 预测，偏差 > 30% 则回滚或重做 routing-table"
    status: deferred   # 待 phase05-query-summary 2 周后
---

## 背景

当前架构：每条用户消息无差别走 pre-message BM25 RAG（冷分词 + 检索 + 注入 system prompt），存在三个问题：

1. **寒暄/确认/格式偏好确认也检索** —— 浪费 cost、增加延迟、注入噪声让 LLM 跑偏
2. **每条消息冷分词** —— 索引不常驻，是本次 OOM 的根因
3. **召回质量天花板低** —— BM25 是 lexical match，对同义词、语义改写召回差，靠重排弥补

CLAUDE.md 里已经写死了"寒暄不检索"的规则，但目前是靠硬编码 + 路由分类实现，本质上是用代码模拟 LLM 该做的判断（违反全局 Rule 5："code 能答的让 code 答，但**判断类**该让 LLM 答"）。

## 三层架构

| 层 | 适用 | 路径 | 召回 | Cost 模型 |
|---|---|---|---|---|
| L1 寒暄/确认 | 任何分身 | 不检索 | N/A | 0 RAG 开销 |
| L2 小库 (<500k tokens) | design-master、product-manager 等 | Full-context + prompt cache | 全文语义 | Claude cache read 0.1× / Gemini ~免费 |
| L3 大库 (>1M tokens) | 小堵、电图 | BM25 + rerank + agentic search tool | Lexical + LLM 重排 | 索引常驻 + 增量更新 |

**关键判定权**交还给 LLM：用户消息进来后，LLM 看 system prompt 里的 search_knowledge tool description 自行决定 call or not，**不再由代码做"该不该检索"的分类**。

## 决策点与 push-back

### 决策 1：agentic tool description 必须强约束
- 风险：LLM 容易"觉得自己知道"就不 call，对小堵/电图这种领域，幻觉成本 >> 多 call 一次的 cost
- 对策：tool description 加红线 —— "涉及参数/数据/政策/标准/电气规范/项目报价时必须 call，禁止凭记忆作答"
- 验证：phase1-eval 跑回归题库，专业题触发率必须 100%

### 决策 2：同轮对话内 RAG 结果复用
- 风险：纯 agentic 模式下，LLM 每轮都可能 call 一次相同 query
- 对策：以 `(avatar_id, normalized_query)` 为 key 缓存 10 分钟，命中直接返回上次 chunks
- 不做：跨对话/跨 session 复用（会污染上下文，得不偿失）

### 决策 3：Claude prompt cache TTL 档位
- 5min cache（0.1× 单价）：用户连续提问场景胜出
- 1h cache（贵 2×，跨对话保活）：每天用一次的低频场景胜出
- 决策依赖 phase0 实测的"对话间隔分布"，**不预先选**

### 决策 4：<500k 阈值要按分身实测调
- design-master 73 套语料看起来很多，但 token 总量未必 > 500k
- power-grid 一份国标可能就 200k tokens
- 不硬编码阈值，所有 routing 走 routing-table.yaml

### 决策 5：与"九层重构"的关系
- 本计划的 phase1 落点在 [conversation-router](../desktop-app/src/stores/conversation-router.ts)
- 九层重构必须先合，否则没有可插拔的 router 层
- 顺序：九层重构 → 本计划 phase0 数据采集 → phase1 agentic → phase2 cache → phase3 BM25 常驻

## 不在本计划范围内（明确隔离）

- ❌ 今天的 OOM 紧急修复 —— 走独立 hotfix PR，先把"索引常驻"那条短路径合掉
- ❌ 向量检索 / embedding 重排 —— 短期内不引入，BM25 + LLM 重排已足够
- ❌ 知识图谱 / GraphRAG —— 不在本计划范围，等 link-graph（九层重构 phase5）跑通再评估
- ❌ 跨分身知识共享 —— shared/knowledge 的路由策略另立计划

## 验收标准（goal-driven）

1. **Cost**：月度 RAG 相关 cost 比当前下降 ≥ 30%（按 phase0 baseline 对账）
2. **延迟**：寒暄类对话首 token 延迟 < 800ms（当前 1.5s+，省掉 RAG 路径）
3. **质量**：回归题库通过率 ≥ 当前水平，红线题误检索率 0%
4. **稳定性**：连续 7 天无 OOM、无索引相关 crash
5. **可配置**：所有阈值/档位通过 routing-table.yaml 可调，无需改代码

任一不达标 → 该 phase 回滚，不强行往后推。

## 启动条件

- [ ] 九层重构 phase 1-2 合入主干
- [ ] OOM hotfix 上线 ≥ 3 天稳定
- [ ] phase0 数据采集脚本写好（约 0.5 天工作量）

满足后再正式开 phase1。
