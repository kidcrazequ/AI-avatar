---
name: palantir-aip-foundry
description: >-
  Palantir Foundry AIP（Artificial Intelligence Platform）的权威知识技能。覆盖：AIP 是什么、九大应用模块选型
  （AIP Logic / Assist / Analyst / Chatbot Studio / Document Intelligence / Evals / Model Catalog / Threads / AI FDE）、
  LLM 提示工程七大最佳实践、支持的模型清单与「自带模型」(BYOM/注册模型 + ChatCompletion 函数接口 + LLM 兼容代理 API)、
  AI 伦理治理与安全隐私红线、Token→compute-second 计量公式、LLM 容量管理与可观测性、以及功能启用/管理方式。
  当用户问及 Palantir AIP / Foundry AI、某个 AIP 模块怎么用或何时用、如何接入自有/第三方模型、AIP 计费限流容量、
  AIP 治理合规与数据安全时使用。回答必须标注来源文档页；源文档未覆盖的内容显式标注 GAP，禁止编造模型清单、费率或治理原则。
---

# Palantir Foundry AIP · 知识技能（公共版）

> **级别**：[■■■] 专家
> **版本**：v1.0
> **最后更新**：2026-06-02
> **来源**：系统抽取并合成自 **24 篇** Palantir Foundry AIP 官方文档页（`palantir.com/docs/foundry/aip/*` 及各应用模块 `overview` 页），经完整性审校与抽样复核。每条事实标注来源页；源文档未覆盖处显式标 **GAP**，不臆造。完整 URL 见文末「来源文档」。

---

## 技能说明

把 Palantir Foundry AIP 的官方文档知识结构化为可检索的参考，使分身能**准确**回答「AIP 是什么 / 该用哪个模块 / 如何接入自有模型 / AIP 怎么计费限流 / AIP 的治理合规红线」这类问题，并把每个结论锚定到具体文档页。

## 触发条件

在以下场景应读取并遵循本技能：

- 用户问 **Palantir AIP / Foundry AI / AIP 平台**是什么、能做什么、和 Foundry/Apollo 的关系。
- 用户问某个 **AIP 模块**（Logic / Assist / Analyst / Chatbot Studio / Document Intelligence / Evals / Model Catalog / Threads / AI FDE）的用途、能力、何时选用、彼此区别。
- 用户问 **接入模型**：支持哪些 LLM、如何「自带模型」(BYOM / 注册模型 / ChatCompletion 函数接口 / LLM 兼容代理 API)。
- 用户问 **AIP 计费 / 限流 / 容量**：token 计量、compute-second、TPM/RPM、容量层级、预留容量、自动扩容。
- 用户问 **AIP 治理 / 伦理 / 安全 / 隐私 / 合规**：第三方模型数据保证、责任 AI 原则、可解释性/可追溯性控制、地域限制。
- 用户问 **AIP 提示工程最佳实践**。
- 用户问 **如何启用 AIP 功能**、管理员权限模型、按模型启用。

**触发关键词**：Palantir、Foundry、AIP、AIP Logic、AIP Assist、AIP Analyst、Chatbot Studio、Agent Studio、Document Intelligence、AIP Evals、Model Catalog、AIP Threads、AI FDE、Ontology、BYOM、自带模型、注册模型、registered model、ChatCompletion、compute-second、TPM、RPM、责任 AI、prompt engineering、Supported LLMs、LLM proxy。

---

## 使用本技能时的硬规则（回答前必读）

1. **事实必标来源页**。每个结论/数字/能力点，行内标注来自哪一篇文档页（如「(来源: Compute usage with AIP)」）。这是 Palantir 文档的二手合成，不是用户的私有知识库。
2. **不编造、宁可标 GAP**。模型清单、compute 费率、责任 AI 原则名称、模块能力——源页没写就明说「文档未列出 / 待查实时页」，**禁止**自行补全或推断 provider/数字。
3. **hub 页只给框架**。`AIP overview`、`AIP features`、`AIP observability` 等是导航/框架页，深层操作步骤在其**子页**。用户问到操作细节而本技能只有框架时，明确提示「需查对应子文档页」。
4. **带免责声明**：多数模块页都声明 *AIP feature availability is subject to change and may differ between customers*；数据集成以 **Foundry enrollment** 为前提。回答涉及「某客户是否有某功能」时带上这句。
5. **选型先走 Module Map**（§2）。用户说「我要做 X，用哪个」时，先用模块地图路由，再展开。
6. **时效提醒**：模型清单与费率随版本更新（本技能快照 = 2026-06）。涉及「现在支持哪些模型 / 当前费率」时提示以 `Supported LLMs` / `Compute usage` 实时页为准。

---

## 1. AIP 是什么

**AIP（Artificial Intelligence Platform）** 是 Palantir 把 AI 与组织的**数据和运营**连接起来、在运营流程中驱动自动化的平台，受众覆盖从开发者到一线用户（来源: AIP overview）。三大核心搭建工具——**AIP Logic、AIP Chatbot Studio（原 AIP Agent Studio）、AIP Evals**——在 **Ontology** 上构建可投产的 AI **工作流、agent 和 function**（来源: AIP overview）。

AIP 处在一个更大的「操作系统」中：**AIP + Foundry（数据运营）+ Apollo（自治软件部署）**，覆盖从 LLM Web/移动应用（含视觉语言模型）到边缘应用（来源: AIP overview）。

