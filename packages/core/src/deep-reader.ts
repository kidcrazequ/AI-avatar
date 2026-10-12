/**
 * 知识库「精读」（deep-read）管线：把整本书/长文档蒸馏成可追溯、经过验证的知识单元。
 *
 * 方法论参考 book-to-skill 与 cangjie-skill，但只产出 Soul 原生知识，不生成/安装 Skill：
 *   - 提炼结构而非摘要：命名框架 / 原则 / 技法 / 反模式，不做章节复述
 *   - Adler 整书理解 → 五视角候选池 → V1/V2/V3 三重校验 → RIA++ 知识单元
 *   - candidates / rejected / PIPELINE_STATE 全程留痕，可审计、可续跑
 *   - 保留作者命名精度；密度优先；绝不复制原文长段
 *   - 编译时付费、运行时按需加载：产物按章节拆文件，配合 BM25 检索按需召回
 *
 * 与现有摄取链路的分工（对照 document-formatter.ts 的 formatDocument）：
 *   - formatDocument = 排版员（零删减格式化，产出"原文的 markdown 版"）
 *   - runDeepRead   = 读书人（蒸馏框架与决策规则，产出"二手精读笔记"）
 *
 * 产物（写入 knowledge/精读/<书名>/）：
 *   00-索引.md        书目元数据 + 章节索引表 + 核心框架 + 主题索引
 *   NN-<章名>.md      逐章精读笔记（带 pages 来源锚点）
 *   术语表.md          全书术语 → 定义（标注章号）
 *   模式与决策.md      决策规则 / 技法 / 权衡矩阵
 *   速查表.md          单页速查：判定规则、阈值、信号
 *
 * 所有产物 frontmatter 带 source_type: deep-read（不进 system prompt 直塞，
 * 走 search_knowledge 检索）+ raw_file 锚点（citation chip 可跳回原书）。
 *
 * LLM 通过 LLMCallFn 注入（同 formatDocument），AbortSignal 贯穿每次调用。
 */

import { detectChapterHeadings, type LLMCallFn } from './document-formatter'
import { cleanLlmOutput } from './utils/ocr-html-cleaner'
import { localDateString } from './utils/common'

// ─── 类型 ────────────────────────────────────────────────────────────────────

/** 学习深度：study=精读（含实例演算），reference=速查（只留决策要点） */
export type DeepReadDepth = 'study' | 'reference'
/** 内容类型：technical=含代码/表格/公式，text=纯文字 */
export type DeepReadContentType = 'technical' | 'text'

export interface BookChapter {
  title: string
  content: string
  index: number
  /** 章节起止页码（仅 PDF 有 `### 第 N 页` 标记时存在） */
  pageStart?: number
  pageEnd?: number
}

export type DeepReadStage = 'chapters' | 'overview' | 'candidates' | 'verification' | 'knowledge' | 'synthesis' | 'done'

export interface DeepReadProgress {
  stage: DeepReadStage
  /** 已完成的 LLM 任务数（章节 + 综合件） */
  current: number
  /** 总 LLM 任务数 */
  total: number
  /** 当前在处理的章节/产物名 */
  label: string
}

export type DeepReadProductKind =
  | 'state'
  | 'index'
  | 'chapter'
  | 'overview'
  | 'candidate'
  | 'verification'
  | 'verified'
  | 'rejected'
  | 'knowledge-units'
  | 'relationships'
  | 'glossary'
  | 'patterns'
  | 'cheatsheet'

export interface DeepReadProduct {
  kind: DeepReadProductKind
  /** 相对 knowledge/ 根的路径，如 精读/小米创业思考/01-前言.md */
  relativePath: string
  content: string
  chapterIndex?: number
}

export interface DeepReadOptions {
  /** 书名（用于产物标题与 prompt） */
  bookTitle: string
  /** 产物目录（相对 knowledge/ 根），如 `精读/小米创业思考` */
  outputDir: string
  /** 原始文件在 knowledge/ 下的相对路径（_raw/xxx.pdf），写入 frontmatter raw_file */
  rawFileRelPath?: string
  depth: DeepReadDepth
  contentType: DeepReadContentType
  callLLM: LLMCallFn
  abortSignal?: AbortSignal
  onProgress?: (progress: DeepReadProgress) => void
  /** 每生成一个产物文件回调（调用方负责写盘）；抛错视为写盘失败，中止整个管线 */
  onProduct: (product: DeepReadProduct) => Promise<void>
  /**
   * 断点续跑：返回 true 表示该产物已存在、跳过生成。
   * 跳过的章节不再调 LLM，但其已有笔记内容应通过 priorChapterNotes 传入以参与综合件。
   */
  shouldSkip?: (relativePath: string) => boolean
  /** 断点续跑时已存在的章节笔记内容（仅正文，供综合件摘取要点） */
  priorChapterNotes?: Array<{ relativePath: string; content: string }>
  /** 断点续跑时已存在的书级产物。纯续跑会复用内容，避免重付 LLM。 */
  priorProducts?: Array<{ relativePath: string; content: string }>
}

export interface DeepReadRunResult {
  products: Array<{ kind: DeepReadProductKind; relativePath: string }>
  failedChapters: Array<{ title: string; error: string }>
  skippedChapters: number
  totalChapters: number
  verifiedUnits: number
  rejectedUnits: number
}

