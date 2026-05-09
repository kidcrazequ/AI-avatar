/**
 * @file life-service.ts — 渲染端「人生经历」服务封装
 *
 * 职责：
 *   1. 把 `window.electronAPI.life` 系列 IPC 包装成方便 React 组件消费的纯函数；
 *   2. 提供 UI 显示用的格式化工具（年月、倒计时、时间速度标签）；
 *   3. 封装 `life:progress` 事件订阅生命周期（自动 unsubscribe）。
 *
 * 设计要点：
 *   - 所有错误都向上抛，由组件 try/catch + Toast + logEvent（react-renderer.mdc）；
 *   - 不引入 @soul/core 的 grower 函数（那里依赖 fs，渲染端会爆 process is not defined）；
 *   - 倒计时算法 inline 一份等价实现（与 grower.computeAvatarDeltaMonths 公式一致：
 *     30.4375 真实天 / timeScale = 1 个分身月）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

/** 与 grower.ts REAL_DAYS_PER_MONTH 同值；切勿调整 */
const REAL_DAYS_PER_MONTH = 30.4375

/** 合法 timeScale 选项（与 main.ts:LifeStartGenerationParams 校验一致） */
export const VALID_TIME_SCALES = [0, 1, 12, 52] as const
export type LifeTimeScale = (typeof VALID_TIME_SCALES)[number]

/** 一次性拉齐 LifePanel 首屏所需的全部状态（manifest + timeline + progress + consolidated） */
export interface LifeBundle {
  manifest: LifeManifest | null
  timeline: LifeTimelineEntry[]
  progress: LifeProgress | null
  consolidated: string
}

/**
 * 一次并发拉齐 manifest / timeline / progress / consolidated。
 * 任一 IPC 失败都向上抛错（由调用方决定降级或提示）。
 */
export async function loadLifeBundle(avatarId: string): Promise<LifeBundle> {
  const [manifest, timeline, progress, consolidated] = await Promise.all([
    window.electronAPI.life.getManifest(avatarId),
    window.electronAPI.life.listTimeline(avatarId),
    window.electronAPI.life.getProgress(avatarId),
    window.electronAPI.life.readConsolidated(avatarId),
  ])
  return { manifest, timeline, progress, consolidated }
}

/**
 * 仅订阅自己关心的 avatarId 的 progress 推送，自动按 avatarId 过滤。
 * @returns unsubscribe 函数（组件卸载时必须调用）
 */
export function subscribeLifeProgress(
  avatarId: string,
  callback: (payload: LifeProgressPayload) => void,
): () => void {
  return window.electronAPI.life.onProgress((payload) => {
    if (payload.avatarId !== avatarId) return
    callback(payload)
  })
}

// ─── 倒计时计算（纯函数，与 grower.ts:208 逻辑等价） ────────────────────────────

/**
 * 反向计算「距下次生长还有多少毫秒」。
 *
 * 推导：grower 推进逻辑要求 avatarDeltaMonths = floor(realDeltaMs / msPerMonth × timeScale) >= 1。
 * 因此到下次推进至少需要：
 *   realDeltaMs_required = ceil(1 × msPerMonth / timeScale)
 *
 * @param lastAdvancedAt manifest.lastAdvancedAt（ISO 串）
 * @param timeScale 分身/真实时间倍率（0 = 冻结，返回 Infinity）
 * @param now 当前真实时间，缺省 new Date()
 * @returns 距下次推进的毫秒数；timeScale<=0 或解析失败时返回 Infinity
 */
export function computeNextGrowthMs(
  lastAdvancedAt: string,
  timeScale: number,
  now: Date = new Date(),
): number {
  if (!Number.isFinite(timeScale) || timeScale <= 0) return Number.POSITIVE_INFINITY
  const lastTs = Date.parse(lastAdvancedAt)
  if (!Number.isFinite(lastTs)) return Number.POSITIVE_INFINITY
  const msPerAvatarMonth = (REAL_DAYS_PER_MONTH * 24 * 60 * 60 * 1000) / timeScale
  const elapsed = now.getTime() - lastTs
  const remaining = msPerAvatarMonth - elapsed
  return remaining > 0 ? Math.ceil(remaining) : 0
}