**官方反复强调的安全/治理底色**：AIP **继承 Foundry 的全部安全机制**——访问控制、加密、审计、治理/血缘——而非绕过它们（来源: AIP Security and Privacy）。各模块页反复强调 AIP 在「与平台其余部分相同的严格安全模型」下运行，LLM 只获得**完成任务所必需的最小权限**（least-privilege，AIP Logic / Chatbot Studio / Assist 均明确）。责任 AI 被定位为「**贯穿系统全生命周期、内建于技术之中**」，而非事后合规附加（来源: AI Ethics and Governance）。

overview 列出六大收益主题：无缝数据集成；安全与治理；模型管理（带版本控制的 build/train/deploy）；可扩展性与性能（分布式算力、细粒度资源控制）；可解释性与透明度（审计轨迹、解释、evals）；快速上手（来源: AIP overview）。

> **免责声明（多页通用）**：AIP 功能可用性随时变化、因客户而异；数据集成以 Foundry enrollment 为前提。

---

## 2. 模块地图（Module Map）

| 模块 | 做什么 | 何时选它 |
|---|---|---|
| **AIP Logic**（AIP Logic Overview） | 无代码环境，**构建/测试/发布 LLM 驱动的 function**（基于 Ontology），免去传统开发与 API 复杂度；含提示工程、测试、评估、监控、自动化。输出 = **Ontology 编辑** 和/或 **字符串返回**。 | 需要一个可投产、受治理、可复用的 AI **function**（如把非结构化输入连到 Ontology、解排程冲突、优化资产配置、应对供应链中断），点选式搭建。 |
| **AIP Assist**（AIP Assist Overview） | 平台内 **LLM 助手/支持工具**，基于 Palantir 文档训练，用 NLP + 第三方 LLM 在侧边栏回答自然语言问题。四种模式：AIP Assist（默认）/ Platform Documentation Assist / Developer Assist / AIP Chatbots。上下文感知、多语言、**不访问你的数据**。 | 终端用户需要平台使用/搭建帮助，或想用自定义 Notepad/Markdown 文档、聚焦型自建 chatbot 扩展帮助。导航栏或 **Cmd/Ctrl+Shift+U** 打开。 |
| **AIP Analyst**（AIP Analyst Overview） | 自然语言 **Ontology 即席分析 agent**：搜索 ontology、建/转对象集、跑聚合、ontology/dataset SQL、执行 function 与 ontology action，并产出摘要 + Vega 图表 / 地图 / Mermaid。**支持上传 Excel/CSV/Word(DOCX)/图片/PDF 及 Foundry media set，支持语音输入**。 | 非开发者要做探索性/地理空间/竞品分析或 ontology SQL，不想写代码。注意：action **需审批、可回滚**；**会话关闭后不保留对话历史**（建议保存 query 与 Vega-Lite 代码）；Memory 需 Palantir 支持开启。入口 `/workspace/aip-analyst`。 |
| **AIP Chatbot Studio**（AIP Chatbot Studio Overview） | 搭建交互式 AI 助手（「AIP Chatbots」）的开发平台，由 **LLM + Ontology + 文档 + 自定义工具**四要素驱动；支持上下文感知的**读与写**工作流。可内/外部部署（Ontology SDK / 平台 API），可嵌入 Workshop。 | 需要可复用、可部署、扎根 Ontology/文档/工具的企业级助手，自动化任务、减少手工操作。即原 "AIP Agent Studio / AIP Agents"。 |
| **AIP Document Intelligence**（AIP Document Intelligence Overview） | 「Foundry 所有文档抽取工作流的入口」：打开 media set，跑抽取策略（Raw text / OCR / Layout-aware OCR / VLM 生成→Markdown），评估质量·速度·token 成本，分块，再**一键部署为批处理 Python transform**。 | 需要从企业文档（PDF、扫描件）抽文本/结构并把策略产品化为批处理管线。Raw text 仅限电子版 PDF；layout-aware OCR 保留结构；VLM 消耗 token。 |
| **AIP Evals**（AIP Evals Overview） | 评测环境，针对 LLM 的非确定性评估 **AIP Logic function / Chatbot function / 代码编写的 function**。Evaluation suite = 测试用例（输入-输出对）+ 目标 function + 评估 function（产出指标）。可与 AI FDE 集成（对话式创建 suite）。 | 要在投产前验证 prompt/function 改动、对比模型、度量 run-to-run 方差、建立部署信心。 |
| **AIP Model Catalog**（Model Catalog Overview） | **发现/评估/对比/试用 Palantir 提供的 LLM** 的 AIP 应用。三视图：Homepage（发现）、Entity Page（Playground + "How to use it" + 描述：上下文窗口/token 上限/训练截止）、Comparison（两个 LLM 同任务对比，completion 或 vision）。可按 lifecycle/type/creator 过滤。**仅 LLM，不含自定义 ML/AI 模型**。 | 选型/基准某个可用 LLM、理解生命周期状态（Experimental / Stable-GA / Sunset / Deprecated）、区分 completion / embedding / vision 模型——**这套能力类型与生命周期分类以本页为准**。 |
| **AIP Threads**（AIP Threads Overview） | 轻量无代码生产力工具，做**即席 LLM 任务**：拖入 PDF（或选组织自建的 AIP Chatbot）做快速、迭代、跨语言的问答/摘要/对比。**Beta**（经 Palantir Support 开通）。 | 用户想要零搭建的快速文档问答（技术手册、供应商沟通、政策/法规、HR 制度）。重复/复杂工作流应改用 AIP Chatbot Studio。需启用 AIP + AIP custom workflows。 |
| **AI FDE**（AI FDE Overview） | 通过**对话指令操作 Foundry** 的 agent——把意图翻译成原生操作（管线、ontology 编辑、function、治理审计、OSDK React 应用）。闭环（执行→观测预览/CI→以 Global Branch 提案或 Code Repo PR 提交）。**始终尊重用户既有权限**。 | 想让 agent 在 Foundry 里**干活**（建/改管线、编辑 ontology、写 Logic/TS/Python function、审计治理、建 OSDK 应用），在评审门控、权限受限下进行。需启用 AIP；ontology 编辑建议开 Global Branching。 |

