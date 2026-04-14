/**
 * vision-ocr.ts 单元测试
 *
 * 覆盖：
 *   - 成功路径
 *   - Retry 成功（429 / 5xx / network）
 *   - Retry 耗尽失败（分类正确）
 *   - 4xx 不重试
 *   - truncated（finish_reason === 'length'）保留部分内容
 *   - Empty response retry
 *   - 连续 empty 失败
 *   - Retry-After 头被尊重
 *   - Overall timeout 触发
 *   - 并发不重复领任务
 *
 * 运行方式：
 *   cd packages/core && npm run build
 *   node --test dist/tests/vision-ocr.test.js
 *
 * @author zhi.qu
 * @date 2026-04-14
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { callVisionOcr } from '../utils/vision-ocr'

// ─── Mock fetch helper ──────────────────────────────────────────────────────

interface MockResponse {
  status: number
  body?: unknown
  /** 响应头（会被 fetchWithTimeout 规范化为小写 key 写入 HttpError.headers）*/
  headers?: Record<string, string>
  /** 响应前的延迟 ms（用于模拟慢响应）*/
  delayMs?: number
  /** 抛 network error 而不是返回 response */
  networkError?: boolean
}

/**
 * 创建一个按 call count 返回预设响应的 mock fetch。
 * 调用次数超过 responses 数组长度时，反复返回最后一项（方便无限失败场景）。
 */
function makeMockFetch(responses: MockResponse[]): (url: string, init?: RequestInit) => Promise<Response> {
  let call = 0
  return async (_url: string, _init?: RequestInit) => {
    const r = responses[Math.min(call, responses.length - 1)]
    call++
    if (r.delayMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, r.delayMs))
    }
    if (r.networkError) {
      throw new TypeError('fetch failed')
    }
    const bodyText = JSON.stringify(r.body ?? {})
    const headers = new Headers()
    if (r.headers) {
      for (const [k, v] of Object.entries(r.headers)) {
        headers.set(k, v)
      }
    }
    return new Response(bodyText, { status: r.status, headers })
  }
}

/** OpenAI Chat Completions 格式的成功响应 body */
function okBody(content: string, finishReason: string = 'stop'): unknown {
  return {
    choices: [
      {
        message: { content },
        finish_reason: finishReason,
      },
    ],
  }
}

/** 一个随机占位 base64 data URL，用作 images 数组元素（内容不重要，mock fetch 不真的读）*/
const FAKE_IMAGE = 'data:image/png;base64,AAAA'

