interface Props {
  message: string
  type?: 'success' | 'error'
}

/** 像素风 Toast 通知，替代原生 alert() */
export default function Toast({ message, type = 'success' }: Props) {
  return (
    <div
      className={`fixed bottom-6 right-6 z-50 px-5 py-3
        border-2 font-pixel text-[10px] tracking-wider
        shadow-pixel
        animate-pixel-in
        ${type === 'error'
          ? 'bg-px-danger text-px-white border-px-danger'
          : 'bg-px-black text-px-white border-px-black'
        }`}
      role="alert"
      aria-live="polite"
    >
      {message}
    </div>
  )
}
