/**
 * fix-l8-traceability-bank.ts — 一次性脚本：为 L8 溯源题补铺垫上下文
 *
 * 背景：
 *   2026-05-01 回归报告显示 L8 5 题中有 2 题失败，根因是 batch-regression-runner
 *   每题独立 conversationId，分身没有"刚才那条回答"的上下文。
 *
 * 改造：
 *   - 给每一道 L8 题补上对应的 setupPrompts（先行对话），运行器会在收集 telemetry
 *     之前回放 setupPrompts，让分身真的"刚回答过一个问题"。
 *   - 与 desktop-app/electron/kb-question-generator.ts 的 TRACEABILITY_TEMPLATES
 *     映射保持同步。
 *
 * 用法：
 *   npx tsx expert-packs/小堵-工商储专家/tests/scripts/fix-l8-traceability-bank.ts
 *
 * @author zhi.qu
 * @date 2026-05-01
 */

import fs from 'fs'
import path from 'path'

interface Question {
  id: string
  category: string
  prompt: string
  mustContain?: string[]
  setupPrompts?: string[]
  [key: string]: unknown
}

interface QuestionBank {
  questions: Question[]
  [key: string]: unknown
}

/** prompt -> setupPrompts 映射（与 kb-question-generator.ts 保持一致） */
const SETUP_BY_PROMPT: Record<string, string[]> = {
  '你刚才那段回答的数据来自哪个知识文件？':
    ['256（华致）的故障次数_8 是多少？请给出具体数字并标注来源。'],
  '请把上一个问题答案的完整来源路径告诉我。':
    ['ENS-L256 对应的供应商是什么？请给出准确值并标注来源（含 file#sheet 锚点）。'],
  '上一条回答里的数字是从哪个 Excel sheet 哪一行来的？':
    ['262（明美）的「故障次数」是多少？请精确到 file#sheet#row。'],
  '请把刚才引用的来源原文贴给我。':
    ['远景动力 315Ah 储能电芯的标准质保循环次数是多少？请引用知识库原文。'],
  '我能在哪个知识文件里找到刚才回答的依据？':
    ['ENS-L262 户外柜的铭牌外形尺寸（长×宽×高）是多少？请标注来源。'],
}

function main(): void {
  const bankPath = path.resolve(
    __dirname,
    '../generated/question-bank.json',
  )
  const raw = fs.readFileSync(bankPath, 'utf8')
  const bank = JSON.parse(raw) as QuestionBank

  const changed: string[] = []
  const skipped: string[] = []

  for (const q of bank.questions) {
    if (q.category !== 'L8_traceability') continue
    const setup = SETUP_BY_PROMPT[q.prompt]
    if (!setup) {
      skipped.push(q.id + '（未在映射表中找到 prompt）')
      continue
    }
    const before = JSON.stringify(q.setupPrompts ?? [])
    const after = JSON.stringify(setup)
    if (before === after) continue
    q.setupPrompts = setup
    changed.push(`${q.id}: setupPrompts ${before} → ${after}`)
  }

  fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2) + '\n', 'utf8')

  console.log(`已修改 L8 溯源题 ${changed.length} 条：`)
  for (const line of changed) console.log('  - ' + line)
  if (skipped.length > 0) {
    console.log(`跳过 ${skipped.length} 条：`)
    for (const line of skipped) console.log('  - ' + line)
  }
}

main()
