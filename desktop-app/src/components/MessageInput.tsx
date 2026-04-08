import { useState, KeyboardEvent, useRef, useCallback } from 'react'

interface Props {
  onSend: (message: string, images?: string[]) => void
  disabled: boolean
}

export default function MessageInput({ onSend, disabled }: Props) {
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addImageFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      if (dataUrl) setPendingImages(prev => [...prev, dataUrl])
    }
    reader.readAsDataURL(file)
  }, [])

  const handleSend = () => {
    if ((!input.trim() && pendingImages.length === 0) || disabled) return
    onSend(input.trim(), pendingImages.length > 0 ? pendingImages : undefined)
    setInput('')
    setPendingImages([])
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) addImageFile(file)
      }
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    files.forEach(addImageFile)
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => setIsDragging(false)

  const removeImage = (index: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== index))
  }

  return (
    <div className="flex flex-col gap-2">
      {/* 图片预览条 */}
      {pendingImages.length > 0 && (
        <div className="flex gap-2 flex-wrap px-1">
          {pendingImages.map((img, i) => (
            <div key={i} className="relative group border-2 border-px-border">
              <img
                src={img}
                alt={`附件 ${i + 1}`}
                className="w-16 h-16 object-cover block"
              />
              <button
                onClick={() => removeImage(i)}
                className="absolute top-0 right-0 bg-px-danger text-white
                  font-mono text-[9px] w-4 h-4 flex items-center justify-center
                  opacity-0 group-hover:opacity-100"
                aria-label="移除图片"
              >
                ×
              </button>
            </div>
          ))}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-16 h-16 border-2 border-dashed border-px-border flex items-center justify-center
              font-mono text-px-2xs text-px-text-dim hover:border-px-primary hover:text-px-primary transition-none"
          >
            +
          </button>
        </div>
      )}

      {/* 输入行 */}
      <div
        className={`flex gap-3 items-end
          ${isDragging ? 'ring-2 ring-px-primary ring-offset-2 ring-offset-px-bg' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
          <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={pendingImages.length > 0 ? '添加文字描述... (Enter 发送)' : '输入消息... (Enter 发送，Shift+Enter 换行)'}
          disabled={disabled}
          aria-label="消息输入框"
          className="flex-1 resize-none bg-px-surface text-px-text border-2 border-px-border
            px-4 py-3 font-game text-[14px]
            placeholder:text-px-text-dim
            focus:border-px-primary focus:outline-none focus:shadow-glow-sm
            disabled:opacity-40 disabled:cursor-not-allowed"
          rows={2}
        />

        <div className="flex gap-1.5 self-end flex-shrink-0">
          {/* 图片上传按钮 */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label="添加图片"
            title="添加图片 (也可粘贴或拖拽)"
            className="px-5 py-3 bg-px-surface text-px-text-sec border-2 border-px-border
              font-game text-[13px] tracking-wider
              hover:border-px-primary hover:text-px-primary
              disabled:opacity-30 disabled:cursor-not-allowed
              transition-none"
          >
            图片
          </button>

          <button
            onClick={handleSend}
            disabled={disabled || (!input.trim() && pendingImages.length === 0)}
            aria-label="发送消息"
            className="px-5 py-3 bg-px-primary text-white border-2 border-px-primary
              font-game text-[13px] tracking-wider
              hover:bg-px-primary-hover hover:border-px-primary-hover
              disabled:opacity-30 disabled:cursor-not-allowed
              shadow-pixel-brand
              active:shadow-none active:translate-x-[2px] active:translate-y-[2px]
              transition-none"
          >
            发送
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || [])
            files.forEach(addImageFile)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
