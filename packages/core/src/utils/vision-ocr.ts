/**
 * vision-ocr.ts — 图表页 Vision OCR 共享管线
 *
 * 环境无关：主进程（Electron main）和渲染进程（KnowledgePanel）共用同一份实现，
 * 避免 prompt / 调用细节在两端漂移。底层使用 core 自己的 fetchWithTimeout。
 *
 * 能力：
 *   - 并发调用 Vision 模型识别图表页（默认并发 3）
 *   - 每张图独立错误隔离：单张失败不中断其他图，失败详情上报调用方
 *   - 自动 cleanOcrHtml 清洗 HTML→Markdown
 *   - 智能 retry：指数退避 full jitter + 尊重 429 Retry-After 头
 *   - 总体超时 cap：整批 overall timeout 后未完成的 slot 全部标记失败并返回
 *   - 按错误分类（timeout / rate-limit / server-error / network / client-error /
 *     empty-response / truncated / parse-error / overall-timeout / unknown）
 *   - Prompt / 模型名 / 并发数 / retry 参数全部可配置
 *
 * @author zhi.qu
 * @date 2026-04-14
 */

import { fetchWithTimeout, HttpError } from './http'
import { cleanOcrHtml } from './ocr-html-cleaner'

// ─── 默认常量 ─────────────────────────────────────────────────────────────

/** 默认 Vision 模型 */
export const DEFAULT_VISION_MODEL = 'qwen-vl-max'

/** 默认并发数。DashScope 常见限流阈值允许 3 并发稳定运行。 */
export const DEFAULT_VISION_CONCURRENCY = 3

/**
 * 单次 Vision 调用超时（5 分钟）。大图 OCR 偶尔需要 60-120 秒，
 * 极端情况（密集表格 + 尺寸标注 + 长注解）可达 180-240 秒，
 * 300 秒保守上限避免把本能成功的请求当作失败。
 */
export const DEFAULT_VISION_TIMEOUT_MS = 300_000

/** 默认 retry 次数（不含首次调用）。2 次 retry = 最多 3 次 attempt。 */
export const DEFAULT_VISION_MAX_RETRIES = 2

/** 指数退避基数（毫秒）。Full jitter: random(0, base * 2^attempt)。 */
export const DEFAULT_VISION_RETRY_BASE_MS = 1000

/**
 * 默认 max_tokens。密集技术图可能需要更多输出预算（原 4096 常被截断），
 * 提升到 8192 覆盖绝大多数场景。这是输出预算，不影响响应时间上限。
 */
export const DEFAULT_VISION_MAX_TOKENS = 8192

/**
 * 整批 OCR 的总体超时 cap（20 分钟）。
 * 防御 worst case：单图 3 次 retry × 300s = 15 分钟/图，50 张图理论最坏 4+ 小时。
 * 达到 overall timeout 后：
 *   - 已完成的保留 results
 *   - 进行中的 fetch 会被 AbortSignal 中断
 *   - 未开始的 slot 标记为 `overall-timeout` 类别失败
 * 设为 0 禁用。
 */
export const DEFAULT_VISION_OVERALL_TIMEOUT_MS = 20 * 60 * 1000

/**
 * 默认 Vision Prompt。和渲染进程原有 prompt 保持一致，避免行为差异。
 * 两处硬编码合并为此常量。
 */
export const DEFAULT_VISION_PROMPT =
  '请仔细分析这张技术文档页面图片，提取所有有价值的结构化信息：' +
  '1. 尺寸图/工程图：提取所有尺寸标注数值（单位mm），整理为参数表格；' +
  '2. 设备布局图：描述各组件的空间位置关系，整理为布局表格；' +
  '3. 原理图/流程图：描述流向、各部件名称和功能；' +
  '4. 数据表格：以 Markdown 表格格式输出；' +
  '5. 接线图：描述端子排列、线缆规格。' +
  '输出要求：使用 Markdown 格式，直接输出内容不要用代码围栏包裹，保留原始精度数值，' +
  '只输出图片中实际可见的数据，不要编造或推断图片中不存在的数值，' +
  '禁止使用任何 emoji 图标，不要在末尾附加总结或自评。'

