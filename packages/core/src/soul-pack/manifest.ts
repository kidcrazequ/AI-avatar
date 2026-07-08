/**
 * soul-pack manifest schema（v18 Letta .af 借鉴）
 *
 * 让 Soul 分身能用**单 JSON 文件**做可移植打包：
 *   - 跨用户分发（朋友拿到 .soulpack.json 即可加载）
 *   - 版本管理（git diff 直观）
 *   - 备份 / 回滚（一文件 commit / restore）
 *
 * 与 Letta .af 的差异：Letta 的 agent state 都在内存抽象（system prompt + memory blocks），
 * 单 JSON 装得下；Soul 的分身有 knowledge / wiki / skills 实际 markdown 文件，所以：
 *   - 文本类（.md / .yaml / .json）**inline** 进 manifest.files[]
 *   - 二进制（.xlsx / .pdf / .png 等）只列 ref + sha256，不 inline
 *   - 大文件门槛 INLINE_MAX_BYTES：超过的文本也只列 ref（防 JSON 失控膨胀）
 *
 * 记忆默认不打包（含隐私对话历史）；显式 includeMemory=true 才纳入。
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import crypto from 'crypto'

/** schema 版本：破坏性升级时递增；importer 按版本走兼容路径 */
export const SOUL_PACK_SCHEMA_VERSION = 1

/** 单条 inline 文本文件大小上限（字节）；超过转 binary ref，防 manifest 膨胀 */
export const INLINE_MAX_BYTES = 256 * 1024 // 256 KB

/** 允许 inline 的扩展名（文本类） */
export const INLINE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.yaml', '.yml', '.json', '.txt', '.csv', '.html', '.css', '.svg',
])

/**
 * 自包含 zip 分身包（.soulpack.zip）的容器布局常量。
 * zip 里 manifest 走 pack.json（即 serializeSoulPack 的输出），二进制 blob 放 blobs/<相对路径>；
 * import 端逐个按 binary_ref.sha256 校验后写盘，实现无损还原。
 * 供 electron 打包/解包层引用，作为格式单一事实源。
 */
export const SOUL_PACK_MANIFEST_FILENAME = 'pack.json'
export const SOUL_PACK_BLOB_DIR = 'blobs'

/** Inline 文本文件 entry */
export interface SoulPackFile {
  /** 相对 avatar 根目录的 POSIX 路径（导出导入两端统一用 /） */
  path: string
  /** UTF-8 内容 */
  content: string
  /** sha256 hex（基于原 utf-8 字节流） */
  sha256: string
  /** 原文件字节大小 */
  size: number
}

/** 二进制文件 ref（不 inline，仅元数据） */
export interface SoulPackBinaryRef {
  path: string
  sha256: string
  size: number
  /** 提示性 MIME 类型（按后缀推断），import 时仅作 hint */
  mime?: string
}

/** 共享 / 社区技能引用（不打包本体，靠 import 端环境提供） */
export interface SoulPackSkillsRef {
  /** shared/skills/ 通道技能名列表（在 import 端 shared/skills/ 找） */
  shared: string[]
  /** community 通道技能（git 源 + ref + 选装清单），import 端走 soul-sync.sh 拉取 */
  community: Array<{
    /** 包名（对应 shared/skills/community/<name>/） */
    name: string
    /** git 源 URL */
    repo: string
    /** tag / branch / commit */
    ref: string
    /** 选装的具体 skill 名；空 = 全装 */
    skills: string[]
  }>
}

/** 可选打包的记忆数据 */
export interface SoulPackMemory {
  /** memory/MEMORY.md 原文（用户偏好记忆） */
  structuredMemoryMd?: string
  /** memory/USER.md 原文（用户画像） */
  userMd?: string
  /** memory/standing-orders.md 原文（永久规则） */
  standingOrdersMd?: string
  /** episodes/*.json 列表（每条 ConversationEpisode 已 parse） */
  episodes?: unknown[]
  /** daily-summaries/*.md 列表 */
  dailySummaries?: Array<{ date: string; content: string }>
}

/** 完整 soul-pack 数据结构（== JSON 文件结构） */
export interface SoulPack {
  schema_version: number
  /** avatar 目录名（如 "小堵-工商储专家"），import 时作为目标目录 */
  name: string
  /** 人类可读名（与 soul.md 中标题对应） */
  display_name: string
  /** 一句话描述 */
  description: string
  /** 可选领域分类（"energy" / "finance" / "design" 等） */
  domain?: string
  /** ISO 8601 导出时间戳 */
  created_at: string
  /** 导出者标识（可选；不强制） */
  created_by?: string
  /** soul-pack 工具版本（语义版本） */
  pack_version: string
  /** 默认 LLM 配置（从 avatar.config.json 提取） */
  default_llm?: {
    provider?: string
    model?: string
    temperature?: number
  }
  /** 全部 inline 文本文件（按 path 升序，便于 git diff 稳定） */
  files: SoulPackFile[]
  /** 二进制文件 ref（不 inline；import 时提示用户单独拷贝） */
  binary_refs: SoulPackBinaryRef[]
  /** shared / community 外部技能依赖 */
  external_skills: SoulPackSkillsRef
  /** 是否包含记忆数据 */
  memory_included: boolean
  /** 当 memory_included=true 时存在 */
  memory?: SoulPackMemory
  /**
   * 整 pack 校验和：把除 manifest_sha256 字段外所有字段稳定序列化后的 sha256。
   * 防篡改 + 版本管理对比。
   */
  manifest_sha256: string
}

