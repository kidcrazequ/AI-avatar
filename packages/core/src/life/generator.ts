/**
 * 「人生经历」初始化生成器（4 Stage Pipeline）。
 *
 * 流程总览：
 *   Stage 0 manifest    → 1 次大 LLM 调用，写 manifest.json
 *   Stage 1 outline     → 6 次中 LLM 调用，逐年龄段列事件大纲，写 timeline.json
 *   Stage 2 episodes    → 60-100 次中 LLM 调用，并发 5 写 episodes/<id>.md
 *   Stage 3 forgetting  → 算法层标注 consolidationStatus + LLM 复盘写 consolidated.md
 *
 * 关键能力：
 *   - 断点续传：每完成一个 episode / Stage 写 progress.json，重启时跳过已完成
 *   - 取消：abortSignal 透传到所有 LLM 调用（Promise.race 包装）
 *   - fallback：creationModel 缺失自动用 chatModel，progress.usedFallback=true
 *   - 进度推送：onProgress 回调（main.ts handler 内转 webContents.send）
 *   - 持续生长（Phase 2 grower 复用）：导出 generateEpisode 单事件函数
 *
 * 设计约束：
 *   - 不依赖 Electron / fs 之外的桌面端模块（纯 @soul/core 内部）
 *   - 路径全部走 store.ts 暴露的函数，零重复实现
 *   - LLM 调用全部经 callCreation/callChat 这两个内部 helper（避免散落）
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'fs'
import path from 'path'

import type { LLMCallFn } from '../document-formatter'
import { localDateString } from '../utils/common'
import { assertSafeSegment, resolveUnderRoot } from '../utils/path-security'
import {
  applyAlgorithmicForgetting,
  generateConsolidated as generateConsolidatedInner,
} from './forgetter'
import {
  buildEpisodePrompt,
  buildManifestPrompt,
  buildOutlinePrompt,
  EPISODE_SYSTEM_PROMPT,
  MANIFEST_SYSTEM_PROMPT,
  OUTLINE_SYSTEM_PROMPT,
} from './prompts'
import {
  appendLifeTimelineEntry,
  ensureLifeDir,
  listLifeEpisodeIds,
  readLifeManifest,
  readLifeProgress,
  readLifeTimeline,
  writeLifeConsolidated,
  writeLifeEpisode,
  writeLifeManifest,
  writeLifeProgress,
  writeLifeTimeline,
} from './store'
import type {
  LifeArcItem,
  LifeEmotionType,
  LifeEpisode,
  LifeEventCategory,
  LifeFailedEpisode,
  LifeManifest,
  LifePersonaNameSource,
  LifePipelineStage,
  LifeProgress,
  LifeRelationship,
  LifeTimelineEntry,
} from './types'

// ─── 公共类型 ───────────────────────────────────────────────────────────────

/**
 * LLM 配置注入。Phase 1 generator 接收 creation + chat 两套配置，
 * 内部根据 creationConfigured 决定走哪套，并把 fallback 标记写入 progress。
 */
export interface LifeLLMConfig {
  /** 创作模型调用函数（cration_model；缺失时也要构造一个 dummy 不会被用） */
  creationLLM: LLMCallFn
  /** 对话模型调用函数（chat_model，必须存在） */
  chatLLM: LLMCallFn
  /** 用户是否在设置里配了 creation_api_key（决定是否走 fallback） */
  creationConfigured: boolean
}

/** 用户在创建向导第 5 步确认的人生骨架参数 */
export interface LifeUserParams {
  /** 18-80 岁 */
  currentAge: number
  /** 1.0 / 12.0 / 52.0 / 0 */
  timeScale: number
  /** 是否启用持续生长（Phase 2 cron 用） */
  growthEnabled: boolean
  /** 用户在向导填的额外要求（可空） */
  extraHints: string
  /** 用户确认的人生经历使用名；未提供时使用 avatarName */
  personaName?: string
  /** personaName 是否已经过用户确认 */
  personaNameConfirmed?: boolean
  /** personaName 来源，默认由 personaNameConfirmed 推导 */
  nameSource?: LifePersonaNameSource
}

