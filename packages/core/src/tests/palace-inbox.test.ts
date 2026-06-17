/**
 * Palace 任务后沉淀 inbox 测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  PALACE_SCHEMA_VERSION,
  addPalaceInboxItemToDocument,
  filterPalaceInboxItems,
  generatePalaceInboxItemId,
  updatePalaceInboxItemInDocument,
  type PalaceInboxDocument,
  type PalaceInboxItem,
} from '../index'

const NOW = new Date('2026-06-17T08:00:00.000Z')

describe('palace inbox', () => {
  it('生成稳定递增的 inbox id', () => {
    const existing: PalaceInboxItem[] = [
      baseItem('inbox-20260617-001', '项目进展'),
      baseItem('inbox-20260617-004', '复用写法'),
      baseItem('inbox-20260616-099', '昨天'),
    ]
    assert.equal(generatePalaceInboxItemId(existing, NOW), 'inbox-20260617-005')
  })

  it('新增和更新 pending 沉淀项', () => {
    const empty: PalaceInboxDocument = { schemaVersion: PALACE_SCHEMA_VERSION, items: [] }
    const added = addPalaceInboxItemToDocument(empty, {
      kind: 'project',
      title: '项目进入报价阶段',
      content: 'XX 项目已经进入报价阶段，下次写周报需要提到报价风险。',
      target: 'projects',
      source: '本次周报任务',
      confidence: 0.82,
      tags: ['周报', '报价', '周报'],
    }, NOW)

    assert.equal(added.item.id, 'inbox-20260617-001')
    assert.equal(added.item.status, 'pending')
    assert.equal(added.item.confidence, 0.82)
    assert.deepEqual(added.item.tags, ['周报', '报价'])

    const updated = updatePalaceInboxItemInDocument(added.document, added.item.id, {
      status: 'accepted',
      target: 'reports',
      confidence: null,
    }, new Date('2026-06-18T02:00:00.000Z'))

    assert.equal(updated.item.status, 'accepted')
    assert.equal(updated.item.target, 'reports')
    assert.equal(updated.item.confidence, undefined)
  })

  it('默认只列 pending，并支持 includeResolved / kind / target / query', () => {
    const doc: PalaceInboxDocument = {
      schemaVersion: PALACE_SCHEMA_VERSION,
      items: [
        { ...baseItem('pending-project', '报价阶段', 'project'), target: 'projects', tags: ['报价'] },
        { ...baseItem('pending-writing', '老板口径', 'writing'), target: 'reports', content: '王总只看数字、风险、下一步。' },
        { ...baseItem('accepted', '已归档', 'fact'), status: 'accepted', target: 'wiki' },
        { ...baseItem('rejected', '误判', 'fact'), status: 'rejected', target: 'wiki' },
      ],
    }

    assert.deepEqual(filterPalaceInboxItems(doc).map(item => item.id), ['pending-project', 'pending-writing'])
    assert.deepEqual(filterPalaceInboxItems(doc, { includeResolved: true }).map(item => item.id), [
      'pending-project',
      'pending-writing',
      'accepted',
      'rejected',
    ])
    assert.deepEqual(filterPalaceInboxItems(doc, { kind: 'writing' }).map(item => item.id), ['pending-writing'])
    assert.deepEqual(filterPalaceInboxItems(doc, { target: 'projects' }).map(item => item.id), ['pending-project'])
    assert.deepEqual(filterPalaceInboxItems(doc, { query: '王总' }).map(item => item.id), ['pending-writing'])
  })

  it('拒绝非法置信度和非法 target', () => {
    const empty: PalaceInboxDocument = { schemaVersion: PALACE_SCHEMA_VERSION, items: [] }
    assert.throws(() => addPalaceInboxItemToDocument(empty, {
      title: '坏置信度',
      content: 'content',
      confidence: 2,
    }), /confidence/)
    assert.throws(() => addPalaceInboxItemToDocument(empty, {
      title: '坏 target',
      content: 'content',
      target: 'bad-target' as never,
    }), /sediment target/)
  })
})

function baseItem(id: string, title: string, kind: PalaceInboxItem['kind'] = 'fact'): PalaceInboxItem {
  return {
    id,
    kind,
    title,
    content: title,
    status: 'pending',
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
  }
}
