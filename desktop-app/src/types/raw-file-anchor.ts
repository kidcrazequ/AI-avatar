/**
 * 原始源文件溯源（raw-file anchor）契约。
 *
 * 设计目标：
 * - LLM 在回答中始终输出 `[来源: knowledge/<file>.md#L12-L20]` 格式（保持 L8 红线不变）。
 * - 渲染层从该 .md 顶部 frontmatter 的 `raw_file` 字段拿到原始 PDF/Excel/PPT 路径，
 *   在 UI 上额外展示一个「📎 原始文件」chip，点击后由主进程调 `shell.openPath`
 *   用系统默认应用打开。
 *
 * 本文件是渲染层 / preload / 主进程三方共享的契约（channel 名 + 入参/返回类型 +
 * resolver 签名）。任何一方修改都需同步更新另两方。
 *
 * @author zhi.qu
 * @date 2026-05-06
 */

/** 主进程 IPC channel 名常量（preload 与 main 必须使用同一份） */
export const RAW_FILE_IPC_CHANNELS = {
  /** 解析 anchor → 原始文件元信息 */
  RESOLVE: 'knowledge:resolve-raw-file',
  /** 用系统默认应用打开原始文件 */
  OPEN: 'knowledge:open-raw-file',
} as const

/**
 * `knowledge:resolve-raw-file` 入参。
 * - avatarId：分身目录名（如 `小堵-工商储专家`）
 * - mdRelativePath：知识 .md 相对 `<avatar>/knowledge/` 的路径，如
 *   `02_01_01_0221_BMU吸塑盖板.md`，**不带** `knowledge/` 前缀。
 */
export interface ResolveRawFileInput {
  avatarId: string
  mdRelativePath: string
}

/**
 * `knowledge:resolve-raw-file` 返回。
 * - 当 frontmatter 没有 `raw_file` 字段、文件不存在或路径越界时，返回 `null`，
 *   渲染层应优雅降级为只显示原 anchor 文本，不显示「📎 原始文件」按钮。
 */
export interface ResolveRawFileResult {
  /** 相对 `<avatar>/knowledge/` 的原始文件路径，如 `_raw/02.01.01.0221_BMU吸塑盖板.pdf` */
  rawRelPath: string
  /** UI 展示用的文件名（取 basename），如 `02.01.01.0221_BMU吸塑盖板.pdf` */
  displayName: string
  /** 原始文件后缀（小写，不含点），如 `pdf` / `xlsx` / `pptx`；无后缀时为空字符串 */
  ext: string
  /** 原始文件是否实际存在于磁盘上 */
  exists: boolean
}

/**
 * `knowledge:open-raw-file` 入参。
 * - rawRelPath：必须是 `_raw/` 前缀的相对路径，主进程会强制校验，越界（如 `../../`）拒绝。
 */
export interface OpenRawFileInput {
  avatarId: string
  rawRelPath: string
}

/** `knowledge:open-raw-file` 返回 */
export interface OpenRawFileResult {
  ok: boolean
  /** 失败时的错误描述（路径越界、文件不存在、shell.openPath 报错等） */
  error?: string
}

/**
 * 渲染层 anchor → 原始文件解析器签名。
 *
 * 输入是 LLM 输出里的完整 anchor 字符串（如 `[来源: knowledge/xxx.md#L12-L20]`），
 * 函数内部负责：
 * 1. 用 `parseSourceAnchor` 解析出 `.md` 相对路径
 * 2. 命中本地缓存则直接返回，否则走 IPC `knowledge:resolve-raw-file`
 * 3. 不可解析（非 knowledge 类型 / IPC 不可用 / frontmatter 无 raw_file）返回 `null`
 *
 * 实现见 `src/services/raw-file-resolver.ts`。
 */
export type ResolveRawFileForAnchorFn = (
  avatarId: string,
  anchor: string,
) => Promise<ResolveRawFileResult | null>
