/**
 * JSONL 落盘 EvaluationStore。每个 EvalKind 一个文件，每行一个 suite 结果。
 */

import fs from 'fs'
import path from 'path'
import type { EvalKind, EvalSuiteResult, EvaluationStore } from './types'

export interface JsonlStoreOptions {
  /** 目录绝对路径；不存在自动创建 */
  baseDir: string
}

export class JsonlEvaluationStore implements EvaluationStore {
  constructor(private opts: JsonlStoreOptions) {
    if (!fs.existsSync(opts.baseDir)) fs.mkdirSync(opts.baseDir, { recursive: true })
  }

  private fileFor(kind: EvalKind): string {
    return path.join(this.opts.baseDir, `${kind}.jsonl`)
  }

  async recordSuite(kind: EvalKind, result: EvalSuiteResult): Promise<void> {
    const line = JSON.stringify({ kind, ...result }) + '\n'
    await fs.promises.appendFile(this.fileFor(kind), line, 'utf-8')
  }

  async loadRecent(kind: EvalKind, limit: number): Promise<EvalSuiteResult[]> {
    const file = this.fileFor(kind)
    if (!fs.existsSync(file)) return []
    const content = await fs.promises.readFile(file, 'utf-8')
    const lines = content.split('\n').filter((l) => l.trim())
    return lines
      .slice(-limit)
      .map((l) => JSON.parse(l) as EvalSuiteResult & { kind: EvalKind })
      .map(({ kind: _k, ...rest }) => rest as EvalSuiteResult)
  }
}
