/**
 * rebuild-raw-from-source.ts —— 从外部源材料目录回填 knowledge/_raw/
 *
 * 背景：
 *   `avatars/<id>/knowledge/_raw/` 与 `expert-packs/<id>/knowledge/_raw/` 在仓库中
 *   通过 .gitignore 排除（原始 PDF/DOCX 等二进制源，单文件常 >100MB 超 GitHub 限制）。
 *   本地被清理后，需要按 .md frontmatter 的 `raw_file:` 引用，从外部源材料目录
 *   精准回填，避免无脑全量拷贝带来冗余与漏拷。
 *
 * 工作流（四阶段，可独立重试）：
 *   scan    扫描所有 .md frontmatter 的 raw_file 字段 → .manifest.json
 *   match   在源目录递归按 basename 匹配 → .match-report.json（含命中/未命中/同名多源/孤儿）
 *   copy    按 report 拷贝到 expert-packs/_raw/（主），再硬链接到 avatars/_raw/（镜像）
 *   verify  双边逐 .md 验证 raw_file 在 _raw/ 下可解，写 REBUILD_LOG.md 留痕
 *
 * 路径约定：
 *   <SOUL_ROOT>/expert-packs/<avatar>/knowledge/   主存储（含 _raw/、_index/、.md）
 *   <SOUL_ROOT>/avatars/<avatar>/knowledge/        本地编辑副本（_raw/ 用硬链接镜像）
 *
 * 用法：
 *   cd desktop-app
 *   npx tsx scripts/rebuild-raw-from-source.ts scan [--avatar <id>]
 *   npx tsx scripts/rebuild-raw-from-source.ts match --source <dir> [--avatar <id>]
 *   npx tsx scripts/rebuild-raw-from-source.ts copy [--avatar <id>] [--dry-run] [--no-mirror]
 *   npx tsx scripts/rebuild-raw-from-source.ts verify [--avatar <id>]
 *
 * 默认 avatar = `小堵-工商储专家`
 *
 * @author zhi.qu
 * @date 2026-05-15
 */

import fs from 'fs'
import path from 'path'

/* ------------------------------------------------------------------ */
/*  常量 / 路径解析                                                     */
/* ------------------------------------------------------------------ */

const SOUL_ROOT = path.resolve(__dirname, '../..')
const DEFAULT_AVATAR = '小堵-工商储专家'

interface AvatarPaths {
  avatarId: string
  /** expert-packs/<id>/knowledge —— 主存储（也是打包到 .exe/.dmg 的源） */
  expertKnowledge: string
  /** avatars/<id>/knowledge —— 本地编辑副本 */
  avatarKnowledge: string
  expertRaw: string
  avatarRaw: string
  /** scan 输出 / match 输入：raw 引用清单 */
  manifest: string
  /** match 输出 / copy 输入：源目录命中报告 */
  matchReport: string
  /** verify 输出：闭环校验日志（人类可读） */
  rebuildLog: string
}

function resolveAvatar(avatarId: string): AvatarPaths {
  const expertKnowledge = path.join(SOUL_ROOT, 'expert-packs', avatarId, 'knowledge')
  const avatarKnowledge = path.join(SOUL_ROOT, 'avatars', avatarId, 'knowledge')
  const expertRaw = path.join(expertKnowledge, '_raw')
  const avatarRaw = path.join(avatarKnowledge, '_raw')
  return {
    avatarId,
    expertKnowledge,
    avatarKnowledge,
    expertRaw,
    avatarRaw,
    manifest: path.join(expertRaw, '.manifest.json'),
    matchReport: path.join(expertRaw, '.match-report.json'),
    rebuildLog: path.join(expertRaw, 'REBUILD_LOG.md'),
  }
}

/* ------------------------------------------------------------------ */
/*  frontmatter 解析                                                    */
/* ------------------------------------------------------------------ */

/**
 * 从 .md 文件内容中提取 frontmatter 的 `raw_file` 字段。
 * 实现极简：只识别开头 `---\n...\n---` 块内首个匹配 `^raw_file:` 的行。
 * 不引入 gray-matter 依赖，避免脚本启动成本。
 *
 * @returns raw_file 字段值（如 `_raw/foo.pdf`），无则 null
 */
