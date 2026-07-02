# 社区热门 AI 项目深读 — Soul 借鉴点清单

> Updated: 2026-07-02
> 来源：用户备忘录（8 条「GitHub AI 热门项目」笔记，2026-06-24 ~ 07-01）→ 筛出 Soul 强相关的 16 个项目 → 7 路并行深读（全部拉取真实仓库/源码核实，非转述备忘录）。
> 配套文档：`docs/agent-runtime-roadmap.md`、`docs/agent-runtime-sdk-borrow-backlog.md`（已收口）。
> 本文只收「与已收口 backlog 不重复、且通过实读验证」的借鉴点。

---

## 0. 备忘录纠错（先扫雷）

备忘录多源转载，实测出入不少，引用前先看这张表：

| 备忘录说法 | 实测 |
|---|---|
| ECC = "性能优化系统：懒加载/压缩/缓存/沙箱，省 40-60% token" | **严重失实**。ECC（224k star 属实）是 Claude Code 配置+技能合集仓库："压缩"=教人手动敲 `/compact` 的纪律文档；"省 40-60%"=「Opus 换 Sonnet」的换模型建议；"沙箱"=静态扫描。**几乎无可借**，Soul 的自动压缩已领先它 |
| superpowers "定义了 Skill 标准、50+ 技能" | 标准是 **agentskills.io 规范**（Anthropic 主导），superpowers 是遵循者；实际 14 个技能。跨 harness 兼容（10 个）属实且被低估 |
| OpenClaw "60 天 star 超 React" | 约 3 个多月，非 60 天；381k star 属实。`nicepkg/openclaw` 链接**不存在**，正主 `openclaw/openclaw` |
| "Anthropic-Cybersecurity-Skills"（23.8k star） | **非 Anthropic 官方**，社区作者 mukul975 蹭名。`anthropics/agent-skills-cybersecurity` 不存在 |
| open-notebook "多文档分析 + 知识图谱" | **无知识图谱**，只有 SurrealDB 全文+向量检索（SurrealDB 的"多模型库"营销可能是讹传源头） |
| hermes-agent 两个链接 | 正主 `NousResearch/hermes-agent`（207k star）；`mrbrax/hermes-agent` 已死 |
| codebase-memory-mcp 两个链接 | 正主 `DeusData/`（23.8k star）；`iansinnott/` 不存在。"减少 99% token" = 只回传结构化元数据、源码按需显式取（自选场景基准） |
| headroom "3-4 万 star" | 已迁移到 `headroomlabs-ai/headroom`，实测 **55k star**，Rust 核心 + 388 单测 + 真实质量回归评测，**是真货** |
| supermemory "支持本地全量运行" | 打折扣：OSS 仓库只有 SDK/MCP/插件，**引擎闭源**（云 API 或不可审计的预编译二进制） |

---

## 1. Tier A — 护红线 / 补实缺口（优先做）

### A1 · 溯源闭集校验：anchor 白名单 + verifier 后置断言
- **借自**：open-notebook 的「检索结果 id 随 prompt 下发 → 只准引用白名单内 id」闭集模式——但它止步于 prompt 约束、粒度只到文档级；Soul 补上它没做的**机器校验**。
- **做法**：`search_knowledge` / `knowledge_grep` / `query_excel` 每条返回携带稳定 anchor id（`knowledge/x.md#h=章节` / `foo.xlsx#sheet=S!A1:C20`）；回答中每个 `[来源: ...]` 必须 ∈ 本轮工具返回的 anchor 集合，由已 live 的 `verifier.ts` 做后置断言，集合外 = 溯源违规。
- **为什么**：对 2026-05-22「来源错位」事故最直接的**结构性**防御（现在只靠 prompt 恳求）。
- **落点**：`packages/core/src/agent-runtime/verifier.ts` + tool-router 检索工具返回结构。配套：知识索引建块时存 `路径+标题层级/行号区间`（open-notebook 的反面教训：chunk 不存位置锚点，引用就永远只能到文档级）。

