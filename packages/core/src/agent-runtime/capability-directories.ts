/**
 * Avatar capability directory protocol.
 *
 * This is a read-only map over the existing Soul avatar package layout. It
 * gives future desktop/CLI/IM adapters one vocabulary for tools, skills,
 * schedules, channels, knowledge, memory, tests, and conversation workspaces
 * without moving existing files.
 */

import path from 'path'

export const AGENT_CAPABILITY_PROTOCOL_VERSION = '2026-06-p0-capabilities'

export type AgentCapabilityDirKind =
  | 'avatar'
  | 'tools'
  | 'skills'
  | 'channels'
  | 'schedules'
  | 'knowledge'
  | 'memory'
  | 'tests'
  | 'workspaces'

export interface AgentCapabilityDirDescriptor {
  kind: AgentCapabilityDirKind
  path: string
  virtualPath: string
  purpose: string
  required: boolean
}

export interface AgentCapabilityLayout {
  protocolVersion: typeof AGENT_CAPABILITY_PROTOCOL_VERSION
  avatarRoot: string
  dirs: Record<AgentCapabilityDirKind, string>
  virtualDirs: Record<AgentCapabilityDirKind, string>
  descriptors: AgentCapabilityDirDescriptor[]
}

const DIR_NAMES: Record<AgentCapabilityDirKind, string> = {
  avatar: '.',
  tools: 'tools',
  skills: 'skills',
  channels: 'channels',
  schedules: 'schedules',
  knowledge: 'knowledge',
  memory: 'memory',
  tests: 'tests',
  workspaces: 'workspaces',
}

const PURPOSES: Record<AgentCapabilityDirKind, string> = {
  avatar: 'Avatar identity files such as soul.md, CLAUDE.md, and avatar.config.json.',
  tools: 'Local adapter/tool definitions. Optional today; reserved for Gateway-compatible tools.',
  skills: 'Local skill definitions and skill-index.yaml references.',
  channels: 'Inbound/outbound channel adapters such as desktop, API, IM, or MCP profiles.',
  schedules: 'Cron or recurring task definitions owned by the avatar.',
  knowledge: 'Traceable domain knowledge and source-derived notes.',
  memory: 'Long-term memory, standing orders, and profile state.',
  tests: 'Red-line, regression, and persona test cases.',
  workspaces: 'Per-conversation task workspaces with uploads, outputs, artifacts, and traces.',
}

const REQUIRED_DIRS = new Set<AgentCapabilityDirKind>([
  'avatar',
  'skills',
  'knowledge',
  'memory',
  'tests',
  'workspaces',
])

function makeRecord<T>(pairs: Array<[AgentCapabilityDirKind, T]>): Record<AgentCapabilityDirKind, T> {
  return Object.fromEntries(pairs) as Record<AgentCapabilityDirKind, T>
}

export function buildAgentCapabilityLayout(avatarRoot: string): AgentCapabilityLayout {
  const root = path.resolve(avatarRoot)
  const kinds = Object.keys(DIR_NAMES) as AgentCapabilityDirKind[]
  const dirs = makeRecord(kinds.map((kind) => [kind, path.join(root, DIR_NAMES[kind])]))
  dirs.avatar = root
  const virtualDirs = makeRecord(kinds.map((kind) => [kind, `/mnt/avatar/${kind}`]))
  virtualDirs.avatar = '/mnt/avatar'
  const descriptors = kinds.map((kind) => ({
    kind,
    path: dirs[kind],
    virtualPath: virtualDirs[kind],
    purpose: PURPOSES[kind],
    required: REQUIRED_DIRS.has(kind),
  }))

  return {
    protocolVersion: AGENT_CAPABILITY_PROTOCOL_VERSION,
    avatarRoot: root,
    dirs,
    virtualDirs,
    descriptors,
  }
}

export function describeAgentCapabilityLayout(layout: AgentCapabilityLayout): string[] {
  return layout.descriptors.map((item) => {
    const required = item.required ? 'required' : 'optional'
    return `${item.kind} ${item.virtualPath} (${required}) - ${item.purpose}`
  })
}

export function buildAgentCapabilityPromptHint(layout: AgentCapabilityLayout): string {
  return [
    '## Avatar Capability Directories',
    `Protocol: ${layout.protocolVersion}`,
    ...describeAgentCapabilityLayout(layout).map((line) => `- ${line}`),
    'Use knowledge/ for professional facts, memory/ for durable preferences, skills/ for reusable workflows, and workspaces/<conversation>/outputs for user-facing deliverables.',
  ].join('\n')
}
