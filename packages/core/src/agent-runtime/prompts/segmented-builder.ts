/**
 * 把 AgentBlueprint + 知识检索结果 + 对话历史 组装成 4 段 prompt：
 *
 *   1. soul.persona + redline       永久 → cacheable
 *   2. skill-index 摘要              日级 → cacheable
 *   3. knowledge index 摘要 / knowledge hits  每次变 → 不 cache
 *   4. （由调用方拼接对话历史）       动态
 *
 * 让 Anthropic prompt_caching 利用率最大化：段 1+2 形成稳定前缀。
 *
 * 与 prompt-builder（旧路径）并存。
 */

import type { AgentBlueprint } from '../blueprint'
import { makeSegment, type PromptSegment } from './registry'

export interface SegmentedPromptInput {
  blueprint: AgentBlueprint
  /** 知识检索命中（每次对话不同，不可缓存） */
  knowledgeHits?: string[]
  /** 可选自定义段（如对话补丁、强制规则） */
  extra?: PromptSegment[]
}

export function buildSegmentedSystemPrompt(input: SegmentedPromptInput): PromptSegment[] {
  const { blueprint, knowledgeHits = [], extra = [] } = input
  const segments: PromptSegment[] = []

  // ── 段 1：persona + redline（最稳定，永远 cacheable）
  const personaBody = [
    blueprint.identity.name && `# ${blueprint.identity.name}`,
    blueprint.identity.persona,
    blueprint.identity.redline && `\n**红线**：${blueprint.identity.redline}`,
  ]
    .filter(Boolean)
    .join('\n')
  if (personaBody) {
    segments.push(makeSegment('soul.persona', personaBody, true, { agentId: blueprint.identity.id }))
  }

  // ── 段 2：skill-index 摘要（日级变化，仍 cacheable；不直接塞所有 skill 内容）
  if (blueprint.skills.length > 0) {
    const skillIndex = blueprint.skills
      .map((s) => {
        const kw = s.keywords?.length ? `（关键词：${s.keywords.slice(0, 4).join('/')}）` : ''
        const intents = s.handles_intents?.length ? `；意图：${s.handles_intents.slice(0, 4).join('/')}` : ''
        const provides = s.provides?.length ? `；产物：${s.provides.slice(0, 4).join('/')}` : ''
        return `- **${s.id}**${kw}：${s.when ?? '—'}${intents}${provides}`
      })
      .join('\n')
    segments.push(
      makeSegment(
        'skill.index',
        `## 可用技能\n${skillIndex}\n\n（按需调用 load_skill 加载完整内容）`,
        true,
        { skillCount: blueprint.skills.length }
      )
    )
  }

  // ── 段 3：knowledge hits（每次变化，不 cache）
  if (knowledgeHits.length > 0) {
    segments.push(
      makeSegment(
        'knowledge.hits',
        `## 本轮检索到的知识\n${knowledgeHits.map((h, i) => `### 命中 ${i + 1}\n${h}`).join('\n\n')}`,
        false,
        { hitCount: knowledgeHits.length }
      )
    )
  }

  // ── 段 4：调用方自定义（默认不 cache）
  for (const seg of extra) {
    segments.push(seg)
  }

  return segments
}