### A2 · soul-sync 安装门禁：静态扫描 + 指纹基线（供应链缺口，当前为零）
- **借自**：NVIDIA SkillSpector（11.8k star，Apache 2.0；其研究数据：公开技能 26.1% 含漏洞、5.2% 恶意）。实读 `soul-sync.sh`（315 行）确认：clone → `cp *.md` 进 community/，**中间零检查**。
- **做法**（按落地顺序）：
  1. **Unicode 隐藏字符硬拦截**：零宽字符、bidi（Trojan Source）、Unicode Tag 块 ASCII smuggling——人工审 diff 完全看不见，技能 md 里无合法理由出现，可做零误报硬拒；
  2. **静态 pattern 门禁**：移植 SkillSpector 四类最相关 pattern（指令覆盖 / 隐藏指令 / 会话外传 / 凭证收集），带 severity 权重累加 risk_score，三段处理（放行 / 警告需 `--force` / 拒装 exit≠0）。纯 regex 无外部依赖；
  3. **baseline 指纹抑制**：接受过的 finding 记 sha256 + 必填 reason，重扫只报新增——既解决误报，又天然防 **rug-pull**（同 repo 换 tag 注入）；
  4. **来源持久化**：soul-sync 已取 `actual_commit`（L120）但没存——把 `source_repo/source_commit/installed_at/scan_score` 写进技能 frontmatter 或旁挂 lock 文件。
- **信任教训**：23.8k star 的 "Anthropic-Cybersecurity-Skills" 非官方——repo 名与 star 数都不是信任信号，信任只能来自扫描。
- **落点**：`scripts/soul-sync.sh` clone 与 cp 之间插扫描脚本 + `shared/skills/community/.scan-baseline.yaml`。
- **不借**：YARA / AST / 污点跟踪 / CVE 查询（Soul 技能是纯 md 进 prompt，不执行代码）；LangGraph 编排（单脚本够）；LLM 语义复核做默认（有"用 LLM 读注入文本"悖论，至多做 CAUTION 区间可选辅助）。

### A3 · 工具结果压缩下一步：确定性统计压缩 + CCR 可逆取回（BR-2 的续篇）
- **借自**：headroom（55k star，算法级实读）。
- **做法**（按 ROI 排序）：
  1. **CCR 可逆压缩**：任何截断/摘要处留 `[已压缩 N→M，取回原文: id=xxx]` marker + 注册内置 `retrieve_original` 工具。Soul 已 SQLite+JSONL 双写，**原文本来就在，只缺模型取回的路**——把"压缩不丢数字"从事前祈祷变成事后可恢复。与被暂缓的 BR-8 不同：marker 里直接写调用方式，弱模型发现成本极低；
  2. **确定性统计压缩**插在「盲字节截断」与「LLM 摘要」之间，处理 JSON/表格类工具输出：错误项永不丢（关键词表）、Pareto 罕见值保留（top-K 覆盖 80%）、罕见字段（<20% 出现率）保留、query 关键词命中保留、首 30%/尾 15% 位置锚点、丢弃行统计聚合；先试无损重排（JSON 数组→CSV，省 ≥15% 才用）。数字原样保留、零模型调用、可单测——比 LLM 摘要更守溯源红线；
  3. **prompt cache 对齐**：Soul 当前「每轮滚动压缩旧工具结果」= 每轮前缀变化 = **每轮 cache 全 miss**（DeepSeek/Anthropic 都受害）。改为阈值触发的批量压缩，让前缀多轮稳定。BR-2 触发时机同理；
  4. **SUPERSEDED/STALE 判定**：同工具同参数被再次调用 → 旧结果替换为一行 marker（headroom 实测 75% read 字节属此类，零信息损失）；比现有按轮龄压缩更精确；
  5. **inflation guard**：`compactContextIfSafe` 压完估算 token，`after >= before` 整体回退（~5 行）；
  6. **before/after 回归评测**：同组问答在压缩开/关下对照跑，承重数字+来源引用逐字断言（可程序化，不必 LLM judge）——BR-2 默认关正是因为没有质量证据，没有评测它永远不敢默认开。
- **落点**：chatStore 工具循环逐结果截断处（独立 `tool-result-compressor.ts` 纯函数模块）、`src/services/context-compaction.ts`、ToolRouter 内置工具、`src/services/eval/`。
- **不借**：Kompress ML 压缩模型（Electron 塞 HF 模型不现实 + ML 改写数字撞红线）；proxy 接入；对数据类内容做语义摘要（headroom 的经验恰是结构化数据走统计保留而非摘要）。

