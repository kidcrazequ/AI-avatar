import { ReactNode } from 'react'
import ConversationList from './ConversationList'

interface Conversation {
  id: string
  title: string
  created_at: number
  updated_at: number
}

interface Props {
  conversations: Conversation[]
  activeConversationId: string | null
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
  onNewConversation: () => void
  children: ReactNode
}

export default function Sidebar({
  conversations,
  activeConversationId,
  onSelectConversation,
  onDeleteConversation,
  onNewConversation,
  children,
}: Props) {
  return (
    <div className="flex h-screen">
      <div className="w-64 flex-shrink-0">
        <ConversationList
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelectConversation={onSelectConversation}
          onDeleteConversation={onDeleteConversation}
          onNewConversation={onNewConversation}
        />
      </div>
      <div className="flex-1">
        {children}
      </div>
    </div>
  )
}
