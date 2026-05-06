/**
 * cleanup-pdf-toc-pages.ts — 一次性脚本：清理 PDF 转出 .md 文件中的目录页噪声
 *
 * PDF→md 转换后，目录页原样保留了大量形如"第N章 标题........页码"的无用行。
 * 本脚本识别并删除这些 TOC 行及相关的"目 录"标题行，同时折叠残留的连续空行。
 *
 * 用法：
 *   cd desktop-app
 *   npx tsx scripts/cleanup-pdf-toc-pages.ts            # dry-run（默认）
 *   npx tsx scripts/cleanup-pdf-toc-pages.ts --apply     # 落盘写入
 *
 * @author zhi.qu
 * @date 2026-05-02
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

/* ------------------------------------------------------------------ */
/*  配置                                                               */
/* ------------------------------------------------------------------ */

const SOUL_ROOT = path.resolve(__dirname, '../..')
const KNOWLEDGE_GLOB = 'avatars/*/knowledge/*.md'
const APPLY = process.argv.includes('--apply')

/* ------------------------------------------------------------------ */
/*  TOC 行匹配                                                        */
/* ------------------------------------------------------------------ */

/**
 * TOC 行：5+ 连续点号/省略号，后面只能是可选空白 + 可选页码数字。
 * 排除 key-value 行（如 "Report Number............: CN24DZ91 001"），
 * 因为那些行在点号之后有 `:` 分隔符。
 */
const RE_TOC_DOTS = /[.．。·…]{5,}[\s\d]*$/

/** "目 录" / "目录" 独占行（不区分全角空格） */
const RE_TOC_HEADING = /^目\s*录\s*$/

/** 连续 3+ 空行折叠为 2 空行 */
function collapseBlankLines(lines: string[]): string[] {
  const result: string[] = []
  let blankCount = 0
  for (const line of lines) {
    if (line.trim() === '') {
      blankCount++
      if (blankCount <= 2) result.push(line)
    } else {
      blankCount = 0
      result.push(line)
    }
  }
  return result
}

/* ------------------------------------------------------------------ */
/*  Frontmatter 解析（轻量内联，仅判断 source: pdf）                    */
/* ------------------------------------------------------------------ */

function isPdfSource(content: string): boolean {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return false
  const endIdx = content.indexOf('\n---', 4)
  if (endIdx === -1) return false
  const fm = content.slice(4, endIdx)
  return /^\s*source\s*:\s*pdf\s*$/m.test(fm)
}

function frontmatterEndLine(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return i
  }
  return 0
}

/* ------------------------------------------------------------------ */
/*  单文件处理                                                         */
/* ------------------------------------------------------------------ */

interface CleanResult {
  filePath: string
  removedLines: { lineNum: number; content: string }[]
  newContent: string
}

function cleanFile(filePath: string): CleanResult | null {
  const raw = fs.readFileSync(filePath, 'utf-8')
  if (!isPdfSource(raw)) return null

  const lines = raw.split('\n')
  const fmEnd = frontmatterEndLine(lines)

  const removedLines: { lineNum: number; content: string }[] = []
  const kept: string[] = lines.slice(0, fmEnd + 1)

  const bodyLines = lines.slice(fmEnd + 1)

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]
    const absLineNum = fmEnd + 1 + i + 1 // 1-based

    if (RE_TOC_DOTS.test(line)) {
      removedLines.push({ lineNum: absLineNum, content: line })
      continue
    }

    if (RE_TOC_HEADING.test(line.trim())) {
      const nearby = bodyLines.slice(Math.max(0, i - 3), Math.min(bodyLines.length, i + 6))
      const hasTocNeighbor = nearby.some(l => RE_TOC_DOTS.test(l))
      if (hasTocNeighbor) {
        removedLines.push({ lineNum: absLineNum, content: line })
        continue
      }
    }

    kept.push(line)
  }

  if (removedLines.length === 0) return null

  const collapsed = [
    ...kept.slice(0, fmEnd + 1),
    ...collapseBlankLines(kept.slice(fmEnd + 1)),
  ]

  return {
    filePath,
    removedLines,
    newContent: collapsed.join('\n'),
  }
}

/* ------------------------------------------------------------------ */
/*  主流程                                                             */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`🔍 模式: ${APPLY ? '--apply（落盘写入）' : '--dry-run（仅预览）'}`)
  console.log(`📁 扫描: ${KNOWLEDGE_GLOB}\n`)

  const knowledgeDirs = fs.readdirSync(path.join(SOUL_ROOT, 'avatars'), { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(SOUL_ROOT, 'avatars', d.name, 'knowledge'))
    .filter(p => fs.existsSync(p))

  let totalFiles = 0
  let affectedFiles = 0
  let totalRemoved = 0
  const results: CleanResult[] = []

  for (const knDir of knowledgeDirs) {
    const mdFiles = fs.readdirSync(knDir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(knDir, f))

    for (const mdPath of mdFiles) {
      totalFiles++
      const result = cleanFile(mdPath)
      if (result) {
        results.push(result)
        affectedFiles++
        totalRemoved += result.removedLines.length
      }
    }
  }

  if (results.length === 0) {
    console.log('✅ 没有发现需要清理的 PDF 目录页噪声')
    return
  }

  for (const r of results) {
    const relPath = path.relative(SOUL_ROOT, r.filePath)
    console.log(`\n📄 ${relPath} — 将删除 ${r.removedLines.length} 行:`)
    for (const rm of r.removedLines.slice(0, 10)) {
      const preview = rm.content.length > 100 ? rm.content.slice(0, 100) + '...' : rm.content
      console.log(`   L${rm.lineNum}: ${preview}`)
    }
    if (r.removedLines.length > 10) {
      console.log(`   ... 还有 ${r.removedLines.length - 10} 行`)
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log(`📊 统计: 扫描 ${totalFiles} 个 .md，${affectedFiles} 个含目录噪声，共 ${totalRemoved} 行待删除`)

  if (!APPLY) {
    console.log('\n💡 这是 dry-run 模式，不会修改任何文件。')
    console.log('   确认无误后运行: npx tsx scripts/cleanup-pdf-toc-pages.ts --apply')
    return
  }

  for (const r of results) {
    fs.writeFileSync(r.filePath, r.newContent, 'utf-8')
  }
  console.log(`\n✅ 已写入 ${affectedFiles} 个文件`)

  try {
    const diff = execSync('git diff --stat', { cwd: SOUL_ROOT, encoding: 'utf-8' })
    console.log('\n📋 git diff --stat:')
    console.log(diff)
  } catch {
    console.log('\n⚠️  无法执行 git diff（可能不在 git 仓库内）')
  }

  console.log('💡 请 review 改动后 git add + commit，或 git checkout -- 撤销')
}

main().catch(err => {
  console.error('脚本执行失败:', err)
  process.exit(1)
})