/** generateLife 全 Pipeline 入参 */
export interface GenerateLifeOptions {
  /** avatars 根目录（Electron 主进程的 avatarsPath） */
  avatarsRoot: string
  /** 分身 ID（main.ts 已 assertSafeSegment，这里再防御一次） */
  avatarId: string
  /** avatar 显示名（用于 prompt） */
  avatarName: string
  /** 用户输入的人生参数 */
  userParams: LifeUserParams
  /** LLM 配置 */
  llms: LifeLLMConfig
  /** 进度回调；main.ts 转成 webContents.send('life:progress', ...) */
  onProgress?: (progress: LifeProgress) => void
  /** 取消信号（main.ts 内部 AbortController） */
  abortSignal?: AbortSignal
  /**
   * 时间获取函数，便于测试（单测 mock 出固定时间）。
   * 默认 `() => new Date()`。
   */
  now?: () => Date
}

// ─── 公共导出 helper（供 main.ts 构造 manifest 入参，以及测试断言）──────────

/** 默认每段生成的事件数（plan 2.1 Stage 1 的 8-15 中位） */
export const DEFAULT_OUTLINE_TARGET_COUNTS = [10, 10, 12, 14, 12, 10] as const

/**
 * 把 0~currentAge 切成 6 段（plan 2.1 Stage 1）。
 * 段不够长时（如 currentAge < 25）自动按比例缩放。
 * 导出供测试和 Phase 2 grower 复用「年龄分桶」。
 */
export function partitionAgeStages(currentAge: number): Array<{ from: number; to: number }> {
  const defaultRanges = [
    { from: 0, to: 3 },
    { from: 3, to: 7 },
    { from: 7, to: 12 },
    { from: 12, to: 18 },
    { from: 18, to: 25 },
    { from: 25, to: 25 }, // 占位，下面 clamp
  ]
  defaultRanges[5].to = Math.max(currentAge, 25)
  // 当 currentAge < 25 时收缩到 currentAge
  return defaultRanges
    .map((range) => ({
      from: Math.min(range.from, currentAge),
      to: Math.min(range.to, currentAge),
    }))
    .filter((range) => range.to > range.from || (range.from === currentAge && range.to === currentAge))
}

// ─── 主流程：generateLife ───────────────────────────────────────────────────

/**
 * 4 Stage 全流程入口。
 *
 * 幂等支持：
 *   1. 已有 manifest.json + progress.stage='complete'：无需重跑，直接返回
 *   2. progress.stage='episodes'：跳过 Stage 0/1，从未完成的 episode 开始续生成
 *   3. progress.stage='forgetting'：跳过 Stage 0/1/2，重新做 Stage 3
 */