function extractRawFile(mdContent: string): string | null {
  if (!mdContent.startsWith('---')) return null
  const end = mdContent.indexOf('\n---', 3)
  if (end < 0) return null
  const frontmatter = mdContent.slice(3, end)
  const m = frontmatter.match(/^raw_file:\s*(.+?)\s*$/m)
  if (!m) return null
  let value = m[1].trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return value
}

/* ------------------------------------------------------------------ */
/*  数据结构                                                            */
/* ------------------------------------------------------------------ */

interface RawRef {
  /** 原始文件名（path.basename(raw_file)） */
  basename: string
  /** frontmatter 完整值，例如 `_raw/foo.pdf` */
  rawPath: string
  /** 引用该原始文件的 .md 列表（仅文件名，相对 knowledgeDir） */
  mdRelPaths: string[]
}

interface MatchHit {
  basename: string
  /** 源目录中匹配到的绝对路径（同名多源时取首个） */
  sourcePath: string
}

interface MatchReport {
  generatedAt: string
  sourceDir: string
  stats: {
    manifestSize: number
    hits: number
    misses: number
    duplicates: number
    orphansTotal: number
  }
  hits: MatchHit[]
  misses: string[]
  duplicates: { basename: string; sources: string[] }[]
  /** 源目录中未被任何 .md 引用的文件（仅采样前 N 条，避免 JSON 膨胀） */
  orphansSample: string[]
}

/* ------------------------------------------------------------------ */
/*  通用工具                                                            */
/* ------------------------------------------------------------------ */

/** 递归收集目录下所有文件（跳过 .DS_Store 与 . 开头隐藏文件/目录） */
function listFilesRecursive(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    console.error(`[listFiles] 读目录失败 ${dir}: ${(e as Error).message}`)
    return
  }
  for (const ent of entries) {
    if (ent.name === '.DS_Store' || ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) listFilesRecursive(full, out)
    else if (ent.isFile()) out.push(full)
  }
}

/* ------------------------------------------------------------------ */
/*  R1: scan                                                            */
/* ------------------------------------------------------------------ */

function cmdScan(paths: AvatarPaths): void {
  if (!fs.existsSync(paths.expertKnowledge)) {
    console.error(`[scan] knowledge 目录不存在: ${paths.expertKnowledge}`)
    process.exit(1)
  }
  console.log(`[scan] 扫描 ${paths.expertKnowledge}`)

  const refs = new Map<string, RawRef>()
  let totalMd = 0
  let mdWithRaw = 0

  const mdFiles = fs
    .readdirSync(paths.expertKnowledge)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))

  for (const mdName of mdFiles) {
    totalMd++
    const mdPath = path.join(paths.expertKnowledge, mdName)
    let content: string
    try {
      content = fs.readFileSync(mdPath, 'utf-8')
    } catch (e) {
      console.error(`[scan] 读 .md 失败 ${mdName}: ${(e as Error).message}`)
      continue
    }
    const rawRef = extractRawFile(content)
    if (!rawRef) continue
    mdWithRaw++
    const basename = path.basename(rawRef)
    if (!refs.has(basename)) {
      refs.set(basename, { basename, rawPath: rawRef, mdRelPaths: [] })
    }
    refs.get(basename)!.mdRelPaths.push(mdName)
  }

  fs.mkdirSync(paths.expertRaw, { recursive: true })
  const list = [...refs.values()].sort((a, b) => a.basename.localeCompare(b.basename))
  const manifest = {
    generatedAt: new Date().toISOString(),
    avatarId: paths.avatarId,
    knowledgeDir: path.relative(SOUL_ROOT, paths.expertKnowledge),
    stats: { totalMd, mdWithRaw, uniqueRawRefs: list.length },
    refs: list,
  }
  fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2))

  console.log(`[scan] avatar          = ${paths.avatarId}`)
  console.log(`[scan] .md 总数        = ${totalMd}`)
  console.log(`[scan] 含 raw_file 的  = ${mdWithRaw}`)
  console.log(`[scan] 去重后 raw 数   = ${list.length}`)
  console.log(`[scan] manifest 写入   = ${path.relative(SOUL_ROOT, paths.manifest)}`)
}

/* ------------------------------------------------------------------ */
/*  R2: match                                                           */
/* ------------------------------------------------------------------ */

