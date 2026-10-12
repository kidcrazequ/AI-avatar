/**
 * 「人生经历」持续生长（Stage 4，cron 调度）。
 *
 * 流程总览（plan 2.2 节 Step 4.1~4.5）：
 *   Step 4.1：算时间增量 realDeltaMonths × timeScale → avatarDeltaMonths
 *   Step 4.2：对 [currentAgeMonths..newAgeMonths] 每个月按 d(age) 投骰子
 *   Step 4.3：对每个抽中月份调 LLM 生成 outline（1 项）+ episode 正文
 *   Step 4.4：触发条件 reconsolidate（>=5 episodes 或 >=30 天）
 *   Step 4.5：刷新 manifest（lastAdvancedAt / currentAgeMonths / totalEpisodes）
 *
 * 设计要点：
 *   - 纯外部依赖注入：avatarsRoot / nowFn / randomFn / callLLMs 全部可 mock
 *   - 单分身失败不影响其他分身（advanceAllAvatars 各自 try/catch）
 *   - LLM 调用失败重试 1 次，仍失败标进 progress.failedEpisodes
 *   - timeline 孤儿防护：episode 写盘失败时回滚 timeline 条目
 *   - 内存级生长锁（lifeGrowthLocks）避免和 generator 并发竞争
 *
 * 边界处理（plan 要求必测）：
 *   - timeScale = 0     → 跳过（avatarDeltaMonths = 0）
 *   - growthEnabled = false → 跳过
 *   - generationStatus = 'generating' → 跳过（避免和初始化打架）
 *   - 仅记录 lastAdvancedAt 不生成事件 → 也算成功推进
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import type { LLMCallFn } from '../document-formatter'
import {
  applyAlgorithmicForgetting,
  generateConsolidated,
} from './forgetter'
import {
  appendNewEpisodeForGrowth,
} from './generator'
import {
  buildOutlinePrompt,
  OUTLINE_SYSTEM_PROMPT,
} from './prompts'
import {
  appendLifeTimelineEntry,
  readLifeManifest,
  readLifeProgress,
  readLifeTimeline,
  writeLifeConsolidated,
  writeLifeManifest,
  writeLifeProgress,
  writeLifeTimeline,
} from './store'
import type {
  LifeEmotionType,
  LifeEventCategory,
  LifeFailedEpisode,
  LifeManifest,
  LifeProgress,
  LifeTimelineEntry,
} from './types'
import {
  DEFAULT_DENSITY_WEIGHTS,
  eventDensityPerMonth,
  monthsToYears,
  type DensityWeights,
} from './density'

// ─── 公共常量 ────────────────────────────────────────────────────────────────

/** plan 2.2 Step 4.4：reconsolidate 默认阈值 */
export interface ReconsolidateThresholds {
  /** 距上次 reconsolidate 新增 episodes 数（默认 5） */
  episodeThreshold: number
  /** 距上次 reconsolidate 真实时间天数（默认 30） */
  daysThreshold: number
}

export const DEFAULT_RECONSOLIDATE_THRESHOLDS: ReconsolidateThresholds = {
  episodeThreshold: 5,
  daysThreshold: 30,
}

/** LLM 失败时的重试次数（plan 要求重试 1 次） */
const LLM_RETRY_TIMES = 1

/** 单次推进最多生成 episode 数；防止时间跨度极大时 LLM 调用爆炸 */
const MAX_NEW_EPISODES_PER_ADVANCE = 60

// ─── 公共类型 ────────────────────────────────────────────────────────────────

