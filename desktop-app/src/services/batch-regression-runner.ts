/**
 * batch-regression-runner.ts — 批量回归运行器
 *
 * 职责：
 *   - 加载题库（GeneratedQuestion[]）
 *   - 逐题创建独立 conversationId，调用 sendMessage 走真实工作流
 *   - 用 TelemetryCollector 抓本题工具/任务/消息事件
 *   - 用规则断言判定 pass/fail（5 类断言）
 *   - 累加成 BatchRunResult，每题完成回调进度
 *
 * 设计原则：
 *   - 不直接 import chatStore（避免 Zustand 实例耦合 + 便于测试）
 *     → 通过 sendMessage / waitForIdle 函数指针注入
 *   - 单题失败不中断整体（异常被捕获记入 case）
 *   - AbortSignal 支持运行中途取消
 *   - conversationId 命名带 'regression-' 前缀，便于侧边栏过滤
 *
 * 不依赖 Electron / DOM，可纯 Node 跑单测。
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import {
  regressionTelemetry,
  TelemetryCollector,
  type TelemetryEvent,
  type ToolCallEndEvent,
  type ToolCallStartEvent,
  type MessageDoneEvent,
} from './regression-telemetry'

// ─── 题库类型重声明（避免引入 Electron 主进程模块） ───────────────────

export type QuestionCategory =
  | 'L1_excel_fact'
  | 'L2_excel_compare'
  | 'L3_excel_aggregate'
  | 'L4_chart'
  | 'L5_bom'
  | 'L6_protocol'
  | 'L7_certification'
  | 'L8_traceability'
  | 'L9_redline'
  | 'L10_personality'

export interface ExpectedValue {
  value: number
  unit?: string
  tolerancePct: number
}

/**
 * expectedTools 项：
 *   - string                     → 该工具必须被调用（AND 项）
 *   - string[]（嵌套数组）       → 内层语义为 OR：任一工具被调用即视为命中（用于 query_excel | search_knowledge 这类等价路径）
 *
 * 例：[["query_excel", "search_knowledge"], "load_skill"]
 *   → load_skill 必须命中，且 (query_excel ∨ search_knowledge) 命中。
 */
export type ExpectedToolItem = string | string[]

export interface GeneratedQuestion {
  id: string
  category: QuestionCategory
  prompt: string
  expectedTools?: ExpectedToolItem[]
  expectedSkills?: string[]
  expectedValue?: ExpectedValue
  mustContain?: string[]
  mustNotContain?: string[]
  sourceFile?: string
  sourceSection?: string
  /**
   * 前置铺垫消息（用于 L8_traceability 等需要"上一轮回答"上下文的题目）。
   * - 在收集器启动 *之前*，按顺序在同一 conversationId 下发送这些 prompt 并等待 idle
   * - 这些消息触发的工具调用 / message-done 事件**不会**进入 assertions
   * - 仅 question.prompt 这一条消息的回答会被作为本题答案
   * 设计目的：避免把铺垫题也算成一条独立 case，又能给溯源题真实的上下文。
   */
  setupPrompts?: string[]
}

/** 本次运行使用的题库来源快照（完整题库 JSON 由主进程单独落盘） */
export interface QuestionBankRunSource {
  sourcePath: string
  cached: boolean
  loadedAt: number
  generatedAt?: string
  totalQuestionCount: number
  selectedQuestionCount: number
}

// ─── 断言层 ────────────────────────────────────────────────────────────

export interface AssertionResult {
  /** 断言名（expectedTools / expectedSkills / expectedValue / mustContain / mustNotContain） */
  name: string
  pass: boolean
  /** 失败原因（pass=false 时填） */
  reason?: string
}

/**
 * 校验所有 expectedTools 都被调用过且至少一次成功。
 * - 平铺项 string         → 该工具必须命中且至少一次 ok=true（AND）
 * - 嵌套项 string[]       → 内层 OR：任一工具命中且至少一次 ok=true 即可
 *
 * 任一项不满足 → fail
 *
 * @author zhi.qu
 * @date 2026-05-02
 */