function cmdMatch(paths: AvatarPaths, sourceDir: string): void {
  if (!fs.existsSync(paths.manifest)) {
    console.error(`[match] manifest 不存在，请先跑 scan: ${paths.manifest}`)
    process.exit(1)
  }
  if (!fs.existsSync(sourceDir)) {
    console.error(`[match] 源目录不存在: ${sourceDir}`)
    process.exit(1)
  }
  const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf-8')) as {
    refs: RawRef[]
  }
  const want = new Set<string>(manifest.refs.map(r => r.basename))
  console.log(`[match] 期望 ${want.size} 个 raw，源目录 = ${sourceDir}`)

  const allFiles: string[] = []
  listFilesRecursive(sourceDir, allFiles)
  console.log(`[match] 源目录文件总数 = ${allFiles.length}`)

  const hitMap = new Map<string, string[]>()
  const orphans: string[] = []
  for (const full of allFiles) {
    const bn = path.basename(full)
    if (want.has(bn)) {
      if (!hitMap.has(bn)) hitMap.set(bn, [])
      hitMap.get(bn)!.push(full)
    } else {
      orphans.push(full)
    }
  }

  const hits: MatchHit[] = []
  const duplicates: MatchReport['duplicates'] = []
  for (const [bn, sources] of hitMap) {
    sources.sort() // deterministic
    hits.push({ basename: bn, sourcePath: sources[0] })
    if (sources.length > 1) {
      duplicates.push({ basename: bn, sources })
    }
  }
  hits.sort((a, b) => a.basename.localeCompare(b.basename))

  const misses = [...want].filter(bn => !hitMap.has(bn)).sort()

  const ORPHAN_SAMPLE_LIMIT = 50
  const orphansSample = orphans
    .slice(0, ORPHAN_SAMPLE_LIMIT)
    .map(f => path.relative(sourceDir, f))

  const report: MatchReport = {
    generatedAt: new Date().toISOString(),
    sourceDir,
    stats: {
      manifestSize: want.size,
      hits: hits.length,
      misses: misses.length,
      duplicates: duplicates.length,
      orphansTotal: orphans.length,
    },
    hits,
    misses,
    duplicates,
    orphansSample,
  }
  fs.writeFileSync(paths.matchReport, JSON.stringify(report, null, 2))

  console.log(`[match] 命中           = ${hits.length} / ${want.size}`)
  console.log(`[match] 未命中         = ${misses.length}`)
  console.log(`[match] 同名多源       = ${duplicates.length}（默认取首个）`)
  console.log(`[match] 孤儿（未引用）= ${orphans.length}（仅记录前 ${ORPHAN_SAMPLE_LIMIT} 个）`)
  console.log(`[match] 报告写入       = ${path.relative(SOUL_ROOT, paths.matchReport)}`)
  if (misses.length > 0) {
    console.log(`[match] ⚠ 未命中样本（前 10 个）:`)
    misses.slice(0, 10).forEach(m => console.log(`  - ${m}`))
  }
}

/* ------------------------------------------------------------------ */
/*  R4: copy（双副本 + 硬链接）                                          */
/* ------------------------------------------------------------------ */

function cmdCopy(
  paths: AvatarPaths,
  opts: { dryRun: boolean; mirror: boolean },
): void {
  if (!fs.existsSync(paths.matchReport)) {
    console.error(`[copy] match-report 不存在，请先跑 match: ${paths.matchReport}`)
    process.exit(1)
  }
  const report = JSON.parse(fs.readFileSync(paths.matchReport, 'utf-8')) as MatchReport

  fs.mkdirSync(paths.expertRaw, { recursive: true })
  if (opts.mirror) fs.mkdirSync(paths.avatarRaw, { recursive: true })

  let copied = 0
  let linked = 0
  let copiedBytes = 0
  let skipped = 0
  let linkFallback = 0

  for (const hit of report.hits) {
    const dstMain = path.join(paths.expertRaw, hit.basename)
    if (fs.existsSync(dstMain)) {
      skipped++
    } else if (opts.dryRun) {
      copied++
    } else {
      try {
        fs.copyFileSync(hit.sourcePath, dstMain)
        copiedBytes += fs.statSync(dstMain).size
        copied++
      } catch (e) {
        console.error(`[copy] 拷贝失败 ${hit.basename}: ${(e as Error).message}`)
        continue
      }
    }

    if (!opts.mirror) continue
    const dstMirror = path.join(paths.avatarRaw, hit.basename)
    if (fs.existsSync(dstMirror)) continue
    if (opts.dryRun) {
      linked++
      continue
    }
    try {
      fs.linkSync(dstMain, dstMirror)
      linked++
    } catch {
      // 跨盘或权限问题：fallback 到 copy（保持两边都有文件，不阻塞流程）
      try {
        fs.copyFileSync(dstMain, dstMirror)
        linked++
        linkFallback++
      } catch (e2) {
        console.error(`[copy] 镜像失败 ${hit.basename}: ${(e2 as Error).message}`)
      }
    }
  }

  const tag = opts.dryRun ? '[DRY-RUN] ' : ''
  console.log(`[copy] ${tag}主存储拷贝 expert-packs/_raw/ = ${copied}`)
  if (opts.mirror) {
    console.log(`[copy] ${tag}镜像 avatars/_raw/         = ${linked}（硬链接，fallback=${linkFallback}）`)
  } else {
    console.log(`[copy] 未启用镜像（--no-mirror）`)
  }
  console.log(`[copy] 跳过（已存在）  = ${skipped}`)
  if (!opts.dryRun) {
    console.log(`[copy] 主存储写入字节  = ${(copiedBytes / 1024 / 1024).toFixed(1)} MB`)
  }
}

