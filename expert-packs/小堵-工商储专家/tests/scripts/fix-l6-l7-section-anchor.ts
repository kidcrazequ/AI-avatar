/**
 * fix-l6-l7-section-anchor.ts — 一次性脚本：校正 L6/L7 题目的「章节锚点」与 prompt
 *
 * 背景：
 *   2026-05-02 的回归报告（5213722c577b）显示 L6/L7 失败 3 题，根因都在题库侧的
 *   sourceSection 锚点不准：
 *     - L6-75fceb56：sourceSection="5. 接线图：描述端子排列、线缆规格"，但该章节正文
 *       仅 1 行（"图中未包含接线图..."），实际 °C 数值在更前面的「一、主要技术参数」
 *       的"环境温度 -25°C--55°C"。fix-l6-l7-prompts.ts 的 valueExistsInFile 走的是
 *       "整文件搜索"，无法发现章节内是空的。
 *     - L7-0459ad60：sourceSection="数据表格"，而该报告里"### 数据表格"出现了 3 次，
 *       expectedValue=100% 实际只在第 3 次出现的章节（×100% 的列名计算）。
 *
 * 改造：
 *   1. 用增强版章节切分（markdown ## ### #### + 中文一二三四级编号「一、xxx」）
 *      解析 sourceFile，并对同名章节做 (N) 后缀去重，得到唯一章节 ID。
 *   2. 对每条带 expectedValue 的 L6/L7 题：
 *      - 先按当前 sourceSection 找章节正文（含同名 (N) 变体）
 *      - 校验"章节正文是否实际包含 expectedValue 的数字+单位"
 *      - 不命中则**重选**：在文件内按文档顺序找首个真正包含目标值的章节
 *      - 改写 sourceSection（如有 (N) 后缀也写进去）+ 改写 prompt（与
 *        fix-l6-l7-prompts.ts 保持同样的"在 `knowledge/<file>` 的「<section>」一节
 *        中..."模板）
 *   3. 写不回去的（重新选也找不到）→ 落入 _pending_fix_l6l7_anchor.md，不动题目
 *
 * 与 desktop-app/electron/kb-question-generator.ts 的 generateMdQuestions /
 * splitMarkdownByHeading 同步：生成器侧会做章节正文长度过滤、值校验、同名章节
 * 后缀去重，避免下次重新生成题库时回退。
 *
 * 用法：
 *   npx tsx expert-packs/小堵-工商储专家/tests/scripts/fix-l6-l7-section-anchor.ts
 *
 * @author zhi.qu
 * @date 2026-05-02
 */

import fs from 'fs'
import path from 'path'

interface ExpectedValue {
  value: number
  unit?: string
  tolerancePct: number
}

interface Question {
  id: string
  category: string
  prompt: string
  mustContain?: string[]
  expectedValue?: ExpectedValue
  sourceFile?: string
  sourceSection?: string
  [key: string]: unknown
}

interface QuestionBank {
  questions: Question[]
  [key: string]: unknown
}

interface Chapter {
  /** 经过同名后缀去重后的唯一标题（如 "数据表格 (3)"） */
  uniqueTitle: string
  /** 原始标题（如 "数据表格"） */
  rawTitle: string
  /** 章节正文 */
  content: string
}

const KNOWLEDGE_ROOT = path.resolve(__dirname, '../../knowledge')
const BANK_PATH = path.resolve(__dirname, '../generated/question-bank.json')
const PENDING_PATH = path.resolve(
  __dirname,
  '../runs/_pending_fix_l6l7_anchor.md',
)

/**
 * 增强版 markdown 章节切分：
 *   - 识别 markdown ## ### #### 标题
 *   - 识别中文一二三四级编号 "一、xxx" / "二、xxx"（独立成行，不在表格 | 行内）
 *   - 不识别 1.1 / 1.2 等子级编号，避免噪声
 *   - 同名章节按出现序补 (2) (3) ... 后缀，保证 uniqueTitle 唯一
 */
