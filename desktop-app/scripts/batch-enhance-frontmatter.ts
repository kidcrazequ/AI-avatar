/**
 * batch-enhance-frontmatter.ts — 批量增强非 Excel 来源知识库 .md 文件的 frontmatter
 *
 * 扫描 knowledge/*.md，对 source 为 pdf / pptx / ppt 的文件补充
 * title / model / version / category / keywords / summary 等增强字段。
 *
 * 用法：
 *   cd desktop-app
 *   npx tsx scripts/batch-enhance-frontmatter.ts <avatar-id>             # dry-run（默认）
 *   npx tsx scripts/batch-enhance-frontmatter.ts <avatar-id> --apply     # 实际写入
 *
 * 例：
 *   npx tsx scripts/batch-enhance-frontmatter.ts 小堵-工商储专家
 *   npx tsx scripts/batch-enhance-frontmatter.ts 小堵-工商储专家 --apply
 *
 * @author zhi.qu
 * @date 2026-05-03
 */

import fs from 'fs'
import path from 'path'
import {
  parseFrontmatterCore,
  extractFrontmatterFields,
  mergeFrontmatter,
  buildFrontmatterBlock,
} from '../../packages/core/src/utils/knowledge-frontmatter'

const ELIGIBLE_SOURCES = new Set(['pdf', 'pptx', 'ppt'])

const ENHANCE_FIELDS = ['title', 'model', 'version', 'category', 'keywords', 'summary'] as const

interface FileResult {
  file: string
  action: 'enhanced' | 'skipped'
  reason?: string
  addedFields?: string[]
}

interface Stats {
  scanned: number
  enhanced: number
  skipped: number
  fieldHits: Record<string, number>
  results: FileResult[]
}

function collectKnowledgeMdFiles(knowledgeDir: string): string[] {
  const entries = fs.readdirSync(knowledgeDir, { withFileTypes: true })
  const mdFiles: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.md')) continue
    if (entry.name === 'README.md') continue
    mdFiles.push(path.join(knowledgeDir, entry.name))
  }
  return mdFiles.sort()
}

function run(): void {
  const avatarId = process.argv[2]
  if (!avatarId) {
    console.error('用法: npx tsx scripts/batch-enhance-frontmatter.ts <avatar-id> [--apply]')
    process.exit(1)
  }

  const applyMode = process.argv.includes('--apply')
  const mode = applyMode ? 'APPLY' : 'DRY-RUN'

  // 兼容两种来源：dev 工作区 avatars/<id> 与可分发专家包 expert-packs/<id>
  // 优先级：avatars/ 优先（用户安装后的最新数据），fallback 到 expert-packs/（出厂模板）
  const candidateRoots = [
    path.resolve(__dirname, '../../avatars', avatarId),
    path.resolve(__dirname, '../../expert-packs', avatarId),
  ]
  const avatarRoot = candidateRoots.find(p => fs.existsSync(path.join(p, 'knowledge'))) ?? candidateRoots[0]
  const knowledgeDir = path.join(avatarRoot, 'knowledge')

  if (!fs.existsSync(knowledgeDir)) {
    console.error(`知识库目录不存在: ${knowledgeDir}`)
    console.error('已尝试的候选根目录:')
    for (const p of candidateRoots) console.error(`  - ${p}`)
    process.exit(1)
  }

  console.log(`\n=== 批量增强 frontmatter [${mode}] ===`)
  console.log(`知识库: ${knowledgeDir}\n`)

  const mdFiles = collectKnowledgeMdFiles(knowledgeDir)
  const stats: Stats = {
    scanned: 0,
    enhanced: 0,
    skipped: 0,
    fieldHits: Object.fromEntries(ENHANCE_FIELDS.map(f => [f, 0])),
    results: [],
  }

  for (const filePath of mdFiles) {
    const fileName = path.basename(filePath)
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      stats.results.push({ file: fileName, action: 'skipped', reason: `读取失败: ${msg}` })
      stats.skipped++
      continue
    }

    const { meta, body } = parseFrontmatterCore(content)
    const source = String(meta.source ?? '')

    if (!ELIGIBLE_SOURCES.has(source)) {
      stats.results.push({ file: fileName, action: 'skipped', reason: `source="${source}"，非目标类型` })
      stats.skipped++
      continue
    }

    stats.scanned++

    const enhanced = extractFrontmatterFields(fileName, body)
    const newFieldKeys = Object.keys(enhanced).filter(k => !(k in meta))

    if (newFieldKeys.length === 0) {
      stats.results.push({ file: fileName, action: 'skipped', reason: '无新增字段' })
      stats.skipped++
      continue
    }

    const merged = mergeFrontmatter(meta, enhanced)
    const newContent = buildFrontmatterBlock(merged) + '\n' + body

    if (applyMode) {
      try {
        fs.writeFileSync(filePath, newContent, 'utf-8')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  ✗ 写入失败 ${fileName}: ${msg}`)
        stats.results.push({ file: fileName, action: 'skipped', reason: `写入失败: ${msg}` })
        stats.skipped++
        continue
      }
    }

    for (const field of ENHANCE_FIELDS) {
      if (field in enhanced) {
        stats.fieldHits[field]++
      }
    }

    stats.enhanced++
    stats.results.push({ file: fileName, action: 'enhanced', addedFields: newFieldKeys })

    const tag = applyMode ? '✔' : '◎'
    console.log(`  ${tag} ${fileName}`)
    console.log(`     新增字段: ${newFieldKeys.join(', ')}`)
  }

  console.log('\n=== 汇总 ===')
  console.log(`扫描非 Excel 源 .md 文件: ${stats.scanned}`)
  console.log(`增强 frontmatter 文件数: ${stats.enhanced}`)
  console.log(`跳过文件数: ${stats.skipped}`)

  console.log('\n字段覆盖率:')
  for (const field of ENHANCE_FIELDS) {
    const count = stats.fieldHits[field]
    const pct = stats.scanned > 0 ? ((count / stats.scanned) * 100).toFixed(1) : '0.0'
    console.log(`  ${field}: ${count}/${stats.scanned} (${pct}%)`)
  }

  const skippedResults = stats.results.filter(r => r.action === 'skipped' && r.reason)
  if (skippedResults.length > 0) {
    console.log('\n跳过文件明细:')
    for (const r of skippedResults) {
      console.log(`  - ${r.file}: ${r.reason}`)
    }
  }

  if (!applyMode && stats.enhanced > 0) {
    console.log(`\n💡 以上为预览，执行 --apply 写入文件:`)
    console.log(`   npx tsx scripts/batch-enhance-frontmatter.ts ${avatarId} --apply`)
  }

  console.log('')
}

run()