export async function generateLife(opts: GenerateLifeOptions): Promise<void> {
  assertSafeSegment(opts.avatarId, '分身ID')
  // 防御：avatarsRoot 必须是绝对目录
  if (!path.isAbsolute(opts.avatarsRoot)) {
    throw new Error(`generateLife: avatarsRoot 必须是绝对路径: ${opts.avatarsRoot}`)
  }
  await ensureLifeDir(opts.avatarsRoot, opts.avatarId)

  const now = opts.now ?? (() => new Date())
  const usedFallback = !opts.llms.creationConfigured

  // ─ 加载或创建 progress
  let progress = await readLifeProgress(opts.avatarsRoot, opts.avatarId)
  if (progress === null) {
    progress = createInitialProgress(now())
    progress.usedFallback = usedFallback
    await writeProgressAndNotify(opts, progress)
  } else {
    // 续跑时保证 fallback 标记反映本次实际配置
    progress.usedFallback = usedFallback
    progress.lastError = ''
    progress.updatedAt = now().toISOString()
    await writeProgressAndNotify(opts, progress)
  }

  if (progress.stage === 'complete') {
    return
  }

  try {
    // ─ Stage 0：manifest
    // 注：之前条件含 `progress.stage === 'failed'` 会导致重试时**无脑重写 manifest**，
    // 让已生成的 episodes 和新 manifest 人生骨架严重不一致。已移除该项；
    // 失败重试时按"哪一步失败就从哪一步续跑"的语义走。
    let manifest = await readLifeManifest(opts.avatarsRoot, opts.avatarId)
    if (manifest === null || progress.stage === 'manifest') {
      progress = await advanceStage(opts, progress, 'manifest', now)
      manifest = await runStage0Manifest(opts, now)
      await writeLifeManifest(opts.avatarsRoot, opts.avatarId, manifest)
    } else {
      manifest = ensureManifestIdentity(manifest, opts.avatarName)
      if (manifest.generationStatus !== 'generating') {
        manifest = { ...manifest, generationStatus: 'generating' }
      }
      await writeLifeManifest(opts.avatarsRoot, opts.avatarId, manifest)
    }

    // ─ Stage 1：outline
    let timeline = await readLifeTimeline(opts.avatarsRoot, opts.avatarId)
    if (timeline.length === 0 || progress.stage === 'manifest' || progress.stage === 'outline') {
      progress = await advanceStage(opts, progress, 'outline', now)
      timeline = await runStage1Outline(opts, manifest)
      await writeLifeTimeline(opts.avatarsRoot, opts.avatarId, timeline)
      progress.totalEpisodes = timeline.length
      await writeProgressAndNotify(opts, progress)
    }

    // ─ Stage 2：episodes（断点续传）
    progress = await advanceStage(opts, progress, 'episodes', now)
    progress.totalEpisodes = timeline.length
    await writeProgressAndNotify(opts, progress)
    await runStage2Episodes(opts, manifest, timeline, progress, now)

    // ─ Stage 3：forgetting
    progress = await advanceStage(opts, progress, 'forgetting', now)
    const consolidatedManifest = await runStage3Forgetting(opts, manifest, timeline, now)
    await writeLifeManifest(opts.avatarsRoot, opts.avatarId, consolidatedManifest)

    // ─ 收尾
    progress = await advanceStage(opts, progress, 'complete', now)
    progress.lastError = ''
    await writeProgressAndNotify(opts, progress)
  } catch (err) {
    if (isAbortError(err)) throw err
    progress.stage = 'failed'
    progress.lastError = err instanceof Error ? err.message : String(err)
    progress.updatedAt = now().toISOString()
    await writeProgressAndNotify(opts, progress)

    // 关键：同步把 manifest.generationStatus 设为 'failed'，否则 UI 派生的 mode
    // 仍是 'generating'（看 manifest 而非 progress），用户会卡在错乱进度条上。
    try {
      const failedManifest = await readLifeManifest(opts.avatarsRoot, opts.avatarId)
      if (failedManifest && failedManifest.generationStatus !== 'failed') {
        failedManifest.generationStatus = 'failed'
        await writeLifeManifest(opts.avatarsRoot, opts.avatarId, failedManifest)
      }
    } catch (writeErr) {
      // 不要让 manifest 回写失败掩盖原始错误；仅吞掉，原 err 继续向上抛
      void writeErr
    }

    throw err
  }
}

// ─── Stage 0：manifest ─────────────────────────────────────────────────────

async function runStage0Manifest(
  opts: GenerateLifeOptions,
  now: () => Date,
): Promise<LifeManifest> {
  throwIfAborted(opts.abortSignal)

  const avatarBrief = await readAvatarBrief(opts.avatarsRoot, opts.avatarId)
  const soulExcerpt = await readSoulExcerpt(opts.avatarsRoot, opts.avatarId, 1500)
  const todayStr = localDateString(now())
  const currentYear = now().getFullYear()
  const nameDecision = resolvePersonaName(opts.userParams, opts.avatarName)

  const userPrompt = buildManifestPrompt({
    avatarName: opts.avatarName,
    personaName: nameDecision.personaName,
    personaNameConfirmed: nameDecision.confirmed,
    avatarBrief,
    soulExcerpt,
    currentAge: opts.userParams.currentAge,
    currentYear,
    initialAgeBornAt: now().toISOString(),
    userHint: opts.userParams.extraHints,
    timeScale: opts.userParams.timeScale,
  })

  const raw = await callLLMWithAbort(
    opts.llms.creationConfigured ? opts.llms.creationLLM : opts.llms.chatLLM,
    MANIFEST_SYSTEM_PROMPT,
    userPrompt,
    8000,
    opts.abortSignal,
  )
  const parsed = parseJsonRobust<ManifestSkeletonShape>(raw, 'Stage 0 manifest')

  const manifest: LifeManifest = {
    schemaVersion: 1,
    displayName: opts.avatarName,
    personaName: nameDecision.personaName,
    realNameConfirmed: nameDecision.confirmed,
    nameSource: nameDecision.source,
    birthYear: clampInt(parsed.birthYear, 1900, currentYear, currentYear - opts.userParams.currentAge),
    birthMonth: clampInt(parsed.birthMonth, 1, 12, 1),
    birthDay: clampInt(parsed.birthDay, 1, 28, 15),
    initialAge: opts.userParams.currentAge,
    initialAgeBornAt: now().toISOString(),
    timeScale: opts.userParams.timeScale,
    lastAdvancedAt: now().toISOString(),
    currentAgeMonths: opts.userParams.currentAge * 12,
    growthEnabled: opts.userParams.growthEnabled,
    gender: ensureNonEmptyString(parsed.gender, '其他'),
    birthplace: ensureNonEmptyString(parsed.birthplace, '中国'),
    familyBackground: ensureNonEmptyString(parsed.familyBackground, ''),
    personalityArc: normalizeArcItems(parsed.personalityArc, 'shift'),
    professionalSpine: normalizeArcItems(parsed.professionalSpine, 'milestone'),
    majorRelationships: normalizeRelationships(parsed.majorRelationships),
    createdAt: todayStr,
    totalEpisodes: 0,
    totalChars: 0,
    generationStatus: 'generating',
    lastConsolidatedAt: now().toISOString(),
    consolidationCounter: 0,
  }
  validateGeneratedManifestSkeleton(manifest)
  return manifest
}

