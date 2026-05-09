/**
 * Snapshot builder for Soul WebDAV sync (#16).
 *
 * 流式打包 zip 归档，包含：
 *  - SQLite 静态快照（通过注入的 runDbBackup 由调用方执行 DatabaseManager.backup()）
 *  - avatars 目录（生产环境为 userData/avatars/，开发环境为仓库 avatars/）
 *  - shared 目录（仓库 shared/，缺失则跳过）
 *  - conversations JSONL（userData/conversations/<id>.jsonl，缺失则跳过）
 *  - manifest.json（每个 entry 的 sha256）
 *
 * 单 zip 上限 500 MB（坚果云单文件限制兜底），超出抛 SnapshotTooLargeError。
 *
 * 设计要点：
 *  - 不直接 import DatabaseManager，避免与 better-sqlite3 native 模块强耦合，
 *    DB 备份通过 runDbBackup 注入；测试 / 离线脚本可以传入 fake 实现。
 *  - 不引入 single 单例 logger，由调用方注入最小 SnapshotLogger 接口；
 *    与 conversation-jsonl-appender.ts 的注入式风格保持一致。
 *  - 解压使用 adm-zip（已在 desktop-app 依赖中、folder-importer.ts 同款），
 *    不引入新依赖；archiver 同步出，adm-zip 同步进，避免双流式异步语义复杂度。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import archiver from 'archiver'
import {
  buildSnapshotManifest,
  parseSnapshotManifest,
  serializeSnapshotManifest,
  type SnapshotManifest,
  type SnapshotManifestEntry,
} from '@soul/core'

/** 默认最大 zip 体积（500 MB）。坚果云免费套餐单文件上限同此值。 */
export const DEFAULT_SNAPSHOT_MAX_BYTES = 500 * 1024 * 1024

/** zip 内白名单路径前缀。所有写入 / 校验都基于这套常量。 */
const ZIP_PATHS = {
  manifest: 'manifest.json',
  dbSnapshot: 'snapshot/xiaodu-snapshot.db',
  avatars: 'snapshot/avatars/',
  shared: 'snapshot/shared/',
  conversations: 'snapshot/conversations/',
} as const

/**
 * 跳过的目录名（递归遍历 avatars / shared 时命中即整目录跳过）。
 *
 * - _cache：chart-cache 等运行期产物，恢复后会自动重建
 * - _index：embedding 索引缓存，恢复后由 reindex 任务重建
 * - .verifier：tool-router 验证器临时文件
 *
 * 注：Excel 中间产物 _excel/ 与 §4.14 决策一致，必须包含，不在此白名单中。
 */
const EXCLUDED_DIR_NAMES = new Set<string>(['_cache', '_index', '.verifier'])

/** 跳过的文件名模式（系统垃圾文件）。 */
const EXCLUDED_FILE_PATTERNS: readonly RegExp[] = [/^\.DS_Store$/, /^Thumbs\.db$/]

/** zip 单条目最大字节数（防 zip slip / zip 炸弹）。 */
const MAX_SINGLE_ENTRY_BYTES = 500 * 1024 * 1024

/** 快照超出体积上限的专用错误类型。 */
export class SnapshotTooLargeError extends Error {
  constructor(public readonly actualBytes: number, public readonly maxBytes: number) {
    super(`snapshot exceeds size limit: ${actualBytes} bytes > ${maxBytes} bytes`)
    this.name = 'SnapshotTooLargeError'
  }
}

/**
 * 最小化的结构化日志接口。
 *
 * 与 conversation-jsonl-appender.ts 的 JsonlAppenderLogger 同款风格，
 * 真实 Logger 用 logEvent('warn'/'info', ...) 适配，单测注入 fake。
 */
export interface SnapshotLogger {
  info(msg: string): void
  warn(msg: string, err?: Error): void
}

