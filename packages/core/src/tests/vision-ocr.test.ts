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
 *
 * **重要**：delayMs 期间会监听 `init.signal`，被 abort 时立刻抛 AbortError，
 * 模拟真实 fetch 的 abort 行为。这样才能真正覆盖 overall timeout 中断 in-flight fetch 的路径。
 */
function makeMockFetch(responses: MockResponse[]): (url: string, init?: RequestInit) => Promise<Response> {
  let call = 0
  return async (_url: string, init?: RequestInit) => {
    const r = responses[Math.min(call, responses.length - 1)]
    call++
    if (r.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, r.delayMs)
        const signal = init?.signal
        if (signal) {
          const onAbort = (): void => {
            clearTimeout(timer)
            const err = new Error('This operation was aborted')
            ;(err as Error & { name: string }).name = 'AbortError'
            reject(err)
          }
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }
      })
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
          onRetry: (info) => {
            retryEvents.push({ attempt: info.attempt, category: info.category })
          },
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
          onProgress: (done, total) => {
            progressCalls.push({ done, total })
          },
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

  it('畸形 JSON 响应（SyntaxError）→ 可重试', async () => {
    const originalFetch = globalThis.fetch
    let callCount = 0
    // @ts-expect-error mock
    globalThis.fetch = async (_url: string) => {
      callCount++
      if (callCount === 1) {
        // 第一次返回畸形 JSON → response.json() 抛 SyntaxError
        return new Response('<html>not json</html>', { status: 200 })
      }
      // 第二次正常返回
      return new Response(JSON.stringify(okBody('parsed on retry')), { status: 200 })
    }
    try {
      const result = await callVisionOcr([FAKE_IMAGE], baseOpts)
      assert.equal(result.failures.length, 0)
      assert.match(result.results[0] as string, /parsed on retry/)
      assert.equal(callCount, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('Retry-After: 2 秒 → 实际等待时间接近 2 秒（而非本地 full-jitter 退避）', async () => {
    await withMockFetch(
      [
        { status: 429, headers: { 'Retry-After': '2' }, body: {} },
        { status: 200, body: okBody('respected') },
      ],
      async () => {
        const start = Date.now()
        const result = await callVisionOcr([FAKE_IMAGE], {
          ...baseOpts,
          retryBaseMs: 1, // 本地退避 attempt=0: 0.5-1ms，远远小于 Retry-After 指定的 2000ms
        })
        const elapsed = Date.now() - start
        assert.equal(result.failures.length, 0)
        // 如果代码不尊重 Retry-After，elapsed 会 < 100ms
        // 如果尊重了，elapsed 应 ≥ 1900ms（留 100ms 容差）
        assert.ok(
          elapsed >= 1900,
          `expected elapsed >= 1900ms (Retry-After honored), got ${elapsed}ms`,
        )
      },
    )
  })

  it('Retry-After: HTTP date 格式 → 被正确解析', async () => {
    // 构造未来 3 秒的 HTTP date。注意 HTTP date 精度到秒（toUTCString 丢 ms），
    // 所以 Date.parse 回来最多少 999ms。用 +3000ms 保证实际等待至少 2001ms，
    // 容差后断言 >= 1900ms，避免秒边界 timing 导致的 flaky。
    const futureDate = new Date(Date.now() + 3000).toUTCString()
    await withMockFetch(
      [
        { status: 429, headers: { 'Retry-After': futureDate }, body: {} },
        { status: 200, body: okBody('http-date ok') },
      ],
      async () => {
        const start = Date.now()
        const result = await callVisionOcr([FAKE_IMAGE], { ...baseOpts, retryBaseMs: 1 })
        const elapsed = Date.now() - start
        assert.equal(result.failures.length, 0)
        assert.ok(
          elapsed >= 1900,
          `expected elapsed >= 1900ms (HTTP date honored), got ${elapsed}ms`,
        )
      },
    )
  })

  it('Overall timeout 在 retry sleep 期间触发 → 正确标记 overall-timeout', async () => {
    // 第 1 次 429（立即返回）→ 进入 retry sleep（退避 ≥ 500ms，equal jitter baseMs=2000）
    // overall timeout=100ms，会在 retry sleep 期间触发
    await withMockFetch(
      [
        { status: 429, body: {} },
        { status: 200, body: okBody('should not reach') },
      ],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], {
          ...baseOpts,
          retryBaseMs: 2000, // equal jitter → 1000-2000ms，远大于 overall timeout 100ms
          overallTimeoutMs: 100,
        })
        assert.equal(result.failures.length, 1)
        assert.equal(result.failures[0].category, 'overall-timeout')
      },
    )
  })

  it('Overall timeout 中断 in-flight fetch（mock 检查 signal）', async () => {
    // 单个 fetch 延迟 500ms，overall timeout 100ms，fetch 应被 AbortSignal 中断
    const start = Date.now()
    await withMockFetch(
      [{ status: 200, body: okBody('slow'), delayMs: 500 }],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], {
          ...baseOpts,
          overallTimeoutMs: 100,
        })
        // fetch 被中断 → HttpError('aborted') → classifyError → overall-timeout
        assert.equal(result.failures.length, 1)
        assert.equal(result.failures[0].category, 'overall-timeout')
      },
    )
    const elapsed = Date.now() - start
    // 如果 mock 没 honor signal，测试会等 500ms 才完成
    // 如果 honored，应在 100-200ms 之间完成
    assert.ok(
      elapsed < 400,
      `expected fetch aborted promptly (elapsed < 400ms), got ${elapsed}ms`,
    )
  })

  it('interruptibleSleep: Overall timeout 在 retry sleep 期间触发立即唤醒（硬上限）', async () => {
    // retryBaseMs=5000 → equal jitter attempt=0 区间 2500-5000ms
    // overallTimeoutMs=200 → 200ms 后触发
    // 预期：retry sleep 被中断，总耗时接近 200ms（而非 2500ms+）
    const start = Date.now()
    await withMockFetch(
      [
        { status: 429, body: {} },
        { status: 200, body: okBody('should not reach') },
      ],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], {
          ...baseOpts,
          retryBaseMs: 5000,
          overallTimeoutMs: 200,
        })
        assert.equal(result.failures.length, 1)
        assert.equal(result.failures[0].category, 'overall-timeout')
      },
    )
    const elapsed = Date.now() - start
    // 如果 sleep 不可中断，elapsed 至少 2500ms
    // 如果可中断，应在 300ms 左右（200 overall + 少量 overhead）
    assert.ok(
      elapsed < 1000,
      `expected interruptible sleep (elapsed < 1000ms), got ${elapsed}ms`,
    )
  })

  it('maxRetries=0 边界 → 首次失败立即终态（无 retry）', async () => {
    await withMockFetch(
      [{ status: 429, body: {} }],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], {
          ...baseOpts,
          maxRetries: 0,
        })
        assert.equal(result.failures.length, 1)
        assert.equal(result.failures[0].attempts, 1)
        assert.equal(result.failures[0].category, 'rate-limit')
      },
    )
  })

  it('maxRetries=0 首次成功', async () => {
    await withMockFetch(
      [{ status: 200, body: okBody('no retry needed') }],
      async () => {
        const result = await callVisionOcr([FAKE_IMAGE], {
          ...baseOpts,
          maxRetries: 0,
        })
        assert.equal(result.failures.length, 0)
        assert.match(result.results[0] as string, /no retry needed/)
      },
    )
  })

  it('concurrency=0 抛错（非法参数）', async () => {
    await assert.rejects(
      () => callVisionOcr([FAKE_IMAGE], { ...baseOpts, concurrency: 0 }),
      /concurrency 必须 >= 1/,
    )
  })

  it('maxRetries=-1 抛错（非法参数）', async () => {
    await assert.rejects(
      () => callVisionOcr([FAKE_IMAGE], { ...baseOpts, maxRetries: -1 }),
      /maxRetries 必须 >= 0/,
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
