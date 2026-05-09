/**
 * AI 分身「人生经历」功能的核心类型定义。
 *
 * 对应 plan 1.1 / 1.2 节的 manifest.json / timeline.json schema。
 * 所有字段顺序与 plan 文档一致，便于人工 diff 检查。
 *
 * 注意：渲染端 `desktop-app/src/global.d.ts` 中有平行的 `LifeManifest` /
 * `LifeTimelineEntry` / `LifeProgress` 接口声明，修改本文件时必须同步更新
 * 那两份声明（与既有 Avatar / Skill 同模式）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

// ─── 联合类型常量 ─────────────────────────────────────────────────────────────

/** 事件分类：塑造性 / 日常 / 创伤 / 喜悦 / 专业 / 失去 */
export type LifeEventCategory =
  | 'formative'
  | 'daily'
  | 'trauma'
  | 'joy'
  | 'professional'
  | 'loss'

/** 情感主色调 */
export type LifeEmotionType =
  | 'joy'
  | 'sorrow'
  | 'anger'
  | 'fear'
  | 'wonder'
  | 'shame'
  | 'love'

/** 单个事件经过遗忘机制筛选后的状态 */
export type LifeConsolidationStatus = 'remembered' | 'blurred' | 'forgotten'

/**
 * 人生整体生成状态。
 * - pending: 已规划，尚未开始
 * - generating: Stage 0-3 进行中
 * - complete: 初始化生成完成
 * - failed: 初始化失败（progress.lastError 有值）
 * - growing: cron 持续生长中（已完成初始化，Stage 4 在跑）
 */
export type LifeGenerationStatus =
  | 'pending'
  | 'generating'
  | 'complete'
  | 'failed'
  | 'growing'

/**
 * 当前生成器所处的 Pipeline 阶段。
 * - idle: 未开始
 * - manifest: Stage 0（生成 manifest）
 * - outline: Stage 1（阶段大纲）
 * - episodes: Stage 2（逐事件传记）
 * - forgetting: Stage 3（双重遗忘筛选）
 * - growing: Stage 4（持续生长 cron）
 * - complete: 全部完成
 * - failed: 失败，详见 lastError
 */
export type LifePipelineStage =
  | 'idle'
  | 'manifest'
  | 'outline'
  | 'episodes'
  | 'forgetting'
  | 'growing'
  | 'complete'
  | 'failed'

// ─── 数据结构 ─────────────────────────────────────────────────────────────────

/**
 * personalityArc / professionalSpine 的子项。
 * 共用结构：年龄 + 文字描述。字段名按 plan 1.1 区分（shift / milestone）。
 */
export interface LifeArcItem {
  age: number
  shift?: string
  milestone?: string
}

/** 关键关系人 */
export interface LifeRelationship {
  /** 关系角色（祖辈/父母/导师/挚友/对手等） */
  role: string
  /** 关系人姓名或称谓（AI 想象） */
  name: string
  /** 1-3 句关键画像 */
  description: string
}

/**
 * 人生骨架文件 `life/manifest.json` 的完整 schema。
 * 与 plan 1.1 节字段一一对应。
 */
export interface LifeManifest {
  /** schema 版本，破坏性升级时递增 */
  schemaVersion: number
  /** 角色名（AI 想象，可与 avatar 名不同） */
  personaName: string

  // ─── 出生与年龄 ───
  birthYear: number
  birthMonth: number
  birthDay: number
  /** 创建分身时用户指定的当前年龄 */
  initialAge: number
  /** 创建分身的真实时间锚点（ISO 字符串） */
  initialAgeBornAt: string

  // ─── 真实时间生长（v1 完整实现） ───
  /** 1.0=真实 1 月→分身 1 月；12.0=真实 1 月→分身 1 年；52.0=真实 1 周→分身 1 年；0=冻结 */
  timeScale: number
  /** 上次 cron 推进的真实时间（ISO） */
  lastAdvancedAt: string
  /** 分身当前年龄（精确到月，方便 cron 计算） */
  currentAgeMonths: number
  /** 是否启用持续生长（用户可关） */
  growthEnabled: boolean

