/**
 * 豆包流式 ASR 主进程会话。
 *
 * 主进程负责 WebSocket 鉴权与协议帧收发；渲染进程只上传 16kHz PCM 分片。
 *
 * @author zhi.qu
 * @date 2026-05-10
 */

import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import {
  DoubaoAsrMessageType,
  buildDoubaoAsrAudioOnlyRequest,
  buildDoubaoAsrFullClientRequest,
  parseDoubaoAsrServerResponse,
  type JsonObject,
} from '../../packages/core/src/audio/doubao-asr-protocol'
import type { Logger } from './logger'

export const DOUBAO_ASR_DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'
export const DOUBAO_ASR_API_KEY_SETTING = 'doubao_asr_api_key'
export const DOUBAO_ASR_RESOURCE_ID_SETTING = 'doubao_asr_resource_id'
export const DOUBAO_ASR_ENDPOINT_SETTING = 'doubao_asr_endpoint'
export const DOUBAO_ASR_MODEL_SETTING = 'doubao_asr_model'

const SOCKET_OPEN_STATE = 1
const SOCKET_OPEN_TIMEOUT_MS = 10_000
const SOCKET_CLOSE_AFTER_STOP_MS = 800

export interface DoubaoAsrSessionStartResult {
  readonly requestId: string
  readonly endpoint: string
}

export interface DoubaoAsrPartialPayload {
  readonly requestId: string
  readonly text: string
  readonly isFinal: boolean
}

export interface DoubaoAsrErrorPayload {
  readonly requestId: string
  readonly message: string
}

export interface DoubaoAsrEndPayload {
  readonly requestId: string
  readonly reason: 'stopped' | 'cancelled' | 'error' | 'server-final' | 'closed'
}

export interface DoubaoAsrSocketLike {
  readonly readyState: number
  send(data: Buffer, callback?: (error?: Error) => void): void
  close(code?: number, reason?: string | Buffer): void
  terminate(): void
  on(event: 'open', listener: () => void): this
  on(event: 'message', listener: (data: RawData) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this
}

export type DoubaoAsrSocketFactory = (
  endpoint: string,
  options: { readonly headers: Record<string, string> },
) => DoubaoAsrSocketLike

export interface DoubaoAsrSessionOptions {
  readonly getSetting: (key: string) => string | undefined
  readonly webContents: WebContents
  readonly logger: Logger
  readonly socketFactory?: DoubaoAsrSocketFactory
  readonly requestIdFactory?: () => string
  readonly onEnd?: (session: DoubaoAsrSession, payload: DoubaoAsrEndPayload) => void
}

interface DoubaoAsrSettings {
  readonly apiKey: string
  readonly resourceId: string
  readonly endpoint: string
  readonly modelName: string
}

const defaultSocketFactory: DoubaoAsrSocketFactory = (endpoint, options) => new WebSocket(endpoint, { headers: options.headers })

export class DoubaoAsrSession {
  private readonly getSetting: (key: string) => string | undefined
  private readonly webContents: WebContents
  private readonly logger: Logger
  private readonly socketFactory: DoubaoAsrSocketFactory
  private readonly requestIdFactory: () => string
  private readonly onEnd?: (session: DoubaoAsrSession, payload: DoubaoAsrEndPayload) => void
  private readonly requestId: string
  private socket: DoubaoAsrSocketLike | null = null
  // 豆包服务端会把 full client request 计为 sequence=1；首个 audio-only 包必须从 2 开始。
  private sequence = 2
  private ended = false
  private closeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: DoubaoAsrSessionOptions) {
    this.getSetting = options.getSetting
    this.webContents = options.webContents
    this.logger = options.logger
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
    this.requestIdFactory = options.requestIdFactory ?? randomUUID
    this.onEnd = options.onEnd
    this.requestId = this.requestIdFactory()
  }

  get active(): boolean {
    return !this.ended
  }

  async start(): Promise<DoubaoAsrSessionStartResult> {
    const settings = this.readSettings()
    const headers = {
      'X-Api-Key': settings.apiKey,
      'X-Api-Resource-Id': settings.resourceId,
      'X-Api-Request-Id': this.requestId,
      'X-Api-Sequence': '-1',
    }
    const socket = this.socketFactory(settings.endpoint, { headers })
    this.socket = socket
    this.bindSocket(socket)

    await waitForSocketOpen(socket, SOCKET_OPEN_TIMEOUT_MS)
    this.sendFrame(buildDoubaoAsrFullClientRequest({
      request: { model_name: settings.modelName },
      audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
      compression: 'gzip',
    }))
    this.logger.activity('doubao-asr:start', `requestId=${this.requestId}`)
    return { requestId: this.requestId, endpoint: settings.endpoint }
  }

  pushPcm(audio: Uint8Array): void {
    if (this.ended) throw new Error('豆包 ASR 会话已结束')
    if (audio.byteLength === 0) return
    this.sendFrame(buildDoubaoAsrAudioOnlyRequest({
      audio,
      sequence: this.sequence,
      compression: 'gzip',
    }))
    this.sequence += 1
  }