export interface DeepReadEstimate {
  llmCalls: number
  inputTokens: number
  outputTokens: number
  estMinutes: number
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 书级章节合并阈值：小于此字符数的章节并入前一章（书的"章"远大于文档的"节"） */
const MIN_BOOK_CHAPTER_CHARS = 2000
/** 单次蒸馏调用的输入上限；超长章节按段落切成多个部分 */
const MAX_DISTILL_INPUT_CHARS = 28_000
/** LLM 并发上限（与 document-formatter 的 FORMAT_CONCURRENCY 对齐） */
const DEEP_READ_CONCURRENCY = 3
/** 单章失败后的重试次数 */
const CHAPTER_RETRY_TIMES = 1
/** 综合件摘取每章笔记的最大字符数（控制综合调用的输入规模） */
const DIGEST_CHARS_PER_CHAPTER = 1200
/**
 * 综合调用 digest 输入总量上限（≈5 万 tokens，给模型上下文留余量）。
 * 章节数多到人均预算不足时按比例压缩每章摘取量，保证超长书的综合件不会确定性超限失败。
 */
const MAX_DIGEST_TOTAL_CHARS = 80_000
/** 每章摘取量的压缩下限（再低摘要就失去信息量了） */
const MIN_DIGEST_CHARS_PER_CHAPTER = 200

/** 书级产物文件名（manager 断点续跑按它探测并装载内容） */
export const DEEP_READ_SYNTHESIS_FILES = [
  '00-整书理解.md',
  '候选池/框架.md',
  '候选池/原则.md',
  '候选池/案例.md',
  '候选池/反例.md',
  '候选池/术语.md',
  '三重校验.md',
  '验证通过.md',
  '淘汰记录.md',
  '知识单元.md',
  '关系图.md',
  '术语表.md',
  '模式与决策.md',
  '速查表.md',
  '00-索引.md',
] as const

/** 真正需要 LLM 的书级产物；其余验证拆分/术语兼容件由程序派生。 */
export const DEEP_READ_LLM_FILES = [
  '00-整书理解.md',
  '候选池/框架.md',
  '候选池/原则.md',
  '候选池/案例.md',
  '候选池/反例.md',
  '候选池/术语.md',
  '三重校验.md',
  '知识单元.md',
  '关系图.md',
  '模式与决策.md',
  '速查表.md',
  '00-索引.md',
] as const

/** PDF 解析注入的页码标记（document-parser.ts parsePdf 的 `### 第 N 页`） */
const PAGE_MARKER_REGEX = /^###\s*第\s*(\d+)\s*页\s*$/

/**
 * 每章笔记的 token 预算矩阵（book-to-skill Step 7 原表）。
 * 是目标区间不是硬上限：密度优先，禁止凑字数。
 */
const CHAPTER_TOKEN_BUDGET: Record<DeepReadContentType, Record<DeepReadDepth, [number, number]>> = {
  text: { reference: [800, 1200], study: [1000, 1800] },
  technical: { reference: [1200, 1800], study: [2000, 3000] },
}

// ─── 章节切分 ────────────────────────────────────────────────────────────────

/**
 * 把整本书文本切成"书级章节"。
 *
 * 与 splitIntoChapters（文档级，3000 字符封顶）的区别：书的章节以万字计，
 * 这里只在超过单次蒸馏输入上限时才二切，并保留 PDF 页码区间作来源锚点。
 *
 * 切分优先级：
 *   1. markdown h1/h2 标题（docx/md 来源；`### 第 N 页` 是页码标记不算标题）
 *   2. 纯文本章节模式（复用 document-formatter 的 detectChapterHeadings）
 *   3. 都没有 → 整本按输入上限均切
 */
export function splitBookIntoChapters(text: string): BookChapter[] {
  const lines = text.split('\n')

  // markdown h1/h2 优先（h3 留给 PDF 页码标记和章内结构）
  const mdBreaks: Array<{ lineIndex: number; title: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,2}\s+(.+?)\s*$/)
    if (m && !/^第\s*\d+\s*页$/.test(m[1])) {
      mdBreaks.push({ lineIndex: i, title: m[1] })
    }
  }

  let breaks = mdBreaks
  if (breaks.length < 2) {
    breaks = detectChapterHeadings(lines)
  }

  const rawChapters: Array<{ title: string; startLine: number; endLine: number }> = []
  if (breaks.length === 0) {
    rawChapters.push({ title: '全文', startLine: 0, endLine: lines.length })
  } else {
    const first = breaks[0].lineIndex
    if (first > 0 && lines.slice(0, first).join('\n').trim().length > 200) {
      rawChapters.push({ title: '前言与目录', startLine: 0, endLine: first })
    }
    for (let i = 0; i < breaks.length; i++) {
      const end = i + 1 < breaks.length ? breaks[i + 1].lineIndex : lines.length
      rawChapters.push({ title: cleanChapterTitle(breaks[i].title), startLine: breaks[i].lineIndex, endLine: end })
    }
  }

  // 每行生效页码（最后一个出现的页码标记），供章节定页码区间
  const pageAtLine = new Array<number | undefined>(lines.length)
  let currentPage: number | undefined
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PAGE_MARKER_REGEX)
    if (m) currentPage = parseInt(m[1], 10)
    pageAtLine[i] = currentPage
  }

  // 合并过小章节
  const merged: Array<{ title: string; startLine: number; endLine: number }> = []
  for (const ch of rawChapters) {
    const chars = lines.slice(ch.startLine, ch.endLine).join('\n').trim().length
    if (merged.length > 0 && chars < MIN_BOOK_CHAPTER_CHARS) {
      merged[merged.length - 1].endLine = ch.endLine
    } else {
      merged.push({ ...ch })
    }
  }

  // 超长章节按段落二切，组装最终章节
  const result: BookChapter[] = []
  for (const ch of merged) {
    const content = lines.slice(ch.startLine, ch.endLine).join('\n').trim()
    const pageStart = pageAtLine[ch.startLine] ?? findFirstPage(lines, ch.startLine, ch.endLine)
    const pageEnd = pageAtLine[Math.max(ch.startLine, ch.endLine - 1)]
    if (content.length <= MAX_DISTILL_INPUT_CHARS) {
      if (content) result.push(withPages({ title: ch.title, content, index: result.length }, pageStart, pageEnd))
      continue
    }
    const parts = splitByParagraphs(content, MAX_DISTILL_INPUT_CHARS)
    // 部分的页码区间按内部页码标记重新收紧
    let partPageStart = pageStart
    for (let p = 0; p < parts.length; p++) {
      const partMarkers = [...parts[p].matchAll(new RegExp(PAGE_MARKER_REGEX.source, 'gm'))]
      const partPageEnd = partMarkers.length > 0
        ? parseInt(partMarkers[partMarkers.length - 1][1], 10)
        : (p === parts.length - 1 ? pageEnd : partPageStart)
      result.push(withPages({
        title: parts.length > 1 ? `${ch.title}（第${p + 1}部分）` : ch.title,
        content: parts[p],
        index: result.length,
      }, partPageStart, partPageEnd))
      partPageStart = partPageEnd
    }
  }

  return result
}

