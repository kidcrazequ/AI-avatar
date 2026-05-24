/**
 * TypedSubAgentManager：在 SubAgentManager 之上加 agentType + SpawnGuard。
 *
 * 与现有 SubAgentManager 并存：
 *   - 旧路径（无类型）走 SubAgentManager.delegate(task, systemPrompt, callLLM)
 *   - 新路径走 TypedSubAgentManager.delegateTyped(task, parentBlueprint, agentType, callLLM)
 *
 * 由 SOUL_USE_NEW_RUNTIME flag 控制选择。
 */

import { HookPoint } from './hooks/points'
import type { HookRegistry, OnSpawnPayload } from './hooks/registry'
import type { AuditTrail } from './audit-trail'
import type { AgentBlueprint } from './blueprint'
import {
  checkSpawn,
  deriveChildBlueprint,
  SUB_AGENT_PROFILES,
  type SubAgentType,
} from './governance/spawn-guard'

export type TypedSubAgentStatus = 'pending' | 'running' | 'done' | 'error' | 'denied'

export interface TypedSubAgentTask {
  id: string
  task: string
  agentType: SubAgentType
  parentAgentId: string
  status: TypedSubAgentStatus
  blueprint: AgentBlueprint
  result?: string
  error?: string
  startedAt?: number
  finishedAt?: number
  denyReason?: string
}

export type LLMCallFn = (
  systemPrompt: string,
  userPrompt: string,
  maxTokens?: number
) => Promise<string>

/**
 * 状态变更通知回调（v16 引入，Managed-Agents 借鉴第 1 步 · 拓展到 typed runtime）。
 *
 * 与 SubAgentManager 的 SubAgentChangeFn 形态一致，差别仅在 task 类型：
 * 这里传 TypedSubAgentTask，多出 agentType / parentAgentId / denyReason 等字段。
 *
 * 在以下时刻各被调用一次：
 *   - SpawnGuard 拒绝 → status='denied'
 *   - Hook 拒绝       → status='denied'
 *   - spawn 成功     → status='running'
 *   - LLM 完成       → status='done'
 *   - LLM 失败       → status='error'
 *
 * 实现方必须 fire-and-forget 自行兜底异常；TypedSubAgentManager 内部已 try/catch 兜底。
 */
export type TypedSubAgentChangeFn = (task: TypedSubAgentTask) => void

export interface DelegateTypedOptions {
  task: string
  parentBlueprint: AgentBlueprint
  agentType: SubAgentType
  callLLM: LLMCallFn
  /** 自定义 system prompt 拼装；默认基于 parent.persona + agentType */
  buildSystemPrompt?: (child: AgentBlueprint) => string
  hooks?: HookRegistry
  audit?: AuditTrail
  /** 任务状态变更回调（denied/running/done/error 各触发一次） */
  onChange?: TypedSubAgentChangeFn
}

const DEFAULT_AGENT_TYPE_HINTS: Record<SubAgentType, string> = {
  explore: '你是只读探索子代理：可以读文件、搜知识、查 Excel，不可写入。专注定位与回报。',
  plan: '你是规划子代理：分析任务、拆解步骤、不写文件。输出结构化方案，不执行。',
  worker: '你是执行子代理：完成具体子任务后向主代理交付。',
  verifier: [
    '你是复核子代理：专门检查另一个子代理（通常是 worker）产出的结论是否站得住。',
    '检查项（按 Soul 数据可溯源红线）：',
    '1) 每个具体数字是否真的能在引用的来源里找到？（query_excel / read_file 自己复算一遍）',
    '2) 引用的 knowledge/<path>.md 是否真实存在且包含被引段落？',
    '3) Excel 来源是否标到 sheet 名级别？还是用 markdown 总结冒充原始 sheet？',
    '4) 有没有"缺数据但画了占位骨架"的情况？',
    '不写文件、不 spawn 子代理。输出必须明确：✅ 通过 / ❌ 不通过 + 具体不通过项 + 缺口清单。',
  ].join('\n'),
}

