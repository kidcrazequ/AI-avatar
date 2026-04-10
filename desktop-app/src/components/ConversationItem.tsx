import { useState } from 'react'
import { localDateString } from '@soul/core'

interface Props {
  conversation: Conversation
  isActive: boolean
  onClick: () => void
  onDelete: () => void
}

export default function ConversationItem({ conversation, isActive, onClick, onDelete }: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const formatDate = (ts: number) => {
    const date = new Date(ts)
    const now = new Date()
    const days = Math.floor((now.getTime() - date.getTime()) / 86400000)
    if (days === 0) return 'TODAY'
    if (days === 1) return 'YESTERDAY'
    if (days < 7) return `${days}D AGO`
    return localDateString(date)
  }

  const handleDeleteRequest = (e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmingDelete(true)
  }

  const handleConfirmDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmingDelete(false)
    onDelete()
  }

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmingDelete(false)
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        className={`group flex items-center justify-between px-4 py-3 cursor-pointer
          border-l-3 transition-none
          ${isActive
            ? 'bg-px-surface border-l-px-primary text-px-text'
            : 'bg-transparent border-l-transparent text-px-text-sec hover:bg-px-surface/50 hover:text-px-text'
          }`}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
        aria-label={conversation.title}
        aria-current={isActive ? 'true' : undefined}
      >
        <div className="flex-1 min-w-0">
          <p className="font-game text-[14px] font-medium truncate">{conversation.title}</p>
          <p className="font-game text-[10px] text-px-text-dim mt-1 tracking-wider">
            {formatDate(conversation.updated_at)}
          </p>
        </div>

        {!confirmingDelete && (
          <button
            onClick={handleDeleteRequest}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label={`删除 ${conversation.title}`}
            className="ml-2 opacity-0 group-hover:opacity-100 font-game text-[12px] text-px-text-dim hover:text-px-danger px-1 py-0.5 focus:opacity-100"
          >
            ×
          </button>
        )}
      </div>

      {confirmingDelete && (
        <div className="flex items-center gap-1 px-4 py-1.5 bg-px-danger/10 border-l-3 border-px-danger">
          <span className="font-game text-[11px] text-px-danger mr-1">删除?</span>
          <button
            onClick={handleConfirmDelete}
            className="font-game text-[11px] px-2 py-0.5 bg-px-danger text-white"
          >
            是
          </button>
          <button
            onClick={handleCancelDelete}
            className="font-game text-[11px] px-2 py-0.5 border border-px-border text-px-text-sec"
          >
            否
          </button>
        </div>
      )}
    </div>
  )
}