---

## 3. 核心平台概念（按文档定义）

- **Ontology** — AIP 搭建工具构建可投产工作流/agent/function 所依托的数据与运营模型（来源: AIP overview）。它是「接地基质」：Logic function 读取并写入编辑；Analyst 在其上搜索/聚合/SQL；AIP Chatbot 以它为四要素之一。
- **AIP 接你的数据 / Ontology grounding** — AIP 的价值被表述为「把 AI 连接到组织的数据与运营」（来源: AIP overview）。AIP Chatbots 明确「由四样东西驱动：LLM、Ontology、文档、自定义工具」（来源: AIP Chatbot Studio）。**GAP**：字面短语 "AIP-on-your-data" 未在源文档出现，grounding 概念通过 Ontology 集成语言表达，而非一个具名功能。
- **Agents** — 文档中两类 agentic 界面：**AI FDE**（用原生工具操作 Foundry，闭环，基于分支提案）与 **AIP Analyst**（自治搜索 ontology、建对象集、执行 function/action、可视化）；AIP Chatbots 则是带工具、可读写的交互助手（来源: AI FDE / AIP Analyst / AIP Chatbot Studio）。
- **Functions** — AIP Logic 产出 **Logic function**：集成 Ontology 对象，输出 Ontology 编辑 和/或 字符串，受 user + function 权限治理（来源: AIP Logic Overview）。Ontology SDK 让 Python/Java/TypeScript 应用内建访问 Logic function；Functions、Transforms、Code Workspaces 提供对 Palantir LLM 的访问（来源: AIP Features）。
- **AIP Logic Tools（最小权限的具体载体）** — Logic function 通过「Tools」把**特定 Ontology 数据/操作**授予 LLM block，从而把 LLM 的访问限制在必要范围内；也是可解释性控制之一（Debug View 可见其编排）（来源: AIP Logic Overview / AI Ethics and Governance「AIP Logic Tools」）。
- **Object set**（AIP Analyst） — 通过 filter / search-around / 语义搜索构建的、可从既有 Foundry 对象集导入的、经过滤/转换的 ontology 对象集合（来源: AIP Analyst Overview）。
- **Closed-loop operation**（AI FDE） — 模型执行 action、观测结果（transform 预览、function 预览、CI 检查）、据反馈决定下一步（来源: AI FDE Overview）。
- **嵌入式 AIP 功能** — 搭建/开发工具：AIP Chatbot Studio、AIP Logic、Pipeline Builder、Ontology SDK、Palantir MCP。嵌入式 LLM 功能：Pipeline Builder 的 **Use LLM Node**、**Trial Runs**、**Text to Embeddings**(text-embedding-ada-002)、Assist(Explain / Regex Helper / Transform Assist)；**Automate**（由 Logic 构建自动化、暂存/应用 ontology 编辑供人审）；**Notepad**（拼写/缩写/改写/翻译）；**Scheduler**（自然语言→schedule/cron）（来源: AIP Features）。
- **Palantir MCP** — 把外部 AI IDE/agent 接入平台，使其能借 ontology 上下文查询数据、访问文档、构建应用（来源: AIP Features）。

---

## 4. LLM 提示工程最佳实践

> 来源: **Best practices for LLM prompt engineering**。核心命题：设计输入以引导 LLM 产出期望结果；**提示质量直接影响回答的相关性、准确性与连贯性**。七大策略——逐条以祈使句列出每个具体手法：

**① 清晰具体（Be clear and specific）**
- 用直接、有针对性的语言定义任务（用「Summarize framework options for web development」而非「What do you know about coding?」）。
- 用背景/角色锚定提示（如「As a software engineer, explain the benefits of abstraction」）。

**② 精炼迭代（Refine and iterate）**
- 测试不同的提示结构。
- 先宽后窄：回答太发散就收窄。
- 把模型输出回喂为反馈回路来改进措辞。

**③ 用示例（Use examples）**
- 给「输入→输出」样例演示期望输出（如 "Hello" → "Bonjour"）。
- 建立模板/模式以保证结构一致（如「For each fruit, list color and taste. Example: Apple - Red, Sweet」）——即 few-shot。

**④ 管理长度与复杂度（Manage length and complexity）**
- 简洁，只含必要细节（要简短历史摘要，别要机器人学全史）。
- 把复杂任务拆成顺序步骤（先列半导体制造步骤，再逐步解释）。

**⑤ 加入约束（Incorporate constraints）**
- 设明确边界（如「Summarize in no more than three sentences」）。
- 用显式排除剔除不想要的输出（如「List pros/cons of remote work, excluding personal opinions」）。

**⑥ 提供相关上下文（Provide relevant context）**
- 让提示契合模型的强项与局限（向医学训练过的模型问症状，别问无关主题）。
- 让提示匹配模型的训练数据（如「Discuss recent AI advancements」）。

**⑦ 优化交互（Optimize the interaction）**
- 赋予 persona/角色以引导语气与深度（如「As a mechanical engineer, describe critical sensors for manufacturing」）。
- 复杂回答用顺序式/多步提示。

