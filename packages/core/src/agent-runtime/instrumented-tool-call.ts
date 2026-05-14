/**
 * 工具调用 wrapper：把 Hook 总线 + AuditTrail 嵌入到 tool 执行前后。
 *
 * 旧路径（tool-router 直接 execute）保持不变；新路径走本 wrapper，
 * 由 feature flag SOUL_USE_NEW_RUNTIME 控制。
 *
 * 使用：
 *   const result = await runInstrumentedToolCall({
 *     toolName,
 *     args,
 *     execute: () => toolRouter.executeXxx(args),
 *     hooks,
 *     audit,
 *     meta: { agentId, sessionId }
 *   })
 */

import { HookPoint } from './hooks/points'
import type { HookRegistry, PreToolUsePayload, PostToolUsePayload } from './hooks/registry'
import type { AuditTrail } from './audit-trail'

export interface InstrumentedToolCallOptions<TResult> {
  toolName: string
  args: Record<string, unknown>
  /** 真正的工具实现；接受（可能被 hook 改写过的）参数 */
  execute: (args: Record<string, unknown>) => Promise<TResult>
  hooks?: HookRegistry
  audit?: AuditTrail
  meta?: { agentId?: string; sessionId?: string }
}

export interface InstrumentedToolCallResult<TResult> {
  ok: boolean
  result?: TResult
  error?: string
  /** Hook 拒绝时为 true */
  denied?: boolean
  denyReason?: string
  durationMs: number
}

export async function runInstrumentedToolCall<TResult>(
  opts: InstrumentedToolCallOptions<TResult>
): Promise<InstrumentedToolCallResult<TResult>> {
  const start = Date.now()
  const { toolName, hooks, audit, meta } = opts
  let args = opts.args

  // PRE_TOOL_USE
  if (hooks) {
    const prePayload: PreToolUsePayload = {
      point: HookPoint.PRE_TOOL_USE,
      timestamp: Date.now(),
      toolName,
      args,
      meta,
    }
    const pre = await hooks.fire(prePayload)
    if (pre.deny) {
      audit?.record({
        point: HookPoint.PRE_TOOL_USE,
        agentId: meta?.agentId,
        sessionId: meta?.sessionId,
        payload: { toolName, args, denied: true, reason: pre.reason },
      })
      return {
        ok: false,
        denied: true,
        denyReason: pre.reason,
        durationMs: Date.now() - start,
      }
    }
    if (pre.rewriteArgs) args = pre.rewriteArgs
  }

  // 执行
  let result: TResult | undefined
  let error: string | undefined
  try {
    result = await opts.execute(args)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const durationMs = Date.now() - start

  // POST_TOOL_USE
  if (hooks) {
    const postPayload: PostToolUsePayload = {
      point: HookPoint.POST_TOOL_USE,
      timestamp: Date.now(),
      toolName,
      args,
      result,
      durationMs,
      error,
      meta,
    }
    await hooks.fire(postPayload)
  }

  audit?.record({
    point: HookPoint.POST_TOOL_USE,
    agentId: meta?.agentId,
    sessionId: meta?.sessionId,
    payload: { toolName, args, durationMs, error, ok: !error },
  })

  if (error) {
    return { ok: false, error, durationMs }
  }
  return { ok: true, result, durationMs }
}
