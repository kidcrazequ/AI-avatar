/**
 * eval/eval-log.ts — Eval log JSONL 写入器
 *
 * 借鉴 Inspect AI 的 .eval log 思路（简化）：
 *   - 每行一个 JSON：header（首行）+ N 条 sample-result 行 + 末行 summary
 *   - 流式 append：runEval 跑完一条就写一行，整批崩溃也能保留进度
 *
 * 不依赖 Electron / fs-extra；Node 原生 fs.promises 即可。浏览器侧调用方应传 null 表示禁用落盘。
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import { mkdir, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EvalResult, SampleResult, Task } from './types'

interface HeaderLine {
  kind: 'header'
  task: string
  startedAt: number
  datasetSize: number
  scorers: string[]
}

interface SampleLine {
  kind: 'sample'
  result: SampleResult
}

interface SummaryLine {
  kind: 'summary'
  result: Omit<EvalResult, 'samples'>
}

export type EvalLogLine = HeaderLine | SampleLine | SummaryLine

export class EvalLogWriter {
  private readonly path: string
  private headerWritten = false

  constructor(path: string) {
    this.path = path
  }

  private async ensureDir(): Promise<void> {
    const dir = dirname(this.path)
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  }

  async writeHeader<I, T>(task: Task<I, T>, startedAt: number): Promise<void> {
    await this.ensureDir()
    const line: HeaderLine = {
      kind: 'header',
      task: task.name,
      startedAt,
      datasetSize: task.dataset.length,
      scorers: task.scorers.map(s => s.name),
    }
    await appendFile(this.path, JSON.stringify(line) + '\n', 'utf8')
    this.headerWritten = true
  }

  async writeSample(result: SampleResult): Promise<void> {
    if (!this.headerWritten) {
      throw new Error('EvalLogWriter: header 未写，先调用 writeHeader')
    }
    const line: SampleLine = { kind: 'sample', result }
    await appendFile(this.path, JSON.stringify(line) + '\n', 'utf8')
  }

  async writeSummary(result: EvalResult): Promise<void> {
    if (!this.headerWritten) {
      throw new Error('EvalLogWriter: header 未写')
    }
    const { samples: _samples, ...rest } = result
    const line: SummaryLine = { kind: 'summary', result: rest }
    await appendFile(this.path, JSON.stringify(line) + '\n', 'utf8')
  }

  getPath(): string {
    return this.path
  }
}

/** 给定目录 + taskName，生成 evals/<taskName>-<ts>.jsonl 风格的路径 */
export function defaultEvalLogPath(dir: string, taskName: string, when = Date.now()): string {
  const ts = new Date(when).toISOString().replace(/[:.]/g, '-')
  const safe = taskName.replace(/[^a-zA-Z0-9_\-一-龥]+/g, '_')
  return `${dir.replace(/\/$/, '')}/${safe}-${ts}.jsonl`
}
