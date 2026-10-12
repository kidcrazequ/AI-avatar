/**
 * Per-run JSONL trace recorder.
 *
 * AuditTrail records cross-cutting governance events. RunTrace is narrower:
 * one user-visible run, its tool/model/sub-agent/artifact/source lifecycle, and
 * a compact summary for UI and support diagnostics.
 */

import fs from 'fs'
import path from 'path'

export type RunTraceEventKind =
  | 'run_started'
  | 'run_finished'
  | 'model_call'
  | 'tool_call'
  | 'subagent'
  | 'artifact'
  | 'source_hit'
  | 'guardrail'
  | 'error'

export interface TokenUsageLike {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export interface RunTraceEvent {
  ts: string
  kind: RunTraceEventKind
  runId: string
  conversationId?: string
  avatarId?: string
  payload: Record<string, unknown>
}

export interface RunTraceSummary {
  runId: string
  conversationId?: string
  avatarId?: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'done' | 'error'
  durationMs?: number
  eventCount: number
  modelCallCount: number
  toolCallCount: number
  subagentCount: number
  guardrailDecisionCount: number
  errorCount: number
  artifacts: string[]
  sources: string[]
  usage: Required<TokenUsageLike>
  estimatedCostUsd?: number
}

export interface RunTraceRecorderOptions {
  traceDir: string
  runId: string
  conversationId?: string
  avatarId?: string
  now?: () => Date
  onWriteError?: (err: unknown) => void
}

function emptyUsage(): Required<TokenUsageLike> {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
}

function addUsage(target: Required<TokenUsageLike>, usage: TokenUsageLike | undefined): void {
  if (!usage) return
  target.inputTokens += usage.inputTokens ?? 0
  target.outputTokens += usage.outputTokens ?? 0
  target.cacheReadTokens += usage.cacheReadTokens ?? 0
  target.cacheCreationTokens += usage.cacheCreationTokens ?? 0
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

export class RunTraceRecorder {
  private readonly file: string
  private readonly summaryFile: string
  private readonly now: () => Date
  private readonly onWriteError: (err: unknown) => void
  private readonly summary: RunTraceSummary
  private queue: Promise<void> = Promise.resolve()
  private startedMs: number

  constructor(private readonly opts: RunTraceRecorderOptions) {
    this.now = opts.now ?? (() => new Date())
    this.onWriteError = opts.onWriteError ?? ((err) => console.error('[run-trace] write failed:', err))
    fs.mkdirSync(opts.traceDir, { recursive: true })
    this.file = path.join(opts.traceDir, `${opts.runId}.jsonl`)
    this.summaryFile = path.join(opts.traceDir, `${opts.runId}.summary.json`)
    const startedAt = this.now()
    this.startedMs = startedAt.getTime()
    this.summary = {
      runId: opts.runId,
      conversationId: opts.conversationId,
      avatarId: opts.avatarId,
      startedAt: startedAt.toISOString(),
      status: 'running',
      eventCount: 0,
      modelCallCount: 0,
      toolCallCount: 0,
      subagentCount: 0,
      guardrailDecisionCount: 0,
      errorCount: 0,
      artifacts: [],
      sources: [],
      usage: emptyUsage(),
    }
  }

  start(payload: Record<string, unknown> = {}): void {
    this.record('run_started', payload)
  }

  record(kind: RunTraceEventKind, payload: Record<string, unknown> = {}): void {
    const event: RunTraceEvent = {
      ts: this.now().toISOString(),
      kind,
      runId: this.opts.runId,
      conversationId: this.opts.conversationId,
      avatarId: this.opts.avatarId,
      payload,
    }
    this.fold(event)
    const line = JSON.stringify(event) + '\n'
    this.queue = this.queue.then(
      () =>
        new Promise<void>((resolve) => {
          fs.appendFile(this.file, line, (err) => {
            if (err) this.onWriteError(err)
            resolve()
          })
        })
    )
  }

  finish(status: 'done' | 'error' = 'done', payload: Record<string, unknown> = {}): void {
    const finishedAt = this.now()
    this.summary.status = status
    this.summary.finishedAt = finishedAt.toISOString()
    this.summary.durationMs = Math.max(0, finishedAt.getTime() - this.startedMs)
    if (typeof payload.estimatedCostUsd === 'number') {
      this.summary.estimatedCostUsd = payload.estimatedCostUsd
    }
    this.record('run_finished', { status, ...payload })
    this.queue = this.queue.then(
      () =>
        new Promise<void>((resolve) => {
          fs.writeFile(this.summaryFile, JSON.stringify(this.summary, null, 2) + '\n', (err) => {
            if (err) this.onWriteError(err)
            resolve()
          })
        })
    )
  }

  getSummary(): RunTraceSummary {
    return {
      ...this.summary,
      artifacts: [...this.summary.artifacts],
      sources: [...this.summary.sources],
      usage: { ...this.summary.usage },
    }
  }

  async flush(): Promise<void> {
    await this.queue
  }

  private fold(event: RunTraceEvent): void {
    this.summary.eventCount += 1
    if (event.kind === 'model_call') {
      this.summary.modelCallCount += 1
      addUsage(this.summary.usage, event.payload.usage as TokenUsageLike | undefined)
    } else if (event.kind === 'tool_call') {
      this.summary.toolCallCount += 1
    } else if (event.kind === 'subagent') {
      this.summary.subagentCount += 1
    } else if (event.kind === 'guardrail') {
      this.summary.guardrailDecisionCount += 1
    } else if (event.kind === 'error') {
      this.summary.errorCount += 1
    } else if (event.kind === 'artifact') {
      for (const artifact of asStringArray(event.payload.paths)) {
        if (!this.summary.artifacts.includes(artifact)) this.summary.artifacts.push(artifact)
      }
      if (typeof event.payload.path === 'string' && !this.summary.artifacts.includes(event.payload.path)) {
        this.summary.artifacts.push(event.payload.path)
      }
    } else if (event.kind === 'source_hit') {
      for (const source of asStringArray(event.payload.sources)) {
        if (!this.summary.sources.includes(source)) this.summary.sources.push(source)
      }
      if (typeof event.payload.source === 'string' && !this.summary.sources.includes(event.payload.source)) {
        this.summary.sources.push(event.payload.source)
      }
    }
  }
}
