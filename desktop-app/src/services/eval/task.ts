/**
 * eval/task.ts — runEval 入口
 *
 * 流程：
 *   1) 写 header
 *   2) 顺序跑 dataset：solver(sample) → 多个 scorer → SampleResult
 *   3) 累计 summary（pass/fail/error + scorerPassCounts + totalUsage）
 *   4) 写 summary，返回 EvalResult
 *
 * 设计要点：
 *   - solver 抛错 / 返回 error 不中断整批，统一标 errored
 *   - scorer 抛错视为该 scorer fail，记入 explanation；不影响其他 scorer
 *   - AbortSignal 支持中途停（保留已跑完的 samples）
 *   - 题间 delay 让 UI 喘息（默认 500ms）
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import { EvalLogWriter, defaultEvalLogPath } from './eval-log'
import type {
  EvalResult,
  Sample,
  SampleResult,
  Score,
  Scorer,
  SolverOutput,
  Task,
} from './types'
import type { NormalizedUsage } from '../llm-providers/types'
import { costTracker } from '../llm-providers/cost-tracker'

export interface RunEvalOptions {
  signal?: AbortSignal
  onProgress?: (event: {
    current: number
    total: number
    sample: SampleResult
    cumulativePassRate: number
  }) => void | Promise<void>
  /**
   * 把每条 SolverOutput.usage 上报到 cost-tracker 时使用的 avatarId。
   * 不传 → 不上报（保持 eval 模块零侧效应）。
   * 上层应在调用 runEval 前显式 costTracker.reset() 控制累计窗口。
   */
  trackCostsAs?: string
}

function emptyUsage(): NormalizedUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
}

function addUsage(acc: NormalizedUsage, u: NormalizedUsage | undefined): NormalizedUsage {
  if (!u) return acc
  return {
    inputTokens: acc.inputTokens + (u.inputTokens || 0),
    outputTokens: acc.outputTokens + (u.outputTokens || 0),
    cacheReadTokens: (acc.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0),
    cacheCreationTokens: (acc.cacheCreationTokens ?? 0) + (u.cacheCreationTokens ?? 0),
  }
}

async function runOneScorer<TTarget>(
  scorer: Scorer<TTarget>,
  sample: Sample<unknown, TTarget>,
  output: SolverOutput,
): Promise<Score> {
  try {
    return await scorer.score(sample, output)
  } catch (e) {
    return {
      value: 'fail',
      passed: false,
      explanation: `scorer threw: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

/**
 * 执行一个 Task，返回 EvalResult。
 *
 * - dataset 空 → 抛错（让调用方早期察觉）
 * - 整体 abort 时返回已完成的 samples，summary 仍正确累加
 */
export async function runEval<TInput, TTarget>(
  task: Task<TInput, TTarget>,
  options: RunEvalOptions = {},
): Promise<EvalResult> {
  if (!task.dataset || task.dataset.length === 0) {
    throw new Error(`runEval: task "${task.name}" 数据集为空`)
  }

  const startedAt = Date.now()
  const interDelay = task.config?.interSampleDelayMs ?? 500
  const samples: SampleResult[] = []
  let passed = 0
  let failed = 0
  let errored = 0
  const scorerPassCounts: Record<string, number> = {}
  let totalUsage = emptyUsage()

  let logger: EvalLogWriter | undefined
  let logPath: string | undefined
  if (task.config?.logDir) {
    logPath = defaultEvalLogPath(task.config.logDir, task.name, startedAt)
    logger = new EvalLogWriter(logPath)
    await logger.writeHeader(task, startedAt)
  }

  for (let i = 0; i < task.dataset.length; i++) {
    if (options.signal?.aborted) break
    const sample = task.dataset[i]

    let output: SolverOutput
    try {
      output = await task.solver(sample as Sample<TInput, unknown>, options.signal)
    } catch (e) {
      output = {
        text: '',
        toolEvents: [],
        durationMs: 0,
        error: e instanceof Error ? e.message : String(e),
      }
    }

    const scores: Record<string, Score> = {}
    if (!output.error) {
      for (const scorer of task.scorers) {
        const s = await runOneScorer(scorer, sample as Sample<unknown, TTarget>, output)
        scores[scorer.name] = s
        if (s.passed) scorerPassCounts[scorer.name] = (scorerPassCounts[scorer.name] ?? 0) + 1
      }
    }

    // 全部 scorer 都 pass（或无 scorer）+ 无 error → 视作 passed
    const samplePassed = !output.error
      && task.scorers.every(sc => scores[sc.name]?.passed === true)
    const result: SampleResult = {
      sampleId: sample.id,
      passed: samplePassed,
      error: output.error,
      output,
      scores,
    }
    samples.push(result)

    if (output.error) errored++
    if (samplePassed) passed++
    else if (!output.error) failed++
    totalUsage = addUsage(totalUsage, output.usage)
    if (options.trackCostsAs && output.usage && output.model) {
      costTracker.record(options.trackCostsAs, output.model, output.usage)
    }

    if (logger) await logger.writeSample(result)
    if (options.onProgress) {
      try {
        await options.onProgress({
          current: i + 1,
          total: task.dataset.length,
          sample: result,
          cumulativePassRate: passed / (i + 1),
        })
      } catch (cbErr) {
        console.warn('[runEval] onProgress threw:', cbErr instanceof Error ? cbErr.message : String(cbErr))
      }
    }

    if (i < task.dataset.length - 1 && interDelay > 0) {
      try { await sleep(interDelay, options.signal) }
      catch { break }
    }
  }

  const result: EvalResult = {
    task: task.name,
    startedAt,
    finishedAt: Date.now(),
    logPath,
    summary: {
      total: samples.length,
      passed,
      failed,
      errored,
      scorerPassCounts,
      totalUsage,
    },
    samples,
  }
  if (logger) await logger.writeSummary(result)
  return result
}
