/**
 * folder-importer.ts — 文件夹 + 归档批量导入支持。
 *
 * 职责：
 *   - walkFolder(): 递归遍历文件夹，过滤支持的扩展名，返回候选文件路径
 *   - extractArchive(): 按扩展名 dispatch 到 zip / tar.gz / 7z / rar 解压
 *   - 全程硬上限防护：深度 / 文件数 / 总字节 / 单文件大小 / zip 炸弹
 *
 * 所有新增依赖都是纯 JS 或平台二进制（7zip-bin 通过 electron-builder extraResources 打包）：
 *   - adm-zip         zip
 *   - tar + zlib      tar.gz (zlib 是 Node 内置)
 *   - node-7z + 7zip-bin   7z (spawn 平台二进制)
 *   - node-unrar-js   rar (WASM 端口)
 *
 * @author zhi.qu
 * @date 2026-04-13
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { SUPPORTED_PARSE_EXTENSIONS, MAX_PARSE_FILE_BYTES } from './document-parser'

// ─── 硬上限 ─────────────────────────────────────────────────────────────────

/** 单次文件夹遍历最大深度，防止符号链接循环或巨型嵌套 */
export const FOLDER_MAX_DEPTH = 8

/** 单次批量导入最多文件数 */
export const FOLDER_MAX_FILES = 500

/** 单次批量导入总字节数上限（2 GB） */
export const FOLDER_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

/** 单个归档文件大小上限（2 GB） */
export const ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024

/** 归档解压后总大小上限（4 GB），防止 zip 炸弹 */
export const ARCHIVE_MAX_INFLATED_BYTES = 4 * 1024 * 1024 * 1024

/** 跳过模式：这些路径段出现在任意层级都会被整段 skip */
const SKIP_PATTERNS = new Set([
  'node_modules',
  '.git',
  '.DS_Store',
  '__MACOSX',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  'dist',
  'build',
  '.cache',
])

// ─── 类型 ───────────────────────────────────────────────────────────────────

export interface WalkOptions {
  /** 限定扩展名，小写带点；默认 SUPPORTED_PARSE_EXTENSIONS */
  allowedExtensions?: ReadonlySet<string>
  /** 最大深度（默认 FOLDER_MAX_DEPTH） */
  maxDepth?: number
  /** 最大文件数（默认 FOLDER_MAX_FILES） */
  maxFiles?: number
  /** 最大总字节（默认 FOLDER_MAX_TOTAL_BYTES） */
  maxTotalBytes?: number
  /** 单文件最大字节（默认 MAX_PARSE_FILE_BYTES） */
  maxFileBytes?: number
}

export interface WalkResult {
  /** 通过所有过滤的文件绝对路径列表 */
  files: string[]
  /** 被跳过的文件，附原因 */
  skipped: Array<{ path: string; reason: string }>
}

// ─── 文件夹遍历 ─────────────────────────────────────────────────────────────

/**
 * BFS 遍历文件夹，返回支持的文件列表。失败时抛出异常；
 * 单个文件级别的跳过通过 result.skipped 上报，不中断整个遍历。
 */
