/**
 * flow-recorder.ts — Anthropic Proxy 流量录制器（mitmproxy 风格）
 *
 * 灵感：mitmproxy 的 flow record / replay —— 把每次进入 /v1/messages 的请求
 * 与最终响应写成 JSONL，回放时可作为离线测试集喂给 eval/runEval()，免去
 * 手写大量回归用例 + 实现弱网/离线开发场景下的 dry-run。
 *
 * 与 proxy-server.ts 的耦合方式：
 *   - 模块级单例 `flowRecorder`，默认 disabled（emit 是 O(0) 早退）
 *   - proxy-server 在 2 个点调用：onRequest / onFinish
 *   - 录制器内部按 flowId 缓冲请求段，待 finish 时合并落盘（JSONL append）
 *
 * 不录什么（v1）：
 *   - SSE 增量 chunk（reassemble 需要解析 anthropic SSE，体积大；后续按需）
 *   - 鉴权头（含 token，安全考虑）
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import { mkdir, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** 录制流 JSONL 单行结构（一条完整请求-响应对） */
export interface RecordedFlow {
  flowId: string
  /** 请求接收时间戳 ms */
  startedAt: number
  /** finish 完成时间戳 ms */
  finishedAt: number
  durationMs: number
  conversationId: string
  /** 是否是 SSE 流式请求 */
  stream: boolean
  request: {
    /** Anthropic Messages API JSON body（不含 Authorization 头） */
    body: Record<string, unknown>
  }
  response: {
    /** 'json' / 'sse' / 'error' */
    kind: 'json' | 'sse' | 'error'
    /** kind=json 时的最终 JSON body（finish 阶段写入） */
    json?: unknown
    /** kind=error 时的错误字符串 */
    error?: string
    /** kind=sse 时是否成功完成（无 error） */
    sseOk?: boolean
  }
}

interface PendingFlow {
  flowId: string
  startedAt: number
  conversationId: string
  stream: boolean
  body: Record<string, unknown>
}

class FlowRecorder {
  private enabled = false
  private outputPath: string | null = null
  private pending = new Map<string, PendingFlow>()

  /** 启用录制并指定 JSONL 输出路径（不存在则递归创建父目录） */
  async enable(outputPath: string): Promise<void> {
    this.outputPath = outputPath
    const dir = dirname(outputPath)
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    this.enabled = true
  }

  disable(): void {
    this.enabled = false
    this.outputPath = null
    this.pending.clear()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** proxy-server 收到请求时调用：缓冲 request 段 */
  onRequest(flowId: string, info: { conversationId: string; stream: boolean; body: Record<string, unknown> }): void {
    if (!this.enabled) return
    this.pending.set(flowId, {
      flowId,
      startedAt: Date.now(),
      conversationId: info.conversationId,
      stream: info.stream,
      body: info.body,
    })
  }

  /** proxy-server 在 finish handler 内调用：合并 response 段并 append JSONL 一行 */
  async onFinish(flowId: string, payload: { error?: string; json?: unknown }): Promise<void> {
    if (!this.enabled || !this.outputPath) return
    const pending = this.pending.get(flowId)
    if (!pending) return
    this.pending.delete(flowId)

    const finishedAt = Date.now()
    let response: RecordedFlow['response']
    if (payload.error) {
      response = { kind: 'error', error: payload.error }
    } else if (payload.json !== undefined) {
      response = { kind: 'json', json: payload.json }
    } else {
      response = { kind: 'sse', sseOk: true }
    }

    const flow: RecordedFlow = {
      flowId,
      startedAt: pending.startedAt,
      finishedAt,
      durationMs: finishedAt - pending.startedAt,
      conversationId: pending.conversationId,
      stream: pending.stream,
      request: { body: pending.body },
      response,
    }

    try {
      await appendFile(this.outputPath, JSON.stringify(flow) + '\n', 'utf8')
    } catch (e) {
      // 录制器永远不影响主链路；只 warn
      console.warn('[flow-recorder] append failed:', e instanceof Error ? e.message : String(e))
    }
  }

  /** 测试用：当前缓冲中的 pending 数 */
  pendingCount(): number {
    return this.pending.size
  }
}

export const flowRecorder = new FlowRecorder()