// ─── Stage 1：outline ──────────────────────────────────────────────────────

async function runStage1Outline(
  opts: GenerateLifeOptions,
  manifest: LifeManifest,
): Promise<LifeTimelineEntry[]> {
  const stages = partitionAgeStages(opts.userParams.currentAge)
  const targetCounts = DEFAULT_OUTLINE_TARGET_COUNTS

  const timeline: LifeTimelineEntry[] = []
  let episodeSeq = 0

  for (let i = 0; i < stages.length; i++) {
    throwIfAborted(opts.abortSignal)
    const stage = stages[i]
    const target = targetCounts[i] ?? 10

    const previousTitles = timeline.slice(-12).map(e => e.title)
    const userPrompt = buildOutlinePrompt({
      manifest,
      ageFrom: stage.from,
      ageTo: stage.to,
      targetCount: target,
      previousTitles,
    })

    const raw = await callLLMWithAbort(
      opts.llms.creationConfigured ? opts.llms.creationLLM : opts.llms.chatLLM,
      OUTLINE_SYSTEM_PROMPT,
      userPrompt,
      6000,
      opts.abortSignal,
    )
    const items = parseJsonRobust<OutlineItemShape[]>(raw, `Stage 1 outline ${stage.from}-${stage.to}`)
    if (!Array.isArray(items)) {
      throw new Error(`Stage 1: ${stage.from}-${stage.to} 段输出非数组`)
    }

    for (const item of items) {
      const age = clampInt(item.age, stage.from, stage.to, stage.from)
      const titleForId = typeof item.title === 'string' ? item.title : `event-${episodeSeq}`
      const id = formatEpisodeId(++episodeSeq, titleForId)
      timeline.push({
        id,
        age,
        year: manifest.birthYear + age,
        month: clampInt(item.month, 1, 12, 1),
        title: ensureNonEmptyString(item.title, '未命名事件').slice(0, 40),
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
      })
    }
  }
  return timeline
}

// ─── Stage 2：episodes（并发 5 + 断点续传） ──────────────────────────────────

const STAGE2_CONCURRENCY = 5