/** advanceLife 入参 */
export interface AdvanceLifeOptions {
  avatarsRoot: string
  avatarId: string
  /** Phase 1 buildLifeLLMConfig 同款配置（creation + chat） */
  llms: {
    creationLLM: LLMCallFn
    chatLLM: LLMCallFn
    creationConfigured: boolean
  }
  /** 当前真实时间（注入便于测试，默认 () => new Date()） */
  now?: () => Date
  /** 随机数源（注入便于测试，默认 Math.random） */
  random?: () => number
  /** 自定义事件密度权重（默认 DEFAULT_DENSITY_WEIGHTS） */
  densityWeights?: DensityWeights
  /** 自定义 reconsolidate 阈值（默认 DEFAULT_RECONSOLIDATE_THRESHOLDS） */
  thresholds?: ReconsolidateThresholds
  /** 推进进度回调（可空；与 generator 共用 LifeProgress 形态） */
  onProgress?: (progress: LifeProgress) => void
  abortSignal?: AbortSignal
}

/** advanceLife 单次推进的结果摘要 */
export interface AdvanceLifeResult {
  /** 是否真正推进（false 表示因 timeScale=0/growthEnabled=false/generating 等被跳过） */
  advanced: boolean
  /** 跳过原因（advanced=false 时填） */
  skipReason?:
    | 'no-manifest'
    | 'growth-disabled'
    | 'time-frozen'
    | 'generation-in-progress'
    | 'sub-month-delta'
    | 'locked'
  /** 推进掉的分身月数（未跳过时 >= 1） */
  avatarDeltaMonths: number
  /** 新生成成功的 episode 数 */
  newEpisodes: number
  /** 本次失败的 episode 数（已记入 progress.failedEpisodes） */
  failedEpisodes: number
  /** 是否触发了 reconsolidate */
  reconsolidated: boolean
}

/** advanceAllAvatars 入参 */
export interface AdvanceAllAvatarsOptions {
  avatarsRoot: string
  /** 全部分身 ID 列表（main.ts 通过 AvatarManager.listAvatars 获取） */
  avatarIds: string[]
  /** 与 advanceLife 一致的 LLM 配置 */
  llms: {
    creationLLM: LLMCallFn
    chatLLM: LLMCallFn
    creationConfigured: boolean
  }
  now?: () => Date
  random?: () => number
  densityWeights?: DensityWeights
  thresholds?: ReconsolidateThresholds
  /** 单分身进度回调（可空） */
  onAvatarProgress?: (avatarId: string, progress: LifeProgress) => void
  /** 单分身完成后回调 */
  onAvatarSettled?: (avatarId: string, result: AdvanceLifeResult | { error: string }) => void
}

/** advanceAllAvatars 汇总结果 */
export interface AdvanceAllAvatarsResult {
  total: number
  advanced: number
  skipped: number
  failed: number
  details: Array<{
    avatarId: string
    result?: AdvanceLifeResult
    error?: string
  }>
}

// ─── 内存级并发锁（防止 cron 与 generator / 多次 cron 并发推进同一分身） ───

const activeGrowthLocks = new Set<string>()

/**
 * 试图获取单分身的生长锁；获取失败说明该分身已在生长中。
 * 调用方在 advanceLife 顶部调用，结束（成功/失败）必须调 releaseGrowthLock。
 */
function acquireGrowthLock(avatarId: string): boolean {
  if (activeGrowthLocks.has(avatarId)) return false
  activeGrowthLocks.add(avatarId)
  return true
}

function releaseGrowthLock(avatarId: string): void {
  activeGrowthLocks.delete(avatarId)
}

/** 测试钩子：清空所有锁（仅在单测 beforeEach 用） */
export function __clearGrowthLocksForTesting(): void {
  activeGrowthLocks.clear()
}

// ─── 时间换算（Step 4.1，纯函数，可单独测试） ────────────────────────────────

/** 1 个真实月默认按 30.4375 天（365.25 / 12）算 */
const REAL_DAYS_PER_MONTH = 30.4375

/**
 * 计算「真实时间 → 分身时间」的月增量（Step 4.1）。
 *
 * @param now 当前真实时间
 * @param lastAdvancedAt 上次推进的 ISO 字符串
 * @param timeScale 时间倍率（0 = 冻结，1 = 真实同步，12 = 12×，52 = 52×）
 * @returns 分身月数（向下取整；< 1 时返回 0）
 *
 * 边界：
 *   - now < lastAdvancedAt（系统时钟回拨）→ 返回 0
 *   - timeScale = 0 → 返回 0
 *   - lastAdvancedAt 解析失败 → 返回 0（静默兜底，避免 cron 阻塞）
 */
