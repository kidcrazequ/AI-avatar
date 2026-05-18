/**
 * Tool Result Lazy Store —— 长工具输出离线挂载机制
 *
 * 灵感来源：Tencent/TencentDB-Agent-Memory 的 symbolic short-term memory（WideSearch 实测 token -61%）。
 * 思路：长工具输出（如 web_fetch 30KB+ HTML→MD）落盘到会话目录 tool-refs/，
 *      prompt 里只留 `body_lazy_ref` 标记 + 元数据；LLM 想看正文调 `read_tool_ref`。
 *
 * v1 范围（保守）：
 *   - 只对 `web_fetch` 启用（其他工具风险高，比如 search_knowledge 的章节如果 lazy 化，
 *     LLM 容易"忘记取回"导致回答缺事实根基）
 *   - 阈值：原始 body 字段 ≥ 4000 字符才落盘
 *   - JSON 结构保留：lazy 只替换 body 字段，url/status/format/char_count 元数据原样在 prompt 可见
 *   - env `SOUL_TOOL_LAZY_RETRIEVAL=on|off`，默认 off
 *
 * 红线：
 *   - 绝对不对 query_excel / search_knowledge / read_knowledge_file 等事实根基类工具启用
 *   - 不调 LLM 摘要——元数据由工具调用上下文机械生成
 *   - 异常自动降级为原文（不抛、不丢内容）
 *
 * @author zhi.qu
 * @date 2026-05-18
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

/** lazy 触发阈值：原始 body 字符数 ≥ 此值才落盘 */
const DEFAULT_LAZY_THRESHOLD = 4000

/** read_tool_ref 单次返回硬上限（避免反向把 lazy 的好处吃掉） */
export const READ_TOOL_REF_HARD_LIMIT = 8000

/** v1 仅启用 lazy 的工具白名单 */
export const DEFAULT_LAZY_TOOLS: ReadonlySet<string> = new Set(['web_fetch'])

export interface LazyStoreConfig {
  enabled: boolean
  thresholdChars: number
  allowedTools: ReadonlySet<string>
}

/** 从 env 构建默认配置（在 ToolRouter 构造时调用一次） */
export function buildDefaultLazyStoreConfig(envValue?: string): LazyStoreConfig {
  // 默认 off——v1 保守，需要用户主动开启
  const enabled = (envValue ?? 'off').toLowerCase() === 'on'
  return {
    enabled,
    thresholdChars: DEFAULT_LAZY_THRESHOLD,
    allowedTools: DEFAULT_LAZY_TOOLS,
  }
}

export interface LazyStoreContext {
  /** 会话 workspace 根目录绝对路径（lazy refs 落到 ${root}/tool-refs/） */
  workspaceRoot: string
  /** 工具名（与 allowedTools 比对） */
  toolName: string
  /** 工具参数（仅用于元数据展示，不参与 callId 生成） */
  toolArgs: Record<string, unknown>
}

export interface LazyStoreResult {
  /** 处理后的 content（可能已 lazy 化，也可能原样透传） */
  content: string
  /** 是否真的落盘了（true = lazy 启用并触发；false = 透传） */
  stored: boolean
  /** 落盘文件的 callId（仅 stored=true 时有效） */
  callId?: string
}

/**
 * 生成新的 callId。基于工具名 + 参数 + 时间 + 随机熵，防同会话内碰撞。
 * 格式：`tool-{12hex}`，正则可校验。
 */
function generateCallId(toolName: string, args: Record<string, unknown>): string {
  const seed = `${toolName}:${JSON.stringify(args)}:${Date.now()}:${Math.random()}`
  const hex = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12)
  return `tool-${hex}`
}

/** 校验 callId 是否符合预期格式（防路径穿越） */
export function isValidCallId(callId: string): boolean {
  return /^tool-[a-f0-9]{12}$/.test(callId)
}

/**
 * 评估并（可能）把工具输出落盘为 lazy ref。
 *
 * 当前仅识别 web_fetch 的 JSON 结构（top-level `body` 字段为长 markdown/text）。
 * 失败时降级为透传原文，永不抛、永不丢内容。
 */
