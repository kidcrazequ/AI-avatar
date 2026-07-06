/**
 * P1 Agent Gateway protocol.
 *
 * This is the shared run/thread contract used by desktop IPC today and by CLI,
 * MCP, or IM adapters later. It does not execute a model call by itself; it
 * produces a normalized run plan that every adapter can trace and govern.
 */

import type { BehaviorModeId } from './behavior-modes'
import {
  detectGuardrails,
  type GuardrailActivation,
} from './guardrails'

export const AGENT_GATEWAY_PROTOCOL_VERSION = '2026-06-p1'

export type AgentGatewayChannel = 'desktop' | 'cli' | 'mcp' | 'api' | 'im'
export type AgentGatewayRunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface AgentGatewayRequest {
  runId?: string
  threadId: string
  avatarId: string
  userText: string
  channel?: AgentGatewayChannel
  model?: string
  behaviorModeIds?: Array<BehaviorModeId | string>
  traceEnabled?: boolean
  metadata?: Record<string, string | number | boolean | null>
}

export interface AgentGatewayRunPlan {
  protocolVersion: typeof AGENT_GATEWAY_PROTOCOL_VERSION
  runId: string
  threadId: string
  avatarId: string
  channel: AgentGatewayChannel
  status: AgentGatewayRunStatus
  model?: string
  behaviorModeIds: string[]
  guardrails: GuardrailActivation[]
  traceEnabled: boolean
  secretsExposed: false
  createdAt: string
  metadata: Record<string, string | number | boolean | null>
}

function makeRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const suffix = Math.random().toString(36).slice(2, 8)
  return `run-${stamp}-${suffix}`
}

export function buildAgentGatewayRunPlan(
  req: AgentGatewayRequest,
  now: Date = new Date()
): AgentGatewayRunPlan {
  const behaviorModeIds = [...new Set((req.behaviorModeIds ?? []).map((id) => id.replace(/-/g, '_')))]
  return {
    protocolVersion: AGENT_GATEWAY_PROTOCOL_VERSION,
    runId: req.runId && req.runId.length > 0 ? req.runId : makeRunId(now),
    threadId: req.threadId,
    avatarId: req.avatarId,
    channel: req.channel ?? 'desktop',
    status: 'queued',
    model: req.model,
    behaviorModeIds,
    guardrails: detectGuardrails({
      userText: req.userText,
      behaviorModeIds,
    }),
    traceEnabled: req.traceEnabled ?? true,
    secretsExposed: false,
    createdAt: now.toISOString(),
    metadata: req.metadata ?? {},
  }
}

export function summarizeAgentGatewayRunPlan(plan: AgentGatewayRunPlan): string {
  const modes = plan.behaviorModeIds.length > 0 ? plan.behaviorModeIds.join(',') : 'none'
  const guards = plan.guardrails.length > 0 ? plan.guardrails.map((g) => g.policy.id).join(',') : 'none'
  return `run=${plan.runId} thread=${plan.threadId} avatar=${plan.avatarId} channel=${plan.channel} modes=${modes} guardrails=${guards}`
}

