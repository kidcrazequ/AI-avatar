/**
 * eval/dataset-from-flows.ts — 把 mitmproxy 风格的 RecordedFlow JSONL 转 Sample
 *
 * 用法：
 *   const samples = await loadFlowsAsSamples('/path/to/proxy-flows.jsonl')
 *   await runEval({ name: 'replay', dataset: samples, solver: makeChatSolver(...), scorers: [...] })
 *
 * - flow.request.body 是 Anthropic Messages API JSON；本模块只抽最后一条 user 文本作为 sample.input
 * - 若 flow.response.kind === 'json' 且能取出助手文本，则作为 metadata.recordedAnswer 保留（方便实现 diff scorer）
 * - error 流（response.kind='error'）默认跳过
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import { readFile } from 'node:fs/promises'
import { extractLastUserTextFromAnthropic } from '../../lib/anthropic-proxy-protocol'
import type { Sample } from './types'

interface FlowJsonLine {
  flowId: string
  startedAt: number
  finishedAt: number
  durationMs: number
  conversationId: string
  stream: boolean
  request: { body: Record<string, unknown> }
  response: {
    kind: 'json' | 'sse' | 'error'
    json?: unknown
    error?: string
    sseOk?: boolean
  }
}

export interface LoadFlowsOptions {
  /** 跳过 response.kind='error' 的流（默认 true） */
  skipErrors?: boolean
  /** 仅取这些 conversationId（白名单） */
  conversationIds?: string[]
}

/** 从 Anthropic JSON 响应里抽助手最终文本 */
function extractAssistantText(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined
  const content = (json as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.length > 0 ? parts.join('') : undefined
}

/** 解析 JSONL，每行一个 RecordedFlow；忽略空行 */
export function parseFlowJsonl(content: string): FlowJsonLine[] {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  const flows: FlowJsonLine[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      flows.push(JSON.parse(lines[i]) as FlowJsonLine)
    } catch (e) {
      console.warn(`[dataset-from-flows] line ${i + 1} parse failed:`, e instanceof Error ? e.message : String(e))
    }
  }
  return flows
}

/** RecordedFlow → Sample；跳过无法抽取 user 文本的流 */
export function flowsToSamples(flows: FlowJsonLine[], opts: LoadFlowsOptions = {}): Sample<string, unknown>[] {
  const skipErrors = opts.skipErrors !== false
  const allowConv = opts.conversationIds ? new Set(opts.conversationIds) : null

  const samples: Sample<string, unknown>[] = []
  for (const flow of flows) {
    if (skipErrors && flow.response.kind === 'error') continue
    if (allowConv && !allowConv.has(flow.conversationId)) continue
    let input: string
    try {
      input = extractLastUserTextFromAnthropic((flow.request.body as { messages?: unknown }).messages)
    } catch {
      continue // 缺 user 文本的流跳过
    }
    const recordedAnswer = flow.response.kind === 'json' ? extractAssistantText(flow.response.json) : undefined
    samples.push({
      id: `flow-${flow.flowId}`,
      input,
      metadata: {
        conversationId: flow.conversationId,
        recordedAt: flow.startedAt,
        recordedAnswer,
        model: (flow.request.body as { model?: unknown }).model,
      },
    })
  }
  return samples
}

/** 一站式：从 JSONL 文件路径加载并转 Sample[] */
export async function loadFlowsAsSamples(path: string, opts?: LoadFlowsOptions): Promise<Sample<string, unknown>[]> {
  const content = await readFile(path, 'utf8')
  return flowsToSamples(parseFlowJsonl(content), opts)
}
