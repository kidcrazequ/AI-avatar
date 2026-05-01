/**
 * super_inline_html 单测：覆盖 css/script/img 内联，
 * 以及未越界（resourceBaseDir 之外的相对路径不读盘）。
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { superInlineHtml } from './inline-html'

function setupFixture(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-inline-'))
  fs.writeFileSync(path.join(dir, 'styles.css'), 'body { background: url("./bg.png"); color: red; }')
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("hello")')
  // 1×1 PNG（10 字节够用）
  const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  fs.writeFileSync(path.join(dir, 'bg.png'), tinyPng)
  fs.writeFileSync(path.join(dir, 'logo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    `<!doctype html>
     <html><head>
       <link rel="stylesheet" href="styles.css">
       <link rel="icon" href="logo.jpg">
     </head><body>
       <h1>hi</h1>
       <img src="logo.jpg" alt="logo">
       <script src="app.js"></script>
     </body></html>`,
  )
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

test('superInlineHtml 把外部 css / script / img / icon 全部内联为 dataURL', async () => {
  const { dir, cleanup } = setupFixture()
  try {
    const inputPath = path.join(dir, 'index.html')
    const outputPath = path.join(dir, 'out.html')
    const result = await superInlineHtml({ inputPath, outputPath })
    assert.equal(result.inlinedCss, 1, '应内联 1 个外部样式表')
    assert.equal(result.inlinedScripts, 1, '应内联 1 个外部脚本')
    assert.equal(result.inlinedImages, 1, '应内联 1 张图片')

    const written = fs.readFileSync(outputPath, 'utf-8')
    assert.ok(written.includes('<style>'), '原 link 应替换为 style 标签')
    assert.ok(!/<link[^>]+href="styles\.css"/.test(written), '不应残留外部 css link')
    assert.ok(!/<script[^>]+src="app\.js"/.test(written), '不应残留外部 script src')
    assert.ok(/data:image\/jpeg;base64,/.test(written), '图片应内联为 dataURL')
    assert.ok(/data:image\/png;base64,/.test(written), 'CSS 中的 url(bg.png) 应内联为 dataURL')
  } finally {
    cleanup()
  }
})

test('superInlineHtml 对 / 开头的相对路径越界引用：返回 warning 并保留 src', async () => {
  const { dir, cleanup } = setupFixture()
  try {
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<html><body><img src="../../etc/hosts" alt="bad"></body></html>',
    )
    const result = await superInlineHtml({
      inputPath: path.join(dir, 'index.html'),
      outputPath: path.join(dir, 'out.html'),
    })
    assert.equal(result.inlinedImages, 0)
    assert.ok(result.warnings.some((w) => w.includes('etc/hosts')), '越界图片应被记录到 warnings')
  } finally {
    cleanup()
  }
})

test('superInlineHtml 已经是 dataURL 的资源不重复处理', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-inline-data-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<html><body><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></body></html>',
    )
    const result = await superInlineHtml({
      inputPath: path.join(dir, 'index.html'),
      outputPath: path.join(dir, 'out.html'),
    })
    assert.equal(result.inlinedImages, 0)
    assert.equal(result.warnings.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
