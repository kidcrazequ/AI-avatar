#!/usr/bin/env node
/**
 * #16 手动验证脚本：Excel 解析不再冻结主进程 + 超时可 terminate 强杀。
 *
 * 前置：先 `npm run build`（产出 dist-electron/excel-parse-worker.cjs）。
 *
 * 用法：
 *   node scripts/verify-excel-worker.cjs                       # 默认 worker 模式
 *   node scripts/verify-excel-worker.cjs --rows 300000 --cols 30
 *   node scripts/verify-excel-worker.cjs --timeout-ms 2000     # 验证超时 terminate（无需等 5min）
 *   node scripts/verify-excel-worker.cjs --inline              # 对照：主线程内联解析（会冻结心跳）
 *
 * 原理：解析期间主线程跑 100ms 心跳，统计最大心跳间隔。
 *   - worker 模式：重活在 worker 线程，主线程心跳应 ≈100ms（不卡）→ 证明 #16 修复生效
 *   - --inline 模式：重活在主线程，心跳会停滞整个解析时长 → 复现修复前的冻结
 *   - --timeout-ms：到点 worker.terminate() 强杀（被锁死的同步解析也能被杀，主线程内联做不到）
 *
 * 注意：本脚本直接跑 dist-electron 内的 worker.cjs（非 asar）。
 *   asar 内加载只能在打包版手动验证：打开应用 → 导入一个大 .xlsx → 确认 UI 不卡、能出结果。
 */
'use strict'

const path = require('path')
const os = require('os')
const fs = require('fs')
const { Worker } = require('node:worker_threads')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require('xlsx')

function parseArgs(argv) {
  const args = { rows: 150000, cols: 20, sheets: 1, timeoutMs: 0, inline: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--inline') args.inline = true
    else if (a === '--rows') args.rows = Number(argv[++i])
    else if (a === '--cols') args.cols = Number(argv[++i])
    else if (a === '--sheets') args.sheets = Number(argv[++i])
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i])
    else { console.error(`未知参数: ${a}`); process.exit(2) }
  }
  return args
}

/** 生成一个 rows×cols × sheets 的 .xlsx：表头行 + 数据行 + 末尾一行"总计"。返回 { filePath, dir }。 */
function genXlsx({ rows, cols, sheets }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-excel-'))
  const filePath = path.join(dir, `big-${rows}x${cols}x${sheets}.xlsx`)
  const wb = XLSX.utils.book_new()
  for (let s = 0; s < sheets; s++) {
    const aoa = new Array(rows + 2)
    const header = new Array(cols)
    header[0] = '名称'
    for (let c = 1; c < cols; c++) header[c] = `指标${c}`
    aoa[0] = header
    for (let r = 0; r < rows; r++) {
      const row = new Array(cols)
      row[0] = `项目-${r}`
      for (let c = 1; c < cols; c++) row[c] = (r * 7 + c) % 1000
      aoa[r + 1] = row
    }
    const total = new Array(cols)
    total[0] = '总计'
    for (let c = 1; c < cols; c++) total[c] = rows * 100 + c
    aoa[rows + 1] = total
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), `Sheet${s + 1}`)
  }
  XLSX.writeFile(wb, filePath)
  return { filePath, dir }
}