### A4 · 记忆系统改造：有界预算 store + 后台复盘 + session_search（点亮 dormant memory/* 的设计蓝本）
- **借自**：Hermes Agent（NousResearch，207k star，源码级实读 memory_tool.py 等 9 个文件）。核心洞察：**该量级下不需要向量/图，2~3KB 有界纯文本 + FTS 就是正确解**。
- **做法**：
  1. **有界条目 store**：MEMORY.md 改为条目分隔 + 全文件字符预算（Hermes 2200 字符，Soul 每分身可放宽到 4-6K）+ add/replace/remove 原子操作。**预算即遗忘**——满了必须先删/合并，价值排序被结构强制而非 prompt 恳求；每次遗忘都是可见的工具调用记录（合 Soul 溯源基因）；
  2. **双 store 分离**：MEMORY.md（分身运行笔记：工具坑、环境约定、教训）与 USER.md（用户画像：偏好、沟通风格）分开，注入时各带用量表头（`[82% — 1,804/2,200 chars]`，用量可见本身就是 consolidate 的 nudge）；
  3. **抽取改为 N 轮一次后台复盘**（Hermes 默认 10 用户轮），回复送达后跑、可路由便宜模型；复盘 prompt 移植 Hermes 负面清单 + Soul 特有项："**专业事实不进 MEMORY.md，引导去 knowledge/（走溯源规范）**"。最锋利的一条禁令：**不许记对工具/环境的负面断言**（"query_excel 不可用"会硬化成几个月后还在自我引用的拒绝理由）；"Nothing to save" 合法化；
  4. **冻结快照注入**：session 开始时快照注入 system prompt，中途写只落盘、下个 session 生效——保整个会话的 prefix cache（与 A3-3 同一原理）；
  5. **`session_search` 工具**（情节记忆泄压阀）：SQLite FTS5 三模式（搜索/翻页/浏览），零 LLM 成本；细节照抄：命中点 ±N 消息窗口 + 会话首尾 bookends、按会话去重、定时任务会话降权不排除。有了它，抽取 prompt 才能理直气壮说"过程性内容不进记忆，用会话搜索找"；
  6. **记忆四分边界写进 agent-template**：knowledge/（无状态专业事实，强溯源）≠ memory/（有状态：用户是谁、环境现状）≠ 会话历史（发生过什么，FTS）≠ skills/（怎么做这类任务）。
- **工程铁律**（Hermes 用 298 秒阻塞事故换的）：记忆写入永远不能阻塞回复路径——Soul 在 better-sqlite3 同步 API + 主进程事件循环约束下同样适用。
- **落点**：`memory/MEMORY.md` 格式约定、`packages/core` dormant `memory/*` 点亮为该 store 的 API、`chatStore.ts` memory-write 抽取逻辑、`soul-loader.ts` 注入路径、ToolRouter + `electron/database.ts`（FTS5 索引）。
- **不借**：supermemory 整套向量+图引擎（闭源不可审计 + 几 KB 量级杀鸡用牛刀）；**Derives 自动推断事实**（无来源推断=占位符的另一种形态，撞红线）；静默自动遗忘（删除不留痕）；Hermes 激进 skill review（"每 session 至少产出一个技能更新"——与「宁拒答不占位」相反，它自己都被迫造 curator 收拾垃圾）。

---

## 2. Tier B — 技能体系升级（中期，多为模板/脚本级）

### B1 · 技能格式对齐 agentskills.io 事实标准
目录型技能（`SKILL.md` + `references/` + `scripts/` + `assets/`）、`name` 与目录名一致、SKILL.md <500 行、重型参考拆 `references/<域>.md` 且引用限一层深。对齐后 `soul-sync.sh` 可**零转换安装** anthropics/skills、superpowers 及整个社区生态。`load_skill` 需支持技能目录内相对路径二次读取（`resolveUnderRoot` 守护）。
→ 落点：`templates/skill-template.md`、`soul-sync.sh`、SkillManager（向后兼容现有单文件技能）。

### B2 · description 撰写规范：触发条件优先 + pushy 关键词
两派实测哲学合并：superpowers SDO（"Use when..." 开头，**只写触发场景、禁止摘要流程**——防模型"读了摘要以为自己会了、不 load 全文"）+ anthropic pptx 式关键词穷举（同义词/场景全列）。Soul 用 DeepSeek/Qwen 弱模型，undertrigger 比 Claude 更严重，这是零成本召回提升。可对存量技能做一轮 description 重写。
→ 落点：skill-template 撰写指南 + skill-index.yaml 摘要生成规则。

