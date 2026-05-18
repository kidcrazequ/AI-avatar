---
title: OpenHuman 借鉴点 — Tool Result 压缩 + Memory Tree 分层
author: zhi.qu
date: 2026-05-18
status: backlog
source_inspiration: https://github.com/tinyhumansai/openhuman（2026-05 GitHub trending）
---

# OpenHuman 借鉴点 · Plan

> **背景**：OpenHuman 是 2026-05 上 GitHub trending 的桌面 AI agent，定位「个人 AI 超级智能 · 本地优先」。对比 Soul，2 个点值得纳入 backlog：(1) TokenJuice 式的工具结果压缩，(2) Karpathy/Memory Tree 式的记忆分层折叠。其他卖点（118 OAuth、桌面吉祥物、加入 Google Meet）与 Soul 定位冲突，**明确不做**。

---

## 0. 红线（写在最前，避免 LLM 改方案时漂走）

| 红线 | 原因 |
|---|---|
| **不调 LLM 做 tool result 二次总结** | LLM 摘要 = 有损 + 引入幻觉风险；Soul 已有 search_knowledge / query_excel / web_search 的"工具调用诚信铁律"，压缩层必须**机械、可审计** |
| **`query_excel.rows[]` / `read_knowledge_file.body` / `search_knowledge` 单 chunk quote 原样透传** | Soul 已确立"数字必须从工具返回原文取"，这些字段是事实根基，**禁止任何修改** |
| **不替代 RAG 选择性注入策略** | 现有「rag_only 不全塞 + Channel B/C 按需取」是另一层正交决策，本期**不动** |
| **环境变量 `SOUL_TOOL_COMPRESSION=off` 一键回退** | 任何意外回归立刻关闭压缩层，不需要 hotfix 代码 |

---

## 1. P1：Tool Result 压缩层（TokenJuice 启发）

### 1.1 目标

在 `tool-router.ts` 的工具执行返回前，加一层**无损 + 可还原**的统一后处理，预计 token 占用降 20-40%。

### 1.2 设计

**新模块**：`packages/core/src/tool-result-compressor.ts`（80-120 行）

```ts
export interface CompressConfig {
  enabled: boolean              // 默认 true，env override
  dedupe: boolean               // 跨调用去重
  shortenUrls: boolean          // 展示态 URL 截短，保留源链接到 source_anchor
  collapseWhitespace: boolean   // 折叠连续空行
  stripAnsi: boolean            // 去 ANSI 转义
  passthrough: Set<string>      // 不压缩的工具名白名单
}

export function compressToolResult(
  toolName: string,
  rawResult: ToolCallResult,
  config: CompressConfig,
  conversationContext: { previousResults: ToolCallResult[] },  // 用于跨调用去重
): ToolCallResult
```

### 1.3 操作分类

| 类别 | 操作 | 何时触发 |
|---|---|---|
| **无损 - 通用** | trim trailing whitespace · 折叠连续 ≥3 空行 → 1 空行 · 去 ANSI/控制字符 | 所有工具 |
| **无损 - 去重** | 同一对话窗口内，相同 chunk hash 的内容只保留首次（second occurrence 替换为 `[此片段已在前文返回，省略]`） | `search_knowledge` / `web_search` / `read_knowledge_file` |
| **可还原 - URL 截短** | 展示态把 `https://example.com/very/long/path/with?many=params` 写成 `https://example.com/…`，但 source_anchor 字段保留**完整 URL** | `web_search` / `web_fetch` 的 content 渲染态 |
| **禁止 - 透传白名单** | `query_excel` 全部 rows 字段 · `read_knowledge_file` body · `search_knowledge` 每个 chunk 的原文 · `read_attachment` · `eval_js` 的 stdout · `exec_shell` 的 stdout | 这些工具的事实根基不动 |

### 1.4 安全网