function splitChapters(text: string): Chapter[] {
  const lines = text.split('\n')
  const raw: { title: string; lines: string[] }[] = []
  let currentTitle = ''
  let currentLines: string[] = []

  const flush = () => {
    if (currentTitle && currentLines.length > 0) {
      const content = currentLines.join('\n').trim()
      if (content.length > 0) raw.push({ title: currentTitle, lines: currentLines })
    }
  }

  for (const line of lines) {
    const mdMatch = line.match(/^(#{2,4})\s+(.+?)\s*$/)
    const cnMatch = line.match(/^([一二三四五六七八九十]+)、\s*(.+?)\s*$/)
    let title: string | null = null
    if (mdMatch) {
      title = mdMatch[2].trim()
    } else if (cnMatch && !line.includes('|')) {
      title = `${cnMatch[1]}、${cnMatch[2].trim()}`
    }
    if (title) {
      flush()
      currentTitle = title
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }
  flush()

  const seen = new Map<string, number>()
  const chapters: Chapter[] = []
  for (const r of raw) {
    const n = (seen.get(r.title) ?? 0) + 1
    seen.set(r.title, n)
    const uniqueTitle = n === 1 ? r.title : `${r.title} (${n})`
    chapters.push({
      uniqueTitle,
      rawTitle: r.title,
      content: r.lines.join('\n').trim(),
    })
  }
  return chapters
}

/**
 * 校验章节正文是否包含 expectedValue 的"数字 + 单位"组合（容差 tolerancePct）
 */
function chapterContainsValue(content: string, ev: ExpectedValue): boolean {
  if (!ev.unit) return true
  const tol = Math.abs(ev.tolerancePct) / 100
  const lower = ev.value === 0 ? -0.5 : ev.value * (1 - tol)
  const upper = ev.value === 0 ? 0.5 : ev.value * (1 + tol)
  const min = Math.min(lower, upper)
  const max = Math.max(lower, upper)
  const numberRegex = /(\d+(?:\.\d+)?)/g
  let match: RegExpExecArray | null
  while ((match = numberRegex.exec(content)) !== null) {
    const n = parseFloat(match[1])
    if (!Number.isFinite(n) || n < min || n > max) continue
    const around = content.slice(
      Math.max(0, match.index - 3),
      Math.min(content.length, match.index + match[0].length + ev.unit.length + 3),
    )
    if (around.includes(ev.unit)) return true
  }
  return false
}

/**
 * 在 sourceFile 的章节列表里查找当前 sourceSection 对应的章节
 * 优先精确匹配 uniqueTitle，其次匹配首个 rawTitle 相同的章节
 */
function findChapterBySection(
  chapters: Chapter[],
  sourceSection: string,
): Chapter | undefined {
  const exact = chapters.find(c => c.uniqueTitle === sourceSection)
  if (exact) return exact
  const byRaw = chapters.find(c => c.rawTitle === sourceSection)
  return byRaw
}

/**
 * 在文件内按文档顺序找首个真正包含 expectedValue 的章节
 */
function pickFirstChapterWithValue(
  chapters: Chapter[],
  ev: ExpectedValue,
): Chapter | undefined {
  for (const ch of chapters) {
    if (chapterContainsValue(ch.content, ev)) return ch
  }
  return undefined
}

function buildPrompt(sourceFile: string, section: string, ev: ExpectedValue): string {
  return `在 \`knowledge/${sourceFile}\` 的「${section}」一节中，涉及 ${ev.unit ?? ''} 的具体数值是多少？请引用原文回答并标注来源（含 file#section）。`
}

function main(): void {
  const raw = fs.readFileSync(BANK_PATH, 'utf8')
  const bank = JSON.parse(raw) as QuestionBank

  const fixed: string[] = []
  const okPass: string[] = []
  const pending: { id: string; reason: string }[] = []
  const fileChapterCache = new Map<string, Chapter[]>()

  function loadChapters(sourceFile: string): Chapter[] | null {
    const cached = fileChapterCache.get(sourceFile)
    if (cached) return cached
    const filePath = path.join(KNOWLEDGE_ROOT, sourceFile)
    let text: string
    try {
      text = fs.readFileSync(filePath, 'utf8')
    } catch {
      return null
    }
    text = text.replace(/^---[\s\S]*?\n---\s*\n?/m, '')
    const chapters = splitChapters(text)
    fileChapterCache.set(sourceFile, chapters)
    return chapters
  }

  for (const q of bank.questions) {
    if (q.category !== 'L6_protocol' && q.category !== 'L7_certification') continue
    if (!q.sourceFile || !q.sourceSection || !q.expectedValue) continue

    const chapters = loadChapters(q.sourceFile)
    if (!chapters || chapters.length === 0) {
      pending.push({ id: q.id, reason: `无法读取或切分 sourceFile=${q.sourceFile}` })
      continue
    }

    const currentChapter = findChapterBySection(chapters, q.sourceSection)
    if (currentChapter && chapterContainsValue(currentChapter.content, q.expectedValue)) {
      okPass.push(q.id)
      continue
    }

    const candidate = pickFirstChapterWithValue(chapters, q.expectedValue)
    if (!candidate) {
      pending.push({
        id: q.id,
        reason: `expectedValue=${q.expectedValue.value}${q.expectedValue.unit ?? ''} 在 ${q.sourceFile} 任何章节都未找到`,
      })
      continue
    }

    const oldSection = q.sourceSection
    q.sourceSection = candidate.uniqueTitle
    q.prompt = buildPrompt(q.sourceFile, candidate.uniqueTitle, q.expectedValue)
    fixed.push(`${q.id}: 「${oldSection}」→「${candidate.uniqueTitle}」`)
  }

  fs.writeFileSync(BANK_PATH, JSON.stringify(bank, null, 2) + '\n', 'utf8')

  if (pending.length > 0) {
    const lines: string[] = ['# L6/L7 章节锚点修复 — 待人工复核清单', '']
    lines.push(`> 生成时间：2026-05-02；共 ${pending.length} 条无法自动重选`)
    lines.push('')
    for (const p of pending) {
      lines.push(`- **${p.id}** — ${p.reason}`)
    }
    fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true })
    fs.writeFileSync(PENDING_PATH, lines.join('\n') + '\n', 'utf8')
  }

  console.log(`已重写章节锚点 ${fixed.length} 条：`)
  for (const line of fixed) console.log('  - ' + line)
  console.log(`原章节已正确包含目标值，无需改：${okPass.length} 条`)
  if (pending.length > 0) {
    console.log(`无法自动重选 ${pending.length} 条 → ${PENDING_PATH}`)
    for (const p of pending) console.log(`    - ${p.id}: ${p.reason}`)
  }
}

main()
