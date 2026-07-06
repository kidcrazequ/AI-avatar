import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAgentGatewayRunPlan,
  buildGuardrailPromptBlock,
  detectGuardrails,
  evaluateGuardrailToolCall,
  summarizeAgentGatewayRunPlan,
} from '../agent-runtime'

describe('P1 guardrails', () => {
  it('detects source and code-review guardrails from modes and keywords', () => {
    const guards = detectGuardrails({
      userText: '请做 code review，要求严谨溯源，不要编。',
      behaviorModeIds: ['strict_traceability'],
    })
    assert.deepEqual(guards.map((g) => g.policy.id), ['source_traceability', 'code_review_readonly'])
    const block = buildGuardrailPromptBlock(guards)
    assert.match(block, /Runtime Guardrails/)
    assert.match(block, /source_traceability/)
    assert.match(block, /code_review_readonly/)
  })

  it('denies mutation tools in code-review mode', () => {
    const deny = evaluateGuardrailToolCall({
      toolName: 'write_file',
      behaviorModeIds: ['code-review'],
    })
    assert.equal(deny.action, 'deny')
    assert.equal(deny.policyId, 'code_review_readonly')

    const allow = evaluateGuardrailToolCall({
      toolName: 'read_file',
      behaviorModeIds: ['code_review'],
    })
    assert.equal(allow.action, 'allow')
  })
})

describe('P1 gateway protocol', () => {
  it('builds a stable run plan without exposing secrets', () => {
    const plan = buildAgentGatewayRunPlan(
      {
        runId: 'run-fixed',
        threadId: 'conv-1',
        avatarId: '小堵',
        userText: '输出留痕，严格溯源。',
        channel: 'desktop',
        model: 'deepseek-chat',
        behaviorModeIds: ['strict-traceability'],
        metadata: { requestId: 7 },
      },
      new Date(Date.UTC(2026, 5, 25, 2, 0, 0)),
    )

    assert.equal(plan.protocolVersion, '2026-06-p1')
    assert.equal(plan.runId, 'run-fixed')
    assert.equal(plan.status, 'queued')
    assert.equal(plan.secretsExposed, false)
    assert.deepEqual(plan.behaviorModeIds, ['strict_traceability'])
    assert.ok(plan.guardrails.some((g) => g.policy.id === 'source_traceability'))
    assert.ok(plan.guardrails.some((g) => g.policy.id === 'artifact_pathing'))
    assert.match(summarizeAgentGatewayRunPlan(plan), /run=run-fixed/)
  })
})