/* ------------------------------------------------------------------ */
/*  R5: verify                                                          */
/* ------------------------------------------------------------------ */

/**
 * 关键文件名清单：知识库的"核心入口"类文件（dashboard / 索引 / 总览），
 * 如果在 miss 名单里命中，应在日志最前面高亮提醒，以免被淹没在长清单中。
 * 规则：basename 包含以下任一片段（不区分大小写）。
 */
const CRITICAL_RAW_HINTS = ['dashboard', '总览', '索引', 'index', 'overview']

function cmdVerify(paths: AvatarPaths): void {
  if (!fs.existsSync(paths.expertKnowledge)) {
    console.error(`[verify] knowledge 目录不存在: ${paths.expertKnowledge}`)
    process.exit(1)
  }
  const sides: { name: string; dir: string }[] = [
    { name: 'expert-packs', dir: paths.expertRaw },
    { name: 'avatars', dir: paths.avatarRaw },
  ]
  const mdFiles = fs
    .readdirSync(paths.expertKnowledge)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))

  let totalMd = 0
  let okBoth = 0
  const broken: { md: string; raw: string; missingIn: string[] }[] = []

  for (const mdName of mdFiles) {
    const content = fs.readFileSync(path.join(paths.expertKnowledge, mdName), 'utf-8')
    const rawRef = extractRawFile(content)
    if (!rawRef) continue
    totalMd++
    const bn = path.basename(rawRef)
    const missing: string[] = []
    for (const s of sides) {
      if (!fs.existsSync(path.join(s.dir, bn))) missing.push(s.name)
    }
    if (missing.length === 0) okBoth++
    else broken.push({ md: mdName, raw: bn, missingIn: missing })
  }

  // 把 match-report 里的 miss / duplicates 同步进 REBUILD_LOG，让"重建结论"一处可读
  let matchReport: MatchReport | null = null
  if (fs.existsSync(paths.matchReport)) {
    try {
      matchReport = JSON.parse(fs.readFileSync(paths.matchReport, 'utf-8')) as MatchReport
    } catch (e) {
      console.error(`[verify] 读 match-report 失败: ${(e as Error).message}`)
    }
  }

  // 高亮关键文件（dashboard 等）：basename 命中 CRITICAL_RAW_HINTS 任一片段
  const criticalMisses = (matchReport?.misses ?? []).filter(m =>
    CRITICAL_RAW_HINTS.some(h => m.toLowerCase().includes(h.toLowerCase())),
  )

  console.log(`[verify] 含 raw_file 的 .md = ${totalMd}`)
  console.log(`[verify] 双边都可解         = ${okBoth}`)
  console.log(`[verify] 断链               = ${broken.length}`)
  if (criticalMisses.length > 0) {
    console.log(`[verify] ⚠ 关键文件缺失（请优先补齐）:`)
    criticalMisses.forEach(m => console.log(`  - ${m}`))
  }
  if (broken.length > 0) {
    console.log(`[verify] 前 10 条断链:`)
    broken.slice(0, 10).forEach(b => {
      console.log(`  - ${b.md} → ${b.raw} (缺: ${b.missingIn.join(',')})`)
    })
  }

  /* ---------------- 写 REBUILD_LOG.md（人类可读，结构化分段） ---------------- */
  const lines: string[] = [
    `# _raw 重建日志`,
    ``,
    `- 生成时间: ${new Date().toISOString()}`,
    `- avatarId: ${paths.avatarId}`,
    `- 含 raw_file 的 .md: ${totalMd}`,
    `- 双边都可解: ${okBoth}`,
    `- 断链: ${broken.length}`,
    ``,
  ]

  if (criticalMisses.length > 0) {
    lines.push(
      `## ⚠ 关键文件缺失（dashboard / 总览 等，建议优先手工补齐）`,
      ``,
      ...criticalMisses.map(m => `- **${m}**`),
      ``,
    )
  }

  if (matchReport) {
    lines.push(
      `## 源目录匹配概览（来自 .match-report.json）`,
      ``,
      `- 源目录: \`${matchReport.sourceDir}\``,
      `- 命中: ${matchReport.stats.hits} / ${matchReport.stats.manifestSize}`,
      `- 未命中: ${matchReport.stats.misses}`,
      `- 同名多源: ${matchReport.stats.duplicates}（默认取字母序首个）`,
      `- 孤儿（源中未引用）: ${matchReport.stats.orphansTotal}`,
      ``,
    )

    if (matchReport.misses.length > 0) {
      lines.push(
        `## 未命中清单（共 ${matchReport.misses.length} 个，需手工补到 _raw/ 才能解开引用）`,
        ``,
        ...matchReport.misses.map(m => `- ${m}`),
        ``,
      )
    }

    if (matchReport.duplicates.length > 0) {
      lines.push(
        `## 同名多源（共 ${matchReport.duplicates.length} 个，已默认取字母序首个）`,
        ``,
      )
      for (const d of matchReport.duplicates) {
        lines.push(`### ${d.basename}`)
        d.sources.forEach((s, i) => lines.push(`- ${i === 0 ? '✓ **已采用**' : '○ 备选'}: ${s}`))
        lines.push(``)
      }
    }
  }

  if (broken.length > 0) {
    lines.push(`## 断链清单（.md → raw_file 引用解不开）`, ``)
    for (const b of broken) {
      lines.push(`- ${b.md} → ${b.raw} (缺: ${b.missingIn.join(',')})`)
    }
    lines.push(``)
  }

  fs.mkdirSync(paths.expertRaw, { recursive: true })
  fs.writeFileSync(paths.rebuildLog, lines.join('\n'))
  console.log(`[verify] 日志写入: ${path.relative(SOUL_ROOT, paths.rebuildLog)}`)
}