export function computeAvatarDeltaMonths(
  now: Date,
  lastAdvancedAt: string,
  timeScale: number,
): number {
  if (!Number.isFinite(timeScale) || timeScale <= 0) return 0
  const lastTs = Date.parse(lastAdvancedAt)
  if (!Number.isFinite(lastTs)) return 0
  const realDeltaMs = now.getTime() - lastTs
  if (realDeltaMs <= 0) return 0
  const realDeltaMonths = realDeltaMs / (REAL_DAYS_PER_MONTH * 24 * 60 * 60 * 1000)
  const avatarMonths = realDeltaMonths * timeScale
  return Math.floor(avatarMonths)
}

// ─── 事件密度抽样（Step 4.2，纯函数） ────────────────────────────────────────

/**
 * 对 [fromMonth..toMonth) 的每个月按 density(age) 投骰子，返回触发新事件的月份偏移。
 *
 * @param fromAgeMonths 起始月（含），通常 = currentAgeMonths
 * @param toAgeMonths 终止月（不含），通常 = newAgeMonths
 * @param random 随机数源 ∈ [0, 1)
 * @param weights 密度参数，缺省 DEFAULT_DENSITY_WEIGHTS
 * @returns 触发的月份偏移（绝对月数，便于 grower 算 age/year/month）
 */
export function samplePendingMonths(
  fromAgeMonths: number,
  toAgeMonths: number,
  random: () => number,
  weights: DensityWeights = DEFAULT_DENSITY_WEIGHTS,
): number[] {
  const triggered: number[] = []
  if (toAgeMonths <= fromAgeMonths) return triggered
  for (let m = fromAgeMonths; m < toAgeMonths; m++) {
    const ageYears = monthsToYears(m)
    const p = eventDensityPerMonth(ageYears, weights)
    if (random() < p) {
      triggered.push(m)
      if (triggered.length >= MAX_NEW_EPISODES_PER_ADVANCE) break
    }
  }
  return triggered
}

// ─── reconsolidate 阈值判定（Step 4.4，纯函数） ─────────────────────────────

/**
 * 判定是否触发 reconsolidate。
 * 条件（满足任一）：
 *   - (currentTotalEpisodes - lastConsolidatedTotal) >= episodeThreshold
 *   - (now - lastConsolidatedAt) >= daysThreshold * 24h
 *
 * @param currentTotalEpisodes 推进后 timeline 条目总数
 * @param lastConsolidatedTotal progress.consolidationLastTotalEpisodes
 * @param lastConsolidatedAt manifest.lastConsolidatedAt（ISO）
 * @param now 当前真实时间
 * @param thresholds 阈值
 */
export function shouldReconsolidate(
  currentTotalEpisodes: number,
  lastConsolidatedTotal: number,
  lastConsolidatedAt: string,
  now: Date,
  thresholds: ReconsolidateThresholds = DEFAULT_RECONSOLIDATE_THRESHOLDS,
): boolean {
  const episodeDelta = currentTotalEpisodes - lastConsolidatedTotal
  if (episodeDelta >= thresholds.episodeThreshold) return true
  const lastTs = Date.parse(lastConsolidatedAt)
  if (!Number.isFinite(lastTs)) return true // 从未 reconsolidate 过 → 触发
  const dayMs = 24 * 60 * 60 * 1000
  const daysSince = (now.getTime() - lastTs) / dayMs
  return daysSince >= thresholds.daysThreshold
}

// ─── 主入口：advanceLife（单分身） ──────────────────────────────────────────

/**
 * 单分身推进一次（cron 每天调一次 / 用户调试时手动调一次）。
 *
 * 不抛错（abort 除外）；失败原因写入 progress.lastError，调用方通过
 * onProgress 或 readLifeProgress 取。AbortError 会向上抛。
 */