/**
 * 把 computeNextGrowthMs 输出格式化为「X 天 Y 时」。
 * 对应 plan 4.2 ASCII「下次生长：还有 18 天 17 时」。
 */
export function formatNextGrowthEta(
  lastAdvancedAt: string,
  timeScale: number,
  growthEnabled: boolean,
  generationStatus: LifeGenerationStatus,
  now: Date = new Date(),
): string {
  if (!growthEnabled) return '已暂停生长'
  if (timeScale <= 0) return '已冻结'
  if (generationStatus === 'generating') return '生成中…'
  if (generationStatus === 'failed') return '生成失败'
  const ms = computeNextGrowthMs(lastAdvancedAt, timeScale, now)
  if (!Number.isFinite(ms)) return '—'
  if (ms <= 0) return '已就绪，下次 cron 将推进'
  const totalHours = Math.floor(ms / (60 * 60 * 1000))
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  if (days > 0) return `还有 ${days} 天 ${hours} 时`
  if (hours > 0) return `还有 ${hours} 时`
  const minutes = Math.max(1, Math.ceil(ms / (60 * 1000)))
  return `还有 ${minutes} 分`
}

/**
 * 估算调到 newScale 后落后的"分身月"。用于 LifeTimeScaleModal 的"按 12× 计算落后：1 年 0 月"提示。
 *
 * @returns avatarMonthsBehind 落后多少个分身月（floor 后的整数）
 */
export function estimateBacklogMonths(
  lastAdvancedAt: string,
  newTimeScale: number,
  now: Date = new Date(),
): number {
  if (!Number.isFinite(newTimeScale) || newTimeScale <= 0) return 0
  const lastTs = Date.parse(lastAdvancedAt)
  if (!Number.isFinite(lastTs)) return 0
  const realDeltaMs = now.getTime() - lastTs
  if (realDeltaMs <= 0) return 0
  const realDeltaMonths = realDeltaMs / (REAL_DAYS_PER_MONTH * 24 * 60 * 60 * 1000)
  return Math.floor(realDeltaMonths * newTimeScale)
}

/** 把分身月数格式化为「X 年 Y 月」 */
export function formatAvatarMonths(months: number): string {
  if (months <= 0) return '0 月'
  const years = Math.floor(months / 12)
  const remainder = months % 12
  if (years > 0 && remainder > 0) return `${years} 年 ${remainder} 月`
  if (years > 0) return `${years} 年`
  return `${remainder} 月`
}

/**
 * timeScale → 中文标签。0 → 冻结。
 * 对应 plan 4.3 时间速度选项标签。
 */
export function formatTimeScaleLabel(timeScale: number): string {
  if (timeScale === 0) return '冻结（不随真实时间生长）'
  if (timeScale === 1) return '1× 真实同步（1 月→1 月）'
  if (timeScale === 12) return '12× 加速（1 月→1 年）'
  if (timeScale === 52) return '52× 加速（1 周→1 年）'
  return `${timeScale}× 自定义`
}

/**
 * currentAgeMonths → 「X 岁 Y 月」（plan 4.2 子标题用）。
 * 兼容非整数月或负数（虽然不应该出现）。
 */
export function formatAgeFromMonths(currentAgeMonths: number): string {
  if (!Number.isFinite(currentAgeMonths) || currentAgeMonths < 0) return '—'
  const totalMonths = Math.floor(currentAgeMonths)
  const years = Math.floor(totalMonths / 12)
  const months = totalMonths % 12
  if (months === 0) return `${years} 岁`
  return `${years} 岁 ${months} 月`
}

/**
 * 数 timeline 中标记 'remembered' 的事件数（plan 4.2 子标题"还记得 K 件"）。
 */
export function countRemembered(timeline: LifeTimelineEntry[]): number {
  let n = 0
  for (const entry of timeline) {
    if (entry.consolidationStatus === 'remembered') n += 1
  }
  return n
}

