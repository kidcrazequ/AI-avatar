/**
 * 对话框附件白名单与大小常量。
 *
 * 设计原则：
 *   - 与 desktop-app/electron/document-parser.ts 的 SUPPORTED_PARSE_EXTENSIONS 配套：
 *     凡是文档解析器认得的格式（PDF / Word / PPTX / Excel / CSV / TXT / MD），都默认进白名单
 *   - 额外允许常见代码 / 配置文件，让模型可以在对话里"被喂代码"
 *   - 显式拒绝可执行二进制（.exe / .dmg / .app / .so / .dll / .bin）
 *
 * 全项目共享一份白名单，避免渲染进程和主进程出现"前端允许后端拒绝"的不一致。
 *
 * @author zhi.qu
 * @date 2026-05-01
 */

/** 单个附件文件最大字节数（50MB），与 attachment-store.MAX_ATTACHMENT_FILE_BYTES 对齐 */
export const MAX_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024

/** 小文本"直接拼到 user message 正文"的字节阈值（5KB）。超过走 LLM tool-use 按需读取。 */
export const INLINE_TEXT_BYTE_THRESHOLD = 5 * 1024

/** 单条消息最多附件数量（图片 + 文档总和） */
export const MAX_ATTACHMENT_COUNT_PER_MESSAGE = 10

/**
 * 文档类（解析器能抽取文本的）后缀白名单。
 * 与 document-parser.SUPPORTED_PARSE_EXTENSIONS 同步；这里硬编码一份避免渲染进程
 * 因模块边界拿不到主进程常量。
 */
export const ATTACHMENT_DOCUMENT_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.doc',
  '.docx',
  '.pptx',
  '.ppt',
  '.xlsx',
  '.xls',
  '.csv',
] as const

/** 文本类后缀白名单（小文本会直接拼入 user 正文，大文本进 LLM 按需读取） */
export const ATTACHMENT_TEXT_EXTENSIONS: readonly string[] = [
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.log',
] as const

/** 代码类后缀白名单 */
export const ATTACHMENT_CODE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.swift',
  '.kt',
  '.scala',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.r',
  '.lua',
  '.dart',
  '.vue',
  '.svelte',
] as const

/** 显式拒绝的危险/无意义后缀（即使前端 accept 漏过，主进程也再校一次） */
export const ATTACHMENT_REJECTED_EXTENSIONS: readonly string[] = [
  '.exe',
  '.dmg',
  '.app',
  '.so',
  '.dll',
  '.bin',
  '.iso',
  '.msi',
  '.deb',
  '.rpm',
  '.pkg',
  '.dylib',
  '.jar',
  '.apk',
  '.ipa',
] as const

/**
 * 全部允许的非图片附件后缀（合并文档 + 文本 + 代码）。
 * 注意：图片不在这里——图片保留原有 vision 链路独立处理。
 */
export const ATTACHMENT_WHITELIST_EXTENSIONS: readonly string[] = [
  ...ATTACHMENT_DOCUMENT_EXTENSIONS,
  ...ATTACHMENT_TEXT_EXTENSIONS,
  ...ATTACHMENT_CODE_EXTENSIONS,
  '.env', // 单独列出：白名单接受，但渲染进程要弹"包含敏感信息"提示
] as const

/**
 * 提示用户"可能含敏感信息"的后缀集合。
 * 渲染进程在 MessageInput 拿到这些扩展时弹 toast 让用户二次确认。
 */
export const ATTACHMENT_SENSITIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.env',
  '.pem',
  '.key',
])

/**
 * 判断附件后缀是否在白名单内。
 * 输入会被转小写；空字符串 / 未知后缀返回 false。
 */
export function isAttachmentExtensionAllowed(ext: string): boolean {
  if (!ext) return false
  const normalized = ext.toLowerCase()
  if (ATTACHMENT_REJECTED_EXTENSIONS.includes(normalized)) return false
  return ATTACHMENT_WHITELIST_EXTENSIONS.includes(normalized)
}

/**
 * 把白名单转成 `<input accept="...">` 字符串。
 * 包含 `image/*` 让浏览器同时允许图片，与原有 vision 链路兼容。
 */
export function buildAttachmentAcceptString(): string {
  return ['image/*', ...ATTACHMENT_WHITELIST_EXTENSIONS].join(',')
}

/**
 * 文件路由分类（决定走哪条发送链路）：
 *   - image    → 走 vision 链路（image_url content part）
 *   - inline   → 小文本直接拼到 user 正文
 *   - document → 大文档落盘 + 元信息嵌入 + LLM 按需用 read_attachment 工具
 *   - rejected → 黑名单 / 未知后缀
 */
export type AttachmentRoute = 'image' | 'inline' | 'document' | 'rejected'

/**
 * 按 MIME / 后缀 / 大小决定路由。
 * 调用方应已确保 size 是真实字节数（非 base64 长度）。
 */
export function classifyAttachmentRoute(opts: {
  mime: string
  ext: string
  size: number
}): AttachmentRoute {
  const mime = (opts.mime || '').toLowerCase()
  const ext = (opts.ext || '').toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (!isAttachmentExtensionAllowed(ext)) return 'rejected'
  // 文本/代码类 + 小于阈值 → 直接拼到正文
  const isTextLike =
    ATTACHMENT_TEXT_EXTENSIONS.includes(ext) || ATTACHMENT_CODE_EXTENSIONS.includes(ext)
  if (isTextLike && opts.size <= INLINE_TEXT_BYTE_THRESHOLD) return 'inline'
  return 'document'
}
