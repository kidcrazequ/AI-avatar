import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DYNAMIC_SYSTEM_PROMPT_MARKER,
  combineSystemPromptSections,
  normalizeSystemPromptSections,
  splitSystemPromptSections,
} from '../prompt-sections'

describe('prompt-sections', () => {
  it('应把 stable 与 dynamic 合成带 marker 的 system prompt', () => {
    const combined = combineSystemPromptSections('stable block', '# 长期记忆\nfoo')
    assert.ok(combined.includes(DYNAMIC_SYSTEM_PROMPT_MARKER))
    assert.ok(combined.startsWith('stable block'))
    assert.ok(combined.endsWith('# 长期记忆\nfoo'))
  })

  it('应能从 combined prompt 中拆回 stable 与 dynamic', () => {
    const combined = combineSystemPromptSections('stable block', '# 用户画像\nbar')
    const sections = splitSystemPromptSections(combined)
    assert.equal(sections.stableSystemPrompt, 'stable block')
    assert.equal(sections.dynamicSystemPrompt, '# 用户画像\nbar')
    assert.equal(sections.systemPrompt, combined)
  })

  it('legacy prompt 未带 marker 时应全部视为 stable', () => {
    const sections = normalizeSystemPromptSections('legacy prompt only')
    assert.equal(sections.stableSystemPrompt, 'legacy prompt only')
    assert.equal(sections.dynamicSystemPrompt, '')
  })
})
