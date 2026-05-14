import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { runSuite, JsonlEvaluationStore, type EvalCase } from '../agent-runtime'

describe('Phase 7 — runSuite', () => {
  it('全部通过', async () => {
    const cases: EvalCase[] = [
      {
        id: 'c1',
        kind: 'unit',
        title: 't1',
        run: async () => ({ caseId: 'c1', pass: true, durationMs: 1 }),
      },
      {
        id: 'c2',
        kind: 'unit',
        title: 't2',
        run: async () => ({ caseId: 'c2', pass: true, durationMs: 1 }),
      },
    ]
    const r = await runSuite(cases)
    assert.equal(r.passCount, 2)
    assert.equal(r.failCount, 0)
  })

  it('异常 case 被捕获标记失败', async () => {
    const cases: EvalCase[] = [
      {
        id: 'bad',
        kind: 'unit',
        title: 't',
        run: async () => {
          throw new Error('boom')
        },
      },
    ]
    const r = await runSuite(cases)
    assert.equal(r.failCount, 1)
    assert.match(r.cases[0].reason ?? '', /boom/)
  })

  it('bailOnFail：第一次失败立即停止', async () => {
    let bRan = false
    const cases: EvalCase[] = [
      {
        id: 'a',
        kind: 'unit',
        title: 't',
        run: async () => ({ caseId: 'a', pass: false, durationMs: 1 }),
      },
      {
        id: 'b',
        kind: 'unit',
        title: 't',
        run: async () => {
          bRan = true
          return { caseId: 'b', pass: true, durationMs: 1 }
        },
      },
    ]
    await runSuite(cases, { bailOnFail: true })
    assert.equal(bRan, false)
  })

  it('case 超时被记为失败', async () => {
    const cases: EvalCase[] = [
      {
        id: 'slow',
        kind: 'unit',
        title: 't',
        run: () => new Promise(() => {}), // 永不 resolve
      },
    ]
    const r = await runSuite(cases, { caseTimeoutMs: 50 })
    assert.equal(r.failCount, 1)
    assert.match(r.cases[0].reason ?? '', /超时/)
  })
})

describe('Phase 7 — JsonlEvaluationStore', () => {
  it('录入 + 读取最近 N 条', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-store-'))
    const store = new JsonlEvaluationStore({ baseDir: dir })
    for (let i = 0; i < 5; i++) {
      await store.recordSuite('regression', {
        startedAt: i,
        finishedAt: i + 1,
        cases: [],
        passCount: i,
        failCount: 0,
      })
    }
    const recent = await store.loadRecent('regression', 3)
    assert.equal(recent.length, 3)
    assert.equal(recent[recent.length - 1].passCount, 4)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
