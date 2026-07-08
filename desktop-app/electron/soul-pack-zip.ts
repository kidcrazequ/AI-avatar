/**
 * soul-pack-zip.ts — 自包含 zip 分身包（.soulpack.zip）的打包 / 解包。
 *
 * 布局：
 *   pack.json          serializeSoulPack 输出（manifest：inline 文本 + binary_refs + 元数据）
 *   blobs/<相对路径>    每个 binary_ref 的真实字节（Excel/PDF/图片/扫描件/超大文本）
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
import path from 'path'
import {
  exportSoulPack,
  serializeSoulPack,
  parseSoulPack,
  toPosixPath,
  SOUL_PACK_MANIFEST_FILENAME,
  SOUL_PACK_BLOB_DIR,
  assertSafeSegment,
  type SoulPack,
  type ExportSoulPackOptions,
} from '@soul/core'

/**
 * zip 分身包专用体积上限：比 folder-importer 的 2GB/4GB 更保守——这是「弹窗确认后立即同步
 * 读」的交互路径，不能久卡主进程。超大分身请改用 .soulpack.json 或拆分知识库。
 */
const SOULPACK_ZIP_MAX_BYTES = 1024 * 1024 * 1024 // 1GB（压缩后）
const SOULPACK_ZIP_MAX_INFLATED_BYTES = 2 * 1024 * 1024 * 1024 // 2GB（解压后）

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
  /** 按 manifest 声明的相对路径惰性取 blob 字节；越界 / 不存在返回 null（交 importSoulPack 判缺失） */
  readBlob: (relPath: string) => Buffer | null
  /** blobs/ 下实际存在的条目数（可与 pack.binary_refs.length 比对是否缺 blob） */
  blobsPresent: number
}

/** 纵深防御：拒绝 `..` 段 / 绝对（前导 /）路径，不依赖调用方 preflight 顺序 */
function isBlobRelPathSafe(posixRel: string): boolean {
  if (!posixRel || posixRel.startsWith('/')) return false
  return !posixRel.split('/').some((seg) => seg === '..' || seg === '')
}

/**
 * 读取 .soulpack.zip：校验体积 → 读 pack.json → 提供惰性 readBlob。
 * 不解压到临时目录：blob 由 readBlob 从内存 zip 惰性取，交 importSoulPack 逐个校验后写盘。
 * TOCTOU 复核由调用方用 pack.manifest_sha256 完成（不在此重复整包哈希）。
 *
 * 失败抛 Error：过大 / 疑似 zip 炸弹 / 缺 pack.json / manifest 校验失败。
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
  const entries = zip.getEntries() as Array<{
    entryName: string
    isDirectory: boolean
    header: { size: number }
  }>

  // 防 zip 炸弹：累加解压后大小
  let inflated = 0
  let blobsPresent = 0
  for (const e of entries) {
    inflated += e.header.size || 0
    if (inflated > SOULPACK_ZIP_MAX_INFLATED_BYTES) {
      throw new Error(
        `zip 分身包解压后总大小超过 ${SOULPACK_ZIP_MAX_INFLATED_BYTES} 字节，疑似 zip 炸弹，已拒绝`,
      )
    }
    if (!e.isDirectory && e.entryName.startsWith(`${SOUL_PACK_BLOB_DIR}/`)) blobsPresent++
  }

  const manifestEntry = zip.getEntry(SOUL_PACK_MANIFEST_FILENAME)
  if (!manifestEntry) {
    throw new Error(`不是有效的 .soulpack.zip：缺 ${SOUL_PACK_MANIFEST_FILENAME}`)
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
