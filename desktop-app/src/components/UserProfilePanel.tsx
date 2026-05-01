/**
 * UserProfilePanel: 用户画像查看与编辑面板。
 *
 * 用于管理 memory/USER.md 文件，记录用户的沟通风格、常用术语、个人背景等偏好信息。
 * 与 MEMORY.md（事实性记忆）分离，独立维护。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

/** 新建用户画像时的默认模板 */
const DEFAULT_USER_PROFILE = `# 用户画像

本文件记录用户偏好，帮助 AI 分身更好地适应沟通风格。

## 沟通偏好

## 专业背景

## 常用术语

## 禁忌话题
`

interface Props {
  avatarId: string
  onClose: () => void
}

export default function UserProfilePanel({ avatarId, onClose }: Props) {
  const [content, setContent] = useState('')
  const [editedContent, setEditedContent] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const loadSeqRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; clearTimeout(statusTimerRef.current) }
  }, [])

  const loadProfile = useCallback(async () => {
    const seq = ++loadSeqRef.current
    try {
      const profileContent = await window.electronAPI.readUserProfile(avatarId)
      if (loadSeqRef.current !== seq) return
      setContent(profileContent)
      setEditedContent(profileContent || DEFAULT_USER_PROFILE)
    } catch (error) {
      if (loadSeqRef.current !== seq) return
      console.error('[UserProfilePanel] 加载用户画像失败:', error)
      showStatus('LOAD FAILED')
    }
  }, [avatarId])

  useEffect(() => {
    loadProfile()
  }, [loadProfile])

  const showStatus = (msg: string) => {
    if (!mountedRef.current) return
    setStatusMsg(msg)
    clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => { if (mountedRef.current) setStatusMsg('') }, 2500)
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await window.electronAPI.writeUserProfile(avatarId, editedContent)
      if (!mountedRef.current) return
      setContent(editedContent)
      setIsEditing(false)
      showStatus('SAVED')
    } catch (error) {
      if (!mountedRef.current) return
      console.error('保存用户画像失败:', error)
      showStatus('FAILED')
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const handleClear = () => {
    setEditedContent(DEFAULT_USER_PROFILE)
    showStatus('RESET (unsaved)')
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <PanelHeader
        title="USER PROFILE"
        subtitle={`${avatarId} / memory/USER.md`}
        onClose={onClose}
        actions={
          !isEditing ? (
            <button onClick={() => setIsEditing(true)} className="pixel-btn-outline-light py-1">EDIT</button>
          ) : undefined
        }
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 工具栏 */}
        <div className="flex items-center justify-between px-4 py-2 bg-px-elevated border-b-2 border-px-border">
          <div className="flex items-center gap-2">
            <span className="font-game text-[12px] text-px-text-dim">memory/USER.md</span>
            {statusMsg && (
              <span className={`font-game text-[12px] tracking-wider ${statusMsg.includes('SAVED') ? 'text-px-success' : statusMsg.includes('FAIL') ? 'text-px-danger' : 'text-px-primary'}`}>
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
              <button onClick={() => setIsEditing(true)} className="pixel-btn-outline-light py-1">EDIT</button>
            )}
          </div>
        </div>

        {/* 功能说明 */}
        <div className="px-5 py-3 bg-px-bg border-b border-px-border-dim">
          <p className="font-game text-[13px] text-px-text-sec leading-relaxed">
            用户画像帮助 AI 分身记住你的沟通偏好、专业背景和常用术语，让回答更贴合你的风格
          </p>
          <p className="font-game text-[12px] text-px-text-dim mt-1.5">
            无需手动维护 · AI 在对话中自动学习并更新 · 你也可以手动编辑微调
          </p>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-hidden bg-px-surface">
          {isEditing ? (
            <textarea
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              className="w-full h-full resize-none p-6 font-mono text-[14px] bg-px-surface text-px-text border-none outline-none
                focus:shadow-none leading-relaxed"
              placeholder="# 用户画像..."
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
                  <div className="text-center max-w-xs">
                    <div className="w-12 h-12 border-2 border-px-primary bg-px-primary/10 flex items-center justify-center mx-auto mb-3">
                      <span className="text-px-primary font-game text-[12px]">U</span>
                    </div>
                    <p className="font-game text-[13px] text-px-text-dim tracking-wider">尚未建立用户画像</p>
                    <p className="font-game text-[11px] text-px-text-dim mt-2 leading-relaxed">
                      开始对话后 AI 会自动学习你的偏好并生成画像
                    </p>
                    <p className="font-game text-[11px] text-px-text-dim mt-1 leading-relaxed">
                      也可以点击右上角 EDIT 手动填写
                    </p>
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
