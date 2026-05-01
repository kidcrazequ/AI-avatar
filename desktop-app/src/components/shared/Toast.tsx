interface Props {
  message: string
  type?: 'success' | 'error'
}

export default function Toast({ message, type = 'success' }: Props) {
  return (
    <div
      className={`fixed bottom-6 right-6 z-50 px-5 py-3
        border-2 font-game text-[13px] tracking-wider
        shadow-pixel-brand animate-slide-up
        ${type === 'error'
          ? 'bg-px-danger text-white border-px-danger shadow-[2px_2px_0_0_#B83030]'
          : 'bg-px-primary text-px-bg border-px-primary shadow-pixel-brand'
        }`}
      role="alert"
      aria-live="polite"
    >
      {message}
    </div>
  )
}
