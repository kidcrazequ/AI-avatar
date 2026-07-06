/**
 * P1 guardrail policy pack.
 *
 * This layer is intentionally small and deterministic: prompt guardrails guide
 * model behavior, while tool-call guardrails can make a pre-execution decision
 * without depending on Electron or a provider SDK.
 */

import type { BehaviorModeId } from './behavior-modes'

export type GuardrailPolicyId =
  | 'source_traceability'
  | 'code_review_readonly'
  | 'artifact_pathing'
  | 'irreversible_action_confirm'

export type GuardrailAction = 'allow' | 'ask' | 'deny'

export interface GuardrailPolicy {
  id: GuardrailPolicyId
  title: string
  action: GuardrailAction
  prompt: string
  triggers: string[]
}

export interface GuardrailActivation {
  policy: GuardrailPolicy
  reason: string
}

export interface DetectGuardrailsInput {
  userText?: string
  behaviorModeIds?: Array<BehaviorModeId | string>
}

export interface GuardrailToolCallContext {
  toolName: string
  args?: Record<string, unknown>
  behaviorModeIds?: Array<BehaviorModeId | string>
  userText?: string
}

export interface GuardrailToolDecision {
  action: GuardrailAction
  policyId?: GuardrailPolicyId
  reason?: string
}

export const DEFAULT_GUARDRAIL_POLICIES: GuardrailPolicy[] = [
  {
    id: 'source_traceability',
    title: 'Source Traceability',
    action: 'allow',
    prompt: '关键事实、参数、结论必须能回到知识库、附件、工具结果或明确来源；缺来源时直接标缺口。',
    triggers: ['溯源', '来源', '证据', '不要编', '严谨'],
  },
  {
    id: 'code_review_readonly',
    title: 'Code Review Readonly',
    action: 'deny',
    prompt: '代码审查默认只读：先输出问题清单，不主动改代码、不执行破坏性命令，除非用户明确要求修复。',
    triggers: ['code review', '代码审查', 'review'],
  },
  {
    id: 'artifact_pathing',
    title: 'Artifact Pathing',
    action: 'allow',
    prompt: '需要留痕或交付文件时，把最终文件写入 outputs/，中间产物写入 artifacts/，不要把临时草稿当最终交付。',
    triggers: ['输出留痕', '落盘', '生成文件', '导出', '报告'],
  },
  {
    id: 'irreversible_action_confirm',
    title: 'Irreversible Action Confirmation',
    action: 'ask',
    prompt: '删除、覆盖、批量改写、外部发布等不可逆动作必须先确认影响范围；不清楚时降级为方案或草稿。',
    triggers: ['删除', '覆盖', '清空', '发布', '推送'],
  },
]

const POLICY_BY_ID = new Map(DEFAULT_GUARDRAIL_POLICIES.map((p) => [p.id, p]))

const READONLY_DENIED_TOOL_NAMES = new Set([
  'write_file',
  'delete_file',
  'copy_file',
  'move_file',
  'write_knowledge_file',
  'delete_knowledge_file',
  'create_knowledge_file',
  'install_skill',
  'delete_skill',
  'toggle_skill',
  'execute_command',
  'run_command',
  'shell',
  'apply_patch',
])

const READONLY_DENIED_PREFIXES = ['write_', 'delete_', 'create_', 'update_']

function hasMode(ids: Array<BehaviorModeId | string> | undefined, id: BehaviorModeId): boolean {
  return Boolean(ids?.some((item) => item === id || item.replace(/-/g, '_') === id))
}

function textMatches(text: string, policy: GuardrailPolicy): boolean {
  const lower = text.toLowerCase()
  return policy.triggers.some((trigger) => lower.includes(trigger.toLowerCase()))
}

function addPolicy(out: GuardrailActivation[], id: GuardrailPolicyId, reason: string): void {
  const policy = POLICY_BY_ID.get(id)
  if (!policy || out.some((item) => item.policy.id === id)) return
  out.push({ policy, reason })
}

export function detectGuardrails(input: DetectGuardrailsInput): GuardrailActivation[] {
  const text = input.userText ?? ''
  const out: GuardrailActivation[] = []

  if (hasMode(input.behaviorModeIds, 'strict_traceability')) {
    addPolicy(out, 'source_traceability', 'behavior_mode:strict_traceability')
  }
  if (hasMode(input.behaviorModeIds, 'code_review')) {
    addPolicy(out, 'code_review_readonly', 'behavior_mode:code_review')
  }

  for (const policy of DEFAULT_GUARDRAIL_POLICIES) {
    if (textMatches(text, policy)) addPolicy(out, policy.id, 'keyword')
  }

  return out
}

export function buildGuardrailPromptBlock(activations: GuardrailActivation[]): string {
  if (activations.length === 0) return ''
  const lines = ['## Runtime Guardrails']
  for (const activation of activations) {
    lines.push(`- ${activation.policy.id} [${activation.policy.action}]: ${activation.policy.prompt}`)
  }
  return lines.join('\n')
}

export function isReadonlyDeniedTool(toolName: string): boolean {
  const normalized = toolName.trim()
  if (READONLY_DENIED_TOOL_NAMES.has(normalized)) return true
  return READONLY_DENIED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export function evaluateGuardrailToolCall(ctx: GuardrailToolCallContext): GuardrailToolDecision {
  if (hasMode(ctx.behaviorModeIds, 'code_review') && isReadonlyDeniedTool(ctx.toolName)) {
    return {
      action: 'deny',
      policyId: 'code_review_readonly',
      reason: `代码审查模式默认只读，已拒绝工具 ${ctx.toolName}`,
    }
  }
  return { action: 'allow' }
}

