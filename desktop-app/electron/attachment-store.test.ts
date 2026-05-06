/**
 * AttachmentStore 单测（对话框附件扩展，子任务 1）。
 *
 * 验证点：
 *   1. 落盘后能按 hash 找回相同绝对路径
 *   2. 同 hash 内容重复落盘不会重写文件
 *   3. 路径穿越（conversationId 含 ..）被拒绝
 *   4. getAttachmentAbsPath 对非法 hash / ext 立即抛错
 *   5. deleteAttachmentsByConversation 删除整个会话目录且幂等
 *   6. 超过 MAX_ATTACHMENT_FILE_BYTES 抛错
 *
 * @author zhi.qu
 * @date 2026-05-01
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AttachmentStore, MAX_ATTACHMENT_FILE_BYTES } from './attachment-store'

function makeTempUserData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soul-attach-test-'))
}

test('AttachmentStore: 落盘后可按 hash + ext 重新解析路径', () => {
  const userData = makeTempUserData()
  const store = new AttachmentStore(userData)
  const buffer = Buffer.from('hello world', 'utf-8')
  const saved = store.saveAttachment('conv-1', 'note.md', buffer)

  assert.ok(saved.id.startsWith('att_'), 'id 应有 att_ 前缀')
  assert.equal(saved.ext, '.md')
  assert.equal(saved.size, buffer.length)
  assert.ok(fs.existsSync(saved.storedPath), '落盘文件应存在')
  assert.equal(fs.readFileSync(saved.storedPath, 'utf-8'), 'hello world')

  const resolved = store.getAttachmentAbsPath('conv-1', saved.hash, saved.ext)
  assert.equal(resolved, saved.storedPath)
})

test('AttachmentStore: 同内容重复落盘走去重，不重写', () => {
  const userData = makeTempUserData()
  const store = new AttachmentStore(userData)
  const buf = Buffer.from('idempotent content', 'utf-8')
  const a = store.saveAttachment('conv-2', 'a.txt', buf)
  const mtimeA = fs.statSync(a.storedPath).mtimeMs

  // 略等一会再写，确保如果有重写就能从 mtime 看出来
  const start = Date.now()
  while (Date.now() - start < 5) { /* spin */ }

  const b = store.saveAttachment('conv-2', 'b.txt', buf)
  assert.equal(b.storedPath, a.storedPath, '同 hash 应落到同一文件')
  assert.equal(fs.statSync(b.storedPath).mtimeMs, mtimeA, '同 hash 不应触发重写')
  // 但元信息（id / name）按调用次数生成，互不相同
  assert.notEqual(a.id, b.id)
  assert.equal(b.name, 'b.txt')
})

test('AttachmentStore: conversationId 含路径穿越段被拒绝', () => {
  const userData = makeTempUserData()
  const store = new AttachmentStore(userData)
  assert.throws(() =>
    store.saveAttachment('../evil', 'x.txt', Buffer.from('payload')),
  /非法|穿越|分隔/)
  // evil 目录绝不应被创建
  assert.equal(fs.existsSync(path.join(userData, 'evil')), false)
  assert.equal(fs.existsSync(path.join(userData, 'attachments', '..', 'evil')), false)
})

test('AttachmentStore: getAttachmentAbsPath 拒绝非法 hash / ext', () => {
  const userData = makeTempUserData()
  const store = new AttachmentStore(userData)
  assert.throws(() => store.getAttachmentAbsPath('conv-1', 'not-a-hash', '.md'), /非法附件 hash/)
  // 非法后缀（含 / 或 ..）
  const validHash = 'a'.repeat(64)
  assert.throws(() => store.getAttachmentAbsPath('conv-1', validHash, '../etc'), /非法附件后缀/)
  // 文件不存在抛错
  assert.throws(() => store.getAttachmentAbsPath('conv-1', validHash, '.md'), /不存在/)
})

test('AttachmentStore: deleteAttachmentsByConversation 删除目录且幂等', () => {
  const userData = makeTempUserData()
  const store = new AttachmentStore(userData)
  store.saveAttachment('conv-3', 'a.md', Buffer.from('AAA'))
  store.saveAttachment('conv-3', 'b.md', Buffer.from('BBB'))
  const convDir = path.join(store.getRootDir(), 'conv-3')
  assert.equal(fs.existsSync(convDir), true)
  assert.equal(fs.readdirSync(convDir).length, 2)

  store.deleteAttachmentsByConversation('conv-3')
  assert.equal(fs.existsSync(convDir), false, '目录应被删除')

  // 重复删除不应抛错
  store.deleteAttachmentsByConversation('conv-3')
})

test('AttachmentStore: 超过 50MB 抛错', () => {
  const userData = makeTempUserData()
  const store = new AttachmentStore(userData)
  // 用 alloc 而不是 alloc(0)，分配真实内存避免 sparse 优化
  const oversize = Buffer.alloc(MAX_ATTACHMENT_FILE_BYTES + 1, 0)
  assert.throws(
    () => store.saveAttachment('conv-4', 'big.bin', oversize),
    /附件过大/,
  )
})

test('AttachmentStore: 空 buffer 抛错', () => {
  const userData = makeTempUserData()
  const store = new AttachmentStore(userData)
  assert.throws(
    () => store.saveAttachment('conv-5', 'empty.txt', Buffer.alloc(0)),
    /内容为空/,
  )
})
