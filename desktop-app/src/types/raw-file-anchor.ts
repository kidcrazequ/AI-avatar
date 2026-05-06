/**
 * 原始源文件溯源（raw-file anchor）契约。
 *
 * 设计目标：
 * - LLM 在回答中始终输出 `[来源: knowledge/<file>.md...]` 自由格式（多文件 / 章节名 /
 *   行号区间 / section= / 无后缀均可）。保持 L8 红线（mustContain 校验）不变。
 * - 渲染层从 anchor 文本里**全局扫描提取**所有 `knowledge/<path>.md` 路径（提取式
 *   而非匹配式，不再追逐 LLM 自由格式），对每个路径独立解析 frontmatter 的
 *   `raw_file` 字段，UI 上把整个 `[来源: ...]` 文本块**替换**为 N 个「📎 文件名.pdf」
 *   按钮组（视觉方案 B）。点击按钮由主进程调 `shell.openPath` 用系统默认应用打开。
 *
 * 关键变更（2026-05-06 重构）：
 * - 删除旧 `ResolveRawFileForAnchorFn`（"单 anchor → 单 result"模型不适合多文件 anchor）
 * - 新增 `ExtractMdPathsFromAnchorFn`：anchor → string[]（提取阶段）
 * - 新增 `ResolveRawFileFn`：(avatarId, mdPath) → ResolveRawFileResult | null（解析阶段）
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
 * 提取阶段：从完整 anchor 文本块里**全局扫描**所有 `knowledge/<path>.md` 路径。
 *
 * 输入：完整 anchor 字符串，例如：
 *   `[来源: knowledge/a.md#L1-L5, knowledge/b.md#第7页]`
 *   `[来源: knowledge/foo.md#2. 设备布局图]`
 *   `[来源: knowledge/bar.md]`
 *
 * 输出：去重后的相对 `<avatar>/knowledge/` 的 .md 路径数组。
 *   - 排除 `_excel/` 前缀（Excel JSON 走另一套链路）
 *   - 没有任何 .md 命中时返回空数组（调用方应保留原文本降级，避免引用消失）
 *
 * 实现要点：用 `String.prototype.matchAll` 全局扫描 `knowledge\/(?!_excel\/)[^,，;；\s\]#]+\.md`，
 * 不依赖 anchor 文本的具体分隔符（逗号 / 分号 / 空格 / `+` / 全角符号都行）。
 *
 * 实现见 `src/services/raw-file-resolver.ts`。
 */
export type ExtractMdPathsFromAnchorFn = (anchor: string) => string[]

/**
 * 解析阶段：单个 .md 路径 → 原始源文件元信息。
 *
 * 输入：avatarId + 单个 mdRelativePath（如 `02_01_01_0221_BMU吸塑盖板.md`）。
 * 行为：
 * 1. 命中本地 LRU 缓存 → 直接返回（含 null 结果也命中）
 * 2. 未命中 → 走 IPC `knowledge:resolve-raw-file`
 * 3. IPC 未注入 / 抛错 → 返回 null（IPC 抛错不写缓存，下次重试）
 *
 * 实现见 `src/services/raw-file-resolver.ts`。
 */
export type ResolveRawFileFn = (
  avatarId: string,
  mdRelativePath: string,
) => Promise<ResolveRawFileResult | null>
