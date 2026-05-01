/**
 * backfill-excel-meta-role.ts — 给现有 _excel/*.json 补 rowMetaRoles 字段
 *
 * 背景：在 ExcelSheetData 增加 rowMetaRoles 字段后，存量 _excel/*.json
 * 缺少该字段。本脚本对每个 sheet 的每行调用 inferRowMetaRole 推断角色，
 * 并就地写回 JSON。
 *
 * 与 backfill-excel-json.ts 的区别：
 *   - 该脚本：从 _raw/ 重新解析 Excel 文件
 *   - 本脚本：仅读现有 _excel/*.json，按 row 数据原地补字段（不需要原 xlsx）
 *
 * 用法：
 *   cd desktop-app
 *   npx tsx scripts/backfill-excel-meta-role.ts                 # 所有分身
 *   npx tsx scripts/backfill-excel-meta-role.ts <avatar-id>     # 指定分身
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import fs from 'fs'
import path from 'path'
import { inferRowMetaRole } from '../electron/document-parser'
import type { ExcelStructuredData, ExcelSheetData, ExcelRowMetaRole } from '../electron/document-parser'

interface BackfillStats {
  fileOk: number
  fileFail: number
  fileSkip: number
  sheetsUpdated: number
  rolesByType: Record<ExcelRowMetaRole, number>
}

function backfillSheetRoles(sheet: ExcelSheetData): boolean {
  if (!sheet.rows || sheet.rows.length === 0) {
    if (!sheet.rowMetaRoles) sheet.rowMetaRoles = []
    return false
  }
  const roles: ExcelRowMetaRole[] = sheet.rows.map(r => inferRowMetaRole(r, sheet.columns))
  sheet.rowMetaRoles = roles
  return true
}

function backfillExcelJsonFile(jsonPath: string, stats: BackfillStats): boolean {
  let raw: string
  try {
    raw = fs.readFileSync(jsonPath, 'utf-8')
  } catch (e) {
    console.error(`[backfill] 读取失败 ${jsonPath}: ${(e as Error).message}`)
    return false
  }

  let data: ExcelStructuredData
  try {
    data = JSON.parse(raw) as ExcelStructuredData
  } catch (e) {
    console.error(`[backfill] JSON 解析失败 ${jsonPath}: ${(e as Error).message}`)
    return false
  }

  if (!Array.isArray(data.sheets)) {
    console.warn(`[backfill] 跳过（无 sheets 字段）: ${jsonPath}`)
    return false
  }

  let anyUpdated = false
  for (const sheet of data.sheets) {
    const updated = backfillSheetRoles(sheet)
    if (updated) {
      anyUpdated = true
      stats.sheetsUpdated++
      for (const r of sheet.rowMetaRoles ?? []) {
        stats.rolesByType[r] = (stats.rolesByType[r] || 0) + 1
      }
    }
  }

  if (anyUpdated) {
    try {
      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (e) {
      console.error(`[backfill] 写入失败 ${jsonPath}: ${(e as Error).message}`)
      return false
    }
  }
  return true
}

function findExcelJsonFiles(rootDir: string): string[] {
  const files: string[] = []
  function walk(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(full)
      } else if (ent.isFile() && ent.name.endsWith('.json')) {
        // 仅处理位于 knowledge/_excel/ 下的 json
        if (full.includes(path.sep + '_excel' + path.sep)) {
          files.push(full)
        }
      }
    }
  }
  walk(rootDir)
  return files
}

function main(): void {
  const arg = process.argv[2]
  // 工作区根：脚本位于 desktop-app/scripts/，因此 ../../ 是 soul 根
  const repoRoot = path.resolve(__dirname, '..', '..')
  const avatarsRoot = path.join(repoRoot, 'avatars')

  let scanRoots: string[] = []
  if (arg) {
    const single = path.join(avatarsRoot, arg)
    if (!fs.existsSync(single)) {
      console.error(`分身目录不存在: ${single}`)
      process.exit(1)
    }
    scanRoots = [single]
  } else {
    if (!fs.existsSync(avatarsRoot)) {
      console.error(`avatars 目录不存在: ${avatarsRoot}`)
      process.exit(1)
    }
    scanRoots = fs.readdirSync(avatarsRoot)
      .map(n => path.join(avatarsRoot, n))
      .filter(p => fs.statSync(p).isDirectory())
  }

  const stats: BackfillStats = {
    fileOk: 0,
    fileFail: 0,
    fileSkip: 0,
    sheetsUpdated: 0,
    rolesByType: { data: 0, subtitle: 0, subtotal: 0, total: 0 },
  }

  for (const avatarRoot of scanRoots) {
    const avatarName = path.basename(avatarRoot)
    const excelJsonFiles = findExcelJsonFiles(avatarRoot)
    if (excelJsonFiles.length === 0) {
      console.log(`[${avatarName}] 无 _excel/*.json 文件，跳过`)
      continue
    }
    console.log(`[${avatarName}] 扫到 ${excelJsonFiles.length} 个 _excel json`)
    for (const f of excelJsonFiles) {
      const ok = backfillExcelJsonFile(f, stats)
      if (ok) stats.fileOk++
      else stats.fileFail++
    }
  }

  console.log('\n=== Backfill 完成 ===')
  console.log(`成功文件:   ${stats.fileOk}`)
  console.log(`失败文件:   ${stats.fileFail}`)
  console.log(`更新 sheets: ${stats.sheetsUpdated}`)
  console.log('行角色分布:')
  for (const [k, v] of Object.entries(stats.rolesByType)) {
    console.log(`  ${k.padEnd(10)} ${v}`)
  }
}

main()
