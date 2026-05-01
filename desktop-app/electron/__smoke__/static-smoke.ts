/**
 * 静态冒烟脚本：在纯 Node 环境下跑 html-to-pptx（editable + screenshots 两种模式）
 * 与 super_inline_html，落实物到一个临时目录，并把产物路径 / 大小 / 关键校验项打印出来。
 *
 * 这个脚本不需要启动 Electron，因为这两个模块都不依赖 BrowserWindow / app context。
 *
 * 用法：
 *   cd desktop-app && npx tsx electron/__smoke__/static-smoke.ts
 *
 * 输出目录：os.tmpdir()/soul-smoke-<timestamp>/static/
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { htmlToPptx } from '../exporters/html-to-pptx'
import { superInlineHtml } from '../exporters/inline-html'

interface SmokeStep {
  name: string
  ok: boolean
  outputPath?: string
  bytes?: number
  elapsedMs: number
  detail?: Record<string, unknown>
  error?: string
}

const SMOKE_DIR = path.join(os.tmpdir(), `soul-smoke-${Date.now()}`, 'static')
fs.mkdirSync(SMOKE_DIR, { recursive: true })

/** 1×1 透明 PNG，给截图模式 / 背景图测试用，避免外部依赖 */
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='

/** 拼一个有标题/正文/列表/图片/border/shadow/背景图的多页 HTML，用于 editable 模式冒烟 */
function buildEditableSampleHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
  <section class="slide" style="background-color:#0f172a">
    <h1 style="color:#ffffff; font-size:48px">Soul L3 冒烟报告</h1>
    <p style="color:#cbd5f5; font-size:18px">由 static-smoke.ts 自动生成，验证 editable PPTX 全链路。</p>
    <ul>
      <li style="color:#e2e8f0">html-to-pptx 编辑模式</li>
      <li style="color:#e2e8f0">背景色 / 背景图 / 全屏 img</li>
      <li style="color:#e2e8f0">border / radius / shadow</li>
    </ul>
  </section>

  <section class="slide" style="background-color:#ffffff">
    <h2 style="color:#0f172a">样式提取覆盖项</h2>
    <p style="border:2px solid #336699; border-radius:8px; box-shadow:0 4px 6px rgba(0,0,0,0.2); background-color:#f8fafc; color:#0f172a">
      这段段落附带 border + radius + shadow + background-color，
      对应 pptxgenjs 的 line / rectRadius / shadow / fill。
    </p>
    <p style="color:#475569; font-size:16px">注意：jsdom 不会展开 Tailwind class，所以请用 inline style。</p>
  </section>

  <section class="slide">
    <img src="${TINY_PNG}" style="width:100%; height:100%"/>
    <h2 style="color:#ffffff">全屏 img 作为背景</h2>
    <p style="color:#ffffff">应被识别为 slide.background，img 不会再次出现在内容流中。</p>
  </section>
</body></html>`
}

/** 拼一个引用外部 css/js/img 的 HTML，用于 super_inline_html 冒烟 */
function buildInlineSample(rootDir: string): string {
  fs.writeFileSync(
    path.join(rootDir, 'theme.css'),
    'body{font-family:sans-serif;background:#fafafa;color:#222}h1{color:#3b82f6}',
    'utf-8',
  )
  fs.writeFileSync(
    path.join(rootDir, 'app.js'),
    'window.__souldSmoke = "ok";\nconsole.log("inline js loaded");',
    'utf-8',
  )
  // 一个真实的 1x1 png 文件，验证非 dataURL 路径也能内联
  const pngBuf = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
    'base64',
  )
  fs.writeFileSync(path.join(rootDir, 'pixel.png'), pngBuf)
  return `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="./theme.css">
</head><body>
  <h1>Inline Smoke</h1>
  <img src="./pixel.png" alt="px"/>
  <script src="./app.js"></script>
