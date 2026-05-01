/**
 * Chat message shared types used by service-level tests.
 *
 * @author zhi.qu
 * @date 2026-04-24
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
}
