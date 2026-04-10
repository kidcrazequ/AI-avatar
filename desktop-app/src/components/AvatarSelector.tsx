/**
 * @file AvatarSelector.tsx — 顶栏分身选择器（含换头像入口）
 * @author zhi.qu
 * @date 2026-04-10
 */

import { useState, useEffect } from 'react'
import AvatarImage from './AvatarImage'
import AvatarPicker from './AvatarPicker'

interface Props {
  activeAvatarId: string
  onSelectAvatar: (id: string) => void
  onCreateAvatar: () => void
  /** 保存头像成功后通知 App 刷新分身列表（如 ChatWindow 依赖的 avatarImage） */
  onAvatarsChanged?: () => void | Promise<void>
  /** 保存成功/失败提示（与项目 Toast 规范一致） */
  showToast?: (message: string, type?: 'success' | 'error') => void
}

export default function AvatarSelector({
  activeAvatarId,
  onSelectAvatar,
  onCreateAvatar,
  onAvatarsChanged,
  showToast,
}: Props) {
  const [avatars, setAvatars] = useState<Avatar[]>([])
  const [isOpen, setIsOpen] = useState(false)
  /** 是否显示换头像弹窗 */
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)
  /** 换头像时的临时选择值 */
  const [pickerValue, setPickerValue] = useState<string>('')
  const [isSaving, setIsSaving] = useState(false)

  const loadAvatars = () => {
    window.electronAPI.listAvatars().then(setAvatars)
  }

  useEffect(() => {
    loadAvatars()
  }, [])

  const activeAvatar = avatars.find(a => a.id === activeAvatarId)

  const handleOpenPicker = () => {
    setPickerValue(activeAvatar?.avatarImage ?? '')
    setShowAvatarPicker(true)
    setIsOpen(false)
  }

  const handleSaveAvatar = async () => {
    const trimmed = pickerValue.trim()
    if (!trimmed) {
      showToast?.('请先选择预置头像或上传图片', 'error')
      return
    }
    if (!activeAvatarId.trim()) {
      showToast?.('未选择分身，无法保存头像', 'error')
      return
    }
    setIsSaving(true)
    try {
      await window.electronAPI.saveAvatarImage(activeAvatarId, trimmed)
      await onAvatarsChanged?.()
      loadAvatars()
      setShowAvatarPicker(false)
      showToast?.('头像已保存', 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      window.electronAPI.logEvent('error', 'avatar-selector-save-image', msg)
      showToast?.(`保存失败：${msg}`, 'error')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <>
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          className="flex items-center gap-3 px-3 py-1.5 bg-px-elevated text-px-text border-2 border-px-border
            hover:border-px-primary transition-none select-none"
        >
          {/* 分身头像（sm 尺寸） */}
          <AvatarImage avatarImage={activeAvatar?.avatarImage} name={activeAvatar?.name ?? '?'} size="sm" />
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
                    <AvatarImage avatarImage={avatar.avatarImage} name={avatar.name} size="sm" />
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
              <div className="border-t-2 border-px-border p-2 space-y-1">
                {/* 换头像入口 */}
                {activeAvatarId && (
                  <button
                    onClick={handleOpenPicker}
                    className="w-full flex items-center gap-2 px-4 py-2.5
                      text-px-text-sec hover:bg-px-hover tracking-wider"
                  >
                    <span className="font-game text-[13px]">[✎]</span>
                    <span className="font-game text-[13px]">换头像</span>
                  </button>
                )}
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

      {/* 换头像弹窗 */}
      {showAvatarPicker && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-[2px] flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-px-surface border-2 border-px-border shadow-pixel-glow w-[460px] max-h-[90vh] flex flex-col animate-pixel-expand">
            {/* 头部 */}
            <div className="flex items-center justify-between px-5 py-4 bg-px-bg border-b-2 border-px-border">
              <div className="flex items-center gap-3">
                <div className="w-1.5 h-5 bg-px-primary" />
                <span className="font-game text-[14px] text-px-text tracking-wider">
                  换头像 — {activeAvatar?.name}
                </span>
              </div>
              <button
                onClick={() => setShowAvatarPicker(false)}
                className="pixel-close-btn"
                aria-label="关闭"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="square" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* 内容 */}
            <div className="flex-1 overflow-y-auto p-5">
              <AvatarPicker value={pickerValue} onChange={setPickerValue} />
            </div>

            {/* 底部按钮 */}
            <div className="flex items-center justify-between px-5 py-4 border-t-2 border-px-border bg-px-elevated">
              <button
                onClick={() => setShowAvatarPicker(false)}
                className="pixel-btn-outline-muted"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSaveAvatar}
                disabled={isSaving || !pickerValue.trim()}
                className="pixel-btn-primary"
              >
                {isSaving ? '保存中...' : '保存头像'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
