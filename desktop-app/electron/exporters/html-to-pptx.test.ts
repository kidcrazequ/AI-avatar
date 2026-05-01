/**
 * html-to-pptx 单测：覆盖 editable 模式与 screenshots 模式两种主路径，
 * 以及 .slide / [data-slide] / 自定义 selector 三种 page 选择策略。
 *
 * 注意：pptxgenjs 在 Node 下走 fflate，需要保证 fs 可写；
 * 单测在 os.tmpdir() 下的临时目录里写文件，写完后立即删掉。
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { htmlToPptx, __test } from './html-to-pptx'

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soul-pptx-')), name)
}

test('htmlToPptx editable 模式：识别 .slide 元素并写出可解压的 PPTX 文件', async () => {
  const html = `
    <html><body>
      <section class="slide" style="background-color:#ffffff">
        <h1 style="font-size:36px;color:#111111">Hello Soul</h1>
        <p>这是第一页正文，验证段落写入。</p>
        <ul><li>要点一</li><li>要点二</li></ul>
      </section>
      <section class="slide">
        <h2>Page 2</h2>
        <p>第二页内容。</p>
      </section>
    </body></html>
  `
  const outPath = tmpFile('basic.pptx')
  const result = await htmlToPptx({ htmlContent: html, outputPath: outPath })
  assert.equal(result.slideCount, 2, '应该识别两张 slide')
  assert.equal(result.selectorUsed, '.slide')
  assert.ok(fs.existsSync(outPath), 'PPTX 文件应该写入磁盘')
  const stat = fs.statSync(outPath)
  assert.ok(stat.size > 1024, `PPTX 应该有合理体积 (got ${stat.size})`)
  // PPTX 是 zip 格式，前两个字节应该是 PK
  const head = fs.readFileSync(outPath).slice(0, 2)
  assert.equal(head[0], 0x50, '应该是 PK 开头')
  assert.equal(head[1], 0x4b, '应该是 PK 开头')
})

test('htmlToPptx 自动回退 selector：没有 .slide 时用 [data-slide]', async () => {
  const html = '<html><body><div data-slide><h1>A</h1></div><div data-slide><h1>B</h1></div></body></html>'
  const outPath = tmpFile('fallback.pptx')
  const result = await htmlToPptx({ htmlContent: html, outputPath: outPath })
  assert.equal(result.selectorUsed, '[data-slide]')
  assert.equal(result.slideCount, 2)
})

test('htmlToPptx 完全没有 page 容器时把 body 视为单页', async () => {
  const html = '<html><body><h1>Lonely Page</h1><p>only one</p></body></html>'
  const outPath = tmpFile('singleton.pptx')
  const result = await htmlToPptx({ htmlContent: html, outputPath: outPath })
  assert.equal(result.selectorUsed, 'body')
  assert.equal(result.slideCount, 1)
})

test('htmlToPptx screenshots 模式：每页用一张 dataURL 全屏渲染', async () => {
  // 1×1 透明 PNG 的 dataURL（最小合法 PNG）
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
  const outPath = tmpFile('shots.pptx')
  const result = await htmlToPptx({
    htmlContent: '<html><body>not used</body></html>',
    outputPath: outPath,
    slideScreenshots: [tinyPng, tinyPng, tinyPng],
  })
  assert.equal(result.slideCount, 3)
  assert.equal(result.selectorUsed, '__screenshot_mode__')
  assert.ok(fs.existsSync(outPath))
})

test('htmlToPptx 自定义 page selector', async () => {
  const html = '<html><body><div class="custom-page"><h1>Custom</h1></div></body></html>'
  const outPath = tmpFile('custom.pptx')
  const result = await htmlToPptx({ htmlContent: html, outputPath: outPath, pageSelector: '.custom-page' })
  assert.equal(result.selectorUsed, '.custom-page')
  assert.equal(result.slideCount, 1)
})

// =====================================================================
// B3：背景图 / border / shadow / radius 样式提取
// 直接断言内部 helper（__test）输出，避免依赖 pptx 二进制结构验断
// =====================================================================

/** 用 JSDOM 把一个内联 style 字符串挂到一个真实 element 上，方便测试 helper */
function makeEl(tag: string, attrs: Record<string, string> = {}): { el: Element; dom: JSDOM } {
  const dom = new JSDOM(`<html><body><${tag} id="x"></${tag}></body></html>`)
  const el = dom.window.document.getElementById('x')!
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return { el, dom }
}

test('extractBoxStyle 解析 border 缩写（"2px solid #f00"）', () => {
  const { el } = makeEl('p', { style: 'border: 2px solid #ff0000' })
  const box = __test.extractBoxStyle(el)
  assert.equal(box.borderColorHex, 'FF0000')
  assert.equal(box.borderWidthPt, 2, '2px → 大约 2pt（pxToPt 0.75 倍后 round=2）')
  assert.equal(box.borderDash, 'solid')
})

test('extractBoxStyle 解析 border 分项写法 + dashed 映射 dash', () => {
  const { el } = makeEl('div', {
    style: 'border-width: 3px; border-style: dashed; border-color: rgb(0, 100, 200)',
  })
  const box = __test.extractBoxStyle(el)
  assert.equal(box.borderColorHex, '0064C8')
  assert.equal(box.borderDash, 'dash')
  assert.ok(box.borderWidthPt && box.borderWidthPt >= 2, 'borderWidthPt 应该大于 2')
})

