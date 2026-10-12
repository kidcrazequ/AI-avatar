/**
 * SubAgentManager — expected_output schema 单测（v18 CrewAI 借鉴）
 *
 * 覆盖：
 *   - delegate 不传 options：行为不变，userPrompt 不含输出约束段
 *   - delegate 传 expectedOutput：userPrompt 末尾注入【输出格式约束】段
 *   - 空 / 纯空白 expectedOutput：视为不传，不注入
 *   - SubAgentTask 状态对象上 expectedOutput 透传
 *   - systemPrompt 不被改（cache 友好）
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SubAgentManager } from '../sub-agent-manager'

/**
 * 捕获 callLLM 的 system + user 参数 + 控制 resolve 时机的辅助 stub。
 */
function makeCapturingLLM(response: string = 'OK') {
  const calls: Array<{ system: string; user: string; maxTokens?: number }> = []
  const fn = async (system: string, user: string, maxTokens?: number): Promise<string> => {
    calls.push({ system, user, maxTokens })
    return response
  }
  return { fn, calls }
}

describe('SubAgentManager — expected_output', () => {
  it('不传 options：userPrompt 不含【输出格式约束】段', async () => {
    const mgr = new SubAgentManager()
    const { fn, calls } = makeCapturingLLM()
    const t = await mgr.delegate('做加法 1+1', 'sys', fn)
    await mgr.waitForTask(t.id, 5000)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].user.includes('【输出格式约束'), false)
    assert.equal(calls[0].user.includes('expected_output'), false)
    assert.ok(calls[0].user.includes('做加法 1+1'))
  })

  it('传 expectedOutput：userPrompt 末尾注入约束段', async () => {
    const mgr = new SubAgentManager()
    const { fn, calls } = makeCapturingLLM()
    const t = await mgr.delegate('给方案打分', 'sys', fn, undefined, {
      expectedOutput: 'JSON 数组每项含 name, score, reason',
    })
    await mgr.waitForTask(t.id, 5000)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].user.includes('【输出格式约束'))
    assert.ok(calls[0].user.includes('JSON 数组每项含 name, score, reason'))
    // 约束在 task 之后
    const taskIdx = calls[0].user.indexOf('给方案打分')
    const directiveIdx = calls[0].user.indexOf('【输出格式约束')
    assert.ok(taskIdx >= 0 && directiveIdx > taskIdx, '约束段应在任务描述之后')
  })

  it('空字符串 expectedOutput 视为不传，不注入', async () => {
    const mgr = new SubAgentManager()
    const { fn, calls } = makeCapturingLLM()
    const t = await mgr.delegate('做事', 'sys', fn, undefined, { expectedOutput: '' })
    await mgr.waitForTask(t.id, 5000)
    assert.equal(calls[0].user.includes('【输出格式约束'), false)
  })

  it('纯空白 expectedOutput 视为不传', async () => {
    const mgr = new SubAgentManager()
    const { fn, calls } = makeCapturingLLM()
    const t = await mgr.delegate('做事', 'sys', fn, undefined, { expectedOutput: '   \n\t  ' })
    await mgr.waitForTask(t.id, 5000)
    assert.equal(calls[0].user.includes('【输出格式约束'), false)
  })

  it('SubAgentTask 上 expectedOutput 透传可查（任务跟踪需要）', async () => {
    const mgr = new SubAgentManager()
    const { fn } = makeCapturingLLM()
    const t = await mgr.delegate('做事', 'sys', fn, undefined, {
      expectedOutput: 'Markdown 表格 a/b',
    })
    const fetched = mgr.getTask(t.id)
    assert.ok(fetched)
    assert.equal(fetched.expectedOutput, 'Markdown 表格 a/b')
  })

  it('不传 options 时 SubAgentTask 上无 expectedOutput 字段（不污染序列化）', async () => {
    const mgr = new SubAgentManager()
    const { fn } = makeCapturingLLM()
    const t = await mgr.delegate('做事', 'sys', fn)
    const fetched = mgr.getTask(t.id)
    assert.ok(fetched)
    assert.equal('expectedOutput' in fetched, false)
  })

  it('systemPrompt 不被 expectedOutput 改写（保 cache 命中）', async () => {
    const mgr = new SubAgentManager()
    const { fn, calls } = makeCapturingLLM()
    const t = await mgr.delegate('做事', 'STABLE_SYSTEM_PROMPT', fn, undefined, {
      expectedOutput: 'JSON',
    })
    await mgr.waitForTask(t.id, 5000)
    assert.equal(calls[0].system, 'STABLE_SYSTEM_PROMPT')
  })

  it('expectedOutput 前后被 trim', async () => {
    const mgr = new SubAgentManager()
    const { fn, calls } = makeCapturingLLM()
    const t = await mgr.delegate('做事', 'sys', fn, undefined, {
      expectedOutput: '  Markdown 表格  \n',
    })
    await mgr.waitForTask(t.id, 5000)
    // 注入的内容 trim 后的版本
    assert.ok(calls[0].user.includes('Markdown 表格'))
    assert.equal(calls[0].user.includes('\n  Markdown 表格  \n'), false)
  })
})
