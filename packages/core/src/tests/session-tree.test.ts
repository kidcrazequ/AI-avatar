/**
 * 会话树模型单测（借鉴 Pi 树状会话）。
 *
 * 为什么这些测试存在（Rule 9）：活动路径算错会让用户看到错乱/缺失的对话历史；环保护缺失
 * 会在坏数据下死循环冻结主进程。线性场景必须等价于"扁平顺序"（保证落地后零行为变化）。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildActivePath,
  backfillLinearParents,
  findBranchPoints,
} from '../session-tree'

describe('buildActivePath', () => {
  test('线性链：root→leaf 顺序，等价扁平顺序', () => {
    const nodes = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: 'b' },
    ]
    assert.deepEqual(buildActivePath(nodes, 'c').map((n) => n.id), ['a', 'b', 'c'])
  })

  test('分叉树：只收某叶子那条活动路径，不含另一分支', () => {
    const nodes = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'c1', parentId: 'b' }, // 分支 1
      { id: 'c2', parentId: 'b' }, // 分支 2
    ]
    assert.deepEqual(buildActivePath(nodes, 'c1').map((n) => n.id), ['a', 'b', 'c1'])
    assert.deepEqual(buildActivePath(nodes, 'c2').map((n) => n.id), ['a', 'b', 'c2'])
  })

  test('leaf 不存在 / 空 → 空路径', () => {
    assert.deepEqual(buildActivePath([{ id: 'a' }], 'zzz'), [])
    assert.deepEqual(buildActivePath([{ id: 'a' }], null), [])
    assert.deepEqual(buildActivePath([{ id: 'a' }], undefined), [])
  })

  test('环保护：坏数据自引用/互引不死循环', () => {
    const nodes = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ]
    const path = buildActivePath(nodes, 'x')
    assert.ok(path.length <= 2) // 不无限增长
  })
})

describe('backfillLinearParents', () => {
  test('每条指向前一条，首条 null', () => {
    assert.deepEqual(
      backfillLinearParents([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
      [
        { id: 'a', parentId: null },
        { id: 'b', parentId: 'a' },
        { id: 'c', parentId: 'b' },
      ],
    )
  })
  test('回填结果喂回 buildActivePath 还原原顺序', () => {
    const ordered = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const linked = backfillLinearParents(ordered)
    assert.deepEqual(buildActivePath(linked, 'c').map((n) => n.id), ['a', 'b', 'c'])
  })
})

describe('findBranchPoints', () => {
  test('识别有多个子分支的节点', () => {
    const nodes = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'c1', parentId: 'b' },
      { id: 'c2', parentId: 'b' },
    ]
    assert.deepEqual(findBranchPoints(nodes), ['b'])
  })
  test('纯线性无分叉点', () => {
    const nodes = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
    ]
    assert.deepEqual(findBranchPoints(nodes), [])
  })
})
