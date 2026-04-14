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

import { fetchWithTimeout } from './http'
import { cleanOcrHtml } from './ocr-html-cleaner'

/** 默认 Vision 模型 */
export const DEFAULT_VISION_MODEL = 'qwen-vl-max'

/** 默认并发数。DashScope 常见限流阈值允许 3 并发稳定运行。 */
export const DEFAULT_VISION_CONCURRENCY = 3

/** 单次 Vision 调用超时（3 分钟），大图 OCR 偶尔需要 60-120 秒。 */
export const DEFAULT_VISION_TIMEOUT_MS = 180_000

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
  /** 单请求超时（ms），默认 180000 */
  timeoutMs?: number
  /** Prompt 覆盖（可选）*/
  prompt?: string
  /** 单图最大 tokens，默认 4096 */
  maxTokens?: number
  /** 进度回调：每完成一张图触发一次 */
  onProgress?: (completed: number, total: number) => void
}

export interface VisionOcrFailure {
  /** 原始 images 数组中的下标 */
  index: number
  /** 错误消息 */
  error: string
}

export interface VisionOcrResult {
  /**
   * OCR 结果数组，下标与输入 `images` 一一对应。
   * 失败的位置为 `null`，成功的位置为 cleanOcrHtml 后的 Markdown。
   * 不使用紧凑数组是为了让调用方能按原 imagePageNumbers 对应关系处理。
   */
  results: Array<string | null>
  /** 失败详情列表 */
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
    maxTokens = 4096,
    onProgress,
  } = options

  if (!apiKey) throw new Error('callVisionOcr: apiKey 必填')
  if (!baseUrl) throw new Error('callVisionOcr: baseUrl 必填')

  const total = images.length
  const results: Array<string | null> = new Array(total).fill(null)
  const failures: VisionOcrFailure[] = []
  let cursor = 0
  let completed = 0

  async function processOne(idx: number): Promise<void> {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: images[idx] } },
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
        choices?: Array<{ message?: { content?: string } }>
      }
      const text = data.choices?.[0]?.message?.content ?? ''
      if (text) {
        results[idx] = cleanOcrHtml(text)
      } else {
        failures.push({ index: idx, error: 'empty response from vision model' })
      }
    } catch (err) {
      failures.push({
        index: idx,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      completed++
      if (onProgress) onProgress(completed, total)
    }
  }

  async function worker(): Promise<void> {
    while (cursor < total) {
      const idx = cursor++
      await processOne(idx)
    }
  }

  const workerCount = Math.min(concurrency, total)
  if (workerCount === 0) return { results, failures }
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return { results, failures }
}
