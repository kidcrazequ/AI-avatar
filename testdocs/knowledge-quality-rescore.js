/**
 * Knowledge quality rescoring script (100-point scale).
 *
 * Usage:
 *   cd packages/core
 *   npm run test:knowledge-score -- "/path/to/knowledge"
 *
 * Optional:
 *   npm run test:knowledge-score -- "/path/to/knowledge" "/path/to/output-report.md"
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { KnowledgeRetriever } = require('../packages/core/src/knowledge-retriever.ts')

const TEXT_LIKE = new Set(['.md', '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.csv', '.txt'])

function walk(root) {
  const out = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
      } else if (entry.isFile()) {
        const stat = fs.statSync(full)
        out.push({
          full,
          rel: path.relative(root, full),
          ext: path.extname(full).toLowerCase() || '(none)',
          size: stat.size,
        })
      }
    }
  }
  visit(root)
  return out
}

function normalizeName(input) {
  return input.replace(/\.[^.]+$/, '').replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

function pickSpread(arr, count) {
  if (arr.length <= count) return [...arr]
  const out = []
  const step = Math.max(1, Math.floor(arr.length / count))
  for (let i = 0; i < arr.length && out.length < count; i += step) out.push(arr[i])
  return out
}

function scoreFormatCompliance(mdRatio) {
  if (mdRatio >= 0.9) return 40
  if (mdRatio >= 0.8) return 34
  if (mdRatio >= 0.5) return 22
  if (mdRatio > 0) return 10
  return 0
}

function scoreCoverage(textLikeRatio) {
  return Math.max(0, Math.min(20, Math.round(textLikeRatio * 20)))
}

function scoreStructure(mdFiles, root) {
  if (mdFiles.length === 0) return { score: 0, frontmatterRatio: 0, headingRatio: 0 }
  const sample = pickSpread(mdFiles, Math.min(80, mdFiles.length))
  let withFrontmatter = 0
  let withHeading = 0
  for (const f of sample) {
    try {
      const text = fs.readFileSync(path.join(root, f.rel), 'utf-8').slice(0, 30000)
      if (text.startsWith('---\n') || text.startsWith('---\r\n')) withFrontmatter++
      if (/^#{1,3}\s+/m.test(text)) withHeading++
    } catch {
      // ignore single file read failure in scoring
    }
  }
  const frontmatterRatio = sample.length > 0 ? withFrontmatter / sample.length : 0
  const headingRatio = sample.length > 0 ? withHeading / sample.length : 0
  const score = Math.round(20 * (frontmatterRatio * 0.5 + headingRatio * 0.5))
  return { score, frontmatterRatio, headingRatio }
}

function runRetrievalMetrics(root, mdFiles) {
  if (mdFiles.length === 0) {
    return {
      score: 0,
      coldAvgMs: null,
      warmAvgMs: null,
      top3Rate: null,
      sampleSize: 0,
    }
  }

  const sample = pickSpread(mdFiles, Math.min(20, mdFiles.length))
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-score-sample-'))
  const MAX_RETRIEVAL_CHARS_PER_FILE = 5000
  for (const file of sample) {
    const sourcePath = path.join(root, file.rel)
    const targetPath = path.join(tempRoot, file.rel)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    const text = fs.readFileSync(sourcePath, 'utf-8').slice(0, MAX_RETRIEVAL_CHARS_PER_FILE)
    fs.writeFileSync(targetPath, text, 'utf-8')
  }

  const retriever = new KnowledgeRetriever(tempRoot)
  const questions = sample.map((f) => `请检索与 ${path.basename(f.rel)} 相关的内容`)

  const runPass = () => {
    const costs = []
    for (const q of questions) {
      const t0 = Date.now()
      retriever.searchChunks(q, 5)
      costs.push(Date.now() - t0)
    }
    return Number((costs.reduce((s, x) => s + x, 0) / costs.length).toFixed(2))
  }

  const coldAvgMs = runPass()
  const warmAvgMs = runPass()

  let top3Hit = 0
  for (const f of sample) {
    const q = `请检索与 ${path.basename(f.rel)} 相关的内容`
    const hits = retriever.searchChunks(q, 3)
    const key = normalizeName(path.basename(f.rel))
    const ok = hits.some((h) => normalizeName(h.file).includes(key) || normalizeName(h.heading).includes(key) || normalizeName(h.content).includes(key))
    if (ok) top3Hit++
  }
  const top3Rate = sample.length > 0 ? top3Hit / sample.length : 0

  let perfScore = 0
  if (warmAvgMs <= 50) perfScore = 6
  else if (warmAvgMs <= 100) perfScore = 4
  else if (warmAvgMs <= 200) perfScore = 3
  else perfScore = 2

  let qualityScore = 0
  if (top3Rate >= 0.7) qualityScore = 4
  else if (top3Rate >= 0.5) qualityScore = 3
  else if (top3Rate >= 0.3) qualityScore = 2
  else qualityScore = 1

  try {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // Scoring must not fail because temporary cleanup failed.
  }

  return {
    score: (perfScore + qualityScore) * 2,
    coldAvgMs,
    warmAvgMs,
    top3Rate: Number((top3Rate * 100).toFixed(2)),
    sampleSize: sample.length,
    retrievalCorpus: 'sampled-truncated',
    maxCharsPerFile: MAX_RETRIEVAL_CHARS_PER_FILE,
  }
}

function toSlug(input) {
  return input.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()
}

function generateReport(targetRoot, summary) {
  const lines = []
  lines.push('# 知识库质量复评报告（100 分制）')
  lines.push('')
  lines.push(`- 目录: \`${targetRoot}\``)
  lines.push(`- 评估时间: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`)
  lines.push(`- 核心规则: 知识库文件应以 \`.md\` 为主格式`)
  lines.push('')
  lines.push('## 总分')
  lines.push('')
  lines.push(`- **${summary.totalScore} / 100**`)
  lines.push('')
  lines.push('## 维度明细')
  lines.push('')
  lines.push('| 维度 | 分值 | 结果 |')
  lines.push('|---|---:|---|')
  lines.push(`| A. 格式合规（MD 主格式） | 40 | ${summary.formatScore} |`)
  lines.push(`| B. 可解析覆盖 | 20 | ${summary.coverageScore} |`)
  lines.push(`| C. 结构化质量 | 20 | ${summary.structure.score} |`)
  lines.push(`| D+E. 检索与回答代理质量 | 20 | ${summary.retrieval.score} |`)
  lines.push('')
  lines.push('## 数据概览')
  lines.push('')
  lines.push(`- 文件总数: ${summary.fileCount}`)
  lines.push(`- .md 数量: ${summary.mdCount}`)
  lines.push(`- .md 占比: ${(summary.mdRatio * 100).toFixed(2)}%`)
  lines.push(`- 文本型占比: ${(summary.textLikeRatio * 100).toFixed(2)}%`)
  lines.push(`- frontmatter 覆盖率: ${(summary.structure.frontmatterRatio * 100).toFixed(2)}%`)
  lines.push(`- heading 覆盖率: ${(summary.structure.headingRatio * 100).toFixed(2)}%`)
  if (summary.retrieval.sampleSize > 0) {
    lines.push(`- 检索冷态平均: ${summary.retrieval.coldAvgMs}ms`)
    lines.push(`- 检索热态平均: ${summary.retrieval.warmAvgMs}ms`)
    lines.push(`- 检索 Top3 命中率（代理）: ${summary.retrieval.top3Rate}%`)
  } else {
    lines.push('- 检索项: 无 md 文件，未执行')
  }
  lines.push('')
  lines.push('## 扩展名分布 Top 12')
  lines.push('')
  lines.push('| 扩展名 | 数量 |')
  lines.push('|---|---:|')
  for (const [ext, count] of summary.topExt) {
    lines.push(`| ${ext} | ${count} |`)
  }
  lines.push('')
  lines.push('## 结论')
  lines.push('')
  if (summary.mdRatio < 0.8) {
    lines.push('- 当前目录不满足“知识库以 md 为主”的目标，建议先做 raw -> md 标准化。')
  } else {
    lines.push('- 当前目录 md 占比达到可用门槛，可继续优化结构化字段与命中率。')
  }
  if (summary.retrieval.sampleSize > 0 && summary.retrieval.top3Rate < 50) {
    lines.push('- 检索命中代理指标偏低，建议补充专题索引页和关键词同义词。')
  }
  return lines.join('\n')
}

function main() {
  const targetRoot = process.argv[2]
  if (!targetRoot) {
    throw new Error('missing target root, usage: npm run test:knowledge-score -- "/path/to/knowledge" [output-report.md]')
  }
  if (!fs.existsSync(targetRoot)) {
    throw new Error(`target root not found: ${targetRoot}`)
  }
  const outputPath = process.argv[3] || path.join('/Users/cnlm007398/AI/soul/testdocs', `knowledge-quality-score-${toSlug(path.basename(targetRoot) || 'target')}.md`)

  const files = walk(targetRoot)
  const fileCount = files.length
  const mdFiles = files.filter((f) => f.ext === '.md')
  const mdCount = mdFiles.length
  const mdRatio = fileCount > 0 ? mdCount / fileCount : 0
  const textLikeCount = files.filter((f) => TEXT_LIKE.has(f.ext)).length
  const textLikeRatio = fileCount > 0 ? textLikeCount / fileCount : 0

  const byExt = {}
  for (const f of files) byExt[f.ext] = (byExt[f.ext] || 0) + 1
  const topExt = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 12)

  const formatScore = scoreFormatCompliance(mdRatio)
  const coverageScore = scoreCoverage(textLikeRatio)
  const structure = scoreStructure(mdFiles, targetRoot)
  const retrieval = runRetrievalMetrics(targetRoot, mdFiles)

  const totalScore = formatScore + coverageScore + structure.score + retrieval.score

  const summary = {
    targetRoot,
    outputPath,
    fileCount,
    mdCount,
    mdRatio,
    textLikeRatio,
    formatScore,
    coverageScore,
    structure,
    retrieval,
    totalScore,
    topExt,
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, generateReport(targetRoot, summary), 'utf-8')
  console.log(JSON.stringify(summary, null, 2))
}

main()
