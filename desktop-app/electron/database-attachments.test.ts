/**
 * database.ts 附件相关 CRUD 单测（对话框附件扩展，子任务 8）。
 *
 * 验证点：
 *   1. v8 migration 能在干净库上建出 attachments 表（schema 里包含 attachments 列定义）
 *   2. insertAttachment + getAttachmentById 往返一致
 *   3. listAttachmentsByConversation 按 created_at ASC 返回当前会话的附件
 *   4. linkAttachmentToMessage 把指定 id 的 message_id 字段批量更新
 *   5. deleteAttachmentsByConversation 删除附件行，且不影响其他会话
 *   6. 删除会话时联动删除其附件（cascade 路径）
 *   7. 二次创建 DatabaseManager 复用同一文件不会重复迁移、不抛错（迁移幂等）
 *
 * 实现注意：database.ts 顶部 `import { app } from 'electron'`，tsx 直接跑会因为 electron 仅在
 * Electron 运行时存在而失败。这里在 import 之前用 require.cache 注入一个最小 stub
 * （只暴露 app.getPath），然后用 CJS require 加载 database.ts，避免 ES import 被提升导致 stub 失效。
 *
 * @author zhi.qu
 * @date 2026-05-01
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── 注入 electron stub ────────────────────────────────────────────────
// 必须放在 require('./database') 之前。tsx 使用 CJS 输出，require.cache 命中即不再实际加载真模块。
const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-test-userdata-'))
const electronStubExports = {
  app: { getPath: (_key: string) => TMP_USER_DATA },
  shell: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
}
const electronResolvedId = (() => {
  try {
    return require.resolve('electron')
  } catch {
    return 'electron'
  }
})()
require.cache[electronResolvedId] = {
  id: electronResolvedId,
  filename: electronResolvedId,
  loaded: true,
  exports: electronStubExports,
  parent: null,
  children: [],
  paths: [],
} as unknown as NodeJS.Module

// ─── stub 完成后再加载真实模块 ──────────────────────────────────────────
// 用 require 而非 import：避免 ES import 在 CJS 输出里被提升到 stub 之前
// （`type: commonjs` 的项目里 tsx 把 import 转成 require，但顺序保留；
// 用显式 require 更稳，未来即使打包器变更也不会受影响）
//
// 另外：better-sqlite3 是原生模块，会按 Electron 的 ABI 编译（NODE_MODULE_VERSION 145），
// 与系统 node v22 (127) 不兼容。系统 Node 直跑时 require 会抛 ERR_DLOPEN_FAILED。
// 此时把整个 suite 优雅 skip，避免阻塞 CI；要跑这些 case 请走：
//   npm run smoke:verifier   （或在 npm rebuild 之后用系统 Node）
let DatabaseManagerCtor: typeof import('./database').DatabaseManager | null = null
let loadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./database') as typeof import('./database')
  DatabaseManagerCtor = mod.DatabaseManager
  // better-sqlite3 的原生绑定是 lazy 加载（只在 new Database(...) 时才解析），
  // 所以这里要做一次 throwaway 实例化来触发 ABI 校验。失败说明 NODE_MODULE_VERSION 不匹配。
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-test-probe-'))
  const probe = new DatabaseManagerCtor(path.join(probeDir, 'probe.db'))
  probe.close()
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
  DatabaseManagerCtor = null
}
const skipReason = loadError
  ? `跳过：本测试需要 better-sqlite3 原生绑定与当前 Node ABI 匹配（${loadError.split('\n')[0]}）`
  : null

function makeTempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-test-'))
  return path.join(dir, 'test.db')
}

function makeAttachment(overrides: Partial<{
  id: string
  conversation_id: string
  message_id: string | null
  name: string
  mime: string
  size: number
  hash: string
  ext: string
  summary: string | null
  outline: string | null
  parsed_meta: string | null
}> = {}) {
  const now = Date.now()
  const id = overrides.id ?? `att_${now}_${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    conversation_id: overrides.conversation_id ?? 'conv-1',
    message_id: overrides.message_id ?? null,
    name: overrides.name ?? 'note.md',
    mime: overrides.mime ?? 'text/markdown',
    size: overrides.size ?? 123,
    hash: overrides.hash ?? 'a'.repeat(64),
    ext: overrides.ext ?? '.md',
    summary: overrides.summary ?? '这是摘要',
    outline: overrides.outline ?? '一级标题',
    parsed_meta: overrides.parsed_meta ?? null,
    created_at: now,
  }
}

test('attachments: insertAttachment + getAttachmentById 往返', { skip: skipReason ?? undefined }, () => {
  const db = new DatabaseManagerCtor!(makeTempDbFile())
  db.ensureConversation('conv-1', '测试会话', 'a-1')
  const att = makeAttachment({ id: 'att_round_trip_1' })
  db.insertAttachment(att)
  const back = db.getAttachmentById('att_round_trip_1')
  assert.ok(back, '应能按 id 查回附件')
  assert.equal(back!.name, att.name)
  assert.equal(back!.mime, att.mime)
  assert.equal(back!.size, att.size)
  assert.equal(back!.hash, att.hash)
  assert.equal(back!.ext, att.ext)
  assert.equal(back!.summary, att.summary)
  assert.equal(back!.outline, att.outline)
  assert.equal(back!.message_id, null, '未关联消息时 message_id 为 null')
  db.close()
})

test('attachments: listAttachmentsByConversation 按 created_at ASC 返回', { skip: skipReason ?? undefined }, () => {
  const db = new DatabaseManagerCtor!(makeTempDbFile())
  db.ensureConversation('conv-list', 't', 'a-1')
  db.ensureConversation('conv-other', 't2', 'a-1')
  const a1 = makeAttachment({ id: 'att_l1', conversation_id: 'conv-list', name: 'first.md' })
  // 第二条手动晚一点，确保 created_at 严格递增
  const a2 = { ...makeAttachment({ id: 'att_l2', conversation_id: 'conv-list', name: 'second.pdf', ext: '.pdf' }), created_at: Date.now() + 5 }
  const a3 = makeAttachment({ id: 'att_other', conversation_id: 'conv-other', name: 'other.md' })
  db.insertAttachment(a1)
  db.insertAttachment(a2)
  db.insertAttachment(a3)

  const list = db.listAttachmentsByConversation('conv-list')
  assert.equal(list.length, 2, '只返回当前会话的两条')
  assert.deepEqual(list.map(r => r.id), ['att_l1', 'att_l2'])
  db.close()
})

test('attachments: linkAttachmentToMessage 批量回填 message_id', { skip: skipReason ?? undefined }, () => {
  const db = new DatabaseManagerCtor!(makeTempDbFile())
  db.ensureConversation('conv-link', 't', 'a-1')
  db.insertAttachment(makeAttachment({ id: 'att_link_1', conversation_id: 'conv-link' }))
  db.insertAttachment(makeAttachment({ id: 'att_link_2', conversation_id: 'conv-link' }))
  // 第三条不参与关联，验证未被波及
  db.insertAttachment(makeAttachment({ id: 'att_link_3', conversation_id: 'conv-link' }))

  const updated = db.linkAttachmentToMessage('msg-xyz', ['att_link_1', 'att_link_2'], 'conv-link')
  assert.equal(updated, 2, '应更新 2 行')
  assert.equal(db.getAttachmentById('att_link_1')!.message_id, 'msg-xyz')
  assert.equal(db.getAttachmentById('att_link_2')!.message_id, 'msg-xyz')
  assert.equal(db.getAttachmentById('att_link_3')!.message_id, null, '未被指定的附件 message_id 仍为 null')
  db.close()
})

test('attachments: deleteAttachmentsByConversation 仅删除目标会话', { skip: skipReason ?? undefined }, () => {
  const db = new DatabaseManagerCtor!(makeTempDbFile())
  db.ensureConversation('conv-del', 't', 'a-1')
  db.ensureConversation('conv-keep', 't2', 'a-1')
  db.insertAttachment(makeAttachment({ id: 'att_del_1', conversation_id: 'conv-del' }))
  db.insertAttachment(makeAttachment({ id: 'att_del_2', conversation_id: 'conv-del' }))
  db.insertAttachment(makeAttachment({ id: 'att_keep_1', conversation_id: 'conv-keep' }))

  db.deleteAttachmentsByConversation('conv-del')
  assert.equal(db.listAttachmentsByConversation('conv-del').length, 0)
  assert.equal(db.listAttachmentsByConversation('conv-keep').length, 1)
  assert.equal(db.getAttachmentById('att_keep_1')!.id, 'att_keep_1', '其他会话附件不受影响')
  db.close()
})

test('attachments: deleteConversation cascade 清理本会话附件', { skip: skipReason ?? undefined }, () => {
  const db = new DatabaseManagerCtor!(makeTempDbFile())
  db.ensureConversation('conv-cascade', 't', 'a-1')
  db.insertAttachment(makeAttachment({ id: 'att_cas_1', conversation_id: 'conv-cascade' }))
  db.insertAttachment(makeAttachment({ id: 'att_cas_2', conversation_id: 'conv-cascade' }))
  assert.equal(db.listAttachmentsByConversation('conv-cascade').length, 2)

  db.deleteConversation('conv-cascade')
  assert.equal(db.listAttachmentsByConversation('conv-cascade').length, 0, '删除会话应清理附件元信息')
  assert.equal(db.getAttachmentById('att_cas_1'), undefined)
  db.close()
})

test('attachments: 二次开库迁移幂等', { skip: skipReason ?? undefined }, () => {
  const dbPath = makeTempDbFile()
  const first = new DatabaseManagerCtor!(dbPath)
  first.ensureConversation('conv-mig', 't', 'a-1')
  first.insertAttachment(makeAttachment({ id: 'att_mig_1', conversation_id: 'conv-mig' }))
  first.close()

  const second = new DatabaseManagerCtor!(dbPath)
  const back = second.getAttachmentById('att_mig_1')
  assert.ok(back, '二次开库后旧附件仍可查询')
  assert.equal(back!.id, 'att_mig_1')
  second.close()
})