/**
 * 估算遗忘曲线"剩余强度"百分比（用于 EpisodeViewer 的 ████░░ 进度条）。
 *
 * 简化模型：
 *   强度 = clamp(importance × 10 - age_gap × 0.8 + emotion × 3, 0, 100)
 *
 * 这只是 UI 直观提示，不是真实遗忘公式（真实公式在 forgetter.ts，这里仅做视觉化约等）。
 *
 * @param entry timeline 条目
 * @param currentAgeYears 分身当前岁数（取自 manifest.currentAgeMonths/12）
 * @returns 0~100 整数
 */
export function estimateMemoryStrength(
  entry: LifeTimelineEntry,
  currentAgeYears: number,
): number {
  const ageGap = Math.max(0, currentAgeYears - entry.age)
  const raw = entry.importance * 10 - ageGap * 0.8 + entry.emotion * 3
  if (entry.consolidationStatus === 'forgotten') {
    return Math.max(0, Math.min(20, Math.round(raw * 0.2)))
  }
  if (entry.consolidationStatus === 'blurred') {
    return Math.max(15, Math.min(60, Math.round(raw * 0.6)))
  }
  return Math.max(40, Math.min(100, Math.round(raw)))
}

/**
 * 判断 LifePanel 应该处于哪种状态。
 * 集中决策避免组件里散写多个三元运算。
 */
export type LifePanelMode =
  | 'no-life'        // manifest = null：从未生成
  | 'generating'    // generationStatus = generating | pending：初始化进行中
  | 'failed'        // generationStatus = failed
  | 'ready'         // generationStatus = complete
  | 'growing'       // generationStatus = growing（已就绪 + 正在持续生长）

export function deriveLifePanelMode(
  manifest: LifeManifest | null,
  progress: LifeProgress | null,
): LifePanelMode {
  // 优先级 1：progress.stage='failed' 是最可信的失败信号
  // （generator 历史 bug 可能让 manifest.generationStatus 残留 'generating' 而 progress 已 failed，
  //  此时 UI 必须切到 FailedView，否则用户会卡在错乱的进度条上找不到重试入口）
  if (progress && progress.stage === 'failed') return 'failed'

  // manifest 还没出来但 progress 已经在跑（启动后第一次 webContents.send 到达前的窗口期，
  // 或 generator 写 manifest 之前就被订阅到第一个 progress）→ 视为 generating，避免回到 no-life
  const progressActive =
    progress &&
    progress.stage !== 'idle' &&
    progress.stage !== 'complete' &&
    progress.stage !== 'failed' &&
    progress.stage !== 'growing'
  if (!manifest) {
    return progressActive ? 'generating' : 'no-life'
  }
  if (manifest.generationStatus === 'failed') return 'failed'
  if (manifest.generationStatus === 'generating' || manifest.generationStatus === 'pending') {
    return 'generating'
  }
  if (manifest.generationStatus === 'growing') return 'growing'
  // complete 状态下若 progress.stage 还在初始化阶段，按 generating 处理（边界保护）
  if (progressActive) return 'generating'
  return 'ready'
}

/**
 * 计算进度条百分比（0~100）。Stage 2 是大头，按 episodes/totalEpisodes 算。
 */
export function computeProgressPercent(progress: LifeProgress | null): number {
  if (!progress) return 0
  if (progress.totalEpisodes <= 0) {
    // 还在 manifest / outline 阶段，按 stage 给个粗略值
    if (progress.stage === 'manifest') return 5
    if (progress.stage === 'outline') return 15
    if (progress.stage === 'forgetting') return 95
    if (progress.stage === 'complete') return 100
    return 0
  }
  const ratio = progress.completedEpisodes / progress.totalEpisodes
  // 把 episodes 进度压缩到 [20, 90] 区间，留出 manifest/outline/forgetting 的份额
  const pct = 20 + Math.min(1, Math.max(0, ratio)) * 70
  if (progress.stage === 'forgetting') return Math.max(pct, 95)
  if (progress.stage === 'complete') return 100
  return Math.round(pct)
}
