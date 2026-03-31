import { useState, useEffect } from 'react'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  onClose: () => void
}

/**
 * MemoryPanel: 查看和编辑分身的长期记忆（memory/MEMORY.md）。
 * GAP2 实现的一部分。
 */
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
      showStatus('✓ 记忆已保存')
    } catch (error) {
      console.error('保存记忆失败:', error)
      showStatus('✗ 保存失败')
    } finally {
      setIsSaving(false)
    }
  }

  const handleClear = async () => {
    const defaultMemory = `# Memory Index\n\n本文件用于记录长期记忆。\n\n## 偏好记录\n\n## 纠偏记录\n\n## 项目记录\n\n## 决策记录\n`
    setEditedContent(defaultMemory)
    showStatus('内容已重置（未保存）')
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <PanelHeader
        title="MEMORY"
        subtitle={`${avatarId} · ${content.split('\n').length} LINES`}
        onClose={onClose}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 工具栏 */}
        <div className="flex items-center justify-between px-4 py-2 bg-px-mid border-b-2 border-px-line">
          <div className="flex items-center gap-2">
            <span className="font-pixel text-[8px] text-px-muted">memory/MEMORY.md</span>
            {statusMsg && (
              <span className={`font-pixel text-[8px] ${statusMsg.includes('✓') ? 'text-green-400' : 'text-px-danger'}`}>
                {statusMsg}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {isEditing ? (
              <>
                <button onClick={handleClear} className="pixel-btn-outline-muted text-[10px]">RESET</button>
                <button onClick={() => { setIsEditing(false); setEditedContent(content) }} className="pixel-btn-outline-muted text-[10px]">CANCEL</button>
                <button onClick={handleSave} disabled={isSaving} className="pixel-btn-outline-light text-[10px] disabled:opacity-40">
                  {isSaving ? 'SAVING...' : '[✓] SAVE'}
                </button>
              </>
            ) : (
              <button onClick={() => setIsEditing(true)} className="pixel-btn-outline-light text-[10px]">[/] EDIT</button>
            )}
          </div>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-hidden bg-px-dark">
          {isEditing ? (
            <textarea
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              className="w-full h-full resize-none p-4 font-mono text-sm bg-px-dark text-px-white border-none outline-none"
              placeholder="# Memory Index..."
            />
          ) : (
            <div className="h-full overflow-y-auto p-4">
              {content ? (
                <pre className="whitespace-pre-wrap font-mono text-sm text-px-warm leading-relaxed">
                  {content}
                </pre>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="font-pixel text-[10px] text-px-muted tracking-wider">NO MEMORY YET</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