  // ─── 时代与背景 ───
  gender: string
  birthplace: string
  /** 200-500 字家庭/时代背景 */
  familyBackground: string

  // ─── 人格主线 ───
  /** 性格演化主线（4-6 个关键转折） */
  personalityArc: LifeArcItem[]
  /** 专业骨架（如何走到当前专业） */
  professionalSpine: LifeArcItem[]
  /** 重要关系（祖辈/导师/挚友/对手） */
  majorRelationships: LifeRelationship[]

  // ─── 元数据 ───
  /** 用 localDateString() 写入的 YYYY-MM-DD */
  createdAt: string
  totalEpisodes: number
  totalChars: number
  generationStatus: LifeGenerationStatus
  /** 上次重新整理 consolidated.md 的时间（ISO） */
  lastConsolidatedAt: string
  /** 已 reconsolidate 次数（每 +5 个事件触发 1 次） */
  consolidationCounter: number
}

/**
 * 时间轴条目 `life/timeline.json` 的单项 schema。
 * 与 plan 1.2 节字段一一对应。
 */
export interface LifeTimelineEntry {
  /** episode id：`ep-<4 位序号>-<slug>`，对应 episodes/<id>.md 文件名（不含扩展名） */
  id: string
  age: number
  year: number
  month: number
  title: string
  /** ≤ 80 字一句话摘要 */
  summary: string
  category: LifeEventCategory
  themes: string[]
  /** 重要性 0-10 */
  importance: number
  /** 情感强度 0-10 */
  emotion: number
  emotionType: LifeEmotionType
  wordCount: number
  consolidationStatus: LifeConsolidationStatus
  /** AI 复盘理由 */
  consolidationNote: string
}

/**
 * 单个 episode 的轻量内存表示。
 *
 * episode 落盘形态是 `life/episodes/<id>.md` 文件，包含 2-5K 字传记正文。
 * 元信息（title / age / themes 等）以 timeline.json 为权威，故本类型只
 * 携带 id + 正文，避免重复定义并产生不一致风险。
 */
export interface LifeEpisode {
  /** 与 timeline 中的 id 严格一致 */
  id: string
  /** Markdown 正文（不含 frontmatter） */
  content: string
}

/**
 * 单个 episode 在 progress.json 中的失败记录。
 */
export interface LifeFailedEpisode {
  id: string
  /** 失败原因（用户可见，简短） */
  error: string
  /** 失败时间（ISO） */
  failedAt: string
}

/**
 * 生成进度文件 `life/progress.json` 的 schema。
 *
 * 用途：
 * 1. 断点续传：启动 generator 时读取 progress 决定从哪个 stage 继续
 * 2. UI 显示：渲染端通过 IPC 读取展示进度条 / 错误 / fallback 提示
 * 3. cron 调度：grower 据此判断是否跳过本次推进
 */
export interface LifeProgress {
  /** 当前 Pipeline 阶段 */
  stage: LifePipelineStage
  /** 已完成 episodes 数（Stage 2 实时刷新） */
  completedEpisodes: number
  /** 计划生成 episodes 总数（Stage 1 完成后确定） */
  totalEpisodes: number
  /** creationModel 缺失被迫回退到 chatModel 时为 true */
  usedFallback: boolean
  /** 用户可见的最近错误信息，成功时为空字符串 */
  lastError: string
  /** ISO 字符串，每次写入更新 */
  updatedAt: string
  /** 失败的 episode 列表，断点续传时跳过 */
  failedEpisodes: LifeFailedEpisode[]
  /** 上次完成 reconsolidate 时的 totalEpisodes 快照，grower 用来判断阈值 */
  consolidationLastTotalEpisodes: number
}
