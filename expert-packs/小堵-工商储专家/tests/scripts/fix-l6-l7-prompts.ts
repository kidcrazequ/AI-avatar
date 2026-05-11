/**
 * fix-l6-l7-prompts.ts — 一次性脚本：给 L6/L7 题目 prompt 加 file#section 锚点
 *
 * 背景：
 *   2026-05-01 回归报告显示 L6/L7 失败的 23 题中，绝大多数是 expectedValue 不匹配。
 *   根因：prompt 形如"4. 数据表格 涉及的 ℃ 具体数值是多少？" 太宽泛，
 *   而"数据表格"/"接线图"等章节标题在十几份规范/报告里都出现过，分身找到的
 *   往往不是该题对应的源段。
 *
 * 改造：
 *   - 对每条带 sourceFile + sourceSection 的 L6/L7 题，把 prompt 改写为：
 *     `在 \`knowledge/<sourceFile>\` 的「<sourceSection>」一节中，涉及 <unit> 的
 *     具体数值是多少？请引用原文回答并标注来源（含 file#section）。`
 *   - 与 desktop-app/electron/kb-question-generator.ts 的生成模板保持同步。
 *
 * 用法：
 *   npx tsx expert-packs/小堵-工商储专家/tests/scripts/fix-l6-l7-prompts.ts
 *
 * 反查策略：
 *   如果当前 expectedValue 在 sourceFile 中不存在，会写一份 _pending_fix.md，
 *   不直接改写题目，避免硬调引入新错误。
 *
 * @author zhi.qu
 * @date 2026-05-01
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
  expectedValue?: ExpectedValue
  sourceFile?: string
  sourceSection?: string
  [key: string]: unknown
}

interface QuestionBank {
  questions: Question[]
  [key: string]: unknown
}

const KNOWLEDGE_ROOT = path.resolve(
  __dirname,
  '../../knowledge',
)
const BANK_PATH = path.resolve(
  __dirname,
  '../generated/question-bank.json',
)
const PENDING_PATH = path.resolve(
  __dirname,
  '../runs/_pending_fix.md',
)

/**
 * 在 sourceFile 中粗略验证 expectedValue 的存在性。
 * 用宽松匹配：寻找 "数字 + 单位" 的字符串组合。
 */
function valueExistsInFile(filePath: string, ev: ExpectedValue): boolean {
  if (!ev.unit) return true
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return false
  }
  const tol = Math.abs(ev.tolerancePct) / 100
  const lower = ev.value === 0 ? -0.5 : ev.value * (1 - tol)
  const upper = ev.value === 0 ? 0.5 : ev.value * (1 + tol)
  const min = Math.min(lower, upper)
  const max = Math.max(lower, upper)
  const numberRegex = /(\d+(?:\.\d+)?)\s*[^\d]/g
  let match: RegExpExecArray | null
  while ((match = numberRegex.exec(text)) !== null) {
    const n = parseFloat(match[1])
    if (!Number.isFinite(n) || n < min || n > max) continue
    const around = text.slice(
      Math.max(0, match.index - 3),
      Math.min(text.length, match.index + match[0].length + ev.unit.length + 3),
    )
    if (around.includes(ev.unit)) return true
  }
  return false
}

function main(): void {
  const raw = fs.readFileSync(BANK_PATH, 'utf8')
  const bank = JSON.parse(raw) as QuestionBank

  const changed: string[] = []
  const skipped: { id: string; reason: string }[] = []
  const pending: { id: string; reason: string; expected: string; sourceFile: string }[] = []

  for (const q of bank.questions) {
    if (q.category !== 'L6_protocol' && q.category !== 'L7_certification') continue
    if (!q.sourceFile || !q.sourceSection) {
      skipped.push({ id: q.id, reason: '缺 sourceFile/sourceSection' })
      continue
    }

    const newPrompt = q.expectedValue
      ? `在 \`knowledge/${q.sourceFile}\` 的「${q.sourceSection}」一节中，涉及 ${q.expectedValue.unit ?? ''} 的具体数值是多少？请引用原文回答并标注来源（含 file#section）。`
      : `\`knowledge/${q.sourceFile}\` 的「${q.sourceSection}」一节的核心要点是什么？请引用原文回答并标注来源（含 file#section）。`

    if (q.expectedValue) {
      const filePath = path.join(KNOWLEDGE_ROOT, q.sourceFile)
      if (!valueExistsInFile(filePath, q.expectedValue)) {
        pending.push({
          id: q.id,
          reason: `expectedValue=${q.expectedValue.value}${q.expectedValue.unit ?? ''} 在 sourceFile 中未找到 — 题目数据本身可疑，未改写`,
          expected: `${q.expectedValue.value}${q.expectedValue.unit ?? ''}`,
          sourceFile: q.sourceFile,
        })
        continue
      }
    }

    if (q.prompt === newPrompt) continue
    q.prompt = newPrompt
    changed.push(q.id)
  }

  fs.writeFileSync(BANK_PATH, JSON.stringify(bank, null, 2) + '\n', 'utf8')

  if (pending.length > 0) {
    const lines: string[] = ['# L6/L7 题目数据反查未通过清单（不修改 prompt）', '']
    lines.push(`> 生成时间：2026-05-01；共 ${pending.length} 条建议人工复核或重新生成`)
    lines.push('')
    for (const p of pending) {
      lines.push(`- **${p.id}**`)
      lines.push(`  - sourceFile: \`knowledge/${p.sourceFile}\``)
      lines.push(`  - 期望: \`${p.expected}\``)
      lines.push(`  - 原因: ${p.reason}`)
    }
    fs.writeFileSync(PENDING_PATH, lines.join('\n') + '\n', 'utf8')
  }

  console.log(`已重写 prompt ${changed.length} 条`)
  if (changed.length > 0) {
    console.log('  样本:')
    for (const id of changed.slice(0, 3)) console.log('    - ' + id)
  }
  if (skipped.length > 0) {
    console.log(`跳过 ${skipped.length} 条:`)
    for (const s of skipped.slice(0, 5)) console.log(`    - ${s.id} (${s.reason})`)
  }
  if (pending.length > 0) {
    console.log(`数据存疑 ${pending.length} 条 → ${PENDING_PATH}`)
  }
}

main()