</body></html>`
}

async function run(): Promise<void> {
  const steps: SmokeStep[] = []

  // ---------- step 1: html-to-pptx editable ----------
  {
    const out = path.join(SMOKE_DIR, 'editable.pptx')
    const t0 = Date.now()
    try {
      const r = await htmlToPptx({
        htmlContent: buildEditableSampleHtml(),
        outputPath: out,
      })
      const bytes = fs.statSync(out).size
      // 解析 PK 头，确认是合法 zip
      const head = fs.readFileSync(out).slice(0, 2)
      const isZip = head[0] === 0x50 && head[1] === 0x4b
      steps.push({
        name: 'html-to-pptx [editable, 3 slides, 含 border/shadow/全屏 img 背景]',
        ok: isZip && r.slideCount === 3,
        outputPath: out,
        bytes,
        elapsedMs: Date.now() - t0,
        detail: { slideCount: r.slideCount, selectorUsed: r.selectorUsed, warnings: r.warnings, isPkHeader: isZip },
      })
    } catch (err) {
      steps.push({
        name: 'html-to-pptx [editable]',
        ok: false,
        elapsedMs: Date.now() - t0,
        error: (err as Error).message,
      })
    }
  }

  // ---------- step 2: html-to-pptx screenshots ----------
  {
    const out = path.join(SMOKE_DIR, 'screenshots.pptx')
    const t0 = Date.now()
    try {
      const r = await htmlToPptx({
        htmlContent: '<html><body>not used</body></html>',
        outputPath: out,
        slideScreenshots: [TINY_PNG, TINY_PNG, TINY_PNG, TINY_PNG],
      })
      const bytes = fs.statSync(out).size
      steps.push({
        name: 'html-to-pptx [screenshots, 4 dataURL pages]',
        ok: r.slideCount === 4 && bytes > 1024,
        outputPath: out,
        bytes,
        elapsedMs: Date.now() - t0,
        detail: { slideCount: r.slideCount, selectorUsed: r.selectorUsed },
      })
    } catch (err) {
      steps.push({
        name: 'html-to-pptx [screenshots]',
        ok: false,
        elapsedMs: Date.now() - t0,
        error: (err as Error).message,
      })
    }
  }

  // ---------- step 3: super_inline_html ----------
  {
    const srcDir = path.join(SMOKE_DIR, 'inline-src')
    fs.mkdirSync(srcDir, { recursive: true })
    const srcHtml = path.join(srcDir, 'index.html')
    fs.writeFileSync(srcHtml, buildInlineSample(srcDir), 'utf-8')

    const outHtml = path.join(SMOKE_DIR, 'inlined.html')
    const t0 = Date.now()
    try {
      const r = await superInlineHtml({
        inputPath: srcHtml,
        outputPath: outHtml,
        resourceBaseDir: srcDir,
      })
      const text = fs.readFileSync(outHtml, 'utf-8')
      const cssInlined = text.includes('background:#fafafa') && !text.includes('href="./theme.css"')
      const jsInlined = text.includes('window.__souldSmoke') && !text.includes('src="./app.js"')
      const imgInlined = text.includes('data:image/png;base64,')
      steps.push({
        name: 'super_inline_html [css + js + img 全部内联]',
        ok: cssInlined && jsInlined && imgInlined,
        outputPath: outHtml,
        bytes: fs.statSync(outHtml).size,
        elapsedMs: Date.now() - t0,
        detail: {
          cssInlined,
          jsInlined,
          imgInlined,
          inlinedCss: r.inlinedCss,
          inlinedScripts: r.inlinedScripts,
          inlinedImages: r.inlinedImages,
          warnings: r.warnings,
        },
      })
    } catch (err) {
      steps.push({
        name: 'super_inline_html',
        ok: false,
        elapsedMs: Date.now() - t0,
        error: (err as Error).message,
      })
    }
  }

  // ---------- 汇总 ----------
  const passed = steps.filter((s) => s.ok).length
  const failed = steps.length - passed
  // eslint-disable-next-line no-console
  console.log('\n========== SOUL STATIC SMOKE REPORT ==========')
  // eslint-disable-next-line no-console
  console.log('Output dir:', SMOKE_DIR)
  for (const s of steps) {
    const tag = s.ok ? 'PASS' : 'FAIL'
    // eslint-disable-next-line no-console
    console.log(`\n[${tag}] ${s.name}`)
    if (s.outputPath) console.log('  → output:', s.outputPath, `(${s.bytes ?? 0} bytes)`)
    console.log('  → elapsed:', s.elapsedMs + 'ms')
    if (s.detail) console.log('  → detail :', JSON.stringify(s.detail))
    if (s.error) console.log('  → error  :', s.error)
  }
  // eslint-disable-next-line no-console
  console.log(`\nTotal: ${steps.length}   Passed: ${passed}   Failed: ${failed}`)
  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('static-smoke fatal:', err)
  process.exit(2)
})
