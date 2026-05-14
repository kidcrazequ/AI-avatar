/**
 * Agent Runtime 桥接层：把 @soul/core/agent-runtime 接入到 desktop-app。
 *
 * 当前接入范围（Phase 1 + Phase 5 理想版观测）：
 *   - loadAvatarBlueprint(avatarId)：装配并缓存当前分身的 AgentBlueprint
 *   - getPromptCacheStats(avatarId, parts, hits?)：基于 stable/dynamic 拆分
 *     输出 cacheable 占比统计。理想版把 CLAUDE.md+soul.md+HARD_RULES 等稳定
 *     内容标 cacheable=true，仅 @mentions intro / attachment guide / 检索 hits
 *     等动态内容标 uncached。
 *
 * 由 `SOUL_USE_NEW_RUNTIME` 环境变量控制是否启用——默认关闭，旧路径不动。
 * 当前实现「观测」级；后续切到 Anthropic SDK 后可直接使用 toAnthropicSystemBlocks
 * 把分段结果作为 system 数组传入。
 */

import path from 'path'
import { AgentRuntime } from '@soul/core'

interface PromptCacheStats {
  enabled: boolean
  avatarId: string
  totalChars: number
  cacheableChars: number
  cacheableRatio: number
  segmentCount: number
  segments: Array<{ id: string; version: string; cacheable: boolean; chars: number }>
}

const blueprintCache = new Map<string, AgentRuntime.AgentBlueprint>()

export function clearBlueprintCache(avatarId?: string): void {
  if (avatarId) blueprintCache.delete(avatarId)
  else blueprintCache.clear()
}

export function loadAvatarBlueprintCached(
  avatarId: string,
  avatarsPath: string
): AgentRuntime.AgentBlueprint | null {
  const cached = blueprintCache.get(avatarId)
  if (cached) return cached
  try {
    const avatarDir = path.join(avatarsPath, avatarId)
    const repoRoot = path.resolve(avatarsPath, '..')
    const bp = AgentRuntime.loadBlueprintFromAvatarDir({ avatarDir, repoRoot })
    blueprintCache.set(avatarId, bp)
    return bp
  } catch (err) {
    console.warn(`[agent-runtime] loadAvatarBlueprintCached failed for ${avatarId}:`, err)
    return null
  }
}

/**
 * 把 system prompt 切成 5 段：
 *   1. soul.persona              ← Blueprint.identity.persona  (cacheable)
 *   2. skill.index               ← Blueprint.skills 摘要      (cacheable)
 *   3. rules.stable              ← stableSystemPrompt          (cacheable)
 *      （= store.systemPrompt + HARD_RULES，分身加载时已确定，会话内极少变）
 *   4. dynamic.tail              ← dynamicSystemPrompt         (uncached)
 *      （= @mentions intro + attachmentGuide + snipNoticeBlock，每次可能变）
 *   5. knowledge.hits            ← knowledgeHits               (uncached)
 *
 * 段 1-3 形成稳定前缀，挂 Anthropic cache_control 后整段命中 prompt-caching。
 * 段 4-5 是动态尾巴，每次重新计费。
 *
 * 返回统计；不修改原 prompt 字符串。
 */
export interface PromptParts {
  /** 稳定段（cacheable）：分身定义 + 全局硬性规则 */
  stableSystemPrompt: string
  /** 动态段（uncached）：@mentions intro / attachment guide / snip notice */
  dynamicSystemPrompt?: string
}

export function getPromptCacheStats(
  avatarId: string,
  avatarsPath: string,
  parts: PromptParts,
  knowledgeHits: string[] = []
): PromptCacheStats {
  const stable = parts.stableSystemPrompt
  const dynamic = parts.dynamicSystemPrompt ?? ''
  const total0 = stable.length + dynamic.length

  if (!AgentRuntime.isNewRuntimeEnabled()) {
    return {
      enabled: false,
      avatarId,
      totalChars: total0,
      cacheableChars: 0,
      cacheableRatio: 0,
      segmentCount: 0,
      segments: [],
    }
  }

  const bp = loadAvatarBlueprintCached(avatarId, avatarsPath)
  if (!bp) {
    return {
      enabled: true,
      avatarId,
      totalChars: total0,
      cacheableChars: 0,
      cacheableRatio: 0,
      segmentCount: 0,
      segments: [],
    }
  }

  const baseSegments = AgentRuntime.buildSegmentedSystemPrompt({
    blueprint: bp,
    knowledgeHits,
  })
  // baseSegments 中既有 cacheable（persona / skill-index）也可能有 uncached（knowledge.hits）

  const stableCacheable = baseSegments.filter((s) => s.cacheable)
  const baseUncached = baseSegments.filter((s) => !s.cacheable)

  const segments: AgentRuntime.PromptSegment[] = [...stableCacheable]
  if (stable) {
    segments.push(AgentRuntime.makeSegment('rules.stable', stable, true, { source: 'chatStore stable' }))
  }
  // dynamic 优先于 hits（顺序无关 cache 影响，统一观测）
  if (dynamic) {
    segments.push(AgentRuntime.makeSegment('dynamic.tail', dynamic, false, { source: 'chatStore dynamic' }))
  }
  segments.push(...baseUncached)

  const { total, cacheable } = AgentRuntime.totalLength(segments)
  return {
    enabled: true,
    avatarId,
    totalChars: total,
    cacheableChars: cacheable,
    cacheableRatio: total === 0 ? 0 : cacheable / total,
    segmentCount: segments.length,
    segments: segments.map((s) => ({
      id: s.id,
      version: s.version,
      cacheable: s.cacheable,
      chars: s.body.length,
    })),
  }
}

export type { PromptCacheStats }
