/**
 * Simulate desktop-app format pipeline for a whole source folder.
 *
 * This script intentionally reuses the desktop formatter pipeline:
 *   DocumentParser.parseFile -> PDF/DOCX cleaners -> formatDocument -> Markdown output
 *
 * It replaces only the external LLM call with a deterministic local formatter so
 * the simulation can run without API keys.
 *
 * Usage:
 *   cd desktop-app
 *   npx --yes tsx ../testdocs/simulate-desktop-format.ts "/source/folder" "/output/knowledge"
 *
 * @author zhi.qu
 * @date 2026-04-27
 */

import fs from 'fs'
import path from 'path'
import { DocumentParser, SUPPORTED_PARSE_EXTENSIONS, isGarbledText } from '../desktop-app/electron/document-parser'
import {
  cleanPdfFullText,
  stripDocxToc,
  formatDocument,
  type LLMCallFn,
} from '../packages/core/src/index'

const DEFAULT_SOURCE_ROOT = '/Users/cnlm007398/堵杰的文档/堵杰的文档'
const DEFAULT_OUTPUT_ROOT = '/Users/cnlm007398/AI/soul/testdocs/sim-desktop-format-knowledge'

type SourceFile = {
  full: string
  rel: string
  ext: string
  size: number
}

type FormatResult = {
  source: string
  output: string
  status: 'formatted' | 'metadata-card' | 'parse-failed'
  parser?: string
  rawChars?: number
  cleanedChars?: number
  images?: number
  reason?: string
  ms: number
}

const supportedExts = new Set<string>(SUPPORTED_PARSE_EXTENSIONS)

