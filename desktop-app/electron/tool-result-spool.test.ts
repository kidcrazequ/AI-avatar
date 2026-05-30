/**
 * ToolResultSpool 单测（Stage 三 P2 #15）。
 *
 * 验证点：
 *   1. 小于阈值的内容原样返回，不落盘
 *   2. 超过阈值时落盘到 conversationId 子目录，content 改为头/尾摘要 + 路径提示
 *   3. 写文件后路径可读、内容完整
 *   4. cleanup() 删除超过 retention 的旧文件，并清理空目录
 *   5. 工具名含特殊字符（路径穿越尝试）被清洗为安全 segment
 *   6. 非法 conversationId（如 ../） 走兜底分支返回截断内容、不抛错
 *   7. listForConversation 按 mtime 倒序返回
 *
 * @author zhi.qu
 * @date 2026-04-29
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolResultSpool, readSpoolLineRange } from './tool-result-spool'

function makeTempUserData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soul-spool-test-'))
}

/** 写一个临时文件并返回路径（readSpoolLineRange 用例） */
function writeTempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-spool-read-'))
  const file = path.join(dir, 'spool.txt')
  fs.writeFileSync(file, content, 'utf-8')
  return file
}

test('ToolResultSpool: 小内容原样返回，不落盘', () => {
  const userData = makeTempUserData()
  const spool = new ToolResultSpool(userData, { threshold: 1000 })
  const out = spool.spool('conv-1', 'query_excel', 'short content')
  assert.equal(out.spilled, false)
  assert.equal(out.content, 'short content')
  assert.equal(out.path, undefined)
  assert.equal(out.originalLength, 'short content'.length)
})

test('ToolResultSpool: 超阈值内容落盘 + 头尾摘要 + 路径提示', () => {
  const userData = makeTempUserData()
  const spool = new ToolResultSpool(userData, {
    threshold: 100,
    headChars: 30,
    tailChars: 20,
  })
  const original = 'A'.repeat(50) + 'MID' + 'B'.repeat(80)
  const out = spool.spool('conv-2', 'search_knowledge', original)

  assert.equal(out.spilled, true, '应触发落盘')
  assert.ok(out.path, '应返回路径')
  assert.equal(out.originalLength, original.length)
  assert.ok(fs.existsSync(out.path!), '落盘文件应存在')

  // 文件内容应完整
  const onDisk = fs.readFileSync(out.path!, 'utf-8')
  assert.equal(onDisk, original)

  // 摘要应包含头部、尾部、路径提示
  assert.ok(out.content.startsWith('A'.repeat(30)), '应以头部 30 个 A 开头')
  assert.ok(out.content.includes('中段已省略'), '应包含中段省略提示')
  assert.ok(out.content.includes('B'.repeat(20)), '应包含尾部 20 个 B')
  assert.ok(out.content.includes(out.path!), '应包含完整路径')
  assert.ok(out.content.includes('read_file'), '应提示用 read_file 拉取全文')
})

test('ToolResultSpool: threshold=0 禁用落盘', () => {
  const userData = makeTempUserData()
  const spool = new ToolResultSpool(userData, { threshold: 0 })
  const big = 'x'.repeat(50_000)
  const out = spool.spool('conv-3', 't', big)
  assert.equal(out.spilled, false)
  assert.equal(out.content.length, 50_000)
})

test('ToolResultSpool: 落盘文件按 conversationId 分目录', () => {
  const userData = makeTempUserData()
  const spool = new ToolResultSpool(userData, { threshold: 10 })
  spool.spool('conv-A', 'tool1', 'this is a long enough content to spool')
  spool.spool('conv-B', 'tool2', 'another long enough content for spooling')

  const dirA = path.join(spool.getRootDir(), 'conv-A')
  const dirB = path.join(spool.getRootDir(), 'conv-B')
  assert.equal(fs.existsSync(dirA), true)
  assert.equal(fs.existsSync(dirB), true)
  assert.ok(fs.readdirSync(dirA).length >= 1)
  assert.ok(fs.readdirSync(dirB).length >= 1)
})