/** buildSnapshot 入参。 */
export interface BuildSnapshotOptions {
  /** 输出 zip 完整路径（父目录会被自动创建）。 */
  outputZipPath: string
  /** Avatars 源根目录（userData/avatars/ 或仓库 avatars/）。 */
  avatarsRoot: string
  /** Shared 源根目录（仓库 shared/）。不存在则跳过该子树。 */
  sharedRoot: string
  /** Conversations JSONL 根目录（userData/conversations/）。不存在则跳过。 */
  conversationsRoot: string
  /** 设备 UUID，参与 manifest.deviceId 与文件名生成。 */
  deviceId: string
  /** 可选友好设备名，仅作为 manifest 元数据。 */
  deviceName?: string
  /** Soul app version（由调用方从 package.json 读出注入）。 */
  appVersion: string
  /** SQLite schema version（由调用方从 CURRENT_SCHEMA_VERSION 注入）。 */
  dbSchemaVersion: number
  /**
   * 调用方注入的 DB 备份钩子。底层应调用 DatabaseManager.backup(destPath)，
   * 完成后 destPath 必须是可读的完整 SQLite 静态快照。
   *
   * 之所以注入：本模块属 desktop-app/electron 子模块，但不希望强依赖
   * better-sqlite3 / DatabaseManager 单例，便于测试和未来抽离独立 worker。
   */
  runDbBackup: (destPath: string) => Promise<void>
  /** 可选：自定义最大字节数；缺省取 DEFAULT_SNAPSHOT_MAX_BYTES。 */
  maxBytes?: number
  /** 注入式日志接口；warn 用于非致命异常上报，info 用于关键节点埋点。 */
  logger: SnapshotLogger
}

/** buildSnapshot 返回值。 */
export interface BuildSnapshotResult {
  manifest: SnapshotManifest
  zipPath: string
  zipBytes: number
}

/** extractSnapshot 入参。 */
export interface ExtractSnapshotOptions {
  zipPath: string
  outputDir: string
  logger: SnapshotLogger
}

/** extractSnapshot 返回值。 */
export interface ExtractSnapshotResult {
  manifest: SnapshotManifest
  extractedDir: string
}

/**
 * 主入口：构建 snapshot zip。
 *
 * 流程：
 *   1. 在临时目录创建 SQLite 快照（通过 runDbBackup 注入）
 *   2. 收集 avatars / shared / conversations 下需要打包的文件清单
 *   3. 预检：累计原始大小，超过 maxBytes 立即抛 SnapshotTooLargeError
 *   4. 流式 archiver 写入 zip，逐文件计算 sha256
 *   5. 最后一个 entry 写入 manifest.json
 *   6. 关闭 zip 流，清理临时目录
 *
 * 任何阶段失败都会清理 tempDir；输出 zip 文件在错误时尽力删除。
 */
