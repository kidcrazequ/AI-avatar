import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MEMORY_CHAR_LIMIT, MEMORY_WARN_THRESHOLD } from '@soul/core'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  onClose: () => void
}

export default function MemoryPanel({ avatarId, onClose }: Props) {
  const [content, setContent] = useState('')
  const [editedContent, setEditedContent] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isConsolidating, setIsConsolidating] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [stats, setStats] = useState<{ chars: number; ratio: number; entries: number } | null>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(statusTimerRef.current)
    }
  }, [])

  const loadSeqRef = useRef(0)

  const loadMemory = useCallback(async () => {
    const seq = ++loadSeqRef.current
    try {
      const memContent = await window.electronAPI.readMemory(avatarId)
      if (loadSeqRef.current !== seq) return
      setContent(memContent)
      setEditedContent(memContent)
      const memStats = await window.electronAPI.getMemoryStats(avatarId)
      if (loadSeqRef.current !== seq) return
      setStats(memStats)
    } catch (error) {
      if (loadSeqRef.current !== seq) return
      console.error('[MemoryPanel] 加载记忆失败:', error)
      showStatus('LOAD FAILED')
    }
  }, [avatarId])

  useEffect(() => {
    loadMemory()
  }, [loadMemory])

  const showStatus = (msg: string) => {
    if (!mountedRef.current) return
    setStatusMsg(msg)
    clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => { if (mountedRef.current) setStatusMsg('') }, 2500)
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await window.electronAPI.writeMemory(avatarId, editedContent)
      if (!mountedRef.current) return
      setContent(editedContent)
      setIsEditing(false)
      const memStats = await window.electronAPI.getMemoryStats(avatarId)
      if (!mountedRef.current) return
      setStats(memStats)
      showStatus('SAVED')
    } catch (error) {
      if (!mountedRef.current) return
      console.error('保存记忆失败:', error)
      showStatus('FAILED')
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  /** 手动触发 LLM 整理记忆 */
  const handleConsolidate = async () => {
    setIsConsolidating(true)
    try {
      const apiKey = await window.electronAPI.getSetting('chat_api_key') ?? ''
      if (!apiKey) {
        showStatus('请先在设置中配置 API Key')
        return
      }
      const baseUrl = await window.electronAPI.getSetting('chat_base_url') ?? ''
      const consolidated = await window.electronAPI.consolidateMemory(avatarId, content, apiKey, baseUrl)
      if (!mountedRef.current) return
      await window.electronAPI.writeMemory(avatarId, consolidated)
      if (!mountedRef.current) return
      setContent(consolidated)
      setEditedContent(consolidated)
      const memStats = await window.electronAPI.getMemoryStats(avatarId)
      if (!mountedRef.current) return
      setStats(memStats)
      showStatus('CONSOLIDATED')
    } catch (error) {
      if (!mountedRef.current) return
      console.error('整理记忆失败:', error)
      showStatus('CONSOLIDATE FAILED')
    } finally {
      if (mountedRef.current) setIsConsolidating(false)
    }
  }

  const handleClear = async () => {
    const defaultMemory = `# Memory Index\n\n本文件用于记录长期记忆。\n\n## 偏好记录\n\n## 纠偏记录\n\n## 项目记录\n\n## 决策记录\n`
    setEditedContent(defaultMemory)
    showStatus('RESET (unsaved)')
  }

  /** 计算容量条颜色 */
  const getCapacityColor = () => {
    if (!stats) return 'bg-px-primary'
    if (stats.ratio >= 1.0) return 'bg-px-danger'
    if (stats.ratio >= MEMORY_WARN_THRESHOLD) return 'bg-yellow-400'
    return 'bg-px-primary'
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <PanelHeader
        title="MEMORY"
        subtitle={`${avatarId} / ${content.split('\n').length} lines`}
        onClose={onClose}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 工具栏 */}
        <div className="flex items-center justify-between px-4 py-2 bg-px-elevated border-b-2 border-px-border">
          <div className="flex items-center gap-2">
            <span className="font-game text-[12px] text-px-text-dim">memory/MEMORY.md</span>
            {statusMsg && (
              <span className={`font-game text-[12px] tracking-wider ${statusMsg.includes('SAVED') || statusMsg.includes('CONSOLIDATED') ? 'text-px-success' : statusMsg.includes('FAIL') ? 'text-px-danger' : 'text-px-primary'}`}>
                {statusMsg}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {isEditing ? (
              <>
                <button onClick={handleClear} className="pixel-btn-outline-muted py-1">RESET</button>
                <button onClick={() => { setIsEditing(false); setEditedContent(content) }} className="pixel-btn-outline-muted py-1">CANCEL</button>
                <button onClick={handleSave} disabled={isSaving} className="pixel-btn-primary py-1">
                  {isSaving ? '...' : 'SAVE'}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleConsolidate}
                  disabled={isConsolidating}
                  title="调用 AI 整理记忆，合并重复条目"
                  className="pixel-btn-outline-muted py-1 text-[12px]"
                >
                  {isConsolidating ? '整理中...' : 'CONSOLIDATE'}
                </button>
                <button onClick={() => setIsEditing(true)} className="pixel-btn-outline-light py-1">EDIT</button>
              </>
            )}
          </div>
        </div>

        {/* 容量指示器 */}
        {stats && (
          <div className="px-4 py-2 bg-px-bg border-b border-px-border-dim">
            <div className="flex items-center justify-between mb-1">
              <span className="font-game text-[11px] text-px-text-dim">容量</span>
              <span className={`font-game text-[11px] ${stats.ratio >= 1.0 ? 'text-px-danger' : stats.ratio >= MEMORY_WARN_THRESHOLD ? 'text-yellow-400' : 'text-px-text-dim'}`}>
                {stats.chars} / {MEMORY_CHAR_LIMIT} 字符
                {stats.ratio >= 1.0 && ' ⚠ 已超限，建议整理'}
                {stats.ratio >= MEMORY_WARN_THRESHOLD && stats.ratio < 1.0 && ' · 接近上限'}
              </span>
            </div>
            <div className="w-full h-1.5 bg-px-border rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${getCapacityColor()}`}
                style={{ width: `${Math.min(stats.ratio * 100, 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* 内容区 */}
        <div className="flex-1 overflow-hidden bg-px-surface">
          {isEditing ? (
            <textarea
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              className="w-full h-full resize-none p-6 font-mono text-[14px] bg-px-surface text-px-text border-none outline-none
                focus:shadow-none leading-relaxed"
              placeholder="# Memory Index..."
            />
          ) : (
            <div className="h-full overflow-y-auto p-6">
              {content ? (
                <div className="prose prose-sm prose-invert max-w-none prose-pixel font-body
                  prose-headings:font-game prose-headings:font-bold prose-headings:text-px-text prose-headings:tracking-wider
                  prose-p:text-px-text-sec prose-p:leading-[1.75] prose-p:text-[14px] prose-p:font-body
                  prose-code:text-px-accent prose-code:bg-px-bg prose-code:px-1.5 prose-code:py-0.5 prose-code:border prose-code:border-px-border prose-code:text-[13px] prose-code:font-mono
                  prose-strong:text-px-text prose-strong:font-bold
                  prose-a:text-px-primary prose-a:no-underline hover:prose-a:underline
                  prose-li:text-px-text-sec prose-li:marker:text-px-primary prose-li:font-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <div className="w-12 h-12 border-2 border-px-primary bg-px-primary/10 flex items-center justify-center mx-auto mb-3">
                      <span className="text-px-primary font-game text-[12px]">M</span>
                    </div>
                    <p className="font-game text-[13px] text-px-text-dim tracking-wider">暂无记录</p>
                    <p className="font-game text-[12px] text-px-text-dim mt-1">点击编辑开始记录</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