> 该页外链 Anthropic、Google、Microsoft、OpenAI 的提示工程资料。
> **范围提示**：本页只讲通用提示工程，不含治理、BYOM、模型清单或计量规则。

---

## 5. 支持的模型 + 自带模型（BYOM）

### 5.1 支持的模型版图（来源: Supported LLMs）

AIP 支持多家头部 provider 的 LLM 与文本嵌入模型；**可用模型因 enrollment 和地域而异**。源页快照（2026-06，**随版本变化，以实时页为准**）：

- **xAI Grok**：Grok-3、Grok-3-Mini-Reasoning、Grok-4、Grok-4-Fast(Reasoning/Non-Reasoning)、Grok-4-1-Fast(Reasoning/Non-Reasoning)、Grok-Code-Fast-1。
- **OpenAI / Azure**：GPT-4o、GPT-4o mini、GPT-4.1/4.1 mini/4.1 nano、GPT-5 系列（含 Pro/Codex/mini/nano）、GPT-5.1/5.2/5.3/5.4/5.5 变体、o1、o3-mini、o3、o4-mini。
- **Anthropic Claude**：3 Haiku 到 4.7 Opus（含 3.5/3.7 Sonnet、4 Sonnet/Opus、4.5/4.6 系列）。
- **Meta / 开源（Palantir 托管）Llama**：3 8B/70B、3.1、3.2 NV EmbedQA、3.3 70B、3.3 Nemotron Super、4 Scout/Maverick。
- **Mistral**：7B、Mixtral 8X7B、Small 24B。
- **Google Vertex Gemini**：2.0 Flash、2.5 Pro/Flash/Flash Lite、3 Pro/Flash、3.1 Flash-Lite。
- **文本嵌入模型**：OpenAI ada embedding、text-embedding-3-large、text-embedding-3-small、Snowflake Arctic Embed。

**可用性机制（来源: Supported LLMs）**：
- **Control Panel 模型状态**：*enabled*；*disabled*（待法律确认）；*disallowed*（地域限制或待审）。
- **可用前提**：AIP 集成完成；签署所需法律确认；enrollment 已为 custom workflows 启用 AIP；外部 provider 模型需地域可用性兼容；开源模型需额外 Palantir 工程评审；前端集成时间充足；实验模型需风险确认。
- **地域 georestriction 指 enrollment 设置，而非用户所在地**。跟踪区域：US、EU、UK、CA、AU、JP、KSA、IL2、IL4、IL5（九区）。Palantir 托管开源模型（如 Llama 3.1 8B / 3.3 70B / Mixtral 8x7B）与 GPT-4o 覆盖全部九区；较新的 GPT-5 系列与 xAI Grok 更受限（常偏 US）；个别（如 GPT-5 Pro）在表中无地域可用性。
- 速率限制单独治理，见 LLM capacity management。

> **能力类型与生命周期分类的归属**：completion / embedding / vision 三类划分与 Experimental/Stable-GA/Sunset/Deprecated 生命周期状态来自 **Model Catalog** 页；`Supported LLMs` 页只单列出 embedding 一节，不按能力类型归类。引用「视觉/嵌入区分」时锚定 Model Catalog，别张冠李戴。

### 5.2 自带模型 —— 当前「注册模型 / registered models」路径（来源: Bring Your Own Model）

BYOM 品牌名 = **「registered models」**。**仅在**法律/合规原因导致无法用 Palantir 提供的模型、或你有自定义微调 LLM 时推荐；否则优先用 Palantir 提供的模型（OpenAI、Azure OpenAI、AWS Bedrock、xAI、GCP Vertex）或自托管开源（如 Llama）。平台提供：模型选择、权限、限流、用量可观测。

**两阶段注册**：
1. **Data Connection REST API source** — 配置指向 provider 端点的 REST API source（base URL、认证、端口），**打开「Enable exports to this source」**。需 Enrollment-admin + 该 source 的 Owner/Editor。
2. **Control Panel 注册** — **AIP settings → Registered models 标签 → "Register a model"**；选 source RID；填 provider 名、模型名、API 端点路径；声明**每端点能力**（Reasoning、Structured outputs、Tool calling）；设 **Enrollment 限流**（max req/min 或 tokens/min）与 **User 限流**（按用户，用于 AI FDE / AIP Analyst / 用户归属应用）。再启用注册模型访问（全 enrollment 或指定用户组）。模型随后出现在模型选择器的 "Registered models" 下。

**注册模型的治理 / 计费**：
- 注册后与底层 Data Connection source **解耦**——终端用户无需 source 权限；访问由 Control Panel 启用治理。
- 仅 **Enrollment 管理员**可注册/编辑/删除/禁用注册模型。
- **项目级限流默认 = enrollment 限额的 70%**（Resource Management → "AIP usage and limits"）。
- **Palantir 不额外收平台费**；provider 直接计费，成本**不出现**在 Resource Management。
- 注册模型**当前不支持 Markings**；访问控制 = Control Panel 启用 + Resource Management 项目级容量分配。
- **支持范围**：AI FDE、AIP Analyst、AIP Chatbot Studio、AIP Logic、Workshop（经 Chatbot Studio/Logic）、Code Repositories 的 TypeScript functions。
- **不支持（且无计划）**：AIP Assist（含 Code Repositories 代码助手）、Pipeline Builder Generate/Explain——这些原生助手依赖针对 Palantir 模型调优的 evaluation。
- **2026 年 3 月**版较旧法改进：集成更顺滑、原生支持 tool calling/reasoning、基建工具更好。