export async function walkFolder(root: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const allowed = opts.allowedExtensions ?? new Set(SUPPORTED_PARSE_EXTENSIONS)
  const maxDepth = opts.maxDepth ?? FOLDER_MAX_DEPTH
  const maxFiles = opts.maxFiles ?? FOLDER_MAX_FILES
  const maxTotal = opts.maxTotalBytes ?? FOLDER_MAX_TOTAL_BYTES
  const maxFileBytes = opts.maxFileBytes ?? MAX_PARSE_FILE_BYTES

  const stat = await fs.promises.stat(root)
  if (!stat.isDirectory()) {
    throw new Error(`路径不是文件夹: ${root}`)
  }

  const files: string[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  let totalBytes = 0

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!
    if (depth > maxDepth) {
      skipped.push({ path: dir, reason: `depth > ${maxDepth}` })
      continue
    }

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (err) {
      skipped.push({ path: dir, reason: `readdir failed: ${(err as Error).message}` })
      continue
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)

      // 跳过模式（全路径任意段命中都跳过）
      if (SKIP_PATTERNS.has(entry.name) || entry.name.startsWith('.')) {
        skipped.push({ path: full, reason: `skip pattern: ${entry.name}` })
        continue
      }

      if (entry.isDirectory()) {
        queue.push({ dir: full, depth: depth + 1 })
        continue
      }

      if (!entry.isFile()) {
        skipped.push({ path: full, reason: 'not a regular file' })
        continue
      }

      const ext = path.extname(entry.name).toLowerCase()
      if (!allowed.has(ext)) {
        skipped.push({ path: full, reason: `unsupported extension: ${ext || '(none)'}` })
        continue
      }

      let fileSize: number
      try {
        fileSize = (await fs.promises.stat(full)).size
      } catch (err) {
        skipped.push({ path: full, reason: `stat failed: ${(err as Error).message}` })
        continue
      }
      if (fileSize > maxFileBytes) {
        skipped.push({ path: full, reason: `file too large: ${fileSize} > ${maxFileBytes}` })
        continue
      }
      if (totalBytes + fileSize > maxTotal) {
        skipped.push({ path: full, reason: `total bytes cap reached (${maxTotal})` })
        continue
      }

      files.push(full)
      totalBytes += fileSize
      if (files.length >= maxFiles) {
        skipped.push({ path: '(后续略)', reason: `file count cap reached (${maxFiles})` })
        return { files, skipped }
      }
    }
  }

  return { files, skipped }
}

// ─── 归档解压 ───────────────────────────────────────────────────────────────

/**
 * 在系统临时目录创建一个唯一子目录供解压使用。调用方负责在完成后清理。
 */
export async function makeTempExtractDir(): Promise<string> {
  const base = path.join(os.tmpdir(), 'soul-import-' + crypto.randomBytes(6).toString('hex'))
  await fs.promises.mkdir(base, { recursive: true })
  return base
}

/** 清理临时目录，失败静默（不抛异常覆盖业务错误） */
export async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true })
  } catch (err) {
    console.warn('[folder-importer] cleanup temp dir failed:', (err as Error).message)
  }
}

/**
 * 按扩展名 dispatch 到对应解压函数。返回解压后的目录。
 * 调用方应在 finally 块调用 cleanupTempDir() 清理。
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const stat = await fs.promises.stat(archivePath)
  if (!stat.isFile()) {
    throw new Error(`归档路径不是文件: ${archivePath}`)
  }
  if (stat.size > ARCHIVE_MAX_BYTES) {
    throw new Error(`归档文件过大 (${stat.size} > ${ARCHIVE_MAX_BYTES})，请拆分后导入`)
  }

  const lower = archivePath.toLowerCase()
  if (lower.endsWith('.zip')) {
    return extractZip(archivePath, destDir)
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    return extractTarGz(archivePath, destDir)
  }
  if (lower.endsWith('.7z')) {
    return extract7z(archivePath, destDir)
  }
  if (lower.endsWith('.rar')) {
    return extractRar(archivePath, destDir)
  }
  throw new Error(`不支持的归档格式: ${path.basename(archivePath)}`)
}

/**
 * zip 解压 — 使用 adm-zip 同步 API。先扫描 entries 做 zip 炸弹检测，
 * 然后再调用 extractAllTo。
 */
async function extractZip(archivePath: string, destDir: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(archivePath)
  const entries = zip.getEntries() as Array<{ entryName: string; header: { size: number } }>

  // 防 zip 炸弹：累加解压后大小
  let inflated = 0
  for (const entry of entries) {
    inflated += entry.header.size || 0
    if (inflated > ARCHIVE_MAX_INFLATED_BYTES) {
      throw new Error(
        `zip 解压后总大小超过 ${ARCHIVE_MAX_INFLATED_BYTES} 字节，疑似 zip 炸弹，已拒绝`,
      )
    }
    // 防 zip slip：resolve 后的路径必须在 destDir 内
    const resolved = path.resolve(destDir, entry.entryName)
    if (!resolved.startsWith(destDir + path.sep) && resolved !== destDir) {
      throw new Error(`zip 含非法路径条目（路径穿越），已拒绝: ${entry.entryName}`)
    }
  }

  zip.extractAllTo(destDir, /* overwrite */ true)
}

