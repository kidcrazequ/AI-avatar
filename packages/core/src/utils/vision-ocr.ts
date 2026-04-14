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
 *   - Prompt 和模型名可选覆盖
 *
 * @author zhi.qu
 * @date 2026-04-14
 */

import { fetchWithTimeout, HttpError } from './http'
import { cleanOcrHtml } from './ocr-html-cleaner'

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

/** 指数退避基数（毫秒）。第 N 次 retry 等 base * 2^N + jitter(0~500) ms。 */
export const DEFAULT_VISION_RETRY_BASE_MS = 1000

/**
 * 默认 max_tokens。密集技术图可能需要更多输出预算（原 4096 常被截断），
 * 提升到 8192 覆盖绝大多数场景。这是输出预算，不影响响应时间上限。
 */
export const DEFAULT_VISION_MAX_TOKENS = 8192

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
  /** 重试次数（不含首次），默认 2。仅对可重试错误（429/5xx/timeout/network）生效 */
  maxRetries?: number
  /** 指数退避基数 ms，默认 1000。第 N 次 retry 等 base * 2^N + jitter(0~500) */
  retryBaseMs?: number
  /** 进度回调：每完成一张图触发一次 */
  onProgress?: (completed: number, total: number) => void
}

/** OCR 失败的错误类别，便于上层 UI 和日志聚合 */
export type VisionOcrFailureCategory =
  | 'timeout'        // 连续重试仍超时
  | 'rate-limit'     // 429，已重试用尽
  | 'server-error'   // 5xx，已重试用尽
  | 'network'        // 网络层，已重试用尽
  | 'client-error'   // 4xx（非 429），不重试
  | 'empty-response' // 模型返回空 content
  | 'truncated'      // finish_reason === 'length'，输出被截断
  | 'parse-error'    // 响应 JSON 解析失败
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

/**
 * 并发调用 Vision 模型对多张图表页图片做 OCR。
 *
 * 使用和 document-formatter 里一致的 worker-based 并发模式：
 *   - 固定 N 个 worker，每个 worker 从共享 cursor 领任务
 *   - 单任务失败不影响其他 worker
 *   - 按完成顺序触发 onProgress，按原序写入 results
 *
 * @param images - base64 data URL 数组（data:image/png;base64,...）
 * @param options - 见 VisionOcrOptions
 * @returns `{ results, failures }` — results 长度等于 images.length，失败位为 null
 *
 * @example
 * ```ts
 * const { results, failures } = await callVisionOcr(images, {
 *   apiKey: 'sk-...',
 *   baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
 *   onProgress: (done, total) => console.log(`${done}/${total}`),
 * })
 * if (failures.length > 0) console.warn(`${failures.length} 张图 OCR 失败`)
 * const cleanResults = results.filter((r): r is string => r !== null)
 * ```
 */
/**
 * 判断错误是否可重试。
 *
 * 可重试：timeout / network / 429 限流 / 5xx 服务端错误
 * 不可重试：4xx（非 429）客户端错误（认证失败、图片格式错误、参数错误等）、
 *           aborted（用户主动取消）、非 HttpError 异常（JSON 解析等）
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false
  if (err.type === 'timeout' || err.type === 'network') return true
  if (err.type === 'http') {
    if (err.status === 429) return true
    if (err.status !== undefined && err.status >= 500) return true
    return false
  }
  // aborted → 不重试（用户主动取消）
  return false
}

/** 将 HttpError / 其他错误映射为 VisionOcrFailureCategory */
function classifyError(err: unknown): VisionOcrFailureCategory {
  if (err instanceof HttpError) {
    if (err.type === 'timeout') return 'timeout'
    if (err.type === 'network') return 'network'
    if (err.type === 'http') {
      if (err.status === 429) return 'rate-limit'
      if (err.status !== undefined && err.status >= 500) return 'server-error'
      return 'client-error'
    }
  }
  if (err instanceof SyntaxError) return 'parse-error'
  return 'unknown'
}

/** 指数退避 sleep：base * 2^attempt + jitter(0~500ms) */
function backoffDelay(attempt: number, baseMs: number): number {
  return baseMs * Math.pow(2, attempt) + Math.floor(Math.random() * 500)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
    onProgress,
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

  /** 发一次 request + 解析响应。成功返回 OCR 文本，失败抛结构化异常。 */
  async function callOnce(imageBase64: string): Promise<string> {
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
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
      }),
      timeoutMs,
    })
    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string }
        finish_reason?: string
      }>
    }
    const choice = data.choices?.[0]
    const text = choice?.message?.content ?? ''
    if (!text) {
      // 空 content 抛特殊错误，不走重试（模型真的觉得没内容）
      const err = new Error('empty response from vision model')
      ;(err as Error & { __visionCategory?: VisionOcrFailureCategory }).__visionCategory = 'empty-response'
      throw err
    }
    if (choice?.finish_reason === 'length') {
      // 输出被 max_tokens 截断。不重试（重试同样会截），但标记类别让上层知道。
      // 注意：虽然截断但 content 已经有部分内容，仍然返回这部分（比完全丢弃好）。
      const err = new Error(`vision response truncated by max_tokens (${maxTokens})`)
      ;(err as Error & { __visionCategory?: VisionOcrFailureCategory; __visionPartial?: string }).__visionCategory = 'truncated'
      ;(err as Error & { __visionPartial?: string }).__visionPartial = text
      throw err
    }
    return text
  }

  /** 处理单张图：含 retry 循环 + 错误分类 */
  async function processOne(idx: number): Promise<void> {
    let attempt = 0
    let lastErr: unknown = null
    while (attempt <= maxRetries) {
      try {
        const text = await callOnce(images[idx])
        results[idx] = cleanOcrHtml(text)
        return
      } catch (err) {
        lastErr = err
        // empty-response / truncated 都不重试
        const visionCategory = (err as Error & { __visionCategory?: VisionOcrFailureCategory }).__visionCategory
        if (visionCategory) {
          if (visionCategory === 'truncated') {
            // 截断情况下仍然记录已有内容，再登记失败
            const partial = (err as Error & { __visionPartial?: string }).__visionPartial
            if (partial) results[idx] = cleanOcrHtml(partial)
          }
          break
        }
        if (attempt < maxRetries && isRetryable(err)) {
          await sleep(backoffDelay(attempt, retryBaseMs))
          attempt++
          continue
        }
        break
      }
    }

    // 走到这里说明失败（或截断）
    const category =
      (lastErr as Error & { __visionCategory?: VisionOcrFailureCategory }).__visionCategory ??
      classifyError(lastErr)
    const httpStatus = lastErr instanceof HttpError ? lastErr.status : undefined
    failures.push({
      index: idx,
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      category,
      attempts: attempt + 1,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    })
  }

  async function worker(): Promise<void> {
    while (cursor < total) {
      const idx = cursor++
      await processOne(idx)
      completed++
      if (onProgress) onProgress(completed, total)
    }
  }

  const workerCount = Math.min(concurrency, total)
  if (workerCount === 0) return { results, failures }
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return { results, failures }
}