1. **回归门禁**：
   - `小堵-工商储专家` 现有 54 用例（含铜铝对比、上海电价、土壤密实度等高敏感数据回归）必须 pass
   - 新增 5 个针对压缩层的单测：
     - 同一 chunk 多次召回 → 只保留首次
     - 长 URL → 展示截短，source_anchor 完整
     - query_excel rows 全字段透传
     - 异常输入（malformed JSON）不抛、降级返回原文
     - SOUL_TOOL_COMPRESSION=off 时压缩函数变 identity（透传）
2. **可观测**：每次压缩在 `result.meta.compressionStats` 记录 `originalChars / finalChars / dropped` 三个数，便于事后审计
3. **env 回退**：`SOUL_TOOL_COMPRESSION=off` 在主进程启动时读，覆盖所有工具

### 1.5 工作量

| 子任务 | 估时 |
|---|---|
| 新建 tool-result-compressor.ts + 单测 | 0.5 天 |
| 接入 tool-router.ts（5-8 个工具调用出口） | 0.3 天 |
| 跑小堵 54 用例回归 + 修问题 | 0.5-1 天 |
| 文档（决策依据 + 关 flag 说明） | 0.2 天 |
| **合计** | **~1.5 天** |

### 1.6 不做

- ❌ LLM 二次总结（违反红线）
- ❌ JSON 字段折叠（精度风险）
- ❌ 任何"自适应阈值"压缩（追求确定性）
- ❌ 改 search_knowledge / query_excel 的工具实现（只在出口加一层 wrapper）

---

### 1.7 P1.5：Symbolic Short-term Memory（TDAI 借鉴，2026-05-18 加入）

**灵感来源**：Tencent/TencentDB-Agent-Memory（MIT, TypeScript）的 symbolic short-term memory 机制。
**实测 token 节省**：WideSearch 221M → 85M (-61.38%)，远超 P1 v1 的章节去重收益。

**核心思路**：长工具输出**不内联进 prompt**，而是落盘到 `conversations/<convId>/tool-refs/<callId>.md`，prompt 里只留 `[lazy_ref: <call_id> · 一句话摘要 · ~12k chars · use read_tool_ref]`。LLM 想看正文调新工具 `read_tool_ref(call_id, offset?, limit?)`。

**v1 范围（保守，只覆盖 web_fetch）**：
- **触发阈值**：`web_fetch` 返回 ≥ 4000 字符时启用 lazy mode
- **lazy 摘要格式**：`[lazy_ref: tool-{shortHash} · web_fetch(url=...) · returned ~{N} chars · use read_tool_ref(call_id) to view full]`
- **新工具 `read_tool_ref(call_id, offset?, limit?)`**：从 `conversations/<convId>/tool-refs/<callId>.md` 取正文，支持分页（offset/limit ≤ 8000 字符/次）
- **存储**：会话目录下 `tool-refs/` 子目录，新建 conversation 创建，删 conversation 时一起清
- **env 开关**：`SOUL_TOOL_LAZY_RETRIEVAL=on|off`，**默认 off**，跟 P1 v1 同款独立开关

**红线**：
- ❌ **绝对不对 query_excel / search_knowledge / read_knowledge_file / read_attachment 等事实根基类工具启用 lazy**——这些回答必须看到完整数据；lazy 只能应用于"可重新拉取"的来源
- ❌ 不调 LLM 摘要（一句话摘要由工具调用上下文机械生成：`web_fetch(url=...)` → "fetched <host>"）
- ❌ 不动 search_knowledge 章节去重（P1 v1 跟 P1.5 正交）
- ✅ `read_tool_ref` 调用失败时（文件被清等）返回明确错误，引导 LLM 重新调原工具

**Soul 当前架构契合度**：
- 会话目录已存在（`workspaces/<convId>/`），加 `tool-refs/` 子目录 0 风险
- 已有 read_attachment / read_knowledge_file 模式可参考
- 主进程已暴露 `wrapHandler` 注册 IPC，新工具加一行即可

