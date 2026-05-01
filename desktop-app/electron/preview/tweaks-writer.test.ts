/**
 * tweaks-writer 单测：验证 EDITMODE 块识别 / 多块共存 / 不存在时报错 / 备份。
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyTweaks } from './tweaks-writer'

function tmpHtml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-tweaks-'))
  const f = path.join(dir, 'index.html')
  fs.writeFileSync(f, content, 'utf-8')
  return f
}

test('applyTweaks 把指定 block 替换为新 JSON 并保留外层 script 包装', () => {
  const file = tmpHtml(`
    <html><body>
      <!-- EDITMODE-BEGIN id="hero" -->
      <script type="application/json" id="hero">
      { "title": "old", "color": "#000" }
      </script>
      <!-- EDITMODE-END -->
    </body></html>
  `)
  const r = applyTweaks({ htmlAbsPath: file, blockId: 'hero', newValues: { title: 'new', color: '#3b82f6' } })
  assert.equal(r.changed, true)
  const after = fs.readFileSync(file, 'utf-8')
  assert.ok(after.includes('"title": "new"'), '应该写入新 title')
  assert.ok(after.includes('<!-- EDITMODE-BEGIN id="hero" -->'), '保留起始注释')
  assert.ok(after.includes('<!-- EDITMODE-END -->'), '保留结束注释')
  assert.ok(after.includes('<script type="application/json" id="hero">'), '保留 script 包装')
  assert.ok(r.backupPath && fs.existsSync(r.backupPath), '默认应该写入备份')
})

test('applyTweaks 多 block 共存时只改命中的 block', () => {
  const file = tmpHtml(`
    <!-- EDITMODE-BEGIN id="a" -->
    <script type="application/json" id="a">{"v":1}</script>
    <!-- EDITMODE-END -->
    <!-- EDITMODE-BEGIN id="b" -->
    <script type="application/json" id="b">{"v":2}</script>
    <!-- EDITMODE-END -->
  `)
  applyTweaks({ htmlAbsPath: file, blockId: 'b', newValues: { v: 99 }, backup: false })
  const after = fs.readFileSync(file, 'utf-8')
  assert.ok(after.includes('id="a">{"v":1}</script>'), 'a 块不应被改')
  assert.ok(after.includes('"v": 99'), 'b 块应该写入 v:99')
})

test('applyTweaks 找不到 block 时抛错', () => {
  const file = tmpHtml('<html><body>nothing</body></html>')
  assert.throws(
    () => applyTweaks({ htmlAbsPath: file, blockId: 'missing', newValues: {} }),
    /未找到 EDITMODE 块/,
  )
})

test('applyTweaks blockId 含特殊字符时被 escape，不会误匹配', () => {
  const file = tmpHtml(`
    <!-- EDITMODE-BEGIN id="hero.x*y" -->
    <script type="application/json" id="hero.x*y">{"v":1}</script>
    <!-- EDITMODE-END -->
  `)
  applyTweaks({ htmlAbsPath: file, blockId: 'hero.x*y', newValues: { v: 9 }, backup: false })
  const after = fs.readFileSync(file, 'utf-8')
  assert.ok(after.includes('"v": 9'))
})
