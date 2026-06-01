/**
 * 会话树版本切换器纯逻辑单测（v21·phase2）。
 *
 * 为什么这些测试存在（Rule 9）：版本序号/总数算错 → ‹k/n› 显示错乱或该显示时不显示；
 * 分支尖端算错 → 切换后落到分支中段、丢失该分支后续轮次。
 *
 * @author zhi.qu
 * @date 2026-06-02
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeBranchInfo, findBranchTip, type TreeNodeLite } from './branch-nav'

// 树：U(user) 下两个 assistant 版本 A1、A2；A2 后又追问 U2→A3
const TREE: TreeNodeLite[] = [
  { id: 'U', parentId: null, role: 'user', createdAt: 100 },
  { id: 'A1', parentId: 'U', role: 'assistant', createdAt: 200 },
  { id: 'A2', parentId: 'U', role: 'assistant', createdAt: 300 },
  { id: 'U2', parentId: 'A2', role: 'user', createdAt: 400 },
  { id: 'A3', parentId: 'U2', role: 'assistant', createdAt: 500 },
]

describe('computeBranchInfo', () => {
  test('同父同角色兄弟 = 同一轮的多个版本：A1 是 1/2、A2 是 2/2', () => {
    const i1 = computeBranchInfo(TREE, 'A1')
    const i2 = computeBranchInfo(TREE, 'A2')
    assert.deepEqual(i1, { index: 0, total: 2, siblings: ['A1', 'A2'] })
    assert.deepEqual(i2, { index: 1, total: 2, siblings: ['A1', 'A2'] })
  })
  test('只有一个版本 → null（不显示切换器）', () => {
    assert.equal(computeBranchInfo(TREE, 'A3'), null) // A3 是 U2 唯一 assistant 子
    assert.equal(computeBranchInfo(TREE, 'U'), null) // U 是唯一根
  })
  test('消息不存在 → null', () => {
    assert.equal(computeBranchInfo(TREE, 'zzz'), null)
  })
})

describe('findBranchTip', () => {
  test('A1 是叶子分支 → 尖端是自己', () => {
    assert.equal(findBranchTip(TREE, 'A1'), 'A1')
  })
  test('A2 分支后续还有 U2→A3 → 尖端走到 A3', () => {
    assert.equal(findBranchTip(TREE, 'A2'), 'A3')
  })
  test('从根 U 向下走最近活动分支（A2 比 A1 新）→ A3', () => {
    assert.equal(findBranchTip(TREE, 'U'), 'A3')
  })
  test('环数据保护：不死循环', () => {
    const cyclic: TreeNodeLite[] = [
      { id: 'x', parentId: 'y', role: 'assistant', createdAt: 1 },
      { id: 'y', parentId: 'x', role: 'assistant', createdAt: 2 },
    ]
    const tip = findBranchTip(cyclic, 'x')
    assert.ok(tip === 'x' || tip === 'y')
  })
})
