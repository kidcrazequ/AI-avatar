/**
 * AgentBlueprint — 声明式分身定义
 *
 * 借鉴 power-agent-platform 的 IdentityCard + AgentBlueprint 设计：
 * 把现有的 expert-pack.json / soul.md / skill-index.yaml / knowledge 目录
 * 装配成单个 frozen 对象，供 Hook 总线、SpawnGuard、PromptRegistry 消费。
 *
 * 不破坏现有 AvatarManager 与 SkillManager；旧路径继续按需读取文件，
 * 新路径走 loadBlueprintFromAvatarDir() 装配。
 *
 * 与 A2A AgentCard 兼容：identity 子结构是 AgentCard 的子集，
 * Phase 8 增加 `toA2AAgentCard(blueprint)` 直接暴露 /.well-known/agent.json。
 */

import { z } from 'zod'

// ── 子结构 ───────────────────────────────────────────────────────────────

export const IdentityCardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 一段自我介绍，会被组装到 system prompt 顶部 */
  persona: z.string(),
  /** 业务范围（PAP scope），例如 "财务分析" */
  scope: z.string().default(''),
  owner: z.string().default(''),
  version: z.string().default('0.1.0'),
  tags: z.array(z.string()).default([]),
  description: z.string().default(''),
  /** 红线提示，例如"不替代审计意见" */
  redline: z.string().default(''),
})
export type IdentityCard = z.infer<typeof IdentityCardSchema>

export const SkillRefSchema = z.object({
  id: z.string().min(1),
  source: z.enum(['local', 'shared', 'community']),
  path: z.string().min(1),
  version: z.string().optional(),
  domain: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  when: z.string().optional(),
  priority: z.number().optional(),
})
export type SkillRef = z.infer<typeof SkillRefSchema>

export const ToolRefSchema = z.object({
  name: z.string().min(1),
  /** MCP server 名称；内置工具留空 */
  server: z.string().optional(),
})
export type ToolRef = z.infer<typeof ToolRefSchema>

export const KBScopeSchema = z.object({
  /** 知识库目录相对路径（相对仓库根） */
  path: z.string().min(1),
  read: z.boolean().default(true),
  write: z.boolean().default(false),
})
export type KBScope = z.infer<typeof KBScopeSchema>

/** 工具权限模式 — Phase 4 引入 ASK 态 */
export const PermissionModeSchema = z.enum(['allow', 'ask', 'deny'])
export type PermissionMode = z.infer<typeof PermissionModeSchema>

export const PermissionSchema = z.object({
  /** 工具名 → 模式覆盖；未匹配走 defaultMode */
  tools: z.record(z.string(), PermissionModeSchema).default({}),
  defaultMode: PermissionModeSchema.default('allow'),
})
export type Permission = z.infer<typeof PermissionSchema>

export const BudgetSchema = z.object({
  maxTurns: z.number().int().positive().default(20),
  maxTokens: z.number().int().positive().optional(),
  maxWallClockSec: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
})
export type Budget = z.infer<typeof BudgetSchema>

export const MemoryPolicySchema = z.object({
  shortTermTtlSec: z.number().int().nonnegative().default(3600),
  episodicRetentionDays: z.number().int().nonnegative().default(365),
  semanticRetentionDays: z.number().int().nonnegative().default(365 * 5),
  importanceDecay: z.boolean().default(true),
})
export type MemoryPolicy = z.infer<typeof MemoryPolicySchema>

// ── 顶层 Blueprint ───────────────────────────────────────────────────────

export const AgentBlueprintSchema = z.object({
  identity: IdentityCardSchema,
  /** soul.md / CLAUDE.md / shared CLAUDE.md 的有序路径列表 */
  ruleLayers: z.array(z.string()).default([]),
  skills: z.array(SkillRefSchema).default([]),
  tools: z.array(ToolRefSchema).default([]),
  kbScopes: z.array(KBScopeSchema).default([]),
  memoryPolicy: MemoryPolicySchema.default(() => MemoryPolicySchema.parse({})),
  permission: PermissionSchema.default(() => PermissionSchema.parse({})),
  budget: BudgetSchema.default(() => BudgetSchema.parse({})),
  /** 父代理 id，用于 SpawnGuard 校验能力降级（Phase 3） */
  parentAgentId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export type AgentBlueprint = z.infer<typeof AgentBlueprintSchema>

/**
 * 检查子 Blueprint 的能力是否 ⊆ 父 Blueprint（SpawnGuard 用，Phase 3）。
 * 当前只校验工具白名单与权限默认值，未来扩展更多维度。
 */
export function isCapabilitySubset(
  child: AgentBlueprint,
  parent: AgentBlueprint
): { ok: boolean; reason?: string } {
  // 工具白名单：子代理不能拥有父代理没有的工具
  const parentToolNames = new Set(parent.tools.map((t) => t.name))
  for (const childTool of child.tools) {
    if (parentToolNames.size > 0 && !parentToolNames.has(childTool.name)) {
      return { ok: false, reason: `子代理工具 "${childTool.name}" 不在父代理白名单中` }
    }
  }
  // defaultMode 等级：allow > ask > deny；子不能比父宽松
  const rank: Record<PermissionMode, number> = { deny: 0, ask: 1, allow: 2 }
  if (rank[child.permission.defaultMode] > rank[parent.permission.defaultMode]) {
    return {
      ok: false,
      reason: `子代理默认权限 "${child.permission.defaultMode}" 高于父代理 "${parent.permission.defaultMode}"`,
    }
  }
  // budget：子不能超过父
  if (child.budget.maxTurns > parent.budget.maxTurns) {
    return { ok: false, reason: `子代理 maxTurns (${child.budget.maxTurns}) 超过父 (${parent.budget.maxTurns})` }
  }
  return { ok: true }
}