export async function advanceLife(opts: AdvanceLifeOptions): Promise<AdvanceLifeResult> {
  const now = (opts.now ?? (() => new Date()))()
  const random = opts.random ?? Math.random
  const densityWeights = opts.densityWeights ?? DEFAULT_DENSITY_WEIGHTS
  const thresholds = opts.thresholds ?? DEFAULT_RECONSOLIDATE_THRESHOLDS

  // 内存锁：防止两次 cron 并发或 cron 与 advance-now 并发
  if (!acquireGrowthLock(opts.avatarId)) {
    return makeSkippedResult('locked', 0)
  }

  try {
    throwIfAborted(opts.abortSignal)

    const manifest = await readLifeManifest(opts.avatarsRoot, opts.avatarId)
    if (!manifest) {
      return makeSkippedResult('no-manifest', 0)
    }
    if (!manifest.growthEnabled) {
      return makeSkippedResult('growth-disabled', 0)
    }
    if (manifest.timeScale === 0) {
      return makeSkippedResult('time-frozen', 0)
    }
    if (manifest.generationStatus === 'generating') {
      return makeSkippedResult('generation-in-progress', 0)
    }

    // Step 4.1
    const avatarDeltaMonths = computeAvatarDeltaMonths(
      now,
      manifest.lastAdvancedAt,
      manifest.timeScale,
    )
    if (avatarDeltaMonths < 1) {
      return makeSkippedResult('sub-month-delta', avatarDeltaMonths)
    }

    const newAgeMonths = manifest.currentAgeMonths + avatarDeltaMonths

    // Step 4.2
    const triggeredMonths = samplePendingMonths(
      manifest.currentAgeMonths,
      newAgeMonths,
      random,
      densityWeights,
    )

    // 即使没触发任何事件也算"推进成功"——更新时间戳即可
    let newEpisodes = 0
    let failedEpisodes = 0
    const callLLM = opts.llms.creationConfigured ? opts.llms.creationLLM : opts.llms.chatLLM

    // 读 progress（不存在则构造一个 idle 占位 → 推进结束改为 'growing'）
    const progress = (await readLifeProgress(opts.avatarsRoot, opts.avatarId))
      ?? createGrowthInitialProgress(now, manifest)

    if (triggeredMonths.length > 0) {
      progress.stage = 'growing'
      progress.lastError = ''
      progress.totalEpisodes = manifest.totalEpisodes + triggeredMonths.length
      progress.updatedAt = now.toISOString()
      await persistProgress(opts, progress)

      const timelineSnapshot = await readLifeTimeline(opts.avatarsRoot, opts.avatarId)
      let episodeSeqStart = computeNextEpisodeSeq(timelineSnapshot)

      // Step 4.3：逐月生成（顺序，避免和初始化的并发池竞争 LLM 配额）
      for (const monthOffset of triggeredMonths) {
        throwIfAborted(opts.abortSignal)
        const ageYears = monthsToYears(monthOffset)
        const monthInYear = (monthOffset % 12) + 1

        try {
          const entry = await generateGrowthEntry({
            manifest,
            ageYears,
            monthInYear,
            episodeSeq: episodeSeqStart,
            previousTitles: timelineSnapshot.slice(-12).map(e => e.title),
            callLLM,
            abortSignal: opts.abortSignal,
            now,
          })
          // 先 append timeline，再生成 episode 正文。失败时回滚 timeline。
          await appendLifeTimelineEntry(opts.avatarsRoot, opts.avatarId, entry)
          try {
            const episode = await retryWithRollbackEpisode({
              opts,
              manifest,
              entry,
              callLLM,
            })
            // 把 wordCount 回填到 timeline.json
            await patchTimelineWordCount(opts.avatarsRoot, opts.avatarId, entry.id, episode.content.length)
            newEpisodes += 1
            episodeSeqStart += 1
            timelineSnapshot.push({ ...entry, wordCount: episode.content.length })
            progress.completedEpisodes += 1
            progress.updatedAt = now.toISOString()
            await persistProgress(opts, progress)
          } catch (writeErr) {
            // 回滚 timeline 条目（episode 没写成功，避免孤儿）
            await rollbackTimelineEntry(opts.avatarsRoot, opts.avatarId, entry.id)
            throw writeErr
          }
        } catch (err) {
          if (isAbortError(err)) throw err
          failedEpisodes += 1
          const failedRecord: LifeFailedEpisode = {
            id: `growth-${monthOffset}`,
            error: err instanceof Error ? err.message : String(err),
            failedAt: now.toISOString(),
          }
          progress.failedEpisodes.push(failedRecord)
          progress.lastError = failedRecord.error
          progress.updatedAt = now.toISOString()
          await persistProgress(opts, progress)
          // 单事件失败不阻塞后续月份，继续下一个
        }
      }
    }

    // Step 4.4：reconsolidate 条件触发
    let reconsolidated = false
    const updatedTotalEpisodes = manifest.totalEpisodes + newEpisodes
    if (
      newEpisodes > 0
      && shouldReconsolidate(
        updatedTotalEpisodes,
        progress.consolidationLastTotalEpisodes,
        manifest.lastConsolidatedAt,
        now,
        thresholds,
      )
    ) {
      try {
        await runReconsolidate({
          opts,
          manifest,
          callLLM,
          now,
        })
        reconsolidated = true
        progress.consolidationLastTotalEpisodes = updatedTotalEpisodes
      } catch (err) {
        if (isAbortError(err)) throw err
        progress.lastError = `reconsolidate 失败：${err instanceof Error ? err.message : String(err)}`
      }
    }

    // Step 4.5：更新 manifest
    const refreshedManifest: LifeManifest = {
      ...manifest,
      lastAdvancedAt: now.toISOString(),
      currentAgeMonths: newAgeMonths,
      totalEpisodes: updatedTotalEpisodes,
      generationStatus: 'growing',
      lastConsolidatedAt: reconsolidated ? now.toISOString() : manifest.lastConsolidatedAt,
      consolidationCounter: reconsolidated
        ? manifest.consolidationCounter + 1
        : manifest.consolidationCounter,
    }
    await writeLifeManifest(opts.avatarsRoot, opts.avatarId, refreshedManifest)

    // 推进收尾
    progress.stage = newEpisodes > 0 ? 'growing' : 'complete'
    progress.totalEpisodes = updatedTotalEpisodes
    progress.updatedAt = now.toISOString()
    await persistProgress(opts, progress)

    return {
      advanced: true,
      avatarDeltaMonths,
      newEpisodes,
      failedEpisodes,
      reconsolidated,
    }
  } finally {
    releaseGrowthLock(opts.avatarId)
  }
}

