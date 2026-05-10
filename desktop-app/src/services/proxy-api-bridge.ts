/**
 * 主进程 Proxy 请求 → 渲染进程 `sendMessage` 桥接（方案 A）。
 * 在 App 挂载时注册 `soul-proxy-api:run-request` 监听。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import {
  extractLastUserTextFromAnthropic,
  formatSseEvent,
} from '../lib/anthropic-proxy-protocol'
import { useChatStore } from '../stores/chatStore'

/** 与 electron/proxy-server.SoulProxyRunPayload 一致 */
interface SoulProxyRunPayload {
  jobId: string
  stream: boolean
  conversationId: string
  body: Record<string, unknown>
}

function anthropicModelLabel(body: Record<string, unknown>): string {
  const m = body.model
  return typeof m === 'string' && m.length > 0 ? m : 'soul-chat'
}

export function registerSoulProxyApiBridge(): () => void {
  if (typeof window === 'undefined' || !window.electronAPI?.onSoulProxyApiRunRequest) {
    return () => undefined
  }
  return window.electronAPI.onSoulProxyApiRunRequest((payload: unknown) => {
    void handleProxyRunRequest(payload as SoulProxyRunPayload)
  })
}

async function handleProxyRunRequest(payload: SoulProxyRunPayload): Promise<void> {
  const { jobId, stream, conversationId, body } = payload
  const api = window.electronAPI
  try {
    const userText = extractLastUserTextFromAnthropic(body.messages)
    const { bindConversation, sendMessage } = useChatStore.getState()

    if (useChatStore.getState().isLoading) {
      await api.soulProxyApiFinish(jobId, {
        error: 'Soul 正有一条对话进行中（isLoading），请稍后再试 Proxy 请求',
      })
      return
    }

    const conv = await api.getConversation(conversationId)
    if (!conv) {
      await api.soulProxyApiFinish(jobId, { error: `会话不存在: ${conversationId}` })
      return
    }

    await bindConversation(conversationId)
    const avatarId = conv.avatar_id

    const messageId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    const modelLabel = anthropicModelLabel(body)

    if (stream) {
      await api.soulProxyApiSseWrite(
        jobId,
        formatSseEvent('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: modelLabel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      )
      await api.soulProxyApiSseWrite(
        jobId,
        formatSseEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      )
    }

    await sendMessage(userText, conversationId, avatarId, undefined, undefined, undefined, undefined, {
      proxyJobId: jobId,
      proxyStream: stream,
      proxyAnthropicMessageId: messageId,
      proxyModelLabel: modelLabel,
      onProxyComplete: async (result) => {
        if (!result.ok) {
          await api.soulProxyApiFinish(jobId, { error: result.error })
          return
        }
        if (stream) {
          await api.soulProxyApiSseWrite(jobId, formatSseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }))
          await api.soulProxyApiSseWrite(
            jobId,
            formatSseEvent('message_delta', {
              type: 'message_delta',
              delta: {
                stop_reason: 'end_turn',
                stop_sequence: null,
              },
            }),
          )
          await api.soulProxyApiSseWrite(jobId, formatSseEvent('message_stop', { type: 'message_stop' }))
        }
        if (!stream) {
          await api.soulProxyApiFinish(jobId, {
            json: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: result.assistantText }],
              model: modelLabel,
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: Math.ceil(result.assistantText.length / 4) },
            },
          })
          return
        }
        await api.soulProxyApiFinish(jobId, {})
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await window.electronAPI.soulProxyApiFinish(jobId, { error: msg })
  }
}

