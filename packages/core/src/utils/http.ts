/**
 * HTTP 请求工具：统一超时控制与错误分类。
 *
 * 全项目统一使用 fetchWithTimeout 发起 HTTP 请求，
 * 禁止直接调用 fetch —— 防止遗漏超时设置导致请求无限挂起。
 *
 * @author zhi.qu
 * @date 2026-04-10
 */

/** fetch 请求选项，扩展标准 RequestInit */
export interface FetchWithTimeoutOptions extends Omit<RequestInit, 'signal'> {
  /** 超时时间（毫秒），默认 30000ms */
  timeoutMs?: number
  /** 外部 AbortSignal，可用于用户主动取消 */
  signal?: AbortSignal
}

/** HTTP 请求错误，携带错误分类便于上层统一处理 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly type: 'timeout' | 'network' | 'http' | 'aborted',
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 带超时控制的 fetch 封装。
 *
 * - 默认 30 秒超时，LLM 等慢请求可设置更长的 timeoutMs
 * - 支持与外部 AbortSignal 合并（外部取消时也会中止请求）
 * - 错误分为 timeout / network / http / aborted 四类
 *
 * @example
 * ```ts
 * const res = await fetchWithTimeout('https://api.example.com/data', {
 *   method: 'POST',
 *   body: JSON.stringify({ query: 'hello' }),
 *   headers: { 'Content-Type': 'application/json' },
 *   timeoutMs: 60_000,
 * })
 * const data = await res.json()
 * ```
 *
 * @throws {HttpError} 请求失败时抛出，可通过 error.type 区分原因
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: externalSignal, ...fetchOptions } = options

  const controller = new AbortController()

  const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)

  const onExternalAbort = () => controller.abort(externalSignal?.reason)
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId)
      throw new HttpError('请求已取消', 'aborted')
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal })

    if (!response.ok) {
      throw new HttpError(
        `HTTP ${response.status} ${response.statusText}: ${url}`,
        'http',
        response.status,
      )
    }

    return response
  } catch (err) {
    if (err instanceof HttpError) throw err

    if (err instanceof Error) {
      if (err.name === 'AbortError' || err.message === 'This operation was aborted') {
        if (externalSignal?.aborted) {
          throw new HttpError('请求已取消', 'aborted')
        }
        throw new HttpError(`请求超时 (${timeoutMs}ms): ${url}`, 'timeout')
      }
      throw new HttpError(`网络错误: ${err.message}`, 'network')
    }

    throw new HttpError(`未知错误: ${String(err)}`, 'network')
  } finally {
    clearTimeout(timeoutId)
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }
}