/** 用 try/finally 包装测试，保证 globalThis.fetch 复原 */
async function withMockFetch(
  responses: MockResponse[],
  body: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  // @ts-expect-error -- mock fetch 返回类型与标准 fetch 兼容但签名更宽松
  globalThis.fetch = makeMockFetch(responses)
  try {
    await body()
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ─── 测试 ───────────────────────────────────────────────────────────────────

describe('callVisionOcr', () => {
  const baseOpts = {
    apiKey: 'test-key',
    baseUrl: 'https://mock.example.com/v1',
    retryBaseMs: 1, // 保持测试快，full jitter random(0, 1*2^n) 几乎瞬时
    overallTimeoutMs: 0, // 默认禁用 overall timeout，个别测试再开
  }

  it('首次调用成功', async () => {
    await withMockFetch(
      [{ status: 200, body: okBody('hello world') }],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], baseOpts)
        assert.equal(result.failures.length, 0)
        assert.equal(result.results.length, 1)
        assert.ok(result.results[0])
        assert.match(result.results[0] as string, /hello world/)
      },
    )
  })

  it('429 → retry → 第二次成功', async () => {
    await withMockFetch(
      [
        { status: 429, body: { error: 'rate limited' } },
        { status: 200, body: okBody('ok after retry') },
      ],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], baseOpts)
        assert.equal(result.failures.length, 0)
        assert.match(result.results[0] as string, /ok after retry/)
      },
    )
  })

  it('5xx → retry → 第二次成功', async () => {
    await withMockFetch(
      [
        { status: 503, body: { error: 'unavailable' } },
        { status: 200, body: okBody('recovered') },
      ],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], baseOpts)
        assert.equal(result.failures.length, 0)
        assert.match(result.results[0] as string, /recovered/)
      },
    )
  })

  it('连续 429 → retry 耗尽 → 分类 rate-limit', async () => {
    await withMockFetch(
      [{ status: 429, body: { error: 'rate limited' } }],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], { ...baseOpts, maxRetries: 2 })
        assert.equal(result.failures.length, 1)
        assert.equal(result.failures[0].category, 'rate-limit')
        assert.equal(result.failures[0].attempts, 3) // 1 + 2 retries
        assert.equal(result.failures[0].httpStatus, 429)
        assert.equal(result.results[0], null)
      },
    )
  })

  it('400 客户端错误不重试', async () => {
    await withMockFetch(
      [{ status: 400, body: { error: 'bad request' } }],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], { ...baseOpts, maxRetries: 2 })
        assert.equal(result.failures.length, 1)
        assert.equal(result.failures[0].category, 'client-error')
        assert.equal(result.failures[0].attempts, 1) // 不重试
        assert.equal(result.failures[0].httpStatus, 400)
      },
    )
  })

  it('truncated (finish_reason=length) 保留 partial + failures 有记录', async () => {
    await withMockFetch(
      [{ status: 200, body: okBody('partial text here', 'length') }],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], baseOpts)
        assert.equal(result.failures.length, 1)
        assert.equal(result.failures[0].category, 'truncated')
        // results[0] 应该仍有已截断的内容
        assert.ok(result.results[0])
        assert.match(result.results[0] as string, /partial text here/)
      },
    )
  })

  it('空 content → retry → 第二次成功', async () => {
    await withMockFetch(
      [
        { status: 200, body: okBody('') }, // empty
        { status: 200, body: okBody('content on retry') },
      ],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], baseOpts)
        assert.equal(result.failures.length, 0)
        assert.match(result.results[0] as string, /content on retry/)
      },
    )
  })

  it('连续空 content → retry 耗尽 → 分类 empty-response', async () => {
    await withMockFetch(
      [{ status: 200, body: okBody('') }],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], { ...baseOpts, maxRetries: 2 })
        assert.equal(result.failures.length, 1)
        assert.equal(result.failures[0].category, 'empty-response')
        assert.equal(result.failures[0].attempts, 3)
      },
    )
  })

  it('Retry-After 头被尊重（取 Retry-After 和 full jitter 退避较大值）', async () => {
    // Retry-After: 0 秒 意味着不强制等待，测试 retry-after 路径不抛错
    await withMockFetch(
      [
        { status: 429, headers: { 'Retry-After': '0' }, body: { error: 'rate limited' } },
        { status: 200, body: okBody('after retry-after') },
      ],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], baseOpts)
        assert.equal(result.failures.length, 0)
        assert.match(result.results[0] as string, /after retry-after/)
      },
    )
  })

  it('onRetry 回调在每次 retry 前触发', async () => {
    const retryEvents: Array<{ attempt: number; category: string }> = []
    await withMockFetch(
      [
        { status: 429, body: {} },
        { status: 500, body: {} },
        { status: 200, body: okBody('success') },
      ],
      async () => {
        await callVisionOcr([FAKE_IMAGE], {
          ...baseOpts,
          maxRetries: 2,
          onRetry: (info) => retryEvents.push({ attempt: info.attempt, category: info.category }),
        })
        assert.equal(retryEvents.length, 2)
        assert.equal(retryEvents[0].attempt, 1)
        assert.equal(retryEvents[0].category, 'rate-limit')
        assert.equal(retryEvents[1].attempt, 2)
        assert.equal(retryEvents[1].category, 'server-error')
      },
    )
  })

  it('onProgress 每完成一张图触发一次', async () => {
    const progressCalls: Array<{ done: number; total: number }> = []
    await withMockFetch(
      [{ status: 200, body: okBody('img') }],
      async () => {
        await callVisionOcr([FAKE_IMAGE, FAKE_IMAGE, FAKE_IMAGE], {
          ...baseOpts,
          concurrency: 1,
          onProgress: (done, total) => progressCalls.push({ done, total }),
        })
        assert.equal(progressCalls.length, 3)
        assert.deepEqual(
          progressCalls.map((p) => p.done),
          [1, 2, 3],
        )
      },
    )
  })

  it('并发 worker 不重复领任务（cursor 原子性）', async () => {
    // 准备 10 张图，mock 每次都返回递增 id 让我们能验证所有任务都被领走
    const mockResponses = Array.from({ length: 10 }, (_, i) => ({
      status: 200,
      body: okBody(`img-${i}`),
    }))
    await withMockFetch(mockResponses, async () => {
      const result = await callVisionOcr(
        Array(10).fill(FAKE_IMAGE),
        { ...baseOpts, concurrency: 5 },
      )
      assert.equal(result.failures.length, 0)
      assert.equal(result.results.length, 10)
      // 所有 slot 都有结果（没有 null）
      const nonNull = result.results.filter((r) => r !== null).length
      assert.equal(nonNull, 10)
    })
  })

  it('Overall timeout 触发 — 已完成的保留，其他标记 overall-timeout', async () => {
    // 3 张图，每张 fetch 延迟 200ms，overallTimeoutMs=100 强制中断
    await withMockFetch(
      [
        { status: 200, body: okBody('slow1'), delayMs: 200 },
        { status: 200, body: okBody('slow2'), delayMs: 200 },
        { status: 200, body: okBody('slow3'), delayMs: 200 },
      ],
      async () => {
        const result = await callVisionOcr(
          [FAKE_IMAGE, FAKE_IMAGE, FAKE_IMAGE],
          {
            ...baseOpts,
            concurrency: 1, // 串行保证第 2、3 张不会启动
            overallTimeoutMs: 100,
          },
        )
        // 第 1 张 fetch 300ms 超过 100ms overall timeout → aborted
        // 所有 3 张最终都在 failures 里（第 1 张因 abort，第 2/3 张因未启动）
        assert.ok(result.failures.length >= 1)
        const overallTimeouts = result.failures.filter(
          (f) => f.category === 'overall-timeout',
        )
        assert.ok(overallTimeouts.length >= 1)
      },
    )
  })

  it('apiKey 缺失抛错', async () => {
    await assert.rejects(
      () => callVisionOcr([FAKE_IMAGE], { ...baseOpts, apiKey: '' }),
      /apiKey 必填/,
    )
  })

  it('baseUrl 缺失抛错', async () => {
    await assert.rejects(
      () => callVisionOcr([FAKE_IMAGE], { ...baseOpts, baseUrl: '' }),
      /baseUrl 必填/,
    )
  })

  it('baseUrl 尾部斜杠被归一化', async () => {
    const urls: string[] = []
    const originalFetch = globalThis.fetch
    // @ts-expect-error mock
    globalThis.fetch = async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify(okBody('ok')), { status: 200 })
    }
    try {
      await callVisionOcr([FAKE_IMAGE], {
        ...baseOpts,
        baseUrl: 'https://mock.example.com/v1///',
      })
      assert.equal(urls.length, 1)
      // 不应该有 //chat/completions
      assert.ok(!urls[0].includes('v1//chat'))
      assert.ok(urls[0].endsWith('/v1/chat/completions'))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
