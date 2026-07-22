/**
 * soul-proxy-client 单测（⑦ 适配器地基 · P-a）。
 *
 * 用一个 stub HTTP server 冒充 soul proxy——不需要真 app / 飞书，即可验证：
 *   - runViaSoulProxy 发出的请求契约正确（POST /v1/messages、Bearer 鉴权、
 *     x-soul-conversation-id 头、Anthropic 请求体）——契约错了适配器就收不到分身回复。
 *   - Anthropic 响应被正确解析成纯文本（这是要发回飞书的内容）。
 *   - 非 2xx 抛错，由适配器兜底而非静默返回空。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { runViaSoulProxy, extractAnthropicText } from './soul-proxy-client'

// ── extractAnthropicText 纯函数：容错 ──
test('extractAnthropicText 拼接多个 text 块、跳过非 text', () => {
  const json = { content: [{ type: 'text', text: '你好' }, { type: 'tool_use' }, { type: 'text', text: '，世界' }] }
  assert.equal(extractAnthropicText(json), '你好，世界')
})

test('extractAnthropicText 对畸形输入返回空串（不抛）', () => {
  assert.equal(extractAnthropicText(null), '')
  assert.equal(extractAnthropicText('x'), '')
  assert.equal(extractAnthropicText({}), '')
  assert.equal(extractAnthropicText({ content: 'nope' }), '')
  assert.equal(extractAnthropicText({ content: [{ type: 'text' }] }), '') // text 缺失
})

// ── runViaSoulProxy 端到端（对 stub proxy） ──
async function withStubProxy(
  handler: (captured: { method?: string; url?: string; headers: Record<string, string | string[] | undefined>; body: string }) => { status: number; json: unknown },
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const captured = { method: undefined as string | undefined, url: undefined as string | undefined, headers: {} as Record<string, string | string[] | undefined>, body: '' }
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      captured.method = req.method; captured.url = req.url; captured.headers = req.headers; captured.body = raw
      const out = handler(captured)
      const payload = JSON.stringify(out.json)
      res.writeHead(out.status, { 'Content-Type': 'application/json' })
      res.end(payload)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  // 断言请求契约
  assert.equal(captured.method, 'POST', 'must POST')
  assert.equal(captured.url, '/v1/messages', 'endpoint 必须是 /v1/messages')
  assert.equal(captured.headers['authorization'], 'Bearer tok-123', 'Bearer 鉴权头')
  assert.equal(captured.headers['x-soul-conversation-id'], 'conv-9', '会话头决定哪个分身应答')
  const parsedBody = JSON.parse(captured.body)
  assert.equal(parsedBody.stream, false, '非流式')
  assert.deepEqual(parsedBody.messages, [{ role: 'user', content: '帮我写周报' }], 'Anthropic 请求体含用户消息')
}

test('runViaSoulProxy：请求契约正确 + 解析出回复文本', async () => {
  await withStubProxy(
    () => ({ status: 200, json: { content: [{ type: 'text', text: '好的，周报如下：…' }] } }),
    async (baseUrl) => {
      const reply = await runViaSoulProxy({ baseUrl, token: 'tok-123', conversationId: 'conv-9', text: '帮我写周报' })
      assert.equal(reply, '好的，周报如下：…')
    },
  )
})

test('runViaSoulProxy：非 2xx 抛错（不静默返回空）', async () => {
  await assert.rejects(
    () => withStubProxy(
      () => ({ status: 401, json: { error: 'invalid_token' } }),
      async (baseUrl) => { await runViaSoulProxy({ baseUrl, token: 'tok-123', conversationId: 'conv-9', text: '帮我写周报' }) },
    ),
  )
})
