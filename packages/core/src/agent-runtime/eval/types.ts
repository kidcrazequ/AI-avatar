/**
 * EvalHarness：统一的评估抽象，对齐 PAP 的 unit / integration / regression / benchmark。
 *
 * 现有 batch-regression-runner / test-runner / manual-qa-scenarios / reference-simulation
 * 可逐步迁移到本接口；中间过渡期可以并存。
 */

export type EvalKind = 'unit' | 'integration' | 'regression' | 'benchmark'

export interface EvalCase {
  id: string
  kind: EvalKind
  /** 一句话标题 */
  title: string
  /** 业务标签：分身 id / 模块 / 红线 / 数据溯源 ... */
  tags?: string[]
  /** 期望与实际比较的策略由 case 自定义 */
  run: () => Promise<EvalCaseResult>
}

export interface EvalCaseResult {
  caseId: string
  pass: boolean
  /** 失败时给的可读原因 */
  reason?: string
  /** 自由指标（latency / tokens / scores …） */
  metrics?: Record<string, number>
  /** 任意附带 payload，用于回放 */
  artefacts?: Record<string, unknown>
  durationMs: number
}

export interface EvalSuiteResult {
  startedAt: number
  finishedAt: number
  cases: EvalCaseResult[]
  passCount: number
  failCount: number
}

export interface EvaluationStore {
  /** 写入一次 suite 结果（JSONL 落盘） */
  recordSuite(kind: EvalKind, result: EvalSuiteResult): Promise<void>
  /** 读取最近 N 次 suite 结果 */
  loadRecent(kind: EvalKind, limit: number): Promise<EvalSuiteResult[]>
}
