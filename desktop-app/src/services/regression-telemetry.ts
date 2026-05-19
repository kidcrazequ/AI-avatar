/**
 * regression-telemetry.ts — 批量回归遥测事件总线
 *
 * 用途：批量回归运行器在跑题前订阅事件，跑完后停止收集，把 chatStore
 * 内部的工具调用 / todo / 消息事件汇总成一份"本次会话的工作流轨迹"，
 * 用于断言 expectedTools / expectedSkills 是否命中、产生评估报告。
 *
 * 设计原则：
 *   - 默认 disable：未启用时 emit 是 O(0) 早退，对常规聊天 0 性能影响
 *   - 模块级单例：避免在 chatStore 里挂 store 字段、避免 Zustand 重渲染
 *   - 类型安全：每个事件类型独立 interface，可辨识联合
 *   - 浏览器 + Node 通用：仅依赖标准 Set，无 DOM 依赖（可用于服务测试）
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

// ─── 事件类型 ──────────────────────────────────────────────────────────

import type { NormalizedUsage } from './llm-providers/types'

export type TelemetryEventType =
  | 'conversation-started'
  | 'conversation-error'
  | 'tool-call-start'
  | 'tool-call-end'
  | 'tool-loop:soft-warn'
  | 'tool-loop:hard-stop'
  | 'todo-write'
  | 'message-done'
  | 'usage'

interface BaseEvent {
  type: TelemetryEventType
  conversationId: string
  /** 高精度时间戳（ms since epoch） */
  timestamp: number
}

export interface ConversationStartedEvent extends BaseEvent {
  type: 'conversation-started'
  prompt: string
}

export interface ConversationErrorEvent extends BaseEvent {
  type: 'conversation-error'
  error: string
}

export interface ToolCallStartEvent extends BaseEvent {
  type: 'tool-call-start'
  /** OpenAI tool_call_id（去重用） */
  toolCallId: string
  /** 工具名（如 query_excel / load_skill / todo_write） */
  name: string
  /** 工具入参（已 JSON.parse） */
  args: Record<string, unknown>
}

export interface ToolCallEndEvent extends BaseEvent {
  type: 'tool-call-end'
  toolCallId: string
  name: string
  /** 调用耗时 ms */
  durationMs: number
  /** 是否成功（结果不以"工具执行失败/已跳过"开头） */
  ok: boolean
  /** 失败时错误摘要（最多 200 字） */
  errorMsg?: string
}

export interface ToolLoopSoftWarnEvent extends BaseEvent {
  type: 'tool-loop:soft-warn'
  /** 已触达软警告的工具轮次 */
  round: number
}

export interface ToolLoopHardStopEvent extends BaseEvent {
  type: 'tool-loop:hard-stop'
  /** 已触达硬兜底的工具轮次 */
  round: number
}

export interface TodoWriteEvent extends BaseEvent {
  type: 'todo-write'
  /** 写入后的全部任务 JSON 序列化（便于历史快照） */
  tasksJson: string
  /** 是否增量合并（merge=true）还是整体覆盖（false） */
  merge: boolean
}

export interface MessageDoneEvent extends BaseEvent {
  type: 'message-done'
  /** 助手最终回复全文（可能很长，运行器自行截断） */
  content: string
}

/**
 * LLM 调用结束的 token usage（每轮一条；多轮 tool-use 会出多条）。
 *
 * 用途：
 *   - eval 框架的 extractUsage(events) 汇总后喂 cost-tracker
 *   - 单条会话的 prompt cache 命中率监控
 */
export interface UsageEvent extends BaseEvent {
  type: 'usage'
  /** 模型 ID（cost-tracker 据此查定价表） */
  model: string
  usage: NormalizedUsage
  /** 当轮在多轮 tool-use 中的序号（0 起；非 tool 循环时只有 0） */
  round?: number
}

export type TelemetryEvent =
  | ConversationStartedEvent
  | ConversationErrorEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | ToolLoopSoftWarnEvent
  | ToolLoopHardStopEvent
  | TodoWriteEvent
  | MessageDoneEvent
  | UsageEvent

// ─── 总线 ──────────────────────────────────────────────────────────────

type Subscriber = (event: TelemetryEvent) => void

class TelemetryBus {
  private enabled = false
  private subscribers = new Set<Subscriber>()

  /** 启用遥测（批量回归运行器 start 时调用） */
  enable(): void {
    this.enabled = true
  }

  /** 关闭并清空订阅者（运行器结束 / 被取消时调用） */
  disable(): void {
    this.enabled = false
    this.subscribers.clear()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * 订阅事件流，返回取消订阅函数。
   * 重复添加同一函数会被 Set 去重，重复 unsubscribe 安全。
   */
  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb)
    return () => {
      this.subscribers.delete(cb)
    }
  }

  /**
   * 发布事件。
   * - disable 状态直接 return（chatStore 调用零成本）
   * - 单个订阅者抛错不影响其他订阅者
   */
  emit(event: TelemetryEvent): void {
    if (!this.enabled || this.subscribers.size === 0) return
    for (const cb of this.subscribers) {
      try {
        cb(event)
      } catch (err) {
        // 订阅者出错绝不影响主链路（聊天工具循环），仅 warn
        console.warn('[regression-telemetry] subscriber threw:', err instanceof Error ? err.message : String(err))
      }
    }
  }

  /** 测试用：当前订阅者数量 */
  subscriberCount(): number {
    return this.subscribers.size
  }
}

/** 全局单例（chatStore + 运行器都引用同一个实例） */
export const regressionTelemetry = new TelemetryBus()

// ─── 收集器 ────────────────────────────────────────────────────────────

/**
 * 单题级别的事件收集器。
 *
 * 典型用法（运行器视角）：
 *   const collector = new TelemetryCollector(convId)
 *   collector.start()
 *   await chatStore.sendMessage(...)
 *   const events = collector.stop()
 *   const usedTools = events.filter(e => e.type === 'tool-call-end').map(e => e.name)
 */
export class TelemetryCollector {
  private events: TelemetryEvent[] = []
  private unsubscribe: (() => void) | null = null
  private readonly conversationId: string

  constructor(conversationId: string) {
    this.conversationId = conversationId
  }

  /** 开始收集（必须先调用 regressionTelemetry.enable()） */
  start(): void {
    if (this.unsubscribe) {
      throw new Error('TelemetryCollector 已 start，未 stop 不能再 start')
    }
    this.events = []
    this.unsubscribe = regressionTelemetry.subscribe((event) => {
      if (event.conversationId === this.conversationId) {
        this.events.push(event)
      }
    })
  }

  /** 停止收集并返回事件副本 */
  stop(): TelemetryEvent[] {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    return [...this.events]
  }

  /** 测试用：当前已收集事件数（未 stop） */
  size(): number {
    return this.events.length
  }
}
