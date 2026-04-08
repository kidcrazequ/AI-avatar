import { ReactNode } from 'react'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

export default function Modal({ isOpen, onClose, children, size = 'lg' }: ModalProps) {
  if (!isOpen) return null

  const sizeClasses = {
    sm: 'w-[600px] max-h-[70vh]',
    md: 'w-[720px] h-[80vh]',
    lg: 'w-[90vw] h-[90vh]',
    xl: 'w-[95vw] h-[95vh]',
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 animate-fade-in"
      onClick={onClose}
    >
      <div
        className={`bg-px-surface border-2 border-px-border shadow-pixel-glow ${sizeClasses[size]} flex flex-col animate-pixel-expand`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
