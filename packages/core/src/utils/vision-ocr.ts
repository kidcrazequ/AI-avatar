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
  /**
   * 进度回调：每完成一张图（**无论成功或失败**）触发一次。
   *
   * - `completed` 含失败的图 —— `completed === total` 不代表全部成功，
   *   应当同时检查 `failures.length`
   * - 回调返回的 Promise 会被 await，可安全地做 I/O（如 IPC 事件上报）
   * - **并发顺序非确定**：多 worker 并发时，`completed` 值递增顺序由完成时机决定，
   *   不保证严格单调递增（worker A 的 completed=1 回调可能晚于 worker B 的 completed=2）。
   *   UI 实现应按"显示最新值"的策略，不要假设回调严格按 1,2,3... 顺序触发。
   */
  onProgress?: (completed: number, total: number) => void | Promise<void>
  /**
   * 重试事件回调：每次决定 retry 前触发（在退避 sleep 之前）。
   *
   * - `info.category` 是**上一次失败**的分类（如 'rate-limit'），不是"最终会失败"
   *   如果 retry 成功，这个回调触发但 failures 里不会有对应条目
   * - `info.nextDelayMs` 是纯退避时间，不含 onRetry 回调自身耗时；
   *   **实际 retry 间隔 = onRetry 耗时 + nextDelayMs**，回调内部请保持轻量（建议 <10ms）
   * - 回调返回的 Promise 会被 await
   */
  onRetry?: (info: {
    index: number
    attempt: number
    category: VisionOcrFailureCategory
    nextDelayMs: number
  }) => void | Promise<void>
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
 * Vision OCR 可识别的结构化错误（文件内部类，不对外导出）。
 * 用 instanceof 检测，替代在 Error 对象上动态加属性的反模式。
 *
 * 外部消费方通过 `VisionOcrFailure.category` 字符串判断错误类别 —— 这个 class
 * 只是 callVisionOcr 内部把"已识别的语义错误"和"HTTP/网络错误"分开处理的载体。
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
 * 可重试：
 *   - VisionOcrKnownError.retryable=true（empty-response）
 *   - HttpError: timeout / network / 429 / 5xx
 *   - SyntaxError：JSON 解析失败（CDN/代理返回畸形响应体、gzip 解压失败等，通常瞬时）
 * 不可重试：
 *   - HttpError 4xx（非 429）、aborted（overall timeout 会走专门分支）
 *   - VisionOcrKnownError.retryable=false（truncated）
 *   - 其他未知异常
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof VisionOcrKnownError) return err.retryable
  if (err instanceof SyntaxError) return true
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
    // aborted 只会由 overall timeout 触发（callVisionOcr 不接受外部 signal），
    // 归到 overall-timeout 更精确
    return 'overall-timeout'
  }
  if (err instanceof SyntaxError) return 'parse-error'
  return 'unknown'
}

/**
 * Equal jitter 指数退避：delay/2 + random(0, delay/2)，其中 delay = base * 2^attempt。
 *
 * 保证最小退避 delay/2 —— 不像 full jitter 可能返回 0ms 等于没退避。同时
 * 上半段随机打散 retry 风暴，平衡"给服务器喘息空间"和"分散并发 worker 同时醒来"两个目标。
 * 参考 AWS Architecture Blog "Exponential Backoff And Jitter"（equal jitter 小节）。
 *
 * 示例（baseMs=1000）：
 *   - attempt=0: 500-1000ms
 *   - attempt=1: 1000-2000ms
 *   - attempt=2: 2000-4000ms
 */
