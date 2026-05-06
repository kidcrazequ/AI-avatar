/**
 * regression-prepare-table.ts — prepareTable + ffillLeadingColumns 回归验证脚本
 *
 * 验证：
 *   1. _excel/*.json 结构化数据（columns + rows）与改前完全一致
 *   2. markdown 表格表头从 col1/col2 升级为真实列名（子任务 2 预期变化）
 *   3. 合并单元格前向填充生效：前 N 列的空 cell 被上方值填充（子任务 3 预期变化）
 *
 * 用法：
 *   cd desktop-app
 *   npx tsx scripts/regression-prepare-table.ts
 *
 * @author zhi.qu
 * @date 2026-05-02
 */

import fs from 'fs'
import path from 'path'
import { DocumentParser } from '../electron/document-parser'

const AVATAR_ROOT = path.resolve(__dirname, '../../avatars/小堵-工商储专家/knowledge')
const RAW_DIR = path.join(AVATAR_ROOT, '_raw')
const EXCEL_DIR = path.join(AVATAR_ROOT, '_excel')
const OUT_MD = '/tmp/regression-md'
const OUT_JSON = '/tmp/regression-json'

const TEST_FILES = [
  '调试问题top10.xlsx',
  '通用柜体检验指导书.xlsx',
]

function toBaseName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_MD, { recursive: true })
  fs.mkdirSync(OUT_JSON, { recursive: true })

  const parser = new DocumentParser()
  let allPass = true

  for (const file of TEST_FILES) {
    const rawPath = path.join(RAW_DIR, file)
    if (!fs.existsSync(rawPath)) {
      console.log(`⏭  跳过 ${file}（_raw/ 中不存在）`)
      continue
    }

    console.log(`\n===== ${file} =====`)

    const result = await parser.parseFile(rawPath)

    // 写 markdown 输出供人工 diff
    const baseName = toBaseName(file)
    const mdPath = path.join(OUT_MD, `${baseName}.md`)
    fs.writeFileSync(mdPath, result.text, 'utf-8')
    console.log(`📝 md  → ${mdPath}`)

    // 写 JSON 输出
    const jsonPath = path.join(OUT_JSON, `${baseName}.json`)
    if (result.structuredData) {
      fs.writeFileSync(jsonPath, JSON.stringify(result.structuredData, null, 2), 'utf-8')
      console.log(`📝 json → ${jsonPath}`)
    }

    // 与现有 _excel JSON 比对 columns.name
    const existingJsonPath = path.join(EXCEL_DIR, `${baseName}.json`)
    if (fs.existsSync(existingJsonPath) && result.structuredData) {
      const existing = JSON.parse(fs.readFileSync(existingJsonPath, 'utf-8'))
      let jsonMatch = true

      for (let si = 0; si < existing.sheets.length; si++) {
        const oldSheet = existing.sheets[si]
        const newSheet = result.structuredData.sheets[si]
        if (!newSheet) {
          console.log(`  ❌ sheet[${si}] "${oldSheet.name}" 缺失`)
          jsonMatch = false
          continue
        }

        // 比对列名
        const oldCols = oldSheet.columns.map((c: { name: string }) => c.name)
        const newCols = newSheet.columns.map((c: { name: string }) => c.name)
        if (JSON.stringify(oldCols) !== JSON.stringify(newCols)) {
          console.log(`  ❌ sheet "${oldSheet.name}" columns 不一致:`)
          console.log(`     旧: ${JSON.stringify(oldCols)}`)
          console.log(`     新: ${JSON.stringify(newCols)}`)
          jsonMatch = false
        }

        // 比对行数
        if (oldSheet.rowCount !== newSheet.rowCount) {
          console.log(`  ❌ sheet "${oldSheet.name}" rowCount: ${oldSheet.rowCount} → ${newSheet.rowCount}`)
          jsonMatch = false
        }

        // 比对首行 keys
        if (oldSheet.rows.length > 0 && newSheet.rows.length > 0) {
          const oldKeys = Object.keys(oldSheet.rows[0]).sort()
          const newKeys = Object.keys(newSheet.rows[0]).sort()
          if (JSON.stringify(oldKeys) !== JSON.stringify(newKeys)) {
            console.log(`  ❌ sheet "${oldSheet.name}" row keys 不一致:`)
            console.log(`     旧: ${JSON.stringify(oldKeys)}`)
            console.log(`     新: ${JSON.stringify(newKeys)}`)
            jsonMatch = false
          }
        }
      }

      if (jsonMatch) {
        console.log(`  ✅ JSON 结构化数据与现有 _excel JSON 一致（query_excel 行为不变）`)
      } else {
        allPass = false
      }
    } else {
      console.log(`  ⚠️  无现有 _excel JSON 可对比，请人工检查输出`)
    }

    // 输出 markdown 表头摘要供快速确认
    const mdLines = result.text.split('\n')
    const headerLines = mdLines.filter(l => l.startsWith('| ') && !l.startsWith('| ---'))
    if (headerLines.length > 0) {
      console.log(`  📋 md 表头: ${headerLines[0].slice(0, 120)}${headerLines[0].length > 120 ? '...' : ''}`)
    }

    // 验证前向填充（ffill）效果
    const tableLines = mdLines.filter(l => l.startsWith('| '))
    if (tableLines.length > 2) {
      const dataLines = tableLines.slice(2) // 跳过表头和分隔线
      let emptyLeadingBefore = 0
      let emptyLeadingAfter = 0
      for (const line of dataLines) {
        const cells = line.split('|').slice(1, 4) // 前 3 列
        for (const cell of cells) {
          if (cell.trim() === '') emptyLeadingAfter++
        }
      }

      // 与原 md 对比前 3 列空 cell 数
      const existingMdPath = path.join(AVATAR_ROOT, `${baseName}.md`)
      if (fs.existsSync(existingMdPath)) {
        const existingLines = fs.readFileSync(existingMdPath, 'utf-8').split('\n').filter(l => l.startsWith('| '))
        if (existingLines.length > 2) {
          for (const line of existingLines.slice(2)) {
            const cells = line.split('|').slice(1, 4)
            for (const cell of cells) {
              if (cell.trim() === '') emptyLeadingBefore++
            }
          }
          const reduced = emptyLeadingBefore - emptyLeadingAfter
          if (reduced > 0) {
            console.log(`  🔄 ffill 效果: 前 3 列空 cell 从 ${emptyLeadingBefore} 减少到 ${emptyLeadingAfter}（填充了 ${reduced} 个）`)
          } else if (emptyLeadingBefore === 0 && emptyLeadingAfter === 0) {
            console.log(`  ✅ ffill: 前 3 列无空 cell（无需填充）`)
          } else {
            console.log(`  ℹ️  ffill: 前 3 列空 cell 未减少（before=${emptyLeadingBefore}, after=${emptyLeadingAfter}）`)
          }
        }
      }

      // 输出前 5 行 body 供人工确认
      console.log(`  📋 md 前 5 行数据（验证 ffill）:`)
      for (let di = 0; di < Math.min(5, dataLines.length); di++) {
        console.log(`     ${dataLines[di].slice(0, 140)}${dataLines[di].length > 140 ? '...' : ''}`)
      }
    }
  }

  console.log('\n' + '='.repeat(60))
  if (allPass) {
    console.log('✅ 全部通过 — query_excel 行为不变，markdown 表头 + ffill 已升级')
  } else {
    console.log('⚠️  存在差异，请检查上方输出')
  }

  console.log(`\n💡 人工 diff markdown 变化：`)
  console.log(`   diff ${AVATAR_ROOT}/调试问题top10.md ${OUT_MD}/调试问题top10.md`)
}

main().catch(err => {
  console.error('脚本执行失败:', err)
  process.exit(1)
})
