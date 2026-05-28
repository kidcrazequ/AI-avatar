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

import { useState, useEffect, KeyboardEvent, useRef, useCallback, useMemo } from 'react'
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENT_COUNT_PER_MESSAGE,
  ATTACHMENT_SENSITIVE_EXTENSIONS,
  ATTACHMENT_WHITELIST_EXTENSIONS,
  classifyAttachmentRoute,
  isAttachmentExtensionAllowed,
} from '@soul/core/browser'
import type { AttachmentRef } from '../stores/chatStore'
import SlashCommandPalette, { SlashCommandItem } from './SlashCommandPalette'
import ContextReferencePalette, { ContextNamespace, ContextEntry } from './ContextReferencePalette'
import { AVAILABLE_NAMESPACES, listEntries, resolveEntryContent } from '../services/context-resolver'

/** 图片单文件大小上限（20MB，沿用旧逻辑） */
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024
/** 压缩后最大宽/高（像素），超出时等比缩放 */
const MAX_IMAGE_DIMENSION = 1920
/** JPEG 压缩质量 */
const IMAGE_QUALITY = 0.85
/** 文件选择器 accept 字符串：用稳定常量派生，避免 dev 缓存拿到旧函数导出。 */
const ATTACHMENT_ACCEPT_STRING = ['image/*', ...ATTACHMENT_WHITELIST_EXTENSIONS].join(',')
/** 豆包流式 ASR 目标采样率：协议层固定 16kHz / s16le / mono。 */
const ASR_TARGET_SAMPLE_RATE = 16_000
/** ASR PCM 分片发送间隔：低于 200ms 保持输入框实时感。 */
const ASR_CHUNK_INTERVAL_MS = 160

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

function concatFloat32Chunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

function downsampleToPcm16(chunks: Float32Array[], inputSampleRate: number): Uint8Array {
  const input = concatFloat32Chunks(chunks)
  if (input.length === 0) return new Uint8Array()
  const ratio = inputSampleRate / ASR_TARGET_SAMPLE_RATE
  const outputLength = Math.max(0, Math.floor(input.length / ratio))
  const output = new Uint8Array(outputLength * 2)
  const view = new DataView(output.buffer)

  for (let i = 0; i < outputLength; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)] ?? 0))
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return output
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
  /** 当前分身 ID（Slash 命令面板加载该分身已启用的技能；未传则不显示面板） */
  avatarId?: string
}