/** 计算字节流 sha256 hex */
export function sha256Hex(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * 算 manifest 自身的稳定 hash：把 pack 对象除 manifest_sha256 字段外 JSON 序列化
 * （sort keys、固定缩进），对结果取 sha256。
 *
 * 用于：
 *   - serializeSoulPack 写出时填 manifest_sha256
 *   - parseSoulPack 读入时校验完整性
 */
export function computeManifestSha256(pack: Omit<SoulPack, 'manifest_sha256'>): string {
  const json = stableStringify(pack)
  return sha256Hex(json)
}

/** 稳定 JSON 序列化：键名按字母序排，对比 / hash 用 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k]
      }
      return sorted
    }
    return val
  })
}

/**
 * 把 pack 序列化为 JSON 文本（带 manifest_sha256 自动填充）。
 * 输出格式：2 空格缩进，便于人读 + git diff。
 */
export function serializeSoulPack(pack: Omit<SoulPack, 'manifest_sha256'>): string {
  const sha = computeManifestSha256(pack)
  const withSha: SoulPack = { ...pack, manifest_sha256: sha }
  return JSON.stringify(withSha, null, 2)
}

/**
 * 从 JSON 文本解析 pack 并校验 sha256 完整性。
 *
 * 解析失败 / schema 不合法 / sha256 不匹配时抛 Error。
 * 调用方应 try/catch。
 */
export function parseSoulPack(json: string): SoulPack {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    throw new Error(`soul-pack JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  validateSoulPackShape(raw)
  const pack = raw as SoulPack

  if (pack.schema_version !== SOUL_PACK_SCHEMA_VERSION) {
    throw new Error(`soul-pack schema 版本不匹配：expected ${SOUL_PACK_SCHEMA_VERSION}，实际 ${pack.schema_version}`)
  }

  // 完整性校验：重算 manifest_sha256 看是否匹配
  const { manifest_sha256, ...rest } = pack
  const recomputed = computeManifestSha256(rest)
  if (recomputed !== manifest_sha256) {
    throw new Error(
      `soul-pack manifest_sha256 校验失败：文件可能被篡改或损坏。expected=${manifest_sha256}, recomputed=${recomputed}`,
    )
  }

  // 每个 file 的 sha256 与 content 校验
  for (const f of pack.files) {
    const recompFile = sha256Hex(f.content)
    if (recompFile !== f.sha256) {
      throw new Error(`soul-pack 文件 ${f.path} sha256 校验失败：content 与 manifest 不一致`)
    }
  }

  return pack
}

/** 抛错式 schema 形状校验（顶层必填字段 + 类型基础检查） */
function validateSoulPackShape(raw: unknown): asserts raw is SoulPack {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('soul-pack 必须是 JSON 对象')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.schema_version !== 'number') throw new Error('soul-pack 缺 schema_version')
  if (typeof obj.name !== 'string' || !obj.name) throw new Error('soul-pack 缺 name')
  if (typeof obj.display_name !== 'string') throw new Error('soul-pack 缺 display_name')
  if (typeof obj.description !== 'string') throw new Error('soul-pack 缺 description')
  if (typeof obj.created_at !== 'string') throw new Error('soul-pack 缺 created_at')
  if (typeof obj.pack_version !== 'string') throw new Error('soul-pack 缺 pack_version')
  if (!Array.isArray(obj.files)) throw new Error('soul-pack files 必须是数组')
  if (!Array.isArray(obj.binary_refs)) throw new Error('soul-pack binary_refs 必须是数组')
  if (typeof obj.external_skills !== 'object' || obj.external_skills === null) {
    throw new Error('soul-pack 缺 external_skills')
  }
  if (typeof obj.memory_included !== 'boolean') throw new Error('soul-pack 缺 memory_included')
  if (typeof obj.manifest_sha256 !== 'string') throw new Error('soul-pack 缺 manifest_sha256')

  // 校验 files 数组元素
  for (const f of obj.files as unknown[]) {
    if (typeof f !== 'object' || f === null) throw new Error('soul-pack file entry 必须是对象')
    const fo = f as Record<string, unknown>
    if (typeof fo.path !== 'string') throw new Error('file 缺 path')
    if (typeof fo.content !== 'string') throw new Error('file 缺 content')
    if (typeof fo.sha256 !== 'string') throw new Error('file 缺 sha256')
    if (typeof fo.size !== 'number') throw new Error('file 缺 size')
  }
}

/** 给文件路径推断 MIME（仅 hint，不严格） */
export function guessMimeByExtension(p: string): string | undefined {
  const ext = p.toLowerCase().slice(p.lastIndexOf('.'))
  const map: Record<string, string> = {
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.zip': 'application/zip',
  }
  return map[ext]
}

/** POSIX 路径化（Windows \ → /），便于跨平台 diff 稳定 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/')
}
