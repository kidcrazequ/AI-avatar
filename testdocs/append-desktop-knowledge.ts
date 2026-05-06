/**
 * Append a source folder into the real desktop Xiaodu knowledge base.
 *
 * The pipeline follows desktop batch import behavior:
 *   walkFolder -> DocumentParser.parseFile -> clean text -> preserve _raw -> write md
 *
 * Difference from current desktop IPC: append mode never overwrites existing md files.
 *
 * Usage:
 *   npx --yes tsx testdocs/append-desktop-knowledge.ts
 *
 * @author zhi.qu
 * @date 2026-04-27
 */

import fs from 'fs'
import path from 'path'
import { DocumentParser } from '../desktop-app/electron/document-parser'
import { walkFolder } from '../desktop-app/electron/folder-importer'
import { cleanPdfFullText, stripDocxToc, WikiCompiler } from '../packages/core/src/index'
import { KnowledgeManager } from '../packages/core/src/knowledge-manager'

const AVATAR_ID = '小堵-工商储专家'
const SOURCE_ROOT = '/Users/cnlm007398/堵杰的文档/堵杰的文档'
const KNOWLEDGE_ROOT = '/Users/cnlm007398/Library/Application Support/soul-desktop/avatars/小堵-工商储专家/knowledge'
const REPORT_PATH = '/Users/cnlm007398/AI/soul/testdocs/append-desktop-knowledge-report.json'
const RAG_ONLY_THRESHOLD = 50_000

interface ImportResult {
  sourcePath: string
  targetPath?: string
  rawPath?: string
  status: 'imported' | 'failed'
  fileType?: string
  rawChars?: number
  cleanedChars?: number
  ms: number
  error?: string
}

function safeBaseName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'document'
}

function uniqueRelativePath(knowledgeRoot: string, baseName: string): string {
  let candidate = `${baseName}.md`
  let index = 2
  while (fs.existsSync(path.join(knowledgeRoot, candidate))) {
    candidate = `${baseName}_${index}.md`
    index += 1
  }
  return candidate
}

function cleanText(fileType: string, text: string): string {
  let cleaned = cleanPdfFullText(text || '')
  if (fileType === 'word') {
    cleaned = stripDocxToc(cleaned)
  }
  return cleaned
}

function buildFrontmatter(fileType: string, rawRelPath: string | null, body: string): string {
  const lines = ['---']
  if (body.length > RAG_ONLY_THRESHOLD) lines.push('rag_only: true')
  lines.push(`source: ${fileType}`)
  if (rawRelPath) lines.push(`raw_file: ${rawRelPath}`)
  lines.push('---', '')
  return lines.join('\n') + '\n'
}

function updateReadme(imported: Array<{ targetPath: string }>): void {
  if (imported.length === 0) return
  const readmePath = path.join(KNOWLEDGE_ROOT, 'README.md')
  let readme = ''
  try {
    readme = fs.readFileSync(readmePath, 'utf-8')
  } catch {
    readme = `# ${AVATAR_ID} 知识库

本目录存放 ${AVATAR_ID} 分身的领域知识文件。分身在工作时会基于这些文件内容进行回答。

## 知识文件索引

| 文件 | 路径 | 来源 |
| --- | --- | --- |
`
  }

  if (!readme.includes('| 文件 |') && !readme.includes('| --- |')) {
    readme += '\n## 知识文件索引\n\n| 文件 | 路径 | 来源 |\n| --- | --- | --- |\n'
  }

  const entries = imported
    .filter((item) => !readme.includes(item.targetPath))
    .map((item) => `| ${item.targetPath.replace(/\.md$/, '')} | [${item.targetPath}](${item.targetPath}) | 批量追加导入 |`)

  if (entries.length > 0) {
    fs.writeFileSync(readmePath, `${readme.trimEnd()}\n${entries.join('\n')}\n`, 'utf-8')
  }
}

async function importOne(parser: DocumentParser, kmgr: KnowledgeManager, filePath: string): Promise<ImportResult> {
  const startedAt = Date.now()
  const fileName = path.basename(filePath)
  const targetPath = uniqueRelativePath(KNOWLEDGE_ROOT, safeBaseName(fileName))

  try {
    const parsed = await parser.parseFile(filePath)
    let rawRelPath: string | null = null
    try {
      rawRelPath = await WikiCompiler.preserveRawFile(KNOWLEDGE_ROOT, filePath)
    } catch (error) {
      console.warn(`[append-desktop-knowledge] preserve raw failed: ${fileName}: ${error instanceof Error ? error.message : String(error)}`)
    }

    const cleaned = cleanText(parsed.fileType, parsed.text || '')
    const finalContent = buildFrontmatter(parsed.fileType, rawRelPath, cleaned) + cleaned
    kmgr.writeFile(targetPath, finalContent)

    return {
      sourcePath: filePath,
      targetPath,
      rawPath: rawRelPath ?? undefined,
      status: 'imported',
      fileType: parsed.fileType,
      rawChars: parsed.text?.length ?? 0,
      cleanedChars: cleaned.length,
      ms: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      sourcePath: filePath,
      status: 'failed',
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(SOURCE_ROOT)) throw new Error(`source root not found: ${SOURCE_ROOT}`)
  if (!fs.existsSync(KNOWLEDGE_ROOT)) throw new Error(`knowledge root not found: ${KNOWLEDGE_ROOT}`)

  const { files, skipped, tempDirs } = await walkFolder(SOURCE_ROOT)
  const parser = new DocumentParser()
  const kmgr = new KnowledgeManager(KNOWLEDGE_ROOT)
  const results: ImportResult[] = []

  try {
    for (let i = 0; i < files.length; i++) {
      const result = await importOne(parser, kmgr, files[i])
      results.push(result)
      const status = result.status === 'imported' ? `-> ${result.targetPath}` : `FAILED: ${result.error}`
      console.log(`[append-desktop-knowledge] ${i + 1}/${files.length} ${path.basename(files[i])} ${status}`)
    }
  } finally {
    for (const dir of tempDirs) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true })
      } catch (error) {
        console.warn(`[append-desktop-knowledge] cleanup temp failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const imported = results
    .filter((item): item is ImportResult & { targetPath: string } => item.status === 'imported' && Boolean(item.targetPath))
    .map((item) => ({ targetPath: item.targetPath }))
  updateReadme(imported)

  const report = {
    avatarId: AVATAR_ID,
    sourceRoot: SOURCE_ROOT,
    knowledgeRoot: KNOWLEDGE_ROOT,
    totalDiscovered: files.length,
    skipped,
    imported: results.filter((item) => item.status === 'imported').length,
    failed: results.filter((item) => item.status === 'failed').length,
    results,
  }

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8')
  console.log(JSON.stringify({
    totalDiscovered: report.totalDiscovered,
    imported: report.imported,
    failed: report.failed,
    skipped: skipped.length,
    reportPath: REPORT_PATH,
  }, null, 2))
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
