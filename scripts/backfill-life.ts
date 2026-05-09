#!/usr/bin/env node
/**
 * scripts/backfill-life.ts
 *
 * Phase 6 / T6.1：历史分身「人生经历」回填扫描脚本。
 *
 * 用途：
 *   扫描 avatars/ 下所有分身，判定哪些缺少完整的 life/ 目录，输出回填清单。
 *   **本脚本不会自动调用任何 LLM**——人生生成必须由用户在 Electron 桌面端手工触发，
 *   原因是：
 *     1. 生成成本高（每个分身约 50 万 tokens），需要用户确认 creationModel 配置；
 *     2. 桌面端有 LifePanel 进度条 + 失败重试 UI，CLI 无对应 UX；
 *     3. cron 推进与初始化生成共享同一把进程内锁，CLI 并发触发会冲突。
 *
 * 输出：
 *   将每个分身分入四类：
 *     - ok            → life/manifest.json 存在且 generationStatus=complete|growing
 *     - generating    → 正在生成（generationStatus=pending|generating，或 progress.json 进行中）
 *     - failed        → generationStatus=failed
 *     - missing       → 没有 life/ 目录，需要在桌面端补做
 *   missing 类是 Phase 6 主要回填目标。
 *
 * 使用：
 *   npx tsx scripts/backfill-life.ts                  # 默认扫描 ./avatars
 *   npx tsx scripts/backfill-life.ts --root <path>    # 自定义 avatars 根
 *   npx tsx scripts/backfill-life.ts --json           # JSON 输出（CI 可消费）
 *
 * 退出码：
 *   0 — 全部 ok
 *   2 — 存在 missing/failed 分身（让 CI 失败提醒人补做）
 *   1 — 脚本本身出错（路径不存在、权限等）
 *
 * 幂等：重复运行只读，不写任何文件。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'fs'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_AVATARS_DIR = path.join(REPO_ROOT, 'avatars')

type LifeStatus = 'ok' | 'generating' | 'failed' | 'missing'

interface AvatarLifeReport {
  avatarId: string
  status: LifeStatus
  reason: string
  manifestStatus?: string
  totalEpisodes?: number
  currentAgeMonths?: number
  timeScale?: number
  growthEnabled?: boolean
  lastError?: string
}

interface CliOptions {
  root: string
  json: boolean
}

function parseArgs(argv: string[]): CliOptions {
  let root = DEFAULT_AVATARS_DIR
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') {
      const next = argv[i + 1]
      if (typeof next !== 'string' || next.length === 0) {
        throw new Error('--root 需要跟一个路径')
      }
      root = path.resolve(next)
      i++
    } else if (a === '--json') {
      json = true
    } else if (a === '-h' || a === '--help') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`未知参数: ${a}`)
    }
  }
  return { root, json }
}

function printHelp(): void {
  console.log(
    [
      '用法: npx tsx scripts/backfill-life.ts [--root <avatars 目录>] [--json]',
      '',
      '说明:',
      '  扫描 avatars/ 下所有分身，输出哪些缺少完整 life/ 目录。',
      '  本脚本不会自动生成人生（生成请到桌面端 LifePanel 手工触发）。',
    ].join('\n'),
  )
}

/**
 * 读单个分身的 life 目录状态，纯 IO + 静态判定，不调任何 LLM。
 */
