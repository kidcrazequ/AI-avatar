/**
 * PromptRegistry：版本化的 prompt 段（PromptSegment）。
 *
 * 每段携带：
 *   - id: 稳定标识（如 "soul.persona"）
 *   - version: 内容指纹或语义版本，便于 cache 命中追踪
 *   - body: 文本
 *   - cacheable: 是否参与 Anthropic prompt_caching（连续 cacheable 段共享一个 cache breakpoint）
 *
 * 装配后转换为 LLM 调用所需的 messages，并自动注入 cache_control marker。
 *
 * 借鉴 PAP `pap/prompts/`；与 Anthropic Messages API 的 cache_control 兼容。
 */

import crypto from 'crypto'

export interface PromptSegment {
  id: string
  version: string
  /** 用于 LLM 的纯文本 */
  body: string
  /** true 表示该段稳定，可参与 prompt_caching；false 表示每次变（不要 cache） */
  cacheable: boolean
  /** 调试用 metadata */
  meta?: Record<string, unknown>
}

/** 计算文本内容指纹（用作 version） */
export function fingerprint(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** 创建一个 segment，自动生成 version 指纹 */
export function makeSegment(id: string, body: string, cacheable: boolean, meta?: Record<string, unknown>): PromptSegment {
  return { id, version: fingerprint(body), body, cacheable, meta }
}

/**
 * 把多段 prompt 合并为 Anthropic system blocks 格式。
 *
 * Anthropic 的 system 字段支持数组形式，每个对象可以带 cache_control。
 * 我们把**连续的 cacheable 段**合并到一个 block，并在最后一个 cacheable
 * block 上挂 cache_control，让该断点之前的所有内容都被缓存。
 *
 * 返回结构：
 *   [
 *     { type: 'text', text: '<soul>\n<skills-index>', cache_control: { type: 'ephemeral' } },
 *     { type: 'text', text: '<rag-hits>\n<conv>' }   // 不缓存
 *   ]
 *
 * 即"cacheable 段"形成稳定前缀；"不可缓存段"附在尾部。
 */
export interface AnthropicSystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

export function toAnthropicSystemBlocks(segments: readonly PromptSegment[]): AnthropicSystemBlock[] {
  if (segments.length === 0) return []

  // 把连续同 cacheable 的段聚合
  const groups: { cacheable: boolean; bodies: string[] }[] = []
  for (const seg of segments) {
    const last = groups[groups.length - 1]
    if (last && last.cacheable === seg.cacheable) {
      last.bodies.push(seg.body)
    } else {
      groups.push({ cacheable: seg.cacheable, bodies: [seg.body] })
    }
  }

  // 找到最后一个 cacheable 组的索引（用于挂 cache_control）
  let lastCacheableIdx = -1
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].cacheable) {
      lastCacheableIdx = i
      break
    }
  }

  return groups.map((g, idx) => {
    const block: AnthropicSystemBlock = {
      type: 'text',
      text: g.bodies.join('\n\n'),
    }
    if (idx === lastCacheableIdx) {
      block.cache_control = { type: 'ephemeral' }
    }
    return block
  })
}

/**
 * 总文本长度（用于估算 token / 调试 cache 占比）
 */
export function totalLength(segments: readonly PromptSegment[]): { total: number; cacheable: number } {
  let total = 0
  let cacheable = 0
  for (const s of segments) {
    total += s.body.length
    if (s.cacheable) cacheable += s.body.length
  }
  return { total, cacheable }
}
