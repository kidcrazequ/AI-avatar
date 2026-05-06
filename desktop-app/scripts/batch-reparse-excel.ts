/**
 * batch-reparse-excel.ts — 批量重新解析 Excel 来源的知识库 .md 文件
 *
 * 背景：document-parser.ts 改进了 prepareTable（智能表头检测）和 ffillLeadingColumns
 * （合并单元格前向填充），加上 @soul/core 新增的 frontmatter 增强工具。
 * 此脚本将所有 source:excel 的旧 .md 文件从原始 xlsx 重新解析，替换为新逻辑产出的内容。
 *
 * 用法：
 *   cd desktop-app
 *   npx tsx scripts/batch-reparse-excel.ts [--apply]
 *
 * 默认 dry-run 模式（只统计不写文件）。加 --apply 真正写入。
 *
 * @author zhi.qu
 * @date 2026-05-03
 */

import fs from 'fs'
import path from 'path'
import { DocumentParser } from '../electron/document-parser'
import {
  parseFrontmatterCore,
  extractFrontmatterFields,
  mergeFrontmatter,
  buildFrontmatterBlock,
} from '@soul/core'

// ─── 配置 ─────────────────────────────────────────────────────────────────────

const AVATAR_ID = '小堵-工商储专家'
const KNOWLEDGE_DIR = path.resolve(__dirname, `../../avatars/${AVATAR_ID}/knowledge`)
const RAW_DIR = path.join(KNOWLEDGE_DIR, '_raw')

// ─── 统计 ─────────────────────────────────────────────────────────────────────

interface Stats {
  total: number
  processed: number
  headerUpgraded: number
  ffillApplied: number
  frontmatterEnhanced: number
  skipped: Array<{ file: string; reason: string }>
  errors: Array<{ file: string; error: string }>
}

// ─── 辅助 ─────────────────────────────────────────────────────────────────────

/**
 * 当 frontmatter 缺少 raw_file 时，尝试按 .md 文件名在 _raw/ 中模糊匹配 xlsx。
 * basename 规则与 batchImportFiles 一致：特殊字符替换为 _ 。
 */
function findRawByMdName(mdFileName: string, rawDir: string): string | null {
  const mdBase = mdFileName.replace(/\.md$/, '')
  let entries: string[]
  try {
    entries = fs.readdirSync(rawDir)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!/\.(xlsx|xls)$/i.test(entry)) continue
    const normalized = entry
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
    if (normalized === mdBase) {
      return path.join(rawDir, entry)
    }
  }
  return null
}

/** 检测旧 .md 是否使用了 col1/col2 占位表头 */
function hasPlaceholderHeaders(body: string): boolean {
  return /\|\s*col\d+\s*\|/.test(body)
}

/** 检测新生成的 body 中前向填充是否生效（对比旧 body 的空 cell 比例） */
function detectFfillApplied(oldBody: string, newBody: string): boolean {
  const countEmptyCells = (text: string): number => {
    const matches = text.match(/\| {0,2}\|/g)
    return matches ? matches.length : 0
  }
  const oldEmpty = countEmptyCells(oldBody)
  const newEmpty = countEmptyCells(newBody)
  return oldEmpty > 0 && newEmpty < oldEmpty
}