export async function buildSnapshot(opts: BuildSnapshotOptions): Promise<BuildSnapshotResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES
  const startedAt = Date.now()
  opts.logger.info(
    `[snapshot-builder] build start: output=${opts.outputZipPath} maxBytes=${maxBytes}`,
  )

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soul-snapshot-'))
  const tempDbPath = path.join(tempDir, 'xiaodu-snapshot.db')

  let outputCreated = false
  try {
    // 1) DB 备份（解耦 better-sqlite3）
    await opts.runDbBackup(tempDbPath)
    const dbStat = await fs.promises.stat(tempDbPath)
    opts.logger.info(`[snapshot-builder] db backup done: ${tempDbPath} (${dbStat.size} bytes)`)

    // 2) 收集 entries（DB 快照固定第一条）
    const planned: PlannedEntry[] = []
    planned.push({ absPath: tempDbPath, zipPath: ZIP_PATHS.dbSnapshot, size: dbStat.size })
    await collectDirEntries(opts.avatarsRoot, ZIP_PATHS.avatars, planned, opts.logger)
    await collectDirEntries(opts.sharedRoot, ZIP_PATHS.shared, planned, opts.logger)
    await collectDirEntries(opts.conversationsRoot, ZIP_PATHS.conversations, planned, opts.logger)

    if (planned.length === 1) {
      // 只有 DB 快照，没有 avatars / shared / conversations。允许继续。
      opts.logger.warn(
        '[snapshot-builder] only DB snapshot collected; avatars/shared/conversations were empty or missing',
      )
    }

    // 3) 预检：累计原始大小
    let estimatedTotal = 0
    for (const entry of planned) {
      if (entry.size === 0) {
        // 之前 collectDirEntries 已 stat 过，这里兜底再 stat 一次（防止竞争）
        const stat = await fs.promises.stat(entry.absPath)
        entry.size = stat.size
      }
      estimatedTotal += entry.size
      if (estimatedTotal > maxBytes) {
        throw new SnapshotTooLargeError(estimatedTotal, maxBytes)
      }
    }
    opts.logger.info(
      `[snapshot-builder] planned ${planned.length} entries, raw total=${estimatedTotal}`,
    )

    // 4) 写 zip
    await fs.promises.mkdir(path.dirname(opts.outputZipPath), { recursive: true })
    const output = fs.createWriteStream(opts.outputZipPath)
    outputCreated = true
    const archive = archiver('zip', { zlib: { level: 6 } })

    const finalizePromise = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve())
      output.on('error', reject)
      archive.on('error', reject)
      archive.on('warning', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          opts.logger.warn(
            `[snapshot-builder] archiver ENOENT warning (continuing)`,
            err instanceof Error ? err : new Error(String(err)),
          )
        } else {
          reject(err)
        }
      })
    })

    archive.pipe(output)

    const manifestEntries: SnapshotManifestEntry[] = []
    for (const entry of planned) {
      // 一次性读入内存：单文件最大 500 MB，整体 zip 上限同样 500 MB；
      // 用流式 tee 实现可避免峰值内存，但实现复杂度上升较多，本期先取简化版。
      const buf = await fs.promises.readFile(entry.absPath)
      if (buf.length !== entry.size) {
        // stat 与 read 之间文件被改写——非致命，更新 size 后继续
        opts.logger.warn(
          `[snapshot-builder] file size changed during read: ${entry.absPath} stat=${entry.size} read=${buf.length}`,
        )
        entry.size = buf.length
      }
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
      archive.append(buf, { name: entry.zipPath })
      manifestEntries.push({ path: entry.zipPath, size: buf.length, sha256 })
    }

    // 5) 最后写 manifest.json
    const manifest = buildSnapshotManifest({
      appVersion: opts.appVersion,
      dbSchemaVersion: opts.dbSchemaVersion,
      deviceId: opts.deviceId,
      deviceName: opts.deviceName,
      createdAt: new Date().toISOString(),
      entries: manifestEntries,
    })
    archive.append(serializeSnapshotManifest(manifest), { name: ZIP_PATHS.manifest })

    // 6) Finalize
    await archive.finalize()
    await finalizePromise

    const zipStat = await fs.promises.stat(opts.outputZipPath)
    if (zipStat.size > maxBytes) {
      // 极少见：压缩后反而增大。抛错并删除残缺 zip。
      await fs.promises.unlink(opts.outputZipPath).catch((err: unknown) => {
        opts.logger.warn(
          `[snapshot-builder] failed to remove oversized zip: ${opts.outputZipPath}`,
          err instanceof Error ? err : new Error(String(err)),
        )
      })
      throw new SnapshotTooLargeError(zipStat.size, maxBytes)
    }

    opts.logger.info(
      `[snapshot-builder] build done: zipBytes=${zipStat.size} entries=${manifest.entries.length} elapsedMs=${Date.now() - startedAt}`,
    )
    return { manifest, zipPath: opts.outputZipPath, zipBytes: zipStat.size }
  } catch (err) {
    // 失败兜底：删除半成品 zip
    if (outputCreated) {
      await fs.promises.unlink(opts.outputZipPath).catch((unlinkErr: unknown) => {
        opts.logger.warn(
          `[snapshot-builder] failed to remove partial zip: ${opts.outputZipPath}`,
          unlinkErr instanceof Error ? unlinkErr : new Error(String(unlinkErr)),
        )
      })
    }
    throw err
  } finally {
    // 7) 清理 tempDir
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch((err: unknown) => {
      opts.logger.warn(
        `[snapshot-builder] failed to remove tempDir: ${tempDir}`,
        err instanceof Error ? err : new Error(String(err)),
      )
    })
  }
}

