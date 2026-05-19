/**
 * eval/solvers.ts — 默认 Solver 实现
 *
 * - `makeChatSolver(deps)`：跑真实 Soul 工作流。等价于
 *   batch-regression-runner.runSingleCase 的"单题执行"部分（sendMessage + waitForIdle
 *   + 收集 telemetry），但只产 SolverOutput，不夹带任何断言逻辑
 * - `staticSolver(answers)`：测试用，按 sample.id 查表回放字符串
 *
 * 把"如何调用模型"和"如何打分"完全解耦，便于将来加：
 *   - tool-use evaluator（专门跑 tool 调用次数 / 顺序）
 *   - 多模型对比 solver（同一 sample 在 Claude / GPT / 本地分别跑）
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import {
  regressionTelemetry,
  TelemetryCollector,
  type TelemetryEvent,
  type MessageDoneEvent,
} from '../regression-telemetry'
import type { NormalizedUsage } from '../llm-providers/types'
import type { Sample, Solver, SolverOutput } from './types'

export interface ChatSolverDeps {
  /** 默认绑定的 avatarId（Sample.metadata.avatarId 可覆盖） */
  defaultAvatarId: string
  /** 模型 ID（cost-tracker 计价用；可空） */
  model?: string
  /** 调用聊天的函数指针，签名同 batch-regression-runner */
  sendMessage: (content: string, conversationId: string, avatarId: string) => Promise<void>
  /** 等空闲 */
  waitForIdle: (signal: AbortSignal) => Promise<void>
  /** 单条超时 ms（默认 180_000） */
  perSampleTimeoutMs?: number
  /**
   * 可选 usage 提取器：从 telemetry 事件流推出本次 token 用量。
   * Soul 当前 telemetry 不带 usage（chatStore 没 emit），所以默认拿不到。
   * 等 chatStore 加 'usage' 事件后，传一个解析函数即可让 cost-tracker 自动接上。
   */
  extractUsage?: (events: TelemetryEvent[]) => NormalizedUsage | undefined
  /** conversationId 前缀（默认 'eval-'） */
  conversationIdPrefix?: string
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function abortable<T>(p: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(`${label} aborted`))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error(`${label} aborted`))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

/**
 * 构造一个走真实 Soul 工作流的 Solver。
 *
 * - 每条 sample 用独立 conversationId（防上下文污染）
 * - sample.metadata.setupPrompts? 支持铺垫消息（同 GeneratedQuestion.setupPrompts）
 * - 调用方需在外层 enable / disable regressionTelemetry；本函数只 start/stop Collector
 */
export function makeChatSolver(deps: ChatSolverDeps): Solver<string> {
  const timeoutMs = deps.perSampleTimeoutMs ?? 180_000
  const prefix = deps.conversationIdPrefix ?? 'eval-'

  return async (sample: Sample<string, unknown>, parentSignal?: AbortSignal): Promise<SolverOutput> => {
    const avatarId = (sample.metadata?.avatarId as string | undefined) ?? deps.defaultAvatarId
    const setupPrompts = sample.metadata?.setupPrompts as string[] | undefined
    const conversationId = `${prefix}${sample.id}`
    const localController = new AbortController()
    const onParentAbort = (): void => localController.abort()
    parentSignal?.addEventListener('abort', onParentAbort, { once: true })

    let error: string | undefined

    if (setupPrompts && setupPrompts.length > 0) {
      try {
        for (let i = 0; i < setupPrompts.length; i++) {
          await withTimeout(
            (async () => {
              await deps.sendMessage(setupPrompts[i], conversationId, avatarId)
              await abortable(deps.waitForIdle(localController.signal), localController.signal, 'waitForIdle')
            })(),
            timeoutMs,
            `sample[${sample.id}].setup[${i}]`,
          )
        }
      } catch (e) {
        error = `setup-failed: ${e instanceof Error ? e.message : String(e)}`
        localController.abort()
      }
    }

    const collector = new TelemetryCollector(conversationId)
    collector.start()
    const startedAt = Date.now()

    if (!error) {
      try {
        await withTimeout(
          (async () => {
            await deps.sendMessage(sample.input, conversationId, avatarId)
            await abortable(deps.waitForIdle(localController.signal), localController.signal, 'waitForIdle')
          })(),
          timeoutMs,
          `sample[${sample.id}]`,
        )
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
        localController.abort()
      }
    }
    parentSignal?.removeEventListener('abort', onParentAbort)

    const events = collector.stop()
    const finishedAt = Date.now()

    const errEvent = events.find(e => e.type === 'conversation-error')
    if (errEvent && !error) error = (errEvent as { error: string }).error

    const msgDone = events.find((e): e is MessageDoneEvent => e.type === 'message-done')
    const text = (msgDone?.content ?? '').slice(0, 4096)
    const usage = deps.extractUsage?.(events)

    return {
      text,
      usage,
      model: deps.model,
      toolEvents: events,
      durationMs: finishedAt - startedAt,
      error,
    }
  }
}

/**
 * 测试用 Solver：按 sample.id 查表返回固定 text，不调用任何 LLM。
 *
 * - answers 为 Map<sampleId, text>
 * - 未命中的 sample 视为 error='no-stub'
 * - toolEvents 永远为空数组，duration=0
 */
export function staticSolver(
  answers: Map<string, string> | Record<string, string>,
  opts: { model?: string; usage?: NormalizedUsage } = {},
): Solver<string> {
  const lookup = answers instanceof Map ? answers : new Map(Object.entries(answers))
  return async (sample): Promise<SolverOutput> => {
    const text = lookup.get(sample.id)
    if (text === undefined) {
      return {
        text: '',
        toolEvents: [],
        durationMs: 0,
        error: `staticSolver: no stub for sample.id=${sample.id}`,
        model: opts.model,
      }
    }
    return {
      text,
      usage: opts.usage,
      model: opts.model,
      toolEvents: [],
      durationMs: 0,
    }
  }
}

/** 让 regressionTelemetry 在批跑期间保持 enabled 的工具方法 */
export function withRegressionTelemetry<T>(fn: () => Promise<T>): Promise<T> {
  regressionTelemetry.enable()
  return fn().finally(() => regressionTelemetry.disable())
}