**工作量**：
- lazy-store 模块（写盘 + 读盘 + cleanup） — 0.5 天
- tool-router 集成（web_fetch 出口 + 新 read_tool_ref 工具）— 0.5 天
- chatStore.ts 注册新工具 schema 给 LLM — 0.2 天
- soul-loader.ts prompt 提示（告诉 LLM 看到 lazy_ref 怎么办）— 0.2 天
- 单测 + 回归 — 0.5 天
- **合计**：~2 天

**启动时机**：本期立刻做（用户 2026-05-18 拍板）。P1 v1 已落地稳定 → P1.5 紧跟。

**v2 范围（暂不做，等 v1 验证）**：
- 扩展到 web_search 结果 lazy 化
- 扩展到 long search_knowledge 结果（需要小心，事实根基敏感）
- LLM 自动 lazy 取片段（agentic retrieval）

### 1.8 P1.5 实测发现（2026-05-18 首日联调）

**链路验证**（端到端 OK）：
1. ✅ env `SOUL_TOOL_LAZY_RETRIEVAL=on` 正确传到主进程
2. ✅ `web_fetch` 抓 `https://fgw.sh.gov.cn/fgw_zcwjfl/index.html` body 5009 字符 → 触发 lazy
3. ✅ prompt content 5393 → 454 字符（body 被替换为 `body_lazy_ref`，元数据 url/status/format/char_count 保留）
4. ✅ 正文落盘 `workspaces/<conv>/tool-refs/tool-7ea47a256c97.md`（8549 bytes UTF-8）
5. ✅ JSONL 存档确认 LLM 端收到的 tool message **只有 `body_lazy_ref`，无 `body` 字段**
6. ✅ LLM 看到 lazy_ref 标记 → 主动调 `read_tool_ref(call_id="tool-7ea47a256c97")` → 取回完整 5009 字符正文 → 基于真实正文生成答复

**性质判断（重要）**：**lazy-store 不是"自动省 token 神器"，是"给 LLM 多一层选择权"**。

| 场景 | LLM 行为 | 省 token？ |
|---|---|---|
| 读页面 / 读 PDF / 看新闻 | "需要正文" → 立刻 `read_tool_ref` | ❌ 不省，反而 +1 轮工具调用 |
| "这 URL 能访问吗" / 验证状态码 | "看 metadata 够了" → 不调 read_tool_ref | ✅ 大省（5393→454 一次性） |
| 批量 fetch 多 URL 比对标题 | "title 在 metadata，body 不需要" | ✅ 大省 |
| search_knowledge 已足，web_fetch 验证 | "验证够了" → 不调 read_tool_ref | ✅ 大省 |
| **多轮对话历史里旧的 web_fetch（关键场景）** | 旧内容不再相关 → 不重读 | ✅ **历史轮永久节省** |

**最后一类是真正的高频价值**：第 N 轮对话时，第 1 轮 web_fetch 的完整 body 在 conversation history 里**永远以 lazy_ref 形式存在**，不重复占用 prompt token——这是单次 fetch 场景看不到、但对话越长越突出的累积节省。

**结论**：保持 lazy=on 跑数天，**真实价值在多轮对话累积**，单轮单 fetch 场景看不出明显省 token 是预期表现，不要因此误判失效。

### 1.9 后续观察指标（P1.5 收数据）

跑稳后 1-2 周，从 JSONL 存档统计：
- 多少次 `web_fetch` 触发了 lazy（body ≥ 4000）
- 其中多少次 LLM 调了 `read_tool_ref`（"看正文" vs "只看 metadata" 的比例）
- 平均每个 conversation 的 `tool-refs/` 文件数 + 总字节数
- 同一会话内是否出现"旧 lazy_ref 历史保留"的情况

如果"调 read_tool_ref"占比 > 90%，说明 lazy 化基本没省 token，可考虑：
- 提高阈值到 8000（短 body 不 lazy）
- 或加 LLM-side 提示「除非真需要正文细节才调 read_tool_ref」

---

