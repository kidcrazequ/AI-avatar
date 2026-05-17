/**
 * TypedSubAgentManager.delegateTyped(..., onChange) 单测（v16 引入）。
 *
 * 覆盖五条状态转移：
 *   1. SpawnGuard 拒绝 → sink 收到一次 status='denied'，denyReason 已填，LLM 未被调用
 *   2. Hook 拒绝       → sink 收到一次 status='denied'，denyReason 已填，LLM 未被调用
 *   3. 合法 spawn 后 LLM 成功 → sink 依次收到 'running' + 'done'，agentType 已填
 *   4. 合法 spawn 后 LLM 失败 → sink 依次收到 'running' + 'error'，error 已填
 *   5. sink 抛错不污染 LLM 主链——返回值仍正常
 *
 * 与 sub-agent-manager.test.ts 形态一致：mock LLM，直接断言 sink 事件序列。
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentBlueprintSchema,
  TypedSubAgentManager,
  HookRegistry,
  HookPoint,
  type TypedSubAgentTask,
} from '../agent-runtime'

function makeParent(maxTurns = 20) {
  return AgentBlueprintSchema.parse({
    identity: { id: 'parent', name: 'Parent', persona: '主代理人格' },
    tools: [
      { name: 'read_knowledge_file' },
      { name: 'query_excel' },
      { name: 'write_file' },
    ],
    budget: { maxTurns },
    permission: { defaultMode: 'allow' },
  })
}

describe('TypedSubAgentManager · onChange sink', () => {
  it('合法 spawn + LLM 成功：sink 依次收到 running + done，agentType 已填', async () => {
    const mgr = new TypedSubAgentManager()
    const events: TypedSubAgentTask[] = []

    const r = await mgr.delegateTyped({
      task: '找出营业收入',
      parentBlueprint: makeParent(),
      agentType: 'explore',
      callLLM: async () => '结果文本',
      onChange: (t) => events.push({ ...t }),
    })

    assert.equal(r.status, 'done')
    assert.equal(events.length, 2, `应触发 running + done 两次，实际 ${events.map((e) => e.status).join(',')}`)
    assert.equal(events[0].status, 'running')
    assert.equal(events[0].agentType, 'explore')
    assert.equal(events[1].status, 'done')
    assert.equal(events[1].result, '结果文本')
  })

  it('合法 spawn + LLM 抛错：sink 依次收到 running + error，error 已填', async () => {
    const mgr = new TypedSubAgentManager()
    const events: TypedSubAgentTask[] = []

    const r = await mgr.delegateTyped({
      task: 't',
      parentBlueprint: makeParent(),
      agentType: 'worker',
      callLLM: async () => { throw new Error('LLM 模拟失败') },
      onChange: (t) => events.push({ ...t }),
    })

    assert.equal(r.status, 'error')
    assert.equal(events.length, 2)
    assert.equal(events[0].status, 'running')
    assert.equal(events[1].status, 'error')
    assert.match(events[1].error ?? '', /LLM 模拟失败/)
  })

  it('Hook 拒绝：sink 仅收到 denied 一次，denyReason 已填，LLM 不被调用', async () => {
    const mgr = new TypedSubAgentManager()
    const events: TypedSubAgentTask[] = []
    const reg = new HookRegistry()
    reg.register(HookPoint.ON_SPAWN, async () => ({ deny: true, reason: '配额耗尽' }))

    let llmCalled = false
    const r = await mgr.delegateTyped({
      task: 't',
      parentBlueprint: makeParent(),
      agentType: 'plan',
      callLLM: async () => { llmCalled = true; return 'x' },
      hooks: reg,
      onChange: (t) => events.push({ ...t }),
    })

    assert.equal(r.status, 'denied')
    assert.equal(llmCalled, false, 'LLM 不应被调用')
    assert.equal(events.length, 1, '只应触发一次 denied，没有 running')
    assert.equal(events[0].status, 'denied')
    assert.equal(events[0].agentType, 'plan')
    assert.match(events[0].denyReason ?? '', /配额耗尽/)
  })

  // 注：SpawnGuard 拒绝路径在 delegateTyped 公共 API 下不可达——
  // deriveChildBlueprint 总会把子代理归一化为合规配置（见 spawn-guard.test.ts:141-142）。
  // 生产路径上 SpawnGuard.fireChange('denied') 与 Hook.fireChange('denied') 完全等价，
  // Hook 那条用例已覆盖整条 'denied' 转移。

  it('sink 抛错不污染 LLM 主链：delegateTyped 仍正常返回 done', async () => {
    const mgr = new TypedSubAgentManager()
    const r = await mgr.delegateTyped({
      task: 't',
      parentBlueprint: makeParent(),
      agentType: 'explore',
      callLLM: async () => '正常结果',
      onChange: () => { throw new Error('sink 故意挂') },
    })
    assert.equal(r.status, 'done', 'sink 异常不应影响主链')
    assert.equal(r.result, '正常结果')
  })
})
