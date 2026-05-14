/**
 * Phase 1 验证：所有 expert-pack 都能装配成 frozen AgentBlueprint 且通过 Zod 校验。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import {
  loadBlueprintFromAvatarDir,
  AgentBlueprintSchema,
  isCapabilitySubset,
  type AgentBlueprint,
} from '../agent-runtime'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const EXPERT_PACKS_DIR = path.join(REPO_ROOT, 'expert-packs')

function listExpertPacks(): string[] {
  if (!fs.existsSync(EXPERT_PACKS_DIR)) return []
  return fs
    .readdirSync(EXPERT_PACKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}

describe('Phase 1 — AgentBlueprint loader', () => {
  it('expert-packs 目录存在', () => {
    assert.ok(fs.existsSync(EXPERT_PACKS_DIR), `expert-packs 目录不存在：${EXPERT_PACKS_DIR}`)
  })

  it('每个 expert-pack 都能装配成有效 Blueprint', () => {
    const packs = listExpertPacks()
    assert.ok(packs.length >= 5, `expert-packs 数量不应少于 5，实际 ${packs.length}`)

    for (const packId of packs) {
      const avatarDir = path.join(EXPERT_PACKS_DIR, packId)
      const bp: AgentBlueprint = loadBlueprintFromAvatarDir({
        avatarDir,
        repoRoot: REPO_ROOT,
      })
      // 关键不变量
      assert.equal(typeof bp.identity.id, 'string', `${packId}: id 必须为 string`)
      assert.ok(bp.identity.id.length > 0, `${packId}: id 不能为空`)
      assert.ok(bp.identity.name.length > 0, `${packId}: name 不能为空`)
      assert.ok(bp.ruleLayers.length > 0, `${packId}: ruleLayers 至少包含一个 markdown`)
      // 装配产物可序列化（A2A AgentCard 兼容前置条件）
      assert.doesNotThrow(() => JSON.stringify(bp), `${packId}: Blueprint 必须可 JSON 序列化`)
    }
  })

  it('Zod schema 严格校验缺失必填字段会失败', () => {
    assert.throws(() => AgentBlueprintSchema.parse({} as unknown), /identity/)
  })

  it('SpawnGuard：子代理工具不能超出父代理白名单', () => {
    const parent = AgentBlueprintSchema.parse({
      identity: { id: 'parent', name: 'parent', persona: '' },
      tools: [{ name: 'read_knowledge_file' }, { name: 'query_excel' }],
    })
    const childOk = AgentBlueprintSchema.parse({
      identity: { id: 'child', name: 'child', persona: '' },
      tools: [{ name: 'read_knowledge_file' }],
    })
    const childBad = AgentBlueprintSchema.parse({
      identity: { id: 'child', name: 'child', persona: '' },
      tools: [{ name: 'execute_bash' }],
    })
    assert.equal(isCapabilitySubset(childOk, parent).ok, true)
    const bad = isCapabilitySubset(childBad, parent)
    assert.equal(bad.ok, false)
    assert.match(bad.reason ?? '', /execute_bash/)
  })

  it('SpawnGuard：子代理 defaultMode 不能比父更宽松', () => {
    const parent = AgentBlueprintSchema.parse({
      identity: { id: 'parent', name: 'parent', persona: '' },
      permission: { defaultMode: 'ask' },
    })
    const childOk = AgentBlueprintSchema.parse({
      identity: { id: 'child', name: 'child', persona: '' },
      permission: { defaultMode: 'deny' },
    })
    const childBad = AgentBlueprintSchema.parse({
      identity: { id: 'child', name: 'child', persona: '' },
      permission: { defaultMode: 'allow' },
    })
    assert.equal(isCapabilitySubset(childOk, parent).ok, true)
    assert.equal(isCapabilitySubset(childBad, parent).ok, false)
  })
})
