/**
 * backfill-excel-json.ts — 一次性 Excel JSON 回填脚本
 *
 * 背景：早期版本的 batchImportFiles 漏写 _excel/<basename>.json，
 * 只产出 .md 文件，导致 query_excel 工具无可查的结构化 JSON。
 * 此脚本扫描 _raw/ 下所有 Excel 重新解析并写 _excel/<basename>.json。
 *
 * 用法：
 *   cd desktop-app
 *   npx tsx scripts/backfill-excel-json.ts <avatar-id>
 *
 * 例：
 *   npx tsx scripts/backfill-excel-json.ts 小堵-工商储专家
 *
 * 行为：
 *   - 扫描 avatars/<id>/knowledge/_raw/**\/*.{xlsx,xls}
 *   - basename 计算与 batchImportFiles 完全一致（保证 query_excel 能找到）
 *   - 已存在且 mtime 不旧于源文件的 _excel json 跳过
 *   - 解析失败的文件继续处理后续文件，最后汇总
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import fs from 'fs'
import path from 'path'
import { DocumentParser } from '../electron/document-parser'

interface BackfillStats {
  ok: number
  skip: number
  fail: number
  failed: Array<{ path: string; error: string }>
}

/** 与 batchImportFiles 中保持一致的 basename 规则 */
function toBaseName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
}

function collectExcelFiles(dir: string): string[] {
  const out: string[] = []
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (/\.(xlsx|xls)$/i.test(e.name)) out.push(full)
    }
  }
  return out
}

async function backfill(avatarsRoot: string, avatarId: string): Promise<BackfillStats> {
  const knowledgeRoot = path.join(avatarsRoot, avatarId, 'knowledge')
  const rawDir = path.join(knowledgeRoot, '_raw')
  const excelDir = path.join(knowledgeRoot, '_excel')

  if (!fs.existsSync(rawDir)) {
    throw new Error(`_raw 目录不存在: ${rawDir}`)
  }
  if (!fs.existsSync(excelDir)) {
    fs.mkdirSync(excelDir, { recursive: true })
  }

  const excelFiles = collectExcelFiles(rawDir)
  console.log(`[backfill] 在 ${rawDir} 找到 ${excelFiles.length} 个 Excel 文件`)
  if (excelFiles.length === 0) return { ok: 0, skip: 0, fail: 0, failed: [] }

  const parser = new DocumentParser()
  const stats: BackfillStats = { ok: 0, skip: 0, fail: 0, failed: [] }

  for (let i = 0; i < excelFiles.length; i++) {
    const xfPath = excelFiles[i]
    const fileName = path.basename(xfPath)
    const baseName = toBaseName(fileName)
    const outPath = path.join(excelDir, `${baseName}.json`)

    // 已存在且 mtime 不老于源文件 → 跳过
    if (fs.existsSync(outPath)) {
      try {
        const outStat = fs.statSync(outPath)
        const srcStat = fs.statSync(xfPath)
        if (outStat.mtimeMs >= srcStat.mtimeMs) {
          stats.skip++
          console.log(`[${i + 1}/${excelFiles.length}] SKIP ${fileName} (已是最新)`)
          continue
        }
      } catch { /* 状态读取失败则重新解析 */ }
    }

    process.stdout.write(`[${i + 1}/${excelFiles.length}] PARSE ${fileName} ... `)
    const t0 = Date.now()
    try {
      const parsed = await parser.parseFile(xfPath)
      if (!parsed.structuredData) {
        console.log('SKIP（解析无 structuredData）')
        stats.skip++
        continue
      }
      fs.writeFileSync(outPath, JSON.stringify(parsed.structuredData, null, 2), 'utf-8')
      const ms = Date.now() - t0
      const sheetCount = parsed.structuredData.sheets.length
      const rowCount = parsed.structuredData.sheets.reduce((s, sh) => s + sh.rowCount, 0)
      console.log(`OK ${ms}ms · ${sheetCount} sheet · ${rowCount} rows`)
      stats.ok++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`FAIL: ${msg.slice(0, 120)}`)
      stats.fail++
      stats.failed.push({ path: xfPath, error: msg })
    }
  }

  return stats
}

async function main(): Promise<void> {
  const avatarId = process.argv[2]
  if (!avatarId) {
    console.error('用法: npx tsx scripts/backfill-excel-json.ts <avatar-id>')
    process.exit(1)
  }

  // 仓库根 = desktop-app 的上一级
  const repoRoot = path.resolve(__dirname, '..', '..')
  const avatarsRoot = path.join(repoRoot, 'avatars')
  if (!fs.existsSync(path.join(avatarsRoot, avatarId))) {
    console.error(`分身目录不存在: ${path.join(avatarsRoot, avatarId)}`)
    process.exit(1)
  }

  const t0 = Date.now()
  const stats = await backfill(avatarsRoot, avatarId)
  const totalSec = Math.round((Date.now() - t0) / 1000)

  console.log('')
  console.log(`[backfill] 完成: ${stats.ok} 成功 / ${stats.skip} 跳过 / ${stats.fail} 失败 — 总耗时 ${totalSec}s`)
  if (stats.failed.length > 0) {
    console.log('')
    console.log('失败列表:')
    for (const f of stats.failed) {
      console.log(`  - ${path.basename(f.path)}: ${f.error}`)
    }
  }
  process.exitCode = stats.fail > 0 ? 1 : 0
}

void main().catch((err) => {
  console.error('[backfill-excel-json] FAIL')
  console.error(err)
  process.exit(1)
})