## 2. P2：Memory Tree 分层折叠

### 2.1 目标

用户连续使用 3+ 月后，`memory/episodes/*.json` 会有数百条，平铺式 system prompt 注入会越来越糙、salience 排序也压不住数量。借鉴 OpenHuman 的 Karpathy/Memory Tree 思路，做**主题 → episode** 两层折叠。

### 2.2 设计

**数据结构新增**：`memory/themes/<theme-slug>.json`

```jsonc
{
  "slug": "shanghai-electricity-tariff",
  "title": "上海电价相关对话",
  "createdAt": "2026-05-18",
  "lastUpdatedAt": "2026-06-15",
  "episodeIds": ["ep-0042-shanghai-tariff-q1", "ep-0051-shanghai-peak-shift", ...],
  "themeSummary": "用户多次询问上海工商业电价政策、峰谷时段、储能套利测算。核心关注 2025-2026 年最新文件、价差变化趋势。",   // ≤ 800 字
  "salience": 4.2,                     // = max(episode.salience) within
  "themeKeywords": ["上海", "电价", "峰谷"]
}
```

**注入策略升级**（soul-loader.ts）：
- 当前：列 top-5 episode title + summary
- 新：先列 top-3 **theme**（含 themeSummary），点开主题再列其下 top-3 episode title
- 用户问"上次聊过的 X" → recall_conversation 工具优先用 theme keywords 召回，再下钻到 episode

### 2.3 主题生成时机

| 触发 | 动作 |
|---|---|
| 写完一条新 episode | 用 segmentit 分词 + keyword 相似度，把 episode 归到现有 theme，若无相似 theme 则**留为 orphan**（不立即建主题） |
| `consolidate-memory` cron（已存在，每天 0:30） | 扫 orphan episodes，相似度 > 阈值的聚类成新 theme；现有 theme 内 episodes 数 > 10 时切分 |
| 手动触发：设置 → 记忆管理 → 重建主题树 | 同上，全量重跑 |

### 2.4 红线

- ❌ **不 LLM 二次摘要 episode 内容**（同 P1 红线，避免幻觉传染）
- ❌ themeSummary 由"已有 episode summary 的拼接 + 去重"机械合成，不调 LLM
- ✅ 原始 `episodes/*.json` 永不删除，theme 只是索引

### 2.5 工作量

| 子任务 | 估时 |
|---|---|
| 数据结构 + 主题生成器（机械聚类，segmentit + 相似度） | 1-2 天 |
| consolidate-memory cron 集成 | 0.5 天 |
| soul-loader.ts 注入策略升级 + 二段式格式 | 0.5 天 |
| recall_conversation 工具升级（先查主题再查 episode） | 0.5 天 |
| 单测 + 回归 + 数据迁移脚本 | 1 天 |
| **合计** | **~3.5-4.5 天** |

---

## 3. 明确不做（来自 OpenHuman 但不契合 Soul 定位）

| OpenHuman 功能 | 不做原因 |
|---|---|
| 118+ OAuth 连接器（Gmail / Slack / Notion / GitHub 自动同步） | 与 Soul 现有 MCP 路线重叠；专业分身（小堵 / 电图 / 财研）的用户上下文不需要这些；OAuth 体系工作量巨大与"轻量化"定位冲突 |
| 桌面吉祥物 mascot + lip-sync 动画 | 与"专业分身"定位冲突；豆包 ASR 已落地，若要语音输出叠 TTS 即可，不做卡通形象 |
| 加入 Google Meet 当真人参与者 | Soul 方向是"知识专家咨询"，不是"会议秘书" |
| 20 分钟全局 auto-fetch loop | Soul 已有 life-grower / consolidate-memory / knowledge-check 三条 cron，再加全局 auto-fetch 会让用户失控；新需求按场景单独加 cron 即可 |

---

## 6. 暂缓 / 已评估但不做 — OpenDataLoader PDF

**评估日期**：2026-05-18  
**结论**：暂不引入，**未来翻出来重新评估前先看本节结论**。

