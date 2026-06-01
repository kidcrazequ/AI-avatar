/**
 * Electron 冒烟：在真实 BrowserWindow 里离屏渲染 chart + mermaid，断言产出 SVG（F8 进阶验证）。
 *
 * 这是 renderConversationAssets 的真实环境验证——node 测试器没有 BrowserWindow，只能靠这个
 * 在 Electron 主进程里跑。echarts/mermaid 都用 SVG renderer，不依赖 GPU。
 *
 * 用法：
 *   cd desktop-app
 *   npm run smoke:charts
 *
 * 输出：os.tmpdir()/soul-smoke-<ts>/charts/{report.json, chart.svg, mermaid.svg}
 * 退出码：chart 与 mermaid 都产出 <svg> → 0；否则 1。
 *
 * @author zhi.qu
 * @date 2026-06-02
 */

/* eslint-disable no-console -- smoke 脚本输出全靠 console，CI 看 stdout */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { renderConversationAssets, assetKey } from '../exporters/conversation-asset-renderer'

const SMOKE_ROOT = path.join(os.tmpdir(), `soul-smoke-${Date.now()}`, 'charts')
fs.mkdirSync(SMOKE_ROOT, { recursive: true })

const CHART = JSON.stringify({
  xAxis: { type: 'category', data: ['铜', '铝'] },
  yAxis: { type: 'value' },
  series: [{ type: 'bar', data: [59.6, 37.7] }],
})
const MERMAID = 'graph TD; A[问题] --> B[查知识库] --> C[标来源]'

async function run(): Promise<void> {
  await app.whenReady()
  const result = await renderConversationAssets(
    [
      { kind: 'chart', code: CHART },
      { kind: 'mermaid', code: MERMAID },
    ],
    { timeoutMs: 20_000 },
  )
  const chartSvg = result.get(assetKey('chart', CHART)) ?? ''
  const mermaidSvg = result.get(assetKey('mermaid', MERMAID)) ?? ''
  const chartOk = chartSvg.includes('<svg')
  const mermaidOk = mermaidSvg.includes('<svg')

  const report = {
    chartOk,
    mermaidOk,
    chartLen: chartSvg.length,
    mermaidLen: mermaidSvg.length,
  }
  fs.writeFileSync(path.join(SMOKE_ROOT, 'report.json'), JSON.stringify(report, null, 2), 'utf-8')
  if (chartSvg) fs.writeFileSync(path.join(SMOKE_ROOT, 'chart.svg'), chartSvg, 'utf-8')
  if (mermaidSvg) fs.writeFileSync(path.join(SMOKE_ROOT, 'mermaid.svg'), mermaidSvg, 'utf-8')

  console.log('[smoke:charts] report =', JSON.stringify(report))
  console.log('[smoke:charts] out =', SMOKE_ROOT)
  const ok = chartOk && mermaidOk
  console.log(ok ? '[smoke:charts] PASS ✓' : '[smoke:charts] FAIL ✗')
  app.exit(ok ? 0 : 1)
}

run().catch((err: unknown) => {
  console.error('[smoke:charts] fatal:', err instanceof Error ? err.message : String(err))
  app.exit(1)
})