test('ToolResultSpool: 非法 conversationId（路径穿越）走兜底分支', () => {
  const userData = makeTempUserData()
  const spool = new ToolResultSpool(userData, { threshold: 10 })
  const out = spool.spool('../evil', 'tool', 'this is a long enough content to spool')
  // 落盘失败但不抛错；返回截断内容 + 错误提示
  assert.equal(out.spilled, false)
  assert.ok(out.content.includes('落盘失败') || out.content.length > 0)
  // evil 目录绝不应在 root 之外被创建
  assert.equal(fs.existsSync(path.join(userData, 'evil')), false)
})

test('ToolResultSpool: 工具名含特殊字符会被清洗', () => {
  const userData = makeTempUserData()
  const spool = new ToolResultSpool(userData, { threshold: 10 })
  const out = spool.spool('conv-clean', '../bad/name space', 'long enough content for spool')
  assert.equal(out.spilled, true)
  // 文件名内不应出现 / 或 .. 或空格
  const fname = path.basename(out.path!)
  assert.ok(!fname.includes('/') && !fname.includes('..') && !fname.includes(' '),
    `期望清洗后的文件名，实际：${fname}`)
})

test('ToolResultSpool.cleanup: 删除超过 retentionDays 的文件', () => {
  const userData = makeTempUserData()
  const spool = new ToolResultSpool(userData, { threshold: 10 })

  // 创建 2 个文件：一个新的、一个改成 30 天前 mtime
  spool.spool('conv-old', 't', 'long enough content for spool')
  const dirOld = path.join(spool.getRootDir(), 'conv-old')
  const oldFiles = fs.readdirSync(dirOld)
  assert.equal(oldFiles.length, 1)
  const oldPath = path.join(dirOld, oldFiles[0])

  const past = Date.now() / 1000 - 30 * 24 * 60 * 60
  fs.utimesSync(oldPath, past, past)

  spool.spool('conv-new', 't', 'long enough content for spool')

  const stat = spool.cleanup(7)
  assert.ok(stat.removedFiles >= 1, '应清理 1 个旧文件')
  assert.equal(fs.existsSync(oldPath), false, '旧文件应被删除')

  // 新文件应保留
  const dirNew = path.join(spool.getRootDir(), 'conv-new')
  assert.ok(fs.existsSync(dirNew))
  assert.ok(fs.readdirSync(dirNew).length >= 1)
})

test('ToolResultSpool.cleanup: 空目录被一并删除', () => {
  const userData = makeTempUserData()
  const spool = new ToolResultSpool(userData, { threshold: 10 })
  spool.spool('conv-empty', 't', 'long enough content for spool')
  const dir = path.join(spool.getRootDir(), 'conv-empty')
  // 把里面文件 mtime 改到 30 天前
  for (const f of fs.readdirSync(dir)) {
    const past = Date.now() / 1000 - 30 * 24 * 60 * 60
    fs.utimesSync(path.join(dir, f), past, past)
  }
  const stat = spool.cleanup(7)
  assert.ok(stat.removedFiles >= 1)
  assert.ok(stat.removedDirs >= 1)
  assert.equal(fs.existsSync(dir), false, '空目录应被删除')
})

test('ToolResultSpool.listForConversation: 按 mtime 倒序', async () => {
  const userData = makeTempUserData()
  const spool = new ToolResultSpool(userData, { threshold: 10 })
  spool.spool('conv-list', 'tool1', 'first long content for spool')
  // 等 5ms 保证 mtime 不同
  await new Promise((resolve) => setTimeout(resolve, 5))
  spool.spool('conv-list', 'tool2', 'second long content for spool')

  const list = spool.listForConversation('conv-list')
  assert.equal(list.length, 2)
  assert.ok(list[0].mtime >= list[1].mtime, '第一个应是最新的')
  assert.ok(list[0].file.includes('tool2'))
})