### 6.1 OpenDataLoader 是什么 / 为什么诱人

Apache 2.0 PDF 解析器，benchmark #1（0.907 vs MinerU 0.831），核心卖点：结构化 markdown 输出 + 每元素 bounding box + 表格 / LaTeX / 80+ 语言 OCR + 100% 本地。对 Soul 的潜在价值：政策文件 / 技术规范 / 财报类 PDF 的标题层级 + 表格抽取显著改善。

### 6.2 Dealbreaker：硬依赖 JRE 11+

npm 包 `@opendataloader/pdf@2.4.3` 实际是 **Java CLI 的 Node.js wrapper**（包体 24.5MB jar）。官方文档明确："Requires: Java 11+ ... Using Without Java? Not possible." 没有纯 JS / 纯 Node 替代。

### 6.3 Windows 打包影响（评估过的具体冲击）

| 问题 | 解决成本 |
|---|---|
| 包体 +50MB（bundle Adoptium Win x64 JRE，jlink 裁剪后 ~35MB） | 配置 0.5 天 |
| asar 不能存可执行文件 → 配 `asarUnpack: ['resources/jre/**']` | 0.5 天 |
| Windows Defender / SmartScreen 标 `java.exe` 假阳性 → 必须 Win 代码签名 | 视 Soul 当前签名状态而定 |
| 含空格 / 中文路径（`C:\Users\张三\`）的 UTF-8 + GBK 编码问题 | 0.5 天调试 |
| 跨架构 JRE（Mac arm64 / Mac x64 / Win x64 / Linux x64）单独 build | 1 天首次配置 |
| jlink 必须在目标平台跑 → 开发机 Mac 没法直接打 Win JRE | 用 Adoptium 预编译或 GH Actions windows-latest |

**总工作量**：6-7 天（含基线测试 + JRE bundle + 代码签名验证）。

### 6.4 为什么暂不做

1. **与 Soul "Electron 单一运行时 / 一个 .dmg / .exe 装上就能用" 的产品定位严重冲突**——用户群体（小堵 / 设计大师 / 财研等分身的用户）多数非技术人员，"装 Java" / "首次弹 SmartScreen" 是 dealbreaker；bundle JRE 让安装包从 ~100MB 翻到 ~300MB+
2. Soul 当前 PDF 链路（`pdf-parse` + `qwen-vl-max` OCR + #14 Template chunking 的 `### 第 N 页` 注入）**已饱和**，超长 chunk / 表格弱不是产品级痛点
3. 真痛点的 workaround 已存在：PDF 转 Word（mammoth styleMap 12 级标题已识别）

### 6.5 未来触发条件（满足任一才重启评估）

- ⏰ 用户明确反馈 "PDF 导入后 search_knowledge 召回不准"，且复现可证明是结构识别不足导致
- ⏰ 想做 "点击 `[来源: foo.pdf]` → 跳到 PDF 第 X 页坐标高亮" 这种高价值 UX
- ⏰ Soul 决定整体引入 Java 运行时（如未来接入其他 Java 库，JRE 已经在了）
- ⏰ OpenDataLoader 或同类项目出**纯 JS / WASM 版本**（撤销 JRE 依赖）

### 6.6 行业现状（给未来评估者的笔记）

"结构识别强" 的 PDF 解析工具 **全部依赖 Java 或 Python 运行时**：
- OpenDataLoader：Java
- MinerU：Python
- Marker：Python
- Docling：Python
- RAGFlow：Python + Docker

Soul 选择 "Electron 单一运行时" 路线就和这类重型解析器**天生有边界**，不是 OpenDataLoader 特殊问题。**纯 JS 替代**（pdfjs / pdf-parse）就只能做基础文本提取，标题 / 表格 / 阅读顺序的语义识别能力天花板低。如果想要"结构识别强 + 单一运行时"，要等行业出 WASM 版（短期不太可能）。

---

