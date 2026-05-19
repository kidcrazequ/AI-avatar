/**
 * eval/types.ts — Inspect-AI 风格的 Task / Solver / Scorer 三层抽象
 *
 * 借鉴 https://github.com/UKGovernmentBEIS/inspect_ai：
 *   - Sample：单条评测项（input + target + metadata）
 *   - Solver：把 Sample 跑成 SolverOutput（默认实现走 Soul 真实工作流，等价于 batch-regression-runner.runSingleCase）
 *   - Scorer：根据 SolverOutput 给一个 Score（多个 scorer 并行叠加，对应原 5 类断言）
 *   - Task：name + dataset + solver + scorers，一次 runEval(task) 出 EvalResult
 *
 * 与 batch-regression-runner.ts 关系：
 *   - 不替换它（596 行业务耦合较深），而是并行实现一套可独立演进的抽象
 *   - eval/adapter.ts 提供 GeneratedQuestion → Sample 的桥接，存量题库可直接喂入
 *
 * 与 llm-providers/types.ts 关系：
 *   - SolverOutput.usage 复用现有 NormalizedUsage，cost-tracker 直接消费
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import type { NormalizedUsage } from '../llm-providers/types'
import type { TelemetryEvent } from '../regression-telemetry'

/** 单条评测样本 */
export interface Sample<TInput = string, TTarget = unknown> {
  id: string
  input: TInput
  /** 期望答案 / 期望工具命中 / 期望数值等，scorer 内部按自己 schema 解读 */
  target?: TTarget
  metadata?: Record<string, unknown>
}

/** Solver 跑完单条样本的产物 */
export interface SolverOutput {
  /** 助手最终回复全文（已截断；上层不需要再截） */
  text: string
  /** 跨 provider 归一化后的 token 用量；为空表示 provider 未返回（如 mock） */
  usage?: NormalizedUsage
  /** 模型 ID（用于 cost-tracker 计价） */
  model?: string
  /** 工作流轨迹事件（工具调用、todo、message-done 等） */
  toolEvents: TelemetryEvent[]
  /** 单条耗时 ms（含 setup） */
  durationMs: number
  /** 整条样本级错误（sendMessage 抛错 / 超时 / conversation-error）；非空 → scorer 跳过 */
  error?: string
}

/**
 * Solver：把样本跑成输出。
 *
 * 默认实现是 makeChatSolver({ sendMessage, waitForIdle, ... })，
 * 但接口允许测试时传 mock solver（如纯文本回放）。
 */
export type Solver<TInput = string> = (
  sample: Sample<TInput, unknown>,
  signal?: AbortSignal,
) => Promise<SolverOutput>

/** Scorer 的结构化打分结果 */
export interface Score {
  /** 数值打分（0-1 / 0-100 都可），或 'pass'/'fail' 离散值 */
  value: number | 'pass' | 'fail'
  /** 是否视作通过；上层做 pass/fail 汇总只看这个字段 */
  passed: boolean
  /** 失败/异常时的可读说明（pass 时可省） */
  explanation?: string
  /** scorer 自由扩展字段（如 matched anchors、missing tools 列表） */
  metadata?: Record<string, unknown>
}

/**
 * Scorer：对 SolverOutput 打一个分。
 *
 * - 同一个 Task 可挂多个 scorer（红线、溯源、人格、知识库、数值），结果按 name 归集
 * - scorer 自身不区分错误，error 样本由 runEval 统一短路成 'fail'
 */
export interface Scorer<TTarget = unknown> {
  /** 报告中显示的名字（如 'red-line' / 'expectedTools' / 'persona'） */
  name: string
  score(sample: Sample<unknown, TTarget>, output: SolverOutput): Promise<Score> | Score
}

export interface TaskConfig {
  /** 单题超时 ms（默认 180_000） */
  perSampleTimeoutMs?: number
  /** 题间间隔 ms（默认 500） */
  interSampleDelayMs?: number
  /** Eval log JSONL 落盘目录；为空则不写盘（仅返回 EvalResult） */
  logDir?: string
}

/** 一个完整的评测任务定义 */
export interface Task<TInput = string, TTarget = unknown> {
  name: string
  dataset: Sample<TInput, TTarget>[]
  solver: Solver<TInput>
  scorers: Scorer<TTarget>[]
  config?: TaskConfig
}

/** 单样本评测结果（runEval 输出的逐条） */
export interface SampleResult {
  sampleId: string
  /** 综合通过（所有 scorer 都 passed=true 且无 error） */
  passed: boolean
  /** 整样本级错误（solver 抛错时填，所有 scorer 跳过） */
  error?: string
  output: SolverOutput
  /** scorer name → score 结果 */
  scores: Record<string, Score>
}

/** 整批评测结果 */
export interface EvalResult {
  task: string
  startedAt: number
  finishedAt: number
  /** Eval log 文件路径（如 config.logDir 非空） */
  logPath?: string
  summary: {
    total: number
    passed: number
    failed: number
    errored: number
    /** 每个 scorer 的 pass 计数（用于看哪类红线最容易破） */
    scorerPassCounts: Record<string, number>
    /** 累计 token 用量（按 NormalizedUsage 字段求和） */
    totalUsage: NormalizedUsage
  }
  samples: SampleResult[]
}
