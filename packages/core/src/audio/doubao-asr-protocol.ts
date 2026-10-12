/**
 * 豆包大模型流式 ASR WebSocket 二进制协议打包与解析。
 *
 * 本模块只处理协议层纯逻辑：构建 full client request、audio-only request，
 * 以及解析 full server response / error response。真实 WebSocket 连接、鉴权、
 * 重连和 UI 状态均由上层会话模块负责。
 *
 * @author zhi.qu
 * @date 2026-05-10
 */

import { gzipSync, gunzipSync } from 'node:zlib'

export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

export type DoubaoAsrCompression = 'none' | 'gzip'

export interface DoubaoAsrAudioMetadata {
  readonly language?: string
  readonly format?: 'pcm' | 'wav' | 'ogg' | 'mp3'
  readonly codec?: 'raw' | 'opus'
  readonly rate?: 16000
  readonly bits?: 16
  readonly channel?: 1 | 2
}

export interface DoubaoAsrFullClientRequestOptions {
  readonly user?: JsonObject
  readonly audio?: DoubaoAsrAudioMetadata
  readonly request?: JsonObject
  readonly extraFields?: JsonObject
  readonly compression?: DoubaoAsrCompression
}

export interface DoubaoAsrAudioOnlyRequestOptions {
  readonly audio: Uint8Array
  readonly sequence?: number
  readonly last?: boolean
  readonly compression?: DoubaoAsrCompression
}

export interface DoubaoAsrParsedServerResponse {
  readonly messageType: DoubaoAsrMessageType
  readonly flags: DoubaoAsrMessageFlags
  readonly serialization: DoubaoAsrSerialization
  readonly compression: DoubaoAsrCompressionCode
  readonly sequence?: number
  readonly payloadSize: number
  readonly payloadBuffer: Buffer
  readonly payload: unknown
  readonly errorCode?: number
}

export enum DoubaoAsrMessageType {
  FullClientRequest = 0x1,
  AudioOnlyRequest = 0x2,
  FullServerResponse = 0x9,
  ErrorResponse = 0xf,
}

export enum DoubaoAsrMessageFlags {
  NoSequence = 0x0,
  PositiveSequence = 0x1,
  LastNoSequence = 0x2,
  NegativeSequence = 0x3,
}

export enum DoubaoAsrSerialization {
  None = 0x0,
  Json = 0x1,
}

export enum DoubaoAsrCompressionCode {
  None = 0x0,
  Gzip = 0x1,
}

export const DOUBAO_ASR_PROTOCOL_VERSION = 0x1
export const DOUBAO_ASR_BASE_HEADER_SIZE_WORDS = 0x1
export const DOUBAO_ASR_BASE_HEADER_SIZE_BYTES = DOUBAO_ASR_BASE_HEADER_SIZE_WORDS * 4
export const DOUBAO_ASR_DEFAULT_AUDIO: Required<Pick<DoubaoAsrAudioMetadata, 'format' | 'codec' | 'rate' | 'bits' | 'channel'>> = {
  format: 'pcm',
  codec: 'raw',
  rate: 16000,
  bits: 16,
  channel: 1,
}

const UINT32_BYTE_LENGTH = 4
const INT32_BYTE_LENGTH = 4
const DEFAULT_REQUEST_FIELDS: JsonObject = {
  model_name: 'bigmodel',
  enable_itn: true,
  enable_punc: true,
}

export class DoubaoAsrProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DoubaoAsrProtocolError'
  }
}

export function buildDoubaoAsrFullClientRequest(options: DoubaoAsrFullClientRequestOptions = {}): Buffer {
  const compression = toCompressionCode(options.compression ?? 'gzip')
  const payloadObject: JsonObject = {
    ...options.extraFields,
    user: options.user ?? {},
    audio: {
      ...DOUBAO_ASR_DEFAULT_AUDIO,
      ...options.audio,
    },
    request: {
      ...DEFAULT_REQUEST_FIELDS,
      ...options.request,
    },
  }
  const payload = encodeJsonPayload(payloadObject, compression)
  const header = buildHeader({
    messageType: DoubaoAsrMessageType.FullClientRequest,
    flags: DoubaoAsrMessageFlags.NoSequence,
    serialization: DoubaoAsrSerialization.Json,
    compression,
  })

  return concatFrameParts([header, writeUint32(payload.length), payload])
}

