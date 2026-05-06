/**
 * 对话输入组件：支持图片 + 文档/文本/代码混合附件。
 *
 * 路由策略（与 @soul/core/browser 的 classifyAttachmentRoute 对齐）：
 *   - 图片            → 走原有 vision 链路（base64 dataURL，提交时塞进 image_url content part）
 *   - 小文本（≤5KB）   → 标记为 inline，发送时由 chatStore 拼到 user 正文
 *   - 大文档 / 大文本  → 立即 saveAttachment 落盘，pendingAttachments 只记元信息
 *
 * 上限：
 *   - 图片单文件 ≤ 20MB（沿用旧值）
 *   - 文档单文件 ≤ 50MB（@soul/core MAX_ATTACHMENT_SIZE_BYTES）
 *   - 图片 + 附件总数 ≤ MAX_ATTACHMENT_COUNT_PER_MESSAGE
 *
 * @author zhi.qu
 * @date 2026-05-01
 */

import { useState, useEffect, KeyboardEvent, useRef, useCallback } from 'react'
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENT_COUNT_PER_MESSAGE,
  ATTACHMENT_SENSITIVE_EXTENSIONS,
  ATTACHMENT_WHITELIST_EXTENSIONS,
  classifyAttachmentRoute,
  isAttachmentExtensionAllowed,
} from '@soul/core/browser'
import type { AttachmentRef } from '../stores/chatStore'

/** 图片单文件大小上限（20MB，沿用旧逻辑） */
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024
/** 压缩后最大宽/高（像素），超出时等比缩放 */
const MAX_IMAGE_DIMENSION = 1920
/** JPEG 压缩质量 */
const IMAGE_QUALITY = 0.85
/** 文件选择器 accept 字符串：用稳定常量派生，避免 dev 缓存拿到旧函数导出。 */
const ATTACHMENT_ACCEPT_STRING = ['image/*', ...ATTACHMENT_WHITELIST_EXTENSIONS].join(',')

/** 待发送的本地附件（图片单独存 dataURL，其它走 saveAttachment 拿 ID） */
interface PendingDocAttachment {
  /** 由主进程 attachments.id 决定（saveAttachment 完成后填上） */
  id: string
  name: string
  mime: string
  size: number
  /** 后缀名（含点，小写） */
  ext: string
  /** 路由：inline 文本会同时塞 inlineText 字段；document 仅占元信息 */
  route: 'inline' | 'document'
  /** inline 路由专用：直接读出来的文本内容（≤5KB） */
  inlineText?: string
  summary?: string | null
  outline?: string | null
}

/**
 * 将 data URL 通过 canvas 压缩到合理分辨率。
 * 若图片尺寸已在限制内则直接返回原始 data URL。
 */
async function compressImage(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const { width, height } = img
      const needsResize = width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
      if (!needsResize) { resolve(dataUrl); return }

      const ratio = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      const ctx = canvas.getContext('2d')
      if (!ctx) { resolve(dataUrl); return }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', IMAGE_QUALITY))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

/** ArrayBuffer → base64（不含 data: 前缀） */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  // 8KB 一段，避免大 file 一次 String.fromCharCode 撑爆栈
  const CHUNK = 0x2000
  let result = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    result += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(result)
}

/** 取后缀（含点，小写）；无后缀返回空字符串 */
function getExt(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx <= 0 || idx === name.length - 1) return ''
  return name.slice(idx).toLowerCase()
}

/** 图片分流必须同时尊重扩展名，避免 HTML 等白名单文档被异常 MIME 误判为图片。 */
function shouldRouteAsImage(file: File): boolean {
  return file.type.startsWith('image/') && !isAttachmentExtensionAllowed(getExt(file.name))
}

/** 字节大小友好显示 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

interface Props {
  /**
   * 发送回调。
   * - images：base64 dataURL[]，与原有契约一致
   * - attachments：用户上传的文档/文本附件元信息（chatStore 据此走分流逻辑）
   */
  onSend: (
    message: string,
    images?: string[],
    attachments?: AttachmentRef[],
    inlineFiles?: Array<{ name: string; ext: string; mime: string; text: string }>,
  ) => void
  disabled: boolean
  /** 外部传入文本以填充输入框（用于提示词模板一键填入） */
  fillText?: string
  /** 当前会话 ID（saveAttachment 必传；切会话时组件 key=conversationId 已重置 state） */
  conversationId?: string
}