async function runStage2Episodes(
  opts: GenerateLifeOptions,
  manifest: LifeManifest,
  timeline: LifeTimelineEntry[],
  progress: LifeProgress,
  now: () => Date,
): Promise<void> {
  const existingIds = new Set(await listLifeEpisodeIds(opts.avatarsRoot, opts.avatarId))
  const failedIds = new Set(progress.failedEpisodes.map(f => f.id))

  const pending = timeline.filter(entry => !existingIds.has(entry.id) && !failedIds.has(entry.id))
  progress.completedEpisodes = existingIds.size

  // 并发池设计要点：
  //   1. abort 时不能产生 unhandledRejection（多个 in-flight 同时 reject）
  //   2. 业务失败（episode LLM 抛错）只记到 failedEpisodes 不阻塞其他
  //   3. abort 由顶层捕获，并发池本身只负责"安全地等待 in-flight 收尾"
  //
  // 实现：每个 episode 任务自己 catch → 写 progress；唯独 abort error 通过
  // 共享的 aborted 标志位向上传，等所有 in-flight 都 settle 后再 throw。
  let aborted = false
  let cursor = 0
  const inFlight = new Set<Promise<void>>()

  const runOne = async (entry: LifeTimelineEntry): Promise<void> => {
    try {
      const wordCount = await generateAndPersistEpisode(opts, manifest, timeline, entry)
      const idx = timeline.findIndex(e => e.id === entry.id)
      if (idx >= 0) {
        timeline[idx] = { ...timeline[idx], wordCount }
      }
      progress.completedEpisodes += 1
      progress.updatedAt = now().toISOString()
      await writeProgressAndNotify(opts, progress)
    } catch (err) {
      if (isAbortError(err)) {
        aborted = true
        return
      }
      const failedEntry: LifeFailedEpisode = {
        id: entry.id,
        error: err instanceof Error ? err.message : String(err),
        failedAt: now().toISOString(),
      }
      progress.failedEpisodes.push(failedEntry)
      progress.updatedAt = now().toISOString()
      try {
        await writeProgressAndNotify(opts, progress)
      } catch {
        // progress 写盘失败不致命，已在 stderr 警告
      }
    }
  }

  const launchNext = (): boolean => {
    if (aborted || opts.abortSignal?.aborted) {
      aborted = true
      return false
    }
    if (cursor >= pending.length) return false
    const entry = pending[cursor++]
    const task = runOne(entry).finally(() => {
      inFlight.delete(task)
    })
    inFlight.add(task)
    return true
  }

  // 初始填满池
  for (let i = 0; i < STAGE2_CONCURRENCY; i++) {
    if (!launchNext()) break
  }

  // 滚动：每完成一个就再起一个；abort 时停止入队，等剩余 in-flight 收尾
  while (inFlight.size > 0) {
    await Promise.race(inFlight)
    launchNext()
  }

  // 把内存中的 wordCount 持久化回 timeline.json
  await writeLifeTimeline(opts.avatarsRoot, opts.avatarId, timeline)

  if (aborted) {
    throw makeAbortError()
  }
}

/**
 * 单事件生成 + 落盘 + 计算字数。
 *
 * 导出此函数：Phase 2 grower 持续生长时直接复用单事件生成（不需要全 Pipeline）。
 *
 * @returns 生成正文的字数
 */
export interface GenerateEpisodeOptions {
  avatarsRoot: string
  avatarId: string
  manifest: LifeManifest
  /** 全部 timeline，用于查找 prev/next（grower 增量生成时也要传完整 timeline） */
  timeline: LifeTimelineEntry[]
  /** 当前要生成的条目（必须已在 timeline 内） */
  entry: LifeTimelineEntry
  /** LLM 调用 */
  callLLM: LLMCallFn
  /** 字数目标（默认 3000） */
  wordTarget?: number
  abortSignal?: AbortSignal
}

export async function generateEpisode(opts: GenerateEpisodeOptions): Promise<LifeEpisode> {
  const wordTarget = opts.wordTarget ?? 3000
  const sortedTimeline = [...opts.timeline].sort((a, b) => a.age - b.age || a.month - b.month)
  const idx = sortedTimeline.findIndex(e => e.id === opts.entry.id)
  const prev = idx > 0 ? sortedTimeline[idx - 1] : null
  const next = idx >= 0 && idx < sortedTimeline.length - 1 ? sortedTimeline[idx + 1] : null

  const userPrompt = buildEpisodePrompt({
    manifest: opts.manifest,
    entry: opts.entry,
    prevTitle: prev ? prev.title : null,
    prevAge: prev ? prev.age : null,
    nextTitle: next ? next.title : null,
    nextAge: next ? next.age : null,
    wordTarget,
  })

  const raw = await callLLMWithAbort(
    opts.callLLM,
    EPISODE_SYSTEM_PROMPT,
    userPrompt,
    Math.ceil(wordTarget * 1.6) + 200, // 中文 1 token ≈ 0.6 字
    opts.abortSignal,
  )
  const content = raw.trim()
  if (content.length === 0) {
    throw new Error(`episode ${opts.entry.id} LLM 返回空文本`)
  }
  return { id: opts.entry.id, content }
}

