/**
 * Phase 6 验证：Memory 3 层抽象
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  InMemoryLayer,
  makeDefaultMemoryTier,
  MemoryPolicySchema,
} from '../agent-runtime'

describe('Phase 6 — InMemoryLayer', () => {
  it('put + get 回旋', async () => {
    const layer = new InMemoryLayer<string>({ ttlMs: null, decay: false })
    await layer.put({ id: 'r1', agentId: 'a', importance: 0.5, value: 'hello' })
    const r = await layer.get('r1', 'a')
    assert.equal(r?.value, 'hello')
  })

  it('TTL 过期后 get 返回 null', async () => {
    const layer = new InMemoryLayer<string>({ ttlMs: 10, decay: false })
    await layer.put({
      id: 'r1',
      agentId: 'a',
      importance: 0.5,
      value: 'hello',
      createdAt: Date.now() - 100,
    })
    const r = await layer.get('r1', 'a')
    assert.equal(r, null)
  })

  it('list 按 importance 倒序（无衰减时）', async () => {
    const layer = new InMemoryLayer<string>({ ttlMs: null, decay: false })
    await layer.put({ id: 'low', agentId: 'a', importance: 0.1, value: 'low' })
    await layer.put({ id: 'high', agentId: 'a', importance: 0.9, value: 'high' })
    const items = await layer.list({ agentId: 'a' })
    assert.equal(items[0].id, 'high')
    assert.equal(items[1].id, 'low')
  })

  it('list 按 tags 过滤', async () => {
    const layer = new InMemoryLayer<string>({ ttlMs: null, decay: false })
    await layer.put({ id: '1', agentId: 'a', importance: 0.5, value: 'a', tags: ['x'] })
    await layer.put({ id: '2', agentId: 'a', importance: 0.5, value: 'b', tags: ['y'] })
    const items = await layer.list({ agentId: 'a', tags: ['x'] })
    assert.equal(items.length, 1)
    assert.equal(items[0].id, '1')
  })

  it('agentId 隔离：不同分身不共享记录', async () => {
    const layer = new InMemoryLayer<string>({ ttlMs: null, decay: false })
    await layer.put({ id: '1', agentId: 'a', importance: 0.5, value: 'a' })
    const itemsA = await layer.list({ agentId: 'a' })
    const itemsB = await layer.list({ agentId: 'b' })
    assert.equal(itemsA.length, 1)
    assert.equal(itemsB.length, 0)
  })

  it('decay：30 天前的记录重要性衰减一半', async () => {
    const layer = new InMemoryLayer<string>({ ttlMs: null, decay: true, halfLifeDays: 30 })
    const now = Date.now()
    await layer.put({
      id: 'fresh',
      agentId: 'a',
      importance: 0.5,
      value: 'fresh',
      lastAccessedAt: now,
    })
    await layer.put({
      id: 'old',
      agentId: 'a',
      importance: 0.5,
      value: 'old',
      lastAccessedAt: now - 30 * 24 * 3600 * 1000,
    })
    const items = await layer.list({ agentId: 'a' })
    // fresh 排前面（importance 0.5 × 1.0 vs old 0.5 × 0.5）
    assert.equal(items[0].id, 'fresh')
    assert.equal(items[1].id, 'old')
  })

  it('prune 清理过期', async () => {
    const layer = new InMemoryLayer<string>({ ttlMs: 10, decay: false })
    await layer.put({
      id: 'old',
      agentId: 'a',
      importance: 0.5,
      value: 'x',
      createdAt: Date.now() - 1000,
    })
    await layer.put({ id: 'new', agentId: 'a', importance: 0.5, value: 'y' })
    const removed = await layer.prune()
    assert.equal(removed, 1)
    const items = await layer.list({ agentId: 'a' })
    assert.equal(items.length, 1)
    assert.equal(items[0].id, 'new')
  })

  it('forget 删除指定记录', async () => {
    const layer = new InMemoryLayer<string>({ ttlMs: null, decay: false })
    await layer.put({ id: 'r1', agentId: 'a', importance: 0.5, value: 'x' })
    const ok = await layer.forget('r1', 'a')
    assert.equal(ok, true)
    assert.equal(await layer.get('r1', 'a'), null)
  })
})

describe('Phase 6 — MemoryTier 工厂', () => {
  it('从默认 MemoryPolicy 装配 3 层', () => {
    const policy = MemoryPolicySchema.parse({})
    const tier = makeDefaultMemoryTier(policy)
    assert.ok(tier.shortTerm)
    assert.ok(tier.episodic)
    assert.ok(tier.semantic)
  })

  it('shortTerm/episodic/semantic 不共享存储', async () => {
    const policy = MemoryPolicySchema.parse({})
    const tier = makeDefaultMemoryTier(policy)
    await tier.shortTerm.put({ id: '1', agentId: 'a', importance: 1, value: 'short' })
    await tier.episodic.put({ id: '2', agentId: 'a', importance: 1, value: 'ep' })
    await tier.semantic.put({ id: '3', agentId: 'a', importance: 1, value: 'sem' })

    assert.equal((await tier.shortTerm.list({ agentId: 'a' })).length, 1)
    assert.equal((await tier.episodic.list({ agentId: 'a' })).length, 1)
    assert.equal((await tier.semantic.list({ agentId: 'a' })).length, 1)
    assert.equal(await tier.shortTerm.get('2', 'a'), null) // 不会跨层
  })
})