export default function MessageInput({ onSend, disabled, fillText, conversationId }: Props) {
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [pendingDocs, setPendingDocs] = useState<PendingDocAttachment[]>([])
  const [isDragging, setIsDragging] = useState(false)
  /** 文件被拒/警告的提示，3 秒后自动消失 */
  const [hint, setHint] = useState<{ type: 'error' | 'warn' | 'info'; msg: string } | null>(null)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** 同步追踪图片 + 文档总数，用于异步流程的提前检查 */
  const totalCountRef = useRef(0)
  /** 组件是否仍挂载，防止异步压缩/IPC 完成后 setState 到已卸载组件 */
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (fillText) setInput(fillText)
  }, [fillText])

  const showHint = useCallback((type: 'error' | 'warn' | 'info', msg: string) => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    setHint({ type, msg })
    hintTimerRef.current = setTimeout(() => setHint(null), 3500)
  }, [])

  useEffect(() => () => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
  }, [])

  const addImageFile = useCallback((file: File) => {
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      showHint('error', `图片过大（${formatBytes(file.size)}），上限 ${formatBytes(MAX_IMAGE_SIZE_BYTES)}`)
      return
    }
    if (totalCountRef.current >= MAX_ATTACHMENT_COUNT_PER_MESSAGE) {
      showHint('warn', `单条消息最多 ${MAX_ATTACHMENT_COUNT_PER_MESSAGE} 个附件`)
      return
    }
    const reader = new FileReader()
    reader.onload = async (e) => {
      const dataUrl = e.target?.result as string
      if (!dataUrl) return
      const compressed = await compressImage(dataUrl)
      if (!mountedRef.current) return
      setPendingImages(prev => {
        if (totalCountRef.current >= MAX_ATTACHMENT_COUNT_PER_MESSAGE) return prev
        const next = [...prev, compressed]
        totalCountRef.current = next.length + pendingDocs.length
        return next
      })
    }
    reader.onerror = () => showHint('error', `读取图片失败: ${file.name}`)
    reader.readAsDataURL(file)
  }, [pendingDocs.length, showHint])

  const addDocumentFile = useCallback(async (file: File) => {
    const ext = getExt(file.name)
    if (!isAttachmentExtensionAllowed(ext)) {
      showHint('error', `不支持的文件类型: ${ext || '(无后缀)'}`)
      return
    }
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      showHint('error', `附件过大（${formatBytes(file.size)}），上限 ${formatBytes(MAX_ATTACHMENT_SIZE_BYTES)}`)
      return
    }
    if (totalCountRef.current >= MAX_ATTACHMENT_COUNT_PER_MESSAGE) {
      showHint('warn', `单条消息最多 ${MAX_ATTACHMENT_COUNT_PER_MESSAGE} 个附件`)
      return
    }
    if (!conversationId) {
      showHint('error', '会话未就绪，无法上传附件')
      return
    }
    if (ATTACHMENT_SENSITIVE_EXTENSIONS.has(ext)) {
      showHint('warn', `${ext} 文件可能含敏感信息，已收下但请自行核对`)
    }

    const routeMime = file.type.startsWith('image/') ? '' : file.type || ''
    const route = classifyAttachmentRoute({ mime: routeMime, ext, size: file.size })
    if (route === 'rejected' || route === 'image') {
      // image 不应进入此分支（外层已分流）；rejected 已在白名单校验时拦截
      showHint('error', `不支持的文件类型: ${ext}`)
      return
    }

    try {
      showHint('info', `正在上传附件: ${file.name}`)
      // inline 文本：直接 readAsText，避免 base64 → 解码两次浪费
      if (route === 'inline') {
        const text = await file.text()
        if (!mountedRef.current) return
        // 仍然落盘一份：让历史会话能恢复 chip + 让模型可选 read_attachment 复读
        const buffer = await file.arrayBuffer()
        const base64 = arrayBufferToBase64(buffer)
        const meta = await window.electronAPI.saveAttachment(conversationId, file.name, base64, file.type || '')
        if (!mountedRef.current) return
        setPendingDocs(prev => {
          if (totalCountRef.current >= MAX_ATTACHMENT_COUNT_PER_MESSAGE) return prev
          const next: PendingDocAttachment[] = [
            ...prev,
            {
              id: meta.id,
              name: meta.name,
              mime: meta.mime,
              size: meta.size,
              ext: meta.ext,
              route: 'inline',
              inlineText: text,
              summary: meta.summary,
              outline: meta.outline,
            },
          ]
          totalCountRef.current = pendingImages.length + next.length
          return next
        })
        showHint('info', `已添加附件: ${file.name}`)
        return
      }

      // 大文档：直接落盘 + 取摘要
      const buffer = await file.arrayBuffer()
      const base64 = arrayBufferToBase64(buffer)
      const meta = await window.electronAPI.saveAttachment(conversationId, file.name, base64, file.type || '')
      if (!mountedRef.current) return
      setPendingDocs(prev => {
        if (totalCountRef.current >= MAX_ATTACHMENT_COUNT_PER_MESSAGE) return prev
        const next: PendingDocAttachment[] = [
          ...prev,
          {
            id: meta.id,
            name: meta.name,
            mime: meta.mime,
            size: meta.size,
            ext: meta.ext,
            route: 'document',
            summary: meta.summary,
            outline: meta.outline,
          },
        ]
        totalCountRef.current = pendingImages.length + next.length
        return next
      })
      showHint('info', `已添加附件: ${file.name}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showHint('error', `上传失败: ${msg}`)
      window.electronAPI.logEvent('error', 'attachment-upload-failed', `${file.name}: ${msg}`)
    }
  }, [conversationId, pendingImages.length, showHint])

  /** 统一入口：根据 MIME 把 File 分发到 image / document 路径 */
  const addFile = useCallback((file: File) => {
    if (shouldRouteAsImage(file)) {
      addImageFile(file)
    } else {
      void addDocumentFile(file)
    }
  }, [addImageFile, addDocumentFile])

  const handleSend = () => {
    if ((!input.trim() && pendingImages.length === 0 && pendingDocs.length === 0) || disabled) return
    const attachmentRefs: AttachmentRef[] | undefined = pendingDocs.length > 0
      ? pendingDocs.map(d => ({
          id: d.id,
          name: d.name,
          mime: d.mime,
          size: d.size,
          summary: d.summary,
          outline: d.outline,
        }))
      : undefined
    const inlineFiles = pendingDocs
      .filter(d => d.route === 'inline' && d.inlineText !== undefined)
      .map(d => ({ name: d.name, ext: d.ext, mime: d.mime, text: d.inlineText! }))
    onSend(
      input.trim(),
      pendingImages.length > 0 ? pendingImages : undefined,
      attachmentRefs,
      inlineFiles.length > 0 ? inlineFiles : undefined,
    )
    setInput('')
    setPendingImages([])
    setPendingDocs([])
    totalCountRef.current = 0
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
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (!file) continue
      e.preventDefault()
      addFile(file)
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    files.forEach(addFile)
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => setIsDragging(false)

  const removeImage = (index: number) => {
    setPendingImages(prev => {
      const next = prev.filter((_, i) => i !== index)
      totalCountRef.current = next.length + pendingDocs.length
      return next
    })
  }

  const removeDoc = (id: string) => {
    setPendingDocs(prev => {
      const next = prev.filter(d => d.id !== id)
      totalCountRef.current = pendingImages.length + next.length
      return next
    })
  }

  const hasAnyAttachment = pendingImages.length > 0 || pendingDocs.length > 0

  return (
    <div className="flex flex-col gap-2">
      {hint && (
        <div
          role="status"
          className={`px-2 py-1 font-game text-[11px] tracking-wider border-2 ${
            hint.type === 'error'
              ? 'text-px-danger border-px-danger bg-px-danger/10'
              : hint.type === 'warn'
                ? 'text-px-warning border-px-warning bg-px-warning/10'
                : 'text-px-text-dim border-px-border bg-px-elevated'
          }`}
        >
          {hint.msg}
        </div>
      )}

      {/* 附件预览区：图片缩略图 + 文档 chip 并列 */}
      {hasAnyAttachment && (
        <div className="flex gap-2 flex-wrap px-1">
          {pendingImages.map((img, i) => (
            <div key={`img-${i}`} className="relative group border-2 border-px-border">
              <img
                src={img}
                alt={`图片 ${i + 1}`}
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
          {pendingDocs.map((doc) => (
            <div
              key={`doc-${doc.id}`}
              className="relative group flex items-center gap-2 px-2 py-1 border-2 border-px-border bg-px-elevated min-w-[140px] max-w-[260px]"
              title={`${doc.name} · ${formatBytes(doc.size)} · ${doc.route === 'inline' ? '小文本（内嵌）' : '大文档（按需读取）'}`}
            >
              <span className="font-mono text-[10px] text-px-primary tracking-wider flex-shrink-0">
                {doc.ext.replace('.', '').toUpperCase() || 'FILE'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-game text-[11px] text-px-text truncate">
                  {doc.name}
                </div>
                <div className="font-mono text-[9px] text-px-text-dim">
                  {formatBytes(doc.size)} · {doc.route === 'inline' ? 'inline' : 'doc'}
                </div>
              </div>
              <button
                onClick={() => removeDoc(doc.id)}
                className="flex-shrink-0 bg-px-danger text-white
                  font-mono text-[10px] w-4 h-4 flex items-center justify-center
                  opacity-0 group-hover:opacity-100"
                aria-label={`移除 ${doc.name}`}
              >
                ×
              </button>
            </div>
          ))}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-16 h-16 border-2 border-dashed border-px-border flex items-center justify-center
              font-mono text-px-2xs text-px-text-dim hover:border-px-primary hover:text-px-primary transition-none"
            aria-label="添加附件"
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
          placeholder={hasAnyAttachment ? '添加文字描述... (Enter 发送)' : '输入消息... (Enter 发送，Shift+Enter 换行)'}
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
          {/* 附件上传按钮（图片 + 文档统一入口） */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label="添加附件"
            title="添加图片或文档（也可粘贴/拖拽）"
            className="px-5 py-3 bg-px-surface text-px-text-sec border-2 border-px-border
              font-game text-[13px] tracking-wider
              hover:border-px-primary hover:text-px-primary
              disabled:opacity-30 disabled:cursor-not-allowed
              transition-none"
          >
            附件
          </button>

          <button
            onClick={handleSend}
            disabled={disabled || (!input.trim() && pendingImages.length === 0 && pendingDocs.length === 0)}
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
          accept={ATTACHMENT_ACCEPT_STRING}
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || [])
            files.forEach(addFile)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