export class TypedSubAgentManager {
  private tasks = new Map<string, TypedSubAgentTask>()
  private destroyed = false

  /**
   * 委派带类型的子任务。spawn 前 fire ON_SPAWN hook，SpawnGuard 检查失败立即拒绝。
   */
  async delegateTyped(opts: DelegateTypedOptions): Promise<TypedSubAgentTask> {
    if (this.destroyed) throw new Error('TypedSubAgentManager 已销毁')

    const { task, parentBlueprint, agentType, callLLM, hooks, audit, onChange } = opts
    const id = `sub-${agentType}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const child = deriveChildBlueprint(parentBlueprint, agentType, id, task)
    const guard = checkSpawn(parentBlueprint, child, agentType)

    const baseTask: TypedSubAgentTask = {
      id,
      task,
      agentType,
      parentAgentId: parentBlueprint.identity.id,
      status: 'pending',
      blueprint: child,
    }

    if (!guard.ok) {
      const denied: TypedSubAgentTask = {
        ...baseTask,
        status: 'denied',
        denyReason: guard.reason,
        finishedAt: Date.now(),
      }
      this.tasks.set(id, denied)
      audit?.record({
        point: HookPoint.ON_SPAWN,
        agentId: parentBlueprint.identity.id,
        payload: { id, agentType, task, denied: true, reason: guard.reason },
      })
      this.fireChange(onChange, denied)
      return denied
    }

    if (hooks) {
      const payload: OnSpawnPayload = {
        point: HookPoint.ON_SPAWN,
        timestamp: Date.now(),
        parentAgentId: parentBlueprint.identity.id,
        childAgentType: agentType,
        task,
      }
      const r = await hooks.fire(payload)
      if (r.deny) {
        const denied: TypedSubAgentTask = {
          ...baseTask,
          status: 'denied',
          denyReason: r.reason,
          finishedAt: Date.now(),
        }
        this.tasks.set(id, denied)
        this.fireChange(onChange, denied)
        return denied
      }
    }

    const running: TypedSubAgentTask = { ...baseTask, status: 'running', startedAt: Date.now() }
    this.tasks.set(id, running)
    this.fireChange(onChange, running)

    audit?.record({
      point: HookPoint.ON_SPAWN,
      agentId: parentBlueprint.identity.id,
      payload: { id, agentType, task, profile: SUB_AGENT_PROFILES[agentType] },
    })

    const systemPrompt =
      opts.buildSystemPrompt?.(child) ??
      `${child.identity.persona}\n\n${DEFAULT_AGENT_TYPE_HINTS[agentType]}`

    try {
      const result = await callLLM(systemPrompt, task)
      const done: TypedSubAgentTask = {
        ...running,
        status: 'done',
        result,
        finishedAt: Date.now(),
      }
      this.tasks.set(id, done)
      this.fireChange(onChange, done)
      return done
    } catch (err) {
      const errored: TypedSubAgentTask = {
        ...running,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: Date.now(),
      }
      this.tasks.set(id, errored)
      this.fireChange(onChange, errored)
      return errored
    }
  }

  /**
   * 安全触发 onChange：sink 抛错只 warn，不污染主链。
   * 与 SubAgentManager.fireChange 同型——两边的 sink 失败行为对外一致。
   */
  private fireChange(onChange: TypedSubAgentChangeFn | undefined, task: TypedSubAgentTask): void {
    if (!onChange) return
    try {
      onChange({ ...task })
    } catch (err) {
      console.warn(`[TypedSubAgentManager] onChange sink 抛错 (${task.id}):`, err instanceof Error ? err.message : String(err))
    }
  }

  get(id: string): TypedSubAgentTask | undefined {
    return this.tasks.get(id)
  }

  list(): TypedSubAgentTask[] {
    return [...this.tasks.values()]
  }

  destroy(): void {
    this.destroyed = true
    this.tasks.clear()
  }
}
