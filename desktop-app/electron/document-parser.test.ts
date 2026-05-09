/**
 * DocumentParser 附件解析单测。
 *
 * 验证：
 *   1. HTML 附件与上传白名单保持一致，上传后可被 read_attachment/search_attachment 读取正文
 *   2. PDF 多页注入 `### 第 N 页` 三级标题（Template-based chunking #14 子任务 1）
 *   3. PDF 单页保持现有行为不注入
 *   4. Word 中文/英文标题层级保留为 ATX markdown（#14 子任务 2）
 *   5. Word convertToHtml 失败时回退到 extractRawText，不抛错
 *
 * @author zhi.qu
 * @date 2026-05-05
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocumentParser, SUPPORTED_PARSE_EXTENSIONS } from './document-parser'
import { buildMinimalPdf } from './__tests__/fixtures/generate-pdf-fixture'
import { buildHeadingsDocx } from './__tests__/fixtures/generate-docx-fixture'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soul-document-parser-test-'))
}

test('DocumentParser: HTML 附件解析为可检索纯文本', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'sample.html')
  fs.writeFileSync(filePath, `<!doctype html>
<html>
  <head>
    <title>产品说明</title>
    <style>.hidden { display: none; }</style>
    <script>window.secret = '不应进入正文'</script>
  </head>
  <body>
    <h1>工商储方案</h1>
    <p>支持 HTML 附件上传后解析。</p>
  </body>
</html>`, 'utf-8')

  const parsed = await new DocumentParser().parseFile(filePath)

  assert.equal(parsed.fileName, 'sample.html')
  assert.equal(parsed.fileType, 'text')
  assert.equal(parsed.images.length, 0)
  assert.match(parsed.text, /产品说明/)
  assert.match(parsed.text, /工商储方案/)
  assert.match(parsed.text, /支持 HTML 附件上传后解析。/)
  assert.doesNotMatch(parsed.text, /不应进入正文/)
  assert.doesNotMatch(parsed.text, /display: none/)
})

test('DocumentParser: 支持 .html 与 .htm 扩展名', () => {
  assert.ok(SUPPORTED_PARSE_EXTENSIONS.includes('.html'))
  assert.ok(SUPPORTED_PARSE_EXTENSIONS.includes('.htm'))
})

test('DocumentParser: 多页 PDF 注入 ### 第 N 页 heading', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'sample-3-pages.pdf')
  fs.writeFileSync(
    filePath,
    buildMinimalPdf(['Page One Hello', 'Page Two World', 'Page Three Soul']),
  )

  try {
    const parsed = await new DocumentParser().parseFile(filePath)

    assert.equal(parsed.fileType, 'pdf')
    // 三页都注入 `### 第 N 页` 标题
    assert.match(parsed.text, /### 第 1 页/, 'text 应包含 ### 第 1 页')
    assert.match(parsed.text, /### 第 2 页/, 'text 应包含 ### 第 2 页')
    assert.match(parsed.text, /### 第 3 页/, 'text 应包含 ### 第 3 页')
    // 原文也应出现在对应页 heading 之后（pdfjs 解析 Helvetica 文本流应能拿到）
    assert.match(parsed.text, /Page One Hello/)
    assert.match(parsed.text, /Page Two World/)
    assert.match(parsed.text, /Page Three Soul/)
    // perPageChars 仍是有效数组，包含每页字符统计
    assert.ok(Array.isArray(parsed.perPageChars), 'perPageChars 应为数组')
    assert.equal(parsed.perPageChars!.length, 3, 'perPageChars 应有 3 项')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('DocumentParser: 单页 PDF 不注入页 heading（保持现有行为）', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'sample-1-page.pdf')
  fs.writeFileSync(filePath, buildMinimalPdf(['Single Page Soul Demo']))

  try {
    const parsed = await new DocumentParser().parseFile(filePath)

    assert.equal(parsed.fileType, 'pdf')
    // 单页不应注入 `### 第 N 页`
    assert.doesNotMatch(parsed.text, /### 第 \d+ 页/, '单页 PDF 不应注入页 heading')
    // 原文仍然存在
    assert.match(parsed.text, /Single Page Soul Demo/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('DocumentParser: Word 中文/英文标题保留 H1/H2/H3 层级（ATX markdown）', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'sample-headings.docx')
  fs.writeFileSync(filePath, await buildHeadingsDocx())

  try {
    const parsed = await new DocumentParser().parseFile(filePath)

    assert.equal(parsed.fileType, 'word')
    // ATX 风格 markdown：# / ## / ### 各层级标题至少一个能匹配上
    // （docx 库默认产出英文 style ID，被 styleMap 中的 "Heading 1/2/3" 项匹配）
    assert.match(parsed.text, /^# 设计文档\s*$/m, '应有 H1 # 设计文档')
    assert.match(parsed.text, /^## 概述\s*$/m, '应有 H2 ## 概述')
    assert.match(parsed.text, /^## 架构\s*$/m, '应有 H2 ## 架构')
    assert.match(parsed.text, /^### 前端\s*$/m, '应有 H3 ### 前端')
    assert.match(parsed.text, /^### 后端\s*$/m, '应有 H3 ### 后端')
    // 正文段落保留
    assert.match(parsed.text, /本文档介绍 Soul 系统。/)
    assert.match(parsed.text, /Electron \+ React。/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('DocumentParser: Word convertToHtml 抛错时回退到 extractRawText（非空 text）', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'sample-fallback.docx')
  fs.writeFileSync(filePath, await buildHeadingsDocx())

  // 通过 require.cache 替换 mammoth，让 convertToHtml 永远 reject。
  // 由于 parseWord 内部用 require('mammoth') 每次拿模块，替换 cache.exports 即可触发。
  const mammothPath = require.resolve('mammoth')
  if (!require.cache[mammothPath]) {
    // 极端情况下缓存被 tsx/jest 清理过：直接重新 require 一次以填缓存
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('mammoth')
  }
  const realModule = require.cache[mammothPath]!
  const realExports = realModule.exports
  realModule.exports = {
    ...realExports,
    convertToHtml: () => Promise.reject(new Error('mocked convertToHtml failure')),
  }

  // 捕获 console.warn 验证回退路径触发
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = ((...args: unknown[]): void => {
    warnings.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '))
  }) as typeof console.warn

  try {
    const parsed = await new DocumentParser().parseFile(filePath)

    assert.equal(parsed.fileType, 'word')
    assert.equal(typeof parsed.text, 'string')
    assert.ok(parsed.text.length > 0, '回退后 text 应为非空字符串（来自 extractRawText）')
    assert.ok(
      warnings.some(w => /convertToHtml.*失败/.test(w)),
      'console.warn 应被调用（含 convertToHtml 失败原因）',
    )
  } finally {
    realModule.exports = realExports
    console.warn = realWarn
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