// ─── 类型 ─────────────────────────────────────────────────────────────────

export interface VisionOcrOptions {
  /** API Key（必填）*/
  apiKey: string
  /** API Base URL（必填，如 https://dashscope.aliyuncs.com/compatible-mode/v1）*/
  baseUrl: string
  /** Vision 模型名，默认 qwen-vl-max */
  model?: string
  /** 并发数，默认 3 */
  concurrency?: number
  /** 单请求超时（ms），默认 300000 */
  timeoutMs?: number
  /** Prompt 覆盖（可选）*/
  prompt?: string
  /** 单图最大输出 tokens，默认 8192 */
  maxTokens?: number
  /** 重试次数（不含首次），默认 2。仅对可重试错误生效 */
  maxRetries?: number
  /** 指数退避基数 ms，默认 1000。Full jitter: random(0, base * 2^attempt) */
  retryBaseMs?: number
  /** 整批总体超时 ms，默认 1200000 (20 分钟)。<= 0 禁用 */
  overallTimeoutMs?: number
  /** 进度回调：每完成一张图（无论成功或失败）触发一次 */
  onProgress?: (completed: number, total: number) => void
  /** 重试事件回调：每次决定 retry 前触发（在 sleep 之前）*/
  onRetry?: (info: {
    index: number
    attempt: number
    category: VisionOcrFailureCategory
    nextDelayMs: number
  }) => void
}

/** OCR 失败的错误类别，便于上层 UI 和日志聚合 */
export type VisionOcrFailureCategory =
  | 'timeout'          // 连续重试仍超时
  | 'rate-limit'       // 429，已重试用尽
  | 'server-error'     // 5xx，已重试用尽
  | 'network'          // 网络层，已重试用尽
  | 'client-error'     // 4xx（非 429），不重试
  | 'empty-response'   // 模型返回空 content，重试用尽
  | 'truncated'        // finish_reason === 'length'，输出被截断（results 仍保留部分内容）
  | 'parse-error'      // 响应 JSON 解析失败
  | 'overall-timeout'  // 整批 overall timeout 触发，单图未能完成
  | 'unknown'

export interface VisionOcrFailure {
  /** 原始 images 数组中的下标 */
  index: number
  /** 错误消息 */
  error: string
  /** 错误类别（用于上层聚合展示："N 张因限流失败 / M 张因超时失败"） */
  category: VisionOcrFailureCategory
  /** 实际 attempt 次数（含首次）。例如 maxRetries=2 时最大为 3 */
  attempts: number
  /** HTTP 状态码（仅 HttpError 'http' 类型有）*/
  httpStatus?: number
}

export interface VisionOcrResult {
  /**
   * OCR 结果数组，下标与输入 `images` 一一对应。
   * - 成功：cleanOcrHtml 后的 Markdown 字符串
   * - 失败：null
   * - 特殊：`truncated` 类别（finish_reason === 'length'）时，results 会包含
   *   已截断的部分内容（不是 null），但 failures 里也有对应记录。调用方可据此决定
   *   是否使用这部分不完整的内容。
   *
   * 不使用紧凑数组是为了让调用方能按原 imagePageNumbers 对应关系处理。
   */
  results: Array<string | null>
  /** 失败详情列表（按完成顺序，带 index 字段可回推原下标） */
  failures: VisionOcrFailure[]
}

// ─── 自定义错误类（替代之前的 monkey-patch）─────────────────────────────────

/**
 * Vision OCR 可识别的结构化错误。
 * 用 instanceof 检测，替代在 Error 对象上动态加属性的反模式。
 *
 * - `retryable=true` 表示值得重试（如 empty-response 可能是瞬时抽风）
 * - `partialContent` 仅 `truncated` 类别有值，是 finish_reason=length 时已输出的部分
 */