/** 同步内联解析（复现修复前主线程行为）：只跑最重的 readFile + sheet_to_json。 */
function inlineParse(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true, cellNF: false })
  let totalRows = 0
  for (const name of wb.SheetNames) {
    const r = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', blankrows: false, raw: false })
    totalRows += r.length
  }
  return { totalRows }
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  const workerCjs = path.join(__dirname, '..', 'dist-electron', 'excel-parse-worker.cjs')
  if (!args.inline && !fs.existsSync(workerCjs)) {
    console.error(`✗ 未找到 ${workerCjs}\n  请先在 desktop-app 下 \`npm run build\`（或 \`node build-electron.js\`）。`)
    process.exit(1)
  }

  console.log(`生成 xlsx：${args.rows} 行 × ${args.cols} 列 × ${args.sheets} sheet ...`)
  const { filePath, dir } = genXlsx(args)
  const sizeMB = (fs.statSync(filePath).size / 1e6).toFixed(1)
  console.log(`生成完成：${filePath} (${sizeMB} MB)\n${args.inline ? '【--inline 对照】主线程内联解析' : '【worker 模式】worker 线程解析'}，主线程心跳监测中（每 100ms 一个 .）：`)

  // 主线程心跳：worker 模式应每 ~100ms 跳一次；inline 模式事件循环被同步阻塞，
  // 解析期间心跳一次都跳不了（ticks≈0）——这才是冻结的可靠信号（maxGap 在全程被阻塞时反而是 0）。
  let lastTick = Date.now()
  let maxGap = 0
  let ticks = 0
  const hb = setInterval(() => {
    const now = Date.now()
    const gap = now - lastTick
    if (gap > maxGap) maxGap = gap
    lastTick = now
    ticks++
    process.stdout.write('.')
  }, 100)

  const start = Date.now()
  let outcome

  if (args.inline) {
    // 同步阻塞主线程——心跳会卡住整个解析时长
    const { totalRows } = inlineParse(filePath)
    outcome = { kind: 'inline', totalRows }
  } else {
    outcome = await new Promise((resolve) => {
      const worker = new Worker(workerCjs, { workerData: { filePath, fileName: path.basename(filePath) } })
      let settled = false
      let timer = null
      const finish = (r) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        void worker.terminate()
        resolve(r)
      }
      if (args.timeoutMs > 0) timer = setTimeout(() => finish({ kind: 'timeout' }), args.timeoutMs)
      worker.once('message', (m) => finish({ kind: 'message', m }))
      worker.once('error', (e) => finish({ kind: 'error', e }))
      worker.once('exit', (code) => { if (!settled && code !== 0) finish({ kind: 'exit', code }) })
    })
  }

  clearInterval(hb)
  const dur = Date.now() - start
  process.stdout.write('\n\n')

  const expectedTicks = Math.floor(dur / 100)
  console.log(`解析耗时：${dur} ms`)
  console.log(`主线程心跳：${dur} ms 内跳了 ${ticks} 次（预期 ~${expectedTicks} 次），最大间隔 ${maxGap} ms`)

  if (outcome.kind === 'message') {
    const ok = outcome.m && outcome.m.ok
    if (ok) {
      const sheet0 = outcome.m.result.structuredData.sheets[0]
      console.log(`worker 返回 ok=true：sheets=${outcome.m.result.structuredData.sheets.length}，sheet0 列=${sheet0.columns.length}，行=${sheet0.rowCount}（截断上限 5000）`)
    } else {
      console.log(`worker 返回 ok=false：${outcome.m && outcome.m.error}`)
    }
  } else if (outcome.kind === 'timeout') {
    console.log(`✅ 到达 --timeout-ms=${args.timeoutMs}，已 worker.terminate() 强杀解析中的 worker`)
    console.log('   （这正是修复关键：被锁死的同步解析也能被中断；主线程内联解析的 Promise.race 超时永远排不上）')
  } else if (outcome.kind === 'inline') {
    console.log(`内联解析完成：读取 ${outcome.totalRows} 行（含表头/总计）`)
  } else {
    console.log(`worker ${outcome.kind}:`, outcome.e || outcome.code)
  }

  console.log('')
  // 平滑判定：心跳次数应接近预期（dur/100）。冻结时心跳跳不动 → ticks 远低于预期。
  const smooth = expectedTicks <= 1 ? maxGap < 500 : ticks >= expectedTicks * 0.6
  if (args.inline) {
    console.log(dur > 800 && ticks <= 1
      ? `⛔ 主线程被同步解析冻结约 ${dur} ms（心跳 ${ticks} 次，预期 ~${expectedTicks} 次）——这正是 #16 修复前的行为，worker 模式应消除它`
      : `（${dur}ms 太短，冻结不明显；加大 --rows 再试，例如 --rows 500000）`)
  } else if (args.timeoutMs > 0) {
    console.log(smooth
      ? '✅ 超时 terminate 期间主线程心跳平滑（未冻结）'
      : `⚠️ 心跳只跳 ${ticks}/${expectedTicks} 次，偏少，请确认确实走了 worker`)
  } else {
    console.log(smooth
      ? `✅ 解析全程主线程心跳平滑（跳了 ${ticks}/${expectedTicks} 次，≈100ms 间隔），主进程未被冻结 → #16 修复生效`
      : `⚠️ 心跳只跳 ${ticks}/${expectedTicks} 次；若是 worker 模式不应这样，请对照 --inline 确认`)
  }

  fs.rmSync(dir, { recursive: true, force: true })
}

run().catch((err) => { console.error(err); process.exit(1) })