function withPages(ch: BookChapter, pageStart?: number, pageEnd?: number): BookChapter {
  if (pageStart !== undefined) ch.pageStart = pageStart
  if (pageEnd !== undefined) ch.pageEnd = pageEnd
  return ch
}

function findFirstPage(lines: string[], start: number, end: number): number | undefined {
  for (let i = start; i < end; i++) {
    const m = lines[i].match(PAGE_MARKER_REGEX)
    if (m) return parseInt(m[1], 10)
  }
  return undefined
}

function cleanChapterTitle(title: string): string {
  return title.replace(/^#+\s*/, '').trim().slice(0, 60)
}

function splitByParagraphs(content: string, maxChars: number): string[] {
  const paragraphs = content.split(/\n{2,}/)
  const parts: string[] = []
  let current = ''
  for (const para of paragraphs) {
    if (current && (current.length + para.length + 2) > maxChars) {
      parts.push(current.trim())
      current = para
    } else {
      current = current ? `${current}\n\n${para}` : para
    }
  }
  if (current.trim()) parts.push(current.trim())
  // 单段落超长兜底：硬切
  return parts.flatMap(p => {
    if (p.length <= maxChars) return [p]
    const out: string[] = []
    let rest = p
    while (rest.length > maxChars) {
      const at = rest.lastIndexOf('\n', maxChars)
      const cut = at > maxChars / 2 ? at : maxChars
      out.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) out.push(rest)
    return out
  })
}

// ─── 成本预估 ────────────────────────────────────────────────────────────────

/** 书级 LLM 任务：整书理解 + 五视角候选 + 校验 + 知识单元 + 关系 + 模式 + 速查 + 索引 */
const SYNTHESIS_CALLS = 12

/**
 * 预估一次精读的 LLM 开销（粗估，供 UI 确认）。
 * 不换算货币——模型单价由用户配置决定，编价格会违反"数据可溯源"红线。
 */
export function estimateDeepRead(
  chapters: BookChapter[],
  depth: DeepReadDepth,
  contentType: DeepReadContentType,
  bookLevelCalls = SYNTHESIS_CALLS,
): DeepReadEstimate {
  const pendingBookCalls = Math.max(0, Math.min(SYNTHESIS_CALLS, Math.floor(bookLevelCalls)))
  const llmCalls = chapters.length + pendingBookCalls
  const totalChars = chapters.reduce((sum, ch) => sum + ch.content.length, 0)
  const [lo, hi] = CHAPTER_TOKEN_BUDGET[contentType][depth]
  const budgetMid = Math.round((lo + hi) / 2)
  // 中英混排约 1.6 字符/token；每次调用另加 prompt 模板开销
  const digestChars = Math.min(MAX_DIGEST_TOTAL_CHARS, chapters.length * DIGEST_CHARS_PER_CHAPTER)
  const inputTokens = Math.ceil(totalChars / 1.6) + llmCalls * 700
    + pendingBookCalls * Math.ceil(digestChars / 1.6)
  const outputTokens = chapters.length * budgetMid + Math.ceil(18_000 * pendingBookCalls / SYNTHESIS_CALLS)
  const estMinutes = Math.max(1, Math.ceil((llmCalls / DEEP_READ_CONCURRENCY) * 0.7))
  return { llmCalls, inputTokens, outputTokens, estMinutes }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

export const DEEP_READ_SYSTEM_PROMPT = `你是一位资深的知识工程师，正在为一本书制作"精读笔记知识库"。

## 核心理念：提炼结构，不做摘要

笔记不是读后感，是可复用的工具箱：
- **命名框架**：作者提出的思维模型，保留作者的精确命名（"5 Whys" 不能写成"多问几个为什么"）
- **可执行原则**：指导决策的规则，写成"当 X 时，做 Y，因为 Z"
- **技法步骤**：可照做的方法，展开成明确步骤或判据
- **反模式**：作者警告要避免什么、为什么会失败

## 硬性约束（不可违反）

1. **绝不编造**：笔记中的每个事实、数字、框架名必须来自原文；原文没有的不能写
2. **绝不复制长段原文**：始终压缩重构，提炼信号
3. **密度优先**：1000 token 的精华胜过 10000 token 的摘录，禁止凑字数
4. **实践者口吻**："当 X 时用 Y"，不写"本章讲了 X"
5. 输出标准 Markdown；小节用 ## / ### 组织；单个小节正文不超过 3000 字符
6. 不用 emoji；末尾不加总结评语
7. 原文中形如「### 第 N 页」的行是 PDF 页码标记，不是章节结构；引用关键事实、数字、框架定义时在句末标注页码，格式：(p.N)。没有页码标记时不要编造页码`

interface ChapterPromptArgs {
  bookTitle: string
  chapter: BookChapter
  depth: DeepReadDepth
  contentType: DeepReadContentType
}

function buildChapterPrompt(args: ChapterPromptArgs): { userPrompt: string; maxTokens: number } {
  const { bookTitle, chapter, depth, contentType } = args
  const [lo, hi] = CHAPTER_TOKEN_BUDGET[contentType][depth]

  const sections = [
    '## 核心思想\n本章最重要的一两句话。',
    '## 框架与方法\n每个框架用 ### 小标题（保留作者命名），写明：何时用、怎么做（明确步骤或判据）。' +
      (depth === 'study' ? '对最重要的 1-2 个框架补一句"为什么有效 / 什么时候会失效"。' : ''),
    '## 关键概念\n本章 5-10 个术语，每个一句话精确定义。',
    '## 反模式\n作者警告避免什么、为什么会失败（本章没有就省略此节）。',
  ]
  if (contentType === 'technical') {
    sections.push('## 代码与示例\n摘录本章最有教学价值的代码片段或参数表（保留精确语法），并用一句话说明它演示了什么（本章没有就省略此节）。')
  }
  if (depth === 'study') {
    sections.push('## 实例演算\n紧凑地重构作者完整走过的一个例子（样例文档/对话/填好的模板/端到端的决策），这是精读笔记最有价值的部分（本章没有完整例子就省略此节，不要硬造）。')
  }
  sections.push('## 要点\n3-7 条从业者必须记住的可执行结论。')

  const userPrompt = `书名：《${bookTitle}》
章节：${chapter.title}${chapter.pageStart !== undefined ? `（原书约 p.${chapter.pageStart}${chapter.pageEnd !== undefined && chapter.pageEnd !== chapter.pageStart ? `-${chapter.pageEnd}` : ''}）` : ''}

请为以下章节原文制作精读笔记，按下列结构输出（不要输出 # 一级标题，从 ## 开始）：

${sections.join('\n\n')}

目标长度 ${lo}-${hi} tokens。内容厚的章节可以略超，单薄的章节宁可短也不要注水，并在"核心思想"里说明该章内容单薄。

--- 章节原文开始 ---

${chapter.content}

--- 章节原文结束 ---`

  return { userPrompt, maxTokens: Math.min(8192, Math.ceil(hi * 1.6)) }
}

const BOOK_OVERVIEW_PROMPT = `请按 Adler 四步阅读法输出整书理解（不要写读后感）：

## 结构
全书试图回答的核心问题、论证骨架、各部分之间的依赖关系。

## 解释
作者最关键的 3-8 个主张；每条标注支持它的章节或页码。

## 批判
未经证明的假设、时代/样本局限、最强反方论证，以及哪些结论不能外推。

## 应用
这本书适合解决什么问题、不适合解决什么问题；给出可观察的触发条件。

必须覆盖输入中的每一章；证据不足时明确写“原文证据不足”，不得补常识。`

interface CandidateJob {
  idPrefix: string
  title: string
  fileName: string
  prompt: string
}

const CANDIDATE_JOBS: CandidateJob[] = [
  {
    idPrefix: 'F',
    title: '框架候选',
    fileName: '候选池/框架.md',
    prompt: '独立提取作者明确提出或反复使用的决策框架/思维模型。',
  },
  {
    idPrefix: 'P',
    title: '原则候选',
    fileName: '候选池/原则.md',
    prompt: '独立提取可执行原则、清单、规则和阈值，优先“当 X 时做 Y，因为 Z”。',
  },
  {
    idPrefix: 'C',
    title: '案例候选',
    fileName: '候选池/案例.md',
    prompt: '独立提取作者真正走过的完整案例，写清情境、动作、结果和它支持的方法。',
  },
  {
    idPrefix: 'X',
    title: '反例候选',
    fileName: '候选池/反例.md',
    prompt: '独立提取失败模式、反例与作者警告，写清失败条件和可观察信号。',
  },
  {
    idPrefix: 'G',
    title: '术语候选',
    fileName: '候选池/术语.md',
    prompt: '独立提取理解全书不可缺少的术语，保留作者命名并给出原文语境下定义。',
  },
]

const CANDIDATE_FORMAT_PROMPT = `
每个候选用以下固定格式，编号从 {{PREFIX}}1 开始且不可重复：

### {{PREFIX}}N · 候选名称
- **主张**：一句话说明可复用内容
- **来源证据**：至少一个章节/页码 + 不超过 150 字的关键原文片段；没有原文片段就不要入选
- **解释**：用自己的话说明机制，不复述原文
- **适用场景**：可观察的触发条件
- **边界**：什么时候不能用或证据不足

只做候选提取，不评价是否最终通过；不得生成 Skill、SKILL.md、触发器或安装说明。`

const TRIPLE_VERIFY_PROMPT = `对候选池逐项执行三重校验：
- V1 跨上下文支持：至少两个独立章节/案例支持；若全书确实只有一个完整案例，必须降级说明
- V2 预测/应用力：能否据此回答一个原文未直接回答的新问题，并写出该问题与推导
- V3 独特性：是否具有作者特有的判据或机制，而不是任何人都会说的常识

严格输出两个一级小节，候选编号必须原样保留：

## 通过候选
每项写：### 编号 · 名称；随后写 V1 / V2 / V3 的结论和证据、最终判断。

## 淘汰候选
每项写：### 编号 · 名称；随后写未通过项和淘汰理由。没有淘汰项也必须写“无”。

证据不足时淘汰，禁止为了数量放宽标准；不得生成 Skill。`

const KNOWLEDGE_UNITS_PROMPT = `把“通过候选”构造成 Soul 原生可复用知识单元。每个单元必须完整包含：

### 编号 · 名称
- **R·来源片段**：不超过 150 字，带章节/页码
- **I·解释**：用自己的话写机制
- **A1·既往应用**：书中案例；若没有，明确“原文未提供完整案例”
- **A2·未来触发**：用户遇到什么可观察情境时应检索此单元，并说明与相邻单元的区别
- **E·执行**：1-2-3 步骤、判据或检查清单
- **B·边界**：不适用条件、作者盲点、证据强度

不得缺段、不得扩写原文没有的事实、不得输出 Skill frontmatter 或安装说明。`

const RELATIONSHIPS_PROMPT = `基于已验证知识单元建立关系图：
1. 分别列出 depends-on（依赖）、contrasts-with（对立/区分）、composes-with（可组合）关系及理由；
2. 输出 Mermaid flowchart，节点使用候选编号；
3. 输出“相邻单元辨析”，明确相似单元各自在什么触发条件下使用。
没有证据支持的关系不要连线。`

const PATTERNS_PROMPT = `基于以下已通过三重校验的知识单元，汇编全书的“模式与决策规则”。
每个模式用 ### 小标题（保留作者命名），写明：**何时用** / **怎么做** / **权衡** / **边界**。
只收录已验证单元，总量控制在 2400 tokens 内。`

const CHEATSHEET_PROMPT = `基于以下已通过三重校验的知识单元，制作单页速查表。这是整套笔记最有区分度的一件：捕捉作者的“判断力”，不是名词列表。
按优先级收录：
1. 判定规则——"当 X 时，做 Y，因为 Z"
2. 决策树/分支选择（用嵌套列表或小表格）
3. 权衡矩阵——按作者在意的维度给出对比
4. 阈值与默认值——作者明确给出的数字、比例、经验法则
5. 信号与征兆——"看到 X，多半是问题 Y"
禁止：纯"术语→定义"行（那是术语表）、成段散文（那是章节笔记）。每一行都要帮读者**做决定**。
用紧凑表格和规则列表，总量控制在 1200 tokens 内。只用已验证单元中的内容。`

const INDEX_CORE_PROMPT = `基于以下已验证知识单元和关系图，输出两个部分（不要输出其他内容）：

## 核心框架
全书最重要的命名框架与心智模型（保留作者命名），写成"当 Y 时用 X"/"优先 X 而非 Y，因为 Z"，约 600-800 tokens。

## 主题索引
按主题字母/拼音排序，每行 \`- **主题** → 知识单元编号（来源章节）\`，只列能定位到原文的主题。`

// ─── 产物组装 ────────────────────────────────────────────────────────────────

/** 文件名清洗（与 KnowledgePanel 导入命名规则一致） */
export function sanitizeFileSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9一-龥_-]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '') || '未命名'
}