### 5.3 旧版 BYOM —— ChatCompletion 函数接口（来源: Register an LLM using function interfaces [Legacy] / Use registered LLM [Legacy]）

> **旧版 / 已被 registered models（2026-03）取代。Palantir 建议用函数接口注册前先联系 Support。**

- 把专有/微调/本地/云托管 LLM 接入 **AIP Logic 与 Pipeline Builder**（后者为 beta）。
- **两种连接方式**：(1) 从 TypeScript 调用的 Data Connection **webhook**（教程示例 OpenAI "Create chat completion" / `CreateChatCompletion`）；(2) **直连 REST API source**，在 TS function 里 `fetch`。
- **接口**：实现 `ChatCompletion` 函数接口（`@palantir/languagemodelservice/contracts`），用 `@ChatCompletion()` 装饰一个 TS 方法，签名 `(messages: FunctionsGenericChatCompletionRequestMessages, params: GenericCompletionParams)`，返回 `Promise<FunctionsGenericChatCompletionResponse>`。把 provider 响应映射为 `{ completion, tokenUsage }`（promptTokens / completionTokens / maxTokens 取自 provider 的 `total_tokens`）。仅 SYSTEM/USER/ASSISTANT 角色被转换（其他抛 "Unsupported role"）。
- **直连 source egress**（Pipeline Builder BYOM 暂不支持 webhook）：用 `@ExternalSystems({sources:[MySourceApiName]})` 装饰，调 `MySourceApiName.getHttpsConnection().url` / `.getSecret()` / `.fetch()`。
- **限流传播以触发自动重试**：在 function 的 `FunctionsResult` 返回类型上声明 `ChatCompletionError`；遇限流返回 `FunctionsResult.err('LanguageModel:RateLimitExceeded', { retryAfterMillis: 20000 })`。AIP Logic / Pipeline Builder 随后以**指数退避 + 抖动**重试（OpenAI 示例：捕获 HTTP 429 并传播）。
- **消费**：AIP Logic 中 "Use LLM" board → "Registered" 标签；Pipeline Builder 中 "Use LLM" transform → Show configurations → Model type "Registered" 标签。

### 5.4 LLM-provider 兼容代理 API（来源: LLM-Provider Compatible APIs）

Foundry 暴露**镜像各 provider 原生 API 格式的代理端点**，使现有/开源 provider SDK 不改动即可用，同时经 Foundry 路由以做限流、数据治理、用量追踪。

- **基础路径**：`/api/v2/llm/proxy/{provider}/...`
- **支持的 provider / API 类型**：Anthropic **Messages**(`/anthropic/v1/messages`)；OpenAI **Chat Completions**(`/openai/v1/chat/completions`)、**Responses**、**Embeddings**；xAI **(Beta)** Chat Completions & Responses；Google **(Beta)** `generateContent` & `streamGenerateContent`。
- **认证**：HTTP bearer —— `Authorization: Bearer {FOUNDRY_TOKEN}`。非标准认证头的 provider（如 Anthropic）须配置为改发 bearer；bearer-native（OpenAI）无需特配。
- 请求体须匹配**原生 provider 端点形状**（查各 provider 文档）。
- Google `streamGenerateContent` **仅支持 SSE**，需 `alt=sse`。
- **强制治理**：零数据保留（ZDR）、georestriction、仅路由已启用模型、Resource Management 用量可见、限流。
- **前提**：enrollment 已启用 AIP + 有使用 AIP builder 能力的权限。

---

## 6. 伦理 / 治理 / 安全 / 隐私 —— 硬红线

### 6.1 安全与隐私（来源: AIP Security and Privacy）

- **AIP 继承 Foundry 全部安全**：访问控制、加密、审计、治理/血缘。AIP **不绕过**它们。
- **第三方模型 provider 的数据保证**（页面以 Q&A 散文形式陈述的承诺，非一份正式枚举 SLA，引用时勿夸大为合同清单）：
  1. prompts/completions 中的客户数据**不被**第三方保留；
  2. 客户数据**不用于**重训模型；
  3. 第三方 provider 人员**无法**访问 prompts 或 completions；
  4. 传输数据在 **prompt 完成后立即丢弃**。
- 启用任何新模型前，Palantir 同时取得**技术与合同保证**（DPA / BAA 为常规；处理任何个人数据前签署）。
- **地域端点**尽量就近以降延迟；当前部分模型的区域 = **US、UK、EU**。地理限制取决于 provider 技术限制、可能变化。
- provider 持有 **ISO 27017、SOC 1/2/3、CSA STAR** 等认证。
- LLM 在**隐私、偏见、人类判断**上同时带来机会与风险，必须纳入考量。

### 6.2 责任 AI 框架（来源: AI Ethics and Governance）

页面把责任 AI 组织为若干核心主题：**Equitable、Explainable、Reliable、Traceable、Collaborative、Accountable、Human-Centered**（页面文字称 "eight core themes" 但实际枚举为七节——源文内部表述不一致，按列出的七个主题理解）。每个主题映射到具体平台功能：

