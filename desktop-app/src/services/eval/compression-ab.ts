/**
 * eval/compression-ab.ts — A3-6：工具结果压缩 before/after 对照评测
 *
 * 同组样本分别在「压缩开 / 压缩关」两个 Task 下跑，**程序化 scorer**（零 LLM judge）
 * 逐字断言：
 *   - 承重数字（target.mustKeepNumbers）原样出现——错误行 / 罕见值 / query 命中 /
 *     首尾行里的数字属于承重数字，压缩后必须逐字存在
 *   - `[来源: ...]` 引用（target.mustKeepAnchors）原样出现——A1 溯源闭集依赖
 *
 * 全程零模型调用：solver 是纯函数（identity / compressToolResult），可进 CI。
 * 这是 BR-2/A3 压缩敢不敢默认开的质量证据来源（没有评测就永远不敢默认开）。
 *
 * @author zhi.qu
 * @date 2026-07-06
 */

import { compressToolResult } from '../tool-result-compressor'
import { runEval } from './task'
import type { EvalResult, Sample, Scorer, Solver, Task } from './types'

/** 单条样本输入：一段模拟的工具结果原文 + 压缩时可用的用户 query */
export interface CompressionAbInput {
  toolResult: string
  query?: string
}

/** 断言目标：逐字必须保留的承重数字与来源锚点 */
export interface CompressionAbTarget {
  mustKeepNumbers?: string[]
  mustKeepAnchors?: string[]
}

function missingVerbatim(text: string, expected: string[] | undefined): string[] {
  return (expected ?? []).filter((item) => !text.includes(item))
}

/** 承重数字逐字断言（不做数值解析——解析即有改写风险，逐字才是溯源口径） */
export const loadBearingNumbersScorer: Scorer<CompressionAbTarget> = {
  name: 'load-bearing-numbers',
  score(sample, output) {
    const missing = missingVerbatim(output.text, sample.target?.mustKeepNumbers)
    if (missing.length === 0) return { value: 'pass', passed: true }
    return {
      value: 'fail',
      passed: false,
      explanation: `承重数字丢失：${missing.join('、')}`,
      metadata: { missing },
    }
  },
}

/** `[来源: ...]` 引用逐字断言 */
export const sourceAnchorKeepScorer: Scorer<CompressionAbTarget> = {
  name: 'source-anchors',
  score(sample, output) {
    const missing = missingVerbatim(output.text, sample.target?.mustKeepAnchors)
    if (missing.length === 0) return { value: 'pass', passed: true }
    return {
      value: 'fail',
      passed: false,
      explanation: `来源锚点丢失：${missing.join(' ')}`,
      metadata: { missing },
    }
  },
}

/** 压缩开（compressed=true 路径）/ 压缩关（identity）两个纯函数 solver */
export function makeCompressionSolver(compressionOn: boolean, maxChars: number): Solver<CompressionAbInput> {
  return (sample) => {
    const startedAt = Date.now()
    const input = sample.input as CompressionAbInput
    const text = compressionOn
      ? compressToolResult(input.toolResult, { maxChars, query: input.query }).content
      : input.toolResult
    return Promise.resolve({ text, toolEvents: [], durationMs: Date.now() - startedAt })
  }
}

export interface CompressionAbOptions {
  /** 压缩目标预算（与 chatStore 的 TOOL_RESULT_COMPRESSED_TARGET_CHARS 同量级） */
  maxChars?: number
}

/** 构建同数据集、同 scorer 的开 / 关两个 Task */
export function buildCompressionAbTasks(
  dataset: Sample<CompressionAbInput, CompressionAbTarget>[],
  opts: CompressionAbOptions = {},
): { on: Task<CompressionAbInput, CompressionAbTarget>; off: Task<CompressionAbInput, CompressionAbTarget> } {
  const maxChars = opts.maxChars ?? 1600
  const scorers = [loadBearingNumbersScorer, sourceAnchorKeepScorer]
  const config = { interSampleDelayMs: 0 }
  return {
    on: { name: 'tool-result-compression-on', dataset, solver: makeCompressionSolver(true, maxChars), scorers, config },
    off: { name: 'tool-result-compression-off', dataset, solver: makeCompressionSolver(false, maxChars), scorers, config },
  }
}

