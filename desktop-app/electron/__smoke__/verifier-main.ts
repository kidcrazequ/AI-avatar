/**
 * Electron 冒烟主进程：只做一件事——起 VerifierAgent 跑一个真实页面，
 * 落盘多 viewport 截图、捕获 console 错误、然后 app.quit()。
 *
 * 用法（先 build，再用 electron 直接启动这个 main）：
 *   cd desktop-app
 *   npx esbuild electron/__smoke__/verifier-main.ts \
 *       --bundle --platform=node --format=cjs \
 *       --outfile=dist-electron/__smoke__/verifier-main.js \
 *       --external:electron --external:better-sqlite3
 *   npx electron dist-electron/__smoke__/verifier-main.js
 *
 * 输出目录：os.tmpdir()/soul-smoke-<timestamp>/verifier/
 *   - report.json           — 结果汇总
 *   - sample.html           — 被验证的页面（含一个故意的 console.error）
 *   - <vp>-<n>.png          — 每个 viewport 的截图
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { VerifierAgent } from '../verifier/VerifierAgent'

const SMOKE_ROOT = path.join(os.tmpdir(), `soul-smoke-${Date.now()}`, 'verifier')
fs.mkdirSync(SMOKE_ROOT, { recursive: true })

/**
 * 写一个测试用 HTML，包含：
 *  - 标题、段落（验证 DOM 渲染）
 *  - 一段故意的 console.error（验证 console 捕获）
 *  - 一个故意 404 的 <img src>（验证 resourceFailures 捕获）
 *  - 媒体查询断点（验证多 viewport 截图差异）
 */
function writeSampleHtml(): string {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Soul Verifier Smoke</title>
<style>
  body{margin:0;font-family:-apple-system,Segoe UI,sans-serif;background:linear-gradient(135deg,#0f172a,#1e293b);color:#fff;padding:32px;min-height:100vh;box-sizing:border-box}
  h1{font-size:36px;margin:0 0 16px}
  p{font-size:16px;line-height:1.6;color:#cbd5f5}
  .badge{display:inline-block;padding:4px 12px;background:#3b82f6;border-radius:999px;font-size:12px;margin-right:8px}
  @media (max-width: 768px){ h1{font-size:24px;color:#fbbf24} body{background:#7c2d12} }
  @media (max-width: 480px){ h1{font-size:18px;color:#34d399} body{background:#064e3b} }
</style></head><body>
  <h1>Soul L3 Verifier Smoke</h1>
  <p><span class="badge">desktop</span><span class="badge">tablet</span><span class="badge">mobile</span></p>
  <p>本页面有一个 <strong>故意</strong> 的 console.error 与一个 404 资源，用于验证 VerifierAgent 的诊断能力。</p>
  <img src="./does-not-exist.png" alt="missing"/>
  <script>
    console.error('[smoke] this error is intentional - if you see it captured, verifier is working');
  </script>
</body></html>`
  const file = path.join(SMOKE_ROOT, 'sample.html')
  fs.writeFileSync(file, html, 'utf-8')
  return file
}

async function run(): Promise<void> {
  await app.whenReady()
  const samplePath = writeSampleHtml()
  const url = 'file://' + samplePath

  // eslint-disable-next-line no-console
  console.log('[smoke] sample html =', samplePath)
  // eslint-disable-next-line no-console
  console.log('[smoke] running VerifierAgent on', url)

  const agent = new VerifierAgent()
  const t0 = Date.now()
  const result = await agent.verify({
    url,
    outputDir: SMOKE_ROOT,
    timeoutMs: 8000,
    // 用三个有差异的视口，验证媒体查询会生效
    viewports: [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'tablet', width: 700, height: 900 }, // 触发 768 断点
      { name: 'mobile', width: 380, height: 800 }, // 触发 480 断点
    ],
  })
  const elapsed = Date.now() - t0

  // 写一份 JSON 报告
  fs.writeFileSync(
    path.join(SMOKE_ROOT, 'report.json'),
    JSON.stringify(result, null, 2),
    'utf-8',
  )

  const intentionalErrCaught = result.errors.some((e) => /intentional/i.test(e.text))
  const notFoundCaught = result.resourceFailures.some((f) => /does-not-exist/.test(f.url))
  // VerifierAgent.shot.filePath 是相对 outputDir 的路径（设计如此），冒烟拼回绝对路径再 check
  const shotsOK =
    result.shots.length === 3 &&
    result.shots.every((s) => s.filePath && fs.existsSync(path.join(SMOKE_ROOT, s.filePath)))

  // eslint-disable-next-line no-console
  console.log('\n========== SOUL VERIFIER SMOKE REPORT ==========')
  // eslint-disable-next-line no-console
  console.log('Output dir:', SMOKE_ROOT)
  // eslint-disable-next-line no-console
  console.log('Elapsed   :', elapsed + 'ms')
  // eslint-disable-next-line no-console
  console.log('Verifier ok:', result.ok, '| message:', result.message)
  // eslint-disable-next-line no-console
  console.log('Errors captured  :', result.errors.length, '| intentional caught?', intentionalErrCaught)
  // eslint-disable-next-line no-console
  console.log('Warnings captured:', result.warnings.length)
  // eslint-disable-next-line no-console
  console.log('Resource failures:', result.resourceFailures.length, '| 404 caught?', notFoundCaught)
  // eslint-disable-next-line no-console
  console.log('Screenshots      :', result.shots.length, '| all on disk?', shotsOK)
  for (const s of result.shots) {
    const abs = s.filePath ? path.join(SMOKE_ROOT, s.filePath) : '(no file)'
    const sz = s.filePath && fs.existsSync(abs) ? `${fs.statSync(abs).size}B` : '?'
    // eslint-disable-next-line no-console
    console.log('  -', s.viewport.name, `${s.width}×${s.height}`, '→', abs, sz)
  }

  // 退出码：所有期望都满足 = 0，否则 = 1
  const ok = intentionalErrCaught && notFoundCaught && shotsOK
  // eslint-disable-next-line no-console
  console.log('\nResult:', ok ? 'PASS' : 'FAIL')
  app.quit()
  // 给 quit 一点时间清理 BrowserWindow
  setTimeout(() => process.exit(ok ? 0 : 1), 200)
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('verifier-smoke fatal:', err)
  app.quit()
  setTimeout(() => process.exit(2), 200)
})
