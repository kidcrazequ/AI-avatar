import { useState } from 'react'
import ConversationItem from './ConversationItem'

interface Props {
  conversations: Conversation[]
  activeConversationId: string | null
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
  onNewConversation: () => void
  isCreatingConversation?: boolean
}

export default function ConversationList({
  conversations,
  activeConversationId,
  onSelectConversation,
  onDeleteConversation,
  onNewConversation,
  isCreatingConversation = false,
}: Props) {
  const [searchQuery, setSearchQuery] = useState('')
  const filtered = conversations.filter(c =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  )

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
        </div>
      </div>

      <div className="mx-4 pixel-divider relative z-10" />

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto relative z-10 pt-1">
        {filtered.length === 0 ? (
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
        )}
      </div>
    </div>
  )
}
