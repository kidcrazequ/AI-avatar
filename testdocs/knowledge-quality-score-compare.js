/**
 * Compare two knowledge quality score reports.
 *
 * Usage:
 *   cd packages/core
 *   npm run test:knowledge-score-compare -- "/path/to/before.md" "/path/to/after.md"
 *   npm run test:knowledge-score-compare -- "/path/to/before.md" "/path/to/after.md" "/path/to/output.md"
 */

const fs = require('fs')
const path = require('path')

function parsePercent(line, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = line.match(new RegExp(`${escaped}:\\s*([0-9]+(?:\\.[0-9]+)?)%`))
  return m ? Number(m[1]) : null
}

function parseNumber(line, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = line.match(new RegExp(`${escaped}:\\s*([0-9]+(?:\\.[0-9]+)?)`))
  return m ? Number(m[1]) : null
}

function parseReport(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8')
  const lines = text.split('\n')

  const totalMatch = text.match(/\*\*(\d+)\s*\/\s*100\*\*/)
  const totalScore = totalMatch ? Number(totalMatch[1]) : null

  const dimensions = {}
  for (const line of lines) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean)
    if (cells.length < 3) continue
    if (!cells[0].startsWith('A.') && !cells[0].startsWith('B.') && !cells[0].startsWith('C.') && !cells[0].startsWith('D+E.')) continue
    const score = Number(cells[2])
    if (!Number.isNaN(score)) dimensions[cells[0]] = score
  }

  let mdRatio = null
  let frontmatterRatio = null
  let headingRatio = null
  let top3Rate = null
  let coldMs = null
  let warmMs = null

  for (const line of lines) {
    if (line.includes('.md 占比')) mdRatio = parsePercent(line, '.md 占比')
    if (line.includes('frontmatter 覆盖率')) frontmatterRatio = parsePercent(line, 'frontmatter 覆盖率')
    if (line.includes('heading 覆盖率')) headingRatio = parsePercent(line, 'heading 覆盖率')
    if (line.includes('Top3 命中率')) top3Rate = parsePercent(line, '检索 Top3 命中率（代理）')
    if (line.includes('检索冷态平均')) coldMs = parseNumber(line, '检索冷态平均')
    if (line.includes('检索热态平均')) warmMs = parseNumber(line, '检索热态平均')
  }

  return {
    filePath,
    totalScore,
    dimensions,
    mdRatio,
    frontmatterRatio,
    headingRatio,
    top3Rate,
    coldMs,
    warmMs,
  }
}

function diffNum(before, after) {
  if (before === null || after === null || before === undefined || after === undefined) return null
  return Number((after - before).toFixed(2))
}

function buildAdvice(before, after, diff) {
  const advices = []
  if ((after.mdRatio ?? 0) < 90) {
    advices.push('优先提升 `.md` 占比到 90% 以上（这是总分提升最快的杠杆）。')
  }
  if ((after.frontmatterRatio ?? 0) < 90) {
    advices.push('补齐 frontmatter（source/type/date/tags/rag_only）到 90%+。')
  }
  if ((after.headingRatio ?? 0) < 90) {
    advices.push('确保 md 至少有 `#` / `##` 层级结构，避免长文纯文本。')
  }
  if ((after.top3Rate ?? 100) < 60) {
    advices.push('优化专题索引页和同义词词表，提高 Top3 命中率到 60%+。')
  }
  if (diff.totalScore !== null && diff.totalScore <= 0) {
    advices.push('format 后总分未提升，请检查是否仅做了格式转换而未做结构化清洗。')
  }
  if (advices.length === 0) {
    advices.push('当前改造方向有效，建议继续按同一规范扩大覆盖范围。')
  }
  return advices
}

