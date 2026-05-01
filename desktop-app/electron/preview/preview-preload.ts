/**
 * preview-preload：被 PreviewManager 创建的两个 WebContentsView 加载的 preload 脚本。
 *
 * 职责（与主聊天窗口的 preload.ts 完全独立，避免污染）：
 *   1. 暴露 window.claude.complete：通过 ipcRenderer.invoke('claudebridge:complete') 调主进程 LLM
 *   2. inspector 模式：Cmd+Click（macOS）/ Ctrl+Click（Win/Linux）选中元素，把
 *      DOM 信息（tag/class/id/data-cc-id/text）+ React 组件名（如能拿到）+
 *      源码片段位置（HEREDOC <!--SRC line=NN-->）以 IPC 推回主进程
 *   3. Tweaks 协议：监听 page 内 postMessage('__edit_mode_available' / '__edit_mode_save')，
 *      把编辑变更通过 IPC 转给主进程，主进程负责回写源 HTML 文件的 EDITMODE-BEGIN/END 块
 *   4. React DevTools shim：把全局 __REACT_DEVTOOLS_GLOBAL_HOOK__ 撑起来，让生产构建
 *      也能注册 fiber root，inspector 才能拿到组件名
 *   5. data-cc-id 标记：DOM 渲染稳定后给每个可见元素打 data-cc-id="cc-N"
 *      作为反射的稳定锚点
 *
 * 注意：本文件在沙盒环境运行，import 必须只用 electron 内置；尽量不引入 @soul/core。
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron'

interface BlockReflectPayload {
  conversationId: string
  ccId: string
  tag: string
  classes: string
  id: string
  text: string
  reactComponentName?: string
  sourceHint?: { file: string; line: number } | null
  rect: { x: number; y: number; width: number; height: number }
}

interface TweaksAvailablePayload {
  conversationId: string
  controls: Array<{ id: string; type: string; label?: string; value?: unknown }>
}

interface TweaksSavePayload {
  conversationId: string
  values: Record<string, unknown>
}

let conversationId = 'unknown'
let inspectorEnabled = false

// React DevTools 全局钩子最小 shim：让生产构建的 React 仍然把 fiber 注册进来，
// 否则 inspector 拿不到组件名。仅为只读，不参与调度。
function ensureReactDevtoolsShim(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 全局 hook 类型来自外部库，运行时形状不固定
  const w = window as any
  if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__) return
  const renderers = new Map<number, unknown>()
  let nextId = 1
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers,
    inject: (renderer: unknown) => {
      const id = nextId++
      renderers.set(id, renderer)
      return id
    },
    onCommitFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
    onScheduleFiberRoot: () => {},
    onPostCommitFiberRoot: () => {},
    checkDCE: () => {},
  }
}

/** 给可见元素打 data-cc-id（cc-1, cc-2, ...）；已存在则跳过 */
function stampCcIds(): number {
  let n = 0
  let seq = 1
  // 跳过 script/style/meta/link 等不可见元素
  const SKIP = new Set(['script', 'style', 'meta', 'link', 'head', 'noscript'])
  const all = document.body?.querySelectorAll('*') ?? ([] as unknown as NodeListOf<Element>)
  for (const el of Array.from(all)) {
    const tag = el.tagName.toLowerCase()
    if (SKIP.has(tag)) continue
    if (el.hasAttribute('data-cc-id')) {
      const existing = parseInt(el.getAttribute('data-cc-id')!.replace(/^cc-/, ''), 10) || 0
      if (existing >= seq) seq = existing + 1
      continue
    }
    el.setAttribute('data-cc-id', `cc-${seq++}`)
    n += 1
  }
  return n
}

/** 从 element 反查 React 组件名（基于 fiber tag.type.displayName / type.name） */
function lookupReactComponentName(el: Element): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- React fiber 内部字段，不导出类型
  const keys = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) as keyof Element | undefined
  if (!keys) return undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- React fiber 链路类型不公开
  let node: any = (el as any)[keys]
  for (let i = 0; i < 20 && node; i++) {
    const type = node.type
    if (typeof type === 'string') return type
    if (type) {
      const name = type.displayName || type.name
      if (name) return name
    }
    node = node.return
  }
  return undefined
}

/** 从 HTML 注释 <!--src=line=NN--> 反推源代码位置（如果有） */
function lookupSourceHint(el: Element): { file: string; line: number } | null {
  // 简单实现：往上找最近的注释节点
  let cur: Node | null = el
  while (cur) {
    let prev: Node | null = cur.previousSibling
    while (prev) {
      if (prev.nodeType === Node.COMMENT_NODE) {
        const m = (prev.nodeValue || '').match(/src\s*=\s*([^\s,]+).*?line\s*=\s*(\d+)/i)
        if (m) return { file: m[1], line: parseInt(m[2], 10) }
      }
      prev = prev.previousSibling
    }
    cur = cur.parentNode
  }
  return null
}

