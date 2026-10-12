/**
 * 上下文溢出错误识别（借鉴 Pi Coding Agent 的 "prompt too long → 压缩后重试一次"）。
 *
 * 两家 Provider 都把原始报错正文保留在 error.message 末尾：
 *   - Anthropic：`Anthropic API 请求失败 (400): prompt is too long: 250000 tokens > 200000 maximum`
 *   - OpenAI-compat：`API 请求失败 (400): This model's maximum context length is ... tokens ...`
 * 因此无需改 Provider 即可识别（同时也尊重上游显式打的 isContextOverflow 标记，便于未来扩展）。
 *
 * 保守匹配"上下文/token 超限"的常见英文签名，避开 401/403/429/网络/AbortError/
 * reasoning_content/thinking 参数 等其它 400，避免把非溢出错误也触发压缩重试。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[\s_-]?length/i,
  /context window/i,
  /maximum context/i,
  /context_length_exceeded/i,
  /prompt is too long/i,
  /input length and max_tokens exceed/i,
  /too many (input )?tokens/i,
  /reduce the (length|number|amount) of/i,
]

/**
 * 判断一个错误是否为"上下文/提示过长"类溢出。命中即可触发"压缩活动路径后重试一次"。
 * 既识别 message 里的英文签名，也尊重 (error as any).isContextOverflow === true 显式标记。
 */
export function isContextOverflowError(error: unknown): boolean {
  if (
    error !== null &&
    typeof error === 'object' &&
    (error as { isContextOverflow?: unknown }).isContextOverflow === true
  ) {
    return true
  }
  const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!msg) return false
  return OVERFLOW_PATTERNS.some((re) => re.test(msg))
}