export default function MessageInput({ onSend, disabled, fillText, conversationId, avatarId }: Props) {
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [pendingDocs, setPendingDocs] = useState<PendingDocAttachment[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isAsrStarting, setIsAsrStarting] = useState(false)
  // ── Slash 命令面板 state ──
  /** 全部已启用技能（按 avatarId 切换时重新拉取） */
  const [allSkills, setAllSkills] = useState<SlashCommandItem[]>([])
  /** Palette 是否可见 */
  const [slashOpen, setSlashOpen] = useState(false)
  /** Palette 中当前高亮索引 */
  const [slashIndex, setSlashIndex] = useState(0)
  /** 输入框中"/"起始位置（绝对偏移），用于选中后定位替换范围；-1 表示未在 slash 模式 */
  const slashStartRef = useRef(-1)
  /** IME 拼写中标志：中文输入时 keydown 的 Enter / ArrowUp 不能拦截 */
  const isComposingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ── @ 引用上下文面板 state ──
  const [ctxOpen, setCtxOpen] = useState(false)
  /** 当前级别：'namespace' 选 @knowledge 等大类；'entries' 选具体项 */
  const [ctxLevel, setCtxLevel] = useState<'namespace' | 'entries'>('namespace')
  const [ctxNsIndex, setCtxNsIndex] = useState(0)
  const [ctxEntryIndex, setCtxEntryIndex] = useState(0)
  const [ctxActiveNs, setCtxActiveNs] = useState<ContextNamespace | null>(null)
  const [ctxEntries, setCtxEntries] = useState<ContextEntry[]>([])
  const [ctxLoading, setCtxLoading] = useState(false)
  /** 输入框中 "@" 起始位置；-1 表示未在 @ 模式 */
  const ctxStartRef = useRef(-1)
  /** Level 1 输入的 namespace 前缀（@k 时是 "k"） */
  const [ctxNsQuery, setCtxNsQuery] = useState('')
  /** @conversation 引用时要回看的消息数（用户可在 palette 顶部改） */
  const [ctxConvMsgCount, setCtxConvMsgCount] = useState(30)
  /** 文件被拒/警告的提示，3 秒后自动消失 */
  const [hint, setHint] = useState<{ type: 'error' | 'warn' | 'info'; msg: string } | null>(null)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const asrFlushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const asrChunksRef = useRef<Float32Array[]>([])
  const asrInputSampleRateRef = useRef(ASR_TARGET_SAMPLE_RATE)
  const lastAsrTextRef = useRef('')
  /** 同步追踪图片 + 文档总数，用于异步流程的提前检查 */
  const totalCountRef = useRef(0)
  /** 组件是否仍挂载，防止异步压缩/IPC 完成后 setState 到已卸载组件 */
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 父组件传 fillText 同步进本地 input state，是受控/非受控混合的合法模式
    if (fillText) setInput(fillText)
  }, [fillText])

  const showHint = useCallback((type: 'error' | 'warn' | 'info', msg: string) => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    setHint({ type, msg })
    hintTimerRef.current = setTimeout(() => setHint(null), 3500)
  }, [])

  const cleanupAudioCapture = useCallback(() => {
    if (asrFlushTimerRef.current) {
      clearInterval(asrFlushTimerRef.current)
      asrFlushTimerRef.current = null
    }
    audioProcessorRef.current?.disconnect()
    audioProcessorRef.current = null
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error)
        window.electronAPI.logEvent('warn', 'asr-audio-context-close-failed', msg)
      })
    }
    audioContextRef.current = null
    asrChunksRef.current = []
  }, [])

  const flushAsrChunks = useCallback(() => {
    const chunks = asrChunksRef.current
    if (chunks.length === 0) return
    asrChunksRef.current = []
    const pcm = downsampleToPcm16(chunks, asrInputSampleRateRef.current)
    if (pcm.byteLength === 0) return
    window.electronAPI.asrPushPcm(pcm).catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error)
      showHint('error', `语音分片发送失败: ${msg}`)
      window.electronAPI.logEvent('error', 'asr-push-pcm-failed', msg)
    })
  }, [showHint])

  const stopAsrRecording = useCallback(async () => {
    flushAsrChunks()
    cleanupAudioCapture()
    setIsRecording(false)
    setIsAsrStarting(false)
    try {
      await window.electronAPI.asrStop()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      showHint('error', `停止语音输入失败: ${msg}`)
      window.electronAPI.logEvent('error', 'asr-stop-failed', msg)
    }
  }, [cleanupAudioCapture, flushAsrChunks, showHint])

  const startAsrRecording = useCallback(async () => {
    if (disabled || isAsrStarting || isRecording) return
    if (!navigator.mediaDevices?.getUserMedia) {
      showHint('error', '当前环境不支持麦克风录音')
      return
    }

    setIsAsrStarting(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      await window.electronAPI.asrStart()

      const audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0)
        asrChunksRef.current.push(new Float32Array(inputData))
      }
      source.connect(processor)
      processor.connect(audioContext.destination)

      audioContextRef.current = audioContext
      audioProcessorRef.current = processor
      asrInputSampleRateRef.current = audioContext.sampleRate
      lastAsrTextRef.current = ''
      asrFlushTimerRef.current = setInterval(flushAsrChunks, ASR_CHUNK_INTERVAL_MS)
      setIsRecording(true)
      showHint('info', '正在听写，点击麦克风结束')
    } catch (error) {
      cleanupAudioCapture()
      const msg = error instanceof Error ? error.message : String(error)
      showHint('error', `启动语音输入失败: ${msg}`)
      window.electronAPI.logEvent('error', 'asr-start-failed', msg)
      window.electronAPI.asrCancel().catch((cancelError: unknown) => {
        const cancelMsg = cancelError instanceof Error ? cancelError.message : String(cancelError)
        window.electronAPI.logEvent('warn', 'asr-cancel-after-start-failed', cancelMsg)
      })
    } finally {
      setIsAsrStarting(false)
    }
  }, [cleanupAudioCapture, disabled, flushAsrChunks, isAsrStarting, isRecording, showHint])

  const toggleAsrRecording = useCallback(() => {
    if (isRecording) {
      void stopAsrRecording()
    } else {
      void startAsrRecording()
    }
  }, [isRecording, startAsrRecording, stopAsrRecording])

  useEffect(() => () => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
  }, [])

  useEffect(() => {
    const offPartial = window.electronAPI.onAsrPartial((payload) => {
      const nextText = payload.text.trim()
      if (!nextText || nextText === lastAsrTextRef.current) return
      setInput(prev => {
        const lastText = lastAsrTextRef.current
        const base = lastText && prev.endsWith(lastText) ? prev.slice(0, -lastText.length).trimEnd() : prev.trimEnd()
        return base ? `${base} ${nextText}` : nextText
      })
      lastAsrTextRef.current = nextText
    })
    const offError = window.electronAPI.onAsrError((payload) => {
      cleanupAudioCapture()
      setIsRecording(false)
      setIsAsrStarting(false)
      showHint('error', `语音识别失败: ${payload.message}`)
      window.electronAPI.logEvent('error', 'asr-session-error', payload.message)
    })
    const offEnd = window.electronAPI.onAsrEnd(() => {
      cleanupAudioCapture()
      setIsRecording(false)
      setIsAsrStarting(false)
      lastAsrTextRef.current = ''
    })
    return () => {
      offPartial()
      offError()
      offEnd()
    }
  }, [cleanupAudioCapture, showHint])

  useEffect(() => () => {
    cleanupAudioCapture()
    window.electronAPI.asrCancel().catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('warn', 'asr-cancel-on-unmount-failed', msg)
    })
  }, [cleanupAudioCapture])

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
    // 区分 DB-backed attachment（id=att_xxx，主进程 read_attachment 能查到）
    // 与 synthetic inline reference（id=@web:/@knowledge:/@conversation:，前端
    // 临时构造，主进程 DB 没行）。后者只走 inline content，不进 <attachments>
    // 元信息——否则模型看到 <attachment id="@knowledge:..." /> 调 read_attachment
    // 一定拿到「附件不存在」。
    const isDbBackedAttachment = (id: string): boolean => id.startsWith('att_')
    const dbBacked = pendingDocs.filter(d => isDbBackedAttachment(d.id))
    const attachmentRefs: AttachmentRef[] | undefined = dbBacked.length > 0
      ? dbBacked.map(d => ({
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

  // ──────────────────────────── Slash 命令面板 ────────────────────────────
  // 拉取当前分身的全部已启用技能：
  //   1) getSkills(avatarId) — local 技能（物理存在于 avatars/<id>/skills/）
  //   2) getAvailableSharedSkills(avatarId) — shared/skills/*.md 中已在该分身 skill-index.yaml 引用的
  //   同名时 local 优先（local override 是显式覆写），shared 视作备份不重复列。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- avatarId 缺失时同步清空 skills 是防御性清理，非"派生 state"反模式
    if (!avatarId) { setAllSkills([]); return }
    let cancelled = false
    Promise.all([
      window.electronAPI.getSkills(avatarId),
      window.electronAPI.getAvailableSharedSkills(avatarId),
    ]).then(([localList, sharedList]) => {
      if (cancelled || !mountedRef.current) return
      const items: SlashCommandItem[] = []
      const seen = new Set<string>()
      for (const s of localList) {
        if (!s.enabled) continue
        const name = s.name || s.id
        if (seen.has(name)) continue
        seen.add(name)
        items.push({ name, description: s.description || '', source: s.source ?? 'local' })
      }
      for (const s of sharedList) {
        if (!s.enabled) continue // 只列已在该分身 skill-index.yaml 引用的
        if (seen.has(s.name)) continue // local 优先
        seen.add(s.name)
        items.push({ name: s.name, description: s.description || '', source: 'shared' })
      }
      setAllSkills(items)
    }).catch((err: unknown) => {
      window.electronAPI.logEvent('warn', 'slash-palette-load-skills-failed', err instanceof Error ? err.message : String(err))
    })
    return () => { cancelled = true }
  }, [avatarId])

  /** 当前 query：从 slashStartRef 到光标位置之间的内容（去掉首字符 `/`） */
  // textareaRef / slashStartRef 是 DOM/标量 ref，render 期间读它们 stable
  // （textarea mount 后 .current 指向不变，slashStart 只在 input handler 里写）。
  // React 19 的 react-hooks/refs 规则一刀切禁了，但本场景不会出现 inconsistent render。
  /* eslint-disable react-hooks/refs */
  const slashQuery = useMemo(() => {
    if (!slashOpen || slashStartRef.current < 0) return ''
    const end = textareaRef.current?.selectionStart ?? input.length
    const raw = input.slice(slashStartRef.current + 1, end)
    return raw.toLowerCase()
  }, [slashOpen, input])
  /* eslint-enable react-hooks/refs */

  /** 过滤后的技能候选：优先匹配 name 前缀，其次 name 包含，再次 description 包含 */
  const filteredSkills = useMemo<SlashCommandItem[]>(() => {
    if (allSkills.length === 0) return []
    if (!slashQuery) return allSkills.slice(0, 50) // 不输入时展示全部（截断防卡顿）
    const q = slashQuery
    const scored: Array<{ item: SlashCommandItem; score: number }> = []
    for (const item of allSkills) {
      const name = item.name.toLowerCase()
      const desc = item.description.toLowerCase()
      if (name.startsWith(q)) scored.push({ item, score: 0 })
      else if (name.includes(q)) scored.push({ item, score: 1 })
      else if (desc.includes(q)) scored.push({ item, score: 2 })
    }
    scored.sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name))
    return scored.slice(0, 50).map(x => x.item)
  }, [allSkills, slashQuery])

  /** Palette 选中后：把 `/<name> ` 替换输入框中 `/...` 那段 */
  const handleSlashSelect = useCallback((item: SlashCommandItem) => {
    if (slashStartRef.current < 0) return
    const ta = textareaRef.current
    const cursor = ta?.selectionStart ?? input.length
    const before = input.slice(0, slashStartRef.current)
    const after = input.slice(cursor)
    const inserted = `/${item.name} `
    const next = before + inserted + after
    setInput(next)
    setSlashOpen(false)
    slashStartRef.current = -1
    // 重置光标到插入末尾
    requestAnimationFrame(() => {
      if (!ta) return
      const pos = before.length + inserted.length
      ta.focus()
      ta.setSelectionRange(pos, pos)
    })
  }, [input])

  /**
   * @ 引用 entries 加载请求序号——防止快速输入时旧 query 晚返回覆盖新候选。
   * 仿 GlobalSearchPalette 的 searchSeqRef 模式：每次发起请求 +1，返回时只接受
   * 序号 = 当前序号 的结果。
   */
  const ctxEntriesSeqRef = useRef(0)

  /** 选定 namespace 后异步加载 entries */
  const loadCtxEntries = useCallback(async (ns: ContextNamespace, query: string) => {
    if (!avatarId) { setCtxEntries([]); return }
    if (ns.key === 'web') { setCtxEntries([]); return } // @web 不进 entries 列表
    const seq = ++ctxEntriesSeqRef.current
    setCtxLoading(true)
    try {
      const list = await listEntries(ns.key, avatarId, query, conversationId)
      if (!mountedRef.current) return
      // race guard：旧 query 晚返回时 seq 已不等于 current，丢弃结果
      if (seq !== ctxEntriesSeqRef.current) return
      setCtxEntries(list)
    } catch (err) {
      window.electronAPI.logEvent(
        'warn',
        'context-resolver-list-failed',
        `${ns.key}: ${err instanceof Error ? err.message : String(err)}`,
      )
      if (mountedRef.current && seq === ctxEntriesSeqRef.current) setCtxEntries([])
    } finally {
      if (mountedRef.current && seq === ctxEntriesSeqRef.current) setCtxLoading(false)
    }
  }, [avatarId, conversationId])

  /** 关闭 @ 面板（用于 Esc / 选中后 / 失焦） */
  const closeCtxPalette = useCallback(() => {
    setCtxOpen(false)
    setCtxLevel('namespace')
    setCtxNsIndex(0)
    setCtxEntryIndex(0)
    setCtxActiveNs(null)
    setCtxEntries([])
    setCtxNsQuery('')
    ctxStartRef.current = -1
  }, [])

  /** 按 namespace 前缀过滤 Level 1 列表（输 @k 时只列 knowledge） */
  const filteredNamespaces = useMemo(() => {
    if (!ctxNsQuery) return [...AVAILABLE_NAMESPACES]
    const q = ctxNsQuery.toLowerCase()
    return AVAILABLE_NAMESPACES.filter(n =>
      n.key.toLowerCase().startsWith(q) || n.label.toLowerCase().startsWith(q),
    )
  }, [ctxNsQuery])

  /** 选中 namespace（Level 1 → 进入 Level 2） */
  const handleSelectNamespace = useCallback((ns: ContextNamespace) => {
    if (ns.key === 'web') {
      // @web 完整版：弹 prompt 收集 query → 调 webSearch → 把结果作为 inline file 塞 pendingDocs
      if (ctxStartRef.current < 0) return
      const ta = textareaRef.current
      const cursor = ta?.selectionStart ?? input.length
      const before = input.slice(0, ctxStartRef.current)
      const after = input.slice(cursor)
      // 移除 input 中 @web 文本
      const cleaned = (before + after).replace(/[ \t]+$/, '')
      setInput(cleaned)
      closeCtxPalette()
      requestAnimationFrame(() => {
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(before.length, before.length)
      })
      const query = window.prompt('联网搜索关键词：', '')
      if (!query || !query.trim()) return
      if (totalCountRef.current >= MAX_ATTACHMENT_COUNT_PER_MESSAGE) {
        showHint('warn', `单条消息最多 ${MAX_ATTACHMENT_COUNT_PER_MESSAGE} 个附件`)
        return
      }
      showHint('info', `正在联网搜索：${query.slice(0, 40)}...`)
      void window.electronAPI.webSearch(query.trim()).then(({ query: q, results, abstract, abstractSource }) => {
        if (!mountedRef.current) return
        const parts: string[] = [`# 联网搜索：${q}`]
        if (abstract) {
          parts.push(`\n## 摘要${abstractSource ? `（来源：${abstractSource}）` : ''}\n${abstract}`)
        }
        if (results.length === 0) {
          parts.push('\n（DuckDuckGo Instant Answer 未返回结果。Long-tail 查询建议改用 @web 之外的搜索 MCP，如 Tavily。）')
        } else {
          parts.push(`\n## 结果（${results.length} 条）`)
          for (const r of results) {
            parts.push(`\n- **${r.title}**\n  ${r.snippet}\n  ${r.url}`)
          }
        }
        const text = parts.join('\n')
        const fakeId = `@web:${Date.now()}`
        setPendingDocs(prev => {
          if (totalCountRef.current >= MAX_ATTACHMENT_COUNT_PER_MESSAGE) return prev
          const next: PendingDocAttachment[] = [
            ...prev,
            {
              id: fakeId,
              name: `@web/${q.slice(0, 30)}.md`,
              mime: 'text/markdown',
              size: text.length,
              ext: '.md',
              route: 'inline',
              inlineText: text,
              summary: null,
              outline: null,
            },
          ]
          totalCountRef.current = pendingImages.length + next.length
          return next
        })
        showHint('info', `已引用 @web/${q.slice(0, 20)}（${results.length} 条结果）`)
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        showHint('error', `联网搜索失败：${msg}`)
        window.electronAPI.logEvent('warn', 'web-search-failed', msg)
      })
      return
    }
    setCtxActiveNs(ns)
    setCtxLevel('entries')
    setCtxEntryIndex(0)
    void loadCtxEntries(ns, '')
    // 把 input 中 "@<已输部分>" 替换为 "@<ns.key>/"，让用户能接着敲过滤词
    if (ctxStartRef.current >= 0) {
      const ta = textareaRef.current
      const cursor = ta?.selectionStart ?? input.length
      const before = input.slice(0, ctxStartRef.current)
      const after = input.slice(cursor)
      const inserted = `@${ns.key}/`
      const next = before + inserted + after
      setInput(next)
      requestAnimationFrame(() => {
        if (!ta) return
        const pos = before.length + inserted.length
        ta.focus()
        ta.setSelectionRange(pos, pos)
      })
    }
  }, [input, closeCtxPalette, loadCtxEntries, pendingImages.length, showHint])

  /** 选中 entry：展开为 inlineFile 推入 pendingDocs，并把输入框中 @ 起始那段移除 */
  const handleSelectEntry = useCallback(async (entry: ContextEntry) => {
    if (!avatarId || ctxStartRef.current < 0) return
    if (totalCountRef.current >= MAX_ATTACHMENT_COUNT_PER_MESSAGE) {
      showHint('warn', `单条消息最多 ${MAX_ATTACHMENT_COUNT_PER_MESSAGE} 个附件`)
      closeCtxPalette()
      return
    }
    const ta = textareaRef.current
    const cursor = ta?.selectionStart ?? input.length
    const before = input.slice(0, ctxStartRef.current)
    const after = input.slice(cursor)
    // 先把输入框中 @... 那段移除
    const cleaned = (before + after).replace(/[ \t]+$/, '')
    setInput(cleaned)
    closeCtxPalette()
    requestAnimationFrame(() => {
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(before.length, before.length)
    })
    // 异步展开内容并塞进 pendingDocs（作为 inline 附件，已有 chip UI 渲染）
    const resolved = await resolveEntryContent(entry, avatarId, {
      conversationMessageCount: entry.namespace === 'conversation' ? ctxConvMsgCount : undefined,
    })
    if (!resolved || !mountedRef.current) return
    setPendingDocs(prev => {
      if (totalCountRef.current >= MAX_ATTACHMENT_COUNT_PER_MESSAGE) return prev
      const fakeId = `@${entry.namespace}:${entry.id}:${Date.now()}`
      const next: PendingDocAttachment[] = [
        ...prev,
        {
          id: fakeId,
          name: `@${entry.namespace}/${resolved.name}`,
          mime: resolved.mime,
          size: resolved.text.length,
          ext: resolved.ext,
          route: 'inline',
          inlineText: resolved.text,
          summary: null,
          outline: null,
        },
      ]
      totalCountRef.current = pendingImages.length + next.length
      return next
    })
    showHint('info', `已引用 @${entry.namespace}/${entry.title}`)
  }, [avatarId, closeCtxPalette, ctxConvMsgCount, input, pendingImages.length, showHint])

  /** textarea onChange：检测 slash / @ 起始 + 同步 query */
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInput(value)
    if (!avatarId) return
    const cursor = e.target.selectionStart ?? value.length
    // 取光标左侧最近的 token：往前到第一个空白或字符串头
    let tokenStart = cursor
    while (tokenStart > 0 && !/\s/.test(value[tokenStart - 1])) tokenStart -= 1
    const token = value.slice(tokenStart, cursor)

    // / 和 @ 互斥：先关闭对方
    if (token.startsWith('/')) {
      slashStartRef.current = tokenStart
      setSlashOpen(true)
      setSlashIndex(0)
      closeCtxPalette()
      return
    }

    if (token.startsWith('@')) {
      ctxStartRef.current = tokenStart
      // 解析 namespace 子串：@knowledge/xxx 中 "knowledge" 是 namespace，"xxx" 是 entries 查询
      const afterAt = token.slice(1)
      const slashIdx = afterAt.indexOf('/')
      slashStartRef.current = -1
      setSlashOpen(false)
      setCtxOpen(true)
      if (slashIdx < 0) {
        // Level 1：用 afterAt 作为 namespace 前缀过滤
        setCtxLevel('namespace')
        setCtxActiveNs(null)
        setCtxNsIndex(0)
        setCtxNsQuery(afterAt)
      } else {
        // @<ns>/<query> 形式：进入 entries 查询
        const nsKey = afterAt.slice(0, slashIdx)
        const query = afterAt.slice(slashIdx + 1)
        const matched = AVAILABLE_NAMESPACES.find(n => n.key === nsKey)
        if (matched) {
          if (!ctxActiveNs || ctxActiveNs.key !== matched.key) {
            setCtxActiveNs(matched)
            setCtxLevel('entries')
            setCtxEntryIndex(0)
          }
          void loadCtxEntries(matched, query)
        } else {
          // 未匹配到 namespace，回到 Level 1
          setCtxLevel('namespace')
          setCtxActiveNs(null)
        }
      }
      return
    }

    // 既不是 / 也不是 @：关闭两个面板
    slashStartRef.current = -1
    setSlashOpen(false)
    closeCtxPalette()
  }, [avatarId, ctxActiveNs, closeCtxPalette, loadCtxEntries])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 拼写中：所有命令键放行
    if (isComposingRef.current) return

    // @ Context palette 打开时：拦截方向键 / Enter / Tab / Esc / Backspace
    if (ctxOpen) {
      const isNsLevel = ctxLevel === 'namespace'
      const list: ReadonlyArray<unknown> = isNsLevel ? filteredNamespaces : ctxEntries
      const currentIdx = isNsLevel ? ctxNsIndex : ctxEntryIndex
      const setIdx = isNsLevel ? setCtxNsIndex : setCtxEntryIndex

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (list.length > 0) setIdx(Math.min(currentIdx + 1, list.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIdx(Math.max(currentIdx - 1, 0))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeCtxPalette()
        return
      }
      if (e.key === 'Backspace' && !isNsLevel) {
        // Level 2 时 Backspace 不删字符，而是返回 Level 1（仅当光标紧贴 @ns 时；为简化总是返回）
        // 仅当输入框中"@<ns>"后没有 query 子串时才拦截，否则放行让用户编辑
        const ta = e.currentTarget
        const cursor = ta.selectionStart ?? input.length
        if (ctxStartRef.current >= 0 && cursor - ctxStartRef.current <= (ctxActiveNs?.key.length ?? 0) + 1) {
          e.preventDefault()
          setCtxLevel('namespace')
          setCtxActiveNs(null)
          setCtxEntries([])
          setCtxEntryIndex(0)
          return
        }
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.shiftKey) return // Shift+Enter 维持换行
        e.preventDefault()
        if (isNsLevel) {
          const ns = filteredNamespaces[ctxNsIndex]
          if (ns) handleSelectNamespace(ns)
        } else {
          const entry = ctxEntries[ctxEntryIndex]
          if (entry) void handleSelectEntry(entry)
        }
        return
      }
    }

    // Slash palette 打开且有候选时：拦截方向键 / Enter / Esc
    if (slashOpen && filteredSkills.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex(i => Math.min(i + 1, filteredSkills.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex(i => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const target = filteredSkills[slashIndex]
        if (target) handleSlashSelect(target)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashOpen(false)
        slashStartRef.current = -1
        return
      }
      if (e.key === 'Tab') {
        // Tab 也作为确认（与 IDE 习惯一致）
        e.preventDefault()
        const target = filteredSkills[slashIndex]
        if (target) handleSlashSelect(target)
        return
      }
    }

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
        className={`flex gap-3 items-end relative
          ${isDragging ? 'ring-2 ring-px-primary ring-offset-2 ring-offset-px-bg' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {slashOpen && avatarId && (
          <div className="absolute left-0 right-0 bottom-full mb-2 z-20 pointer-events-auto">
            <SlashCommandPalette
              items={filteredSkills}
              selectedIndex={slashIndex}
              onSelect={handleSlashSelect}
              onHoverIndex={setSlashIndex}
            />
          </div>
        )}
        {ctxOpen && avatarId && (
          <div className="absolute left-0 right-0 bottom-full mb-2 z-20 pointer-events-auto">
            <ContextReferencePalette
              level={ctxLevel}
              namespaces={filteredNamespaces}
              entries={ctxEntries}
              selectedNamespaceIndex={ctxNsIndex}
              selectedEntryIndex={ctxEntryIndex}
              activeNamespace={ctxActiveNs ?? undefined}
              loading={ctxLoading}
              conversationMessageCount={ctxConvMsgCount}
              onChangeConversationMessageCount={setCtxConvMsgCount}
              onSelectNamespace={handleSelectNamespace}
              onSelectEntry={(entry) => void handleSelectEntry(entry)}
              onHoverNamespace={setCtxNsIndex}
              onHoverEntry={setCtxEntryIndex}
              onBack={() => { setCtxLevel('namespace'); setCtxActiveNs(null); setCtxEntries([]); setCtxEntryIndex(0); setCtxNsQuery('') }}
            />
          </div>
        )}
          <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => { isComposingRef.current = true }}
          onCompositionEnd={() => { isComposingRef.current = false }}
          onBlur={() => {
            // 失焦时关闭 palette（用 setTimeout 让 mousedown 的 onSelect 先跑完）
            setTimeout(() => {
              if (!mountedRef.current) return
              setSlashOpen(false)
              closeCtxPalette()
            }, 120)
          }}
          placeholder={hasAnyAttachment ? '添加文字描述... (Enter 发送)' : '输入消息... (Enter 发送，Shift+Enter 换行，/ 唤起技能，@ 引用上下文)'}
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
            onClick={toggleAsrRecording}
            disabled={disabled || isAsrStarting}
            aria-label={isRecording ? '停止语音输入' : '开始语音输入'}
            title={isRecording ? '停止语音输入' : '开始语音输入（豆包 ASR）'}
            className={`px-4 py-3 border-2 font-game text-[13px] tracking-wider transition-none
              ${isRecording
                ? 'bg-px-danger/10 text-px-danger border-px-danger'
                : 'bg-px-surface text-px-text-sec border-px-border hover:border-px-primary hover:text-px-primary'}
              disabled:opacity-30 disabled:cursor-not-allowed`}
          >
            {isAsrStarting ? '...' : isRecording ? '停止' : '语音'}
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