export function assertExpectedTools(events: TelemetryEvent[], expected: ExpectedToolItem[] | undefined): AssertionResult {
  if (!expected || expected.length === 0) return { name: 'expectedTools', pass: true }
  const calls = events.filter((e): e is ToolCallEndEvent => e.type === 'tool-call-end')

  /** 单个工具是否"命中且至少一次成功" */
  const isToolSatisfied = (tool: string): { hit: boolean; ok: boolean } => {
    const callsOfThis = calls.filter(c => c.name === tool)
    if (callsOfThis.length === 0) return { hit: false, ok: false }
    return { hit: true, ok: callsOfThis.some(c => c.ok) }
  }

  const missing: string[] = []
  const failed: string[] = []
  for (const item of expected) {
    if (Array.isArray(item)) {
      // OR 子句：任一命中且 ok 即视为该子句满足
      const orResults = item.map(t => ({ tool: t, ...isToolSatisfied(t) }))
      const anyOk = orResults.some(r => r.hit && r.ok)
      if (anyOk) continue
      const anyHit = orResults.some(r => r.hit)
      const label = `(${item.join(' | ')})`
      if (!anyHit) {
        missing.push(label)
      } else {
        failed.push(label)
      }
    } else {
      const r = isToolSatisfied(item)
      if (!r.hit) missing.push(item)
      else if (!r.ok) failed.push(item)
    }
  }
  if (missing.length > 0 || failed.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) parts.push(`未调用: [${missing.join(', ')}]`)
    if (failed.length > 0) parts.push(`调用全部失败: [${failed.join(', ')}]`)
    return { name: 'expectedTools', pass: false, reason: parts.join(' · ') }
  }
  return { name: 'expectedTools', pass: true }
}

/**
 * 校验任一 expectedSkill 被 load_skill 工具加载（取交集）。
 * 期望的语义：题库写 expectedSkills 是"或"关系（任一命中即可），
 * 因为不同分身可能用不同 skill 名解决同一问题。
 */
export function assertExpectedSkills(events: TelemetryEvent[], expected: string[] | undefined): AssertionResult {
  if (!expected || expected.length === 0) return { name: 'expectedSkills', pass: true }
  const loaded = new Set<string>()
  for (const e of events) {
    if (e.type !== 'tool-call-start') continue
    const ev = e as ToolCallStartEvent
    if (ev.name !== 'load_skill') continue
    const id = typeof ev.args.skill_id === 'string' ? ev.args.skill_id : ''
    if (id) loaded.add(id)
  }
  const matched = expected.find(s => loaded.has(s))
  if (matched) return { name: 'expectedSkills', pass: true }
  return {
    name: 'expectedSkills',
    pass: false,
    reason: loaded.size === 0
      ? `未调用 load_skill；期望任一: [${expected.join(', ')}]`
      : `已加载 [${[...loaded].join(', ')}]，未命中期望 [${expected.join(', ')}]`,
  }
}

/**
 * 校验答案文本中存在符合期望值的数字（带容差）。
 * - 用宽松正则提取所有数字（含小数）
 * - 任一数字落在 [value*(1-tol/100), value*(1+tol/100)] 即通过
 * - 如果带 unit，要求该数字附近 ±10 字内出现 unit（提高匹配精度）
 */
export function assertExpectedValue(content: string, expected: ExpectedValue | undefined): AssertionResult {
  if (!expected) return { name: 'expectedValue', pass: true }
  if (!content || content.length === 0) {
    return { name: 'expectedValue', pass: false, reason: '答案为空' }
  }
  const tol = Math.abs(expected.tolerancePct) / 100
  // 精确为零时允许 ±0.5 的绝对误差，避免分母为 0
  const lower = expected.value === 0 ? -0.5 : expected.value * (1 - tol)
  const upper = expected.value === 0 ? 0.5 : expected.value * (1 + tol)
  const min = Math.min(lower, upper)
  const max = Math.max(lower, upper)
  const numberRegex = /-?\d+(?:\.\d+)?/g
  let match: RegExpExecArray | null
  while ((match = numberRegex.exec(content)) !== null) {
    const n = parseFloat(match[0])
    if (!Number.isFinite(n)) continue
    if (n < min || n > max) continue
    if (expected.unit) {
      const around = content.slice(Math.max(0, match.index - 10), Math.min(content.length, match.index + match[0].length + 10))
      if (!around.includes(expected.unit)) continue
    }
    return { name: 'expectedValue', pass: true }
  }
  return {
    name: 'expectedValue',
    pass: false,
    reason: `未找到匹配 ${expected.value}${expected.unit ?? ''}（容差 ±${expected.tolerancePct}%）的数值`,
  }
}

