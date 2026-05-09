/**
 * @file Toast.tsx — 轻量像素风 Toast 组件
 *
 * 支持可选 onClick 回调（Phase 4 新增）：用于"点击 Toast 跳转面板"等场景。
 * 当 onClick 存在时切换为 button 角色 + cursor-pointer 视觉反馈。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

interface Props {
  message: string
  type?: 'success' | 'error'
  /** 可选点击回调（提供时 Toast 显示为可点击按钮） */
  onClick?: () => void
}

export default function Toast({ message, type = 'success', onClick }: Props) {
  const baseClass = `fixed bottom-6 right-6 z-50 px-5 py-3
    border-2 font-game text-[13px] tracking-wider
    shadow-pixel-brand animate-slide-up
    ${type === 'error'
      ? 'bg-px-danger text-white border-px-danger shadow-[2px_2px_0_0_#B83030]'
      : 'bg-px-primary text-px-bg border-px-primary shadow-pixel-brand'
    }`

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${baseClass} cursor-pointer hover:opacity-90 transition-opacity`}
        aria-live="polite"
      >
        {message}
      </button>
    )
  }

  return (
    <div
      className={baseClass}
      role="alert"
      aria-live="polite"
    >
      {message}
    </div>
  )
}
