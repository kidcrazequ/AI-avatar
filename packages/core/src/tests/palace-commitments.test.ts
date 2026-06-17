/**
 * Palace 承诺闭环账本测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  PALACE_SCHEMA_VERSION,
  addPalaceCommitmentToDocument,
  filterPalaceCommitments,
  generatePalaceCommitmentId,
  getPalaceCommitmentUrgency,
  updatePalaceCommitmentInDocument,
  type PalaceCommitment,
  type PalaceCommitmentDocument,
} from '../index'

const NOW = new Date('2026-06-17T08:00:00.000Z')

describe('palace commitments', () => {
  it('生成稳定递增的承诺 id', () => {
    const existing: PalaceCommitment[] = [
      baseCommitment('cmt-20260617-001', '已有 1', '2026-06-18'),
      baseCommitment('cmt-20260617-004', '已有 4', '2026-06-19'),
      baseCommitment('cmt-20260616-099', '昨天', '2026-06-16'),
    ]
    assert.equal(generatePalaceCommitmentId(existing, NOW), 'cmt-20260617-005')
  })

  it('新增和更新承诺记录', () => {
    const empty: PalaceCommitmentDocument = { schemaVersion: PALACE_SCHEMA_VERSION, commitments: [] }
    const added = addPalaceCommitmentToDocument(empty, {
      title: '周五前交测算',
      counterparty: '王总',
      promise: '周五前给出储能测算版本',
      direction: 'i_owe_them',
      dueAt: '2026-06-19',
      tags: ['周报', '测算', '周报'],
    }, NOW)

    assert.equal(added.commitment.id, 'cmt-20260617-001')
    assert.deepEqual(added.commitment.tags, ['周报', '测算'])

    const updated = updatePalaceCommitmentInDocument(added.document, added.commitment.id, {
      status: 'done',
      dueAt: null,
      appendNote: '已交付 V1。',
    }, new Date('2026-06-18T02:00:00.000Z'))

    assert.equal(updated.commitment.status, 'done')
    assert.equal(updated.commitment.dueAt, undefined)
    assert.deepEqual(updated.commitment.notes, ['已交付 V1。'])
  })

  it('按逾期/到期/近期到期排序，并默认排除关闭项', () => {
    const doc: PalaceCommitmentDocument = {
      schemaVersion: PALACE_SCHEMA_VERSION,
      commitments: [
        baseCommitment('scheduled', '下周交付', '2026-06-24'),
        baseCommitment('today', '今天回邮件', '2026-06-17'),
        baseCommitment('overdue', '昨天补材料', '2026-06-16'),
        baseCommitment('soon', '三天内确认', '2026-06-20'),
        { ...baseCommitment('closed', '已完成', '2026-06-15'), status: 'done' },
        { ...baseCommitment('no-due', '无截止日', undefined), updatedAt: '2026-06-17T09:00:00.000Z' },
      ],
    }

    const openViews = filterPalaceCommitments(doc, { now: NOW })
    assert.deepEqual(openViews.map(v => [v.id, v.urgency, v.daysUntilDue]), [
      ['overdue', 'overdue', -1],
      ['today', 'due_today', 0],
      ['soon', 'due_soon', 3],
      ['scheduled', 'scheduled', 7],
      ['no-due', 'no_due', null],
    ])

    const withClosed = filterPalaceCommitments(doc, { includeClosed: true, now: NOW })
    assert.equal(withClosed.at(-1)?.id, 'closed')
    assert.equal(getPalaceCommitmentUrgency(withClosed.at(-1)!, NOW), 'closed')
  })

  it('支持状态、方向、关键词和截止日过滤', () => {
    const doc: PalaceCommitmentDocument = {
      schemaVersion: PALACE_SCHEMA_VERSION,
      commitments: [
        { ...baseCommitment('mine', '给客户报价', '2026-06-18'), counterparty: '客户 A', tags: ['报价'] },
        { ...baseCommitment('theirs', '等财务回款', '2026-06-30'), direction: 'they_owe_me', counterparty: '财务', tags: ['回款'] },
        { ...baseCommitment('blocked', '等资料', '2026-06-19'), status: 'blocked', notes: ['客户还没给资料'] },
      ],
    }

    assert.deepEqual(filterPalaceCommitments(doc, { query: '客户 A', now: NOW }).map(v => v.id), ['mine'])
    assert.deepEqual(filterPalaceCommitments(doc, { direction: 'they_owe_me', now: NOW }).map(v => v.id), ['theirs'])
    assert.deepEqual(filterPalaceCommitments(doc, { status: 'blocked', now: NOW }).map(v => v.id), ['blocked'])
    assert.deepEqual(filterPalaceCommitments(doc, { dueBefore: '2026-06-19', now: NOW }).map(v => v.id), ['mine', 'blocked'])
  })
})

function baseCommitment(id: string, title: string, dueAt?: string): PalaceCommitment {
  return {
    id,
    direction: 'i_owe_them',
    title,
    counterparty: '王总',
    promise: title,
    status: 'open',
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    ...(dueAt ? { dueAt } : {}),
  }
}
