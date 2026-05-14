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

export interface DelegateTypedOptions {
  task: string
  parentBlueprint: AgentBlueprint
  agentType: SubAgentType
  callLLM: LLMCallFn
  /** 自定义 system prompt 拼装；默认基于 parent.persona + agentType */
  buildSystemPrompt?: (child: AgentBlueprint) => string
  hooks?: HookRegistry
  audit?: AuditTrail
}

const DEFAULT_AGENT_TYPE_HINTS: Record<SubAgentType, string> = {
  explore: '你是只读探索子代理：可以读文件、搜知识、查 Excel，不可写入。专注定位与回报。',
  plan: '你是规划子代理：分析任务、拆解步骤、不写文件。输出结构化方案，不执行。',
  worker: '你是执行子代理：完成具体子任务后向主代理交付。',
}

export class TypedSubAgentManager {
  private tasks = new Map<string, TypedSubAgentTask>()
  private destroyed = false

  /**
   * 委派带类型的子任务。spawn 前 fire ON_SPAWN hook，SpawnGuard 检查失败立即拒绝。
   */
  async delegateTyped(opts: DelegateTypedOptions): Promise<TypedSubAgentTask> {
    if (this.destroyed) throw new Error('TypedSubAgentManager 已销毁')

    const { task, parentBlueprint, agentType, callLLM, hooks, audit } = opts
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
        return denied
      }
    }

    const running: TypedSubAgentTask = { ...baseTask, status: 'running', startedAt: Date.now() }
    this.tasks.set(id, running)

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
      return done
    } catch (err) {
      const errored: TypedSubAgentTask = {
        ...running,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: Date.now(),
      }
      this.tasks.set(id, errored)
      return errored
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
