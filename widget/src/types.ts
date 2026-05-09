/**
 * Soul Embed widget 类型定义。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

/**
 * 公开配置（widget 启动时从 `/embed/:id/config` 拉取，与 widget-server.handleEmbedConfig 严格对齐）。
 */
export interface EmbedConfig {
  embedId: string
  avatarId: string
  name: string
  greeting: string | null
  rateLimitPerMin: number
}

/** 一条对话消息（仅 user / assistant，不出现 system）。 */
export interface Message {
  /** 客户端唯一 id，用 Date.now() + 自增即可 */
  id: string
  role: 'user' | 'assistant'
  /** 已收到的文本（streaming 期间不断增长） */
  content: string
  /** assistant 流式中标记；用于显示闪烁光标 */
  streaming?: boolean
}

/** widget 顶层状态机状态 */
export type WidgetStatus =
  | 'idle'
  | 'streaming'
  | 'error'
  | 'rate_limited'
  | 'config_failed'

/**
 * 通用 API 错误基类：保留 status，让 UI 层精准分流。
 */
export class ApiError extends Error {
  public readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export class RateLimitError extends ApiError {
  public readonly retryAfterSec: number
  constructor(retryAfterSec: number, message = 'rate_limited') {
    super(429, message)
    this.name = 'RateLimitError'
    this.retryAfterSec = retryAfterSec
  }
}

export class ServerError extends ApiError {
  constructor(status: number, message: string) {
    super(status, message)
    this.name = 'ServerError'
  }
}
