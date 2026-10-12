/**
 * SubAgentManager.delegate(..., onChange) 单测（v15 引入）。
 *
 * 覆盖：
 *   1. onChange 在 running 时刻被同步触发一次（delegate 返回前）
 *   2. LLM 成功后 onChange 再触发一次，task.status === 'done'
 *   3. LLM 失败时 onChange 触发，task.status === 'error'
 *   4. onChange 抛错不污染 LLM 主链——delegate 仍然返回 task，结果仍可 waitForTask
 *
 * 不覆盖：'lost' 状态（由 desktop-app/database.markOrphanRunningAsLost 写入，
 * SubAgentManager 不会自己产生 'lost'）。
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { SubAgentManager, type SubAgentTask } from '../sub-agent-manager'

test('onChange 在 running 时同步触发一次（delegate 返回前）', async () => {
  const mgr = new SubAgentManager()
  try {
    const events: SubAgentTask[] = []
    const llm = async () => 'ok'
    const handle = await mgr.delegate('x', 'sys', llm, (t) => events.push({ ...t }))
    // delegate 返回时至少应有 running 这一次（done 是异步触发的）
    assert.ok(events.length >= 1, 'running 事件应已触发')
    assert.equal(events[0].status, 'running')
    assert.equal(events[0].id, handle.id)
  } finally {
    mgr.destroy()
  }
})

test('onChange 在 done 时再次触发，task.status === done 且 result 已填充', async () => {
  const mgr = new SubAgentManager()
  try {
    const events: SubAgentTask[] = []
    const llm = async () => '子任务返回值'
    const handle = await mgr.delegate('x', 'sys', llm, (t) => events.push({ ...t }))
    const final = await mgr.waitForTask(handle.id, 2000)
    assert.equal(final?.status, 'done')
    assert.equal(final?.result, '子任务返回值')
    // running + done 至少两次
    const done = events.filter((e) => e.status === 'done')
    assert.equal(done.length, 1, 'done 事件应触发一次')
    assert.equal(done[0].result, '子任务返回值')
  } finally {
    mgr.destroy()
  }
})

test('onChange 在 error 时触发，task.status === error 且 error 已填充', async () => {
  const mgr = new SubAgentManager()
  try {
    const events: SubAgentTask[] = []
    const llm = async () => { throw new Error('LLM 模拟失败') }
    const handle = await mgr.delegate('x', 'sys', llm, (t) => events.push({ ...t }))
    const final = await mgr.waitForTask(handle.id, 2000)
    assert.equal(final?.status, 'error')
    assert.match(final?.error ?? '', /LLM 模拟失败/)
    const errs = events.filter((e) => e.status === 'error')
    assert.equal(errs.length, 1)
    assert.match(errs[0].error ?? '', /LLM 模拟失败/)
  } finally {
    mgr.destroy()
  }
})

test('onChange 抛错不影响 LLM 主链——delegate/waitForTask 仍正常返回', async () => {
  const mgr = new SubAgentManager()
  try {
    const llm = async () => '正常结果'
    // sink 总是抛错
    const handle = await mgr.delegate('x', 'sys', llm, () => { throw new Error('sink 故意挂') })
    assert.equal(handle.status, 'running', 'delegate 应正常返回 running handle，不被 sink 异常打断')
    const final = await mgr.waitForTask(handle.id, 2000)
    assert.equal(final?.status, 'done', 'LLM 主链应当照常完成')
    assert.equal(final?.result, '正常结果')
  } finally {
    mgr.destroy()
  }
})
