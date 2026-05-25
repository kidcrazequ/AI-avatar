/**
 * Hook 注册表与触发器。
 *
 * 约束：
 *   - Hook 必须是 async；按注册顺序串行执行
 *   - 任一 Hook 返回 { deny: true } 时立即短路，剩余 Hook 不执行
 *   - Hook 抛异常时不要中断主流程（捕获后转 onError，避免一个坏 Hook 让 agent 卡死）
 *   - 禁止在 Hook 内做同步阻塞 IO（audit 走 fire-and-forget JSONL）
 */

import { HookPoint } from './points'

/** Hook 接收的载荷基类；具体字段由各切入点扩展 */
export interface HookPayload {
  readonly point: HookPoint
  readonly timestamp: number
  /** 上下文 token / 调用 id 等，由调用方注入 */
  readonly meta?: Record<string, unknown>
}

export interface PreToolUsePayload extends HookPayload {
  readonly point: HookPoint.PRE_TOOL_USE
  readonly toolName: string
  readonly args: Record<string, unknown>
}

export interface PostToolUsePayload extends HookPayload {
  readonly point: HookPoint.POST_TOOL_USE
  readonly toolName: string
  readonly args: Record<string, unknown>
  readonly result: unknown
  readonly durationMs: number
  readonly error?: string
}

export interface PreLLMCallPayload extends HookPayload {
  readonly point: HookPoint.PRE_LLM_CALL
  readonly model: string
  readonly messageCount: number
  readonly estimatedTokens?: number
}

export interface PostLLMCallPayload extends HookPayload {
  readonly point: HookPoint.POST_LLM_CALL
  readonly model: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly durationMs: number
}

export interface OnSpawnPayload extends HookPayload {
  readonly point: HookPoint.ON_SPAWN
  readonly parentAgentId: string
  // 与 SubAgentType (governance/spawn-guard.ts) 保持同步；inline 写出避免 hooks 反向依赖 governance
  readonly childAgentType: 'explore' | 'plan' | 'worker' | 'verifier'
  readonly task: string
}

export interface OnErrorPayload extends HookPayload {
  readonly point: HookPoint.ON_ERROR
  readonly source: string
  readonly error: string
  readonly stack?: string
}

export interface OnCompactionPayload extends HookPayload {
  readonly point: HookPoint.ON_COMPACTION
  readonly originalMessageCount: number
  readonly compactedMessageCount: number
  readonly tokensSaved?: number
}

export type AnyHookPayload =
  | HookPayload
  | PreToolUsePayload
  | PostToolUsePayload
  | PreLLMCallPayload
  | PostLLMCallPayload
  | OnSpawnPayload
  | OnErrorPayload
  | OnCompactionPayload

/** Hook 处理结果。返回 deny 可拒绝该次调用；rewriteArgs 可改写工具入参（仅 PRE_TOOL_USE 生效）。 */
export interface HookResult {
  readonly deny?: boolean
  readonly reason?: string
  readonly rewriteArgs?: Record<string, unknown>
}

export type HookHandler = (payload: AnyHookPayload) => Promise<HookResult | void>

interface RegisteredHook {
  readonly id: string
  readonly point: HookPoint
  readonly handler: HookHandler
}

export class HookRegistry {
  private hooks: RegisteredHook[] = []
  /** 失败 Hook 的错误回调（用于把 Hook 内部异常重新发到 ON_ERROR） */
  private onHandlerError?: (err: unknown, ctx: { hookId: string; point: HookPoint }) => void

  register(point: HookPoint, handler: HookHandler, id?: string): string {
    const hookId = id ?? `hook-${Math.random().toString(36).slice(2, 10)}`
    this.hooks.push({ id: hookId, point, handler })
    return hookId
  }

  unregister(hookId: string): boolean {
    const before = this.hooks.length
    this.hooks = this.hooks.filter((h) => h.id !== hookId)
    return this.hooks.length < before
  }

  clear(): void {
    this.hooks = []
  }

  setOnHandlerError(cb: (err: unknown, ctx: { hookId: string; point: HookPoint }) => void): void {
    this.onHandlerError = cb
  }

  /**
   * 触发某个 HookPoint 上的所有 Hook。串行执行，任一返回 deny 立即短路。
   * 多个 Hook 都改写 args 时取**最后一个**的结果（约定：先注册先执行，后者覆盖前者）。
   */
  async fire(payload: AnyHookPayload): Promise<HookResult> {
    const matching = this.hooks.filter((h) => h.point === payload.point)
    let mergedArgs: Record<string, unknown> | undefined
    for (const h of matching) {
      try {
        const r = (await h.handler(payload)) ?? {}
        if (r.deny) {
          return { deny: true, reason: r.reason ?? `denied by hook ${h.id}` }
        }
        if (r.rewriteArgs && payload.point === HookPoint.PRE_TOOL_USE) {
          mergedArgs = r.rewriteArgs
        }
      } catch (err) {
        this.onHandlerError?.(err, { hookId: h.id, point: payload.point })
      }
    }
    return mergedArgs ? { rewriteArgs: mergedArgs } : {}
  }

  list(): Array<{ id: string; point: HookPoint }> {
    return this.hooks.map((h) => ({ id: h.id, point: h.point }))
  }
}