### B3 · 统一 validator 脚本 + 索引由 frontmatter 生成
两路调研独立指向同一结论（pm-skills `validate_plugins.py` + 817 技能库 `validate-skill.py`），且本地 git status 里 10+ 个 skill-index.yaml 同时手工改动正是它要消灭的漂移。校验：name=目录名 kebab-case、description 最短长度且含触发短语、index 引用的技能文件存在、同名覆写显式标注、category 受控词表+别名非阻塞 warn。skill-index.yaml 从技能 frontmatter **生成/校验一致性**而非手写；本地与 CI 跑同一脚本。
→ 落点：`scripts/validate-skill`（新增）。

### B4 · 「判断力规则化」写法进 skill-template（taste-skill 模式）
品味被规则化的核心机制 = **识别并封杀模型的统计均值输出**。三个新增节：
- `## 反模式（禁令 + 归因 + 后果）`：每条 = 禁什么 + 为什么（实测事故/AI 惯性，点名到具体值）+ 违反后果。CLAUDE.md 里 2026-05-22 事故记录已是雏形——模板化推广，让 9 个专家包各自沉淀「AI 惯犯清单」（财研"编造准则条号"、法研"杜撰判例"、设计大师"紫粉渐变/em-dash"）；
- `## 交付前自检`（Pre-Flight）：条目尽量可机械判定（"☐ 每个数字能定位到 `文件#sheet` 级"而非"数据要可溯源"）。与 tests/cases 互补：测试是外部验收，Pre-Flight 是技能内嵌门禁；
- `## 不适用范围（转介给谁）`：taste-skill 明确"不做 dashboard，去用 Fluent/Carbon"——防技能被误路由。
→ 落点：`templates/skill-template.md`、`templates/soul-guide.md`（加"写反默认，不只写正面原则"）、优先落财务/法务/电气等红线专家包。

### B5 · 技能 TDD：baseline 先失败
superpowers writing-skills 的 RED-GREEN-REFACTOR：写技能前先跑压力场景**看着 agent 无技能时违规**（记录具体话术），技能写完复跑对照。"If you didn't watch an agent fail without the skill, you don't know if the skill teaches the right thing." Soul 的 tests/cases 目前只测"有技能后的行为"，缺 baseline 对照——溯源红线这种最容易被 rationalize 的规则最需要。
→ 落点：`templates/test-case-template.md` 加 baseline 段；`src/services/eval/` 支持无技能/有技能对照跑。

### B6 · 大规则集走「结构化数据 + 检索」不塞 prompt
ui-ux-pro-max（99k star）：161 条规则在 CSV（五元组：类别/推荐/must_have/if_X 条件/反模式/严重度），SKILL.md 只是薄检索层——规则可长到几百条而不撑爆上下文。Soul 的 shared/design-systems 73 套语料正对应：为设计大师做一份行业→设计决策表，技能指令"先查决策表再出方案"（复用已有 BM25 检索，**不引入它的 search.py**）。
→ 落点：`shared/design-systems/` 决策表 + design-master 技能。

### B7 · 检索工具默认回元数据、全文按需取
借 codebase-memory-mcp "99% token" 的真实机制翻译到文档域：`search_knowledge` 默认返回 anchor + 命中片段 + 评分，agent 需要细节再显式取正文。与 A1 的 anchor 结构天然配套。
→ 落点：ToolRouter 检索工具返回契约。

### B8 · 摄取管线小项
- markitdown 做长尾格式底座（**EPUB**——已知缺口、docx/pptx/html），`pip install 'markitdown[all]'` 一行接入 book-to-skill 前置；**绝不能替换 query_excel 管线**（它丢单元格地址/合并格/公式，撑不起 `文件#sheet` 溯源，只能当降级视图）；扫描 PDF 保留自研 Vision OCR（markitdown 内置无 OCR）；
- 知识索引持久化 + 增量重建：文件 hash 入 better-sqlite3，改哪个重嵌哪个（零新依赖）；
- 复杂跨文件问答可加多路 fan-out 检索（每路结果带 anchor，与红线兼容）。

---

## 3. Tier C — P1 渠道落地的设计输入（做 P1-1/P1-4 时取用）

借自 OpenClaw（381k star，docs 六板块实读）。这批不是新工作项，是给 roadmap P1 已规划项的**具体形状**：

