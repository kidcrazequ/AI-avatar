import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'
import { validateSoulContent, ValidationResult } from '../services/soul-validator'

interface Props {
  avatarId: string
  onClose: () => void
  onSoulChanged?: () => void
}

export default function SoulEditorPanel({ avatarId, onClose, onSoulChanged }: Props) {
  const [content, setContent] = useState('')
  const [editedContent, setEditedContent] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; clearTimeout(statusTimerRef.current) }
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const soulContent = await window.electronAPI.readSoul(avatarId)
        if (cancelled) return
        setContent(soulContent)
        setEditedContent(soulContent)
        setValidation(null)
        setIsEditing(false)
      } catch (err) {
        if (!cancelled) console.error('[SoulEditorPanel] 加载失败:', err instanceof Error ? err.message : String(err))
      }
    }
    load()
    return () => { cancelled = true }
  }, [avatarId])

  const showStatus = useCallback((msg: string) => {
    if (!mountedRef.current) return
    setStatusMsg(msg)
    clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => { if (mountedRef.current) setStatusMsg('') }, 2500)
  }, [])

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await window.electronAPI.writeSoul(avatarId, editedContent)
      if (!mountedRef.current) return
      setContent(editedContent)
      setIsEditing(false)
      setValidation(null)
      showStatus('SAVED')
      onSoulChanged?.()
    } catch (error) {
      if (!mountedRef.current) return
      console.error('[SoulEditorPanel] 保存人格文档失败:', error)
      showStatus('FAILED')
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const handleValidate = () => {
    const result = validateSoulContent(isEditing ? editedContent : content)
    setValidation(result)
  }

  const handleCancel = () => {
    setIsEditing(false)
    setEditedContent(content)
    setValidation(null)
  }

  const lineCount = (isEditing ? editedContent : content).split('\n').length

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <PanelHeader
        title="SOUL"
        subtitle={`${avatarId} / ${lineCount} lines`}
        onClose={onClose}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 工具栏 */}
        <div className="flex items-center justify-between px-4 py-2 bg-px-elevated border-b-2 border-px-border">
          <div className="flex items-center gap-3">
            <span className="font-game text-[12px] text-px-text-dim">soul.md</span>
            {statusMsg && (
              <span className={`font-game text-[12px] tracking-wider ${
                statusMsg.includes('SAVED') ? 'text-px-success'
                : statusMsg.includes('FAIL') ? 'text-px-danger'
                : 'text-px-primary'
              }`}>
                {statusMsg}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={handleValidate} className="pixel-btn-outline-muted py-1">校验</button>
            {isEditing ? (
              <>
                <button onClick={handleCancel} className="pixel-btn-outline-muted py-1">CANCEL</button>
                <button onClick={handleSave} disabled={isSaving} className="pixel-btn-primary py-1">
                  {isSaving ? '...' : 'SAVE'}
                </button>
              </>
            ) : (
              <button onClick={() => setIsEditing(true)} className="pixel-btn-outline-light py-1">EDIT</button>
            )}
          </div>
        </div>

        {/* 校验结果 */}
        {validation && (
          <div className={`px-4 py-3 border-b-2 ${
            validation.isValid ? 'border-px-success bg-px-success/5' : 'border-px-warning bg-px-warning/5'
          }`}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-game text-[12px] tracking-wider text-px-text">
                {validation.isValid ? '完整度检查通过' : '存在缺失项'}
              </span>
              <span className="font-game text-[13px] text-px-text-sec">{validation.score}%</span>
            </div>
            {validation.missing.length > 0 && (
              <ul className="space-y-1">
                {validation.missing.map((item) => (
                  <li key={item.id} className="font-game text-[13px] flex items-start gap-2">
                    <span className={item.severity === 'critical' ? 'text-px-danger' : 'text-px-warning'}>
                      {item.severity === 'critical' ? '✗' : '!'}
                    </span>
                    <span className="text-px-text-sec">[{item.chapter}] {item.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* 内容区 */}
        <div className="flex-1 overflow-hidden bg-px-surface">
          {isEditing ? (
            <textarea
              value={editedContent}
              onChange={(e) => { setEditedContent(e.target.value); setValidation(null) }}
              className="w-full h-full resize-none p-6 font-mono text-[14px] bg-px-surface text-px-text border-none outline-none
                focus:shadow-none leading-relaxed"
              placeholder="# 分身名称 灵魂文档..."
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
                      <span className="text-px-primary font-game text-[12px]">S</span>
                    </div>
                    <p className="font-game text-[13px] text-px-text-dim tracking-wider">暂无人格定义</p>
                    <p className="font-game text-[12px] text-px-text-dim mt-1">点击编辑开始撰写</p>
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
