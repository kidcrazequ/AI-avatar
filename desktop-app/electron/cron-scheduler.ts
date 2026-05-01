/**
 * CronScheduler: 通用定时任务调度器。
 *
 * 扩展自 ScheduledTester 的定时触发模式，支持多种任务类型：
 * - memory-consolidate: 定时整理记忆（检查容量并调用 LLM 整理）
 * - knowledge-check: 定时检查知识库更新状态
 * - scheduled-test: 定时自检（原有功能）
 *
 * 配置持久化到 settings 表，key 前缀为 `cron_`。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */

import { BrowserWindow } from 'electron'

/** 定时任务类型 */
export type CronTaskType = 'memory-consolidate' | 'knowledge-check' | 'scheduled-test'

/** 定时任务配置 */
export interface CronTaskConfig {
  type: CronTaskType
  intervalHours: number
  avatarId?: string
  enabled: boolean
}

/** 定时任务事件（发送给渲染进程的 IPC 事件名） */
const TASK_EVENT_MAP: Record<CronTaskType, string> = {
  'memory-consolidate': 'cron-memory-consolidate',
  'knowledge-check': 'cron-knowledge-check',
  'scheduled-test': 'scheduled-test-trigger',
}

export class CronScheduler {
  private timers = new Map<CronTaskType, NodeJS.Timeout>()
  private mainWindow: BrowserWindow | null = null

  setWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  /**
   * 启动定时任务。
   *
   * @param config - 任务配置
   */
  schedule(config: CronTaskConfig): void {
    this.cancel(config.type)
    if (!config.enabled || config.intervalHours <= 0) return
    if (!config.avatarId) {
      console.warn(`[CronScheduler] ${config.type} 缺少 avatarId，跳过调度`)
      return
    }
    // 最小间隔 0.1 小时（6 分钟），防止误传极小值导致高频触发
    const MIN_INTERVAL_HOURS = 0.1
    if (config.intervalHours < MIN_INTERVAL_HOURS) {
      console.warn(`[CronScheduler] ${config.type} 间隔 ${config.intervalHours}h 低于最小值 ${MIN_INTERVAL_HOURS}h，已修正`)
    }
    const effectiveHours = Math.max(config.intervalHours, MIN_INTERVAL_HOURS)

    const { type, avatarId } = config
    const intervalMs = effectiveHours * 60 * 60 * 1000
    const timer = setInterval(() => {
      this.trigger(type, avatarId)
    }, intervalMs)
    this.timers.set(type, timer)
  }

  /** 取消指定类型的任务 */
  cancel(type: CronTaskType): void {
    const timer = this.timers.get(type)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(type)
    }
  }

  /** 取消所有任务 */
  cancelAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
  }

  /** 手动触发指定类型任务 */
  trigger(type: CronTaskType, avatarId?: string): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    if (!avatarId) {
      console.warn(`[CronScheduler] ${type} 触发时缺少 avatarId，跳过`)
      return
    }
    const event = TASK_EVENT_MAP[type]
    this.mainWindow.webContents.send(event, avatarId)
  }

  /** 获取当前运行中的任务列表 */
  getRunningTypes(): CronTaskType[] {
    return Array.from(this.timers.keys())
  }
}
