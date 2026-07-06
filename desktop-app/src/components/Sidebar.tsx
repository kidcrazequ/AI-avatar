import { ReactNode } from 'react'
import ConversationList from './ConversationList'

interface Props {
  conversations: Conversation[]
  activeConversationId: string | null
  activeAvatarId?: string
  activeProjectId: string
  knownProjectIds: string[]
  onProjectChange: (projectId: string) => void
  onCreateProjectId: () => void
  onManageProjects?: () => void
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
  onNewConversation: () => void
  isCreatingConversation?: boolean
  children: ReactNode
}

export default function Sidebar({
  conversations,
  activeConversationId,
  activeAvatarId,
  activeProjectId,
  knownProjectIds,
  onProjectChange,
  onCreateProjectId,
  onManageProjects,
  onSelectConversation,
  onDeleteConversation,
  onNewConversation,
  isCreatingConversation = false,
  children,
}: Props) {
  return (
    <div className="flex h-screen min-h-0 overflow-hidden">
      <div className="w-64 flex-shrink-0">
        <ConversationList
          conversations={conversations}
          activeConversationId={activeConversationId}
          activeAvatarId={activeAvatarId}
          activeProjectId={activeProjectId}
          knownProjectIds={knownProjectIds}
          onProjectChange={onProjectChange}
          onCreateProjectId={onCreateProjectId}
          onManageProjects={onManageProjects}
          onSelectConversation={onSelectConversation}
          onDeleteConversation={onDeleteConversation}
          onNewConversation={onNewConversation}
          isCreatingConversation={isCreatingConversation}
        />
      </div>
      <div className="flex-1 min-w-0 min-h-0">
        {children}
      </div>
    </div>
  )
}
