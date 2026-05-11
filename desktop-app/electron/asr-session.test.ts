/**
 * 豆包流式 ASR 主进程会话单元测试。
 *
 * @author zhi.qu
 * @date 2026-05-10
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import { gzipSync } from 'node:zlib'
import type { WebContents } from 'electron'
import type { RawData } from 'ws'
import {
  DOUBAO_ASR_BASE_HEADER_SIZE_BYTES,
  DoubaoAsrCompressionCode,
  DoubaoAsrMessageFlags,
  DoubaoAsrMessageType,
  DoubaoAsrSerialization,
} from '../../packages/core/src/audio/doubao-asr-protocol'
import {
  DoubaoAsrSession,
  extractDoubaoAsrTranscript,
  type DoubaoAsrSocketFactory,
  type DoubaoAsrSocketLike,
} from './asr-session'
import type { Logger } from './logger'

describe('DoubaoAsrSession', () => {
  it('extractDoubaoAsrTranscript 兼容常见服务端文本字段', () => {
    assert.equal(extractDoubaoAsrTranscript({ result: { text: '你好' } }), '你好')
    assert.equal(extractDoubaoAsrTranscript({ text: '直接文本' }), '直接文本')
    assert.equal(extractDoubaoAsrTranscript({ utterances: [{ text: '你' }, { text: '好' }] }), '你好')
  })

  it('start 使用 settings 构造豆包鉴权 Header 并发送 full client request', async () => {
    const socket = new MockAsrSocket()
    let capturedEndpoint = ''
    let capturedHeaders: Record<string, string> = {}
    const factory: DoubaoAsrSocketFactory = (endpoint, options) => {
      capturedEndpoint = endpoint
      capturedHeaders = options.headers
      return socket
    }
    const session = createSession(factory)

    const started = session.start()
    socket.open()
    const result = await started

    assert.equal(result.requestId, 'request-001')
    assert.equal(capturedEndpoint, 'wss://example.test/asr')
    assert.equal(capturedHeaders['X-Api-Key'], 'test-key')
    assert.equal(capturedHeaders['X-Api-Resource-Id'], 'resource-001')
    assert.equal(capturedHeaders['X-Api-Request-Id'], 'request-001')
    assert.equal(capturedHeaders['X-Api-Sequence'], '-1')
    assert.equal(socket.sentFrames.length, 1)
    assert.equal(socket.sentFrames[0][1], 0x10)
    session.cancel()
  })

  it('pushPcm 发送 audio-only 分片，stop 发送 last 分片', async () => {
    const socket = new MockAsrSocket()
    const session = createSession(() => socket)

    const started = session.start()
    socket.open()
    await started

    session.pushPcm(new Uint8Array([1, 2, 3, 4]))
    session.stop()

    assert.equal(socket.sentFrames.length, 3)
    assert.equal(socket.sentFrames[1][1], 0x21)
    assert.equal(socket.sentFrames[1].readInt32BE(DOUBAO_ASR_BASE_HEADER_SIZE_BYTES), 2)
    assert.equal(socket.sentFrames[2][1], 0x23)
    assert.equal(socket.sentFrames[2].readInt32BE(DOUBAO_ASR_BASE_HEADER_SIZE_BYTES), -3)
    session.cancel()
  })

  it('收到服务端 partial 后向渲染端推送 asr:partial', async () => {
    const socket = new MockAsrSocket()
    const events: Array<{ channel: string; payload: unknown }> = []
    const session = createSession(() => socket, events)

    const started = session.start()
    socket.open()
    await started
    socket.emit('message', buildServerResponseFrame('你好'))

    assert.deepEqual(events[0], {
      channel: 'asr:partial',
      payload: { requestId: 'request-001', text: '你好', isFinal: false },
    })
    session.cancel()
  })
})

class MockAsrSocket extends EventEmitter implements DoubaoAsrSocketLike {
  readyState = 0
  readonly sentFrames: Buffer[] = []

  send(data: Buffer, callback?: (error?: Error) => void): void {
    this.sentFrames.push(data)
    callback?.()
  }

  close(): void {
    this.readyState = 3
    this.emit('close', 1000, Buffer.from('closed'))
  }

  terminate(): void {
    this.readyState = 3
    this.emit('close', 1000, Buffer.from('terminated'))
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  override on(event: 'open', listener: () => void): this
  override on(event: 'message', listener: (data: RawData) => void): this
  override on(event: 'error', listener: (error: Error) => void): this
  override on(event: 'close', listener: (code: number, reason: Buffer) => void): this
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener)
  }
}

function createSession(
  socketFactory: DoubaoAsrSocketFactory,
  events: Array<{ channel: string; payload: unknown }> = [],
): DoubaoAsrSession {
  const settings = new Map([
    ['doubao_asr_api_key', 'test-key'],
    ['doubao_asr_resource_id', 'resource-001'],
    ['doubao_asr_endpoint', 'wss://example.test/asr'],
    ['doubao_asr_model', 'bigmodel'],
  ])
  return new DoubaoAsrSession({
    getSetting: (key) => settings.get(key),
    logger: createLogger(),
    webContents: createWebContents(events),
    socketFactory,
    requestIdFactory: () => 'request-001',
  })
}

function createLogger(): Logger {
  return {
    activity: () => undefined,
    error: () => undefined,
  } as unknown as Logger
}

function createWebContents(events: Array<{ channel: string; payload: unknown }>): WebContents {
  return {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      events.push({ channel, payload })
    },
  } as unknown as WebContents
}

function buildServerResponseFrame(text: string): Buffer {
  const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text } }), 'utf-8'))
  const header = Buffer.from([
    0x11,
    (DoubaoAsrMessageType.FullServerResponse << 4) | DoubaoAsrMessageFlags.PositiveSequence,
    (DoubaoAsrSerialization.Json << 4) | DoubaoAsrCompressionCode.Gzip,
    0x00,
  ])
  const sequence = Buffer.alloc(4)
  sequence.writeInt32BE(1, 0)
  const payloadSize = Buffer.alloc(4)
  payloadSize.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, sequence, payloadSize, payload])
}