/** 章节笔记文件名（manager 断点续跑按它探测产物存在性，勿改格式） */
export function chapterFileName(chapter: BookChapter, total: number): string {
  const width = total >= 100 ? 3 : 2
  const num = String(chapter.index + 1).padStart(width, '0')
  return `${num}-${sanitizeFileSegment(chapter.title).slice(0, 40)}.md`
}

interface FrontmatterArgs {
  bookTitle: string
  rawFileRelPath?: string
  chapter?: BookChapter
  totalChapters?: number
}

function buildDeepReadFrontmatter(args: FrontmatterArgs): string {
  const lines = ['---', 'source_type: deep-read', `book: ${args.bookTitle}`]
  if (args.rawFileRelPath) lines.push(`raw_file: ${args.rawFileRelPath}`)
  if (args.chapter && args.totalChapters !== undefined) {
    lines.push(`chapter: ${args.chapter.index + 1}/${args.totalChapters}`)
    if (args.chapter.pageStart !== undefined) {
      const end = args.chapter.pageEnd ?? args.chapter.pageStart
      lines.push(`pages: ${args.chapter.pageStart}-${end}`)
    }
  }
  lines.push(`generated: ${localDateString()}`, '---', '')
  return lines.join('\n')
}

/** 从章节笔记里摘"核心思想 + 框架名 + 要点"作综合件的输入 */
function digestChapterNote(title: string, note: string, maxChars: number): string {
  const core = extractSection(note, '核心思想')
  const frameworks = [...note.matchAll(/^###\s+(.+)$/gm)].map(m => m[1]).slice(0, 8)
  const takeaways = extractSection(note, '要点')
  const parts = [`【${title}】`, core, frameworks.length ? `框架：${frameworks.join('；')}` : '', takeaways]
  return parts.filter(Boolean).join('\n').slice(0, maxChars)
}

function extractSection(markdown: string, heading: string): string {
  const re = new RegExp(`^##\\s*${heading}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'm')
  const m = markdown.match(re)
  return m ? m[1].trim() : ''
}

function countTitledEntries(markdown: string): number {
  return [...markdown.matchAll(/^###\s+/gm)].length
}

/** 去掉既有产物的 frontmatter / 一级标题，供续跑时作为下游 prompt 输入。 */
function productBody(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n+/, '')
    .replace(/^#\s+[^\n]+\n+/, '')
    .trim()
}

/** 每章都取样的整书输入：短章全取，长章保留首尾，避免只看前半本。 */
function buildWholeBookExcerpt(chapters: BookChapter[]): string {
  const perChapter = Math.max(120, Math.min(2400, Math.floor(MAX_DIGEST_TOTAL_CHARS / chapters.length)))
  return chapters.map((ch) => {
    const page = ch.pageStart === undefined
      ? ''
      : `（p.${ch.pageStart}${ch.pageEnd !== undefined && ch.pageEnd !== ch.pageStart ? `-${ch.pageEnd}` : ''}）`
    if (ch.content.length <= perChapter) return `【第${ch.index + 1}章 ${ch.title}${page}】\n${ch.content}`
    const head = Math.floor(perChapter * 0.65)
    const tail = perChapter - head
    return `【第${ch.index + 1}章 ${ch.title}${page}】\n${ch.content.slice(0, head)}\n[…章内中段省略…]\n${ch.content.slice(-tail)}`
  }).join('\n\n')
}

// ─── abort 工具（与 life/grower.ts 同型；deep-reader 不依赖 life 模块） ──────

function makeAbortError(): Error {
  const err = new Error('精读已取消')
  err.name = 'AbortError'
  return err
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw makeAbortError()
}

async function callLLMWithAbort(
  callLLM: LLMCallFn,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  if (!abortSignal) return callLLM(systemPrompt, userPrompt, maxTokens)
  if (abortSignal.aborted) throw makeAbortError()
  return new Promise<string>((resolve, reject) => {
    let done = false
    const onAbort = () => {
      if (done) return
      done = true
      reject(makeAbortError())
    }
    abortSignal.addEventListener('abort', onAbort, { once: true })
    callLLM(systemPrompt, userPrompt, maxTokens).then(
      (value) => {
        if (done) return
        done = true
        abortSignal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        if (done) return
        done = true
        abortSignal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

/**
 * 执行精读：逐章蒸馏（并发 3，单章失败不中断）→ 综合四件套 → 索引。
 *
 * 产物经 onProduct 逐个交给调用方写盘（边产边落，不在内存攒整本）。
 * 全部章节都失败时抛错拒绝写综合件——宁可失败也不写空骨架。
 * onProduct（写盘）抛错视为致命：立即中止全部在飞 worker，不再烧 LLM。
 */
export async function runDeepRead(
  chapters: BookChapter[],
  opts: DeepReadOptions,
): Promise<DeepReadRunResult> {
  if (chapters.length === 0) {
    throw new Error('未能从文档中切分出任何章节，无法精读')
  }

  // 内部 abort：外部取消 → 联动中止；任一 worker 写盘失败 → 中止兄弟 worker（不再烧钱）
  const internalAbort = new AbortController()
  const signal = internalAbort.signal
  let fatalError: unknown = null
  const onExternalAbort = () => internalAbort.abort()
  if (opts.abortSignal?.aborted) internalAbort.abort()
  opts.abortSignal?.addEventListener('abort', onExternalAbort, { once: true })

  try {
    return await runDeepReadInner(chapters, opts, signal, (err) => {
      fatalError = err
      internalAbort.abort()
    })
  } catch (err) {
    // 写盘致命错误会把兄弟 worker abort 掉，Promise.all 先看到谁不确定——以 fatalError 为准
    throw fatalError ?? err
  } finally {
    opts.abortSignal?.removeEventListener('abort', onExternalAbort)
  }
}

async function runDeepReadInner(
  chapters: BookChapter[],
  opts: DeepReadOptions,
  signal: AbortSignal,
  onFatal: (err: unknown) => void,
): Promise<DeepReadRunResult> {
  const totalTasks = chapters.length + SYNTHESIS_CALLS
  let completedTasks = 0
  const report = (stage: DeepReadStage, label: string) => {
    opts.onProgress?.({ stage, current: completedTasks, total: totalTasks, label })
  }

  const products: Array<{ kind: DeepReadProductKind; relativePath: string }> = []
  const failedChapters: Array<{ title: string; error: string }> = []
  // chapterIndex → 笔记正文（不含 frontmatter），供综合件摘要
  const notes = new Map<number, { title: string; body: string }>()
  let skippedChapters = 0
  /** 本轮真正新蒸馏的章节数（区别于续跑装载的旧笔记） */
  let newNotes = 0

  // 断点续跑：先把已有笔记装进 digest 池
  const priorByPath = new Map((opts.priorChapterNotes ?? []).map(n => [n.relativePath, n.content]))
  const priorProductsByPath = new Map((opts.priorProducts ?? []).map(n => [n.relativePath, n.content]))

  const rememberProduct = (kind: DeepReadProductKind, relativePath: string) => {
    if (!products.some(p => p.relativePath === relativePath)) products.push({ kind, relativePath })
  }

  const writePipelineState = async (stage: DeepReadStage, next: string): Promise<void> => {
    const relativePath = `${opts.outputDir}/PIPELINE_STATE.md`
    const generated = products.filter(p => p.kind !== 'state').map(p => `- [x] ${p.relativePath}`).join('\n')
    const content = [
      `# 《${opts.bookTitle}》精读流水线状态`,
      '',
      `- 当前阶段：${stage}`,
      `- 下一步：${next}`,
      `- 章节进度：${notes.size}/${chapters.length}`,
      `- 失败章节：${failedChapters.length > 0 ? failedChapters.map(f => f.title).join('、') : '无'}`,
      `- 更新时间：${localDateString()}`,
      '',
      '## 已完成产物',
      '',
      generated || '- [ ] 尚无',
      '',
      '> 本文件用于断点续跑和审计；最终产物是 Soul 知识文件，不生成或安装 Skill。',
      '',
    ].join('\n')
    await opts.onProduct({ kind: 'state', relativePath, content })
    rememberProduct('state', relativePath)
  }

  // ── 阶段 1：逐章蒸馏（worker pool，与 formatDocument 同型） ──
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < chapters.length) {
      const idx = cursor++
      const ch = chapters[idx]
      const relativePath = `${opts.outputDir}/${chapterFileName(ch, chapters.length)}`

      if (opts.shouldSkip?.(relativePath)) {
        skippedChapters++
        const prior = priorByPath.get(relativePath)
        if (prior) notes.set(ch.index, { title: ch.title, body: prior })
        completedTasks++
        report('chapters', `跳过已完成：${ch.title}`)
        continue
      }

      throwIfAborted(signal)
      report('chapters', `精读中：${ch.title}`)
      const { userPrompt, maxTokens } = buildChapterPrompt({
        bookTitle: opts.bookTitle,
        chapter: ch,
        depth: opts.depth,
        contentType: opts.contentType,
      })

      let body: string | null = null
      let lastErr: unknown
      for (let attempt = 0; attempt <= CHAPTER_RETRY_TIMES; attempt++) {
        throwIfAborted(signal)
        try {
          const raw = await callLLMWithAbort(opts.callLLM, DEEP_READ_SYSTEM_PROMPT, userPrompt, maxTokens, signal)
          body = cleanLlmOutput(raw).trim()
          break
        } catch (err) {
          if (isAbortError(err)) throw err
          lastErr = err
        }
      }

      if (!body) {
        // 失败章节不写占位文件：宁缺毋滥，留给续跑重试
        failedChapters.push({
          title: ch.title,
          error: lastErr instanceof Error ? lastErr.message : String(lastErr),
        })
        completedTasks++
        report('chapters', `失败：${ch.title}`)
        continue
      }

      const pageHint = ch.pageStart !== undefined
        ? `（原书 p.${ch.pageStart}${ch.pageEnd !== undefined && ch.pageEnd !== ch.pageStart ? `-${ch.pageEnd}` : ''}）`
        : ''
      const content = buildDeepReadFrontmatter({
        bookTitle: opts.bookTitle, rawFileRelPath: opts.rawFileRelPath, chapter: ch, totalChapters: chapters.length,
      }) + `# ${ch.title}${pageHint}\n\n${body}\n`

      try {
        await opts.onProduct({ kind: 'chapter', relativePath, content, chapterIndex: ch.index })
      } catch (err) {
        onFatal(err)
        throw err
      }
      products.push({ kind: 'chapter', relativePath })
      notes.set(ch.index, { title: ch.title, body })
      newNotes++
      completedTasks++
      report('chapters', `完成：${ch.title}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(DEEP_READ_CONCURRENCY, chapters.length) }, () => worker()))

  if (notes.size === 0) {
    throw new Error(
      `全部 ${chapters.length} 个章节蒸馏失败，已拒绝生成综合产物。首个错误：${failedChapters[0]?.error ?? '未知'}`,
    )
  }

  await writePipelineState('chapters', '整书理解')

  // ── 书级任务共用输入（每章都有代表，避免只看前半本） ──────────────────
  const perChapterDigest = Math.max(
    MIN_DIGEST_CHARS_PER_CHAPTER,
    Math.min(DIGEST_CHARS_PER_CHAPTER, Math.floor(MAX_DIGEST_TOTAL_CHARS / notes.size)),
  )
  const digest = [...notes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, n]) => digestChapterNote(`第${idx + 1}章 ${n.title}`, n.body, perChapterDigest))
    .join('\n\n')

  const runBookJob = async (job: {
    stage: DeepReadStage
    kind: DeepReadProductKind
    fileName: string
    title: string
    prompt: string
    input: string
    maxTokens: number
  }): Promise<string> => {
    const relativePath = `${opts.outputDir}/${job.fileName}`
    const prior = priorProductsByPath.get(relativePath)
    if (newNotes === 0 && opts.shouldSkip?.(relativePath) && prior) {
      rememberProduct(job.kind, relativePath)
      completedTasks++
      report(job.stage, `沿用已有：${job.title}`)
      return productBody(prior)
    }
    throwIfAborted(signal)
    report(job.stage, `生成中：${job.title}`)
    const raw = await callLLMWithAbort(
      opts.callLLM,
      DEEP_READ_SYSTEM_PROMPT,
      `书名：《${opts.bookTitle}》\n\n${job.prompt}\n\n--- 输入开始 ---\n\n${job.input}\n\n--- 输入结束 ---`,
      job.maxTokens,
      signal,
    )
    const body = cleanLlmOutput(raw).trim()
    if (!body) throw new Error(`${job.title}生成了空内容，已停止以避免写入占位文件`)
    const content = buildDeepReadFrontmatter({ bookTitle: opts.bookTitle, rawFileRelPath: opts.rawFileRelPath })
      + `# 《${opts.bookTitle}》${job.title}\n\n${body}\n`
    try {
      await opts.onProduct({ kind: job.kind, relativePath, content })
    } catch (err) {
      onFatal(err)
      throw err
    }
    rememberProduct(job.kind, relativePath)
    completedTasks++
    report(job.stage, `完成：${job.title}`)
    return body
  }

  const writeDerived = async (
    kind: DeepReadProductKind,
    fileName: string,
    title: string,
    body: string,
  ): Promise<void> => {
    const relativePath = `${opts.outputDir}/${fileName}`
    const content = buildDeepReadFrontmatter({ bookTitle: opts.bookTitle, rawFileRelPath: opts.rawFileRelPath })
      + `# 《${opts.bookTitle}》${title}\n\n${body.trim()}\n`
    try {
      await opts.onProduct({ kind, relativePath, content })
    } catch (err) {
      onFatal(err)
      throw err
    }
    rememberProduct(kind, relativePath)
  }

  // ── 阶段 2：Adler 整书理解 ──────────────────────────────────────────────
  const overview = await runBookJob({
    stage: 'overview',
    kind: 'overview',
    fileName: '00-整书理解.md',
    title: '整书理解',
    prompt: BOOK_OVERVIEW_PROMPT,
    input: buildWholeBookExcerpt(chapters),
    maxTokens: 4200,
  })
  await writePipelineState('overview', '五视角候选提取')

  // ── 阶段 3：五视角独立候选池 ────────────────────────────────────────────
  const candidateBodies = await Promise.all(CANDIDATE_JOBS.map(async job => {
    const format = CANDIDATE_FORMAT_PROMPT.replaceAll('{{PREFIX}}', job.idPrefix)
    const body = await runBookJob({
      stage: 'candidates',
      kind: 'candidate',
      fileName: job.fileName,
      title: job.title,
      prompt: `${job.prompt}\n${format}`,
      input: `【整书理解】\n${overview}\n\n【各章笔记】\n${digest}`,
      maxTokens: job.idPrefix === 'G' ? 2600 : 3600,
    })
    return { ...job, body }
  }))
  await writePipelineState('candidates', 'V1/V2/V3 三重校验')

  const candidates = candidateBodies
    .map(job => `# ${job.title}\n\n${job.body}`)
    .join('\n\n')

  // ── 阶段 4：三重校验 + 淘汰审计 ─────────────────────────────────────────
  const verification = await runBookJob({
    stage: 'verification',
    kind: 'verification',
    fileName: '三重校验.md',
    title: '三重校验',
    prompt: TRIPLE_VERIFY_PROMPT,
    input: `【整书批判与边界】\n${overview}\n\n【候选池】\n${candidates}`,
    maxTokens: 5200,
  })
  const verified = extractSection(verification, '通过候选')
  const rejected = extractSection(verification, '淘汰候选')
  if (!verified || !/^###\s+/m.test(verified)) {
    throw new Error('三重校验未产出可识别的“通过候选”，已停止，避免把未经验证的内容沉淀为知识')
  }
  await writeDerived('verified', '验证通过.md', '验证通过的候选', verified)
  await writeDerived('rejected', '淘汰记录.md', '淘汰记录', rejected || '无')
  const verifiedUnits = countTitledEntries(verified)
  const rejectedUnits = countTitledEntries(rejected)
  await writePipelineState('verification', '构造可复用知识单元')

  // ── 阶段 5：RIA++ 知识单元 + Zettelkasten 关系 ───────────────────────────
  const knowledgeUnits = await runBookJob({
    stage: 'knowledge',
    kind: 'knowledge-units',
    fileName: '知识单元.md',
    title: '知识单元',
    prompt: KNOWLEDGE_UNITS_PROMPT,
    input: verified,
    maxTokens: 6200,
  })
  const relationships = await runBookJob({
    stage: 'knowledge',
    kind: 'relationships',
    fileName: '关系图.md',
    title: '知识关系图',
    prompt: RELATIONSHIPS_PROMPT,
    input: knowledgeUnits,
    maxTokens: 3600,
  })
  const glossaryCandidate = candidateBodies.find(job => job.idPrefix === 'G')?.body ?? ''
  await writeDerived('glossary', '术语表.md', '术语表', glossaryCandidate)
  await writePipelineState('knowledge', '生成模式、速查与索引')

  // ── 阶段 6：兼容既有消费面的模式 / 速查产物 ─────────────────────────────
  await Promise.all([
    runBookJob({
      stage: 'synthesis', kind: 'patterns', fileName: '模式与决策.md', title: '模式与决策',
      prompt: PATTERNS_PROMPT, input: knowledgeUnits, maxTokens: 3600,
    }),
    runBookJob({
      stage: 'synthesis', kind: 'cheatsheet', fileName: '速查表.md', title: '速查表',
      prompt: CHEATSHEET_PROMPT, input: knowledgeUnits, maxTokens: 2200,
    }),
  ])

  // ── 阶段 7：索引（LLM 只写核心框架；章节表和产物表程序拼装） ──────────────
  throwIfAborted(signal)
  report('synthesis', '生成索引')
  const indexPath = `${opts.outputDir}/00-索引.md`
  const priorIndex = priorProductsByPath.get(indexPath)
  if (newNotes === 0 && opts.shouldSkip?.(indexPath) && priorIndex) {
    rememberProduct('index', indexPath)
    completedTasks++
    report('synthesis', '沿用已有：索引')
    await writePipelineState('done', '已完成')
    report('done', '精读完成')
    return { products, failedChapters, skippedChapters, totalChapters: chapters.length, verifiedUnits, rejectedUnits }
  }
  const indexCore = cleanLlmOutput(await callLLMWithAbort(
    opts.callLLM,
    DEEP_READ_SYSTEM_PROMPT,
    `书名：《${opts.bookTitle}》\n\n${INDEX_CORE_PROMPT}\n\n--- 已验证知识与关系 ---\n\n${knowledgeUnits}\n\n${relationships}`,
    2800,
    signal,
  )).trim()
  if (!indexCore) throw new Error('索引核心生成了空内容，已停止写入索引')
  completedTasks++

  const chapterRows = chapters.map(ch => {
    const file = chapterFileName(ch, chapters.length)
    const note = notes.get(ch.index)
    const status = note ? `[${ch.title}](${file})` : `${ch.title} ⚠️ 蒸馏失败，待续跑`
    const pages = ch.pageStart !== undefined ? `p.${ch.pageStart}-${ch.pageEnd ?? ch.pageStart}` : '—'
    return `| ${ch.index + 1} | ${status} | ${pages} |`
  })

  const supportRows = [
    '- [整书理解](00-整书理解.md)',
    '- [验证通过的候选](验证通过.md)',
    '- [淘汰记录](淘汰记录.md)',
    '- [知识单元](知识单元.md)',
    '- [知识关系图](关系图.md)',
    '- [术语表](术语表.md)',
    '- [模式与决策](模式与决策.md)',
    '- [速查表](速查表.md)',
    '- [三重校验审计](三重校验.md)',
    '- [候选池](候选池/框架.md)',
  ].join('\n')

  const depthLabel = opts.depth === 'study' ? '精读（study）' : '速查（reference）'
  const typeLabel = opts.contentType === 'technical' ? '技术' : '文字'
  const resumeNote = skippedChapters > 0
    ? `（其中 ${skippedChapters} 章为续跑沿用，深度/类型以各章笔记 frontmatter 为准）`
    : ''
  const indexContent = buildDeepReadFrontmatter({ bookTitle: opts.bookTitle, rawFileRelPath: opts.rawFileRelPath })
    + [
      `# 《${opts.bookTitle}》精读索引`,
      '',
      `**深度**：${depthLabel} | **类型**：${typeLabel} | **章节**：${chapters.length}${failedChapters.length > 0 ? `（${failedChapters.length} 章失败待续跑）` : ''}${resumeNote}`,
      '',
      '**质量链**：整书理解 → 五视角候选 → V1/V2/V3 三重校验 → RIA++ 知识单元 → 关系图',
      '',
      indexCore || '> ⚠️ 核心框架汇编失败，请续跑精读补全。',
      '',
      '## 章节索引',
      '',
      '| # | 章节 | 原书页码 |',
      '| --- | --- | --- |',
      ...chapterRows,
      '',
      '## 配套文件',
      '',
      supportRows,
      '',
    ].join('\n')

  try {
    await opts.onProduct({ kind: 'index', relativePath: indexPath, content: indexContent })
  } catch (err) {
    onFatal(err)
    throw err
  }
  rememberProduct('index', indexPath)
  await writePipelineState('done', '已完成')
  report('done', '精读完成')

  return { products, failedChapters, skippedChapters, totalChapters: chapters.length, verifiedUnits, rejectedUnits }
}