function backoffDelay(attempt: number, baseMs: number): number {
  const delay = baseMs * Math.pow(2, attempt)
  return Math.floor(delay / 2 + Math.random() * (delay / 2))
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

/**
 * 可中断 sleep：等待 `ms` 毫秒或 `signal` 被 abort，哪个先发生。
 *
 * 与普通 `sleep` 的差别：如果 signal 在 sleep 期间被 abort，立即 resolve（不 reject）。
 * resolve 后调用方可以检查 `signal.aborted` 决定后续逻辑。
 *
 * **为什么 resolve 不 reject**：让 retry loop 在 sleep 后统一走 `overallAborted` 检查分支，
 * 避免 catch 里再次判断 abort 类型。统一的退出路径更易推理。
 *
 * 用于 retry 退避 sleep：overall timeout 触发时 retry sleep 立即醒来，
 * 让 overall timeout 成为真正的硬上限（原先 sleep 不可中断时可能被拖延几秒）。
 */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// ─── OpenAI 兼容协议 helper（#11 轻量抽象）─────────────────────────────────

/** OpenAI Chat Completions 请求体（含 vision content 的子集） */
interface OpenAIVisionRequestBody {
  model: string
  messages: Array<{
    role: 'user'
    content: Array<
      | { type: 'image_url'; image_url: { url: string } }
      | { type: 'text'; text: string }
    >
  }>
  stream: false
  max_tokens: number
}

/**
 * 构造 OpenAI Chat Completions 兼容的请求体（含视觉消息）。
 * 把"协议细节"和"retry 逻辑"解耦 —— 未来换 provider 时只换此函数和 parseResponse。
 */
function buildOpenAICompletionBody(
  imageBase64: string,
  prompt: string,
  model: string,
  maxTokens: number,
): OpenAIVisionRequestBody {
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
  if (concurrency < 1) {
    throw new Error(`callVisionOcr: concurrency 必须 >= 1，收到 ${concurrency}`)
  }
  if (maxRetries < 0) {
    throw new Error(`callVisionOcr: maxRetries 必须 >= 0，收到 ${maxRetries}`)
  }

  // 归一化 baseUrl 尾部斜杠，避免拼接出 //chat/completions
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const endpoint = `${normalizedBaseUrl}/chat/completions`

  const total = images.length
  const results: Array<string | null> = new Array(total).fill(null)
  const failures: VisionOcrFailure[] = []
  let cursor = 0
  let completed = 0

  // Overall timeout：共享 AbortController，超时后 abort 所有 in-flight fetch 和 retry sleep。
  // abort() 不传参数，让调用方通过 `overallAborted` 标志和 `classifyError` 逻辑
  // 统一映射到 `overall-timeout` 类别，不依赖 signal.reason 的 stringify 格式。
  const overallController = new AbortController()
  let overallAborted = false
  const overallTimer: ReturnType<typeof setTimeout> | null =
    overallTimeoutMs > 0
      ? setTimeout(() => {
          overallAborted = true
          overallController.abort()
        }, overallTimeoutMs)
      : null

  /**
   * 发一次 request + 解析响应。成功返回 OCR 文本，失败抛结构化异常。
   * 接收已序列化的 `bodyStr`（由 processOne 在 retry loop 外 build once），
   * 避免 retry 时反复 JSON.stringify 同一张 6+ MB 的 base64 图片。
   */
  async function sendRequestOnce(bodyStr: string): Promise<string> {
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: bodyStr,
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
    // 在 retry loop 外 build + stringify once（base64 图可达 6-7 MB，重复 stringify 浪费）
    const bodyStr = JSON.stringify(
      buildOpenAICompletionBody(images[idx], prompt, model, maxTokens),
    )
    let lastErr: unknown = null
    let lastAttemptIdx = 0

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
      lastAttemptIdx = attempt
      try {
        const text = await sendRequestOnce(bodyStr)
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
            await onRetry({
              index: idx,
              attempt: attempt + 1,
              category: classifyError(err),
              nextDelayMs: delayMs,
            })
          }
          // 可中断 sleep：overall timeout 触发时立即醒来（不等 delayMs 自然结束）
          await interruptibleSleep(delayMs, overallController.signal)
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
      attempts: lastAttemptIdx + 1,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    })
  }

  async function worker(): Promise<void> {
    while (cursor < total && !overallAborted) {
      const idx = cursor++
      await processOne(idx)
      completed++
      if (onProgress) await onProgress(completed, total)
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