## 8. PAP（power-agent-platform）知识库借鉴

**来源**：`/Users/kian/AI/power-agent-platform` 的 `pap/knowledge/`（591 行 Python，agentic search 范式）  
**评估日期**：2026-05-18  
**结论**：3 条值得借鉴并立即做，2 条已有不必动。

### 8.1 PAP 知识库的差异化点

PAP 故意禁用 vector search（`SemanticSearchDisabledError`），强调 "every fact has a traceable source path"。它的工具集：
- `kb.grep`（精确正则匹配，优先 ripgrep，fallback Python re）
- `kb.glob`（文件路径模式匹配）
- `kb.read`（offset/limit 分页）
- `kb.list_dir` / `kb.list_sheets` / `kb.describe_sheet`
- `kb.query_excel`（**小表 ≤ 50 行可放宽 filter+columns+limit 要求**）

Soul 已有的：hybrid retrieval (BM25 + vector + RRF) + search_knowledge / read_knowledge_file / list_knowledge_files / query_excel。**主要缺口：精确字符串/文件名匹配工具**。

### 8.2 立即做（P1.6，~2 天）

#### 8.2.1 加 `grep` + `glob` 工具到 tool-router（~1 天，🥇 高）

**为什么**：现有 `search_knowledge` 是向量+BM25 模糊召回，遇到精确关键词（如型号编号 `262KWh` / `ENS-L262`）时召回率不稳。**小堵真实事故**："铜铝对比" + "土壤密实度" 用例曾因 search_knowledge 没召回完整段落导致漏答——grep 兜底直接消除这类风险。

**设计**：
- `grep(pattern, scope?, regex?, max_per_file?)`: 在 `avatars/<id>/knowledge/`（+ project knowledge 路径）正则搜索；scope 必须在 knowledge/ 内；优先用系统 `rg`，不存在降级 Node re；单文件命中数硬上限 200（防爆）
- `glob(pattern, scope?)`: 文件路径模式匹配（`**/*电价*.md` 等）；scope 同上
- 复用现有 `assertSafeSegment` / `resolveUnderRoot` 做路径安全
- chatStore.ts 注册新 function schema，soul-loader.ts 工具描述补两条
- 红线：**不替代 search_knowledge**，并存——LLM 自主选

**风险**：跨平台 ripgrep 检测（Mac/Win/Linux 路径不同），降级路径必须 robust

#### 8.2.2 `query_excel` 小表 auto-relaxation（~~0.5 天~~，**Soul 已实现，跳过**）

**2026-05-18 复核**：在 `tool-router.ts:2183` 已有 `SMALL_TABLE_ROW_THRESHOLD = 50` + `isSmallTable` 例外逻辑，阈值与 PAP 一致。注释明确"让 LLM 不必为 9 行的小表多绕一轮"。**不需要额外动**。

#### 8.2.3 引用优先级 prompt 规则（~0.5 天，🥈 中）

**为什么**：Soul 现规则只说"来源标注必须有"，PAP 进一步说"哪类查询优先看哪类文件"。**注意：不引入新文件类型**（PAP 的 `学习笔记.md` 在 Soul 已有 wiki/ + memory/MEMORY.md 等价物）。

**设计**：在 soul-loader.ts 「回答规则」段加：
> 文件类型与引用优先级：
> - **数字 / 规则 / 政策 / 参数** → 原文 `knowledge/*.md` + `query_excel` 表（事实根基）
> - **图像识别 / Vision-caption 文字** → 仅看意图，**禁止取作精确数字**（精确数字回查 query_excel 或原图工具）
> - **跨章节关系 / 背景 / 总结 / 决策语境** → `wiki/` sediment notes + `memory/MEMORY.md` 长期记忆

### 8.3 已有，不动

