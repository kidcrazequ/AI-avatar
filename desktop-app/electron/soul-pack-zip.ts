/**
 * soul-pack-zip.ts — 自包含 zip 分身包（.soulpack.zip）的打包 / 解包。
 *
 * 布局：
 *   pack.json          serializeSoulPack 输出（manifest：inline 文本 + binary_refs + 元数据）
 *   blobs/<相对路径>    每个 binary_ref 的真实字节（Excel/PDF/图片/扫描件/超大文本）
 *
 * 兼容布局：
 *   <avatarId>/soul.md + AGENTS.md/expert-pack.json + knowledge/skills/...
 *   即用户直接将完整分身目录压缩得到的旧式 zip。
 *
 * 为什么要 zip：.soulpack.json 只内联 ≤256KB 的白名单文本，二进制一律降级为仅 hash 的
 * binary_ref、不携带字节——导出后在别人机器上不可用。zip 把 manifest 和 blobs 装在一起，
 * 实现无损、自包含的跨机分发。
 *
 * 内存 / 阻塞策略（主进程 V8 堆 ~4GB 硬限，见 oom 记忆）：
 *   - 打包用 archiver **流式写盘**，大分身（几百 MB 扫描件）不会把整包堆进主进程堆。
 *   - 解包用 adm-zip（同步读入）读 pack.json + **惰性**逐个取 blob（一次一个 getData），
 *     交 core importSoulPack 逐个 sha256 校验后落盘。为控制交互路径上的同步阻塞：
 *       · 专用体积上限 SOULPACK_ZIP_MAX_BYTES（1GB）比 folder-importer 的后台导入上限更保守；
 *       · **不再对整包重复计算文件字节 sha**——TOCTOU 复核直接用 pack.manifest_sha256
 *         （parseSoulPack 已自校验；blob 另由 core 逐个 sha256 校验），省掉一次 GB 级哈希。
 *     超大包的彻底方案仍是下沉 worker / 流式解包（与 import-from-file 注释一致）。
 *
 * 安全：解包前 stat 体积上限 + 累加解压后大小防 zip 炸弹；readBlob 自带 `..` / 绝对路径拒绝
 * （纵深防御，不依赖调用方 preflight 顺序），最终落盘路径再由 core importSoulPack 的
 * isSafeRelativePath 校验。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  exportSoulPack,
  serializeSoulPack,
  parseSoulPack,
  toPosixPath,
  SOUL_PACK_MANIFEST_FILENAME,
  SOUL_PACK_BLOB_DIR,
  assertSafeSegment,
  resolveUnderRoot,
  type SoulPack,
  type ExportSoulPackOptions,
} from '@soul/core'

/**
 * zip 分身包专用体积上限：比 folder-importer 的 2GB/4GB 更保守——这是「弹窗确认后立即同步
 * 读」的交互路径，不能久卡主进程。超大分身请改用 .soulpack.json 或拆分知识库。
 */
const SOULPACK_ZIP_MAX_BYTES = 1024 * 1024 * 1024 // 1GB（压缩后）
const SOULPACK_ZIP_MAX_INFLATED_BYTES = 2 * 1024 * 1024 * 1024 // 2GB（解压后）

/** 与 core importSoulPack 上限保持一致，避免预览通过、确认导入后才拒绝。 */
const LEGACY_AVATAR_ZIP_MAX_FILES = 10_000

/**
 * 旧式「直接压缩分身目录」会带上的本机运行期 / 派生 / 备份数据。
 * 兼容导入只取当前有效的分身内容，不把旧工作区和知识库备份复制到新机器。
 */
function shouldSkipLegacyAvatarPath(segments: string[]): boolean {
  if (segments.length === 0) return true
  if (segments.some((segment) => segment.startsWith('.') || segment === '_index')) return true
  const top = segments[0]
  return top === 'workspaces' || top.startsWith('knowledge.backup-')
}

interface SoulPackZipEntry {
  entryName: string
  isDirectory: boolean
  header: { size: number }
  getData: () => Buffer
}

