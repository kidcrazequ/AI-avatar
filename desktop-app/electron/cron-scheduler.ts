/**
 * CronScheduler: 通用定时任务调度器。
 *
 * 扩展自 ScheduledTester 的定时触发模式，支持多种任务类型：
 * - memory-consolidate: 定时整理记忆（检查容量并调用 LLM 整理）
 * - knowledge-check: 定时检查知识库更新状态
 * - scheduled-test: 定时自检（原有功能）
 *
 * 另外提供「每日固定时间」回调调度（Phase 2 人生持续生长 cron 用）：
 * - scheduleDailyCallback(name, hour, minute, callback) 在每日 HH:MM 触发主进程回调
 * - 不依赖 webContents.send（直接 main 进程执行），不需要 avatarId
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

/**
 * 「每日固定时间」回调任务的内部状态。
 * 启动时先 setTimeout 等到第一次触发，之后用 setInterval(24h) 持续触发。
 */
interface DailyCallbackState {
  name: string
  hour: number
  minute: number
  callback: () => void | Promise<void>
  /** 第一次触发的 setTimeout（首次到 HH:MM 的等待） */
  firstTimer: NodeJS.Timeout | null
  /** 之后每 24 小时触发一次的 setInterval */
  intervalTimer: NodeJS.Timeout | null
}

export class CronScheduler {
  private timers = new Map<CronTaskType, NodeJS.Timeout>()
  private dailyCallbacks = new Map<string, DailyCallbackState>()
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

  /** 取消所有任务（包括 daily callback） */
  cancelAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
    this.cancelAllDaily()
  }

  /**
   * 注册「每日固定时间」回调任务（Phase 2 人生持续生长 cron 用）。
   *
   * 与 schedule() 的区别：
   * - 触发时间是固定 HH:MM（不是按 intervalHours），适合"每天 0:30 跑一次"
   * - 不通过 webContents.send 通知渲染端，而是直接在主进程跑 callback
   * - 不绑定 avatarId（callback 内部自行决定遍历哪些分身）
   *
   * 同名任务会被覆盖（先 cancelDaily 再注册）。
   *
   * @param name 任务名（如 'life-advance-all'），同名互斥
   * @param hour 24 小时制小时（0-23）
   * @param minute 分钟（0-59）
   * @param callback 触发时执行的主进程回调（异步函数也可，scheduler 不等结果）
   */
  scheduleDailyCallback(
    name: string,
    hour: number,
    minute: number,
    callback: () => void | Promise<void>,
  ): void {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error(`scheduleDailyCallback: 非法 hour=${hour}（应在 0-23）`)
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error(`scheduleDailyCallback: 非法 minute=${minute}（应在 0-59）`)
    }
    this.cancelDaily(name)

    const state: DailyCallbackState = {
      name,
      hour,
      minute,
      callback,
      firstTimer: null,
      intervalTimer: null,
    }

    const fire = () => {
      Promise.resolve()
        .then(() => callback())
        .catch((err) => {
          console.error(`[CronScheduler] daily '${name}' callback 抛错:`, err)
        })
    }

    const msUntilFirstFire = computeMsUntilNext(hour, minute, new Date())
    state.firstTimer = setTimeout(() => {
      fire()
      // 之后每 24 小时跑一次
      state.intervalTimer = setInterval(fire, 24 * 60 * 60 * 1000)
    }, msUntilFirstFire)

    this.dailyCallbacks.set(name, state)
  }

  /**
   * 立即触发一次某 daily callback（调试用，比如 life:advance-now 全局推进）。
   * 不影响下一次到点触发。
   */
  triggerDaily(name: string): boolean {
    const state = this.dailyCallbacks.get(name)
    if (!state) return false
    Promise.resolve()
      .then(() => state.callback())
      .catch((err) => {
        console.error(`[CronScheduler] daily '${name}' triggerDaily 抛错:`, err)
      })
    return true
  }

  /** 取消单个 daily callback */
  cancelDaily(name: string): void {
    const state = this.dailyCallbacks.get(name)
    if (!state) return
    if (state.firstTimer) clearTimeout(state.firstTimer)
    if (state.intervalTimer) clearInterval(state.intervalTimer)
    this.dailyCallbacks.delete(name)
  }

  /** 取消全部 daily callback */
  cancelAllDaily(): void {
    for (const name of Array.from(this.dailyCallbacks.keys())) {
      this.cancelDaily(name)
    }
  }

  /** 获取已注册的 daily callback 名称列表（调试 / 测试用） */
  getRunningDailyNames(): string[] {
    return Array.from(this.dailyCallbacks.keys())
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

/**
 * 计算从 now 到下一个 HH:MM 触发点的毫秒数。
 * 如果今天的 HH:MM 已过，则返回到明天的 HH:MM 的毫秒数。
 *
 * 本函数导出仅为了方便单测；运行时由 scheduleDailyCallback 内部使用。
 */
export function computeMsUntilNext(hour: number, minute: number, now: Date): number {
  const next = new Date(now)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1)
  }
  return next.getTime() - now.getTime()
}