/** 一次跑完开 / 关两组，返回可对照的 EvalResult 对 */
export async function runCompressionAbEval(
  dataset: Sample<CompressionAbInput, CompressionAbTarget>[] = defaultCompressionAbSamples,
  opts: CompressionAbOptions = {},
): Promise<{ on: EvalResult; off: EvalResult }> {
  const tasks = buildCompressionAbTasks(dataset, opts)
  return { on: await runEval(tasks.on), off: await runEval(tasks.off) }
}

// ─── 内置对照样本（与 tool-result-compressor.test.ts 的夹具风格一致） ────────

function buildExcelLikeSample(): Sample<CompressionAbInput, CompressionAbTarget> {
  const rows: Array<Record<string, unknown>> = []
  for (let i = 1; i <= 40; i++) {
    const row: Record<string, unknown> = {
      序号: i,
      柜体: '262',
      状态: i === 17 ? '失败' : i === 31 ? '复测通过' : '通过',
      良率: Number((88 + i * 0.09).toFixed(2)),
      标记: `T-${String(i).padStart(2, '0')}`,
    }
    if (i === 17) row.来源 = '[来源: knowledge/_excel/262-copq.json#sheet=测试记录&rows=18]'
    rows.push(row)
  }
  return {
    id: 'excel-json-40rows',
    input: { toolResult: JSON.stringify(rows), query: '262 柜体失败原因' },
    target: {
      // 承重数字：错误行（88+17*0.09）与罕见值行（88+31*0.09）的良率
      mustKeepNumbers: ['89.53', '90.79'],
      mustKeepAnchors: ['[来源: knowledge/_excel/262-copq.json#sheet=测试记录&rows=18]'],
    },
  }
}

function buildKnowledgeTextSample(): Sample<CompressionAbInput, CompressionAbTarget> {
  const lines: string[] = []
  for (let i = 1; i <= 60; i++) lines.push(`第${i}条 政策说明文本 适用于工商业储能项目备案与并网流程 编号 P-${2000 + i}`)
  lines[7] = '峰谷价差补贴上限 0.352 元/千瓦时 [来源: knowledge/energy-policy.md#L120-L133]'
  lines[39] = '数据校验失败：附表三缺失 缺口率 0.008'
  return {
    id: 'knowledge-text-60lines',
    input: { toolResult: lines.join('\n') },
    target: {
      mustKeepNumbers: ['0.352', '0.008'],
      mustKeepAnchors: ['[来源: knowledge/energy-policy.md#L120-L133]'],
    },
  }
}

function buildUniformCsvSample(): Sample<CompressionAbInput, CompressionAbTarget> {
  const rows: Array<Record<string, unknown>> = []
  for (let i = 1; i <= 30; i++) {
    rows.push({
      月份: `2026-${String(i).padStart(2, '0')}`,
      良率: Number((91 + i * 0.013).toFixed(3)),
      出货量: 1200 + i * 7,
      放电量: 40000 + i * 13,
      备注: '正常',
    })
  }
  return {
    id: 'uniform-json-to-csv',
    input: { toolResult: JSON.stringify(rows) },
    target: {
      // 无损重排路径：中间行数字也必须逐字在（全量保留）
      mustKeepNumbers: [String(rows[14].良率), String(rows[14].出货量), String(rows[29].良率)],
      mustKeepAnchors: [],
    },
  }
}

/**
 * 默认对照集：JSON 表格 / 纯文本知识摘录 / 均匀数组（CSV 无损路径）各一条。
 * 三条都必须在「压缩开」下与「压缩关」同样全绿——这是压缩不丢承重信息的回归底线。
 */
export const defaultCompressionAbSamples: Sample<CompressionAbInput, CompressionAbTarget>[] = [
  buildExcelLikeSample(),
  buildKnowledgeTextSample(),
  buildUniformCsvSample(),
]
