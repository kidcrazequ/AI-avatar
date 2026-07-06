/**
 * eval/ — Inspect-AI 风格评测框架（Soul 本地实现）
 *
 * 入口：
 *   - runEval(task)              一次评测
 *   - makeChatSolver / staticSolver   Solver 工厂
 *   - defaultScorers / 各 *Scorer    内置 scorer
 *   - questionsToSamples          老题库迁移桥
 *
 * 与现有模块的关系图：
 *   chatStore   ──emit──▶ regressionTelemetry  ──collector──▶ Solver.SolverOutput
 *                                                                │
 *                                                                ▼
 *                                                        Scorer * N
 *                                                                │
 *                                                                ▼
 *                                                          runEval()
 *                                                                │
 *                                                                ▼
 *                                                          EvalResult + JSONL log
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

export type {
  Sample,
  Solver,
  SolverOutput,
  Score,
  Scorer,
  Task,
  TaskConfig,
  SampleResult,
  EvalResult,
} from './types'

export { runEval, type RunEvalOptions } from './task'
export {
  makeChatSolver,
  staticSolver,
  withRegressionTelemetry,
  defaultExtractUsage,
  type ChatSolverDeps,
} from './solvers'
export {
  defaultScorers,
  expectedToolsScorer,
  expectedSkillsScorer,
  expectedValueScorer,
  mustContainScorer,
  mustNotContainScorer,
  citationScorer,
  personaScorer,
  type FullTarget,
} from './scorers'
export { questionsToSamples } from './adapter'
export { EvalLogWriter, defaultEvalLogPath, type EvalLogLine } from './eval-log'
export {
  loadFlowsAsSamples,
  flowsToSamples,
  parseFlowJsonl,
  type LoadFlowsOptions,
} from './dataset-from-flows'
export {
  costTracker,
  DEFAULT_PRICING,
  type ModelPricing,
  type CostBreakdown,
  type AggregateRow,
} from '../llm-providers/cost-tracker'
export {
  runCompressionAbEval,
  buildCompressionAbTasks,
  makeCompressionSolver,
  defaultCompressionAbSamples,
  loadBearingNumbersScorer,
  sourceAnchorKeepScorer,
  type CompressionAbInput,
  type CompressionAbTarget,
  type CompressionAbOptions,
} from './compression-ab'
export {
  runSkillAbEval,
  buildSkillAbTasks,
  composeWithSkillPrompt,
  violationPatternScorer,
  expectedBehaviorScorer,
  type SkillAbInput,
  type SkillAbTarget,
  type SkillAbOptions,
} from './skill-ab'