async function generateAndPersistEpisode(
  opts: GenerateLifeOptions,
  manifest: LifeManifest,
  timeline: LifeTimelineEntry[],
  entry: LifeTimelineEntry,
): Promise<number> {
  const callLLM = opts.llms.creationConfigured ? opts.llms.creationLLM : opts.llms.chatLLM
  const episode = await generateEpisode({
    avatarsRoot: opts.avatarsRoot,
    avatarId: opts.avatarId,
    manifest,
    timeline,
    entry,
    callLLM,
    wordTarget: 3000,
    abortSignal: opts.abortSignal,
  })
  await writeLifeEpisode(opts.avatarsRoot, opts.avatarId, episode)
  return episode.content.length
}

// ─── Stage 3：双重遗忘 ──────────────────────────────────────────────────────

async function runStage3Forgetting(
  opts: GenerateLifeOptions,
  manifest: LifeManifest,
  timeline: LifeTimelineEntry[],
  now: () => Date,
): Promise<LifeManifest> {
  throwIfAborted(opts.abortSignal)
  // 3a 算法层
  const flagged = applyAlgorithmicForgetting(timeline, opts.userParams.currentAge)
  await writeLifeTimeline(opts.avatarsRoot, opts.avatarId, flagged)

  // 3b AI 复盘
  const callLLM = opts.llms.creationConfigured ? opts.llms.creationLLM : opts.llms.chatLLM
  const consolidated = await generateConsolidatedInner({
    manifest,
    timeline: flagged,
    callLLM: (s, u, m) => callLLMWithAbort(callLLM, s, u, m ?? 8000, opts.abortSignal),
    wordTarget: 4000,
  })
  await writeLifeConsolidated(opts.avatarsRoot, opts.avatarId, consolidated)

  // 更新 manifest 元数据
  const totalChars = flagged.reduce((sum, e) => sum + e.wordCount, 0)
  return {
    ...manifest,
    totalEpisodes: flagged.length,
    totalChars,
    generationStatus: 'complete',
    lastConsolidatedAt: now().toISOString(),
    consolidationCounter: manifest.consolidationCounter + 1,
  }
}

// ─── 工具：进度 / 取消 / LLM 调用兜底 ──────────────────────────────────────

function createInitialProgress(now: Date): LifeProgress {
  return {
    stage: 'idle',
    completedEpisodes: 0,
    totalEpisodes: 0,
    usedFallback: false,
    lastError: '',
    updatedAt: now.toISOString(),
    failedEpisodes: [],
    consolidationLastTotalEpisodes: 0,
  }
}

async function advanceStage(
  opts: GenerateLifeOptions,
  progress: LifeProgress,
  next: LifePipelineStage,
  now: () => Date,
): Promise<LifeProgress> {
  progress.stage = next
  progress.updatedAt = now().toISOString()
  await writeProgressAndNotify(opts, progress)
  return progress
}

async function writeProgressAndNotify(
  opts: GenerateLifeOptions,
  progress: LifeProgress,
): Promise<void> {
  await writeLifeProgress(opts.avatarsRoot, opts.avatarId, progress)
  if (opts.onProgress) {
    // 防御：onProgress 抛错不应该影响主流程
    try {
      opts.onProgress({ ...progress, failedEpisodes: [...progress.failedEpisodes] })
    } catch (notifyErr) {
      // 只记录到 stderr，不抛
      // eslint-disable-next-line no-console -- core 模块无 logger，依赖调用方
      console.warn(`[life-generator] onProgress 回调异常: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`)
    }
  }
}

/**
 * 把 LLM 调用与 abortSignal 串起来：abortSignal 触发时立即拒绝。
 * createLLMFn 当前不支持 signal，所以用 Promise.race 兜底（即使底层
 * fetch 仍在跑，上层也能立即返回；底层的 fetch 由 fetchJsonWithTimeout
 * 自身的 5 分钟超时兜底，不会泄漏）。
 */
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
  if (abortSignal.aborted) {
    throw makeAbortError()
  }
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
  const err = new Error('生成已取消')
  err.name = 'AbortError'
  return err
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// ─── 工具：JSON 解析 / 字段规整 ────────────────────────────────────────────

interface ManifestSkeletonShape {
  personaName?: unknown
  birthYear?: unknown
  birthMonth?: unknown
  birthDay?: unknown
  gender?: unknown
  birthplace?: unknown
  familyBackground?: unknown
  personalityArc?: unknown
  professionalSpine?: unknown
  majorRelationships?: unknown
}

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