test('extractBoxStyle 解析 border-radius 8px → rectRadius 0..0.5 之间', () => {
  const { el } = makeEl('div', { style: 'border-radius: 8px' })
  const box = __test.extractBoxStyle(el)
  assert.ok(typeof box.borderRadiusFraction === 'number')
  assert.ok(box.borderRadiusFraction! > 0 && box.borderRadiusFraction! <= 0.5)
})

test('extractBoxStyle 解析 border-radius 50% → rectRadius=0.5（最大圆角）', () => {
  const { el } = makeEl('div', { style: 'border-radius: 50%' })
  const box = __test.extractBoxStyle(el)
  assert.equal(box.borderRadiusFraction, 0.5)
})

test('extractBoxStyle 解析 box-shadow（4 段 + rgba 颜色）', () => {
  const { el } = makeEl('div', {
    style: 'box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2)',
  })
  const box = __test.extractBoxStyle(el)
  assert.ok(box.shadow, '应该解析到 shadow')
  assert.equal(box.shadow!.colorHex, '000000')
  assert.equal(box.shadow!.opacity, 0.2)
  assert.equal(box.shadow!.blur, 6)
  assert.equal(box.shadow!.type, 'outer')
  // ox=0 oy=4 → angle ≈ 90（向下）
  assert.ok(box.shadow!.angle >= 80 && box.shadow!.angle <= 100, `angle ≈ 90 (got ${box.shadow!.angle})`)
})

test('extractBoxStyle 解析 background-color → fillColorHex', () => {
  const { el } = makeEl('div', { style: 'background-color: #336699' })
  const box = __test.extractBoxStyle(el)
  assert.equal(box.fillColorHex, '336699')
})

test('extractBoxStyle 同时解析 border + radius + shadow + fill 并复合', () => {
  const { el } = makeEl('section', {
    style: 'background-color:#fff; border:1px solid #000; border-radius:6px; box-shadow:0 2px 4px rgba(0,0,0,0.15)',
  })
  const box = __test.extractBoxStyle(el)
  assert.equal(box.fillColorHex, 'FFFFFF')
  assert.equal(box.borderColorHex, '000000')
  assert.ok(box.borderRadiusFraction! > 0)
  assert.ok(box.shadow)
})

test('resolveSlideBackground：inline background-image url 命中 dataURL 模式', () => {
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
  const dom = new JSDOM(
    `<html><body><div id="s" style="background-image: url('${tinyPng}')"></div></body></html>`,
  )
  const el = dom.window.document.getElementById('s')!
  const r = __test.resolveSlideBackground(el, '/tmp', [])
  assert.equal(r.background.data, tinyPng)
  assert.equal(r.consumed, undefined, 'dataURL 背景不消费 DOM 元素')
})

test('resolveSlideBackground：全屏 <img> 子节点会被识别为背景且被 consumed', () => {
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
  const dom = new JSDOM(
    `<html><body><section id="s"><img id="bg" src="${tinyPng}" style="width:100%; height:100%"/><h1>title</h1></section></body></html>`,
  )
  const el = dom.window.document.getElementById('s')!
  const r = __test.resolveSlideBackground(el, '/tmp', [])
  assert.equal(r.background.data, tinyPng)
  assert.ok(r.consumed, '全屏 img 应该被消费，避免重复写为 image block')
  assert.equal((r.consumed as Element).id, 'bg')
})

test('resolveSlideBackground：仅有 background-color 时回退到 color', () => {
  const dom = new JSDOM('<html><body><div id="s" style="background-color: #abcdef"></div></body></html>')
  const el = dom.window.document.getElementById('s')!
  const r = __test.resolveSlideBackground(el, '/tmp', [])
  assert.equal(r.background.color, 'ABCDEF')
})

test('resolveSlideBackground：什么都没有时兜底 FFFFFF', () => {
  const dom = new JSDOM('<html><body><div id="s"></div></body></html>')
  const el = dom.window.document.getElementById('s')!
  const r = __test.resolveSlideBackground(el, '/tmp', [])
  assert.equal(r.background.color, 'FFFFFF')
})

test('htmlToPptx 集成：含 border + shadow + bg 的 slide 能正常导出（不报错）', async () => {
  const html = `
    <html><body>
      <section class="slide" style="background-color: #f5f5f5">
        <h1 style="color:#222">Styled Page</h1>
        <p style="border: 2px solid #336699; border-radius: 6px; box-shadow: 0 4px 8px rgba(0,0,0,0.2); background-color:#ffffff">
          Box with border and shadow
        </p>
      </section>
    </body></html>
  `
  const outPath = tmpFile('styled.pptx')
  const r = await htmlToPptx({ htmlContent: html, outputPath: outPath })
  assert.equal(r.slideCount, 1)
  assert.ok(fs.existsSync(outPath))
  // 含样式的 pptx 体积应该比纯文本略大（这里 > 5KB 作为下限）
  assert.ok(fs.statSync(outPath).size > 5_000, `styled pptx 体积应该 > 5KB (got ${fs.statSync(outPath).size})`)
})

test('htmlToPptx 集成：全屏 img 当背景图，pptx 仍只有 1 页（img 不重复成 block）', async () => {
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
  const html = `
    <html><body>
      <section class="slide">
        <img src="${tinyPng}" style="width:100%; height:100%"/>
        <h1 style="color:#fff">Hero Title</h1>
      </section>
    </body></html>
  `
  const outPath = tmpFile('hero.pptx')
  const r = await htmlToPptx({ htmlContent: html, outputPath: outPath })
  assert.equal(r.slideCount, 1)
  assert.ok(fs.existsSync(outPath))
})