export function buildDoubaoAsrAudioOnlyRequest(options: DoubaoAsrAudioOnlyRequestOptions): Buffer {
  const compression = toCompressionCode(options.compression ?? 'gzip')
  const hasSequence = options.sequence !== undefined
  const flags = getAudioRequestFlags({ hasSequence, last: options.last === true })
  const payload = encodeBinaryPayload(options.audio, compression)
  const parts: Buffer[] = [
    buildHeader({
      messageType: DoubaoAsrMessageType.AudioOnlyRequest,
      flags,
      serialization: DoubaoAsrSerialization.None,
      compression,
    }),
  ]

  if (hasSequence) {
    parts.push(writeInt32(normalizeAudioSequence(options.sequence, options.last === true)))
  }
  parts.push(writeUint32(payload.length), payload)

  return concatFrameParts(parts)
}

export function parseDoubaoAsrServerResponse(input: Uint8Array): DoubaoAsrParsedServerResponse {
  const frame = Buffer.from(input)
  const header = parseHeader(frame)
  const offsetAfterHeader = DOUBAO_ASR_BASE_HEADER_SIZE_BYTES

  if (header.messageType === DoubaoAsrMessageType.ErrorResponse) {
    return parseErrorResponse(frame, header, offsetAfterHeader)
  }
  if (header.messageType !== DoubaoAsrMessageType.FullServerResponse) {
    throw new DoubaoAsrProtocolError(`不支持的豆包 ASR 服务端消息类型: ${header.messageType}`)
  }

  let offset = offsetAfterHeader
  const sequence = hasSequence(header.flags) ? readInt32(frame, offset, 'server response sequence') : undefined
  if (sequence !== undefined) {
    offset += INT32_BYTE_LENGTH
  }

  const payloadSize = readUint32(frame, offset, 'server response payload size')
  offset += UINT32_BYTE_LENGTH
  const payloadBuffer = readPayload(frame, offset, payloadSize)
  const decompressed = decodePayload(payloadBuffer, header.compression)

  return {
    messageType: header.messageType,
    flags: header.flags,
    serialization: header.serialization,
    compression: header.compression,
    sequence,
    payloadSize,
    payloadBuffer,
    payload: decodeSerializedPayload(decompressed, header.serialization),
  }
}

function parseErrorResponse(
  frame: Buffer,
  header: ParsedHeader,
  offsetAfterHeader: number,
): DoubaoAsrParsedServerResponse {
  const errorCode = readUint32(frame, offsetAfterHeader, 'error response code')
  const payloadSizeOffset = offsetAfterHeader + UINT32_BYTE_LENGTH
  const payloadSize = readUint32(frame, payloadSizeOffset, 'error response payload size')
  const payloadOffset = payloadSizeOffset + UINT32_BYTE_LENGTH
  const payloadBuffer = readPayload(frame, payloadOffset, payloadSize)
  const decompressed = decodePayload(payloadBuffer, header.compression)

  return {
    messageType: header.messageType,
    flags: header.flags,
    serialization: header.serialization,
    compression: header.compression,
    payloadSize,
    payloadBuffer,
    errorCode,
    payload: decodeSerializedPayload(decompressed, header.serialization),
  }
}

interface ParsedHeader {
  readonly messageType: DoubaoAsrMessageType
  readonly flags: DoubaoAsrMessageFlags
  readonly serialization: DoubaoAsrSerialization
  readonly compression: DoubaoAsrCompressionCode
}

function buildHeader(params: ParsedHeader): Buffer {
  return Buffer.from([
    (DOUBAO_ASR_PROTOCOL_VERSION << 4) | DOUBAO_ASR_BASE_HEADER_SIZE_WORDS,
    (params.messageType << 4) | params.flags,
    (params.serialization << 4) | params.compression,
    0x00,
  ])
}

function parseHeader(frame: Buffer): ParsedHeader {
  if (frame.length < DOUBAO_ASR_BASE_HEADER_SIZE_BYTES) {
    throw new DoubaoAsrProtocolError('豆包 ASR 协议帧过短，缺少 4 字节基础头')
  }

  const version = frame[0] >> 4
  const headerSizeWords = frame[0] & 0x0f
  if (version !== DOUBAO_ASR_PROTOCOL_VERSION) {
    throw new DoubaoAsrProtocolError(`不支持的豆包 ASR 协议版本: ${version}`)
  }
  if (headerSizeWords !== DOUBAO_ASR_BASE_HEADER_SIZE_WORDS) {
    throw new DoubaoAsrProtocolError(`不支持的豆包 ASR 头长度: ${headerSizeWords * 4}`)
  }

  return {
    messageType: (frame[1] >> 4) as DoubaoAsrMessageType,
    flags: (frame[1] & 0x0f) as DoubaoAsrMessageFlags,
    serialization: (frame[2] >> 4) as DoubaoAsrSerialization,
    compression: (frame[2] & 0x0f) as DoubaoAsrCompressionCode,
  }
}