/**
 * tar.gz 解压 — 使用 tar npm 包，流式读取 + 先扫描再解压。
 */
async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tar = require('tar')

  // 先预扫描，累加 size 防炸弹 + 检查路径合法
  let inflated = 0
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(archivePath).pipe(
      tar.t({
        onentry: (entry: { size?: number; path: string }) => {
          inflated += entry.size || 0
          if (inflated > ARCHIVE_MAX_INFLATED_BYTES) {
            stream.destroy(new Error(
              `tar 解压后总大小超过 ${ARCHIVE_MAX_INFLATED_BYTES}，疑似炸弹，已拒绝`,
            ))
            return
          }
          const resolvedTar = path.resolve(destDir, entry.path)
          if (!resolvedTar.startsWith(destDir + path.sep) && resolvedTar !== destDir) {
            stream.destroy(new Error(`tar 含非法路径条目（路径穿越）: ${entry.path}`))
          }
        },
      }),
    )
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })

  // 预扫描通过，正式解压
  await tar.x({
    file: archivePath,
    cwd: destDir,
    preservePaths: false,
    strict: true,
  })
}

/**
 * 7z 解压 — 使用 node-7z + 7zip-bin 提供的平台二进制。
 * 解压成功后扫描解压目录累加文件大小，发现超限就清空并报错。
 */
async function extract7z(archivePath: string, destDir: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SevenZip = require('node-7z')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sevenBin = require('7zip-bin')

  const stream = SevenZip.extractFull(archivePath, destDir, {
    $bin: sevenBin.path7za,
    recursive: true,
  })

  await new Promise<void>((resolve, reject) => {
    stream.on('end', () => resolve())
    stream.on('error', (err: Error) => reject(err))
  })

  // 7z 没法在预解压阶段拿到精确 inflated 大小，退而求其次：解压完后查
  const inflated = await calcDirSize(destDir)
  if (inflated > ARCHIVE_MAX_INFLATED_BYTES) {
    await fs.promises.rm(destDir, { recursive: true, force: true })
    throw new Error(
      `7z 解压后总大小超过 ${ARCHIVE_MAX_INFLATED_BYTES}，已清理，疑似炸弹`,
    )
  }
}

/**
 * rar 解压 — 使用 node-unrar-js WASM 端口。
 */
async function extractRar(archivePath: string, destDir: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const unrar = require('node-unrar-js')
  const data = await fs.promises.readFile(archivePath)
  const extractor = await unrar.createExtractorFromData({
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  })

  const list = extractor.getFileList()
  const headers = Array.from(list.fileHeaders as Iterable<{ name: string; unpSize: number }>)
  let inflated = 0
  for (const h of headers) {
    inflated += h.unpSize || 0
    if (inflated > ARCHIVE_MAX_INFLATED_BYTES) {
      throw new Error(
        `rar 解压后总大小超过 ${ARCHIVE_MAX_INFLATED_BYTES}，疑似炸弹，已拒绝`,
      )
    }
    const resolvedRar = path.resolve(destDir, h.name)
    if (!resolvedRar.startsWith(destDir + path.sep) && resolvedRar !== destDir) {
      throw new Error(`rar 含非法路径条目（路径穿越）: ${h.name}`)
    }
  }

  const extracted = extractor.extract()
  for (const file of Array.from(extracted.files as Iterable<{
    fileHeader: { name: string; flags: { directory: boolean } }
    extraction?: Uint8Array
  }>)) {
    if (file.fileHeader.flags.directory) continue
    if (!file.extraction) continue
    const outPath = path.join(destDir, file.fileHeader.name)
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true })
    await fs.promises.writeFile(outPath, Buffer.from(file.extraction))
  }
}

/** 递归计算目录总字节数（仅用于 7z 后置检查） */
async function calcDirSize(dir: string): Promise<number> {
  let total = 0
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await calcDirSize(full)
    } else if (entry.isFile()) {
      total += (await fs.promises.stat(full)).size
    }
  }
  return total
}
