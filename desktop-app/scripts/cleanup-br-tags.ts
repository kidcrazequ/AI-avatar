/**
 * cleanup-br-tags.ts — 一次性脚本：清理知识库 .md 文件中表格行内的 <br> 标签
 *
 * Excel 单元格内的换行符在旧版 rowsToMarkdownTable 中被转为 <br>，导致
 * 表格行过长、Markdown 渲染异常。本脚本将表格行中的 <br> 替换为中文分号 `；`。
 *
 * 用法：
 *   cd desktop-app
 *   npx tsx scripts/cleanup-br-tags.ts            # dry-run（默认）
 *   npx tsx scripts/cleanup-br-tags.ts --apply     # 落盘写入
 *
 * @author zhi.qu
 * @date 2026-05-03
 */

import fs from 'fs'
import path from 'path'

/* ------------------------------------------------------------------ */
/*  配置                                                               */
/* ------------------------------------------------------------------ */

const SOUL_ROOT = path.resolve(__dirname, '../..')
const KNOWLEDGE_GLOB = 'avatars/*/knowledge/*.md'
const APPLY = process.argv.includes('--apply')

/* ------------------------------------------------------------------ */
/*  辅助函数                                                           */
/* ------------------------------------------------------------------ */

/** 收集 avatars 下各分身 knowledge 目录中的 .md 文件列表 */
function collectMdFiles(): string[] {
  const avatarsDir = path.join(SOUL_ROOT, 'avatars')
  const results: string[] = []
  if (!fs.existsSync(avatarsDir)) return results

  const avatarDirs = fs.readdirSync(avatarsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
  for (const dir of avatarDirs) {
    const knowledgeDir = path.join(avatarsDir, dir.name, 'knowledge')
    if (!fs.existsSync(knowledgeDir)) continue
    const files = fs.readdirSync(knowledgeDir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(knowledgeDir, f))
    results.push(...files)
  }
  return results
}

/** GFM 表格行特征：以 | 开头、以 | 结尾 */
function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|')
}

/** GFM 分隔行特征：| --- | --- | 等 */
function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim()
  return /^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|$/.test(trimmed)
}

/**
 * 替换单行表格行中的 <br> 标签为 `；`。
 * 对于带数字编号的内容（如 `1.xxx<br>2.yyy`），也统一替换为 `；`。
 */
function replaceBrInTableLine(line: string): string {
  return line.replace(/<br\s*\/?>/gi, '；')
}

/* ------------------------------------------------------------------ */
/*  主流程                                                             */
/* ------------------------------------------------------------------ */

interface FileResult {
  filePath: string
  linesChanged: number
}

function processFile(filePath: string): FileResult | null {
  const content = fs.readFileSync(filePath, 'utf-8')

  // 快速跳过：不含 <br 的文件无需处理
  if (!/<br\s*\/?>/i.test(content)) return null

  const lines = content.split('\n')
  let linesChanged = 0
  const newLines: string[] = []

  for (const line of lines) {
    if (isTableRow(line) && !isSeparatorRow(line) && /<br\s*\/?>/i.test(line)) {
      const replaced = replaceBrInTableLine(line)
      if (replaced !== line) {
        linesChanged++
      }
      newLines.push(replaced)
    } else {
      newLines.push(line)
    }
  }

  if (linesChanged === 0) return null

  if (APPLY) {
    fs.writeFileSync(filePath, newLines.join('\n'), 'utf-8')
  }

  return { filePath, linesChanged }
}

function main(): void {
  console.log(`[cleanup-br-tags] 模式: ${APPLY ? '🔧 APPLY（写入）' : '👀 DRY-RUN（只读）'}`)
  console.log()

  const files = collectMdFiles()
  if (files.length === 0) {
    console.log('[cleanup-br-tags] 未找到任何知识库 .md 文件')
    return
  }
  console.log(`[cleanup-br-tags] 扫描 ${files.length} 个 .md 文件...`)
  console.log()

  const results: FileResult[] = []
  for (const f of files) {
    const result = processFile(f)
    if (result) results.push(result)
  }

  if (results.length === 0) {
    console.log('[cleanup-br-tags] ✅ 无需处理，所有表格行均不含 <br> 标签')
    return
  }

  let totalLines = 0
  for (const r of results) {
    const rel = path.relative(SOUL_ROOT, r.filePath)
    console.log(`  ${APPLY ? '✅' : '📋'} ${rel}  (${r.linesChanged} 行)`)
    totalLines += r.linesChanged
  }
  console.log()
  console.log(`[cleanup-br-tags] 共 ${results.length} 个文件、${totalLines} 行受影响`)
  if (!APPLY) {
    console.log('[cleanup-br-tags] 使用 --apply 参数落盘写入')
  }
}

main()
