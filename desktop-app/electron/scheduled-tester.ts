import { BrowserWindow, Notification } from 'electron'

/**
 * ScheduledTester: 负责定时触发自检逻辑（GAP14）。
 * - 按配置频率发送 IPC 事件通知渲染进程运行测试
 * - 通过 Notification API 弹出系统桌面通知
 * - 通过 webContents.send 更新应用内红点状态
 */
export class ScheduledTester {
  private timer: NodeJS.Timeout | null = null
  private mainWindow: BrowserWindow | null = null

  setWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  /** 启动定时自检，intervalHours 为检测间隔（小时数，0 表示禁用） */
  start(avatarId: string, intervalHours: number) {
    this.stop()
    if (intervalHours <= 0) return

    const intervalMs = intervalHours * 60 * 60 * 1000
    this.timer = setInterval(() => {
      this.triggerTest(avatarId)
    }, intervalMs)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private triggerTest(avatarId: string) {
    if (!this.mainWindow) return

    // 通知渲染进程执行测试
    this.mainWindow.webContents.send('scheduled-test-trigger', avatarId)

    // 桌面通知（无需用户打开应用）
    if (Notification.isSupported()) {
      new Notification({
        title: '分身自检提醒',
        body: `分身 ${avatarId} 定时自检已触发，请查看测试结果。`,
        silent: false,
      }).show()
    }
  }

  /** 向渲染进程发送红点状态更新 */
  notifyTestResult(passed: boolean, total: number, failed: number) {
    if (!this.mainWindow) return
    this.mainWindow.webContents.send('test-result-badge', { passed, total, failed })
  }
}