test('ToolResultSpool.listForConversation: 不存在会话返回空数组', () => {
  const userData = makeTempUserData()
  const spool = new ToolResultSpool(userData)
  assert.deepEqual(spool.listForConversation('not-exist'), [])
})

// ─── readSpoolLineRange：流式按字节读取，超长单行不会整体进内存 ────────────────

test('readSpoolLineRange: 普通多行区间返回带行号、不算截断', async () => {
  const file = writeTempFile('L1\nL2\nL3\nL4\nL5')
  const r = await readSpoolLineRange(file, 2, 4)
  assert.equal(r.body, '2|L2\n3|L3\n4|L4')
  assert.equal(r.cappedEnd, 4)
  assert.equal(r.truncated, false, '拿到完整请求区间即使后面还有行也不算截断')
  assert.equal(r.byteCapped, false)
})

test('readSpoolLineRange: trailing newline 不多算一行', async () => {
  const file = writeTempFile('L1\nL2\n')
  const r = await readSpoolLineRange(file, 1, 100)
  assert.equal(r.body, '1|L1\n2|L2')
  assert.equal(r.lastLine, 2)
})

test('readSpoolLineRange: 请求超过文件行数 → cappedEnd 截到 EOF 且 truncated', async () => {
  const file = writeTempFile('L1\nL2\nL3')
  const r = await readSpoolLineRange(file, 1, 100)
  assert.equal(r.lastLine, 3)
  assert.equal(r.cappedEnd, 3)
  assert.equal(r.truncated, true, 'requestedEnd>cappedEnd（EOF 先到）应算截断')
})

test('readSpoolLineRange: start_line 超过总行数 → lastLine<startLine、body 空', async () => {
  const file = writeTempFile('L1\nL2\nL3')
  const r = await readSpoolLineRange(file, 10, 12)
  assert.equal(r.body, '')
  assert.ok(r.lastLine < 10, '调用方据此回报「超过总行数」')
})

test('readSpoolLineRange: 单行超大 minified 内容只读到字节上限即停（不整体进内存）', async () => {
  // 50 个 X、无换行：模拟一行超大 JSON。maxBodyBytes=20 → 只收 20 个内容字节后立即截断。
  const file = writeTempFile('X'.repeat(50))
  const r = await readSpoolLineRange(file, 1, 200, { maxBodyBytes: 20 })
  assert.equal(r.body, '1|' + 'X'.repeat(20), '只应收集到字节预算内的内容')
  assert.equal(r.lastLine, 1)
  assert.equal(r.cappedEnd, 1)
  assert.equal(r.byteCapped, true)
  assert.equal(r.truncated, true)
})

test('readSpoolLineRange: 多行累计触及字节上限 → 在行边界截断', async () => {
  const file = writeTempFile('AAAA\nBBBB\nCCCC\nDDDD')
  // line1 "1|AAAA"=6+1 → bodyBytes=7；line2 "2|BBBB"=6+1 → bodyBytes=14 触顶
  const r = await readSpoolLineRange(file, 1, 200, { maxBodyBytes: 14 })
  assert.equal(r.body, '1|AAAA\n2|BBBB')
  assert.equal(r.cappedEnd, 2)
  assert.equal(r.byteCapped, true)
  assert.equal(r.truncated, true)
})

test('readSpoolLineRange: 行数硬上限提前截断', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n')
  const file = writeTempFile(lines)
  const r = await readSpoolLineRange(file, 1, 100, { hardLineCap: 5 })
  assert.equal(r.cappedEnd, 6, 'startLine(1) + hardLineCap(5) = 6')
  assert.equal(r.body.split('\n').length, 6)
  assert.equal(r.truncated, true, 'cappedEnd<requestedEnd（行数被砍）应算截断')
  assert.equal(r.byteCapped, false)
})