function getAudioRequestFlags(params: { readonly hasSequence: boolean; readonly last: boolean }): DoubaoAsrMessageFlags {
  if (params.hasSequence && params.last) {
    return DoubaoAsrMessageFlags.NegativeSequence
  }
  if (params.hasSequence) {
    return DoubaoAsrMessageFlags.PositiveSequence
  }
  if (params.last) {
    return DoubaoAsrMessageFlags.LastNoSequence
  }
  return DoubaoAsrMessageFlags.NoSequence
}

function normalizeAudioSequence(sequence: number, last: boolean): number {
  if (!Number.isInteger(sequence) || sequence === 0) {
    throw new DoubaoAsrProtocolError('豆包 ASR audio-only sequence 必须是非零整数')
  }
  const absSequence = Math.abs(sequence)
  return last ? -absSequence : absSequence
}

function hasSequence(flags: DoubaoAsrMessageFlags): boolean {
  return flags === DoubaoAsrMessageFlags.PositiveSequence || flags === DoubaoAsrMessageFlags.NegativeSequence
}

function toCompressionCode(compression: DoubaoAsrCompression): DoubaoAsrCompressionCode {
  return compression === 'gzip' ? DoubaoAsrCompressionCode.Gzip : DoubaoAsrCompressionCode.None
}

function encodeJsonPayload(payload: JsonObject, compression: DoubaoAsrCompressionCode): Buffer {
  return encodeBinaryPayload(Buffer.from(JSON.stringify(payload), 'utf-8'), compression)
}

function encodeBinaryPayload(payload: Uint8Array, compression: DoubaoAsrCompressionCode): Buffer {
  const buffer = Buffer.from(payload)
  if (compression === DoubaoAsrCompressionCode.Gzip) {
    return gzipSync(buffer)
  }
  if (compression === DoubaoAsrCompressionCode.None) {
    return buffer
  }
  throw new DoubaoAsrProtocolError(`不支持的豆包 ASR 压缩方式: ${compression}`)
}

function decodePayload(payload: Buffer, compression: DoubaoAsrCompressionCode): Buffer {
  if (compression === DoubaoAsrCompressionCode.Gzip) {
    return gunzipSync(payload)
  }
  if (compression === DoubaoAsrCompressionCode.None) {
    return payload
  }
  throw new DoubaoAsrProtocolError(`不支持的豆包 ASR 压缩方式: ${compression}`)
}

function decodeSerializedPayload(payload: Buffer, serialization: DoubaoAsrSerialization): unknown {
  if (serialization === DoubaoAsrSerialization.Json) {
    return JSON.parse(payload.toString('utf-8')) as unknown
  }
  if (serialization === DoubaoAsrSerialization.None) {
    return payload.toString('utf-8')
  }
  throw new DoubaoAsrProtocolError(`不支持的豆包 ASR 序列化方式: ${serialization}`)
}

function readPayload(frame: Buffer, offset: number, size: number): Buffer {
  const end = offset + size
  if (frame.length < end) {
    throw new DoubaoAsrProtocolError(`豆包 ASR 协议帧过短，payload 声明 ${size} 字节但实际不足`)
  }
  return frame.subarray(offset, end)
}

function readUint32(frame: Buffer, offset: number, fieldName: string): number {
  if (frame.length < offset + UINT32_BYTE_LENGTH) {
    throw new DoubaoAsrProtocolError(`豆包 ASR 协议帧过短，缺少 ${fieldName}`)
  }
  return frame.readUInt32BE(offset)
}

function readInt32(frame: Buffer, offset: number, fieldName: string): number {
  if (frame.length < offset + INT32_BYTE_LENGTH) {
    throw new DoubaoAsrProtocolError(`豆包 ASR 协议帧过短，缺少 ${fieldName}`)
  }
  return frame.readInt32BE(offset)
}

function writeUint32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new DoubaoAsrProtocolError(`豆包 ASR payload size 超出 uint32 范围: ${value}`)
  }
  const buffer = Buffer.alloc(UINT32_BYTE_LENGTH)
  buffer.writeUInt32BE(value, 0)
  return buffer
}

function writeInt32(value: number): Buffer {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new DoubaoAsrProtocolError(`豆包 ASR sequence 超出 int32 范围: ${value}`)
  }
  const buffer = Buffer.alloc(INT32_BYTE_LENGTH)
  buffer.writeInt32BE(value, 0)
  return buffer
}

function concatFrameParts(parts: readonly Buffer[]): Buffer {
  return Buffer.concat(parts)
}
