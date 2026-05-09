/**
 * <soul-embed> Custom Element 实现。
 *
 * 职责：
 *   1. attachShadow（mode: 'open'）—— 与父页样式 / DOM 完全隔离
 *   2. 把 styles.ts 的 CSS 注入 shadow 根的 <style>
 *   3. 渲染 Preact App 到 shadow 根
 *   4. 解析 attribute：embed-id（必填） / data-server（可选；缺省走 main.ts 的 fallback）
 *   5. disconnectedCallback 清理 Preact 树（render(null, root)）
 *
 * 不监听 attributeChangedCallback —— widget 实例化后参数不应变化（如要改请重 mount 元素）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */
import { h, render } from 'preact'
import { App } from './App'
import { STYLES } from './styles'
import { getFallbackServerUrl } from './main'

export class SoulEmbedElement extends HTMLElement {
  private shadow: ShadowRoot | null = null
  private mountPoint: HTMLDivElement | null = null

  connectedCallback(): void {
    if (this.shadow) return // 防御：已挂载过

    const embedId = this.getAttribute('embed-id') ?? this.dataset.embedId ?? ''
    const serverFromAttr = this.getAttribute('data-server') ?? this.dataset.server ?? ''
    const serverUrl = serverFromAttr || getFallbackServerUrl() || ''

    this.shadow = this.attachShadow({ mode: 'open' })

    const styleEl = document.createElement('style')
    styleEl.textContent = STYLES
    this.shadow.appendChild(styleEl)

    const mount = document.createElement('div')
    mount.className = 'soul-mount'
    this.shadow.appendChild(mount)
    this.mountPoint = mount

    if (embedId.length === 0 || serverUrl.length === 0) {
      // 缺参时降级为占位错误，不抛异常（避免阻塞父页）
      const err = document.createElement('div')
      err.style.cssText =
        'padding:12px;font:13px -apple-system,sans-serif;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;'
      err.textContent = '[soul-embed] 缺少必填参数：embed-id 或 data-server'
      mount.appendChild(err)
      return
    }

    render(h(App, { embedId, serverUrl }), mount)
  }

  disconnectedCallback(): void {
    if (this.mountPoint) {
      try {
        render(null, this.mountPoint)
      } catch {
        // 卸载失败兜底：保留 shadow，避免崩溃父页
      }
      this.mountPoint = null
    }
    this.shadow = null
  }
}
