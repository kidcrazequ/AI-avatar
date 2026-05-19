/**
 * flow-recorder.test.ts
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test electron/flow-recorder.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowRecorder } from './flow-recorder'

test('disabled 状态：onRequest / onFinish 无副作用', async () => {
  flowRecorder.disable()
  flowRecorder.onRequest('j1', { conversationId: 'c', stream: true, body: { x: 1 } })
  await flowRecorder.onFinish('j1', { json: { y: 2 } })
  assert.strictEqual(flowRecorder.pendingCount(), 0)
  assert.strictEqual(flowRecorder.isEnabled(), false)
})

test('enable 后写 JSONL：JSON 响应', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-rec-'))
  const path = join(dir, 'flows.jsonl')
  await flowRecorder.enable(path)
  flowRecorder.onRequest('j1', {
    conversationId: 'conv-1',
    stream: false,
    body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
  })
  await flowRecorder.onFinish('j1', { json: { content: [{ type: 'text', text: 'hello' }] } })
  flowRecorder.disable()

  const content = await readFile(path, 'utf8')
  const line = JSON.parse(content.trim())
  assert.strictEqual(line.flowId, 'j1')
  assert.strictEqual(line.conversationId, 'conv-1')
  assert.strictEqual(line.response.kind, 'json')
  assert.ok(line.durationMs >= 0)
})

test('error 响应分支', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-rec-'))
  const path = join(dir, 'flows.jsonl')
  await flowRecorder.enable(path)
  flowRecorder.onRequest('e1', { conversationId: 'c', stream: false, body: {} })
  await flowRecorder.onFinish('e1', { error: 'boom' })
  flowRecorder.disable()

  const line = JSON.parse((await readFile(path, 'utf8')).trim())
  assert.strictEqual(line.response.kind, 'error')
  assert.strictEqual(line.response.error, 'boom')
})

test('SSE 模式（无 error/json）→ kind=sse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-rec-'))
  const path = join(dir, 'flows.jsonl')
  await flowRecorder.enable(path)
  flowRecorder.onRequest('s1', { conversationId: 'c', stream: true, body: {} })
  await flowRecorder.onFinish('s1', {})
  flowRecorder.disable()

  const line = JSON.parse((await readFile(path, 'utf8')).trim())
  assert.strictEqual(line.response.kind, 'sse')
  assert.strictEqual(line.response.sseOk, true)
  assert.strictEqual(line.stream, true)
})

test('未对齐的 onFinish（无对应 onRequest）静默忽略', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-rec-'))
  const path = join(dir, 'flows.jsonl')
  await flowRecorder.enable(path)
  await flowRecorder.onFinish('ghost', { json: {} })
  flowRecorder.disable()
  // 文件不应被创建（除非父目录 mkdir 失败；此处 mkdir 已成功，所以文件存在但为空）
  // 我们只断言"没行被 append"
  const content = await readFile(path, 'utf8').catch(() => '')
  assert.strictEqual(content, '')
})
