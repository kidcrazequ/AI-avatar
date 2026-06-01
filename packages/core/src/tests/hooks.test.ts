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
  makeSourceAnchorEnforcementHook,
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

describe('source-anchor enforcement hook', () => {
  const EXCEL_WITH_ANCHOR = {
    source_anchor: '[来源: knowledge/_excel/sales.json#sheet=Sheet1]',
    rows: [['型号', '循环次数']],
  }
  const EXCEL_NO_ANCHOR = { sheet: 'Sheet1', rows: [['型号', '循环次数']] }
  const KNOWLEDGE_WITH_ANCHOR = '净能量约 100kWh。[来源: knowledge/spec/cell.md#L10-L12]'
  const KNOWLEDGE_NO_ANCHOR = '净能量约 100kWh。（凭记忆，未标来源）'

  function firePost(
    hook: { handler: Parameters<HookRegistry['register']>[1] },
    toolName: string,
    result: unknown,
    error?: string,
  ) {
    const reg = new HookRegistry()
    reg.register(HookPoint.POST_TOOL_USE, hook.handler)
    return reg.fire({
      point: HookPoint.POST_TOOL_USE,
      timestamp: 1,
      toolName,
      args: {},
      result,
      durationMs: 1,
      error,
    })
  }

  it('query_excel 带 source_anchor：不告警', async () => {
    const hook = makeSourceAnchorEnforcementHook()
    await firePost(hook, 'query_excel', EXCEL_WITH_ANCHOR)
    assert.deepEqual(hook.warnings(), [])
  })

  it('query_excel 缺 source_anchor：软告警且不 deny', async () => {
    const hook = makeSourceAnchorEnforcementHook()
    const r = await firePost(hook, 'query_excel', EXCEL_NO_ANCHOR)
    assert.equal(r.deny, undefined)
    assert.equal(hook.warnings().length, 1)
    assert.match(hook.warnings()[0].reason, /来源/)
    assert.equal(hook.warnings()[0].toolName, 'query_excel')
  })

  it('search_knowledge 正文内联 [来源: ...]：不告警', async () => {
    const hook = makeSourceAnchorEnforcementHook()
    await firePost(hook, 'search_knowledge', { content: KNOWLEDGE_WITH_ANCHOR })
    assert.deepEqual(hook.warnings(), [])
  })

  it('search_knowledge 无锚点：告警（字符串结果同样识别）', async () => {
    const hook = makeSourceAnchorEnforcementHook()
    await firePost(hook, 'search_knowledge', KNOWLEDGE_NO_ANCHOR)
    assert.equal(hook.warnings().length, 1)
  })

  it('非取数工具（read_file）即便无锚点也不告警', async () => {
    const hook = makeSourceAnchorEnforcementHook()
    await firePost(hook, 'read_file', { content: '一些代码' })
    assert.deepEqual(hook.warnings(), [])
  })

  it('取数工具自身报错时不叠加来源告警（交给 circuit-breaker）', async () => {
    const hook = makeSourceAnchorEnforcementHook()
    await firePost(hook, 'query_excel', undefined, 'sheet not found')
    assert.deepEqual(hook.warnings(), [])
  })

  it('warnings 环形截断：长会话不无界增长（保留最近 200 条）', async () => {
    const hook = makeSourceAnchorEnforcementHook()
    for (let i = 0; i < 250; i++) {
      await firePost(hook, 'query_excel', { rows: [['x', i]] }) // 每条都缺锚点 → 告警
    }
    assert.equal(hook.warnings().length, 200, '应被截断到 200 条，而非 250')
  })

  it('onWarning 回调被触发，reset() 清空', async () => {
    const seen: string[] = []
    const hook = makeSourceAnchorEnforcementHook({ onWarning: (w) => seen.push(w.toolName) })
    await firePost(hook, 'query_excel', EXCEL_NO_ANCHOR)
    assert.deepEqual(seen, ['query_excel'])
    hook.reset()
    assert.deepEqual(hook.warnings(), [])
  })

  it('端到端：经 runInstrumentedToolCall 软告警，结果照常回流（ok=true）', async () => {
    const reg = new HookRegistry()
    const hook = makeSourceAnchorEnforcementHook()
    reg.register(HookPoint.POST_TOOL_USE, hook.handler)

    const r = await runInstrumentedToolCall({
      toolName: 'query_excel',
      args: { file: 'sales.xlsx' },
      execute: async () => EXCEL_NO_ANCHOR, // 工具忘了带锚点
      hooks: reg,
    })

    assert.equal(r.ok, true) // 软警告不阻断
    assert.deepEqual(r.result, EXCEL_NO_ANCHOR)
    assert.equal(hook.warnings().length, 1)
  })
})
