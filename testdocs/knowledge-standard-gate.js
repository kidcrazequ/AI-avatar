/**
 * Knowledge standard gate checker.
 *
 * Goal:
 * - Ensure all imported files reach target standard.
 * - Fail fast when any file violates hard rules.
 *
 * Usage:
 *   cd packages/core
 *   npm run test:knowledge-standard-gate -- "/path/to/knowledge-root" 396
 *   npm run test:knowledge-standard-gate -- "/path/to/knowledge-root" 396 "/path/to/report.json"
 */

const fs = require('fs')
const path = require('path')

const DEFAULT_MIN_READABILITY = 70
const DEFAULT_MAX_LONG_LINE_RATIO = 0.15
const DEFAULT_MIN_HEADING_RATIO = 0.02

function walk(root) {
  const out = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  visit(root)
  return out
}

function scoreReadability(text) {
  const lines = text.split(/\r?\n/)
  const nonEmpty = lines.filter((l) => l.trim().length > 0)
  const heading = lines.filter((l) => /^#{1,3}\s+/.test(l)).length
  const table = lines.filter((l) => /^\|.*\|\s*$/.test(l)).length
  const avgLen = nonEmpty.length > 0 ? nonEmpty.reduce((s, l) => s + l.length, 0) / nonEmpty.length : 0
  const longLines = nonEmpty.filter((l) => l.length > 180).length

  const tableRatio = nonEmpty.length > 0 ? table / nonEmpty.length : 0
  const headingRatio = nonEmpty.length > 0 ? heading / nonEmpty.length : 0
  const longLineRatio = nonEmpty.length > 0 ? longLines / nonEmpty.length : 0

  let score = 100
  if (tableRatio > 0.6) score -= 35
  else if (tableRatio > 0.4) score -= 25
  else if (tableRatio > 0.25) score -= 15

  if (avgLen > 180) score -= 20
  else if (avgLen > 120) score -= 12
  else if (avgLen > 80) score -= 6

  if (longLineRatio > 0.3) score -= 20
  else if (longLineRatio > 0.15) score -= 12
  else if (longLineRatio > 0.05) score -= 6

  if (headingRatio < 0.02) score -= 15
  else if (headingRatio < 0.05) score -= 8

  return {
    score: Math.max(0, Math.round(score)),
    nonEmptyLines: nonEmpty.length,
    tableRatio,
    headingRatio,
    longLineRatio,
    avgLineLength: Number(avgLen.toFixed(2)),
  }
}

function hasFrontmatter(text) {
  return text.startsWith('---\n') || text.startsWith('---\r\n')
}

function main() {
  const targetRoot = process.argv[2]
  const expectedCountRaw = process.argv[3]
  const outputPath = process.argv[4] || path.join(process.cwd(), 'knowledge-standard-gate-report.json')

  if (!targetRoot || !expectedCountRaw) {
    throw new Error('usage: npm run test:knowledge-standard-gate -- "/path/to/knowledge-root" <expected_count> [output-report.json]')
  }
  if (!fs.existsSync(targetRoot)) {
    throw new Error(`target root not found: ${targetRoot}`)
  }

  const expectedCount = Number.parseInt(expectedCountRaw, 10)
  if (!Number.isFinite(expectedCount) || expectedCount <= 0) {
    throw new Error(`invalid expected_count: ${expectedCountRaw}`)
  }

  const files = walk(targetRoot)
  const rel = (p) => path.relative(targetRoot, p)

  const mdFiles = files.filter((f) => path.extname(f).toLowerCase() === '.md')
  const nonMdFiles = files.filter((f) => path.extname(f).toLowerCase() !== '.md')

  const readabilityFailures = []
  const structureFailures = []

  let readabilitySum = 0
  for (const file of mdFiles) {
    const text = fs.readFileSync(file, 'utf-8')
    const r = scoreReadability(text)
    readabilitySum += r.score

    if (!hasFrontmatter(text)) {
      structureFailures.push({
        file: rel(file),
        reason: 'missing_frontmatter',
      })
    }
    if (r.headingRatio < DEFAULT_MIN_HEADING_RATIO) {
      structureFailures.push({
        file: rel(file),
        reason: 'insufficient_headings',
        headingRatio: Number((r.headingRatio * 100).toFixed(2)),
      })
    }
    if (r.longLineRatio > DEFAULT_MAX_LONG_LINE_RATIO) {
      structureFailures.push({
        file: rel(file),
        reason: 'too_many_long_lines',
        longLineRatio: Number((r.longLineRatio * 100).toFixed(2)),
      })
    }
    if (r.score < DEFAULT_MIN_READABILITY) {
      readabilityFailures.push({
        file: rel(file),
        readabilityScore: r.score,
      })
    }
  }

  const avgReadability = mdFiles.length > 0 ? Number((readabilitySum / mdFiles.length).toFixed(2)) : 0

  const gate = {
    expectedCount,
    totalFileCount: files.length,
    mdCount: mdFiles.length,
    nonMdCount: nonMdFiles.length,
    avgReadability,
    pass: true,
  }

  const violations = []
  if (mdFiles.length !== expectedCount) {
    gate.pass = false
    violations.push({
      type: 'count_mismatch',
      expectedMdCount: expectedCount,
      actualMdCount: mdFiles.length,
    })
  }
  if (nonMdFiles.length > 0) {
    gate.pass = false
    violations.push({
      type: 'non_md_files_present',
      count: nonMdFiles.length,
      samples: nonMdFiles.slice(0, 20).map(rel),
    })
  }
  if (readabilityFailures.length > 0) {
    gate.pass = false
    violations.push({
      type: 'readability_failures',
      count: readabilityFailures.length,
      threshold: DEFAULT_MIN_READABILITY,
      samples: readabilityFailures.slice(0, 30),
    })
  }
  if (structureFailures.length > 0) {
    gate.pass = false
    violations.push({
      type: 'structure_failures',
      count: structureFailures.length,
      samples: structureFailures.slice(0, 30),
    })
  }

  const report = {
    targetRoot,
    gate,
    violations,
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8')
  console.log(JSON.stringify(report, null, 2))

  if (!gate.pass) process.exitCode = 2
}

main()
