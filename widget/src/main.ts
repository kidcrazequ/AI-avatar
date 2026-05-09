/**
 * Soul Embed widget IIFE 入口。
 *
 * 自执行任务：
 *   1. 注册 <soul-embed> Custom Element（重复 define 会抛错，所以做 has() 判断）
 *   2. 把当前 <script> 的 origin 作为 fallback widget-server URL，存到模块级变量供 element.ts 读取
 *      —— 这样用户嵌入代码可以省掉 data-server，只写 <soul-embed embed-id="..."></soul-embed>
 *
 * @author zhi.qu
 * @date 2026-05-09
 */
import { SoulEmbedElement } from './element'

/**
 * 模块级 fallback server URL：从注入此 bundle 的 <script src> 中推断。
 * 仅在 element.ts 拿不到 data-server attr 时使用。
 */
let fallbackServerUrl: string | null = null

function inferFallbackServer(): void {
  if (typeof document === 'undefined') return
  // currentScript 仅在 <script> 同步执行期间有效；vite dev 模式下是 undefined（这种情况下 fallback 留空）
  const script = document.currentScript as HTMLScriptElement | null
  if (script && script.src) {
    try {
      const u = new URL(script.src)
      fallbackServerUrl = `${u.protocol}//${u.host}`
    } catch {
      // 非法 URL：忽略，留 null
    }
  }
}

export function getFallbackServerUrl(): string | null {
  return fallbackServerUrl
}

if (typeof window !== 'undefined') {
  inferFallbackServer()
  if (!customElements.get('soul-embed')) {
    customElements.define('soul-embed', SoulEmbedElement)
  }
}
