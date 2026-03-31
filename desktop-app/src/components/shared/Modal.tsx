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
    md: 'w-[720px] max-h-[80vh]',
    lg: 'w-[90vw] h-[90vh]',
    xl: 'w-[95vw] h-[95vh]',
  }

  return (
    <div
      className="fixed inset-0 bg-px-black/80 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className={`bg-px-dark border-2 border-px-line shadow-pixel-xl ${sizeClasses[size]} flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
