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

  /** GAP9b: 粘贴图片 */
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

  /** GAP9b: 拖拽图片 */
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
      {/* 图片预览条（有图片时显示） */}
      {pendingImages.length > 0 && (
        <div className="flex gap-2 flex-wrap px-1">
          {pendingImages.map((img, i) => (
            <div key={i} className="relative group border-2 border-px-line">
              <img
                src={img}
                alt={`附件 ${i + 1}`}
                className="w-16 h-16 object-cover block"
              />
              <button
                onClick={() => removeImage(i)}
                className="absolute top-0 right-0 bg-px-black text-px-white
                  font-pixel text-[8px] w-4 h-4 flex items-center justify-center
                  opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label="移除图片"
              >
                ×
              </button>
            </div>
          ))}
          {/* 添加更多图片 */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-16 h-16 border-2 border-dashed border-px-line flex items-center justify-center
              font-pixel text-[8px] text-px-muted hover:border-px-white hover:text-px-white transition-none"
          >
            +IMG
          </button>
        </div>
      )}

      {/* 输入行 */}
      <div
        className={`flex gap-3 items-end ${isDragging ? 'ring-2 ring-px-white ring-offset-2 ring-offset-px-dark' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {/* 终端提示符 */}
        <span className="font-pixel text-px-white text-sm pb-3 select-none flex-shrink-0">&gt;_</span>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={pendingImages.length > 0 ? '添加文字描述... (Enter 发送)' : '输入消息或粘贴图片... (Enter 发送，Shift+Enter 换行)'}
          disabled={disabled}
          aria-label="消息输入框"
          className="flex-1 resize-none bg-px-dark text-px-white border-2 border-px-line
            px-4 py-3 font-mono text-sm
            placeholder:text-[#525252]
            focus:border-px-white focus:outline-none
            selection:bg-px-white selection:text-px-black
            disabled:opacity-40 disabled:cursor-not-allowed"
          rows={3}
        />

        <div className="flex flex-col gap-1 self-end flex-shrink-0">
          {/* 图片上传按钮 */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label="添加图片"
            title="添加图片 (也可粘贴或拖拽)"
            className="px-3 py-2 bg-transparent text-px-muted border-2 border-px-line
              font-pixel text-[8px] tracking-wider
              hover:border-px-white hover:text-px-white
              disabled:opacity-30 disabled:cursor-not-allowed
              transition-none"
          >
            IMG
          </button>

          <button
            onClick={handleSend}
            disabled={disabled || (!input.trim() && pendingImages.length === 0)}
            aria-label="发送消息"
            className="px-5 py-3 bg-px-white text-px-black border-2 border-px-white
              font-pixel text-[10px] tracking-wider uppercase
              hover:bg-transparent hover:text-px-white
              disabled:opacity-30 disabled:cursor-not-allowed
              shadow-pixel-white
              active:shadow-none active:translate-x-[3px] active:translate-y-[3px]
              transition-none"
          >
            SEND→
          </button>
        </div>

        {/* 隐藏的文件输入 */}
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
