import { useState } from 'react'

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
    return date.toLocaleDateString('zh-CN').replace(/\//g, '-')
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
        className={`group flex items-center justify-between px-4 py-3 cursor-pointer
          border-l-2 transition-none
          ${isActive
            ? 'bg-px-mid border-l-px-white text-px-white'
            : 'bg-transparent border-l-transparent text-px-subtle hover:bg-px-mid hover:text-px-white'
          }`}
        onClick={onClick}
      >
        <div className="flex-1 min-w-0">
          <p className="font-mono text-sm font-medium truncate">{conversation.title}</p>
          <p className="font-pixel text-[8px] text-px-muted mt-0.5 tracking-wider">
            {formatDate(conversation.updated_at)}
          </p>
        </div>

        {/* 删除按钮（hover 可见，键盘可达） */}
        {!confirmingDelete && (
          <button
            onClick={handleDeleteRequest}
            aria-label={`删除 ${conversation.title}`}
            className="ml-2 opacity-0 group-hover:opacity-100 font-pixel text-[10px] text-px-muted hover:text-px-danger px-1 py-0.5 focus:opacity-100"
          >
            ×
          </button>
        )}
      </div>

      {/* GAP15 UX: 内联删除确认（替代 confirm()） */}
      {confirmingDelete && (
        <div className="flex items-center gap-1 px-4 py-1.5 bg-px-black border-l-2 border-px-danger">
          <span className="font-pixel text-[8px] text-px-danger mr-1">DEL?</span>
          <button
            onClick={handleConfirmDelete}
            className="font-pixel text-[8px] px-2 py-0.5 bg-px-danger text-px-white"
          >
            YES
          </button>
          <button
            onClick={handleCancelDelete}
            className="font-pixel text-[8px] px-2 py-0.5 border border-px-muted text-px-muted"
          >
            NO
          </button>
        </div>
      )}
    </div>
  )
}
