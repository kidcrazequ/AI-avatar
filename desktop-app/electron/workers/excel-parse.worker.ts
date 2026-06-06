/**
 * Excel 解析 worker_threads 入口（#16）。
 *
 * 大 .xlsx 的 XLSX.readFile + sheet_to_json 是同步 CPU 密集操作，放在主进程会冻结
 * 事件循环（UI 卡死、IPC 全堵），且 PARSE_TIMEOUT_MS 的 Promise.race 因事件循环
 * 被锁死而永远触发不了。搬到本 worker 线程后，主进程可用 worker.terminate() 强杀
 * 卡死的同步解析，让超时真正生效。
 *
 * 协议：主进程 `new Worker(excel-parse-worker.cjs, { workerData: { filePath, fileName } })`，
 * worker 回 postMessage：成功 `{ ok: true, result: ParsedDocument }`，失败 `{ ok: false, error }`。
 * 由 build-electron.js 单独打成 dist-electron/excel-parse-worker.cjs（xlsx 纯 JS 一并 bundle）。
 */
import { parentPort, workerData } from 'node:worker_threads'

import { parseExcelCore } from '../excel/excel-parse-core'

export interface ExcelWorkerInput {
  filePath: string
  fileName: string
}

function run(): void {
  if (!parentPort) return
  const input = (workerData ?? {}) as Partial<ExcelWorkerInput>
  if (typeof input.filePath !== 'string' || typeof input.fileName !== 'string') {
    parentPort.postMessage({ ok: false, error: 'excel worker: 缺少 filePath / fileName' })
    return
  }
  try {
    const result = parseExcelCore(input.filePath, input.fileName)
    parentPort.postMessage({ ok: true, result })
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

run()
