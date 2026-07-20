/**
 * 知识库概念卡编译器（确定性结构卡，零 LLM）。
 *
 * 从 knowledge/**.md 纯结构解析出两级卡片，服务"先定位、再钻取"导航：
 *   - 文档卡 DocumentCard：标题 / 摘要线索 / 标题关键词 / 章节数
 *   - 章节卡 SectionCard：标题路径 + 1-based 行号闭区间（引用可落到章节粒度，直接服务溯源纪律）
 *
 * 与 wiki-compiler.ts 互补：wiki 是 LLM 聚合生成的实体概念页，本模块是**确定性**结构索引——
 * 不调用任何模型、不依赖 nodejieba（切词只按空白/标点，不做分词），同输入必得同输出。
 *
 * 产物写入 <knowledge>/_cards/index.json；扫描时排除 _cards 自身与其他索引产物目录，
 * 防止索引自噬。增量构建以 sourceMtimeMs + charCount 双判据整卡复用未变文档。
 *
 * 仅限 Node 环境使用（依赖 fs/path），不导出到 browser.ts。
 *
 * @author zhi.qu
 * @date 2026-07-20
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

// ─── 类型定义（接口契约，勿改字段） ──────────────────────────────────────────

export interface DocumentCard {
  path: string            // 相对 knowledge/ 的 posix 路径
  title: string           // 首个 H1；无则文件名（去扩展名）
  summaryHint: string     // 首个非标题非空段落前 160 字符（确定性摘要线索，非 LLM）
  keywords: string[]      // 各级标题按空白/标点切词去重，上限 20
  sectionCount: number
  charCount: number
  sourceMtimeMs: number   // 源文件 mtime（增量构建判据）
}

export interface SectionCard {
  docPath: string
  headingPath: string[]   // 祖先标题链，如 ['安规', '接地要求']
  startLine: number       // 1-based，含标题行
  endLine: number         // 1-based，闭区间
  charCount: number
  keywords: string[]      // 本节标题切词，上限 10
}

export interface KnowledgeCardsIndex {
  version: 1
  builtAtMs: number
  documents: DocumentCard[]
  sections: Record<string, SectionCard[]>   // key = docPath
}

export interface BuildCardsOptions { maxSectionsPerDoc?: number; now?: () => number }  // maxSectionsPerDoc 默认 100

export interface BuildCardsResult {
  index: KnowledgeCardsIndex
  scannedFiles: number
  skippedUnchanged: number
  droppedSections: Array<{ docPath: string; dropped: number }>   // 超上限被丢弃的节数，绝不静默
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

export const CARDS_DIRNAME = '_cards'

/** 按目录名整个跳过：本模块产物 + 其他索引/导出产物 + 依赖目录（防止索引自噬与噪音） */
const EXCLUDED_DIR_NAMES = new Set([CARDS_DIRNAME, '_wiki', '_index', '_excel', 'node_modules'])

const DEFAULT_MAX_SECTIONS = 100
const SUMMARY_HINT_MAX = 160
const DOC_KEYWORDS_MAX = 20
const SECTION_KEYWORDS_MAX = 10
/** 首个标题前引言节 / 全文无标题单节的伪标题（headingPath 占位，非真实标题） */
const PREFACE_TITLE = '(引言)'
const FULLTEXT_TITLE = '(全文)'

// ─── Markdown 结构解析（ATX 标题 + 代码围栏） ───────────────────────────────

interface HeadingInfo {
  line: number   // 1-based 行号
  level: number  // 1..6
  text: string   // 去掉前导 # 与收尾 # 序列后的标题文本
}

interface FenceState {
  ch: string   // 围栏字符：'`' 或 '~'
  len: number  // 开栏长度（收栏须同字符且不短于开栏）
}

/** 去掉行尾单个 \r（CRLF 文件兼容），仅用于解析；charCount 统计仍基于原始行 */
function normalizeLine(raw: string): string {
  return raw.endsWith('\r') ? raw.slice(0, -1) : raw
}

/**
 * 按行切分。文件以换行结尾时 split 会多出一个空尾元素，弹掉以对齐编辑器行数
 * （"a\nb\n" 是 2 行而不是 3 行），保证 endLine 与用户在编辑器里看到的行号一致。
 */
function splitLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 解析 ATX 标题（CommonMark 风格：≤3 前导空格，#×1..6 后接空白或行尾）；非标题返回 null */
function parseHeading(t: string): { level: number; text: string } | null {
  const m = t.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/)
  if (!m) return null
  // 去掉 ATX 收尾 # 序列（如 "## 标题 ##"）
  const text = (m[2] ?? '').replace(/[ \t]+#+$/, '').trim()
  return { level: m[1].length, text }
}

/** 匹配代码围栏开栏（``` 或 ~~~，≤3 前导空格，可带语言信息串）；不严格校验反引号信息串细则 */
function matchFenceOpen(t: string): FenceState | null {
  const m = t.match(/^ {0,3}(`{3,}|~{3,})/)
  return m ? { ch: m[1][0], len: m[1].length } : null
}

/** 是否为当前围栏的收栏行（同字符、不短于开栏、行内仅围栏与空白） */
function isFenceClose(t: string, fence: FenceState): boolean {
  const m = t.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
  return m !== null && m[1][0] === fence.ch && m[1].length >= fence.len
}

/** 扫描全文 ATX 标题；代码围栏内的 # 行不算标题（技术文档大量代码块，必须排除） */
function scanHeadings(lines: string[]): HeadingInfo[] {
  const headings: HeadingInfo[] = []
  let fence: FenceState | null = null
  for (let i = 0; i < lines.length; i++) {
    const t = normalizeLine(lines[i])
    if (fence) {
      if (isFenceClose(t, fence)) fence = null
      continue
    }
    const open = matchFenceOpen(t)
    if (open) {
      fence = open
      continue
    }
    const h = parseHeading(t)
    if (h) headings.push({ line: i + 1, level: h.level, text: h.text })
  }
  return headings
}

// ─── 切词（确定性：只按空白/标点切，不做分词，中文连续串保持整段） ──────────

/** 标题切词：按"非字母非数字"切开并转小写；中文序列因属 \p{L} 会整体保留 */
function tokenizeHeadingText(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length > 0)
    .map(w => w.toLowerCase())
}

/** 保序去重并截断到上限 */
function dedupeCap(words: string[], cap: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of words) {
    if (seen.has(w)) continue
    seen.add(w)
    out.push(w)
    if (out.length >= cap) break
  }
  return out
}

// ─── 摘要线索提取 ────────────────────────────────────────────────────────────

/** 去掉行首引用记号（>）并修剪空白；引用记号是排版而非内容 */
function cleanSummaryLine(t: string): string {
  return t.replace(/^(\s*>\s?)+/, '').trim()
}

/**
 * 提取首个"非标题非空段落"的前 160 字符作为摘要线索。
 *
 * 为什么要跳过前导噪音：摄取管线产出的知识文件普遍以
 * `<!-- 来源相对路径: ... -->` 注释头 + `---` 包裹的元数据块开头，
 * 逐字取"首段"只会得到元数据而非正文——所以在找到段落起点前跳过：
 * 空行 / 标题 / 代码围栏 / HTML 注释块 / 成对 `---`(或 `...`) 元数据块 / 纯符号行。
 * 孤立未闭合的 `---` 会吞掉后文导致空线索——宁可空线索也不给脏线索。
 */
function extractSummaryHint(lines: string[]): string {
  let fence: FenceState | null = null
  let inComment = false
  let inMetaBlock = false
  const para: string[] = []
  let len = 0

  for (const raw of lines) {
    const t = normalizeLine(raw)
    if (fence) {
      if (isFenceClose(t, fence)) fence = null
      continue
    }
    if (inComment) {
      if (t.includes('-->')) inComment = false
      continue
    }
    if (inMetaBlock) {
      const trimmed = t.trim()
      if (trimmed === '---' || trimmed === '...') inMetaBlock = false
      continue
    }
    const open = matchFenceOpen(t)
    if (open) {
      if (para.length > 0) break   // 段落后紧跟代码块 → 段落结束
      fence = open
      continue
    }
    if (parseHeading(t) !== null) {
      if (para.length > 0) break
      continue
    }
    if (t.trimStart().startsWith('<!--')) {
      if (para.length > 0) break
      if (!t.includes('-->')) inComment = true
      continue
    }
    if (para.length === 0 && t.trim() === '---') {
      inMetaBlock = true
      continue
    }
    const cleaned = cleanSummaryLine(t)
    // 空行或纯符号行（分隔线/表格框线）：找段落时跳过，收集中则视为段落结束
    if (cleaned === '' || !/[\p{L}\p{N}]/u.test(cleaned)) {
      if (para.length > 0) break
      continue
    }
    para.push(cleaned)
    len += cleaned.length + 1
    if (len >= SUMMARY_HINT_MAX) break   // 已够 160 字，无需继续扫描
  }
  return para.join(' ').slice(0, SUMMARY_HINT_MAX)
}

// ─── 章节卡构建 ──────────────────────────────────────────────────────────────

/**
 * 由标题清单切出章节卡。每节区间从标题行起，到下一个同级或更高级标题前一行止
 * （即父节区间覆盖其全部子节）。首个标题前若有非空内容归入 '(引言)' 节；
 * 全文无标题则整篇为单个 '(全文)' 节。
 */
function buildSections(docPath: string, lines: string[], headings: HeadingInfo[]): SectionCard[] {
  const lineCount = lines.length
  const sliceCharCount = (startLine: number, endLine: number): number =>
    lines.slice(startLine - 1, endLine).join('\n').length

  const makeCard = (headingPath: string[], startLine: number, endLine: number): SectionCard => ({
    docPath,
    headingPath,
    startLine,
    endLine,
    charCount: sliceCharCount(startLine, endLine),
    keywords: dedupeCap(tokenizeHeadingText(headingPath[headingPath.length - 1]), SECTION_KEYWORDS_MAX),
  })

  if (headings.length === 0) {
    return [makeCard([FULLTEXT_TITLE], 1, lineCount)]
  }

  const sections: SectionCard[] = []
  const first = headings[0]
  // 首个标题（不限 H1，规格场景即 H1）前的非空引言；纯空行不成节，避免污染 sectionCount
  if (first.line > 1 && lines.slice(0, first.line - 1).some(l => normalizeLine(l).trim() !== '')) {
    sections.push(makeCard([PREFACE_TITLE], 1, first.line - 1))
  }

  const stack: Array<{ level: number; text: string }> = []
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop()
    stack.push({ level: h.level, text: h.text })

    let endLine = lineCount
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        endLine = headings[j].line - 1
        break
      }
    }
    sections.push(makeCard(stack.map(s => s.text), h.line, endLine))
  }
  return sections
}

// ─── 文档扫描与编译 ──────────────────────────────────────────────────────────

/** 目录/文件名级排除：点开头（隐藏/系统）与含 .backup（备份副本不是现役知识） */
function isExcludedName(name: string): boolean {
  return name.startsWith('.') || name.includes('.backup')
}

/** 递归列出待编译 .md 文件，按相对 posix 路径升序（保证 documents 顺序确定可复现） */
function listMarkdownFiles(root: string): Array<{ abs: string; rel: string }> {
  const out: Array<{ abs: string; rel: string }> = []
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (isExcludedName(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(e.name)) continue
        walk(abs)
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/') })
      }
    }
  }
  walk(root)
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

/** 编译单个文档：文档卡 + 章节卡（超上限截断并上报丢弃数，绝不静默） */
function compileDocument(
  relPosix: string,
  content: string,
  mtimeMs: number,
  maxSections: number
): { card: DocumentCard; sections: SectionCard[]; dropped: number } {
  const lines = splitLines(content)
  const headings = scanHeadings(lines)
  const all = buildSections(relPosix, lines, headings)
  const kept = all.length > maxSections ? all.slice(0, maxSections) : all
  const dropped = all.length - kept.length

  // 标题：首个非空 H1；没有（或 H1 文本为空）则回退文件名去扩展名，保证导航列表永远有可读标题
  const h1 = headings.find(h => h.level === 1 && h.text !== '')
  const title = h1 ? h1.text : path.posix.basename(relPosix, '.md')

  const card: DocumentCard = {
    path: relPosix,
    title,
    summaryHint: extractSummaryHint(lines),
    keywords: dedupeCap(headings.flatMap(h => tokenizeHeadingText(h.text)), DOC_KEYWORDS_MAX),
    sectionCount: kept.length,
    charCount: content.length,
    sourceMtimeMs: mtimeMs,
  }
  return { card, sections: kept, dropped }
}

/**
 * 构建知识目录的概念卡索引。
 *
 * 增量规则：prev 中同 path 的文档若 sourceMtimeMs 与 charCount 均未变，
 * 则整卡复用（文档卡 + 章节卡），skippedUnchanged++；否则重新解析。
 * charCount 判据需读文件（UTF-8 字符数≠字节数，stat.size 不可替代），
 * 增量省下的是解析开销而非读盘。
 */
export function buildKnowledgeCards(
  knowledgePath: string,
  prev?: KnowledgeCardsIndex | null,
  opts?: BuildCardsOptions
): BuildCardsResult {
  let rootStat: fs.Stats
  try {
    rootStat = fs.statSync(knowledgePath)
  } catch {
    throw new Error(`[knowledge-cards] 知识目录不存在: ${knowledgePath}`)
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`[knowledge-cards] 不是目录: ${knowledgePath}`)
  }

  const maxSections = opts?.maxSectionsPerDoc ?? DEFAULT_MAX_SECTIONS
  const now = opts?.now ?? Date.now
  const prevByPath = new Map<string, DocumentCard>((prev?.documents ?? []).map(d => [d.path, d]))

  const files = listMarkdownFiles(knowledgePath)
  const documents: DocumentCard[] = []
  const sections: Record<string, SectionCard[]> = {}
  const droppedSections: Array<{ docPath: string; dropped: number }> = []
  let skippedUnchanged = 0

  for (const f of files) {
    const stat = fs.statSync(f.abs)
    const content = fs.readFileSync(f.abs, 'utf-8')

    const prevDoc = prevByPath.get(f.rel)
    if (prev && prevDoc && prevDoc.sourceMtimeMs === stat.mtimeMs && prevDoc.charCount === content.length) {
      documents.push(prevDoc)
      sections[f.rel] = prev.sections[f.rel] ?? []
      skippedUnchanged++
      continue
    }

    const compiled = compileDocument(f.rel, content, stat.mtimeMs, maxSections)
    documents.push(compiled.card)
    sections[f.rel] = compiled.sections
    if (compiled.dropped > 0) droppedSections.push({ docPath: f.rel, dropped: compiled.dropped })
  }

  return {
    index: { version: 1, builtAtMs: now(), documents, sections },
    scannedFiles: files.length,
    skippedUnchanged,
    droppedSections,
  }
}

// ─── 索引持久化 ──────────────────────────────────────────────────────────────

/** 索引文件路径：<knowledgePath>/_cards/index.json */
export function cardsIndexPath(knowledgePath: string): string {
  return path.join(knowledgePath, CARDS_DIRNAME, 'index.json')
}

/**
 * 读取已保存的索引；缺失/损坏/结构不符一律返回 null 不 throw——
 * 加载方（应用启动路径）不能被坏索引拖垮，退化为全量重建即可。
 */
export function loadCardsIndex(knowledgePath: string): KnowledgeCardsIndex | null {
  try {
    const raw = fs.readFileSync(cardsIndexPath(knowledgePath), 'utf-8')
    const parsed = JSON.parse(raw) as KnowledgeCardsIndex
    if (typeof parsed !== 'object' || parsed === null) return null
    if (parsed.version !== 1) return null
    if (!Array.isArray(parsed.documents)) return null
    if (typeof parsed.sections !== 'object' || parsed.sections === null || Array.isArray(parsed.sections)) return null
    return parsed
  } catch {
    return null
  }
}

/** 原子写（tmp+rename，与 knowledge-indexer 同款）：读方永远看不到写了一半的索引 */
function atomicWriteSync(filePath: string, data: string): void {
  const tmpPath = filePath + `.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmpPath, data, 'utf-8')
  try {
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* 清理失败不阻塞 */ }
    throw err
  }
}

/** 保存索引：建目录 + 原子写 */
export function saveCardsIndex(knowledgePath: string, index: KnowledgeCardsIndex): void {
  const target = cardsIndexPath(knowledgePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  atomicWriteSync(target, JSON.stringify(index))
}