  stop(): void {
    if (this.ended) return
    try {
      this.sendFrame(buildDoubaoAsrAudioOnlyRequest({
        audio: new Uint8Array(),
        sequence: this.sequence,
        last: true,
        compression: 'gzip',
      }))
    } catch (error) {
      this.handleSocketError(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.closeTimer = setTimeout(() => {
      this.socket?.close(1000, 'asr-stop')
      this.finish('stopped')
    }, SOCKET_CLOSE_AFTER_STOP_MS)
  }

  cancel(): void {
    if (this.ended) return
    this.socket?.terminate()
    this.finish('cancelled')
  }

  private readSettings(): DoubaoAsrSettings {
    const apiKey = this.getSetting(DOUBAO_ASR_API_KEY_SETTING)?.trim() ?? ''
    const resourceId = this.getSetting(DOUBAO_ASR_RESOURCE_ID_SETTING)?.trim() ?? ''
    const endpoint = this.getSetting(DOUBAO_ASR_ENDPOINT_SETTING)?.trim() || DOUBAO_ASR_DEFAULT_ENDPOINT
    const modelName = this.getSetting(DOUBAO_ASR_MODEL_SETTING)?.trim() || 'bigmodel'
    if (!apiKey) throw new Error('豆包 ASR API Key 未配置')
    if (!resourceId) throw new Error('豆包 ASR Resource Id 未配置')
    if (!endpoint.startsWith('wss://')) throw new Error('豆包 ASR endpoint 必须使用 wss://')
    return { apiKey, resourceId, endpoint, modelName }
  }

  private bindSocket(socket: DoubaoAsrSocketLike): void {
    socket.on('message', (data) => this.handleSocketMessage(data))
    socket.on('error', (error) => this.handleSocketError(error))
    socket.on('close', () => this.finish('closed'))
  }

  private handleSocketMessage(data: RawData): void {
    try {
      const parsed = parseDoubaoAsrServerResponse(rawDataToUint8Array(data))
      if (parsed.messageType === DoubaoAsrMessageType.ErrorResponse) {
        const message = extractDoubaoAsrErrorMessage(parsed.payload) ?? `豆包 ASR 服务端错误: ${parsed.errorCode ?? 'unknown'}`
        this.emitError(message)
        this.finish('error')
        return
      }

      const text = extractDoubaoAsrTranscript(parsed.payload)
      const isFinal = typeof parsed.sequence === 'number' && parsed.sequence < 0
      if (text) {
        this.sendToRenderer('asr:partial', { requestId: this.requestId, text, isFinal })
      }
      if (isFinal) this.finish('server-final')
    } catch (error) {
      this.handleSocketError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handleSocketError(error: Error): void {
    this.logger.error('doubao-asr', error)
    this.emitError(error.message)
    this.finish('error')
  }

  private sendFrame(frame: Buffer): void {
    const socket = this.socket
    if (!socket || socket.readyState !== SOCKET_OPEN_STATE) {
      throw new Error('豆包 ASR WebSocket 未连接')
    }
    socket.send(frame, (error?: Error) => {
      if (error) this.handleSocketError(error)
    })
  }

  private emitError(message: string): void {
    this.sendToRenderer('asr:error', { requestId: this.requestId, message })
  }

  private finish(reason: DoubaoAsrEndPayload['reason']): void {
    if (this.ended) return
    this.ended = true
    if (this.closeTimer) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    const payload = { requestId: this.requestId, reason }
    this.sendToRenderer('asr:end', payload)
    this.onEnd?.(this, payload)
  }

  private sendToRenderer(channel: 'asr:partial', payload: DoubaoAsrPartialPayload): void
  private sendToRenderer(channel: 'asr:error', payload: DoubaoAsrErrorPayload): void
  private sendToRenderer(channel: 'asr:end', payload: DoubaoAsrEndPayload): void
  private sendToRenderer(channel: string, payload: DoubaoAsrPartialPayload | DoubaoAsrErrorPayload | DoubaoAsrEndPayload): void {
    if (!this.webContents.isDestroyed()) {
      this.webContents.send(channel, payload)
    }
  }
}

export function extractDoubaoAsrTranscript(payload: unknown): string | null {
  const texts = collectTextValues(payload, new Set(['text', 'transcript']), 0)
  const joined = texts.join('').trim()
  return joined.length > 0 ? joined : null
}

function extractDoubaoAsrErrorMessage(payload: unknown): string | null {
  const texts = collectTextValues(payload, new Set(['message', 'error', 'msg', 'text']), 0)
  const joined = texts.join(' ').trim()
  return joined.length > 0 ? joined : null
}

function collectTextValues(payload: unknown, allowedKeys: ReadonlySet<string>, depth: number): string[] {
  if (depth > 5 || payload === null || payload === undefined) return []
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => collectTextValues(item, allowedKeys, depth + 1))
  }
  if (!isJsonRecord(payload)) return []

  const values: string[] = []
  for (const [key, value] of Object.entries(payload)) {
    if (allowedKeys.has(key) && typeof value === 'string' && value.trim()) {
      values.push(value.trim())
      continue
    }
    if (key === 'result' || key === 'utterances' || key === 'sentences' || key === 'data') {
      values.push(...collectTextValues(value, allowedKeys, depth + 1))
    }
  }
  return values
}

function isJsonRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rawDataToUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return Buffer.concat(data)
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function waitForSocketOpen(socket: DoubaoAsrSocketLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('豆包 ASR WebSocket 连接超时'))
    }, timeoutMs)

    socket.on('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    })
    socket.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}