function inspectAvatar(avatarsRoot: string, avatarId: string): AvatarLifeReport {
  const lifeDir = path.join(avatarsRoot, avatarId, 'life')
  if (!fs.existsSync(lifeDir)) {
    return {
      avatarId,
      status: 'missing',
      reason: 'life/ 目录不存在，需要在桌面端为该分身触发首次生成',
    }
  }

  const manifestPath = path.join(lifeDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    return {
      avatarId,
      status: 'missing',
      reason: 'life/ 存在但 manifest.json 缺失（可能初始化中断），需要在桌面端重新触发',
    }
  }

  let manifestRaw: string
  try {
    manifestRaw = fs.readFileSync(manifestPath, 'utf-8')
  } catch (err) {
    return {
      avatarId,
      status: 'failed',
      reason: `manifest.json 读取失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(manifestRaw) as Record<string, unknown>
  } catch (err) {
    return {
      avatarId,
      status: 'failed',
      reason: `manifest.json 格式损坏: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const generationStatus = typeof manifest.generationStatus === 'string' ? manifest.generationStatus : 'unknown'
  const totalEpisodes = typeof manifest.totalEpisodes === 'number' ? manifest.totalEpisodes : undefined
  const currentAgeMonths = typeof manifest.currentAgeMonths === 'number' ? manifest.currentAgeMonths : undefined
  const timeScale = typeof manifest.timeScale === 'number' ? manifest.timeScale : undefined
  const growthEnabled = typeof manifest.growthEnabled === 'boolean' ? manifest.growthEnabled : undefined

  const progress = readProgressSafe(lifeDir)
  const lastError = progress?.lastError && typeof progress.lastError === 'string' ? progress.lastError : undefined

  if (generationStatus === 'complete' || generationStatus === 'growing') {
    return {
      avatarId,
      status: 'ok',
      reason:
        `已就绪 (${generationStatus})，` +
        `${totalEpisodes ?? '?'} 个事件，年龄 ${formatAgeMonths(currentAgeMonths)}` +
        (timeScale !== undefined ? `，timeScale=${timeScale}×` : ''),
      manifestStatus: generationStatus,
      totalEpisodes,
      currentAgeMonths,
      timeScale,
      growthEnabled,
      lastError,
    }
  }
  if (generationStatus === 'failed') {
    return {
      avatarId,
      status: 'failed',
      reason: `manifest.generationStatus=failed${lastError ? `；最近错误: ${lastError}` : ''}，请到桌面端 LifePanel 重试`,
      manifestStatus: generationStatus,
      totalEpisodes,
      currentAgeMonths,
      timeScale,
      growthEnabled,
      lastError,
    }
  }
  return {
    avatarId,
    status: 'generating',
    reason: `正在生成 (${generationStatus})，请稍候或到桌面端 LifePanel 查看进度`,
    manifestStatus: generationStatus,
    totalEpisodes,
    currentAgeMonths,
    timeScale,
    growthEnabled,
    lastError,
  }
}

function readProgressSafe(lifeDir: string): Record<string, unknown> | null {
  const progressPath = path.join(lifeDir, 'progress.json')
  if (!fs.existsSync(progressPath)) {
    return null
  }
  try {
    const raw = fs.readFileSync(progressPath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return parsed
  } catch {
    return null
  }
}

function formatAgeMonths(months: number | undefined): string {
  if (typeof months !== 'number' || !Number.isFinite(months) || months < 0) {
    return '?'
  }
  const years = Math.floor(months / 12)
  const remain = Math.round(months - years * 12)
  return `${years} 岁 ${remain} 月`
}

function listAvatars(avatarsRoot: string): string[] {
  return fs
    .readdirSync(avatarsRoot, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh'))
}

function printHumanReport(reports: AvatarLifeReport[]): void {
  const buckets: Record<LifeStatus, AvatarLifeReport[]> = {
    ok: [],
    generating: [],
    failed: [],
    missing: [],
  }
  for (const r of reports) {
    buckets[r.status].push(r)
  }

  console.log(`\n[backfill-life] 共扫描 ${reports.length} 个分身\n`)
  console.log(
    `  ✓ ok=${buckets.ok.length}  ⟳ generating=${buckets.generating.length}  ` +
      `✗ failed=${buckets.failed.length}  ☐ missing=${buckets.missing.length}\n`,
  )

  if (buckets.missing.length > 0) {
    console.log('☐ 缺失人生（需要在桌面端补做）：')
    for (const r of buckets.missing) {
      console.log(`  · ${r.avatarId}  — ${r.reason}`)
    }
    console.log('')
  }
  if (buckets.failed.length > 0) {
    console.log('✗ 生成失败（需要在桌面端 LifePanel 点重试）：')
    for (const r of buckets.failed) {
      console.log(`  · ${r.avatarId}  — ${r.reason}`)
    }
    console.log('')
  }
  if (buckets.generating.length > 0) {
    console.log('⟳ 正在生成（请稍候，无需操作）：')
    for (const r of buckets.generating) {
      console.log(`  · ${r.avatarId}  — ${r.reason}`)
    }
    console.log('')
  }
  if (buckets.ok.length > 0) {
    console.log('✓ 已就绪：')
    for (const r of buckets.ok) {
      console.log(`  · ${r.avatarId}  — ${r.reason}`)
    }
    console.log('')
  }

  if (buckets.missing.length > 0 || buckets.failed.length > 0) {
    console.log('下一步：')
    console.log('  1. 启动桌面端 (cd desktop-app && npm run dev)')
    console.log('  2. 选中需要补做的分身')
    console.log('  3. 点击 PixelNavBar 的「人生 ❀」按钮，进入 LifePanel')
    console.log('  4. missing 分身 → 在「开始为分身设计人生」表单填年龄/timeScale 后点开始')
    console.log('  5. failed 分身 → 直接点「重试」按钮（断点续传，已生成的 episodes 不会重跑）')
    console.log('')
  }
}

function main(): void {
  let opts: CliOptions
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[backfill-life] 参数错误: ${err instanceof Error ? err.message : String(err)}`)
    printHelp()
    process.exit(1)
  }

  if (!fs.existsSync(opts.root)) {
    console.error(`[backfill-life] avatars 目录不存在: ${opts.root}`)
    process.exit(1)
  }

  const avatars = listAvatars(opts.root)
  if (avatars.length === 0) {
    console.log(`[backfill-life] ${opts.root} 下没有任何分身，跳过`)
    process.exit(0)
  }

  const reports = avatars.map(id => inspectAvatar(opts.root, id))

  if (opts.json) {
    process.stdout.write(JSON.stringify({ avatarsRoot: opts.root, reports }, null, 2) + '\n')
  } else {
    printHumanReport(reports)
  }

  const needsAction = reports.some(r => r.status === 'missing' || r.status === 'failed')
  process.exit(needsAction ? 2 : 0)
}

main()
