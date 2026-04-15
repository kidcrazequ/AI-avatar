import { ReactNode } from 'react'

interface PanelHeaderProps {
  title: string
  subtitle?: string
  onClose: () => void
  actions?: ReactNode
}

export default function PanelHeader({ title, subtitle, onClose, actions }: PanelHeaderProps) {
  return (
    <div className="flex items-center justify-between px-6 py-4 bg-px-bg text-px-text border-b-2 border-px-border flex-shrink-0">
      <div className="flex items-center gap-3">
        <div className="w-1.5 h-6 bg-px-primary" />
        <div>
          <h2 className="font-game text-[14px] tracking-wider uppercase">{title}</h2>
          {subtitle && (
            <p className="font-game text-[12px] text-px-primary mt-1 tracking-wider">{subtitle}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <button onClick={onClose} className="pixel-close-btn" aria-label="关闭">X</button>
      </div>
    </div>
  )
}