- **Equitable**（公平/无偏/不歧视）：Sensitive Data Scanner（自动识别受保护属性/偏见源）、Modeling Objectives 的 Subset Evaluation（按人群比较性能）、AIP Evals、Data Health Monitoring；缓解靠重采样 / 代表性数据 / 调整算法。
- **Explainable**（"AI 不应是黑箱"）：Modeling Objectives Evaluation Dashboard（特征重要性）、AIP Evals、**AIP Logic Tools**（委派给可解释工具而非纯靠 LLM）、AIP Logic Debug View（思维链 + 工具编排可见）、AIP Observability。
- **Reliable**：Model Deployments（自动/手动升级）、Functions Versioning/Release Management（语义化版本 + 向后兼容检查）、Rollback、Access Controls + Data Markings、**Georestrictions**、加密（at rest & in transit）、**Capacity Limits**（吸收用量尖峰）。
- **Traceable**：Data Lineage、Workflow Lineage、Audit Logs（所有交互/评估/部署决策）、Modeling Objectives 文档、Notepad 文档模板、经 Resource Management 的 LLM 成本治理。
- **Collaborative**：Role-Based Permissions、Code Workspaces/Repositories、Workshop、External Data Sharing/Collaboration Controls、no-/low-/pro-code 评估框架。
- **Accountable**：细粒度权限管理（组/角色）、完整审计轨迹（谁在何时决定了什么）、结构化审批工作流（checks）、**Checkpoints**（对 AI 建议决策集中确认 + 说明理由）。
- **Human-Centered**（"增强而非替代人类决策"）：Ontology-Based Decision Support、Human Oversight Workflows（ontology action/审批）、仪表盘、带 Checkpoints 的自动化、**Opt-Out and Fallback**、Feedback Loop Integration。

**七条责任 AI 原则**（来源: AIP Security and Privacy 明确「Privacy and Civil Liberties Team 定义了七条原则」；其内容与 Ethics 页的「七条上手准则」一致——同一组清单）：
1. 着眼**完整集成系统**而非单个组件工具（用 Data Lineage + Pipeline Builder）；
2. **承认技术的局限**（problem-first 建模）；
3. **不去解不该解的问题**（有些技术可行但不宜优化的问题，须按法律/伦理/社区规范评估）；
4. 遵循**稳健数据科学的方法论最佳实践**（偏见检测/公平性工具）；
5. 让 AI **负责、可问责、以人为本**；
6. 推动**多方利益相关者参与**；
7. 确保**技术、治理、文化三重意识**。

> （上一版合成曾把这七条标为「未具名 GAP」——**那是错误的**，源文档确有具名枚举，已在此更正。）

**advisor 必须守的硬规则**：
- **不解不该解的问题**——技术可行 ≠ 应当优化，按法律/伦理/社区规范评估。
- **AI 增强而非替代人类决策**——关键决策经 oversight workflow / checkpoint / opt-out 留在人手中。
- **AI 不应是黑箱**——用户应尽量理解其运作。
- 可靠性/安全在**全生命周期**评估；加密（at rest + in transit）与访问控制是核心。
- 需在 requests/responses 必须留在特定司法辖区时设 **Georestrictions**。
- **可问责**需明确角色 + 审计轨迹（谁何时决定了什么）。
- **可追溯**需记录开发过程、数据来源、数据 provenance 以备监管/内审。
- 须设 **Capacity Limits** 防用量尖峰致服务中断。

### 6.3 模块级安全规则
- **AI FDE**：一切操作**尊重用户既有权限**（应用 + 数据），agent 不能超越用户本就能做的；改动经 Global Branch 提案或 Code Repo PR（评审门控）。
- **AIP Logic / Chatbot Studio**：在平台安全模型下运行；LLM 获**最小权限**。
- **AIP Assist**：**不访问你的数据**；遵守 Palantir AI 伦理原则；依赖第三方 LLM（该页未具名 provider）。
- **AIP Analyst**：ontology action 执行**需审批、可回滚**。

---

## 7. 计量 / 容量 / 可观测性

### 7.1 Compute 计量（来源: Compute usage with AIP）

- 基本单位 = **token**（输入 + 输出）；平均 ~4 字符；与词**不是** 1:1；标点/空格也计入；定义因 provider 而异。
- token 换算为 **compute-seconds** 以跨 provider 统一定价。每模型有费率 = **每 1 万输入 token 的 compute-seconds** 与 **每 1 万输出 token 的 compute-seconds**。
- **费率随模型 + Foundry 云区域变化**，三区域：**North America；EU/UK；South America/APAC/Middle East**（来源: Compute usage with AIP，已实时复核区域名）。
- **公式**：`compute-seconds = tokens × (每万 token 费率) / 10,000`（输入 + 输出求和）。
- **算例**：140 字符 = 24 token；GPT-4o 北美 43 cs/万输入 → 24 × 43 / 10,000 = **0.1032 compute-seconds**（来源已实时复核）。
- 样例北美费率（输入/输出，每万 token）：GPT-4o 43/172；Claude 3.5 Haiku 12/62；Grok-3 55/273；Gemini 1.5 Flash 1.3/5.2；**GPT-5.4 Pro 545.5/3272.7**（高端模型贵得多）。
- **嵌入模型**（ada、text-embedding-3-small、Gemini Embedding 2）**无输出 token 成本（N/A）**，只计输入。
- **归属**：compute-seconds 直接挂到发起请求的应用资源（具体 pipeline / Logic function 等）；无法绑定资源时（如部分 AIP Assist / Error Explainer 调用），归到**发起用户的 folder**。
- **审计/导出**：经 Control Panel → Internal dataset export 导出 **"AIP Token Usage" 数据集**——按天给出模型/资源/token/compute-seconds/币种明细。
- **企业合同客户：进行 compute 计算前先联系 Palantir 代表。**
- **GAP / 数字提醒**：源页**未**写明费率表覆盖的具体模型数量（实时页无 "70+"/"90+" 字样——抽取与审校曾各报一个数，均不可考）。需精确数量时让用户查实时页，**勿引用具体计数**，可表述为「覆盖数十款模型」。

