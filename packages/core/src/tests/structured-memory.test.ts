/**
 * structured-memory 单元测试
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseStructuredMemoryDocumentJson,
  formatStructuredMemoryEntriesForPrompt,
  buildLongTermMemoryInjectionBody,
  getCombinedMemoryInjectionStats,
  assertStructuredMemoryDocumentPayload,
  STRUCTURED_MEMORY_MAX_CONTENT_CHARS,
} from '../structured-memory'

const validEntry = {
  id: 'e1',
  createdAt: '2026-05-08T10:00:00.000Z',
  updatedAt: '2026-05-09T08:00:00.000Z',
  category: 'correction',
  content: '用户偏好使用 kW 而非 MW。',
  source: 'manual',
}

describe('structured-memory', () => {
  it('parseStructuredMemoryDocumentJson 接受合法文档', () => {
    const raw = JSON.stringify({ schemaVersion: 1, entries: [validEntry] })
    const doc = parseStructuredMemoryDocumentJson(raw)
    assert.ok(doc)
    assert.equal(doc?.entries.length, 1)
    assert.equal(doc?.entries[0].id, 'e1')
  })

  it('parseStructuredMemoryDocumentJson 拒绝非法 schemaVersion', () => {
    assert.equal(parseStructuredMemoryDocumentJson(JSON.stringify({ schemaVersion: 2, entries: [] })), null)
  })

  it('parseStructuredMemoryDocumentJson 拒绝超长 content', () => {
    const long = 'x'.repeat(STRUCTURED_MEMORY_MAX_CONTENT_CHARS + 1)
    const raw = JSON.stringify({
      schemaVersion: 1,
      entries: [{ ...validEntry, id: 'x', content: long }],
    })
    assert.equal(parseStructuredMemoryDocumentJson(raw), null)
  })

  it('formatStructuredMemoryEntriesForPrompt 含标题与字段', () => {
    const md = formatStructuredMemoryEntriesForPrompt([validEntry])
    assert.match(md, /结构化记忆/)
    assert.match(md, /correction/)
    assert.match(md, /e1/)
    assert.match(md, /用户偏好/)
  })

  it('buildLongTermMemoryInjectionBody 合并 legacy', () => {
    const s = formatStructuredMemoryEntriesForPrompt([validEntry])
    const body = buildLongTermMemoryInjectionBody(s, '# Legacy\n\nhello')
    assert.match(body, /结构化记忆/)
    assert.match(body, /MEMORY\.md（兼容）/)
    assert.match(body, /Legacy/)
  })

  it('buildLongTermMemoryInjectionBody 仅 legacy', () => {
    assert.equal(buildLongTermMemoryInjectionBody('', 'plain'), 'plain')
  })

  it('getCombinedMemoryInjectionStats 条目数含两边', () => {
    const s = formatStructuredMemoryEntriesForPrompt([validEntry])
    const stats = getCombinedMemoryInjectionStats(s, '<!-- 2026-05-09 -->\nx', 1)
    assert.ok(stats.chars > 0)
    assert.equal(stats.entries, 2)
  })

  it('assertStructuredMemoryDocumentPayload 拒绝坏载荷', () => {
    assert.throws(() => assertStructuredMemoryDocumentPayload({ schemaVersion: 1, entries: 'nope' }), /structured_memory_invalid/)
  })
})