/** 检测 frontmatter 是否被增强（新字段数 > 旧字段数） */
function detectFrontmatterEnhanced(
  oldMeta: Record<string, unknown>,
  newMeta: Record<string, unknown>,
): boolean {
  const newKeys = Object.keys(newMeta).filter(k => !(k in oldMeta))
  return newKeys.length > 0
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const applyMode = process.argv.includes('--apply')
  console.log(`\n🔧 batch-reparse-excel — ${applyMode ? '⚡ APPLY 模式' : '👀 DRY-RUN 模式'}\n`)

  const stats: Stats = {
    total: 0,
    processed: 0,
    headerUpgraded: 0,
    ffillApplied: 0,
    frontmatterEnhanced: 0,
    skipped: [],
    errors: [],
  }

  // 1. 扫描 knowledge/*.md，筛选 source: excel
  const mdFiles = fs.readdirSync(KNOWLEDGE_DIR)
    .filter(f => f.endsWith('.md') && f !== 'README.md')

  const parser = new DocumentParser()

  for (const mdFile of mdFiles) {
    const mdPath = path.join(KNOWLEDGE_DIR, mdFile)
    let content: string
    try {
      content = fs.readFileSync(mdPath, 'utf-8')
    } catch (err) {
      stats.errors.push({ file: mdFile, error: `读取失败: ${err instanceof Error ? err.message : String(err)}` })
      continue
    }

    const { meta: oldMeta, body: oldBody } = parseFrontmatterCore(content)

    if (oldMeta.source !== 'excel') continue
    stats.total++

    // 2. 找到对应的 _raw xlsx（优先 raw_file 字段，fallback 按文件名匹配）
    let rawPath: string | null = null
    const rawFileField = oldMeta.raw_file
    if (rawFileField && typeof rawFileField === 'string') {
      const candidate = path.resolve(KNOWLEDGE_DIR, rawFileField)
      if (fs.existsSync(candidate)) rawPath = candidate
    }
    if (!rawPath) {
      rawPath = findRawByMdName(mdFile, RAW_DIR)
    }
    if (!rawPath) {
      stats.skipped.push({ file: mdFile, reason: `找不到原始 xlsx（raw_file=${String(rawFileField ?? '无')}）` })
      continue
    }

    // 3. 用 DocumentParser 重新解析 xlsx
    let parsed: Awaited<ReturnType<DocumentParser['parseFile']>>
    try {
      parsed = await parser.parseFile(rawPath)
    } catch (err) {
      stats.errors.push({ file: mdFile, error: `解析失败: ${err instanceof Error ? err.message : String(err)}` })
      continue
    }

    const newBody = parsed.text

    // 4. 统计改进指标
    const hadPlaceholders = hasPlaceholderHeaders(oldBody)
    const hasRealHeaders = !hasPlaceholderHeaders(newBody)
    if (hadPlaceholders && hasRealHeaders) stats.headerUpgraded++

    if (detectFfillApplied(oldBody, newBody)) stats.ffillApplied++

    // 5. frontmatter 增强（补全缺失的 raw_file 字段）
    const extractedFields = extractFrontmatterFields(mdFile, newBody)
    if (!oldMeta.raw_file) {
      extractedFields.raw_file = '_raw/' + path.basename(rawPath)
    }
    const newMeta = mergeFrontmatter(oldMeta, extractedFields)

    if (detectFrontmatterEnhanced(oldMeta, newMeta)) stats.frontmatterEnhanced++

    // 6. 组装新 .md 内容
    const frontmatterBlock = buildFrontmatterBlock(newMeta)
    const newContent = frontmatterBlock + '\n\n' + newBody + '\n'

    // 7. 写入（或 dry-run 报告）
    if (applyMode) {
      try {
        fs.writeFileSync(mdPath, newContent, 'utf-8')
      } catch (err) {
        stats.errors.push({ file: mdFile, error: `写入失败: ${err instanceof Error ? err.message : String(err)}` })
        continue
      }
    }

    stats.processed++
    if (hadPlaceholders && hasRealHeaders) {
      console.log(`  ✅ ${mdFile} — 表头升级`)
    } else {
      console.log(`  ✅ ${mdFile}`)
    }
  }

  // ─── 汇总报告 ─────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60))
  console.log(`📊 处理报告`)
  console.log('='.repeat(60))
  console.log(`  Excel 源 .md 总数      : ${stats.total}`)
  console.log(`  成功处理               : ${stats.processed}`)
  console.log(`  表头 col→真实 升级     : ${stats.headerUpgraded}`)
  console.log(`  ffill 前向填充生效     : ${stats.ffillApplied}`)
  console.log(`  frontmatter 增强       : ${stats.frontmatterEnhanced}`)

  if (stats.skipped.length > 0) {
    console.log(`\n⏭  跳过 (${stats.skipped.length}):`)
    for (const s of stats.skipped) {
      console.log(`    ${s.file} — ${s.reason}`)
    }
  }

  if (stats.errors.length > 0) {
    console.log(`\n❌ 错误 (${stats.errors.length}):`)
    for (const e of stats.errors) {
      console.log(`    ${e.file} — ${e.error}`)
    }
  }

  if (!applyMode) {
    console.log('\n💡 以上为 dry-run 预览。加 --apply 参数执行实际写入。')
  }

  console.log()

  if (stats.errors.length > 0) {
    process.exit(1)
  }
}

main().catch(err => {
  console.error('脚本执行失败:', err)
  process.exit(1)
})