/**
 * 解压 snapshot zip，并校验每个 entry 的 sha256 / size 与 manifest 一致。
 *
 * 校验失败抛 Error；manifest schema 不兼容由 parseSnapshotManifest 抛 TypeError。
 */
export async function extractSnapshot(
  opts: ExtractSnapshotOptions,
): Promise<ExtractSnapshotResult> {
  // 沿用 folder-importer.ts 同款 require 方式：adm-zip 类型对 ESM/CommonJS 互通的支持不完美，
  // 直接 require 可避开 esModuleInterop 边界问题。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AdmZipCtor = require('adm-zip') as { new (zipPath: string): AdmZipInstance }
  const zip = new AdmZipCtor(opts.zipPath)

  const manifestEntry = zip.getEntry(ZIP_PATHS.manifest)
  if (!manifestEntry) {
    throw new Error(`snapshot zip missing manifest.json: ${opts.zipPath}`)
  }
  const manifestRaw = manifestEntry.getData().toString('utf-8')
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(manifestRaw)
  } catch (err) {
    throw new Error(
      `snapshot manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const manifest = parseSnapshotManifest(parsedJson)

  await fs.promises.mkdir(opts.outputDir, { recursive: true })
  const outputRoot = path.resolve(opts.outputDir)

  const expected = new Map<string, SnapshotManifestEntry>()
  for (const e of manifest.entries) expected.set(e.path, e)

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName
    if (name === ZIP_PATHS.manifest) continue

    const exp = expected.get(name)
    if (!exp) {
      // zip 中存在但 manifest 未声明的文件：仅 warn，不写出（避免污染）
      opts.logger.warn(`[snapshot-builder] zip entry not in manifest, skipping: ${name}`)
      continue
    }

    // 防 zip slip：解析后的目标必须仍在 outputDir 下
    const targetPath = path.resolve(outputRoot, name)
    if (
      !targetPath.startsWith(outputRoot + path.sep) &&
      targetPath !== outputRoot
    ) {
      throw new Error(`zip entry escapes output dir: ${name}`)
    }

    const data = entry.getData()
    if (data.length > MAX_SINGLE_ENTRY_BYTES) {
      throw new Error(
        `zip entry exceeds single-entry limit: ${name} (${data.length} > ${MAX_SINGLE_ENTRY_BYTES})`,
      )
    }
    if (data.length !== exp.size) {
      throw new Error(
        `size mismatch for ${name}: zip=${data.length} manifest=${exp.size}`,
      )
    }
    const actualHash = crypto.createHash('sha256').update(data).digest('hex')
    if (actualHash.toLowerCase() !== exp.sha256.toLowerCase()) {
      throw new Error(
        `sha256 mismatch for ${name}: zip=${actualHash} manifest=${exp.sha256}`,
      )
    }

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.promises.writeFile(targetPath, data)
    expected.delete(name)
  }

  if (expected.size > 0) {
    const sample = Array.from(expected.keys()).slice(0, 5).join(', ')
    const tail = expected.size > 5 ? ' ...' : ''
    throw new Error(`snapshot zip missing entries listed in manifest: ${sample}${tail}`)
  }

  opts.logger.info(
    `[snapshot-builder] extract done: ${opts.zipPath} -> ${opts.outputDir} (${manifest.entries.length} entries)`,
  )
  return { manifest, extractedDir: opts.outputDir }
}

// ─── 内部辅助 ─────────────────────────────────────────────────────────────────

/** 打包前累计的待入 zip 文件清单。 */
interface PlannedEntry {
  /** 源文件绝对路径。 */
  absPath: string
  /** 写入 zip 时使用的 POSIX 路径。 */
  zipPath: string
  /** 文件字节大小（可能在 read 时被修正）。 */
  size: number
}

/** adm-zip 单条目的最小化运行期类型（避免 require 后无类型）。 */
interface AdmZipEntry {
  entryName: string
  isDirectory: boolean
  getData(): Buffer
}

/** adm-zip 实例的最小化运行期类型。 */
interface AdmZipInstance {
  getEntry(name: string): AdmZipEntry | null
  getEntries(): AdmZipEntry[]
}

/**
 * 收集指定根目录下所有需要打包的文件，写入 out。
 *
 * - 根目录不存在 / 不是目录：跳过（仅 warn 非 ENOENT 错误）
 * - 跳过 EXCLUDED_DIR_NAMES 命中的整个子目录
 * - 跳过 EXCLUDED_FILE_PATTERNS 命中的单个文件
 * - 跳过符号链接（防御目录环路）
 */
async function collectDirEntries(
  rootAbsPath: string,
  zipPrefix: string,
  out: PlannedEntry[],
  logger: SnapshotLogger,
): Promise<void> {
  let isDir = false
  try {
    const stat = await fs.promises.stat(rootAbsPath)
    isDir = stat.isDirectory()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      logger.warn(
        `[snapshot-builder] stat failed for ${rootAbsPath}`,
        err instanceof Error ? err : new Error(String(err)),
      )
    }
    return
  }
  if (!isDir) return

  await walkDir(rootAbsPath, '', zipPrefix, out, logger)
}

/**
 * 递归遍历目录写入 PlannedEntry。
 *
 * relPath 使用 POSIX 形式（forward slash），用于拼接 zipPath；
 * 实际文件系统访问通过 path.join(rootAbsPath, ...relPath.split('/')) 转回平台分隔符。
 */
async function walkDir(
  rootAbsPath: string,
  relPath: string,
  zipPrefix: string,
  out: PlannedEntry[],
  logger: SnapshotLogger,
): Promise<void> {
  const dirAbs =
    relPath === '' ? rootAbsPath : path.join(rootAbsPath, ...relPath.split('/'))
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dirAbs, { withFileTypes: true })
  } catch (err) {
    logger.warn(
      `[snapshot-builder] readdir failed for ${dirAbs}`,
      err instanceof Error ? err : new Error(String(err)),
    )
    return
  }
  // 排序保证不同设备 / 平台下打包顺序一致（manifest entries 由 build 端再排一次，但稳定输入更利于复现 bug）
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  for (const ent of entries) {
    if (ent.isSymbolicLink()) {
      // 防御性跳过 symlink，避免环路 / 越界
      continue
    }
    const nextRel = relPath === '' ? ent.name : `${relPath}/${ent.name}`
    if (ent.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(ent.name)) continue
      await walkDir(rootAbsPath, nextRel, zipPrefix, out, logger)
    } else if (ent.isFile()) {
      if (EXCLUDED_FILE_PATTERNS.some((re) => re.test(ent.name))) continue
      const absPath = path.join(dirAbs, ent.name)
      try {
        const stat = await fs.promises.stat(absPath)
        out.push({ absPath, zipPath: `${zipPrefix}${nextRel}`, size: stat.size })
      } catch (err) {
        logger.warn(
          `[snapshot-builder] stat failed for ${absPath}`,
          err instanceof Error ? err : new Error(String(err)),
        )
      }
    }
  }
}
