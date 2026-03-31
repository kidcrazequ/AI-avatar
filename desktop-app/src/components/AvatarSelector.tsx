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
        className="flex items-center gap-3 px-4 py-2 bg-px-dark text-px-white border-2 border-px-line
          hover:border-px-white transition-none select-none"
      >
        {/* 方形像素头像 */}
        <div className="w-7 h-7 bg-px-white text-px-black flex items-center justify-center font-pixel text-[10px] flex-shrink-0">
          {initials}
        </div>
        <span className="font-mono text-sm font-medium max-w-[140px] truncate">
          {activeAvatar?.name || '选择分身'}
        </span>
        <span className="font-pixel text-[8px] text-px-muted ml-1">
          {isOpen ? '▲' : '▼'}
        </span>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-72 bg-px-dark border-2 border-px-black shadow-pixel z-50">
            <div className="py-1" role="listbox">
              {avatars.map((avatar) => (
                <button
                  key={avatar.id}
                  role="option"
                  aria-selected={avatar.id === activeAvatarId}
                  onClick={() => { onSelectAvatar(avatar.id); setIsOpen(false) }}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left
                    ${avatar.id === activeAvatarId
                      ? 'bg-px-mid border-l-2 border-l-px-white'
                      : 'hover:bg-px-mid border-l-2 border-l-transparent'
                    }`}
                >
                  <div className="w-8 h-8 bg-px-white text-px-black flex items-center justify-center font-pixel text-[10px] flex-shrink-0">
                    {avatar.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-sm text-px-white font-medium truncate">{avatar.name}</p>
                    <p className="font-pixel text-[8px] text-px-muted truncate">{avatar.description || avatar.id}</p>
                  </div>
                </button>
              ))}
            </div>
            <div className="border-t-2 border-px-line p-2">
              <button
                onClick={() => { onCreateAvatar(); setIsOpen(false) }}
                className="w-full flex items-center gap-2 px-4 py-2.5
                  text-px-white hover:bg-px-mid font-pixel text-[10px] tracking-wider"
              >
                <span className="text-base leading-none">+</span>
                <span>CREATE NEW</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
