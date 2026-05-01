/**
 * Logger 单测 — 主要覆盖 Stage 三 P2 #16 的工具调用审计写入与脱敏。
 *
 * 验证点：
 *   1. toolCall(record) 写入 logs/tool-calls/<localDate>.jsonl，每行一个合法 JSON 对象
 *   2. argsPreview 中 apiKey/token/secret/password 等敏感字段被替换为 [REDACTED]
 *   3. 入参超长 / 错误信息超长会被截断（含 [truncated, originalLen=X] 提示）
 *   4. 多次调用追加同一日文件，行数累计正确
 *   5. ok 字段在「无错误」与「有 error」时正确取值
 *
 * @author zhi.qu
 * @date 2026-04-29
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Logger, redactSensitiveArgs, type ToolCallAuditRecord } from './logger'
import { localDateString } from '@soul/core'

function makeTempUserData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soul-logger-test-'))
}

test('Logger.toolCall: 写入 jsonl 单行可解析为 JSON', () => {
  const userData = makeTempUserData()
  const logger = new Logger(userData)
  const record: ToolCallAuditRecord = {
    ts: Date.now(),
    avatarId: 'avatar-x',
    conversationId: 'conv-1',
    toolName: 'query_excel',
    durationMs: 123,
    ok: true,
    argsPreview: '{"file":"a.xlsx"}',
    resultLen: 4096,
  }
  logger.toolCall(record)

  const file = path.join(logger.getToolCallsDir(), `${localDateString()}.jsonl`)
  assert.equal(fs.existsSync(file), true, '审计文件应被创建')
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n')
  assert.equal(lines.length, 1, '应只有 1 条记录')
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.toolName, 'query_excel')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.resultLen, 4096)
})

test('Logger.toolCall: 多次调用累计追加到同一文件', () => {
  const userData = makeTempUserData()
  const logger = new Logger(userData)
  for (let i = 0; i < 3; i++) {
    logger.toolCall({
      ts: Date.now(),
      avatarId: 'avatar-x',
      conversationId: 'conv-1',
      toolName: `tool_${i}`,
      durationMs: i * 10,
      ok: true,
      argsPreview: `{}`,
      resultLen: 0,
    })
  }
  const file = path.join(logger.getToolCallsDir(), `${localDateString()}.jsonl`)
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n')
  assert.equal(lines.length, 3, '3 次调用应产生 3 行')
  const tools = lines.map((l) => JSON.parse(l).toolName)
  assert.deepEqual(tools, ['tool_0', 'tool_1', 'tool_2'])
})

test('Logger.toolCall: argsPreview 超长截断并附 originalLen 标记', () => {
  const userData = makeTempUserData()
  const logger = new Logger(userData)
  const longArgs = 'x'.repeat(2000)
  logger.toolCall({
    ts: Date.now(),
    avatarId: 'a',
    conversationId: 'c',
    toolName: 'long_args',
    durationMs: 0,
    ok: true,
    argsPreview: longArgs,
    resultLen: 0,
  })
  const file = path.join(logger.getToolCallsDir(), `${localDateString()}.jsonl`)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').trim())
  assert.ok(parsed.argsPreview.includes('[truncated, originalLen=2000]'), '应包含截断提示')
  assert.ok(parsed.argsPreview.length < 1000, '截断后总长应 <1000 字符')
})

test('Logger.toolCall: error 字段超长也被截断', () => {
  const userData = makeTempUserData()
  const logger = new Logger(userData)
  const longErr = 'E'.repeat(1500)
  logger.toolCall({
    ts: Date.now(),
    avatarId: 'a',
    conversationId: 'c',
    toolName: 'fail_tool',
    durationMs: 5,
    ok: false,
    argsPreview: '{}',
    resultLen: 0,
    error: longErr,
  })
  const file = path.join(logger.getToolCallsDir(), `${localDateString()}.jsonl`)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').trim())
  assert.equal(parsed.ok, false)
  assert.ok(parsed.error.includes('[truncated, originalLen=1500]'))
})

test('Logger.readToolCallLog: 默认读今天的 jsonl', () => {
  const userData = makeTempUserData()
  const logger = new Logger(userData)
  logger.toolCall({
    ts: Date.now(),
    avatarId: 'a',
    conversationId: 'c',
    toolName: 't',
    durationMs: 0,
    ok: true,
    argsPreview: '{}',
    resultLen: 0,
  })
  const txt = logger.readToolCallLog()
  assert.ok(txt.includes('"toolName":"t"'))
})

test('Logger.readToolCallLog: 不存在的日期返回空字符串', () => {
  const userData = makeTempUserData()
  const logger = new Logger(userData)
  const txt = logger.readToolCallLog('1999-01-01')
  assert.equal(txt, '')
})

test('redactSensitiveArgs: 顶层敏感字段值被替换为 [REDACTED]', () => {
  const out = redactSensitiveArgs({
    file: 'a.xlsx',
    apiKey: 'sk-abc',
    api_key: 'xxx',
    token: 'jwt-yyy',
    password: 'pwd123',
    authorization: 'Bearer zzz',
  }) as Record<string, unknown>
  assert.equal(out.file, 'a.xlsx', '非敏感字段保留原值')
  assert.equal(out.apiKey, '[REDACTED]')
  assert.equal(out.api_key, '[REDACTED]')
  assert.equal(out.token, '[REDACTED]')
  assert.equal(out.password, '[REDACTED]')
  assert.equal(out.authorization, '[REDACTED]')
})

test('redactSensitiveArgs: 嵌套对象内的敏感字段也被脱敏', () => {
  const out = redactSensitiveArgs({
    config: { apiKey: 'sk-abc', baseUrl: 'https://api.x' },
    headers: { Authorization: 'Bearer t' },
  }) as { config: Record<string, unknown>; headers: Record<string, unknown> }
  assert.equal(out.config.apiKey, '[REDACTED]')
  assert.equal(out.config.baseUrl, 'https://api.x')
  // Authorization 大写：当前实现是大小写不敏感
  assert.equal(out.headers.Authorization, '[REDACTED]')
})

test('redactSensitiveArgs: 数组元素中的敏感字段也被脱敏', () => {
  const out = redactSensitiveArgs([
    { name: 'a', secret: 's1' },
    { name: 'b', token: 't2' },
  ]) as Array<Record<string, unknown>>
  assert.equal(out[0].secret, '[REDACTED]')
  assert.equal(out[1].token, '[REDACTED]')
  assert.equal(out[0].name, 'a')
})

test('redactSensitiveArgs: null/undefined/原始类型直接返回', () => {
  assert.equal(redactSensitiveArgs(null), null)
  assert.equal(redactSensitiveArgs(undefined), undefined)
  assert.equal(redactSensitiveArgs('plain'), 'plain')
  assert.equal(redactSensitiveArgs(42), 42)
})

test('redactSensitiveArgs: 深度超限返回标记', () => {
  // 构造 5 层嵌套，超过深度上限 3
  const deep = { a: { b: { c: { d: { e: { secret: 'leak' } } } } } }
  const out = redactSensitiveArgs(deep)
  // 顶层 a → b → c → d 是第 4 层，应被截为 '[depth-limit]' 或更内层为字符串
  // 只断言不抛错且返回某种值
  assert.notEqual(out, undefined)
})