| PAP 设计 | Soul 已有 | 不动理由 |
|---|---|---|
| `kb_root` containment / `PathOutsideKBRootError` | `assertSafeSegment` + `resolveUnderRoot` | 同等能力，命名不同 |
| python-calamine + openpyxl Excel 栈 | `xlsx` (SheetJS) | Soul Excel pipeline 已饱和（_excel/_index 缓存机制） |
| InProcessMCPServer 包装 | 工具直接注册 in tool-router | Soul 不走 MCP-first 路线 |
| 禁用 vector search 的设计哲学 | 保留 hybrid retrieval | Soul 已饱和 RAG，禁用反而损失 recall；让 LLM 自主选 grep vs semantic |

### 8.4 启动时机

P1 v1（压缩层）+ P1.5（lazy-store）刚落地，建议**等小堵 / 设计大师在生产环境跑 2-3 天**确认稳定，再启动 P1.6。或者用户立刻拍板做也行（grep 工具独立，不动既有路径）。

---

## 7. Memory Tree 红线重审 trigger（TDAI L1 Atom 借鉴）

**评估日期**：2026-05-18  
**结论**：暂不放开 P2 Memory Tree 的「不 LLM 二次摘要」红线，但记录 trigger 条件以备未来重审。

### 7.1 TDAI L1 Atom 是什么

`Tencent/TencentDB-Agent-Memory` 的 4 层流水线 L0-L3 中，L1 Atom 是「从原始对话中**用 LLM 提取原子事实**」，如：
- 用户提到「我们项目要 100MWh」→ L1 atom: `{project_scale: "100MWh"}`
- 用户说「我喜欢简洁的方案」→ L1 atom: `{user_preference: "prefer simple solutions"}`

PersonaMem benchmark accuracy 从 48% 跳到 76%（**+59%**）—— 主要靠 L1 atom 的精确事实抓取。

### 7.2 为什么暂不做（坚持 P2 红线）

Soul P2 Memory Tree plan §0 红线：
> "不 LLM 二次摘要 episode 内容（避免幻觉传染）"
> "themeSummary 由'已有 episode summary 的拼接 + 去重'机械合成，不调 LLM"

红线动机：
1. **避免幻觉传染**：LLM 摘要会"创造性"修改原文，atom 提取过程中可能把"100MWh" 写成"100GWh"
2. **可追溯**：所有事实有原始 episode 可回溯，机械合并保证 traceability
3. **token 成本**：L1 提取每 N 轮跑一次 LLM 大调用，对个人用户成本累积可观

### 7.3 未来重审 trigger（满足任一）

- ⏰ 用户反馈「分身记不住关键事实」「重复问同一信息」**且 P2 Memory Tree v1（机械合并版）已上线无法解决**
- ⏰ 出现可证明 L1 atom 提取 LLM 调用幻觉率 < 2% 的工艺（如 small structured-output model + JSON schema 严格约束）
- ⏰ Soul 决定整体引入 atomic fact graph（如 Neo4j / typed memory）—— 那时 L1 atom 是天然契合

### 7.4 不直接借鉴的其他 TDAI 层级

- **L2 Scenario（场景块 / 解决方案 reuse）**：跟 Soul P2 Memory Tree theme 节点重叠，按 P2 红线落地即可（不引入 LLM 摘要）
- **L3 Persona（用户画像每 50 条 memory 重建）**：Soul 已有 `memory/USER.md` 平铺版 + `life/consolidated.md`，定期重建机制可在 P2 / P3 加入但不要 LLM 提取
- **存储栈（SQLite + sqlite-vec + BM25 + RRF + jieba）**：与 Soul knowledge-retriever 几乎一致，没有可借

---

## 4. 启动准入

- P1（压缩层）可独立启动，无前置依赖
- P2（Memory Tree）建议在 P1 完成且回归稳定后启动，避免同时改 tool 出口 + 注入策略两侧失控

## 5. 失败回滚

- P1：env `SOUL_TOOL_COMPRESSION=off` 即时关闭
- P2：保留旧的 episode 平铺注入路径作为 fallback；setting `memory_tree_enabled=false` 时退回旧逻辑
