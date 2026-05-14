/**
 * 通用 Eval 执行器：按顺序跑 cases，捕获异常，聚合结果。
 * 调用方按 kind 分别构造 suite（regression / benchmark 等）。
 */

import type { EvalCase, EvalCaseResult, EvalSuiteResult } from './types'

export interface RunSuiteOptions {
  /** 单 case 超时（ms），默认 60s */
  caseTimeoutMs?: number
  /** 单 case 出错时是否中断；默认 false 继续跑 */
  bailOnFail?: boolean
  /** 进度回调 */
  onCaseDone?: (r: EvalCaseResult) => void
}

export async function runSuite(
  cases: readonly EvalCase[],
  opts: RunSuiteOptions = {}
): Promise<EvalSuiteResult> {
  const startedAt = Date.now()
  const results: EvalCaseResult[] = []
  const timeout = opts.caseTimeoutMs ?? 60_000

  for (const c of cases) {
    const start = Date.now()
    let r: EvalCaseResult
    try {
      r = await Promise.race([
        c.run(),
        new Promise<EvalCaseResult>((_, reject) =>
          setTimeout(() => reject(new Error(`case ${c.id} 超时 ${timeout}ms`)), timeout)
        ),
      ])
    } catch (err) {
      r = {
        caseId: c.id,
        pass: false,
        reason: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      }
    }
    results.push(r)
    opts.onCaseDone?.(r)
    if (opts.bailOnFail && !r.pass) break
  }

  const passCount = results.filter((r) => r.pass).length
  return {
    startedAt,
    finishedAt: Date.now(),
    cases: results,
    passCount,
    failCount: results.length - passCount,
  }
}