export function maybeStoreLazyRef(
  rawContent: string,
  config: LazyStoreConfig,
  context: LazyStoreContext,
): LazyStoreResult {
  // 短路：未启用 / 工具不在白名单
  if (!config.enabled || !config.allowedTools.has(context.toolName)) {
    return { content: rawContent, stored: false }
  }
  // 短路：内容太短
  if (rawContent.length < config.thresholdChars) {
    return { content: rawContent, stored: false }
  }

  try {
    // v1 仅识别 web_fetch 的 JSON 结构
    if (context.toolName === 'web_fetch') {
      return processWebFetchLazy(rawContent, context, config)
    }
    return { content: rawContent, stored: false }
  } catch (err) {
    console.warn('[tool-result-lazy-store] lazy 失败，降级为原文:', err instanceof Error ? err.message : String(err))
    return { content: rawContent, stored: false }
  }
}

/**
 * web_fetch 专用：解析 JSON、替换 body 字段为 lazy 标记、落盘 body 到文件。
 *
 * web_fetch 返回 JSON 结构（见 tool-router.webFetch）：
 *   { url, status, content_type, format, char_count, truncated, body, hint? }
 *
 * lazy 化后：
 *   { url, status, content_type, format, char_count, truncated, body_lazy_ref: {call_id, char_count, hint} }
 */
function processWebFetchLazy(
  rawContent: string,
  context: LazyStoreContext,
  config: LazyStoreConfig,
): LazyStoreResult {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    // 非 JSON 输出（异常路径），透传
    return { content: rawContent, stored: false }
  }
  const body = parsed.body
  if (typeof body !== 'string' || body.length < config.thresholdChars) {
    return { content: rawContent, stored: false }
  }

  // 写盘到 ${workspaceRoot}/tool-refs/${callId}.md
  const callId = generateCallId(context.toolName, context.toolArgs)
  const refDir = path.join(context.workspaceRoot, 'tool-refs')
  fs.mkdirSync(refDir, { recursive: true })
  const refPath = path.join(refDir, `${callId}.md`)
  fs.writeFileSync(refPath, body, 'utf-8')

  // 元数据：从 args 提 url，落盘标识方便人工审计
  const url = typeof context.toolArgs.url === 'string' ? context.toolArgs.url : '(unknown)'

  // 替换 body 字段为 lazy ref 描述
  const lazy = {
    ...parsed,
    body_lazy_ref: {
      call_id: callId,
      char_count: body.length,
      hint: `正文已离线存储以节省 token。使用 read_tool_ref(call_id="${callId}", offset?, limit?) 取正文，单次最多 ${READ_TOOL_REF_HARD_LIMIT} 字符。`,
      source_url: url,
    },
  }
  // 删原 body 字段（节省 token，避免歧义）
  delete (lazy as Record<string, unknown>).body

  return {
    content: JSON.stringify(lazy, null, 2),
    stored: true,
    callId,
  }
}

/**
 * 读取已落盘的 lazy ref 正文，支持分页。
 *
 * @param workspaceRoot 会话 workspace 根目录
 * @param callId 工具调用 id（必须通过 isValidCallId 校验）
 * @param offset 起始字符位置（默认 0）
 * @param limit 取多少字符（默认 8000，硬上限 READ_TOOL_REF_HARD_LIMIT）
 */
export function readToolRef(
  workspaceRoot: string,
  callId: string,
  offset = 0,
  limit = READ_TOOL_REF_HARD_LIMIT,
): { content: string; total_chars: number; offset: number; limit: number; truncated: boolean } {
  if (!isValidCallId(callId)) {
    throw new Error(`非法 call_id 格式: ${callId}（必须为 tool-{12hex}）`)
  }
  const refPath = path.join(workspaceRoot, 'tool-refs', `${callId}.md`)
  if (!fs.existsSync(refPath)) {
    throw new Error(`lazy ref 文件不存在: ${callId}.md。可能本工具调用未启用 lazy / 会话已切换 / 文件被清。请重新调用原工具获取正文。`)
  }
  const full = fs.readFileSync(refPath, 'utf-8')
  const safeOffset = Math.max(0, Math.floor(offset))
  const safeLimit = Math.min(READ_TOOL_REF_HARD_LIMIT, Math.max(1, Math.floor(limit)))
  const slice = full.slice(safeOffset, safeOffset + safeLimit)
  return {
    content: slice,
    total_chars: full.length,
    offset: safeOffset,
    limit: safeLimit,
    truncated: safeOffset + safeLimit < full.length,
  }
}
