/**
 * excel-parse worker 契约测试（#16 子任务 2/3）。
 *
 * 直接 spawn 构建产物 dist-electron/excel-parse-worker.cjs，验证：
 *   - worker 线程能跑起 bundled 的 parseExcelCore（含一并打包的 xlsx），回传正确结果
 *   - 解析出错时回 { ok: false, error }，不让 worker 崩溃
 *   - worker.terminate() 能正常停掉 worker（超时强杀机制的基元）
 *
 * 产物未构建时整组跳过（先 `npm run build` 或 `node build-electron.js`）。
 * 运行：NODE_PATH=./test-support/node_modules npx tsx --test electron/workers/excel-parse.worker.test.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Worker } from 'node:worker_threads'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require('xlsx')

const WORKER_CJS = path.join(__dirname, '..', '..', 'dist-electron', 'excel-parse-worker.cjs')
const skip = fs.existsSync(WORKER_CJS) ? false : 'dist-electron/excel-parse-worker.cjs 未构建（先 npm run build）'

interface WorkerMsg { ok: boolean; result?: { fileType?: string; structuredData?: { sheets: Array<{ columns: unknown[]; rowCount: number }> } }; error?: string }

/** 起一个 worker，拿到首条 message（或 error/exit）后 resolve。 */
function runWorker(workerData: { filePath: string; fileName: string }): Promise<WorkerMsg> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_CJS, { workerData })
    worker.once('message', (msg: WorkerMsg) => { void worker.terminate(); resolve(msg) })
    worker.once('error', (err) => { void worker.terminate(); reject(err) })
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exit ${code}`)) })
  })
}

function writeXlsx(rows: unknown[][]): { filePath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-worker-test-'))
  const filePath = path.join(dir, 'fixture.xlsx')
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1')
  XLSX.writeFile(wb, filePath)
  return { filePath, dir }
}

test('excel worker: 正常 .xlsx → { ok: true, result }（bundled xlsx 在 worker 线程可用）', { skip }, async () => {
  const { filePath, dir } = writeXlsx([
    ['产品', '数量'],
    ['电池', 10],
    ['逆变器', 5],
  ])
  try {
    const msg = await runWorker({ filePath, fileName: 'fixture.xlsx' })
    assert.equal(msg.ok, true)
    assert.equal(msg.result?.fileType, 'excel')
    assert.equal(msg.result?.structuredData?.sheets[0]?.columns.length, 2)
    assert.equal(msg.result?.structuredData?.sheets[0]?.rowCount, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('excel worker: 文件不存在 → { ok: false, error }（worker 不崩）', { skip }, async () => {
  const msg = await runWorker({ filePath: '/nonexistent/nope.xlsx', fileName: 'nope.xlsx' })
  assert.equal(msg.ok, false)
  assert.ok(typeof msg.error === 'string' && msg.error.length > 0)
})

// 注：terminate-on-timeout 不在此单测——worker.terminate() 是 Node 原语，parseExcel 超时路径
// 已在 finish() 里无条件调用它；要真实触发 5min 超时强杀需超大文件，留打包版手动验证。