// ─── advanceAllAvatars（cron 入口） ─────────────────────────────────────────

/**
 * 遍历所有分身，逐个调 advanceLife。单分身失败不影响其他分身。
 *
 * cron 每天 0:30 触发一次。调用前由 main.ts 通过 AvatarManager.listAvatars
 * 拿到 avatarIds，注入进来——core 模块不依赖 fs 枚举目录。
 */
export async function advanceAllAvatars(
  opts: AdvanceAllAvatarsOptions,
): Promise<AdvanceAllAvatarsResult> {
  const result: AdvanceAllAvatarsResult = {
    total: opts.avatarIds.length,
    advanced: 0,
    skipped: 0,
    failed: 0,
    details: [],
  }

  for (const avatarId of opts.avatarIds) {
    try {
      const r = await advanceLife({
        avatarsRoot: opts.avatarsRoot,
        avatarId,
        llms: opts.llms,
        now: opts.now,
        random: opts.random,
        densityWeights: opts.densityWeights,
        thresholds: opts.thresholds,
        onProgress: opts.onAvatarProgress
          ? (p) => opts.onAvatarProgress?.(avatarId, p)
          : undefined,
      })
      if (r.advanced) result.advanced += 1
      else result.skipped += 1
      result.details.push({ avatarId, result: r })
      opts.onAvatarSettled?.(avatarId, r)
    } catch (err) {
      result.failed += 1
      const errMsg = err instanceof Error ? err.message : String(err)
      result.details.push({ avatarId, error: errMsg })
      opts.onAvatarSettled?.(avatarId, { error: errMsg })
    }
  }
  return result
}