function walk(root: string): SourceFile[] {
  const out: SourceFile[] = []
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (!entry.isFile()) continue
      const stat = fs.statSync(full)
      out.push({
        full,
        rel: path.relative(root, full),
        ext: path.extname(full).toLowerCase() || '(none)',
        size: stat.size,
      })
    }
  }
  visit(root)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'document'
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function frontmatter(file: SourceFile, extra: Record<string, string | number | boolean>): string {
  const lines = [
    '---',
    'rag_only: false',
    `source_path: ${yamlString(file.rel.replace(/\\/g, '/'))}`,
    `source_ext: ${yamlString(file.ext)}`,
    `file_size_bytes: ${file.size}`,
  ]
  for (const [key, value] of Object.entries(extra)) {
    lines.push(`${key}: ${typeof value === 'string' ? yamlString(value) : value}`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

function metadataCard(file: SourceFile, reason: string): string {
  const title = path.basename(file.rel)
  const parts = file.rel.split(path.sep)
  return [
    frontmatter(file, {
      source: 'metadata-card',
      format_status: 'metadata-card',
      reason,
    }),
    `# ${title}`,
    '',
    '## 摘要',
    '',
    `该文件无法按桌面端文本解析器直接转换正文，已生成可检索元数据卡。`,
    '',
    '## 文件信息',
    '',
    `- 来源路径：\`${file.rel}\``,
    `- 文件类型：\`${file.ext}\``,
    `- 文件大小：${file.size} 字节`,
    `- 所属目录：${parts.slice(0, Math.max(1, parts.length - 1)).join(' / ')}`,
    '',
    '## 检索关键词',
    '',
    `- ${path.basename(file.rel)}`,
    `- ${parts.slice(-4).join(' / ')}`,
    `- ${file.ext}`,
    '',
  ].join('\n')
}

function localFormat(raw: string, title: string): string {
  const text = raw.trim()
  if (!text) return `## ${title}\n\n_（无可提取文本）_`

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const tableLike = lines.length >= 20 && lines.filter((line) => line.length <= 20).length / lines.length > 0.45
  if (tableLike) {
    return [
      `## ${title}`,
      '',
      '```',
      text,
      '```',
      '',
    ].join('\n')
  }

  const chunks: string[] = []
  let buffer: string[] = []
  for (const line of lines) {
    if (/^(第[一二三四五六七八九十百\d]+[章节条]|[一二三四五六七八九十]+、|\d{1,2}(?:\.\d{1,2})*)/.test(line) && buffer.length > 0) {
      chunks.push(buffer.join('\n'))
      buffer = [line]
    } else {
      buffer.push(line)
    }
  }
  if (buffer.length > 0) chunks.push(buffer.join('\n'))

  return chunks.map((chunk, index) => {
    const chunkLines = chunk.split('\n')
    const heading = chunkLines[0].slice(0, 80) || `${title} ${index + 1}`
    const body = chunkLines.slice(1).join('\n').trim()
    return [`## ${heading}`, '', body || chunk].join('\n')
  }).join('\n\n---\n\n')
}

const localLLM: LLMCallFn = async (_systemPrompt, userPrompt) => {
  const marker = '\n---\n\n'
  const idx = userPrompt.indexOf(marker)
  const raw = idx >= 0 ? userPrompt.slice(idx + marker.length) : userPrompt
  const titleMatch = userPrompt.match(/章节标题：(.+)/)
  return localFormat(raw, titleMatch?.[1] ?? '章节')
}

function cleanParsedText(ext: string, text: string): string {
  if (ext === '.pdf') return cleanPdfFullText(text)
  if (ext === '.docx' || ext === '.doc') return stripDocxToc(cleanPdfFullText(text))
  return text
}

async function formatOne(parser: DocumentParser, sourceRoot: string, outputRoot: string, file: SourceFile, index: number): Promise<FormatResult> {
  const startedAt = Date.now()
  const outputName = `${String(index + 1).padStart(4, '0')}-${slug(path.basename(file.rel))}.md`
  const outputPath = path.join(outputRoot, outputName)

  if (!supportedExts.has(file.ext)) {
    fs.writeFileSync(outputPath, metadataCard(file, `unsupported_ext:${file.ext}`), 'utf-8')
    return {
      source: file.rel,
      output: path.relative(outputRoot, outputPath),
      status: 'metadata-card',
      reason: `unsupported_ext:${file.ext}`,
      ms: Date.now() - startedAt,
    }
  }

  try {
    const parsed = await parser.parseFile(file.full)
    const cleaned = cleanParsedText(file.ext, parsed.text || '')
    const title = path.basename(file.rel)
    const shouldUseMetadataCard = cleaned.trim().length < 100 && (!parsed.images || parsed.images.length === 0)
    const body = shouldUseMetadataCard
      ? metadataCard(file, 'text_too_short')
      : frontmatter(file, {
          source: parsed.fileType,
          format_status: 'formatted',
          parser: parsed.fileType,
          raw_chars: parsed.text?.length ?? 0,
          cleaned_chars: cleaned.length,
          images: parsed.images?.length ?? 0,
          garbled: isGarbledText(cleaned),
        }) + await formatDocument(cleaned, title, file.rel, localLLM)

    fs.writeFileSync(outputPath, body, 'utf-8')
    return {
      source: file.rel,
      output: path.relative(outputRoot, outputPath),
      status: shouldUseMetadataCard ? 'metadata-card' : 'formatted',
      parser: parsed.fileType,
      rawChars: parsed.text?.length ?? 0,
      cleanedChars: cleaned.length,
      images: parsed.images?.length ?? 0,
      reason: shouldUseMetadataCard ? 'text_too_short' : undefined,
      ms: Date.now() - startedAt,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    fs.writeFileSync(outputPath, metadataCard(file, `parse_failed:${reason}`), 'utf-8')
    return {
      source: file.rel,
      output: path.relative(outputRoot, outputPath),
      status: 'parse-failed',
      reason,
      ms: Date.now() - startedAt,
    }
  }
}

async function main(): Promise<void> {
  const sourceRoot = process.argv[2] || DEFAULT_SOURCE_ROOT
  const outputRoot = process.argv[3] || DEFAULT_OUTPUT_ROOT

  if (!fs.existsSync(sourceRoot)) throw new Error(`source root not found: ${sourceRoot}`)
  if (fs.existsSync(outputRoot)) fs.rmSync(outputRoot, { recursive: true, force: true })
  fs.mkdirSync(outputRoot, { recursive: true })

  const files = walk(sourceRoot)
  const parser = new DocumentParser()
  const results: FormatResult[] = []

  for (let i = 0; i < files.length; i++) {
    const result = await formatOne(parser, sourceRoot, outputRoot, files[i], i)
    results.push(result)
    if ((i + 1) % 25 === 0 || i + 1 === files.length) {
      console.log(`[simulate-desktop-format] ${i + 1}/${files.length}`)
    }
  }

  const report = {
    sourceRoot,
    outputRoot,
    total: files.length,
    formatted: results.filter((r) => r.status === 'formatted').length,
    metadataCards: results.filter((r) => r.status === 'metadata-card').length,
    parseFailed: results.filter((r) => r.status === 'parse-failed').length,
    results,
  }
  const reportPath = `${outputRoot.replace(/[\/\\]$/, '')}-report.json`
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8')
  console.log(JSON.stringify({
    sourceRoot,
    outputRoot,
    reportPath,
    total: report.total,
    formatted: report.formatted,
    metadataCards: report.metadataCards,
    parseFailed: report.parseFailed,
  }, null, 2))
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
