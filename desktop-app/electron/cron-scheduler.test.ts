/**
 * cron-scheduler.ts 扩展单测（#11 Scheduled Tasks · 子任务 2）。
 *
 * 验证点：
 *   1. scheduleCron 注册后 getRunningCronTaskIds 包含该 taskId
 *   2. 同名 taskId 二次注册：先 cancel 再注册（覆盖语义）
 *   3. cancelCron 后 hasCronTask 为 false
 *   4. cancelAll 同时清理 cronJobs
 *   5. getNextRuns 用 fromTs 注入固定时间，对常见 cron 表达式给出预期触发时刻
 *   6. cron 表达式非法（如 'invalid'）：scheduleCron 抛 Error
 *
 * 设计：computeMsUntilNext 已有的逻辑不变，本文件只覆盖 #11 新增方法。
 * 不模拟时间流逝（不实际等到 cron 触发），避免引入时序不稳测试。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 注入 electron stub（cron-scheduler 顶部 import { BrowserWindow } from 'electron'）
const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-cron-test-userdata-'))
const electronStubExports = {
  app: { getPath: (_key: string) => TMP_USER_DATA },
  BrowserWindow: class FakeBrowserWindow {},
  shell: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
}
const electronResolvedId = (() => {
  try {
    return require.resolve('electron')
  } catch {
    return 'electron'
  }
})()
require.cache[electronResolvedId] = {
  id: electronResolvedId,
  filename: electronResolvedId,
  loaded: true,
  exports: electronStubExports,
  parent: null,
  children: [],
  paths: [],
} as unknown as NodeJS.Module

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CronScheduler, computeMsUntilNext } = require('./cron-scheduler') as typeof import('./cron-scheduler')

test('cron-scheduler: scheduleCron 注册后 getRunningCronTaskIds 含该 taskId', () => {
  const sched = new CronScheduler()
  let calls = 0
  sched.scheduleCron('t1', '*/1 * * * *', 'UTC', () => {
    calls++
  })
  assert.deepEqual(sched.getRunningCronTaskIds(), ['t1'])
  assert.equal(sched.hasCronTask('t1'), true)
  // 不等到实际触发，calls 维持 0
  assert.equal(calls, 0)
  sched.cancelAll()
})

test('cron-scheduler: 同名 taskId 二次注册覆盖（不会重复）', () => {
  const sched = new CronScheduler()
  sched.scheduleCron('t1', '0 9 * * *', 'UTC', () => undefined)
  sched.scheduleCron('t1', '0 10 * * *', 'UTC', () => undefined)
  assert.deepEqual(sched.getRunningCronTaskIds(), ['t1'])
  sched.cancelAll()
})

test('cron-scheduler: cancelCron 后 hasCronTask 为 false', () => {
  const sched = new CronScheduler()
  sched.scheduleCron('t1', '*/5 * * * *', 'UTC', () => undefined)
  sched.cancelCron('t1')
  assert.equal(sched.hasCronTask('t1'), false)
  // 取消不存在的任务静默
  sched.cancelCron('not-exist')
})

test('cron-scheduler: cancelAll 同时清理 cron jobs', () => {
  const sched = new CronScheduler()
  sched.scheduleCron('a', '*/5 * * * *', 'UTC', () => undefined)
  sched.scheduleCron('b', '*/10 * * * *', 'UTC', () => undefined)
  assert.equal(sched.getRunningCronTaskIds().length, 2)
  sched.cancelAll()
  assert.equal(sched.getRunningCronTaskIds().length, 0)
})

test('cron-scheduler: getNextRuns 注入固定 fromTs 给出预期触发时刻', () => {
  const sched = new CronScheduler()
  // 2026-01-01 00:00:00 UTC = 1767225600000
  const fromTs = Date.UTC(2026, 0, 1, 0, 0, 0, 0)
  // 每天 0:00 UTC：从 00:00:00 开始算下一次应该是次日 00:00:00（同时刻 + 1ms 后第一个匹配）
  const next3 = sched.getNextRuns('0 0 * * *', 'UTC', 3, fromTs)
  assert.equal(next3.length, 3)
  // 第一次触发应在 fromTs + 1 天
  assert.equal(next3[0], fromTs + 86400_000)
  assert.equal(next3[1], fromTs + 86400_000 * 2)
  assert.equal(next3[2], fromTs + 86400_000 * 3)
  sched.cancelAll()
})

test('cron-scheduler: getNextRuns n=0 返回空数组', () => {
  const sched = new CronScheduler()
  assert.deepEqual(sched.getNextRuns('* * * * *', 'UTC', 0), [])
  sched.cancelAll()
})

test('cron-scheduler: 非法 cron 表达式 scheduleCron 抛 Error', () => {
  const sched = new CronScheduler()
  assert.throws(() => {
    sched.scheduleCron('bad', 'not a cron', 'UTC', () => undefined)
  })
  // 注册失败后 cronJobs 不应留下 'bad' 项
  assert.equal(sched.hasCronTask('bad'), false)
  sched.cancelAll()
})

test('cron-scheduler: scheduleCron 空 taskId / 空 cronExpr 抛 Error', () => {
  const sched = new CronScheduler()
  assert.throws(() => sched.scheduleCron('', '* * * * *', 'UTC', () => undefined))
  assert.throws(() => sched.scheduleCron('t', '', 'UTC', () => undefined))
  sched.cancelAll()
})

test('cron-scheduler: computeMsUntilNext 既有用例不退化', () => {
  // 现有用例：从 09:00 开始算下一个 09:00 → 24h
  const now = new Date(2026, 0, 1, 9, 0, 0, 0)
  assert.equal(computeMsUntilNext(9, 0, now), 86400_000)
})