function main() {
  const beforePath = process.argv[2]
  const afterPath = process.argv[3]
  const outputPath = process.argv[4] || path.join('/Users/cnlm007398/AI/soul/testdocs', 'knowledge-quality-score-diff.md')

  if (!beforePath || !afterPath) {
    throw new Error('usage: npm run test:knowledge-score-compare -- "/path/to/before.md" "/path/to/after.md" [output.md]')
  }
  if (!fs.existsSync(beforePath)) throw new Error(`before report not found: ${beforePath}`)
  if (!fs.existsSync(afterPath)) throw new Error(`after report not found: ${afterPath}`)

  const before = parseReport(beforePath)
  const after = parseReport(afterPath)

  const diff = {
    totalScore: diffNum(before.totalScore, after.totalScore),
    mdRatio: diffNum(before.mdRatio, after.mdRatio),
    frontmatterRatio: diffNum(before.frontmatterRatio, after.frontmatterRatio),
    headingRatio: diffNum(before.headingRatio, after.headingRatio),
    top3Rate: diffNum(before.top3Rate, after.top3Rate),
    coldMs: diffNum(before.coldMs, after.coldMs),
    warmMs: diffNum(before.warmMs, after.warmMs),
  }

  const allDims = Array.from(new Set([...Object.keys(before.dimensions), ...Object.keys(after.dimensions)]))
  const dimensionDiffs = allDims.map((k) => ({
    name: k,
    before: before.dimensions[k] ?? null,
    after: after.dimensions[k] ?? null,
    delta: diffNum(before.dimensions[k] ?? null, after.dimensions[k] ?? null),
  }))

  const advice = buildAdvice(before, after, diff)

  const lines = []
  lines.push('# 知识库质量评分前后对比')
  lines.push('')
  lines.push(`- before: \`${beforePath}\``)
  lines.push(`- after: \`${afterPath}\``)
  lines.push('')
  lines.push('## 总分变化')
  lines.push('')
  lines.push(`- before: **${before.totalScore ?? 'N/A'} / 100**`)
  lines.push(`- after: **${after.totalScore ?? 'N/A'} / 100**`)
  lines.push(`- delta: **${diff.totalScore ?? 'N/A'}**`)
  lines.push('')
  lines.push('## 维度变化')
  lines.push('')
  lines.push('| 维度 | before | after | delta |')
  lines.push('|---|---:|---:|---:|')
  for (const d of dimensionDiffs) {
    lines.push(`| ${d.name} | ${d.before ?? 'N/A'} | ${d.after ?? 'N/A'} | ${d.delta ?? 'N/A'} |`)
  }
  lines.push('')
  lines.push('## 核心指标变化')
  lines.push('')
  lines.push('| 指标 | before | after | delta |')
  lines.push('|---|---:|---:|---:|')
  lines.push(`| .md 占比(%) | ${before.mdRatio ?? 'N/A'} | ${after.mdRatio ?? 'N/A'} | ${diff.mdRatio ?? 'N/A'} |`)
  lines.push(`| frontmatter 覆盖率(%) | ${before.frontmatterRatio ?? 'N/A'} | ${after.frontmatterRatio ?? 'N/A'} | ${diff.frontmatterRatio ?? 'N/A'} |`)
  lines.push(`| heading 覆盖率(%) | ${before.headingRatio ?? 'N/A'} | ${after.headingRatio ?? 'N/A'} | ${diff.headingRatio ?? 'N/A'} |`)
  lines.push(`| Top3 命中率(%) | ${before.top3Rate ?? 'N/A'} | ${after.top3Rate ?? 'N/A'} | ${diff.top3Rate ?? 'N/A'} |`)
  lines.push(`| 冷态平均耗时(ms) | ${before.coldMs ?? 'N/A'} | ${after.coldMs ?? 'N/A'} | ${diff.coldMs ?? 'N/A'} |`)
  lines.push(`| 热态平均耗时(ms) | ${before.warmMs ?? 'N/A'} | ${after.warmMs ?? 'N/A'} | ${diff.warmMs ?? 'N/A'} |`)
  lines.push('')
  lines.push('## 建议动作')
  lines.push('')
  for (const item of advice) lines.push(`- ${item}`)

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')

  console.log(JSON.stringify({ outputPath, before, after, diff, dimensionDiffs, advice }, null, 2))
}

main()
