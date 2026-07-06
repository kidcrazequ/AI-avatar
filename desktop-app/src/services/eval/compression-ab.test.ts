/**
 * compression-ab.test.ts — A3-6 压缩开/关对照评测
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test src/services/eval/compression-ab.test.ts
 *
 * 意图（Rule 9）：
 *   1. 默认对照集在压缩开 / 关下都全绿 → 压缩不丢承重数字与来源引用（默认开的质量证据）
 *   2. 压缩确实发生（开侧输出更短），对照不是空转
 *   3. scorer 能抓到丢失：非承重的中段数字在压缩开时丢失 → fail。
 *      这条"必须能红"的用例证明 scorer 有判别力，也标定了"承重"的边界。
 */

import { test } from 'node:test'
import assert from 'node:assert'
import {
  runCompressionAbEval,
  buildCompressionAbTasks,
  defaultCompressionAbSamples,
  type CompressionAbInput,
  type CompressionAbTarget,
} from './compression-ab'
import { runEval } from './task'
import type { Sample } from './types'

test('默认对照集：压缩开 / 关都全绿（承重数字 + 来源锚点逐字保留）', async () => {
  const { on, off } = await runCompressionAbEval()
  assert.strictEqual(off.summary.total, defaultCompressionAbSamples.length)
  assert.strictEqual(off.summary.passed, off.summary.total, '压缩关侧必须全绿（对照基线）')
  assert.strictEqual(on.summary.passed, on.summary.total, '压缩开侧必须全绿（压缩不丢承重信息）')
  assert.strictEqual(on.summary.errored, 0)
})

test('压缩确实发生：开侧每条输出都短于关侧，且带 CCR marker', async () => {
  const { on, off } = await runCompressionAbEval()
  for (let i = 0; i < on.samples.length; i++) {
    const onText = on.samples[i].output.text
    const offText = off.samples[i].output.text
    assert.ok(onText.length < offText.length, `样本 ${on.samples[i].sampleId} 未被压缩`)
    assert.ok(onText.startsWith('[已压缩 '), `样本 ${on.samples[i].sampleId} 缺少 CCR marker`)
  }
})

test('scorer 判别力：非承重中段数字被压掉时，开侧 fail、关侧 pass', async () => {
  // 中段普通行的数字（非错误/非罕见/非 query 命中/非首尾）不是承重数字，
  // 声明成 mustKeepNumbers 后压缩开必须能红——证明 scorer 不是摆设
  const rows: Array<Record<string, unknown>> = []
  for (let i = 1; i <= 40; i++) {
    const row: Record<string, unknown> = { 序号: i, 组: '常规', 数值: Number((70 + i * 0.11).toFixed(2)), 标记: `M-${i}` }
    if (i === 3) row.备注 = '首检' // 非均匀键集 → 走 stats 而非 CSV 无损路径
    rows.push(row)
  }
  const midOnlyNumber = String(rows[19].数值) // 序号 20：注定被聚合的中段行
  const dataset: Sample<CompressionAbInput, CompressionAbTarget>[] = [
    {
      id: 'negative-control',
      input: { toolResult: JSON.stringify(rows) },
      target: { mustKeepNumbers: [midOnlyNumber] },
    },
  ]
  const tasks = buildCompressionAbTasks(dataset, { maxChars: 800 })
  const off = await runEval(tasks.off)
  const on = await runEval(tasks.on)
  assert.strictEqual(off.summary.passed, 1, '压缩关侧应 pass（原文里数字都在）')
  assert.strictEqual(on.summary.passed, 0, '压缩开侧应 fail（中段数字非承重，被聚合）')
  assert.strictEqual(on.samples[0].scores['load-bearing-numbers'].passed, false)
})
