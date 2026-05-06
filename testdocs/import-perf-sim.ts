/**
 * Import-performance simulation benchmark.
 *
 * Usage:
 *   cd packages/core
 *   npm run test:import-perf-sim -- "/path/to/source-root"
 *
 * @author zhi.qu
 * @date 2026-04-24
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { KnowledgeRetriever } from '../packages/core/src/knowledge-retriever'
import { saveTokensCache, loadTokensCache } from '../packages/core/src/utils/chunk-cache'

const DEFAULT_SOURCE_ROOT = '/Users/cnlm007398/堵杰的文档/堵杰的文档'
const DEFAULT_REPORT_PATH = '/Users/cnlm007398/AI/soul/testdocs/import-performance-validation-report.md'

type FileEntry = {
  full: string
  rel: string
  ext: string
  size: number
}

type PassMetrics = {
  label: string
  totalMs: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  minMs: number
}

type ScenarioResult = {
  scenario: string
  sourceFileCount: number
  questionCount: number
  metrics: {
    cold: PassMetrics
    warm: PassMetrics
    cached: PassMetrics
  }
}

function walk(dir: string, sourceRoot: string, out: FileEntry[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, sourceRoot, out)
      continue
    }
    if (!entry.isFile()) continue
    const stat = fs.statSync(full)
    out.push({
      full,
      rel: path.relative(sourceRoot, full),
      ext: path.extname(full).toLowerCase() || '(none)',
      size: stat.size,
    })
  }
}

function normalizeText(input: string): string {
  return input
    .replace(/\.[^.]+$/, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function pickSpread<T>(arr: T[], count: number): T[] {
  if (arr.length <= count) return [...arr]
  const out: T[] = []
  const step = Math.max(1, Math.floor(arr.length / count))
  for (let i = 0; i < arr.length && out.length < count; i += step) {
    out.push(arr[i])
  }
  return out
}

function makeQuestion(file: FileEntry): string {
  const noExt = normalizeText(path.basename(file.rel))
  const seg = file.rel.split(path.sep)
  const hint = normalizeText(seg.slice(Math.max(0, seg.length - 3)).join(' '))
  return `请检索与“${noExt}”相关的信息，并说明它属于哪个业务目录（提示：${hint}）。`
}

function buildKnowledgeSim(files: FileEntry[]): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sim-v2-'))
  files.forEach((file, idx) => {
    const keywords = normalizeText(file.rel.replace(/[\\/]/g, ' '))
    const sizeMb = (file.size / 1024 / 1024).toFixed(2)
    const content = [
      '# Imported Knowledge Stub',
      '',
      `source_path: ${file.rel}`,
      `file_type: ${file.ext}`,
      `file_size_mb: ${sizeMb}`,
      '',
      '## Keywords',
      `${keywords}`,
      '',
      '## Summary',
      `该文档来源于 ${file.rel}，用于产品、流程、图纸和交付检索。`,
      '',
      `doc_id: SIM-${idx + 1}`,
      '',
    ].join('\n')
    fs.writeFileSync(path.join(tmpRoot, `doc-${String(idx + 1).padStart(4, '0')}.md`), content, 'utf-8')
  })
  return tmpRoot
}

function runPass(retriever: KnowledgeRetriever, questions: string[], label: string): PassMetrics {
  const costs: number[] = []
  const start = Date.now()
  for (const q of questions) {
    const qStart = Date.now()
    const hits = retriever.searchChunks(q, 6)
    const sink = hits.map((h) => h.heading).join(' ')
    void sink
    costs.push(Date.now() - qStart)
  }
  const sorted = [...costs].sort((a, b) => a - b)
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  return {
    label,
    totalMs: Date.now() - start,
    avgMs: Number((costs.reduce((s, x) => s + x, 0) / costs.length).toFixed(2)),
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[p95Index],
    maxMs: sorted[sorted.length - 1],
    minMs: sorted[0],
  }
}

function runScenario(name: string, sourceFiles: FileEntry[]): ScenarioResult {
  const simRoot = buildKnowledgeSim(sourceFiles)
  const questions = pickSpread(sourceFiles, 20).map(makeQuestion)

  const r1 = new KnowledgeRetriever(simRoot)
  const cold = runPass(r1, questions, `${name}:cold`)
  const warm = runPass(r1, questions, `${name}:warm`)

  const idxDir = path.join(simRoot, '_index')
  saveTokensCache(idxDir, r1.getTokens())
  const tokens = loadTokensCache(idxDir) ?? new Map<string, string[]>()
  const r2 = new KnowledgeRetriever(simRoot)
  r2.setTokens(tokens)
  const cached = runPass(r2, questions, `${name}:cached-cold`)

  fs.rmSync(simRoot, { recursive: true, force: true })

  return {
    scenario: name,
    sourceFileCount: sourceFiles.length,
    questionCount: questions.length,
    metrics: { cold, warm, cached },
  }
}

function judgeScenario(s: ScenarioResult): string {
  const coldAvgWarnMs = 300
  const warmAvgWarnMs = 60
  const coldP95WarnMs = 800
  const c = s.metrics.cold
  const w = s.metrics.warm
  if (c.avgMs > coldAvgWarnMs || c.p95Ms > coldP95WarnMs || w.avgMs > warmAvgWarnMs) {
    return '⚠ 风险偏高'
  }
  return '✅ 可接受'
}

function buildMarkdownReport(
  sourceRoot: string,
  files: FileEntry[],
  scenarios: ScenarioResult[],
): string {
  const byExt: Record<string, number> = {}
  let totalBytes = 0
  for (const f of files) {
    byExt[f.ext] = (byExt[f.ext] ?? 0) + 1
    totalBytes += f.size
  }
  const textLikeExt = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.csv'])
  const textLikeCount = files.filter((f) => textLikeExt.has(f.ext)).length

  const lines: string[] = []
  lines.push('# 导入后检索性能验收报告（模拟）')
  lines.push('')
  lines.push(`- 数据目录: \`${sourceRoot}\``)
  lines.push(`- 文件总数: **${files.length}**`)
  lines.push(`- 总体积: **${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB**`)
  lines.push(`- 文本型文件数（PDF/Office）: **${textLikeCount}**`)
  lines.push('')
  lines.push('## 扩展名分布 Top 12')
  lines.push('')
  lines.push('| 扩展名 | 数量 |')
  lines.push('|---|---:|')
  for (const [ext, count] of Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    lines.push(`| ${ext} | ${count} |`)
  }
  lines.push('')
  lines.push('## 场景结果')
  lines.push('')
  lines.push('| 场景 | 文件数 | 冷态avg(ms) | 冷态p95(ms) | 热态avg(ms) | 缓存冷态avg(ms) | 结论 |')
  lines.push('|---|---:|---:|---:|---:|---:|---|')
  for (const s of scenarios) {
    lines.push(`| ${s.scenario} | ${s.sourceFileCount} | ${s.metrics.cold.avgMs} | ${s.metrics.cold.p95Ms} | ${s.metrics.warm.avgMs} | ${s.metrics.cached.avgMs} | ${judgeScenario(s)} |`)
  }
  lines.push('')
  lines.push('## 结论')
  lines.push('')
  const highRisk = scenarios.filter((s) => judgeScenario(s).includes('风险'))
  if (highRisk.length === 0) {
    lines.push('- 当前规模下，检索链路表现稳定；首轮初始化有抖动，但热态和缓存冷启动均明显收敛。')
  } else {
    lines.push(`- ${highRisk.map((s) => s.scenario).join(', ')} 场景出现性能风险，建议分批导入并在导入后强制预热索引。`)
  }
  lines.push('- 建议把“冷态首问”和“缓存冷启动”纳入回归基线，避免后续版本退化。')
  return lines.join('\n')
}

function main(): void {
  const sourceRoot = process.argv[2] || DEFAULT_SOURCE_ROOT
  const reportPath = process.argv[3] || DEFAULT_REPORT_PATH

  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`source root 不存在: ${sourceRoot}`)
  }

  const allFiles: FileEntry[] = []
  walk(sourceRoot, sourceRoot, allFiles)

  const scenarios: ScenarioResult[] = []
  const pdfFiles = allFiles.filter((f) => f.ext === '.pdf')
  const officeFiles = allFiles.filter((f) => ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.csv'].includes(f.ext))

  if (pdfFiles.length > 0) scenarios.push(runScenario('pdf', pdfFiles))
  if (officeFiles.length > 0) scenarios.push(runScenario('office', officeFiles))
  scenarios.push(runScenario('mixed', allFiles))

  const report = buildMarkdownReport(sourceRoot, allFiles, scenarios)
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, report, 'utf-8')

  console.log(
    JSON.stringify(
      {
        sourceRoot,
        reportPath,
        fileCount: allFiles.length,
        scenarios,
      },
      null,
      2,
    ),
  )
}

main()