class VisionOcrKnownError extends Error {
  constructor(
    message: string,
    readonly visionCategory: VisionOcrFailureCategory,
    readonly retryable: boolean,
    readonly partialContent?: string,
  ) {
    super(message)
    this.name = 'VisionOcrKnownError'
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────

/**
 * 判断错误是否可重试。
 *
 * 可重试：timeout / network / 429 限流 / 5xx 服务端错误 / VisionOcrKnownError.retryable
 * 不可重试：4xx（非 429）客户端错误（认证失败、图片格式错误、参数错误等）、
 *           aborted（用户主动取消或 overall timeout）、非 HttpError 异常（JSON 解析等）
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof VisionOcrKnownError) return err.retryable
  if (!(err instanceof HttpError)) return false
  if (err.type === 'timeout' || err.type === 'network') return true
  if (err.type === 'http') {
    if (err.status === 429) return true
    if (err.status !== undefined && err.status >= 500) return true
    return false
  }
  // aborted → 不重试（用户主动取消 / overall timeout 会触发 abort）
  return false
}

/** 将任意错误映射为 VisionOcrFailureCategory */
function classifyError(err: unknown): VisionOcrFailureCategory {
  if (err instanceof VisionOcrKnownError) return err.visionCategory
  if (err instanceof HttpError) {
    if (err.type === 'timeout') return 'timeout'
    if (err.type === 'network') return 'network'
    if (err.type === 'http') {
      if (err.status === 429) return 'rate-limit'
      if (err.status !== undefined && err.status >= 500) return 'server-error'
      return 'client-error'
    }
    // aborted 走到这里
    return 'unknown'
  }
  if (err instanceof SyntaxError) return 'parse-error'
  return 'unknown'
}

/**
 * Full jitter 指数退避：random(0, base * 2^attempt)
 * 参考 AWS "Exponential Backoff And Jitter"，在高并发场景比 fixed jitter 更能
 * 打散 retry 风暴（避免所有 worker 同时醒来再次打 API）。
 */
function backoffDelay(attempt: number, baseMs: number): number {
  const cap = baseMs * Math.pow(2, attempt)
  return Math.floor(Math.random() * cap)
}

/**
 * 解析 HTTP Retry-After 头。
 * 支持两种格式：
 *   - 秒数：`Retry-After: 120`
 *   - HTTP date：`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`
 * @returns 等待毫秒数，解析失败返回 null
 */
function parseRetryAfter(headers: Record<string, string> | undefined): number | null {
  if (!headers) return null
  const val = headers['retry-after']
  if (!val) return null
  // 纯数字秒
  const sec = parseInt(val, 10)
  if (!isNaN(sec) && sec >= 0) return sec * 1000
  // HTTP date
  const date = Date.parse(val)
  if (!isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── OpenAI 兼容协议 helper（#11 轻量抽象）─────────────────────────────────

/**
 * 构造 OpenAI Chat Completions 兼容的请求体（含视觉消息）。
 * 把"协议细节"和"retry 逻辑"解耦 —— 未来换 provider 时只换此函数和 parseResponse。
 */
function buildOpenAICompletionBody(
  imageBase64: string,
  prompt: string,
  model: string,
  maxTokens: number,
): object {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      },
    ],
    stream: false,
    max_tokens: maxTokens,
  }
}

/** 从 OpenAI Chat Completions 响应中抽取 content + finish_reason */
function parseOpenAICompletionResponse(data: unknown): {
  content: string
  finishReason?: string
} {
  const typed = data as {
    choices?: Array<{
      message?: { content?: string }
      finish_reason?: string
    }>
  }
  const choice = typed.choices?.[0]
  return {
    content: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason,
  }
}

// ─── 主函数 ───────────────────────────────────────────────────────────────

/**
 * 并发调用 Vision 模型对多张图表页图片做 OCR。
 *
 * 使用和 document-formatter 里一致的 worker-based 并发模式：
 *   - 固定 N 个 worker，每个 worker 从共享 cursor 领任务
 *   - 单任务失败不影响其他 worker
 *   - 按完成顺序触发 onProgress，按原序写入 results
 *
 * **Retry 策略**：
 *   - 可重试错误：429（尊重 `Retry-After` 头）/ 5xx / timeout / network / empty-response
 *   - 不可重试错误：4xx（非 429）/ truncated / parse-error / aborted
 *   - 退避：full jitter random(0, base * 2^attempt)
 *
 * **Overall timeout**：
 *   - 整批超过 `overallTimeoutMs` 后，进行中的 fetch 会被 abort，
 *     未开始的 slot 标记为 `overall-timeout` 类别失败。
 *
 * @param images - base64 data URL 数组（data:image/png;base64,...）
 * @param options - 见 VisionOcrOptions
 * @returns `{ results, failures }` — results 长度等于 images.length，失败位为 null（truncated 保留部分）
 *
 * @example
 * ```ts
 * const { results, failures } = await callVisionOcr(images, {
 *   apiKey: 'sk-...',
 *   baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
 *   onProgress: (done, total) => console.log(`${done}/${total}`),
 *   onRetry: (info) => console.log(`retry idx=${info.index} attempt=${info.attempt} after ${info.nextDelayMs}ms`),
 * })
 * const cleanResults = results.filter((r): r is string => r !== null)
 * if (failures.length > 0) {
 *   const byCategory = failures.reduce((acc, f) => ({ ...acc, [f.category]: (acc[f.category] ?? 0) + 1 }), {} as Record<string, number>)
 *   console.warn('OCR 失败分布：', byCategory)
 * }
 * ```
 */
export async function callVisionOcr(
  images: string[],
  options: VisionOcrOptions,
): Promise<VisionOcrResult> {
  const {
    apiKey,
    baseUrl,
    model = DEFAULT_VISION_MODEL,
    concurrency = DEFAULT_VISION_CONCURRENCY,
    timeoutMs = DEFAULT_VISION_TIMEOUT_MS,
    prompt = DEFAULT_VISION_PROMPT,
    maxTokens = DEFAULT_VISION_MAX_TOKENS,
    maxRetries = DEFAULT_VISION_MAX_RETRIES,
    retryBaseMs = DEFAULT_VISION_RETRY_BASE_MS,
    overallTimeoutMs = DEFAULT_VISION_OVERALL_TIMEOUT_MS,
    onProgress,
    onRetry,
  } = options

  if (!apiKey) throw new Error('callVisionOcr: apiKey 必填')
  if (!baseUrl) throw new Error('callVisionOcr: baseUrl 必填')

  // 归一化 baseUrl 尾部斜杠，避免拼接出 //chat/completions
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const endpoint = `${normalizedBaseUrl}/chat/completions`

  const total = images.length
  const results: Array<string | null> = new Array(total).fill(null)
  const failures: VisionOcrFailure[] = []
  let cursor = 0
  let completed = 0

  // Overall timeout：共享 AbortController，超时后 abort 所有 in-flight fetch
  const overallController = new AbortController()
  let overallAborted = false
  const overallTimer: ReturnType<typeof setTimeout> | null =
    overallTimeoutMs > 0
      ? setTimeout(() => {
          overallAborted = true
          overallController.abort(new Error('vision-ocr overall timeout'))
        }, overallTimeoutMs)
      : null

  /** 发一次 request + 解析响应。成功返回 OCR 文本，失败抛结构化异常。 */
  async function callOnce(imageBase64: string): Promise<string> {
    const body = buildOpenAICompletionBody(imageBase64, prompt, model, maxTokens)
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      timeoutMs,
      signal: overallController.signal,
    })
    const data = await response.json()
    const parsed = parseOpenAICompletionResponse(data)