/**
 * 健壮 JSON 解析：去除 markdown 代码块包装，截取首个 `{` 或 `[` 起始的片段。
 * LLM 输出偶发 "好的，以下是 JSON： ```json\n...\n``` " 这种格式。
 */
function parseJsonRobust<T>(raw: string, source: string): T {
  const text = raw.trim()
  // 优先去掉代码块
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  const candidate = fenced ? fenced[1] : text

  // 再次截取 { / [ 起始
  const objStart = candidate.indexOf('{')
  const arrStart = candidate.indexOf('[')
  let start = -1
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) start = objStart
  else if (arrStart >= 0) start = arrStart
  if (start < 0) {
    throw new Error(`${source}: LLM 输出找不到 JSON 起始字符\n原文: ${text.slice(0, 200)}`)
  }
  // 截取到最后一个 } 或 ]
  const objEnd = candidate.lastIndexOf('}')
  const arrEnd = candidate.lastIndexOf(']')
  const end = Math.max(objEnd, arrEnd)
  const json = candidate.slice(start, end + 1)
  try {
    return JSON.parse(json) as T
  } catch (err) {
    throw new Error(
      `${source}: JSON 解析失败 ${err instanceof Error ? err.message : String(err)}\n原文片段: ${json.slice(0, 200)}`,
      { cause: err },
    )
  }
}

function ensureNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return fallback
}

function resolvePersonaName(
  params: LifeUserParams,
  avatarName: string,
): { personaName: string; confirmed: boolean; source: LifePersonaNameSource } {
  const confirmedName = typeof params.personaName === 'string'
    ? params.personaName.trim()
    : ''
  const displayName = avatarName.trim() || '未命名分身'
  const confirmed = params.personaNameConfirmed === true && confirmedName.length > 0
  if (!confirmed) {
    return { personaName: displayName, confirmed: false, source: 'avatarName' }
  }
  return {
    personaName: confirmedName,
    confirmed: true,
    source: params.nameSource ?? 'user',
  }
}

function ensureManifestIdentity(manifest: LifeManifest, avatarName: string): LifeManifest {
  return {
    ...manifest,
    displayName: manifest.displayName ?? avatarName,
    realNameConfirmed: manifest.realNameConfirmed ?? false,
    nameSource: manifest.nameSource ?? 'avatarName',
  }
}

