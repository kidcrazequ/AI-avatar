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
 * 内存策略（主进程 V8 堆 ~4GB 硬限，见 oom 记忆）：
 *   - 打包用 archiver **流式写盘**，大分身（几百 MB 扫描件）不会把整包堆进主进程堆。
 *   - 解包用 adm-zip 读入 zip 后**惰性**逐个取 blob（一次一个 getData），交 core importSoulPack
 *     逐个 sha256 校验后落盘。超大包的彻底方案是下沉 worker（与 import-from-file 注释一致）。
 *
 * 安全：解包前 stat 体积上限 + 累加解压后大小防 zip 炸弹；readBlob 只按 manifest 声明的
 * 相对路径取条目（toPosixPath 归一，不接受调用方传 ../），最终落盘路径由 importSoulPack
 * 再做穿越校验（isSafeRelativePath）。
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
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
import { ARCHIVE_MAX_BYTES, ARCHIVE_MAX_INFLATED_BYTES } from './folder-importer'

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
  /** 按 manifest 声明的相对路径惰性取 blob 字节；不存在返回 null（交 importSoulPack 判缺失） */
  readBlob: (relPath: string) => Buffer | null
  /** blobs/ 下实际存在的条目数（可与 pack.binary_refs.length 比对是否缺 blob） */
  blobsPresent: number
  /** 整个 zip 文件字节的 sha256（token 绑定 / TOCTOU 复核用） */
  fileSha256: string
}

/**
 * 读取 .soulpack.zip：校验体积 → 读 pack.json → 提供惰性 readBlob。
 * 不解压到临时目录：blob 由 readBlob 从内存 zip 惰性取，交 importSoulPack 逐个校验后写盘。
 *
 * 失败抛 Error：过大 / 疑似 zip 炸弹 / 缺 pack.json / manifest 校验失败。
 */
export function readSoulPackZip(zipPath: string): ReadSoulPackZipResult {
  const stat = fs.statSync(zipPath)
  if (!stat.isFile()) throw new Error(`分身包路径不是文件: ${zipPath}`)
  if (stat.size > ARCHIVE_MAX_BYTES) {
    throw new Error(`zip 分身包过大 (${stat.size} > ${ARCHIVE_MAX_BYTES})，请拆分后导入`)
  }
  const fileBuf = fs.readFileSync(zipPath)
  const fileSha256 = crypto.createHash('sha256').update(fileBuf).digest('hex')

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(fileBuf)
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
    if (inflated > ARCHIVE_MAX_INFLATED_BYTES) {
      throw new Error(
        `zip 分身包解压后总大小超过 ${ARCHIVE_MAX_INFLATED_BYTES} 字节，疑似 zip 炸弹，已拒绝`,
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
    const entryName = `${SOUL_PACK_BLOB_DIR}/${toPosixPath(relPath)}`
    const e = zip.getEntry(entryName)
    if (!e || e.isDirectory) return null
    return e.getData() as Buffer
  }

  return { pack, readBlob, blobsPresent, fileSha256 }
}