### 7.2 容量管理（来源: LLM Capacity Management）

- LLM 容量**全行业有限**；每个 provider（Azure、OpenAI、AWS Bedrock、GCP Vertex、xAI、Palantir Hub）按账号设上限。单位：**TPM（tokens/min）**与 **RPM（requests/min）**。
- 限额在 enrollment 层**按模型**设定，各模型容量独立。**同一模型多 backend → 限额相加**（Azure + OpenAI ≈ 翻倍）。
- **四档**：Small / Medium / Large / XLarge。**所有客户从 Medium 起步**（原型 + 多用例、数百用户、大数据集）。升级经 Palantir Support。地域受限 enrollment 在 Large/XLarge 的 TPM/RPM 可能更低。限额与档位见 **Resource Management 的 AIP rate limits 标签**。
- **"AIP usage & limits" 页**（Resource Management）：按模型看 token/request 用量、下钻单模型、enrollment vs project、用户归属用量、限流阈值可视化；保留最长两周分钟级历史；project/resource 切分仅 <6h 区间可用。
- **自动扩容**：至多 **2×** 当前分配，仅在特定地域/合规级别、且**仅对 GPT-5 / GPT-5 mini / GPT-5 nano / GPT-4.1 / 4.1 mini / 4.1 nano**（Palantir 验证过容量处），受稳定性检查约束。
- **项目级限流**（Manage rate limits 标签）：每项目每模型设 TPM/RPM 百分比上限。**模型 override** 覆盖基线——allowlist = 基线 0% + override；禁某模型 = override 0%。
- **预留容量（Reserved capacity）**：在 enrollment 容量**之外**为生产预留专属 TPM/RPM，按 project 按单模型；用尽后回落共享限额。**无服务费**——只算新增 token 用量。由 resource management 管理员配置；超默认分配联系 Support。
- **交互 vs 批处理**：**≥20% 容量预留给交互查询**，管线/批处理封顶 **≤80%**。AIP 通常**优先交互于批处理**。（交互 = Workshop、Chatbot Studio、AIP Logic LLM board 预览、Pipeline Builder LLM 节点预览；批处理 = Transforms 管线、Pipeline Builder、Automate for Logic。）
- **合规对容量的约束**：ZDR + georestriction。**直连 OpenAI 不支持地域限制**（可能全球路由；非受限客户容量更大），其 **Batch API 不可用**（需数据保留，与合规冲突）。Azure OpenAI / AWS Bedrock / GCP Vertex / Palantir 托管支持地域限制但容量保证较小，常需 **provisioned（月度预付）throughput**。
- **LLM 成本视图**：Resource Management → **Analysis 页**（按 source 过滤 All LLMs → 按 source 分组 → 按天按模型看成本）；usage-&-limits 视图**不**为成本优化。
- 历史上预留容量支撑 99.9% 可用；>99% 历史请求失败源于 enrollment/project 限流（可用预留容量解决）。

### 7.3 可观测性（来源: AIP observability）

AIP 可观测性 = **Workflow Lineage** 中一组能力，洞察 AIP & Ontology 工作流执行：
- **Metrics**：近实时成功/失败计数 + function/action/AIP Logic 的 **P95 执行时长**。
- **执行(Run)历史**：function、action、Automate、AIP Logic——**仅近 30 天**。
- **分布式追踪**：横跨 function、action、语言模型、自动化、ontology 加载的完整流程。
- **日志与调试**：服务日志、自定义 function 日志、**token 用量、prompts**、错误详情。
- **日志搜索**：跨某 source executor 的全部服务日志。
- **日志导出**到 Foundry 流式数据集做复杂遥测。
- **上手**：在 Workflow Lineage 打开 function/action/automation → Run history 标签 → 某次执行 "View log details" → 确保已配 **log 权限**。

---

## 8. 启用 / 管理（来源: Enable AIP Features）

- **新 enrollment 默认开 AIP**；**2024 年前建立的 enrollment 需在 Control Panel 手动激活**。
- **仅 enrollment 管理员**可管理 AIP 配置，位于 **Control Panel → AIP settings**。**启用 AIP 可能触发额外 compute 计费**。
- **三类能力**：AIP Assist；平台应用内的 Assistant 功能；面向开发者的 AIP custom workflows 能力。
- **两级权限模型**：
  - **Level 1（AIP & Core Assistant Features）**：启用 AIP Assist + Code Repositories / Pipeline Builder / Workshop 的 assistant 功能。
  - **Level 2（AIP capabilities for custom workflows）**：单独启用——解锁 AIP Logic / LLM Board、Pipeline Builder LLM 节点 + Text-to-embeddings、AIP Automate、AIP Model Catalog、AIP Chatbot Studio、AIP Workshop widgets（Chatbot、Generated Content）、Workshop 翻译、Quiver、AIP Threads，以及 Code Workspaces 里用 LLM 的代码 Transforms/Functions 与 Jupyter。
- **custom-workflow 访问范围**：Everyone / Given User Groups / Nobody。
- **Org 门控**：仅当资源所在 project 的**全部 organization markings** 都启用了 AIP，该资源才算「启用 AIP」。**"Restrict AIP To Organizations" 是黑名单**——未选中的 Org 失去 AIP；enrollment 级禁用 AIP 则**所有 Org 都无访问**，与 Org 级设置无关。
- **按模型族启用**：AIP settings → **Model enablement 标签**。状态：**Enabled**（活跃）；**Disabled**（可用但未激活——管理员选 "Manage"、接受条款、再激活）；**Disallowed**（受法律/地理/基建限制——需 **Palantir Support**）。可按 Org 配置。
- **禁用某模型族组会破坏**依赖该组模型的工作流。
- **实验模型**仅当「Enable experimental models」开关开 **且** 父模型族已启用时才可见。
- 部分应用（如 **AIP Logic**）需在 **Control Panel → Application access** 单独启用。

