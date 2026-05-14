/**
 * Phase 2 验证：Hook 总线、内置 Hook、Instrumented tool call、AuditTrail
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  HookPoint,
  HookRegistry,
  AuditTrail,
  makeReadBeforeEditHook,
  makeCircuitBreakerHook,
  runInstrumentedToolCall,
} from '../agent-runtime'

describe('Phase 2 — Hook Registry', () => {
  it('按注册顺序串行执行', async () => {
    const reg = new HookRegistry()
    const order: string[] = []
    reg.register(HookPoint.PRE_TOOL_USE, async () => {
      order.push('a')
    })
    reg.register(HookPoint.PRE_TOOL_USE, async () => {
      order.push('b')
    })
    await reg.fire({ point: HookPoint.PRE_TOOL_USE, timestamp: Date.now(), toolName: 'x', args: {} })
    assert.deepEqual(order, ['a', 'b'])
  })

  it('任一 Hook 返回 deny 立即短路', async () => {
    const reg = new HookRegistry()
    let bCalled = false
    reg.register(HookPoint.PRE_TOOL_USE, async () => ({ deny: true, reason: 'no' }))
    reg.register(HookPoint.PRE_TOOL_USE, async () => {
      bCalled = true
    })
    const r = await reg.fire({
      point: HookPoint.PRE_TOOL_USE,
      timestamp: Date.now(),
      toolName: 'x',
      args: {},
    })
    assert.equal(r.deny, true)
    assert.equal(bCalled, false)
  })

  it('Hook 抛异常不会中断主流程', async () => {
    const reg = new HookRegistry()
    const errors: unknown[] = []
    reg.setOnHandlerError((err) => errors.push(err))
    reg.register(HookPoint.PRE_TOOL_USE, async () => {
      throw new Error('boom')
    })
    let bCalled = false
    reg.register(HookPoint.PRE_TOOL_USE, async () => {
      bCalled = true
    })
    await reg.fire({ point: HookPoint.PRE_TOOL_USE, timestamp: Date.now(), toolName: 'x', args: {} })
    assert.equal(bCalled, true)
    assert.equal(errors.length, 1)
  })

  it('rewriteArgs 仅在 PRE_TOOL_USE 生效，后注册者覆盖前者', async () => {
    const reg = new HookRegistry()
    reg.register(HookPoint.PRE_TOOL_USE, async () => ({ rewriteArgs: { x: 1 } }))
    reg.register(HookPoint.PRE_TOOL_USE, async () => ({ rewriteArgs: { x: 2, y: 3 } }))
    const r = await reg.fire({
      point: HookPoint.PRE_TOOL_USE,
      timestamp: Date.now(),
      toolName: 'x',
      args: {},
    })
    assert.deepEqual(r.rewriteArgs, { x: 2, y: 3 })
  })
})

describe('Phase 2 — read-before-edit hook', () => {
  it('未读过的文件不允许写入', async () => {
    const reg = new HookRegistry()
    const { handler } = makeReadBeforeEditHook()
    reg.register(HookPoint.PRE_TOOL_USE, handler)
    reg.register(HookPoint.POST_TOOL_USE, handler)

    const r = await reg.fire({
      point: HookPoint.PRE_TOOL_USE,
      timestamp: Date.now(),
      toolName: 'edit_file',
      args: { file_path: '/foo/bar.ts' },
    })
    assert.equal(r.deny, true)
    assert.match(r.reason ?? '', /read-before-edit/)
  })

  it('read 成功后允许 edit', async () => {
    const reg = new HookRegistry()
    const { handler } = makeReadBeforeEditHook()
    reg.register(HookPoint.PRE_TOOL_USE, handler)
    reg.register(HookPoint.POST_TOOL_USE, handler)

    await reg.fire({
      point: HookPoint.POST_TOOL_USE,
      timestamp: Date.now(),
      toolName: 'read_file',
      args: { file_path: '/foo/bar.ts' },
      result: 'content',
      durationMs: 1,
    })
    const r = await reg.fire({
      point: HookPoint.PRE_TOOL_USE,
      timestamp: Date.now(),
      toolName: 'edit_file',
      args: { file_path: '/foo/bar.ts' },
    })
    assert.notEqual(r.deny, true)
  })
})

describe('Phase 2 — circuit-breaker hook', () => {
  it('连续 3 次同工具失败后熔断', async () => {
    const reg = new HookRegistry()
    const { handler } = makeCircuitBreakerHook(3)
    reg.register(HookPoint.PRE_TOOL_USE, handler)
    reg.register(HookPoint.POST_TOOL_USE, handler)

    for (let i = 0; i < 3; i++) {
      await reg.fire({
        point: HookPoint.POST_TOOL_USE,
        timestamp: Date.now(),
        toolName: 'query_excel',
        args: {},
        result: undefined,
        durationMs: 1,
        error: 'boom',
      })
    }
    const r = await reg.fire({
      point: HookPoint.PRE_TOOL_USE,
      timestamp: Date.now(),
      toolName: 'query_excel',
      args: {},
    })
    assert.equal(r.deny, true)
    assert.match(r.reason ?? '', /circuit-breaker/)
  })

  it('一次成功立即重置计数', async () => {
    const reg = new HookRegistry()
    const { handler } = makeCircuitBreakerHook(3)
    reg.register(HookPoint.PRE_TOOL_USE, handler)
    reg.register(HookPoint.POST_TOOL_USE, handler)

    for (let i = 0; i < 2; i++) {
      await reg.fire({
        point: HookPoint.POST_TOOL_USE,
        timestamp: Date.now(),
        toolName: 't',
        args: {},
        result: undefined,
        durationMs: 1,
        error: 'boom',
      })
    }
    await reg.fire({
      point: HookPoint.POST_TOOL_USE,
      timestamp: Date.now(),
      toolName: 't',
      args: {},
      result: 'ok',
      durationMs: 1,
    })
    // 再来 2 次失败不应该触发熔断（计数已重置）
    for (let i = 0; i < 2; i++) {
      await reg.fire({
        point: HookPoint.POST_TOOL_USE,
        timestamp: Date.now(),
        toolName: 't',
        args: {},
        result: undefined,
        durationMs: 1,
        error: 'boom',
      })
    }
    const r = await reg.fire({
      point: HookPoint.PRE_TOOL_USE,
      timestamp: Date.now(),
      toolName: 't',
      args: {},
    })
    assert.notEqual(r.deny, true)
  })
})

describe('Phase 2 — runInstrumentedToolCall', () => {
  it('正常执行：触发前后 Hook、记录 audit', async () => {
    const reg = new HookRegistry()
    const fires: string[] = []
    reg.register(HookPoint.PRE_TOOL_USE, async () => {
      fires.push('pre')
    })
    reg.register(HookPoint.POST_TOOL_USE, async () => {
      fires.push('post')
    })

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'))
    const audit = new AuditTrail({ auditDir: tmpDir })

    const r = await runInstrumentedToolCall({
      toolName: 'echo',
      args: { msg: 'hi' },
      execute: async (a) => `out:${JSON.stringify(a)}`,
      hooks: reg,
      audit,
    })

    await audit.flush()
    assert.equal(r.ok, true)
    assert.equal(r.result, 'out:{"msg":"hi"}')
    assert.deepEqual(fires, ['pre', 'post'])

    const files = fs.readdirSync(tmpDir)
    assert.ok(files.some((f) => f.endsWith('.jsonl')))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('Hook 拒绝时不执行真实工具', async () => {
    const reg = new HookRegistry()
    reg.register(HookPoint.PRE_TOOL_USE, async () => ({ deny: true, reason: 'nope' }))
    let executed = false
    const r = await runInstrumentedToolCall({
      toolName: 'edit_file',
      args: { file_path: '/x' },
      execute: async () => {
        executed = true
        return 'ok'
      },
      hooks: reg,
    })
    assert.equal(r.denied, true)
    assert.equal(executed, false)
    assert.match(r.denyReason ?? '', /nope/)
  })

  it('rewriteArgs 改写工具入参', async () => {
    const reg = new HookRegistry()
    reg.register(HookPoint.PRE_TOOL_USE, async () => ({ rewriteArgs: { x: 99 } }))
    let receivedArgs: Record<string, unknown> | undefined
    await runInstrumentedToolCall({
      toolName: 'echo',
      args: { x: 1 },
      execute: async (a) => {
        receivedArgs = a
        return 'ok'
      },
      hooks: reg,
    })
    assert.deepEqual(receivedArgs, { x: 99 })
  })

  it('工具抛错时仍 fire POST + audit + 返回 error', async () => {
    const reg = new HookRegistry()
    let postFired = false
    reg.register(HookPoint.POST_TOOL_USE, async (p) => {
      postFired = true
      const post = p as { error?: string }
      assert.match(post.error ?? '', /boom/)
    })
    const r = await runInstrumentedToolCall({
      toolName: 't',
      args: {},
      execute: async () => {
        throw new Error('boom')
      },
      hooks: reg,
    })
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /boom/)
    assert.equal(postFired, true)
  })
})
