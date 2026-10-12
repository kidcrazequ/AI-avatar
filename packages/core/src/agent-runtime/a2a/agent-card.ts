/**
 * A2A AgentCard 序列化器。
 *
 * 输出与 google/a2a-protocol 的 AgentCard schema 兼容，可直接挂到
 * /.well-known/agent.json 让外部 agent 平台发现 soul 分身。
 *
 * 我们只输出协议必需字段；扩展字段（capabilities / authentication 等）
 * 在 toA2AAgentCard 的 options 里按需开启。
 */

import type { AgentBlueprint } from '../blueprint'

export interface A2ASkillCard {
  id: string
  name: string
  description: string
  tags: string[]
}

export interface A2AAgentCard {
  /** 协议必需 */
  name: string
  description: string
  /** 服务 endpoint，由调用方注入（如 http://host:port/agent） */
  url: string
  version: string
  /** A2A capabilities 子集 */
  capabilities: {
    streaming: boolean
    pushNotifications: boolean
  }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: A2ASkillCard[]
  /** 扩展元信息 */
  provider?: {
    organization?: string
    url?: string
  }
  /** soul 自有扩展：红线 */
  'x-soul-redline'?: string
  /** soul 自有扩展：业务范围 */
  'x-soul-scope'?: string
}

export interface ToA2AOptions {
  /** Agent 服务的 endpoint */
  url: string
  /** capabilities 覆盖；默认 streaming=false / pushNotifications=false */
  capabilities?: Partial<A2AAgentCard['capabilities']>
  /** 输入/输出模式；默认 ['text'] */
  defaultInputModes?: string[]
  defaultOutputModes?: string[]
  provider?: A2AAgentCard['provider']
}

export function toA2AAgentCard(bp: AgentBlueprint, opts: ToA2AOptions): A2AAgentCard {
  const skills: A2ASkillCard[] = bp.skills.map((s) => ({
    id: s.id,
    name: s.id,
    description: s.when ?? s.domain ?? '',
    tags: s.keywords ?? [],
  }))

  const card: A2AAgentCard = {
    name: bp.identity.name,
    description: bp.identity.description || bp.identity.persona.slice(0, 200),
    url: opts.url,
    version: bp.identity.version,
    capabilities: {
      streaming: opts.capabilities?.streaming ?? false,
      pushNotifications: opts.capabilities?.pushNotifications ?? false,
    },
    defaultInputModes: opts.defaultInputModes ?? ['text'],
    defaultOutputModes: opts.defaultOutputModes ?? ['text'],
    skills,
    provider: opts.provider,
  }

  if (bp.identity.redline) card['x-soul-redline'] = bp.identity.redline
  if (bp.identity.scope) card['x-soul-scope'] = bp.identity.scope

  return card
}