    // 顺序：先检查 truncated（有 content + finish_reason=length），
    // 后检查 empty（无 content）。避免同时命中时归错类。
    if (parsed.finishReason === 'length') {
      throw new VisionOcrKnownError(
        `vision response truncated by max_tokens (${maxTokens})`,
        'truncated',
        false,
        parsed.content || undefined,
      )
    }
    if (!parsed.content) {
      // empty-response: 可重试。可能是模型瞬时抽风（内部限流、网络截断响应体），
      // retry 成功的概率不低。连续失败才视为真终态。
      throw new VisionOcrKnownError(
        'empty response from vision model',
        'empty-response',
        true,
      )
    }
    return parsed.content
  }

  /** 处理单张图：for-loop retry + 错误分类 + Retry-After 尊重 */
  async function processOne(idx: number): Promise<void> {
    let lastErr: unknown = null
    let finalAttempt = 0

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Overall timeout 优先短路：触发后立即标记为 overall-timeout 并返回
      if (overallAborted) {
        failures.push({
          index: idx,
          error: 'overall timeout',
          category: 'overall-timeout',
          attempts: attempt,
        })
        return
      }
      finalAttempt = attempt
      try {
        const text = await callOnce(images[idx])
        results[idx] = cleanOcrHtml(text)
        return
      } catch (err) {
        lastErr = err

        // overall timeout 导致的 aborted → 不计入 retry，直接标记
        if (overallAborted) {
          failures.push({
            index: idx,
            error: 'overall timeout',
            category: 'overall-timeout',
            attempts: attempt + 1,
          })
          return
        }

        // VisionOcrKnownError 的 non-retryable 分支（truncated）立即 break
        // 截断情况下仍然保留 partialContent，上层可决定是否使用
        if (err instanceof VisionOcrKnownError && !err.retryable) {
          if (err.visionCategory === 'truncated' && err.partialContent) {
            results[idx] = cleanOcrHtml(err.partialContent)
          }
          break
        }

        // 到此：可重试错误（HttpError 或 VisionOcrKnownError retryable=true）
        if (attempt < maxRetries && isRetryable(err)) {
          // 429 尊重 Retry-After 头：取服务器建议和本地 full-jitter 退避中的较大值
          let delayMs: number
          if (err instanceof HttpError && err.status === 429) {
            const retryAfter = parseRetryAfter(err.headers)
            delayMs = Math.max(retryAfter ?? 0, backoffDelay(attempt, retryBaseMs))
          } else {
            delayMs = backoffDelay(attempt, retryBaseMs)
          }
          if (onRetry) {
            onRetry({
              index: idx,
              attempt: attempt + 1,
              category: classifyError(err),
              nextDelayMs: delayMs,
            })
          }
          await sleep(delayMs)
          continue
        }

        // 不可重试或 retry 次数用尽 → break
        break
      }
    }

    // 走到这里说明永久失败（或 truncated 已保留 partial 但也要登记）
    const category = classifyError(lastErr)
    const httpStatus = lastErr instanceof HttpError ? lastErr.status : undefined
    failures.push({
      index: idx,
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      category,
      attempts: finalAttempt + 1,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    })
  }

  async function worker(): Promise<void> {
    while (cursor < total && !overallAborted) {
      const idx = cursor++
      await processOne(idx)
      completed++
      if (onProgress) onProgress(completed, total)
    }
  }

  const workerCount = Math.min(concurrency, total)
  if (workerCount === 0) {
    if (overallTimer) clearTimeout(overallTimer)
    return { results, failures }
  }

  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  } finally {
    if (overallTimer) clearTimeout(overallTimer)
  }

  // Overall timeout 触发后扫描未启动的 slot，全部标记 overall-timeout 失败
  if (overallAborted) {
    const failedIndexes = new Set(failures.map((f) => f.index))
    for (let i = 0; i < total; i++) {
      if (results[i] === null && !failedIndexes.has(i)) {
        failures.push({
          index: i,
          error: 'overall timeout (not scheduled)',
          category: 'overall-timeout',
          attempts: 0,
        })
      }
    }
  }

  return { results, failures }
}
