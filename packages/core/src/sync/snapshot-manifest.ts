/**
 * Snapshot manifest schema and pure helpers for Soul WebDAV sync (#16).
 *
 * Pure functions only — no fs, no network, no archiver. Runs in node and browser subentry.
 * Used by snapshot-builder (write) and sync-manager (read on restore).
 *
 * 设计要点：
 *  - 所有解析路径走 unknown + 类型守卫，禁止信任外部 JSON 的字段类型
 *  - serialize 强制按 path 升序排序 entries，保证不同打包顺序下 manifest 文本稳定
 *    （便于上层做 manifest 自身 sha 比对判断 zip 是否被篡改）
 *  - 备份文件名采用 UTC 时间戳，避免跨时区设备生成同名文件造成同步冲突
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

/** 当前 manifest schema 版本号，未来不兼容升级时递增。 */
export const SNAPSHOT_MANIFEST_VERSION = 1

/** zip 内单个文件在 manifest 中的描述。 */
export interface SnapshotManifestEntry {
  /** Path inside the zip, forward-slash separated (POSIX style). */
  path: string
  /** Byte size of the file. */
  size: number
  /** SHA-256 hex of the file contents. */
  sha256: string
}

/** 完整 snapshot manifest 数据结构（写入 zip 内 manifest.json）。 */
export interface SnapshotManifest {
  schemaVersion: typeof SNAPSHOT_MANIFEST_VERSION
  /** Soul app version (read from package.json by snapshot-builder). */
  appVersion: string
  /** SQLite schema version embedded in the snapshot at build time. */
  dbSchemaVersion: number
  /** UUID identifying the device that produced the snapshot. */
  deviceId: string
  /** Optional human-friendly device name. */
  deviceName?: string
  /** ISO-8601 UTC timestamp when the manifest was finalized. */
  createdAt: string
  /** Total uncompressed size in bytes (sum of entries). */
  totalBytes: number
  /** Per-file manifest, sorted by path ascending. */
  entries: SnapshotManifestEntry[]
}

/** buildSnapshotManifest 入参（不含 schemaVersion / totalBytes，由本函数计算）。 */
export interface BuildSnapshotManifestInput {
  appVersion: string
  dbSchemaVersion: number
  deviceId: string
  deviceName?: string
  createdAt: string
  entries: SnapshotManifestEntry[]
}

/**
 * 由 entries + 元数据构造 SnapshotManifest。
 *
 * - 自动填入 schemaVersion 与 totalBytes
 * - 自动按 path 升序排序 entries（保证序列化结果稳定）
 *
 * @throws Error 当 entries 为空时
 */
export function buildSnapshotManifest(input: BuildSnapshotManifestInput): SnapshotManifest {
  if (!input.entries || input.entries.length === 0) {
    throw new Error('snapshot manifest must include at least one entry')
  }
  const sorted = [...input.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const manifest: SnapshotManifest = {
    schemaVersion: SNAPSHOT_MANIFEST_VERSION,
    appVersion: input.appVersion,
    dbSchemaVersion: input.dbSchemaVersion,
    deviceId: input.deviceId,
    createdAt: input.createdAt,
    totalBytes: computeTotalBytes(sorted),
    entries: sorted,
  }
  if (typeof input.deviceName === 'string' && input.deviceName.length > 0) {
    manifest.deviceName = input.deviceName
  }
  return manifest
}

/** 累加 entries 的 size 字段为 totalBytes（纯函数）。 */
export function computeTotalBytes(entries: SnapshotManifestEntry[]): number {
  let total = 0
  for (const e of entries) {
    total += e.size
  }
  return total
}

/** 内部：判断值是否为非空对象（非数组）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 内部：校验单个 manifest entry 结构。 */
function isManifestEntry(v: unknown): v is SnapshotManifestEntry {
  if (!isPlainObject(v)) return false
  const path = v.path
  const size = v.size
  const sha256 = v.sha256
  if (typeof path !== 'string' || path.length === 0) return false
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return false
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) return false
  return true
}

/**
 * 解析并校验外部 JSON 形式的 manifest，返回严格类型化的 SnapshotManifest。
 *
 * @throws TypeError 当结构不合法或 schemaVersion 不兼容时
 */
