/**
 * fix-l5-bom-mustcontain.ts — 一次性脚本：剔除 L5 BOM 题 mustContain 里的"列值脏数据"
 *
 * 背景：
 *   2026-05-02 的回归报告（5213722c577b）显示 L5-c740337c 失败，根因是 question-bank.json
 *   里 mustContain 写成 ["1. 交付完成——调试完成——开始投运\n"] 这种"流程描述"。这条
 *   字符串来自 BOM Excel 里 `供应商` 列被错误写入"流程备注"的脏数据，校验断言要求
 *   分身原样吐回去，分身正常给"供应商=明美/华致"的合规答案反而被判失败。
 *
 * 改造：
 *   - 遍历 `question-bank.json` 中所有 `category = L5_bom` 题目
 *   - 对 `mustContain[0]` 做"列值合理性"校验：
 *       命中以下任一关键词视为脏数据：完成 / 投运 / 调试 / 交付 / 备注 / 待 / 月 / 待定 / 无
 *       字符串长度 > 18 或包含中文标点（——、；）也视为脏数据
 *   - 脏数据 → 清空 mustContain（仅保留 expectedTools + sourceCell 用于校验调用 query_excel
 *     与定位 sheet/row）
 *
 * 与 desktop-app/electron/kb-question-generator.ts 的 generateL5Bom 保持同步，
 * 避免下次重新生成题库时回退（详见 generator 的"列值合理性校验"段）。
 *
 * 用法：
 *   npx tsx expert-packs/小堵-工商储专家/tests/scripts/fix-l5-bom-mustcontain.ts
 *
 * @author zhi.qu
 * @date 2026-05-02
 */

import fs from 'fs'
import path from 'path'

interface SourceCell {
  sheet: string
  rowIndex: number
  column: string
}

interface Question {
  id: string
  category: string
  prompt: string
  mustContain?: string[]
  sourceFile?: string
  sourceCell?: SourceCell
  [key: string]: unknown
}

interface QuestionBank {
  questions: Question[]
  [key: string]: unknown
}

/** 列值脏数据关键词 — 命中任一则判为脏数据 */
const DIRTY_KEYWORDS = ['完成', '投运', '调试', '交付', '备注', '待', '月', '待定', '无']
/** 中文/特殊标点 — 出现即视为脏数据（正常供应商名/物料号不会有这些） */
const DIRTY_PUNCTS = ['——', '；', '；', '；', '\n']
/** 列值长度上限 — 超过视为脏数据（正常供应商名/物料号通常 ≤ 18 字符） */
const MAX_CLEAN_LEN = 18

/**
 * 判断 mustContain 字符串是否为脏数据
 * @param raw mustContain[0] 的原值
 * @returns 是否脏
 */
function isDirtyValue(raw: string): boolean {
  const v = raw.trim()
  if (v === '') return false
  if (v.length > MAX_CLEAN_LEN) return true
  for (const kw of DIRTY_KEYWORDS) {
    if (v.includes(kw)) return true
  }
  for (const p of DIRTY_PUNCTS) {
    if (v.includes(p)) return true
  }
  return false
}

function main(): void {
  const bankPath = path.resolve(
    __dirname,
    '../generated/question-bank.json',
  )
  const raw = fs.readFileSync(bankPath, 'utf8')
  const bank = JSON.parse(raw) as QuestionBank

  const cleared: string[] = []
  const kept: string[] = []

  for (const q of bank.questions) {
    if (q.category !== 'L5_bom') continue
    if (!q.mustContain || q.mustContain.length === 0) continue

    const first = q.mustContain[0]
    if (typeof first !== 'string') continue

    if (isDirtyValue(first)) {
      const before = JSON.stringify(q.mustContain)
      q.mustContain = []
      cleared.push(`${q.id}: ${before} → []`)
    } else {
      kept.push(q.id)
    }
  }

  fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2) + '\n', 'utf8')

  console.log(`已清空 L5 mustContain ${cleared.length} 条（命中脏数据规则）：`)
  for (const line of cleared) console.log('  - ' + line)
  console.log(`保留 ${kept.length} 条 L5 题（mustContain 为正常列值）`)
}

main()
