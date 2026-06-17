#!/usr/bin/env node
/**
 * scripts/backfill-palace.ts
 *
 * Palace / 记忆宫殿回填脚本。
 *
 * 用途：
 *   扫描 avatars/ 下所有分身，检查是否已有 palace/ 文件协议；
 *   默认只读扫描，传入 --write 后才为缺失或不完整的分身补齐基础文件树。
 *
 * 使用：
 *   npx tsx scripts/backfill-palace.ts
 *   npx tsx scripts/backfill-palace.ts --write
 *   npx tsx scripts/backfill-palace.ts --root expert-packs --write
 *   npx tsx scripts/backfill-palace.ts --json
 *
 * 退出码：
 *   0 — 全部 ok，或 --write 后全部补齐成功
 *   2 — dry-run 发现 missing / partial，需要执行 --write 或人工确认
 *   1 — 脚本自身出错
 */

import fs from 'fs'
import path from 'path'

import {
  ensurePalaceWorkspace,
} from '../packages/core/src/palace/store'

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_AVATARS_DIR = path.join(REPO_ROOT, 'avatars')

type PalaceBackfillStatus = 'ok' | 'missing' | 'partial' | 'created' | 'error'

interface PalaceBackfillReport {
  avatarId: string
  status: PalaceBackfillStatus
  reason: string
  missingPaths: string[]
}

interface CliOptions {
  root: string
  write: boolean
  json: boolean
}

const REQUIRED_PATHS = [
  'palace/manifest.json',
  'palace/profile.md',
  'palace/company.md',
  'palace/commitments.json',
  'palace/inbox/items.json',
  'palace/people',
  'palace/projects',
  'palace/meetings',
  'palace/reports',
  'palace/decisions',
  'palace/achievements',
  'palace/wiki',
  'palace/rooms',
  'palace/inbox',
]

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(options.root)) {
    throw new Error(`avatars root 不存在: ${options.root}`)
  }

  const avatars = listAvatars(options.root)
  const reports: PalaceBackfillReport[] = []
  for (const avatarId of avatars) {
    reports.push(await inspectOrBackfillAvatar(options.root, avatarId, options.write))
  }

  if (options.json) {
    console.log(JSON.stringify({
      root: options.root,
      write: options.write,
      total: reports.length,
      reports,
    }, null, 2))
  } else {
    printHumanReport(options.root, options.write, reports)
  }

  const hasProblem = reports.some(r => r.status === 'missing' || r.status === 'partial' || r.status === 'error')
  process.exitCode = hasProblem ? (options.write ? 1 : 2) : 0
}

function parseArgs(argv: string[]): CliOptions {
  let root = DEFAULT_AVATARS_DIR
  let write = false
  let json = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--root') {
      const next = argv[i + 1]
      if (!next) throw new Error('--root 需要跟一个路径')
      root = path.resolve(next)
      i++
    } else if (arg === '--write') {
      write = true
    } else if (arg === '--json') {
      json = true
    } else if (arg === '-h' || arg === '--help') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }

  return { root, write, json }
}

function printHelp(): void {
  console.log([
    '用法: npx tsx scripts/backfill-palace.ts [--root <avatars 目录>] [--write] [--json]',
    '',
    '默认只扫描不写入；加 --write 后为每个分身幂等创建 palace/ 文件树。',
  ].join('\n'))
}

async function inspectOrBackfillAvatar(
  avatarsRoot: string,
  avatarId: string,
  write: boolean,
): Promise<PalaceBackfillReport> {
  try {
    const before = inspectAvatar(avatarsRoot, avatarId)
    if (!write || before.status === 'ok') return before

    await ensurePalaceWorkspace(avatarsRoot, avatarId)
    const after = inspectAvatar(avatarsRoot, avatarId)
    if (after.status === 'ok') {
      return {
        avatarId,
        status: 'created',
        reason: before.status === 'missing' ? '已创建 palace/ 文件树' : '已补齐 palace/ 缺失文件',
        missingPaths: [],
      }
    }
    return after
  } catch (err) {
    return {
      avatarId,
      status: 'error',
      reason: err instanceof Error ? err.message : String(err),
      missingPaths: [],
    }
  }
}

function inspectAvatar(avatarsRoot: string, avatarId: string): PalaceBackfillReport {
  const avatarRoot = path.join(avatarsRoot, avatarId)
  const palaceRoot = path.join(avatarRoot, 'palace')
  const missingPaths = REQUIRED_PATHS.filter(rel => !fs.existsSync(path.join(avatarRoot, rel)))

  if (!fs.existsSync(palaceRoot)) {
    return {
      avatarId,
      status: 'missing',
      reason: 'palace/ 目录不存在',
      missingPaths,
    }
  }
  if (missingPaths.length > 0) {
    return {
      avatarId,
      status: 'partial',
      reason: `palace/ 已存在但缺少 ${missingPaths.length} 个必要路径`,
      missingPaths,
    }
  }
  return {
    avatarId,
    status: 'ok',
    reason: 'palace/ 文件协议已就绪',
    missingPaths: [],
  }
}

function listAvatars(avatarsRoot: string): string[] {
  return fs
    .readdirSync(avatarsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && looksLikeAvatar(path.join(avatarsRoot, entry.name)))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh'))
}

function looksLikeAvatar(dir: string): boolean {
  return [
    'soul.md',
    'CLAUDE.md',
    'AGENTS.md',
    'expert-pack.json',
  ].some(file => fs.existsSync(path.join(dir, file)))
}

function printHumanReport(root: string, write: boolean, reports: PalaceBackfillReport[]): void {
  const counts: Record<PalaceBackfillStatus, number> = {
    ok: 0,
    missing: 0,
    partial: 0,
    created: 0,
    error: 0,
  }
  for (const report of reports) counts[report.status]++

  console.log(`\n[backfill-palace] root=${root}`)
  console.log(`[backfill-palace] mode=${write ? 'write' : 'dry-run'} total=${reports.length}`)
  console.log(
    `  ok=${counts.ok} created=${counts.created} missing=${counts.missing} partial=${counts.partial} error=${counts.error}\n`,
  )

  for (const report of reports) {
    const mark = statusMark(report.status)
    console.log(`${mark} ${report.avatarId} — ${report.reason}`)
    if (report.missingPaths.length > 0) {
      console.log(`    missing: ${report.missingPaths.slice(0, 6).join(', ')}${report.missingPaths.length > 6 ? '...' : ''}`)
    }
  }
}

function statusMark(status: PalaceBackfillStatus): string {
  switch (status) {
    case 'ok':
      return 'OK'
    case 'created':
      return 'NEW'
    case 'missing':
      return 'MISS'
    case 'partial':
      return 'PART'
    case 'error':
      return 'ERR'
  }
}

main().catch(err => {
  console.error(`[backfill-palace] ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