// ─── 内部：生成单条 timeline entry（mini outline 调用） ────────────────────

interface GenerateGrowthEntryArgs {
  manifest: LifeManifest
  ageYears: number
  monthInYear: number
  episodeSeq: number
  previousTitles: string[]
  callLLM: LLMCallFn
  abortSignal: AbortSignal | undefined
  now: Date
}

/**
 * 让 LLM 为「指定月份」生成一条 outline，规整为 LifeTimelineEntry。
 *
 * 复用 buildOutlinePrompt（targetCount=1），并在 user prompt 末尾追加
 * 「现在是 ${ageYears} 岁的 ${monthInYear} 月，事件应发生在这个月」的提示。
 * 如果 LLM 返回的 age/month 偏离，强制矫正回 ageYears + monthInYear。
 */
async function generateGrowthEntry(args: GenerateGrowthEntryArgs): Promise<LifeTimelineEntry> {
  const {
    manifest,
    ageYears,
    monthInYear,
    episodeSeq,
    previousTitles,
    callLLM,
    abortSignal,
    now,
  } = args

  const userBase = buildOutlinePrompt({
    manifest,
    ageFrom: ageYears,
    ageTo: ageYears,
    targetCount: 1,
    previousTitles,
  })

  const realWorldHint = `\n\n# 当前真实时间提示\n现在是 ${now.getFullYear()} 年。这个事件发生在分身 ${ageYears} 岁那年的 ${monthInYear} 月（${manifest.birthYear + ageYears}.${monthInYear}）。请生成 1 条事件大纲，年份和月份必须严格匹配此提示。`

  const userPrompt = userBase + realWorldHint

  const raw = await retryLLM(
    () => callLLMWithAbort(callLLM, OUTLINE_SYSTEM_PROMPT, userPrompt, 1500, abortSignal),
    LLM_RETRY_TIMES,
    abortSignal,
  )

  const parsed = parseOutlineArray(raw)
  if (parsed.length === 0) {
    throw new Error(`grower outline LLM 返回空数组：${raw.slice(0, 200)}`)
  }
  const item = parsed[0]
  const title = ensureNonEmptyString(item.title, `${ageYears}岁的事件`).slice(0, 40)
  const id = formatGrowthEpisodeId(episodeSeq, title)

  return {
    id,
    age: ageYears,
    year: manifest.birthYear + ageYears,
    month: monthInYear,
    title,
    summary: ensureNonEmptyString(item.summary, '').slice(0, 80),
    category: normalizeCategory(item.category),
    themes: Array.isArray(item.themes)
      ? item.themes.map(s => String(s).slice(0, 20)).slice(0, 6)
      : [],
    importance: clampInt(item.importance, 0, 10, 5),
    emotion: clampInt(item.emotion, 0, 10, 5),
    emotionType: normalizeEmotionType(item.emotionType),
    wordCount: 0,
    consolidationStatus: 'remembered',
    consolidationNote: '',
  }
}

// ─── 内部：写 episode 正文（带重试 + 失败回滚 timeline 条目） ───────────────

interface RetryWithRollbackEpisodeArgs {
  opts: AdvanceLifeOptions
  manifest: LifeManifest
  entry: LifeTimelineEntry
  callLLM: LLMCallFn
}

async function retryWithRollbackEpisode(args: RetryWithRollbackEpisodeArgs) {
  return await retryLLM(
    () =>
      appendNewEpisodeForGrowth({
        avatarsRoot: args.opts.avatarsRoot,
        avatarId: args.opts.avatarId,
        manifest: args.manifest,
        entry: args.entry,
        callLLM: args.callLLM,
        abortSignal: args.opts.abortSignal,
      }),
    LLM_RETRY_TIMES,
    args.opts.abortSignal,
  )
}

