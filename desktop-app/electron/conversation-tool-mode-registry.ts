/**
 * 主进程侧会话 → 工具模式（Ask/Plan/Agent）缓存，供 execute-tool-call 门禁读取。
 * 由渲染进程 bindConversation / setMode 及 switch_mode 工具结果同步。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import type { ConversationModeForTools } from '@soul/core'

const conversationIdToMode = new Map<string, ConversationModeForTools>()

export function setConversationToolMode(conversationId: string, mode: ConversationModeForTools): void {
  conversationIdToMode.set(conversationId, mode)
}

export function getConversationToolMode(conversationId: string): ConversationModeForTools {
  return conversationIdToMode.get(conversationId) ?? 'agent'
}
