#!/usr/bin/env node
/**
 * scripts/soul-pack-cli.ts
 *
 * Soul 分身可移植打包 CLI（Letta .af 借鉴，v18）。
 *
 * 用途：让用户不进入桌面端也能 export / import / preview 分身 pack。
 *
 * 用法：
 *   npx tsx scripts/soul-pack-cli.ts export <avatar-id> <output-file.soulpack.json> [options]
 *   npx tsx scripts/soul-pack-cli.ts import <input-file.soulpack.json> [options]
 *   npx tsx scripts/soul-pack-cli.ts preview <input-file.soulpack.json>
 *
 * export 选项：
 *   --root <path>          avatars/ 根目录（默认 ./avatars）
 *   --include-memory       打包 memory/ 下用户记忆（默认不打包）
 *   --include-life         打包 life/ 想象人生（默认不打包）
 *   --include-wiki         打包 wiki/concepts（默认不打包）
 *   --display-name <name>  覆盖 display_name
 *   --description <text>   覆盖 description
 *   --domain <tag>         设置 domain
 *   --created-by <id>      设置 created_by
 *
 * import 选项：
 *   --root <path>          avatars/ 根目录（默认 ./avatars）
 *   --target <id>          覆盖 targetAvatarId
 *   --force                目标已存在时强制覆盖（先清空再写）
 *   --no-memory            不还原 memory（即使 pack 包含）
 *
 * 退出码：0 成功；1 参数 / 文件问题；2 校验失败 / 已存在拒绝；3 其他错误
 */

import fs from 'fs'
import path from 'path'
import {
  exportSoulPack,
  importSoulPack,
  serializeSoulPack,
  parseSoulPack,
} from '../packages/core/src/soul-pack'

interface ParsedArgs {
  positional: string[]
  flags: Set<string>
  values: Map<string, string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags = new Set<string>()
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        values.set(key, next)
        i++
      } else {
        flags.add(key)
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags, values }
}

function resolveRoot(args: ParsedArgs): string {
  return path.resolve(args.values.get('root') ?? 'avatars')
}

function commandExport(args: ParsedArgs): number {
  const [avatarId, outputFile] = args.positional
  if (!avatarId || !outputFile) {
    console.error('usage: soul-pack-cli export <avatar-id> <output-file>')
    return 1
  }
  const avatarsRoot = resolveRoot(args)
  if (!fs.existsSync(avatarsRoot)) {
    console.error(`avatars root 不存在: ${avatarsRoot}`)
    return 1
  }
  try {
    const pack = exportSoulPack(avatarsRoot, avatarId, {
      includeMemory: args.flags.has('include-memory'),
      includeLife: args.flags.has('include-life'),
      includeWiki: args.flags.has('include-wiki'),
      displayName: args.values.get('display-name'),
      description: args.values.get('description'),
      domain: args.values.get('domain'),
      createdBy: args.values.get('created-by'),
    })
    const json = serializeSoulPack(pack)
    const outPath = path.resolve(outputFile)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, json, 'utf-8')
    console.log(`✓ exported ${avatarId} → ${outPath}`)
    console.log(`  size: ${Buffer.byteLength(json, 'utf-8')} bytes`)
    console.log(`  files: ${pack.files.length} inline, ${pack.binary_refs.length} binary refs`)
    console.log(`  memory_included: ${pack.memory_included}`)
    console.log(`  external_skills: shared=${pack.external_skills.shared.length}, community=${pack.external_skills.community.length}`)
    return 0
  } catch (err) {
    console.error(`export 失败: ${err instanceof Error ? err.message : String(err)}`)
    return 3
  }
}