async function rollbackTimelineEntry(
  avatarsRoot: string,
  avatarId: string,
  entryId: string,
): Promise<void> {
  const timeline = await readLifeTimeline(avatarsRoot, avatarId)
  const filtered = timeline.filter(e => e.id !== entryId)
  if (filtered.length === timeline.length) return
  await writeLifeTimeline(avatarsRoot, avatarId, filtered)
}

async function patchTimelineWordCount(
  avatarsRoot: string,
  avatarId: string,
  entryId: string,
  wordCount: number,
): Promise<void> {
  const timeline = await readLifeTimeline(avatarsRoot, avatarId)
  const idx = timeline.findIndex(e => e.id === entryId)
  if (idx < 0) return
  const next = timeline.slice()
  next[idx] = { ...next[idx], wordCount }
  await writeLifeTimeline(avatarsRoot, avatarId, next)
}

// ─── 内部：reconsolidate（Step 4.4 实际执行） ──────────────────────────────

interface RunReconsolidateArgs {
  opts: AdvanceLifeOptions
  manifest: LifeManifest
  callLLM: LLMCallFn
  now: Date
}

async function runReconsolidate(args: RunReconsolidateArgs): Promise<void> {
  const { opts, manifest, callLLM, now } = args
  const timeline = await readLifeTimeline(opts.avatarsRoot, opts.avatarId)
  const currentAge = monthsToYears(manifest.currentAgeMonths)

  // 3a：算法层重新打 consolidationStatus
  const flagged = applyAlgorithmicForgetting(timeline, currentAge)
  await writeLifeTimeline(opts.avatarsRoot, opts.avatarId, flagged)

  // 3b：AI 复盘重新生成 consolidated.md
  const consolidated = await generateConsolidated({
    manifest: { ...manifest, currentAgeMonths: manifest.currentAgeMonths },
    timeline: flagged,
    callLLM: (s, u, m) => callLLMWithAbort(callLLM, s, u, m ?? 8000, opts.abortSignal),
    wordTarget: 4000,
  })
  await writeLifeConsolidated(opts.avatarsRoot, opts.avatarId, consolidated)

  // 防御：若 reconsolidate 顺利完成，把 _now 标记到调用方更新 manifest
  void now // 显式消费，避免 lint warning
}

// ─── 内部：LLM 重试 + abort 兜底 ───────────────────────────────────────────