function validateGeneratedManifestSkeleton(manifest: LifeManifest): void {
  const problems: string[] = []
  if (manifest.familyBackground.trim().length === 0) {
    problems.push('familyBackground 为空')
  }
  if (manifest.personalityArc.length < 4) {
    problems.push(`personalityArc 需要至少 4 项，实际 ${manifest.personalityArc.length} 项`)
  }
  if (manifest.professionalSpine.length < 3) {
    problems.push(`professionalSpine 需要至少 3 项，实际 ${manifest.professionalSpine.length} 项`)
  }
  if (manifest.majorRelationships.length < 3) {
    problems.push(`majorRelationships 需要至少 3 项，实际 ${manifest.majorRelationships.length} 项`)
  }
  if (problems.length > 0) {
    throw new Error(`Stage 0 manifest: 人生骨架生成失败，${problems.join('；')}。请重试或补充更明确的 soul.md/额外要求。`)
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
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

function normalizeArcItems(value: unknown, key: 'shift' | 'milestone'): LifeArcItem[] {
  if (!Array.isArray(value)) return []
  const items: LifeArcItem[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const age = typeof obj.age === 'number' ? obj.age : Number(obj.age)
    if (!Number.isFinite(age)) continue
    const text = obj[key] ?? obj.shift ?? obj.milestone ?? ''
    const normalizedText = String(text).trim().slice(0, 80)
    if (normalizedText.length === 0) continue
    const item: LifeArcItem = { age: Math.round(age) }
    item[key] = normalizedText
    items.push(item)
  }
  return items
}

function normalizeRelationships(value: unknown): LifeRelationship[] {
  if (!Array.isArray(value)) return []
  const result: LifeRelationship[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    result.push({
      role: ensureNonEmptyString(obj.role, '至亲').slice(0, 20),
      name: ensureNonEmptyString(obj.name, '佚名').slice(0, 12),
      description: ensureNonEmptyString(obj.description, '').slice(0, 200),
    })
  }
  return result
}

// ─── 工具：episode id 生成 + 文件读取 ──────────────────────────────────────

const SLUG_MAX_LEN = 24

/**
 * 生成 episode id：`ep-<4 位序号>-<slug>`。
 * slug 用 title 转 ASCII 安全字符；中文标题保留汉字，但去掉空格和符号。
 *
 * 与 Phase 0 store.ts 的 assertSafeEpisodeId 兼容（不含 / .. 空字符等）。
 */
function formatEpisodeId(seq: number, title: string): string {
  const seqStr = seq.toString().padStart(4, '0')
  const slug = title
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/[/.\\]/g, '')
    .slice(0, SLUG_MAX_LEN)
  const safe = slug.length > 0 ? slug : `event${seq}`
  return `ep-${seqStr}-${safe}`
}

async function readAvatarBrief(avatarsRoot: string, avatarId: string): Promise<string> {
  const p = resolveUnderRoot(avatarsRoot, path.join(avatarId, 'avatar.txt'))
  try {
    return sanitizeAvatarBrief(await fs.promises.readFile(p, 'utf-8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return ''
    throw err
  }
}

function sanitizeAvatarBrief(raw: string): string {
  const trimmed = raw.trim()
  // `default:*` 是桌面端默认头像标识，不是角色简介，不能进入人生生成 prompt。
  if (/^default:[A-Za-z0-9_-]+$/.test(trimmed)) return ''
  return trimmed
}

async function readSoulExcerpt(avatarsRoot: string, avatarId: string, maxChars: number): Promise<string> {
  const p = resolveUnderRoot(avatarsRoot, path.join(avatarId, 'soul.md'))
  try {
    const raw = await fs.promises.readFile(p, 'utf-8')
    return raw.length <= maxChars ? raw : raw.slice(0, maxChars)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return ''
    throw err
  }
}

// ─── Phase 2 grower 复用：单事件追加 ───────────────────────────────────────

/**
 * 给定单条新 timeline entry，生成 episode 正文 + 写盘 + 把条目追加到 timeline.json。
 * 适合 Phase 2 grower 推进时增量调用，单次只生成一个 episode。
 *
 * 与 generateLife 的 Stage 2 区别：
 *   - 不维护并发池（grower 一次只追加 1-3 个事件）
 *   - 不写 progress.json（grower 自己管理）
 *   - 必须事先在 timeline.json 里追加 entry（否则 readLifeTimeline 找不到）
 *
 * Phase 2 grower 的典型用法：
 *   1. grower.computeNewEntries() 算出 N 条新条目
 *   2. for (entry of newEntries) {
 *        await appendLifeTimelineEntry(...)
 *        await appendNewEpisodeForGrowth({ ..., entry })
 *      }
 *
 * 此函数不做"取消"，因为 grower 每次只生成少量 episode，调用方可控制。
 */
export interface AppendNewEpisodeForGrowthOptions {
  avatarsRoot: string
  avatarId: string
  manifest: LifeManifest
  /** 新条目（必须已经过 appendLifeTimelineEntry） */
  entry: LifeTimelineEntry
  /** LLM 调用 */
  callLLM: LLMCallFn
  abortSignal?: AbortSignal
}

export async function appendNewEpisodeForGrowth(
  opts: AppendNewEpisodeForGrowthOptions,
): Promise<LifeEpisode> {
  const timeline = await readLifeTimeline(opts.avatarsRoot, opts.avatarId)
  const episode = await generateEpisode({
    avatarsRoot: opts.avatarsRoot,
    avatarId: opts.avatarId,
    manifest: opts.manifest,
    timeline,
    entry: opts.entry,
    callLLM: opts.callLLM,
    abortSignal: opts.abortSignal,
  })
  await writeLifeEpisode(opts.avatarsRoot, opts.avatarId, episode)
  return episode
}

// ─── 重新导出 forgetter 关键函数（Phase 2 grower 复用） ────────────────────

export { applyAlgorithmicForgetting, generateConsolidated } from './forgetter'
export type { ForgettingWeights } from './forgetter'
export { DEFAULT_FORGETTING_WEIGHTS, CONSOLIDATED_MAX_CHARS } from './forgetter'