function commandImport(args: ParsedArgs): number {
  const [inputFile] = args.positional
  if (!inputFile) {
    console.error('usage: soul-pack-cli import <input-file> [--target <id>] [--force] [--no-memory]')
    return 1
  }
  const inputPath = path.resolve(inputFile)
  if (!fs.existsSync(inputPath)) {
    console.error(`输入文件不存在: ${inputPath}`)
    return 1
  }
  const avatarsRoot = resolveRoot(args)
  fs.mkdirSync(avatarsRoot, { recursive: true })
  try {
    const json = fs.readFileSync(inputPath, 'utf-8')
    const pack = parseSoulPack(json)
    const result = importSoulPack(avatarsRoot, pack, {
      targetAvatarId: args.values.get('target'),
      force: args.flags.has('force'),
      restoreMemory: args.flags.has('no-memory') ? false : undefined,
    })
    console.log(`✓ imported → avatars/${result.avatarId}`)
    console.log(`  files written: ${result.filesWritten.length}`)
    console.log(`  memory restored: ${result.memoryRestored}`)
    if (result.binaryRefsMissing.length > 0) {
      console.log(`  ⚠ binary refs missing (${result.binaryRefsMissing.length}):`)
      for (const ref of result.binaryRefsMissing) {
        console.log(`    - ${ref.path} (sha256=${ref.sha256.slice(0, 16)}…, ${ref.size}B)`)
      }
    }
    if (result.warnings.length > 0) {
      console.log('  warnings:')
      for (const w of result.warnings) console.log(`    · ${w}`)
    }
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/已存在|sha256|schema/.test(msg)) {
      console.error(`import 拒绝: ${msg}`)
      return 2
    }
    console.error(`import 失败: ${msg}`)
    return 3
  }
}

function commandPreview(args: ParsedArgs): number {
  const [inputFile] = args.positional
  if (!inputFile) {
    console.error('usage: soul-pack-cli preview <input-file>')
    return 1
  }
  const inputPath = path.resolve(inputFile)
  try {
    const json = fs.readFileSync(inputPath, 'utf-8')
    const pack = parseSoulPack(json)
    console.log(`Soul Pack preview: ${path.basename(inputPath)}`)
    console.log(`  name:            ${pack.name}`)
    console.log(`  display_name:    ${pack.display_name}`)
    console.log(`  description:     ${pack.description}`)
    console.log(`  domain:          ${pack.domain ?? '(none)'}`)
    console.log(`  created_at:      ${pack.created_at}`)
    console.log(`  created_by:      ${pack.created_by ?? '(none)'}`)
    console.log(`  pack_version:    ${pack.pack_version}`)
    console.log(`  schema_version:  ${pack.schema_version}`)
    console.log(`  files inline:    ${pack.files.length}`)
    console.log(`  binary refs:     ${pack.binary_refs.length}`)
    console.log(`  memory_included: ${pack.memory_included}`)
    console.log(`  shared skills:   ${pack.external_skills.shared.length}${pack.external_skills.shared.length > 0 ? ' (' + pack.external_skills.shared.join(', ') + ')' : ''}`)
    console.log(`  community skills:${pack.external_skills.community.length}${pack.external_skills.community.map(c => '\n    - ' + c.name + '@' + c.ref).join('')}`)
    console.log(`  manifest_sha256: ${pack.manifest_sha256}`)
    return 0
  } catch (err) {
    console.error(`preview 失败: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2))
  const subcommand = args.positional.shift()
  switch (subcommand) {
    case 'export':
      return commandExport(args)
    case 'import':
      return commandImport(args)
    case 'preview':
      return commandPreview(args)
    case 'help':
    case undefined:
      console.log('usage: soul-pack-cli <export|import|preview> [args]')
      console.log('  export <avatar-id> <output-file> [--root <path>] [--include-memory] [--include-life] [--include-wiki]')
      console.log('         [--display-name <name>] [--description <text>] [--domain <tag>] [--created-by <id>]')
      console.log('  import <input-file> [--root <path>] [--target <id>] [--force] [--no-memory]')
      console.log('  preview <input-file>')
      return subcommand === undefined ? 1 : 0
    default:
      console.error(`未知子命令: ${subcommand}`)
      return 1
  }
}

process.exit(main())