/** 全部子串都必须出现（AND 关系） */
export function assertMustContain(content: string, expected: string[] | undefined): AssertionResult {
  if (!expected || expected.length === 0) return { name: 'mustContain', pass: true }
  const missing = expected.filter(s => !content.includes(s))
  if (missing.length === 0) return { name: 'mustContain', pass: true }
  return {
    name: 'mustContain',
    pass: false,
    reason: `缺少必含字符串: [${missing.map(s => JSON.stringify(s)).join(', ')}]`,
  }
}

function isL4ChartNoDataResponse(question: GeneratedQuestion, content: string): boolean {
  if (question.category !== 'L4_chart') return false
  if (!question.mustContain?.includes('```chart')) return false
  if (content.includes('```chart')) return false
  const hasNoDataReason = [
    /无(?:可用|有效)?(?:的)?数据/,
    /没有(?:可用|有效)?(?:的)?数据/,
    /未找到(?:可用|有效)?(?:的)?数据/,
    /无法(?:生成|绘制)(?:图表|chart)?/,
    /不能(?:生成|绘制)(?:图表|chart)?/,
    /没有可画数据/,
  ].some(re => re.test(content))
  if (!hasNoDataReason) return false

  return /\[来源:\s*knowledge\//.test(content) ||
    /来源[:：][\s\S]{0,120}(knowledge\/|\.xlsx|\.json|\.md|#sheet|#row)/i.test(content)
}

function assertQuestionMustContain(question: GeneratedQuestion, content: string): AssertionResult {
  const expected = question.mustContain
  if (isL4ChartNoDataResponse(question, content)) {
    return assertMustContain(content, expected?.filter(s => s !== '```chart'))
  }
  return assertMustContain(content, expected)
}

/** 任一子串都不能出现（NAND 关系） */
export function assertMustNotContain(content: string, expected: string[] | undefined): AssertionResult {
  if (!expected || expected.length === 0) return { name: 'mustNotContain', pass: true }
  const violated = expected.filter(s => content.includes(s))
  if (violated.length === 0) return { name: 'mustNotContain', pass: true }
  return {
    name: 'mustNotContain',
    pass: false,
    reason: `出现禁止字符串: [${violated.map(s => JSON.stringify(s)).join(', ')}]`,
  }
}

/**
 * 跑全部 5 类断言并汇总。
 */
export function runAllAssertions(question: GeneratedQuestion, content: string, events: TelemetryEvent[]): {
  pass: boolean
  assertions: AssertionResult[]
} {
  const assertions: AssertionResult[] = [
    assertExpectedTools(events, question.expectedTools),
    assertExpectedSkills(events, question.expectedSkills),
    assertExpectedValue(content, question.expectedValue),
    assertQuestionMustContain(question, content),
    assertMustNotContain(content, question.mustNotContain),
  ]
  return { pass: assertions.every(a => a.pass), assertions }
}

// ─── 运行器 ────────────────────────────────────────────────────────────

/** 单题运行结果 */
export interface CaseResult {
  questionId: string
  category: QuestionCategory
  prompt: string
  conversationId: string
  /** 助手最终回答（截断到 4096 字以防报告过大） */
  answer: string
  /** 本题挂的工具调用名（按顺序，去重前） */
  toolCallSequence: string[]
  /** 累计工具次数（按工具名分组） */
  toolCallCounts: Record<string, number>
  /** 是否触发了 todo_write */
  hasTodoWrite: boolean
  /** 单题耗时（开始 sendMessage 到 message-done 或 conversation-error） */
  durationMs: number
  /** 5 类断言结果 */
  assertions: AssertionResult[]
  /** 综合通过/失败 */
  pass: boolean
  /** 整题级错误（sendMessage 抛错 / 超时 / conversation-error 事件） */
  error?: string
}

/** 全量批跑结果 */
export interface BatchRunResult {
  runId: string
  avatarId: string
  startedAt: number
  finishedAt: number
  totalCases: number
  passCount: number
  failCount: number
  errorCount: number
  /** 按类别聚合的 pass / total */
  categorySummary: Record<string, { total: number; pass: number; fail: number }>
  /** 本次运行使用的题库来源信息，用于让报告可追溯到当次快照 */
  questionBankSource?: QuestionBankRunSource
  cases: CaseResult[]
}

/** 进度回调入参 */
export interface BatchProgressEvent {
  runId: string
  current: number
  total: number
  caseResult: CaseResult
  /** 当前为止累计通过率 */
  cumulativePassRate: number
}

/** 运行器选项 */
export interface RunBatchOptions {
  runId: string
  avatarId: string
  questions: GeneratedQuestion[]
  /**
   * 调用聊天的函数指针。运行器自己生成 conversationId 传入。
   * 实现方应当走真实 chatStore.sendMessage（让工具循环跑起来）。
   */
  sendMessage: (content: string, conversationId: string, avatarId: string) => Promise<void>
  /**
   * 等待空闲（isLoading 转 false）。运行器要靠它判定单题结束。
   * 实现方应当 polling chatStore.isLoading。
   */
  waitForIdle: (signal: AbortSignal) => Promise<void>
  /** 单题超时（默认 180s） */
  perCaseTimeoutMs?: number
  /** 题目之间的固定间隔（默认 500ms，给 UI 喘息） */
  interCaseDelayMs?: number
  /** 题库来源信息；调用方负责把完整题库 JSON 交给持久化层保存 */
  questionBankSource?: QuestionBankRunSource
  /** 进度回调；返回 false 可主动停止 */
  onProgress?: (event: BatchProgressEvent) => void | Promise<void>
  /** 取消信号 */
  signal?: AbortSignal
}

/** 把 abort 包装成 Promise reject 的辅助 */
function abortablePromise<T>(p: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
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

/** 加超时包装（独立 controller，超时时 abort 并 reject） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 简短的休眠 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('sleep aborted')); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('sleep aborted'))
    }, { once: true })
  })
}

/** 从单题事件流构造 CaseResult 公共字段（除 assertions/pass/error 外） */
function buildBaseCaseResult(
  question: GeneratedQuestion,
  conversationId: string,
  events: TelemetryEvent[],
  startedAt: number,
  finishedAt: number,
): Omit<CaseResult, 'assertions' | 'pass' | 'error'> {
  const toolEnds = events.filter((e): e is ToolCallEndEvent => e.type === 'tool-call-end')
  const toolCallSequence = toolEnds.map(e => e.name)
  const toolCallCounts: Record<string, number> = {}
  for (const name of toolCallSequence) {
    toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1
  }
  const messageDone = events.find((e): e is MessageDoneEvent => e.type === 'message-done')
  const answer = (messageDone?.content ?? '').slice(0, 4096)
  const hasTodoWrite = events.some(e => e.type === 'todo-write')
  return {
    questionId: question.id,
    category: question.category,
    prompt: question.prompt,
    conversationId,
    answer,
    toolCallSequence,
    toolCallCounts,
    hasTodoWrite,
    durationMs: finishedAt - startedAt,
  }
}

/**
 * 跑单题：可选铺垫 → sendMessage → 等待 idle → 收集事件 → 跑断言。
 * 任何异常会被吞掉并记入 CaseResult.error；外层不抛。
 *
 * setupPrompts（仅 L8_traceability 等需要上下文的题目使用）：
 *   - 在 collector.start() **之前** 顺序下发，复用同一 conversationId
 *   - 不计入 assertions、不计入 toolCallSequence、不影响 durationMs
 *   - 任一铺垫超时 / 抛错都会标记本题 error 并跳过实际题
 */
async function runSingleCase(
  question: GeneratedQuestion,
  caseIdx: number,
  opts: RunBatchOptions,
): Promise<CaseResult> {
  const conversationId = `regression-${opts.runId}-${caseIdx}`
  const timeoutMs = opts.perCaseTimeoutMs ?? 180_000
  const localController = new AbortController()
  const onParentAbort = (): void => localController.abort()
  if (opts.signal) opts.signal.addEventListener('abort', onParentAbort, { once: true })

  let error: string | undefined

  // ─── 第 1 阶段：可选铺垫消息（不收集 telemetry，不计入断言） ──────────
  if (question.setupPrompts && question.setupPrompts.length > 0 && !error) {
    try {
      for (let i = 0; i < question.setupPrompts.length; i++) {
        const sp = question.setupPrompts[i]
        await withTimeout(
          (async () => {
            await opts.sendMessage(sp, conversationId, opts.avatarId)
            await abortablePromise(opts.waitForIdle(localController.signal), localController.signal, 'waitForIdle')
          })(),
          timeoutMs,
          `case[${question.id}].setup[${i}]`,
        )
      }
    } catch (e) {
      error = `setup-failed: ${e instanceof Error ? e.message : String(e)}`
      localController.abort()
    }
  }

  // ─── 第 2 阶段：正式题，启动 collector 后再发题 ──────────────────────
  const collector = new TelemetryCollector(conversationId)
  collector.start()
  const startedAt = Date.now()

  if (!error) {
    try {
      await withTimeout(
        (async () => {
          await opts.sendMessage(question.prompt, conversationId, opts.avatarId)
          await abortablePromise(opts.waitForIdle(localController.signal), localController.signal, 'waitForIdle')
        })(),
        timeoutMs,
        `case[${question.id}]`,
      )
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      localController.abort()
    }
  }
  if (opts.signal) opts.signal.removeEventListener('abort', onParentAbort)

  const events = collector.stop()
  const finishedAt = Date.now()

  // 即便 sendMessage 抛错，conversation-error 事件也可能已被 emit；优先用 emit 的错误信息
  const errorEvent = events.find(e => e.type === 'conversation-error')
  if (errorEvent && !error) {
    error = (errorEvent as { error: string }).error
  }

  const base = buildBaseCaseResult(question, conversationId, events, startedAt, finishedAt)

  // 有错误时不跑断言，整题计 fail
  if (error) {
    return {
      ...base,
      assertions: [],
      pass: false,
      error,
    }
  }

  const { pass, assertions } = runAllAssertions(question, base.answer, events)
  return { ...base, assertions, pass }
}

/**
 * 主入口：跑全部题，逐题回调进度。
 * 不抛错（除非外部 signal 在 runner 没启动前就 aborted）；任何题级错误都进 CaseResult.error。
 */
export async function runBatchRegression(opts: RunBatchOptions): Promise<BatchRunResult> {
  if (!opts.questions || opts.questions.length === 0) {
    throw new Error('题库为空')
  }
  const startedAt = Date.now()
  const cases: CaseResult[] = []
  let passCount = 0
  let failCount = 0
  let errorCount = 0
  const categorySummary: Record<string, { total: number; pass: number; fail: number }> = {}

  // 必须先 enable 遥测，否则 chatStore 的 emit 是无操作
  regressionTelemetry.enable()
  try {
    for (let i = 0; i < opts.questions.length; i++) {
      if (opts.signal?.aborted) {
        // 外部主动取消：把剩余题标为未跑（不计入失败）
        break
      }
      const q = opts.questions[i]
      const result = await runSingleCase(q, i, opts)
      cases.push(result)

      if (result.pass) passCount++
      else failCount++
      if (result.error) errorCount++

      const catBucket = categorySummary[result.category] ?? { total: 0, pass: 0, fail: 0 }
      catBucket.total++
      if (result.pass) catBucket.pass++
      else catBucket.fail++
      categorySummary[result.category] = catBucket

      if (opts.onProgress) {
        try {
          await opts.onProgress({
            runId: opts.runId,
            current: i + 1,
            total: opts.questions.length,
            caseResult: result,
            cumulativePassRate: passCount / (i + 1),
          })
        } catch (cbErr) {
          // 进度回调出错不应中断运行
          console.warn('[batch-runner] onProgress threw:', cbErr instanceof Error ? cbErr.message : String(cbErr))
        }
      }

      if (i < opts.questions.length - 1) {
        const delay = opts.interCaseDelayMs ?? 500
        if (delay > 0) {
          try { await sleep(delay, opts.signal) }
          catch { break /* 取消 */ }
        }
      }
    }
  } finally {
    regressionTelemetry.disable()
  }

  return {
    runId: opts.runId,
    avatarId: opts.avatarId,
    startedAt,
    finishedAt: Date.now(),
    totalCases: cases.length,
    passCount,
    failCount,
    errorCount,
    categorySummary,
    questionBankSource: opts.questionBankSource,
    cases,
  }
}
