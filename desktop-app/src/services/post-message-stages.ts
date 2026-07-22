/**
 * LLM 回复完成后的后处理 stage 集合（AstrBot 借鉴 · ⑧生命周期钩子地基 · post 半边）。
 *
 * 与 pre-message-stages 对称：把原先内联在 chatStore.sendMessage 尾部的 fire-and-forget
 * 副作用（记忆复盘 / 情景抽取）迁成独立、可测的 post-stage。逻辑与迁移前逐行等价，只是
 * 从巨函数搬出来，由 runPostMessageStages 编排。
 *
 * 这批 post 钩子点 + pre-message 的 stage 一起，构成未来「插件（⑧）/ 适配器（⑦）共用的
 * 生命周期钩子」的基座——详见 docs/soul-extension-architecture.md。
 */

import type { PostMessageStage } from './message-pipeline'

/**
 * 对话情景记忆 lazy 抽取（v17 Phase 2a）。每轮 assistant 回复后触发；消息条数未变化时
 * 主进程幂等跳过。fire-and-forget：缺 LLM 凭据静默跳过，任何失败仅 warn 不抛。
 */
export function episodeExtractStage(): PostMessageStage {
  return {
    name: 'episode-extract',
    run: async (ctx) => {
      try {
        const [apiKey, baseUrl] = await Promise.all([
          window.electronAPI.getSetting('chat_api_key').then(v => v ?? ''),
          window.electronAPI.getSetting('chat_base_url').then(v => v ?? ''),
        ])
        if (!apiKey || !baseUrl) return // 用户没配 LLM 凭据，跳过
        const r = await window.electronAPI.extractConversationEpisode(ctx.avatarId, ctx.conversationId, apiKey, baseUrl)
        if (!r.ok && r.reason && !r.reason.includes('未变化')) {
          // 真实失败才记 warn——"消息条数未变化"是正常跳过
          window.electronAPI.logEvent('warn', 'extract-conversation-episode', r.reason)
        }
      } catch (extractErr) {
        // 抽取失败绝不影响用户体验
        const m = extractErr instanceof Error ? extractErr.message : String(extractErr)
        window.electronAPI.logEvent('warn', 'extract-conversation-episode-throw', m)
      }
    },
  }
}

/**
 * N 轮一次后台记忆复盘（A4 · Hermes 借鉴）。未达 memory_review_turns（默认 10 用户轮）时
 * 主进程快速返回不调 LLM；写入只落盘、下个 session 生效。fire-and-forget：主开关关闭 /
 * 缺凭据静默跳过，失败仅 warn。
 */
export function memoryReviewStage(): PostMessageStage {
  return {
    name: 'memory-review',
    run: async (ctx) => {
      try {
        const reviewEnabled = (await window.electronAPI.getSetting('memory_review_enabled')) !== 'false'
        if (!reviewEnabled) return
        const [apiKey, baseUrl] = await Promise.all([
          window.electronAPI.getSetting('chat_api_key').then(v => v ?? ''),
          window.electronAPI.getSetting('chat_base_url').then(v => v ?? ''),
        ])
        if (!apiKey || !baseUrl) return // 未配 LLM 凭据，跳过
        const r = await window.electronAPI.runMemoryReview(ctx.avatarId, ctx.conversationId, apiKey, baseUrl)
        if (r.ok && (r.applied ?? 0) > 0) {
          window.electronAPI.logEvent('info', 'memory-review-applied', `conv=${ctx.conversationId} applied=${r.applied} rejected=${r.rejected ?? 0}`)
        } else if (!r.ok && r.reason && !r.reason.includes('未达')) {
          // "未达复盘轮数"是常态跳过，不记日志；真实失败才 warn
          window.electronAPI.logEvent('warn', 'memory-review', r.reason)
        }
      } catch (reviewErr) {
        // 复盘失败绝不影响用户体验
        const m = reviewErr instanceof Error ? reviewErr.message : String(reviewErr)
        window.electronAPI.logEvent('warn', 'memory-review-throw', m)
      }
    },
  }
}