**模块启用要点**：
- **AIP Assist**：仅当管理员在 Control Panel 启用 AIP 后可用。
- **AIP Threads**：需 AIP **且** AIP custom workflows；**beta**，经 Palantir Support 开通。
- **AI FDE**：需启用 AIP；ontology 编辑**建议**（非强制）开 Global Branching；联系 Palantir 管理员开通；须为 enrollment 配好启用的模型。
- **AIP Model Catalog**：Control Panel 启用；管理员可禁用 Experimental 模型，使仅 Stable 生命周期模型可见。
- **AIP Analyst Memory**：需 **Palantir Support** 开启。

---

## 9. 上手路径（来源: Get Started with AIP）

该页是薄 hub，指向 Palantir Learning portal（learn.palantir.com），建议**先学课程再读技术文档**：
1. **Introduction to Foundry & AIP for Enterprise Organizations**——平台基础认知。
2. **Scoping Use Cases for Foundry & AIP**（~15 分钟）——用例界定与优先级。
3. **Speedrun: Your First AIP Workflow**（~60–90 分钟）——端到端搭一个 AI 助手（PDF 抽取 + ontology 集成 + chatbot 配置 + 应用开发）。

---

## 反模式（禁止）

下列回答会被判定为失败：

❌ **编造模型清单/费率/原则**——`Supported LLMs`/`Compute usage`/`Ethics` 没列的就标 GAP、让用户查实时页，**不**自行补全 provider、数字或原则名。
❌ **拿 hub 页当操作手册**——overview/features/observability 只给框架；操作细节在子页，要明说「需查子文档页」。
❌ **来源笼统**——不要「来源：Palantir 文档」一句覆盖整段；每条事实标到**具体页名**（如 "AIP Security and Privacy"）。
❌ **把已具名的七条责任 AI 原则当作未知**——它们在 Security/Ethics 页有具名枚举（见 §6.2），可直接作答。
❌ **混淆能力类型归属**——completion/embedding/vision 与生命周期分类引用 **Model Catalog**，不是 `Supported LLMs`。
❌ **省略免责声明**——涉及「某客户是否有某功能」时，须带「功能可用性因客户/区域而异、以 enrollment 为准」。
❌ **报死的费率表模型数量**——实时页无该计数，表述为「数十款」即可。

---

## 来源文档（24 篇，2026-06 快照）

**核心 AIP**
- AIP Overview — `https://www.palantir.com/docs/foundry/aip/overview/`
- AIP Features — `https://www.palantir.com/docs/foundry/aip/aip-features/`
- Get Started with AIP — `https://www.palantir.com/docs/foundry/aip/getting-started-with-aip/`
- Best Practices for LLM Prompt Engineering — `https://www.palantir.com/docs/foundry/aip/best-practices-prompt-engineering/`
- Supported LLMs — `https://www.palantir.com/docs/foundry/aip/supported-llms/`
- LLM-Provider Compatible APIs — `https://www.palantir.com/docs/foundry/aip/llm-provider-compatible-apis/`
- AI Ethics and Governance — `https://www.palantir.com/docs/foundry/aip/ethics-governance/`
- AIP Security and Privacy — `https://www.palantir.com/docs/foundry/aip/aip-security/`
- Compute Usage with AIP — `https://www.palantir.com/docs/foundry/aip/aip-compute-usage/`
- AIP Observability — `https://www.palantir.com/docs/foundry/aip/aip-observability/`

**管理 / Administration**
- Enable AIP Features — `https://www.palantir.com/docs/foundry/aip/enable-aip-features/`
- LLM Capacity Management — `https://www.palantir.com/docs/foundry/aip/llm-capacity-management/`

**自带模型 / Bring Your Own Model**
- Bring Your Own Model to AIP — `https://www.palantir.com/docs/foundry/aip/bring-your-own-model/`
- Register LLM via function interfaces (Legacy) — `https://www.palantir.com/docs/foundry/aip/chat-completion-function-interface-quickstart/`
- Use Registered LLM (Legacy) — `https://www.palantir.com/docs/foundry/aip/use-registered-llm/`

**应用模块 / Application Modules**
- AI FDE — `https://www.palantir.com/docs/foundry/ai-fde/overview/`
- AIP Analyst — `https://www.palantir.com/docs/foundry/aip-analyst/overview/`
- AIP Assist — `https://www.palantir.com/docs/foundry/assist/overview/`
- AIP Chatbot Studio — `https://www.palantir.com/docs/foundry/chatbot-studio/overview/`
- AIP Document Intelligence — `https://www.palantir.com/docs/foundry/document-intelligence/overview/`
- AIP Evals — `https://www.palantir.com/docs/foundry/aip-evals/overview/`
- AIP Logic — `https://www.palantir.com/docs/foundry/logic/overview/`
- AIP Model Catalog — `https://www.palantir.com/docs/foundry/model-catalog/overview/`
- AIP Threads — `https://www.palantir.com/docs/foundry/threads/overview/`

> 注：多数应用模块 overview 页本身是 hub，更深的操作步骤在各自子页（本技能未逐页展开）；用户问到深层操作时提示去对应子文档页。