| # | 借什么 | 落到 P1 哪里 |
|---|---|---|
| C1 | **bindings 确定性路由**：`{avatarId, behaviorMode, match:{channel, chatId/userId}}` 纯配置规则，最具体优先（peer > group > account > channel > default），零 LLM 参与；行为模式/guardrails 档位是 binding 的一部分（"飞书某群 = 财研 + 只读模式"一条规则说完） | P1-4「渠道级配置选择分身」 |
| C2 | **dmPolicy=pairing 默认配对**：陌生人收配对码（1h 过期、每渠道 ≤3 pending）、桌面端批准、名单本地落盘；群聊 `requireMention` 默认只应答 @。企微/飞书组织身份 ≠ 可指挥分身，仍需 pairing | P1-4 IM 侧鉴权 |
| C3 | **session 映射规则**：群→按群一线程；DM→per-channel-peer 隔离（OpenClaw 的"DM 共享主 session"是单主人假设，Soul 多人可达必须取更严默认）；定时任务每次新线程；聊天内 `/new` `/reset` `/status` | P1-4「渠道消息创建或续接线程」 |
| C4 | **Gateway 基线三件套**：默认 bind 127.0.0.1 + token 鉴权 + `POST /runs` 要求 Idempotency-Key（IM 重试/webhook 重投不重复起 run）；写一页 exposure runbook（Tailscale 优先于 LAN） | P1-1 Gateway API |
| C5 | **origin 信任分级**：run-plan 加 `origin: desktop \| channel:<id>`，guardrails 按 origin 查表——channel 来源的灰名单工具默认 deny 或降级为 IM 内回复确认；「会话级始终允许」仅对 desktop origin 生效。另抄 `security audit` 成 `soul gateway audit` 一键自检 | 已有 guardrails/灰名单扩展 |
| C6 | **信任边界诚实声明**：明写"一个 Gateway = 一个信任域，多信任域 = 多实例，不靠 prompt 隔离"——接企微/飞书后必被问"全公司共用一个分身吗" | P1 文档 |

**不借**：进程内无沙箱插件生态（OpenClaw 最大安全软肋，Soul 声明式 md 技能是优势别放弃）；IM 来源开 exec/shell；私有协议逆向的个人号桥接（微信个人号外挂封号风险，走企微/飞书/钉钉官方 bot API）；22+ 渠道大而全（P1 三个 adapter + 把 envelope 接口设计对）。

---

## 4. 全局不借清单（跨项目汇总）

| 东西 | 为何不借 |
|---|---|
| ECC 整体 | 是"使用纪律文档 + 配置集"，Soul 是运行时，自动机制已领先它 |
| 知识库建图（实体图谱） | 代码有 AST 可确定性建图，散文没有；LLM 抽实体贵/不稳/难增量；BM25+向量已覆盖 Soul 负载（与既有 RAG 方向结论一致） |
| SurrealDB / 换数据库 | better-sqlite3+JSONL 已够，迁移纯负收益 |
| supermemory 引擎 / Derives / 静默遗忘 | 闭源不可审计；推断事实与删除不留痕都撞溯源红线 |
| superpowers 强制 bootstrap（每会话注入全文） | 本质是 hook 总线+固定 prompt 税，Soul 摘要注入已解决同一问题 |
| `allowed-tools` frontmatter 字段 | 规范自标 Experimental，Soul 工具授权在 runtime 灰名单层做更合适 |
| Kompress ML 压缩 / proxy 网关 | 体积/内存不现实；ML 改写数字撞红线；多一跳故障面 |
| Hermes 激进 skill review + curator 双系统 | 与「宁拒答不占位」相反；克制写入省掉整个代谢子系统 |
| taste-skill 单文件巨型 SKILL.md 常驻 | Soul 是按需加载体系，巨型技能挤占上下文；反模式/清单拆小或进 knowledge |

---

## 5. 建议执行顺序（首批切片）

按「风险敞口 × 依赖现成设施 × 工作量」排：

1. **A2-1/A2-2 soul-sync 扫描门禁**（S，独立脚本，当前供应链敞口为零防护）
2. **A3-5 inflation guard**（~5 行）+ **A3-3 cache 对齐批量压缩**（S-M，直接省真金白银的 cache miss）
3. **B3 validator 脚本**（S，顺手消掉 10+ 个 skill-index 手工漂移）
4. **A1 溯源闭集校验**（M，verifier 已 live，检索工具返回结构加 anchor）
5. **A4 记忆改造**（M-L，分身产品力核心差异点；dormant memory/* 有了设计蓝本）
6. **A3-1/A3-2 CCR + 确定性压缩**（M-L，BR-2 敢默认开的前提）
7. B1/B2/B4（模板级，随专家包迭代滚动落）
8. Tier C 全部（挂在 P1 启动时）