function buildBlockReflectPayload(el: Element): BlockReflectPayload {
  const rect = el.getBoundingClientRect()
  const ccId = el.getAttribute('data-cc-id') ?? ''
  return {
    conversationId,
    ccId,
    tag: el.tagName.toLowerCase(),
    classes: (el.getAttribute('class') ?? '').slice(0, 200),
    id: el.getAttribute('id') ?? '',
    text: (el.textContent ?? '').trim().slice(0, 200),
    reactComponentName: lookupReactComponentName(el),
    sourceHint: lookupSourceHint(el),
    rect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  }
}

function ensureInspectorOverlay(): HTMLDivElement {
  let overlay = document.getElementById('__soul_inspector_overlay__') as HTMLDivElement | null
  if (overlay) return overlay
  overlay = document.createElement('div')
  overlay.id = '__soul_inspector_overlay__'
  overlay.style.cssText = `
    position: fixed; pointer-events: none; z-index: 2147483647;
    border: 2px solid rgba(56, 189, 248, .9); background: rgba(56, 189, 248, .12);
    border-radius: 4px; transition: all .08s ease-out;
    display: none;
  `
  document.documentElement.appendChild(overlay)
  return overlay
}

function setupInspectorListeners(): void {
  const overlay = ensureInspectorOverlay()

  document.addEventListener('mousemove', (ev) => {
    if (!inspectorEnabled) return
    const target = ev.target as Element | null
    if (!target || target.id === '__soul_inspector_overlay__') return
    const rect = target.getBoundingClientRect()
    overlay.style.display = 'block'
    overlay.style.left = `${rect.left}px`
    overlay.style.top = `${rect.top}px`
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`
  }, true)

  document.addEventListener('click', (ev) => {
    if (!inspectorEnabled) return
    const isModified = ev.metaKey || ev.ctrlKey
    if (!isModified) return
    ev.preventDefault()
    ev.stopPropagation()
    const target = ev.target as Element | null
    if (!target) return
    const payload = buildBlockReflectPayload(target)
    ipcRenderer.send('preview:block-selected', payload)
    inspectorEnabled = false
    overlay.style.display = 'none'
  }, true)

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && inspectorEnabled) {
      inspectorEnabled = false
      overlay.style.display = 'none'
    }
  })
}

function setupTweaksProtocol(): void {
  // 页面侧规约：
  //   window.parent.postMessage({ source: 'soul-tweaks', type: 'available', controls: [...] }, '*')
  //   window.parent.postMessage({ source: 'soul-tweaks', type: 'save', values: {...} }, '*')
  window.addEventListener('message', (ev) => {
    const data = ev.data as { source?: string; type?: string; controls?: TweaksAvailablePayload['controls']; values?: Record<string, unknown> } | null
    if (!data || data.source !== 'soul-tweaks') return
    if (data.type === 'available') {
      ipcRenderer.send('preview:tweaks-available', {
        conversationId,
        controls: data.controls ?? [],
      } satisfies TweaksAvailablePayload)
    } else if (data.type === 'save') {
      ipcRenderer.send('preview:tweaks-save', {
        conversationId,
        values: data.values ?? {},
      } satisfies TweaksSavePayload)
    }
  })
}

function setupResizeObserver(): void {
  // 页面尺寸变化时通知主进程，便于动态调整 setBounds
  const ro = new ResizeObserver((entries) => {
    const last = entries[entries.length - 1]
    if (!last) return
    const rect = last.contentRect
    ipcRenderer.send('preview:size-changed', {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
  })
  if (document.documentElement) ro.observe(document.documentElement)
}

contextBridge.exposeInMainWorld('__soulPreview', {
  setConversationId: (id: string) => {
    if (typeof id === 'string' && id.length > 0) conversationId = id
  },
  enableInspector: (enable: boolean) => {
    inspectorEnabled = !!enable
    if (!inspectorEnabled) {
      const overlay = document.getElementById('__soul_inspector_overlay__')
      if (overlay) overlay.style.display = 'none'
    }
  },
  rescanCcIds: () => stampCcIds(),
})

contextBridge.exposeInMainWorld('claude', {
  /**
   * 给 HTML 工件用的极简补全 API。
   *  - 接受字符串 prompt 或 { messages: [{role,content}, ...] }
   *  - 受主进程多层限流约束
   */
  complete: async (input: unknown, filePath?: string): Promise<string> => {
    const safeInput = typeof input === 'string'
      ? input
      : (input && typeof input === 'object' ? JSON.parse(JSON.stringify(input)) : String(input))
    return ipcRenderer.invoke('claudebridge:complete', conversationId, safeInput, filePath)
  },
})

// 主进程在加载完页面后通过 webContents.send('preview:bootstrap', {...}) 推过来
ipcRenderer.on('preview:bootstrap', (_e, payload: { conversationId?: string; inspector?: boolean }) => {
  if (payload.conversationId) conversationId = payload.conversationId
  if (typeof payload.inspector === 'boolean') inspectorEnabled = payload.inspector
})

window.addEventListener('DOMContentLoaded', () => {
  ensureReactDevtoolsShim()
  setupInspectorListeners()
  setupTweaksProtocol()
  setupResizeObserver()
  // 渲染稳定后再扫一遍 cc-id（很多框架在 first paint 后才挂载子树）
  setTimeout(() => {
    try { stampCcIds() } catch {}
  }, 200)
})

// 保留 webFrame 引用避免被 tree-shake
void webFrame
