/**
 * SpawnGuard：子代理 spawn 前校验能力 ⊆ 父代理。
 *
 * 借鉴 PAP `pap/governance/spawn_guard.py`：每种 SubAgentType 有预设的工具白名单
 * 与 permission defaultMode，子代理 Blueprint 必须能通过 isCapabilitySubset 校验。
 */

import {
  AgentBlueprintSchema,
  isCapabilitySubset,
  type AgentBlueprint,
  type PermissionMode,
  type ToolRef,
} from '../blueprint'

export type SubAgentType = 'explore' | 'plan' | 'worker' | 'verifier'

/**
 * 四类子代理的默认能力约束。
 * - explore：只读工具白名单，不能写文件、不能 spawn 子代理
 * - plan：可读 + 可推理，不能写文件
 * - worker：继承父代理工具白名单（无独立约束）
 * - verifier：只读工具白名单（与 explore 同），不能写文件、不能 spawn；定位是
 *   复核 worker 已产出的结论（来源、数字、引用是否真实存在），匹配 Soul 的
 *   数据可溯源红线。借鉴 MiniMax Mavis 的 Leader/Worker/Verifier 三角色（2026-05-22）。
 */
export interface SubAgentTypeProfile {
  /** 允许的工具名集合；null 表示继承父代理 */
  allowedTools: ReadonlySet<string> | null
  /** 默认权限模式 */
  defaultMode: PermissionMode
  /** 是否允许进一步 spawn 子代理 */
  canSpawn: boolean
  /** 默认 maxTurns 上限（不能超过父代理） */
  maxTurns: number
}

const READ_ONLY_TOOLS = new Set([
  'read_knowledge_file',
  'read_file',
  'search_knowledge',
  'grep',
  'glob',
  'query_excel',
  'list_files',
])

const PLAN_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  'search_design_systems',
  'rerank_skills',
])

export const SUB_AGENT_PROFILES: Record<SubAgentType, SubAgentTypeProfile> = {
  explore: {
    allowedTools: READ_ONLY_TOOLS,
    defaultMode: 'allow',
    canSpawn: false,
    maxTurns: 8,
  },
  plan: {
    allowedTools: PLAN_TOOLS,
    defaultMode: 'allow',
    canSpawn: false,
    maxTurns: 10,
  },
  worker: {
    allowedTools: null, // 继承父代理
    defaultMode: 'allow',
    canSpawn: true,
    maxTurns: 20,
  },
  verifier: {
    allowedTools: READ_ONLY_TOOLS,
    defaultMode: 'allow',
    canSpawn: false,
    maxTurns: 6,
  },
}

/**
 * 基于父 Blueprint + SubAgentType 派生子代理 Blueprint。
 * 子代理 identity 复用父代理（id 加后缀），工具集按 profile 过滤，
 * budget.maxTurns 取 min(profile.maxTurns, parent.budget.maxTurns)。
 */
export function deriveChildBlueprint(
  parent: AgentBlueprint,
  agentType: SubAgentType,
  childId: string,
  task: string
): AgentBlueprint {
  const profile = SUB_AGENT_PROFILES[agentType]

  let childTools: ToolRef[]
  if (profile.allowedTools) {
    childTools = parent.tools.filter((t) => profile.allowedTools!.has(t.name))
    // 若父代理没有列工具（空白名单 = 全允许约定），则用 profile 的工具名占位
    if (parent.tools.length === 0) {
      childTools = Array.from(profile.allowedTools).map((name) => ({ name }))
    }
  } else {
    childTools = [...parent.tools]
  }

  const maxTurns = Math.min(profile.maxTurns, parent.budget.maxTurns)

  return AgentBlueprintSchema.parse({
    identity: {
      ...parent.identity,
      id: childId,
      name: `${parent.identity.name} · ${agentType}`,
      description: task,
    },
    ruleLayers: parent.ruleLayers,
    skills: parent.skills,
    tools: childTools,
    kbScopes: parent.kbScopes.map((s) => ({ ...s, write: false })), // 子代理只读 KB
    memoryPolicy: parent.memoryPolicy,
    permission: {
      tools: parent.permission.tools,
      defaultMode: profile.defaultMode,
    },
    budget: {
      ...parent.budget,
      maxTurns,
    },
    parentAgentId: parent.identity.id,
    metadata: {
      ...parent.metadata,
      subAgentType: agentType,
    },
  })
}

export interface GuardResult {
  ok: boolean
  reason?: string
}

/**
 * 在 spawn 前调用：核验子代理 Blueprint 合法（且 ⊆ 父代理）。
 * 失败时返回 { ok: false, reason }，调用方应抛出或拒绝 spawn。
 */
export function checkSpawn(
  parent: AgentBlueprint,
  child: AgentBlueprint,
  agentType: SubAgentType
): GuardResult {
  const profile = SUB_AGENT_PROFILES[agentType]

  // 必须声明 parentAgentId
  if (child.parentAgentId !== parent.identity.id) {
    return {
      ok: false,
      reason: `子代理 parentAgentId (${child.parentAgentId}) 不匹配父代理 (${parent.identity.id})`,
    }
  }

  // 工具白名单（profile.allowedTools 不为 null 时强约束）
  if (profile.allowedTools) {
    for (const t of child.tools) {
      if (!profile.allowedTools.has(t.name)) {
        return {
          ok: false,
          reason: `${agentType} 子代理不允许工具 "${t.name}"（白名单：${[...profile.allowedTools].join(', ')}）`,
        }
      }
    }
  }

  // maxTurns 上限
  if (child.budget.maxTurns > profile.maxTurns) {
    return {
      ok: false,
      reason: `${agentType} 子代理 maxTurns (${child.budget.maxTurns}) 超过类型上限 (${profile.maxTurns})`,
    }
  }

  // 通用能力降级
  const subset = isCapabilitySubset(child, parent)
  if (!subset.ok) return subset

  return { ok: true }
}
