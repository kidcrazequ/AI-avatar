import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
  const [statusMsg, setStatusMsg] = useState('')

  useEffect(() => {
    loadMemory()
  }, [avatarId])

  const loadMemory = async () => {
    const memContent = await window.electronAPI.readMemory(avatarId)
    setContent(memContent)
    setEditedContent(memContent)
  }

  const showStatus = (msg: string) => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(''), 2500)
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await window.electronAPI.writeMemory(avatarId, editedContent)
      setContent(editedContent)
      setIsEditing(false)
      showStatus('SAVED')
    } catch (error) {
      console.error('保存记忆失败:', error)
      showStatus('FAILED')
    } finally {
      setIsSaving(false)
    }
  }

  const handleClear = async () => {
    const defaultMemory = `# Memory Index\n\n本文件用于记录长期记忆。\n\n## 偏好记录\n\n## 纠偏记录\n\n## 项目记录\n\n## 决策记录\n`
    setEditedContent(defaultMemory)
    showStatus('RESET (unsaved)')
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
