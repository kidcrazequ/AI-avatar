import { useState } from 'react'
import ConversationItem from './ConversationItem'

interface Props {
  conversations: Conversation[]
  activeConversationId: string | null
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
  onNewConversation: () => void
}

export default function ConversationList({
  conversations,
  activeConversationId,
  onSelectConversation,
  onDeleteConversation,
  onNewConversation,
}: Props) {
  const [searchQuery, setSearchQuery] = useState('')
  const filtered = conversations.filter(c =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div className="flex flex-col h-full bg-px-dark border-r-2 border-px-black relative scanlines">
      {/* 新建对话按钮 */}
      <div className="p-4 border-b-2 border-px-line relative z-10">
        <button
          onClick={onNewConversation}
          className="w-full px-4 py-3 bg-px-white text-px-black border-2 border-px-white
            font-pixel text-[10px] tracking-wider uppercase
            hover:bg-transparent hover:text-px-white
            shadow-pixel-white
            active:shadow-none active:translate-x-[3px] active:translate-y-[3px]
            transition-none flex items-center justify-center gap-2 select-none"
        >
          [+] NEW CHAT
        </button>
      </div>

      {/* 搜索框 */}
      <div className="p-4 border-b-2 border-px-line relative z-10">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 font-pixel text-[10px] text-px-muted select-none">&gt;</span>
          <input
            type="text"
            placeholder="search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-2 bg-px-black text-px-white border-2 border-px-line
              font-mono text-sm placeholder:text-[#525252]
              focus:border-px-white focus:outline-none"
          />
        </div>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto relative z-10">
        {filtered.length === 0 ? (
          <div className="p-4 text-center">
            <p className="font-pixel text-[8px] text-px-muted tracking-wider">
              {searchQuery ? 'NO RESULTS' : 'NO CHATS'}
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
