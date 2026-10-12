/**
 * Standing Orders 单元测试（v18 OpenClaw 借鉴）
 *
 * 覆盖：
 *   - readStandingOrders：不存在 / 已存在
 *   - countStandingOrders：空 / 多条
 *   - appendStandingOrder：首次写入建 header / 累加追加 / 空白拒绝 / 过长拒绝 / 上限拒绝
 *   - 单条内换行被替换为空格（防破坏 markdown 列表结构）
 *   - source 字段透传 + 注释格式
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  readStandingOrders,
  countStandingOrders,
  appendStandingOrder,
  MAX_STANDING_ORDERS,
  MAX_ORDER_LENGTH,
} from '../memory/standing-orders'

function withTempDir(body: (avatarsPath: string, avatarId: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standing-orders-test-'))
  const avatarId = 'a1'
  try {
    body(root, avatarId)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe('standing-orders', () => {
  it('文件不存在时 readStandingOrders 返回空串', () => {
    withTempDir((avatarsPath, avatarId) => {
      assert.equal(readStandingOrders(avatarsPath, avatarId), '')
      assert.equal(countStandingOrders(avatarsPath, avatarId), 0)
    })
  })

  it('首次 append 自动建 markdown header + 写入条目', () => {
    withTempDir((avatarsPath, avatarId) => {
      const res = appendStandingOrder(avatarsPath, avatarId, '工商储方案必须先算 IRR', 'conv-1')
      assert.ok(res.ok)
      assert.equal(res.total, 1)
      const content = readStandingOrders(avatarsPath, avatarId)
      assert.ok(content.includes('# Standing Orders'))
      assert.ok(content.includes('- 工商储方案必须先算 IRR'))
      assert.ok(content.includes('source=conv-1'))
    })
  })

  it('多次 append 累加', () => {
    withTempDir((avatarsPath, avatarId) => {
      appendStandingOrder(avatarsPath, avatarId, '规则 1')
      appendStandingOrder(avatarsPath, avatarId, '规则 2')
      const res = appendStandingOrder(avatarsPath, avatarId, '规则 3')
      assert.ok(res.ok)
      assert.equal(res.total, 3)
      assert.equal(countStandingOrders(avatarsPath, avatarId), 3)
    })
  })

  it('空白 order 拒绝', () => {
    withTempDir((avatarsPath, avatarId) => {
      const res = appendStandingOrder(avatarsPath, avatarId, '   \n\t  ')
      assert.equal(res.ok, false)
      assert.equal(countStandingOrders(avatarsPath, avatarId), 0)
    })
  })

  it('单条过长拒绝（不污染文件）', () => {
    withTempDir((avatarsPath, avatarId) => {
      const res = appendStandingOrder(avatarsPath, avatarId, 'X'.repeat(MAX_ORDER_LENGTH + 1))
      assert.equal(res.ok, false)
      assert.equal(countStandingOrders(avatarsPath, avatarId), 0)
    })
  })

  it('达数量上限后拒绝（条数不增）', () => {
    withTempDir((avatarsPath, avatarId) => {
      for (let i = 0; i < MAX_STANDING_ORDERS; i++) {
        const r = appendStandingOrder(avatarsPath, avatarId, `规则 ${i}`)
        assert.ok(r.ok, `第 ${i} 条应成功`)
      }
      const overflow = appendStandingOrder(avatarsPath, avatarId, '超额规则')
      assert.equal(overflow.ok, false)
      assert.match(overflow.error!, /上限/)
      assert.equal(countStandingOrders(avatarsPath, avatarId), MAX_STANDING_ORDERS)
    })
  })

  it('单条内含换行：自动替换为空格，不破坏 markdown 列表', () => {
    withTempDir((avatarsPath, avatarId) => {
      appendStandingOrder(avatarsPath, avatarId, '规则 行 1\n行 2\n行 3')
      const content = readStandingOrders(avatarsPath, avatarId)
      // 单条 entry 必须只占一行（以 - 开头）
      const orderLines = content.split('\n').filter(l => /^- /.test(l))
      assert.equal(orderLines.length, 1)
      assert.ok(orderLines[0].includes('行 1 行 2 行 3'))
    })
  })

  it('source 字段含换行被清洗', () => {
    withTempDir((avatarsPath, avatarId) => {
      appendStandingOrder(avatarsPath, avatarId, '规则', 'conv-a\nconv-b')
      const content = readStandingOrders(avatarsPath, avatarId)
      // source 注释应该单行
      const sourceLines = content.split('\n').filter(l => l.includes('source='))
      assert.equal(sourceLines.length, 1)
      assert.ok(sourceLines[0].includes('source=conv-a conv-b'))
    })
  })

  it('order trim 前后空白', () => {
    withTempDir((avatarsPath, avatarId) => {
      appendStandingOrder(avatarsPath, avatarId, '  规则  ')
      const content = readStandingOrders(avatarsPath, avatarId)
      assert.ok(content.includes('- 规则'))
    })
  })

  it('source 缺省时用 "manual"', () => {
    withTempDir((avatarsPath, avatarId) => {
      appendStandingOrder(avatarsPath, avatarId, '默认规则')
      const content = readStandingOrders(avatarsPath, avatarId)
      assert.ok(content.includes('source=manual'))
    })
  })
})
