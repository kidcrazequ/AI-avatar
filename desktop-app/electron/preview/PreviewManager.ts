/**
 * 预览管理器：管理 user / hidden 两个 WebContentsView。
 *
 * user：用户可见，固定在主窗口右侧 PreviewPane 区域，由渲染进程通过 IPC 报告 bounds。
 * hidden：LLM 操作的预览（截图、跑代码、verifier 比对），不绘制到屏幕。
 *
 * 关键能力：
 *   - load：加载本地文件 / URL，注入 conversationId 到 preview-preload
 *   - eval：在指定 view 中跑 JS（getReturnValue 模式）
 *   - screenshot：capturePage，保存或返回 dataURL
 *   - getLogs：返回 console-message 历史
 *   - 自定义 webRequest 拦截：把 unpkg "production.min.js" 重写为 development，便于 react inspector 反查
 *   - 反向 IPC：preview:block-selected / preview:tweaks-* / preview:size-changed 转发到 mainWindow
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import fs from 'fs'
import path from 'path'
import { BrowserWindow, WebContentsView, app, ipcMain, session } from 'electron'

type TargetView = 'user' | 'hidden'

interface PreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_USER_BOUNDS: PreviewBounds = { x: 0, y: 0, width: 0, height: 0 }

export class PreviewManager {
  private userView: WebContentsView
  private hiddenView: WebContentsView
  private logs: string[] = []
  private userBounds: PreviewBounds = DEFAULT_USER_BOUNDS
  private currentConversationId: string = 'unknown'

  constructor(private readonly mainWindow: BrowserWindow, preloadPath: string) {
    const previewSession = session.fromPartition('persist:soul-preview')
    this.installWebRequestRewrites(previewSession)

    this.userView = new WebContentsView({
      webPreferences: {
        partition: 'persist:soul-preview',
        contextIsolation: true,
        nodeIntegration: false,
        preload: preloadPath,
      },
    })
    this.hiddenView = new WebContentsView({
      webPreferences: {
        partition: 'persist:soul-preview',
        contextIsolation: true,
        nodeIntegration: false,
        preload: preloadPath,
      },
    })
    this.mainWindow.contentView.addChildView(this.userView)
    this.mainWindow.contentView.addChildView(this.hiddenView)
    this.hiddenView.setVisible(false)
    this.bindLogs(this.userView, 'user')
    this.bindLogs(this.hiddenView, 'hidden')
    this.userView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    this.hiddenView.setBounds({ x: 0, y: 0, width: 1, height: 1 })

    this.installRendererBridges()
  }

  /** 渲染进程通过 'preview:set-bounds' 报告 PreviewPane 的实际位置 */
  setUserBounds(bounds: PreviewBounds): void {
    this.userBounds = {
      x: Math.max(0, Math.floor(bounds.x)),
      y: Math.max(0, Math.floor(bounds.y)),
      width: Math.max(0, Math.floor(bounds.width)),
      height: Math.max(0, Math.floor(bounds.height)),
    }
    this.userView.setBounds(this.userBounds)
  }

  /** 主窗口尺寸变化时按比例兜底（如果渲染进程还没设置过 bounds） */
  updateBounds(): void {
    if (this.userBounds.width > 0) {
      this.userView.setBounds(this.userBounds)
      return
    }
    const bounds = this.mainWindow.getContentBounds()
    const userWidth = Math.floor(bounds.width * 0.42)
    this.userView.setBounds({
      x: bounds.width - userWidth,
      y: 0,
      width: userWidth,
      height: bounds.height,
    })
    this.hiddenView.setBounds({ x: 0, y: 0, width: 1, height: 1 })
  }

  /** 主进程会改变是否显示 user view（比如切走预览面板时隐藏） */
  setUserVisible(visible: boolean): void {
    this.userView.setVisible(visible)
  }

  async load(target: TargetView, filePath: string, conversationId?: string): Promise<void> {
    const view = target === 'user' ? this.userView : this.hiddenView
    if (conversationId) this.currentConversationId = conversationId
    const isHtml = filePath.toLowerCase().endsWith('.html') || filePath.toLowerCase().endsWith('.htm')
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)
    if (!fs.existsSync(abs)) {
      throw new Error(`预览文件不存在: ${abs}`)
    }
    if (!isHtml) {
      await view.webContents.loadURL(`file://${abs}`)
    } else {
      await view.webContents.loadFile(abs)
    }
    // 通过 IPC 推一次 bootstrap 给 preview-preload，让它知道当前 conversationId
    try {
      view.webContents.send('preview:bootstrap', {
        conversationId: this.currentConversationId,
        inspector: false,
      })
    } catch {}
  }

  async eval(target: TargetView, code: string): Promise<unknown> {
    const view = target === 'user' ? this.userView : this.hiddenView
    return view.webContents.executeJavaScript(code, true)
  }

  async screenshot(
    target: TargetView,
    savePath?: string,
  ): Promise<{ path?: string; dataUrl?: string; width: number; height: number }> {
    const view = target === 'user' ? this.userView : this.hiddenView
    const image = await view.webContents.capturePage()
    const size = image.getSize()
    if (savePath) {
      const abs = path.isAbsolute(savePath) ? savePath : path.join(app.getPath('userData'), savePath)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, image.toPNG())
      return { path: abs, width: size.width, height: size.height }
    }
    return { dataUrl: image.toDataURL(), width: size.width, height: size.height }
  }

  getLogs(): string[] {
    return this.logs.slice(-300)
  }

  /** 启用/关闭 inspector 模式（指定 view） */
  setInspector(target: TargetView, enabled: boolean): void {
    const view = target === 'user' ? this.userView : this.hiddenView
    view.webContents.send('preview:bootstrap', {
      conversationId: this.currentConversationId,
      inspector: enabled,
    })
  }

  private bindLogs(view: WebContentsView, name: TargetView): void {
    view.webContents.on('console-message', (_event, level, message) => {
      const line = `[${name}][${level}] ${message}`
      this.logs.push(line)
      if (this.logs.length > 500) this.logs = this.logs.slice(-500)
    })
  }

  /**
   * webRequest 拦截：
   *   - 把 unpkg/cdnjs 上的 react/react-dom production.min.js 替换为 development.js
   *     这样 inspector 才能看到 displayName。生产构建里 React 会丢掉组件名。
   */
  private installWebRequestRewrites(sess: Electron.Session): void {
    sess.webRequest.onBeforeRequest({ urls: ['*://unpkg.com/*', '*://cdnjs.cloudflare.com/*'] }, (details, callback) => {
      const url = details.url
      // 仅匹配 react / react-dom 的 production.min.js
      const m = url.match(/(react|react-dom|react-dom-client)(\.production\.min)\.js$/)
      if (m) {
        const replaced = url.replace(`${m[1]}.production.min.js`, `${m[1]}.development.js`)
        callback({ redirectURL: replaced })
        return
      }
      callback({})
    })
  }

  /**
   * 把 preview-preload 通过 ipcRenderer.send(...) 上报的事件转给主窗口。
   * 主窗口侧 React 会监听 'preview:block-selected' / 'preview:tweaks-*'
   * 并把 payload 渲染成附件、提示等。
   */
  private installRendererBridges(): void {
    const forward = (channel: string): void => {
      ipcMain.on(channel, (_event, payload) => {
        try {
          if (!this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(channel, payload)
          }
        } catch {}
      })
    }
    forward('preview:block-selected')
    forward('preview:tweaks-available')
    forward('preview:tweaks-save')
    forward('preview:size-changed')
  }
}