/**
 * 归一化 zip entry 并在任何解压 / 读取前拒绝路径穿越。
 * 反斜杠也按路径分隔符处理，防止 Windows 样式 entry 绕过。
 */
function safeZipEntrySegments(entryName: string): string[] {
  const normalized = entryName.replace(/\\/g, '/')
  if (normalized.includes('\0') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`zip 包含非法绝对路径: ${entryName}`)
  }
  const withoutTrailingSlash = normalized.replace(/\/+$/, '')
  if (!withoutTrailingSlash) return []
  const segments = withoutTrailingSlash.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`zip 包含非法路径（可能路径穿越）: ${entryName}`)
  }
  return segments
}

interface LegacyExpertPackMeta {
  name?: string
  description?: string
  domain?: string
  version?: string
  author?: string
}

function readLegacyExpertPackMeta(avatarRoot: string): LegacyExpertPackMeta {
  const metaPath = path.join(avatarRoot, 'expert-pack.json')
  if (!fs.existsSync(metaPath)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
    return {
      name: typeof raw.name === 'string' ? raw.name : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      domain: typeof raw.domain === 'string' ? raw.domain : undefined,
      version: typeof raw.version === 'string' ? raw.version : undefined,
      author: typeof raw.author === 'string' ? raw.author : undefined,
    }
  } catch (err) {
    throw new Error(
      `旧式分身 zip 的 expert-pack.json 无法解析: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

/**
 * 兼容「单一顶层分身目录直接压缩」的旧式 zip。
 *
 * 转换策略：先把通过安全筛选的文件写到临时 avatar 目录，再复用
 * exportSoulPack 生成标准 manifest；导入时的二进制字节仍直接从原 zip entry
 * 惰性读取，交给 core 逐个 sha256 复核。
 */
function readLegacyAvatarZip(
  zipStat: fs.Stats,
  entries: SoulPackZipEntry[],
): ReadSoulPackZipResult {
  const inspected = entries.map((entry) => ({ entry, segments: safeZipEntrySegments(entry.entryName) }))
  const meaningful = inspected.filter(({ segments }) => {
    if (segments.length === 0) return false
    const top = segments[0]
    return top !== '__MACOSX' && !top.startsWith('.')
  })
  if (meaningful.length === 0) {
    throw new Error(`不是有效的 .soulpack.zip：缺 ${SOUL_PACK_MANIFEST_FILENAME}，也未找到分身目录`)
  }

  const topLevelNames = new Set(meaningful.map(({ segments }) => segments[0]))
  if (topLevelNames.size !== 1) {
    throw new Error(
      `旧式分身 zip 必须只有一个顶层分身目录，当前检测到 ${topLevelNames.size} 个: ` +
      [...topLevelNames].slice(0, 5).join(', '),
    )
  }
  const avatarId = [...topLevelNames][0]
  assertSafeSegment(avatarId, '旧式分身目录名')

  const fileEntries = new Map<string, SoulPackZipEntry>()
  for (const { entry, segments } of meaningful) {
    // 顶层目录 entry 本身，不是分身文件。
    const relativeSegments = segments.slice(1)
    if (relativeSegments.length === 0 || entry.isDirectory || shouldSkipLegacyAvatarPath(relativeSegments)) continue
    const relativePath = relativeSegments.join('/')
    if (fileEntries.has(relativePath)) {
      throw new Error(`旧式分身 zip 包含重复路径: ${relativePath}`)
    }
    fileEntries.set(relativePath, entry)
  }

  if (!fileEntries.has('soul.md')) {
    throw new Error(`不是有效的旧式分身 zip：顶层目录 ${avatarId} 缺 soul.md`)
  }
  if (!fileEntries.has('AGENTS.md') && !fileEntries.has('expert-pack.json')) {
    throw new Error(`不是有效的旧式分身 zip：顶层目录 ${avatarId} 缺 AGENTS.md / expert-pack.json`)
  }
  if (fileEntries.size > LEGACY_AVATAR_ZIP_MAX_FILES) {
    throw new Error(
      `旧式分身 zip 有效文件过多 (${fileEntries.size} > ${LEGACY_AVATAR_ZIP_MAX_FILES})，请删除备份或拆分后导入`,
    )
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-legacy-avatar-zip-'))
  const avatarsRoot = path.join(tempRoot, 'avatars')
  const avatarRoot = path.join(avatarsRoot, avatarId)
  try {
    fs.mkdirSync(avatarRoot, { recursive: true })
    for (const [relativePath, entry] of fileEntries) {
      const outputPath = resolveUnderRoot(avatarRoot, relativePath)
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.writeFileSync(outputPath, entry.getData())
    }

    const meta = readLegacyExpertPackMeta(avatarRoot)
    const exported = exportSoulPack(avatarsRoot, avatarId, {
      includeMemory: true,
      includeLife: true,
      includeWiki: true,
      displayName: meta.name,
      description: meta.description,
      domain: meta.domain,
      packVersion: meta.version ?? 'legacy-folder-1.0.0',
      createdBy: meta.author,
    })
    // exportSoulPack 默认使用当前时间。旧式 zip 在 preview / import 会解析两次，
    // 必须换成稳定时间才能用 manifest_sha256 完成 TOCTOU 复核。
    exported.created_at = zipStat.mtime.toISOString()
    const pack = parseSoulPack(serializeSoulPack(exported))
    const readBlob = (relPath: string): Buffer | null => {
      const posixRel = toPosixPath(relPath)
      if (!isBlobRelPathSafe(posixRel)) return null
      return fileEntries.get(posixRel)?.getData() ?? null
    }
    const blobsPresent = pack.binary_refs.reduce(
      (count, ref) => count + (fileEntries.has(toPosixPath(ref.path)) ? 1 : 0),
      0,
    )
    return { pack, readBlob, blobsPresent }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

/**
 * 读文件前 4 字节判 zip 魔数（PK\x03\x04）。.soulpack.zip 可能被改名，扩展名不可靠，
 * 按内容判定最稳。
 */
export function isZipFile(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(4)
    const read = fs.readSync(fd, buf, 0, 4, 0)
    return read === 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
  } finally {
    fs.closeSync(fd)
  }
}

export interface WriteSoulPackZipResult {
  pack: SoulPack
  /** blobs/ 下实际写入的二进制条目数 */
  blobCount: number
  /** 声明了 binary_ref 但源文件缺失、未能写入 zip 的路径 */
  blobsMissing: string[]
  /** 产出 zip 文件字节大小 */
  size: number
}

/**
 * 导出 avatar 为自包含 .soulpack.zip（archiver 流式写盘）。
 *
 * 失败抛 Error：avatar 不存在 / IO 错误。
 */
export async function writeSoulPackZip(
  avatarsPath: string,
  avatarId: string,
  options: ExportSoulPackOptions,
  outPath: string,
): Promise<WriteSoulPackZipResult> {
  assertSafeSegment(avatarId, '分身ID')
  // exportSoulPack 返回不带 manifest_sha256 的对象；serialize 补 sha 后 parse 拿到完整
  // pack（顺带自检 sha256 与 schema）。pack.json 就写这份 json。
  const json = serializeSoulPack(exportSoulPack(avatarsPath, avatarId, options))
  const pack = parseSoulPack(json)
  const avatarRoot = path.join(avatarsPath, avatarId)

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const archiver = require('archiver')
  const blobsMissing: string[] = []
  let blobCount = 0

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outPath)
    const archive = archiver('zip', { zlib: { level: 6 } })
    output.on('close', () => resolve())
    output.on('error', reject)
    archive.on('error', reject)
    archive.on('warning', (err: { code?: string }) => {
      // 单文件缺失（ENOENT）在下方已显式过滤为 blobsMissing，不该走到这；其余 warning 视为错误
      if (err.code === 'ENOENT') return
      reject(err instanceof Error ? err : new Error(String(err)))
    })
    archive.pipe(output)
    archive.append(json, { name: SOUL_PACK_MANIFEST_FILENAME })
    for (const ref of pack.binary_refs) {
      const abs = path.join(avatarRoot, ref.path)
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        archive.file(abs, { name: `${SOUL_PACK_BLOB_DIR}/${toPosixPath(ref.path)}` })
        blobCount++
      } else {
        blobsMissing.push(ref.path)
      }
    }
    archive.finalize().catch(reject)
  })

  return { pack, blobCount, blobsMissing, size: fs.statSync(outPath).size }
}

export interface ReadSoulPackZipResult {
  pack: SoulPack
  /** 按 manifest 声明的相对路径惰性取二进制字节；越界 / 不存在返回 null */
  readBlob: (relPath: string) => Buffer | null
  /** 实际存在的二进制条目数（可与 pack.binary_refs.length 比对是否缺失） */
  blobsPresent: number
}

/** 纵深防御：拒绝 `..` 段 / 绝对（前导 /）路径，不依赖调用方 preflight 顺序 */
function isBlobRelPathSafe(posixRel: string): boolean {
  if (!posixRel || posixRel.startsWith('/')) return false
  return !posixRel.split('/').some((seg) => seg === '..' || seg === '')
}

/**
 * 读取 zip 分身包：校验体积 → 优先读 pack.json；缺失时尝试解析单顶层分身目录。
 * 标准包不解压到临时目录；旧式目录包仅在转 manifest 时使用临时目录并立即清理。
 * 两种格式的二进制文件都由 readBlob 惰性读取，交 importSoulPack 逐个校验后写盘。
 * TOCTOU 复核由调用方用 pack.manifest_sha256 完成（不在此重复整包哈希）。
 *
 * 失败抛 Error：过大 / 疑似 zip 炸弹 / 无效分身目录 / manifest 校验失败。
 */
export function readSoulPackZip(zipPath: string): ReadSoulPackZipResult {
  const stat = fs.statSync(zipPath)
  if (!stat.isFile()) throw new Error(`分身包路径不是文件: ${zipPath}`)
  if (stat.size > SOULPACK_ZIP_MAX_BYTES) {
    throw new Error(`zip 分身包过大 (${stat.size} > ${SOULPACK_ZIP_MAX_BYTES})，请改用 .soulpack.json 或拆分后导入`)
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries() as SoulPackZipEntry[]

  // 防 zip 炸弹：累加解压后大小
  let inflated = 0
  let blobsPresent = 0
  for (const e of entries) {
    const entrySize = Number(e.header.size || 0)
    if (!Number.isSafeInteger(entrySize) || entrySize < 0) {
      throw new Error(`zip entry 解压大小非法: ${e.entryName}`)
    }
    inflated += entrySize
    if (inflated > SOULPACK_ZIP_MAX_INFLATED_BYTES) {
      throw new Error(
        `zip 分身包解压后总大小超过 ${SOULPACK_ZIP_MAX_INFLATED_BYTES} 字节，疑似 zip 炸弹，已拒绝`,
      )
    }
    if (!e.isDirectory && e.entryName.startsWith(`${SOUL_PACK_BLOB_DIR}/`)) blobsPresent++
  }

  const manifestEntry = zip.getEntry(SOUL_PACK_MANIFEST_FILENAME)
  if (!manifestEntry) {
    return readLegacyAvatarZip(stat, entries)
  }
  const json = (manifestEntry.getData() as Buffer).toString('utf-8')
  const pack = parseSoulPack(json)

  const readBlob = (relPath: string): Buffer | null => {
    const posixRel = toPosixPath(relPath)
    if (!isBlobRelPathSafe(posixRel)) return null
    const e = zip.getEntry(`${SOUL_PACK_BLOB_DIR}/${posixRel}`)
    if (!e || e.isDirectory) return null
    return e.getData() as Buffer
  }

  return { pack, readBlob, blobsPresent }
}
