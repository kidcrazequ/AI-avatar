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
import { Cron } from 'croner'

/** 定时任务类型（内置三类，固定枚举） */
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

/**
 * 「cron 表达式」用户自定义任务的内部状态（#11 Scheduled Tasks）。
 * taskId 为业务键（与 schedules.id 同），同名注册会先 cancel 再注册。
 */
interface CronJobState {
  taskId: string
  cronExpr: string
  timezone: string
  job: Cron
}

export class CronScheduler {
  private timers = new Map<CronTaskType, NodeJS.Timeout>()
  private dailyCallbacks = new Map<string, DailyCallbackState>()
  /** #11：用户自定义 cron 任务（按 taskId 索引，与三类内置任务的 timers Map 完全分离） */
  private cronJobs = new Map<string, CronJobState>()
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

  /** 取消所有任务（包括 daily callback 与 cron 任务） */
  cancelAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
    this.cancelAllDaily()
    this.cancelAllCron()
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

  // ─── #11 Scheduled Tasks: 用户自定义 cron 任务 ────────────────────────────

  /**
   * 注册一条用户自定义 cron 任务（#11 Scheduled Tasks）。
   *
   * 与 schedule() 的区别：
   * - 触发时间由 cron 表达式描述（标准 5 字段，精度到分钟），不是固定间隔
   * - 不通过 webContents.send 通知渲染端，而是直接在主进程跑 callback；
   *   触发链路上层（main.ts 的 schedule:trigger 监听）再决定是否 forward 给渲染端
   * - 同名 taskId 会先 cancel 再注册（覆盖语义）
   *
   * cron_expr 校验：失败抛 Error（croner 解析时报错），调用方应在创建/更新 schedule 时
   * 提前 catch，转化为用户可见的表单校验错误。
   *
   * @param taskId schedules.id（必须，作为 cancelCron / triggerCron 的键）
   * @param cronExpr 标准 5 字段 cron（如 `0 9 * * *` 每天 09:00）
   * @param timezone IANA timezone（如 'Asia/Shanghai'）
   * @param callback 触发时执行的主进程回调（异步函数也可，scheduler 不等结果）
   */
  scheduleCron(
    taskId: string,
    cronExpr: string,
    timezone: string,
    callback: (firedAtUtc: number) => void | Promise<void>,
  ): void {
    if (!taskId) throw new Error('scheduleCron: taskId 不能为空')
    if (!cronExpr) throw new Error('scheduleCron: cronExpr 不能为空')

    this.cancelCron(taskId)

    // croner 内部维护 setTimeout 链，自动按 cron 表达式触发；timezone 处理由 croner 完成。
    // unref 留给 croner 默认（Electron 主进程不需要 unref，应用退出由 cancelAll 主动停止）。
    const job = new Cron(
      cronExpr,
      { timezone, name: `soul-schedule-${taskId}`, paused: false },
      () => {
        // croner 提供的 fire 时刻 = 此次触发时刻；用 Date.now() 取整到秒避免毫秒级抖动
        const firedAtUtc = Math.floor(Date.now() / 1000) * 1000
        Promise.resolve()
          .then(() => callback(firedAtUtc))
          .catch((err) => {
            console.error(`[CronScheduler] cron task '${taskId}' callback 抛错:`, err)
          })
      },
    )

    this.cronJobs.set(taskId, { taskId, cronExpr, timezone, job })
  }

  /** 取消一条 cron 任务 */
  cancelCron(taskId: string): void {
    const state = this.cronJobs.get(taskId)
    if (!state) return
    state.job.stop()
    this.cronJobs.delete(taskId)
  }

  /** 取消全部 cron 任务（cancelAll 内部调用） */
  cancelAllCron(): void {
    for (const state of this.cronJobs.values()) {
      state.job.stop()
    }
    this.cronJobs.clear()
  }

  /** 调试 / UI 用：列出已注册的 cron taskId */
  getRunningCronTaskIds(): string[] {
    return Array.from(this.cronJobs.keys())
  }

  /**
   * 计算某 cron 表达式接下来 n 次触发时间（用于 UI 预览，不影响实际调度）。
   * 失败（cron 表达式非法）抛 Error。
   *
   * @param cronExpr 标准 5 字段 cron
   * @param timezone IANA timezone
   * @param n 计算次数（建议 ≤ 5）
   * @param fromTs 起始时刻（默认 Date.now()，测试可注入固定值）
   * @returns 下 n 次触发的 Unix ms 时间戳数组
   */
  getNextRuns(cronExpr: string, timezone: string, n: number, fromTs?: number): number[] {
    if (n <= 0) return []
    const probe = new Cron(cronExpr, { timezone, paused: true })
    try {
      const result: number[] = []
      let cursor = fromTs !== undefined ? new Date(fromTs) : new Date()
      for (let i = 0; i < n; i++) {
        const next = probe.nextRun(cursor)
        if (!next) break
        result.push(next.getTime())
        // 下一次从这次触发时刻 + 1ms 开始算（避免重复返回同一时刻）
        cursor = new Date(next.getTime() + 1)
      }
      return result
    } finally {
      probe.stop()
    }
  }

  /** 是否已注册某 cron 任务（trigger-now IPC 用于校验） */
  hasCronTask(taskId: string): boolean {
    return this.cronJobs.has(taskId)
  }

  // ─── 内置三类任务 ────────────────────────────────────────────────────────

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