async function retryLLM<T>(
  fn: () => Promise<T>,
  retries: number,
  abortSignal: AbortSignal | undefined,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (abortSignal?.aborted) throw makeAbortError()
    try {
      return await fn()
    } catch (err) {
      if (isAbortError(err)) throw err
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function callLLMWithAbort(
  callLLM: LLMCallFn,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  if (!abortSignal) {
    return callLLM(systemPrompt, userPrompt, maxTokens)
  }
  if (abortSignal.aborted) throw makeAbortError()
  return new Promise<string>((resolve, reject) => {
    let done = false
    const onAbort = () => {
      if (done) return
      done = true
      reject(makeAbortError())
    }
    abortSignal.addEventListener('abort', onAbort, { once: true })
    callLLM(systemPrompt, userPrompt, maxTokens).then(
      (value) => {
        if (done) return
        done = true
        abortSignal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        if (done) return
        done = true
        abortSignal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw makeAbortError()
}

function makeAbortError(): Error {
  const err = new Error('生长已取消')
  err.name = 'AbortError'
  return err
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// ─── 内部：进度持久化 ─────────────────────────────────────────────────────

async function persistProgress(
  opts: AdvanceLifeOptions,
  progress: LifeProgress,
): Promise<void> {
  await writeLifeProgress(opts.avatarsRoot, opts.avatarId, progress)
  if (opts.onProgress) {
    try {
      opts.onProgress({ ...progress, failedEpisodes: [...progress.failedEpisodes] })
    } catch {
      // 回调异常不影响主流程；core 没有 logger，调用方自负
    }
  }
}

function createGrowthInitialProgress(now: Date, manifest: LifeManifest): LifeProgress {
  return {
    stage: 'growing',
    completedEpisodes: manifest.totalEpisodes,
    totalEpisodes: manifest.totalEpisodes,
    usedFallback: false,
    lastError: '',
    updatedAt: now.toISOString(),
    failedEpisodes: [],
    consolidationLastTotalEpisodes: manifest.totalEpisodes,
  }
}

// ─── 内部：JSON 解析 + 字段规整（与 generator.ts 同款，但只解析 outline 数组） ─

interface OutlineItemShape {
  age?: unknown
  year?: unknown
  month?: unknown
  title?: unknown
  summary?: unknown
  category?: unknown
  themes?: unknown
  importance?: unknown
  emotion?: unknown
  emotionType?: unknown
}

function parseOutlineArray(raw: string): OutlineItemShape[] {
  const text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`grower outline 解析失败：找不到 JSON 数组\n原文: ${text.slice(0, 200)}`)
  }
  const json = candidate.slice(start, end + 1)
  try {
    const arr = JSON.parse(json) as unknown
    if (!Array.isArray(arr)) {
      throw new Error('grower outline 解析失败：顶层不是数组')
    }
    return arr as OutlineItemShape[]
  } catch (err) {
    throw new Error(
      `grower outline JSON.parse 失败：${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

const VALID_CATEGORIES: ReadonlySet<LifeEventCategory> = new Set<LifeEventCategory>([
  'formative', 'daily', 'trauma', 'joy', 'professional', 'loss',
])

function normalizeCategory(value: unknown): LifeEventCategory {
  if (typeof value === 'string' && VALID_CATEGORIES.has(value as LifeEventCategory)) {
    return value as LifeEventCategory
  }
  return 'daily'
}

const VALID_EMOTIONS: ReadonlySet<LifeEmotionType> = new Set<LifeEmotionType>([
  'joy', 'sorrow', 'anger', 'fear', 'wonder', 'shame', 'love',
])

function normalizeEmotionType(value: unknown): LifeEmotionType {
  if (typeof value === 'string' && VALID_EMOTIONS.has(value as LifeEmotionType)) {
    return value as LifeEmotionType
  }
  return 'wonder'
}

function ensureNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return fallback
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

// ─── 内部：episode id 生成（与 generator.ts 兼容；冲突由 store 层 throw） ──

const SLUG_MAX_LEN = 24

function formatGrowthEpisodeId(seq: number, title: string): string {
  const seqStr = seq.toString().padStart(4, '0')
  const slug = title
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/[/.\\]/g, '')
    .slice(0, SLUG_MAX_LEN)
  const safe = slug.length > 0 ? slug : `growth${seq}`
  return `ep-${seqStr}-${safe}`
}

/**
 * 从已有 timeline 中算出下一个 episode 序号。grower 不维护全局序号计数器，
 * 每次推进都现算（小数据量，O(N) 即可）。
 */
function computeNextEpisodeSeq(timeline: LifeTimelineEntry[]): number {
  let maxSeq = 0
  const seqRegex = /^ep-(\d+)-/
  for (const entry of timeline) {
    const m = entry.id.match(seqRegex)
    if (m) {
      const seq = parseInt(m[1], 10)
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
    }
  }
  return maxSeq + 1
}

// ─── 内部：跳过结果工厂 ──────────────────────────────────────────────────

function makeSkippedResult(
  reason: AdvanceLifeResult['skipReason'],
  avatarDeltaMonths: number,
): AdvanceLifeResult {
  return {
    advanced: false,
    skipReason: reason,
    avatarDeltaMonths,
    newEpisodes: 0,
    failedEpisodes: 0,
    reconsolidated: false,
  }
}
