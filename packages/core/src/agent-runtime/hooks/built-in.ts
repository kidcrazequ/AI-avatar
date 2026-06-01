/**
 * 内置 Hook：把 CLAUDE.md 里的文本约定（"修改前先读"、"3 轮失败停下"、
 * "数据必须可溯源到原始 sheet/条款"）实现为可执行拦截器。
 */

import { HookPoint } from './points'
import type {
  AnyHookPayload,
  HookHandler,
  HookResult,
  PostToolUsePayload,
  PreToolUsePayload,
} from './registry'
import { SOURCE_ANCHOR_REGEX } from '../../source-anchor'

// ── Hook 1: 修改前先读 ─────────────────────────────────────────────────

const EDIT_TOOL_NAMES = new Set(['edit_file', 'write_file', 'apply_patch', 'str_replace'])
const READ_TOOL_NAMES = new Set(['read_knowledge_file', 'read_file'])

/**
 * 跟踪本会话已 read 过的文件路径。
 * 注意：实例化时持有 Set，跨会话不要共享同一个 hook（每个 session 各自构造）。
 */
export function makeReadBeforeEditHook(): { handler: HookHandler; reset: () => void } {
  const readPaths = new Set<string>()

  const handler: HookHandler = async (payload: AnyHookPayload): Promise<HookResult | void> => {
    if (payload.point !== HookPoint.PRE_TOOL_USE && payload.point !== HookPoint.POST_TOOL_USE) {
      return
    }
    const p = payload as PreToolUsePayload | PostToolUsePayload
    const filePath = (p.args?.['file_path'] || p.args?.['path']) as string | undefined

    if (payload.point === HookPoint.POST_TOOL_USE) {
      // read 成功后登记
      const post = p as PostToolUsePayload
      if (READ_TOOL_NAMES.has(post.toolName) && !post.error && filePath) {
        readPaths.add(filePath)
      }
      return
    }

    // PRE_TOOL_USE：写工具前要求已 read
    const pre = p as PreToolUsePayload
    if (!EDIT_TOOL_NAMES.has(pre.toolName)) return
    if (!filePath) return
    if (!readPaths.has(filePath)) {
      return {
        deny: true,
        reason: `read-before-edit: 必须先读取 ${filePath} 再写入（read_knowledge_file 或 read_file）`,
      }
    }
  }

  return { handler, reset: () => readPaths.clear() }
}

// ── Hook 2: 3 轮相同失败熔断 ───────────────────────────────────────────

/**
 * 同一个工具连续失败 N 次（默认 3）后拒绝后续调用，避免死循环。
 * 成功一次即重置计数。
 */
export function makeCircuitBreakerHook(threshold = 3): {
  handler: HookHandler
  reset: () => void
  state: () => Map<string, number>
} {
  const failureCount = new Map<string, number>()

  const handler: HookHandler = async (payload: AnyHookPayload): Promise<HookResult | void> => {
    if (payload.point === HookPoint.POST_TOOL_USE) {
      const post = payload as PostToolUsePayload
      if (post.error) {
        failureCount.set(post.toolName, (failureCount.get(post.toolName) ?? 0) + 1)
      } else {
        failureCount.delete(post.toolName)
      }
      return
    }
    if (payload.point === HookPoint.PRE_TOOL_USE) {
      const pre = payload as PreToolUsePayload
      const count = failureCount.get(pre.toolName) ?? 0
      if (count >= threshold) {
        return {
          deny: true,
          reason: `circuit-breaker: 工具 ${pre.toolName} 已连续失败 ${count} 次，已熔断（请改用其他工具或调整参数）`,
        }
      }
    }
  }

  return {
    handler,
    reset: () => failureCount.clear(),
    state: () => new Map(failureCount),
  }
}

// ── Hook 3: 数据来源锚点强制（软警告） ─────────────────────────────────

/** 默认纳入溯源校验的工具：会返回知识/表格数据、引用前必须可定位到原始来源。 */
export const DEFAULT_TRACEABLE_TOOLS = ['query_excel', 'search_knowledge', 'knowledge_grep'] as const

export interface SourceAnchorWarning {
  readonly toolName: string
  readonly reason: string
  readonly timestamp: number
}

/** 复用 source-anchor 的唯一正本正则，构造无 lastIndex 副作用的探测器。 */
function resultHasSourceAnchor(result: unknown): boolean {
  if (result === null || result === undefined) return false
  let text: string
  if (typeof result === 'string') {
    text = result
  } else {
    try {
      text = JSON.stringify(result)
    } catch {
      return false
    }
  }
  return new RegExp(SOURCE_ANCHOR_REGEX.source).test(text)
}

/**
 * 数据溯源红线的可执行版本（对口 2026-05-22"来源错位"事故）。
 *
 * 当 query_excel / search_knowledge 等取数工具成功返回、但结果里**没有**任何
 * `[来源: ...]` 锚点（query_excel 的 source_anchor 字段、search_knowledge 正文内联锚点
 * 都走 formatSourceAnchor，统一含 `[来源:`）时，记录一条**软警告**。
 *
 * 刻意只软警告、绝不 deny —— 否则 markdown 二手总结会把正常问答卡死；POST_TOOL_USE
 * 阶段 deny 也不会阻断结果回流，硬拦没有意义。警告通过 onWarning 回调 + warnings()
 * 快照暴露给调用方（审计 / 回灌系统提示），与 makeCircuitBreakerHook 的 state() 同构。
 */
export function makeSourceAnchorEnforcementHook(opts?: {
  tools?: Iterable<string>
  onWarning?: (warning: SourceAnchorWarning) => void
}): { handler: HookHandler; reset: () => void; warnings: () => SourceAnchorWarning[] } {
  const tools = new Set<string>(opts?.tools ?? DEFAULT_TRACEABLE_TOOLS)
  const collected: SourceAnchorWarning[] = []

  const handler: HookHandler = async (payload: AnyHookPayload): Promise<HookResult | void> => {
    if (payload.point !== HookPoint.POST_TOOL_USE) return
    const post = payload as PostToolUsePayload
    if (!tools.has(post.toolName)) return
    // 工具自身失败交给 circuit-breaker，不在此叠加来源告警
    if (post.error) return
    if (resultHasSourceAnchor(post.result)) return

    const warning: SourceAnchorWarning = {
      toolName: post.toolName,
      reason: `source-anchor: 工具 ${post.toolName} 的结果未携带可溯源锚点（[来源: ...] / source_anchor）；引用其中数字/结论前必须补全来源（数据溯源红线，对口 2026-05-22 来源错位事故）`,
      timestamp: post.timestamp,
    }
    collected.push(warning)
    opts?.onWarning?.(warning)
    // 软警告：不返回 deny，不阻断结果回流
  }

  return {
    handler,
    reset: () => {
      collected.length = 0
    },
    warnings: () => [...collected],
  }
}
