/**
 * DocumentParser 附件解析单测。
 *
 * 验证 HTML 附件与上传白名单保持一致，上传后可被 read_attachment/search_attachment 读取正文。
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
