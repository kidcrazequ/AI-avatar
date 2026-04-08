import { useState, useEffect } from 'react'

interface Props {
  activeAvatarId: string
  onSelectAvatar: (id: string) => void
  onCreateAvatar: () => void
}

export default function AvatarSelector({ activeAvatarId, onSelectAvatar, onCreateAvatar }: Props) {
  const [avatars, setAvatars] = useState<Avatar[]>([])
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    window.electronAPI.listAvatars().then(setAvatars)
  }, [])

  const activeAvatar = avatars.find(a => a.id === activeAvatarId)
  const initials = activeAvatar?.name?.charAt(0)?.toUpperCase() || '?'

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className="flex items-center gap-3 px-3 py-1.5 bg-px-elevated text-px-text border-2 border-px-border
          hover:border-px-primary transition-none select-none"
      >
        {/* 品牌色像素头像 */}
        <div className="w-7 h-7 bg-px-primary text-white flex items-center justify-center font-game text-[12px] flex-shrink-0">
          {initials}
        </div>
        <span className="font-game text-[14px] font-medium max-w-[140px] truncate">
          {activeAvatar?.name || '选择分身'}
        </span>
        <svg className={`w-3 h-3 text-px-text-dim ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="square" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-72 bg-px-surface border-2 border-px-border shadow-pixel-glow z-50 animate-fade-in">
            <div className="py-1" role="listbox">
              {avatars.map((avatar) => (
                <button
                  key={avatar.id}
                  role="option"
                  aria-selected={avatar.id === activeAvatarId}
                  onClick={() => { onSelectAvatar(avatar.id); setIsOpen(false) }}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-none
                    ${avatar.id === activeAvatarId
                      ? 'bg-px-primary/10 border-l-3 border-l-px-primary'
                      : 'hover:bg-px-hover border-l-3 border-l-transparent'
                    }`}
                >
                  <div className={`w-8 h-8 flex items-center justify-center font-game text-[12px] flex-shrink-0
                    ${avatar.id === activeAvatarId
                      ? 'bg-px-primary text-white'
                      : 'bg-px-elevated text-px-text-sec border-2 border-px-border'
                    }`}>
                    {avatar.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-game text-[14px] text-px-text font-medium truncate">{avatar.name}</p>
                    <p className="font-game text-[12px] text-px-text-dim truncate">{avatar.description || avatar.id}</p>
                  </div>
                  {avatar.id === activeAvatarId && (
                    <span className="text-px-primary font-game text-[10px]">*</span>
                  )}
                </button>
              ))}
            </div>
            <div className="border-t-2 border-px-border p-2">
              <button
                onClick={() => { onCreateAvatar(); setIsOpen(false) }}
                className="w-full flex items-center gap-2 px-4 py-2.5
                  text-px-primary hover:bg-px-primary/10 tracking-wider"
              >
                <span className="font-game text-[13px]">[+]</span>
                <span className="font-game text-[13px]">新建分身</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
