/**
 * 内置 Hook：把 CLAUDE.md 里的文本约定（"修改前先读"、"3 轮失败停下"）
 * 实现为可执行拦截器。
 */

import { HookPoint } from './points'
import type {
  AnyHookPayload,
  HookHandler,
  HookResult,
  PostToolUsePayload,
  PreToolUsePayload,
} from './registry'

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
