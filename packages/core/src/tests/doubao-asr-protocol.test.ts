/**
 * 豆包大模型流式 ASR WebSocket 二进制协议单元测试。
 *
 * 运行方式：
 *   cd packages/core && npx --yes tsx --test src/tests/doubao-asr-protocol.test.ts
 *
 * @author zhi.qu
 * @date 2026-05-10
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync, gunzipSync } from 'node:zlib'
import {
  DOUBAO_ASR_BASE_HEADER_SIZE_BYTES,
  DoubaoAsrCompressionCode,
  DoubaoAsrMessageFlags,
  DoubaoAsrMessageType,
  DoubaoAsrProtocolError,
  DoubaoAsrSerialization,
  buildDoubaoAsrAudioOnlyRequest,
  buildDoubaoAsrFullClientRequest,
  parseDoubaoAsrServerResponse,
} from '../audio/doubao-asr-protocol'

describe('doubao-asr-protocol', () => {
  it('full client request 应生成稳定头字段', () => {
    const frame = buildDoubaoAsrFullClientRequest({ compression: 'gzip' })

    assert.equal(frame[0], 0x11)
    assert.equal(frame[1], 0x10)
    assert.equal(frame[2], 0x11)
    assert.equal(frame[3], 0x00)
  })

  it('full client request payload size 应使用大端 uint32', () => {
    const frame = buildDoubaoAsrFullClientRequest({
      compression: 'none',
      request: { model_name: 'bigmodel', enable_itn: false },
    })
    const payload = frame.subarray(DOUBAO_ASR_BASE_HEADER_SIZE_BYTES + 4)

    assert.equal(frame.readUInt32BE(DOUBAO_ASR_BASE_HEADER_SIZE_BYTES), payload.length)
  })

  it('full client request gzip payload 可往返解压', () => {
    const frame = buildDoubaoAsrFullClientRequest({
      compression: 'gzip',
      user: { uid: 'user-001' },
    })
    const compressed = frame.subarray(DOUBAO_ASR_BASE_HEADER_SIZE_BYTES + 4)
    const jsonText = gunzipSync(compressed).toString('utf-8')

    assert.match(jsonText, /"uid":"user-001"/)
  })

  it('full client request 应包含默认 JSON 请求与 16k 16bit mono 音频参数', () => {
    const frame = buildDoubaoAsrFullClientRequest({ compression: 'none' })
    const payload = JSON.parse(frame.subarray(DOUBAO_ASR_BASE_HEADER_SIZE_BYTES + 4).toString('utf-8')) as {
      audio: { format: string; codec: string; rate: number; bits: number; channel: number }
      request: { model_name: string; enable_itn: boolean; enable_punc: boolean }
    }

    assert.deepEqual(payload.audio, { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 })
    assert.equal(payload.request.model_name, 'bigmodel')
    assert.equal(payload.request.enable_itn, true)
    assert.equal(payload.request.enable_punc, true)
  })

  it('audio-only 普通包应写入正序号和正序号标志', () => {
    const frame = buildDoubaoAsrAudioOnlyRequest({
      audio: Buffer.from([0x01, 0x02]),
      sequence: 7,
      compression: 'none',
    })

    assert.equal(frame[1], 0x21)
    assert.equal(frame.readInt32BE(DOUBAO_ASR_BASE_HEADER_SIZE_BYTES), 7)
    assert.equal(frame.readUInt32BE(DOUBAO_ASR_BASE_HEADER_SIZE_BYTES + 4), 2)
  })

  it('audio-only last 包应写入负序号和 last 标志', () => {
    const frame = buildDoubaoAsrAudioOnlyRequest({
      audio: Buffer.from([0x03]),
      sequence: 8,
      last: true,
      compression: 'none',
    })

    assert.equal(frame[1], 0x23)
    assert.equal(frame.readInt32BE(DOUBAO_ASR_BASE_HEADER_SIZE_BYTES), -8)
  })

  it('audio-only last 包无序号时应仅写入 last 标志', () => {
    const frame = buildDoubaoAsrAudioOnlyRequest({
      audio: Buffer.from([0x04]),
      last: true,
      compression: 'none',
    })

    assert.equal(frame[1], 0x22)
    assert.equal(frame.readUInt32BE(DOUBAO_ASR_BASE_HEADER_SIZE_BYTES), 1)
  })

  it('parse server response 应解析普通 JSON payload', () => {
    const response = buildServerResponseFrame({
      flags: DoubaoAsrMessageFlags.PositiveSequence,
      compression: DoubaoAsrCompressionCode.None,
      sequence: 2,
      payload: Buffer.from('{"result":[{"text":"你好"}]}', 'utf-8'),
    })

    const parsed = parseDoubaoAsrServerResponse(response)

    assert.equal(parsed.messageType, DoubaoAsrMessageType.FullServerResponse)
    assert.equal(parsed.sequence, 2)
    assert.deepEqual(parsed.payload, { result: [{ text: '你好' }] })
  })

  it('parse server response 应解析 gzip JSON payload', () => {
    const response = buildServerResponseFrame({
      flags: DoubaoAsrMessageFlags.NegativeSequence,
      compression: DoubaoAsrCompressionCode.Gzip,
      sequence: -3,
      payload: gzipSync(Buffer.from('{"result":[{"text":"结束"}]}', 'utf-8')),
    })

    const parsed = parseDoubaoAsrServerResponse(response)

    assert.equal(parsed.sequence, -3)
    assert.deepEqual(parsed.payload, { result: [{ text: '结束' }] })
  })

  it('过短 buffer 应抛出语义化协议错误', () => {
    assert.throws(
      () => parseDoubaoAsrServerResponse(Buffer.from([0x11, 0x91])),
      (error: unknown) => error instanceof DoubaoAsrProtocolError && /协议帧过短/.test(error.message),
    )
  })
})

function buildServerResponseFrame(params: {
  readonly flags: DoubaoAsrMessageFlags
  readonly compression: DoubaoAsrCompressionCode
  readonly sequence: number
  readonly payload: Buffer
}): Buffer {
  const header = Buffer.from([
    0x11,
    (DoubaoAsrMessageType.FullServerResponse << 4) | params.flags,
    (DoubaoAsrSerialization.Json << 4) | params.compression,
    0x00,
  ])
  const sequence = Buffer.alloc(4)
  sequence.writeInt32BE(params.sequence, 0)
  const payloadSize = Buffer.alloc(4)
  payloadSize.writeUInt32BE(params.payload.length, 0)

  return Buffer.concat([header, sequence, payloadSize, params.payload])
}