export function parseSnapshotManifest(raw: unknown): SnapshotManifest {
  if (!isPlainObject(raw)) {
    throw new TypeError('snapshot manifest must be an object')
  }
  if (raw.schemaVersion !== SNAPSHOT_MANIFEST_VERSION) {
    throw new TypeError('incompatible snapshot schema version: ' + String(raw.schemaVersion))
  }
  if (typeof raw.appVersion !== 'string') {
    throw new TypeError('snapshot manifest.appVersion must be string')
  }
  if (
    typeof raw.dbSchemaVersion !== 'number' ||
    !Number.isInteger(raw.dbSchemaVersion) ||
    raw.dbSchemaVersion < 0
  ) {
    throw new TypeError('snapshot manifest.dbSchemaVersion must be a non-negative integer')
  }
  if (typeof raw.deviceId !== 'string' || raw.deviceId.length === 0) {
    throw new TypeError('snapshot manifest.deviceId must be a non-empty string')
  }
  if (raw.deviceName !== undefined && typeof raw.deviceName !== 'string') {
    throw new TypeError('snapshot manifest.deviceName must be string when present')
  }
  if (typeof raw.createdAt !== 'string' || raw.createdAt.length === 0) {
    throw new TypeError('snapshot manifest.createdAt must be a non-empty ISO-8601 string')
  }
  if (
    typeof raw.totalBytes !== 'number' ||
    !Number.isFinite(raw.totalBytes) ||
    raw.totalBytes < 0
  ) {
    throw new TypeError('snapshot manifest.totalBytes must be a non-negative number')
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    throw new TypeError('snapshot manifest.entries must be a non-empty array')
  }
  const entries: SnapshotManifestEntry[] = []
  for (let i = 0; i < raw.entries.length; i++) {
    const item = raw.entries[i]
    if (!isManifestEntry(item)) {
      throw new TypeError(`snapshot manifest.entries[${i}] is invalid`)
    }
    entries.push({ path: item.path, size: item.size, sha256: item.sha256 })
  }
  const result: SnapshotManifest = {
    schemaVersion: SNAPSHOT_MANIFEST_VERSION,
    appVersion: raw.appVersion,
    dbSchemaVersion: raw.dbSchemaVersion,
    deviceId: raw.deviceId,
    createdAt: raw.createdAt,
    totalBytes: raw.totalBytes,
    entries,
  }
  if (typeof raw.deviceName === 'string' && raw.deviceName.length > 0) {
    result.deviceName = raw.deviceName
  }
  return result
}

/**
 * 序列化 manifest 为规范化 JSON（2 空格缩进，entries 按 path 升序）。
 *
 * 同一份 manifest 在任意打包顺序下生成的字符串字节级一致，便于做完整性比对。
 */
export function serializeSnapshotManifest(m: SnapshotManifest): string {
  const sortedEntries = [...m.entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
  const ordered: SnapshotManifest = {
    schemaVersion: m.schemaVersion,
    appVersion: m.appVersion,
    dbSchemaVersion: m.dbSchemaVersion,
    deviceId: m.deviceId,
    createdAt: m.createdAt,
    totalBytes: m.totalBytes,
    entries: sortedEntries,
  }
  if (typeof m.deviceName === 'string' && m.deviceName.length > 0) {
    ordered.deviceName = m.deviceName
  }
  return JSON.stringify(ordered, null, 2)
}

/**
 * 生成备份文件名：soul-backup-<deviceId>-<YYYY-MM-DD-HH-mm-ss>.zip
 *
 * 时间戳采用 UTC，避免跨时区设备生成同名文件。
 *
 * @throws Error 当 deviceId 为空时
 */
export function generateBackupFilename(deviceId: string, date: Date): string {
  if (!deviceId || deviceId.length === 0) {
    throw new Error('deviceId is required for backup filename')
  }
  if (Number.isNaN(date.getTime())) {
    throw new Error('date is invalid for backup filename')
  }
  const iso = date.toISOString()
  const ts = iso.slice(0, 19).replace('T', '-').replace(/:/g, '-')
  return `soul-backup-${deviceId}-${ts}.zip`
}

/** 解析备份文件名，无效返回 null。deviceId 可包含连字符（贪婪匹配再回溯到末尾时间戳）。 */
const BACKUP_FILENAME_RE = /^soul-backup-(.+)-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.zip$/

/**
 * 反向解析 generateBackupFilename 产物：返回 { deviceId, timestamp }，或 null 表示格式不匹配。
 *
 * 时间戳按 UTC 解析（与生成端一致）。
 */
export function parseBackupFilename(filename: string): { deviceId: string; timestamp: Date } | null {
  const match = BACKUP_FILENAME_RE.exec(filename)
  if (!match) return null
  const deviceId = match[1]
  const ts = match[2]
  // ts 形如 "YYYY-MM-DD-HH-mm-ss"（UTC）。还原为 ISO："YYYY-MM-DDTHH:mm:ssZ"。
  const datePart = ts.slice(0, 10)
  const timePart = ts.slice(11).replace(/-/g, ':')
  const isoStr = `${datePart}T${timePart}Z`
  const d = new Date(isoStr)
  if (Number.isNaN(d.getTime())) return null
  return { deviceId, timestamp: d }
}
