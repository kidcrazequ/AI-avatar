import { ReactNode } from 'react'

interface PanelHeaderProps {
  title: string
  subtitle?: string
  onClose: () => void
  actions?: ReactNode
}

export default function PanelHeader({ title, subtitle, onClose, actions }: PanelHeaderProps) {
  return (
    <div className="flex items-center justify-between px-6 py-4 bg-px-black text-px-white border-b-2 border-px-black flex-shrink-0">
      <div>
        <h2 className="font-pixel text-sm tracking-wider">{title}</h2>
        {subtitle && (
          <p className="font-pixel text-[8px] text-px-muted mt-1 tracking-wider">{subtitle}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <button onClick={onClose} className="pixel-close-btn" aria-label="关闭">X</button>
      </div>
    </div>
  )
}
