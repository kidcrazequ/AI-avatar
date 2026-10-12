/**
 * cn_web_search（wigolo 边车）单测。
 *
 * 意图（WHY）：cn_web_search 的价值主张是"诚实降级 + 字节级溯源透传"
 * （docs/wigolo-cn-search-plan.md）。钉死三条纪律：
 *   1. 边车不可用时把 bridge 的 detail 原样透给 LLM 并提示 web_search 兜底——
 *      绝不伪装成"搜索无结果"（占位比拒答更伤信任）
 *   2. 联网总开关是防御性闸门（同 web_search 双层保护，绕过上层过滤也兜得住）
 *   3. 结果映射保留 citation_id / source_span / 引擎遥测（failed_engines 不隐藏），
 *      excerpt 按 800 字符纪律截断
 *
 * 运行：
 *   npx tsx --test packages/core/src/tests/cn-web-search.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import http from 'http'
import type { AddressInfo } from 'net'
import { ToolRouter } from '../tool-router'

const AVATAR_ID = 'cnsearch-test'

function setupSandbox(): { avatarsPath: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-cnsearch-'))
  const avatarsPath = path.join(root, 'avatars')
  fs.mkdirSync(path.join(avatarsPath, AVATAR_ID), { recursive: true })
  return {
    avatarsPath,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ } },
  }
}

/** 联网开关打开的 getSetting 假实现 */
const webEnabledSetting = (key: string): string | undefined =>
  key === 'web_search_enabled' ? 'true' : undefined

test('缺 query / 联网开关关闭 → 明确错误（防御性闸门）', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const routerOff = new ToolRouter(avatarsPath, {
      getSetting: () => undefined,
      wigoloBridge: { ensureReady: async () => ({ ok: true, baseUrl: 'http://127.0.0.1:9' }) },
    })
    const noQuery = await routerOff.execute(AVATAR_ID, { name: 'cn_web_search', arguments: {} })
    assert.match(noQuery.error ?? '', /缺少 query/)

    const gateClosed = await routerOff.execute(AVATAR_ID, { name: 'cn_web_search', arguments: { query: '储能' } })
    assert.match(gateClosed.error ?? '', /联网功能未启用/, '开关关闭必须拦截，即使 bridge 可用')
  } finally {
    cleanup()
  }
})

test('bridge 未注入 → 部署配置错误，不伪装成空结果', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const router = new ToolRouter(avatarsPath, { getSetting: webEnabledSetting })
    const res = await router.execute(AVATAR_ID, { name: 'cn_web_search', arguments: { query: '储能' } })
    assert.match(res.error ?? '', /未注入 wigolo 边车桥/)
    assert.equal(res.content, '')
  } finally {
    cleanup()
  }
})

test('边车不可用 → detail 原样透传 + web_search 兜底提示（诚实降级红线）', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const router = new ToolRouter(avatarsPath, {
      getSetting: webEnabledSetting,
      wigoloBridge: {
        ensureReady: async () => ({ ok: false, detail: 'wigolo 未安装：请运行 npx wigolo init --no-warmup' }),
      },
    })
    const res = await router.execute(AVATAR_ID, { name: 'cn_web_search', arguments: { query: '储能' } })
    assert.match(res.error ?? '', /wigolo 未安装：请运行 npx wigolo init --no-warmup/, 'detail 必须原样可见')
    assert.match(res.error ?? '', /web_search/, '必须给出兜底路径')
    assert.equal(res.content, '', '不可用时绝不返回看似成功的空 content')
  } finally {
    cleanup()
  }
})

test('happy path：映射 citation/span/score，excerpt 截断，引擎遥测透传', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  let receivedBody = ''
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      receivedBody = raw
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        results: [
          {
            title: '峰谷价差政策解读',
            url: 'https://example.cn/a',
            excerpt: 'x'.repeat(900),
            citation_id: 'src-1',
            source_span: { start: 1042, end: 1305 },
            evidence_score: { final: 0.8617, semantic: 0.91 },
          },
          { title: '第二条', url: 'https://example.cn/b', excerpt: '短摘要' },
        ],
        engines_used: ['bing-cn', 'csdn'],
        failed_engines: [{ engine: 'duckduckgo', reason: 'timeout' }],
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const router = new ToolRouter(avatarsPath, {
      getSetting: webEnabledSetting,
      wigoloBridge: { ensureReady: async () => ({ ok: true, baseUrl }) },
    })
    const res = await router.execute(AVATAR_ID, { name: 'cn_web_search', arguments: { query: '峰谷价差', max_results: 2 } })
    assert.equal(res.error, undefined, `不应报错: ${res.error ?? ''}`)

    const sent = JSON.parse(receivedBody) as { query: string; max_results: number }
    assert.equal(sent.query, '峰谷价差')
    assert.equal(sent.max_results, 2)

    const payload = JSON.parse(res.content) as {
      result_count: number
      results: Array<{ excerpt: string; citation_id?: string; source_span?: { start: number }; score?: number }>
      engines_used?: string[]
      failed_engines?: unknown
      hint: string
    }
    assert.equal(payload.result_count, 2)
    // 溯源字段必须保留——这是 cn_web_search 相对 Tavily 的核心价值
    assert.equal(payload.results[0].citation_id, 'src-1')
    assert.equal(payload.results[0].source_span?.start, 1042)
    assert.equal(payload.results[0].score, 0.862)
    // 800 字符截断纪律
    assert.ok(payload.results[0].excerpt.endsWith('...[已截断]'))
    assert.ok(payload.results[0].excerpt.length <= 800 + 10)
    // 引擎遥测如实透传（失败引擎不隐藏）
    assert.deepEqual(payload.engines_used, ['bing-cn', 'csdn'])
    assert.ok(payload.failed_engines, 'failed_engines 必须透传')
    assert.match(payload.hint, /citation_id/, 'hint 应引导溯源引用')
  } finally {
    server.close()
    cleanup()
  }
})

test('边车 5xx → 错误标注状态码 + 兜底提示，不吞异常', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  const server = http.createServer((_req, res) => {
    res.statusCode = 500
    res.end('internal error')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const router = new ToolRouter(avatarsPath, {
      getSetting: webEnabledSetting,
      wigoloBridge: { ensureReady: async () => ({ ok: true, baseUrl }) },
    })
    const res = await router.execute(AVATAR_ID, { name: 'cn_web_search', arguments: { query: '储能' } })
    assert.match(res.error ?? '', /500/)
    assert.match(res.error ?? '', /web_search 兜底/)
  } finally {
    server.close()
    cleanup()
  }
})
