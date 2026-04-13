/**
 * ConversationList: 会话列表组件，支持标题过滤和 FTS5 全文搜索。
 *
 * 搜索框输入时：
 * - 1-2 字符：仅在已加载的会话标题中过滤（纯客户端）
 * - 3+ 字符：同时发起 FTS5 消息全文搜索，展示匹配片段
 *
 * @author zhi.qu
 * @date 2026-04-09
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import ConversationItem from './ConversationItem'

interface Props {
  conversations: Conversation[]
  activeConversationId: string | null
  activeAvatarId?: string
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
  onNewConversation: () => void
  isCreatingConversation?: boolean
}

export default function ConversationList({
  conversations,
  activeConversationId,
  activeAvatarId,
  onSelectConversation,
  onDeleteConversation,
  onNewConversation,
  isCreatingConversation = false,
}: Props) {
  const [searchQuery, setSearchQuery] = useState('')
  const [ftsResults, setFtsResults] = useState<MessageSearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)

  const filtered = useMemo(() => {
    if (!searchQuery) return conversations
    const q = searchQuery.toLowerCase()
    return conversations.filter(c => c.title.toLowerCase().includes(q))
  }, [conversations, searchQuery])

  // FTS5 全文搜索（≥3 字符时触发）
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)

    if (searchQuery.length < 3) {
      ++searchSeq.current
      setFtsResults([])
      setIsSearching(false)
      return
    }

    searchTimer.current = setTimeout(async () => {
      const seq = ++searchSeq.current
      setIsSearching(true)
      try {
        const results = await window.electronAPI.searchMessages(searchQuery, activeAvatarId)
        if (seq !== searchSeq.current) return
        const seen = new Set<string>()
        const deduped = results.filter(r => {
          if (seen.has(r.conversationId)) return false
          seen.add(r.conversationId)
          return true
        })
        setFtsResults(deduped)
      } catch (err) {
        if (seq !== searchSeq.current) return
        console.error('[ConversationList] 全文搜索失败:', err instanceof Error ? err.message : String(err))
        setFtsResults([])
      } finally {
        // 反转条件避免 `return in finally` 触发 no-unsafe-finally 规则；
        // 语义等价：只有在请求未被后来者抢占时才关闭 loading 态
        if (seq === searchSeq.current) {
          setIsSearching(false)
        }
      }
    }, 300)

    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [searchQuery, activeAvatarId])

  const showFts = searchQuery.length >= 3

  return (
    <div className="flex flex-col h-full bg-px-bg border-r-2 border-px-border relative scanlines">
      {/* 品牌标识 */}
      <div className="p-4 relative z-10">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 bg-px-primary flex items-center justify-center shadow-pixel-brand">
            <span className="font-game text-[12px] text-px-bg leading-none">S</span>
          </div>
          <span className="font-game text-[13px] text-px-text tracking-wider">SOUL</span>
        </div>
        <button
          onClick={onNewConversation}
          disabled={isCreatingConversation}
          className="w-full px-4 py-3 bg-px-primary text-px-bg border-2 border-px-primary
            font-game text-[13px] tracking-wider uppercase
            hover:bg-px-primary-hover hover:border-px-primary-hover
            shadow-pixel-brand
            active:shadow-none active:translate-x-[2px] active:translate-y-[2px]
            transition-none flex items-center justify-center gap-2 select-none
            disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
        >
          {isCreatingConversation ? '创建中...' : '[+] NEW CHAT'}
        </button>
      </div>

      {/* 搜索 */}
      <div className="px-4 pb-3 relative z-10">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 font-game text-[12px] text-px-text-dim select-none">&gt;</span>
          <input
            type="text"
            placeholder="搜索..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-2 bg-px-surface text-px-text border-2 border-px-border-dim
              font-game text-[14px] placeholder:text-px-text-dim
              focus:border-px-primary focus:outline-none focus:shadow-glow-sm"
          />
          {isSearching && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 font-game text-[10px] text-px-text-dim">...</span>
          )}
        </div>
        {showFts && (
          <p className="font-game text-[11px] text-px-text-dim mt-1 pl-1">
            消息全文搜索 · {ftsResults.length} 条结果
          </p>
        )}
        {!showFts && searchQuery.length > 0 && (
          <p className="font-game text-[11px] text-px-accent mt-1 pl-1">
            输入至少 3 个字符进行全文搜索
          </p>
        )}
      </div>

      <div className="mx-4 pixel-divider relative z-10" />

      {/* 会话列表 / 搜索结果 */}
      <div className="flex-1 overflow-y-auto relative z-10 pt-1">
        {showFts ? (
          /* FTS5 搜索结果 */
          ftsResults.length === 0 ? (
            <div className="p-6 text-center">
              <p className="font-game text-[12px] text-px-text-dim tracking-wider">
                {isSearching ? '搜索中...' : '无结果'}
              </p>
            </div>
          ) : (
            ftsResults.map((result) => (
              <button
                key={result.messageId}
                onClick={() => onSelectConversation(result.conversationId)}
                className={`w-full text-left px-4 py-3 border-b border-px-border-dim transition-none
                  hover:bg-px-surface
                  ${result.conversationId === activeConversationId ? 'bg-px-surface border-l-3 border-l-px-primary' : ''}`}
              >
                <div className="font-game text-[13px] text-px-text truncate mb-1">
                  {result.conversationTitle}
                </div>
                <div className="font-game text-[11px] text-px-text-dim leading-relaxed">
                  <span className="text-px-text-dim">{result.role === 'user' ? '我' : 'AI'}：</span>
                  {result.snippet}
                </div>
              </button>
            ))
          )
        ) : (
          /* 普通会话列表 */
          filtered.length === 0 ? (
            <div className="p-6 text-center">
              <p className="font-game text-[12px] text-px-text-dim tracking-wider">
                {searchQuery ? '无结果' : '暂无对话'}
              </p>
            </div>
          ) : (
            filtered.map((conversation) => (
              <ConversationItem
                key={conversation.id}
                conversation={conversation}
                isActive={conversation.id === activeConversationId}
                onClick={() => onSelectConversation(conversation.id)}
                onDelete={() => onDeleteConversation(conversation.id)}
              />
            ))
          )
        )}
      </div>
    </div>
  )
}