/* ------------------------------------------------------------------ */
/*  CLI 入口                                                            */
/* ------------------------------------------------------------------ */

interface CliArgs {
  cmd: string
  avatar: string
  source?: string
  dryRun: boolean
  mirror: boolean
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2)
  const cmd = argv[0] ?? ''
  let avatar = DEFAULT_AVATAR
  let source: string | undefined
  let dryRun = false
  let mirror = true
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--avatar') avatar = argv[++i]
    else if (a === '--source') source = argv[++i]
    else if (a === '--dry-run') dryRun = true
    else if (a === '--no-mirror') mirror = false
    else {
      console.error(`[cli] 未知参数: ${a}`)
      process.exit(1)
    }
  }
  return { cmd, avatar, source, dryRun, mirror }
}

function printUsage(): void {
  console.error(`用法:
  npx tsx scripts/rebuild-raw-from-source.ts scan   [--avatar <id>]
  npx tsx scripts/rebuild-raw-from-source.ts match  --source <dir> [--avatar <id>]
  npx tsx scripts/rebuild-raw-from-source.ts copy   [--avatar <id>] [--dry-run] [--no-mirror]
  npx tsx scripts/rebuild-raw-from-source.ts verify [--avatar <id>]
  默认 avatar = ${DEFAULT_AVATAR}`)
}

function main(): void {
  const args = parseArgs()
  const paths = resolveAvatar(args.avatar)
  switch (args.cmd) {
    case 'scan':
      cmdScan(paths)
      break
    case 'match':
      if (!args.source) {
        console.error('[match] 需要 --source <dir>')
        process.exit(1)
      }
      cmdMatch(paths, args.source)
      break
    case 'copy':
      cmdCopy(paths, { dryRun: args.dryRun, mirror: args.mirror })
      break
    case 'verify':
      cmdVerify(paths)
      break
    default:
      printUsage()
      process.exit(1)
  }
}

main()
