/**
 * PromptTemplatePanel — 提示词模板库面板
 *
 * 功能：
 * - 查看、创建、编辑、删除当前分身的提示词模板
 * - 点击模板标题将内容填入输入框（由 onUse 回调传出）
 *
 * @author zhi.qu
 * @date 2026-04-10
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  onClose: () => void
  /** 点击「使用」时的回调，将模板内容传给父组件填入输入框 */
  onUse?: (content: string) => void
}

export default function PromptTemplatePanel({ avatarId, onClose, onUse }: Props) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  /** 序列号防止 avatarId 切换后的过期加载结果覆盖新分身数据 */
  const loadSeqRef = useRef(0)

  const loadTemplates = useCallback(async () => {
    const seq = ++loadSeqRef.current
    try {
      const result = await window.electronAPI.getPromptTemplates(avatarId)
      if (loadSeqRef.current !== seq) return
      setTemplates(result)
    } catch (err) {
      console.error('[PromptTemplatePanel] 加载模板失败:', err instanceof Error ? err.message : String(err))
    }
  }, [avatarId])

  useEffect(() => {
    // 初始加载 + avatarId 切换时重载；loadTemplates 由 useCallback memo，依赖 avatarId
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTemplates()
  }, [loadTemplates])

  const handleCreate = async () => {
    if (!newTitle.trim() || !newContent.trim()) return
    try {
      await window.electronAPI.createPromptTemplate(avatarId, newTitle.trim(), newContent.trim())
      setNewTitle('')
      setNewContent('')
      setIsCreating(false)
      await loadTemplates()
    } catch (err) {
      console.error('[PromptTemplatePanel] 创建模板失败:', err instanceof Error ? err.message : String(err))
    }
  }

  const handleUpdate = async () => {
    if (!editId || !editTitle.trim() || !editContent.trim()) return
    try {
      await window.electronAPI.updatePromptTemplate(editId, avatarId, editTitle.trim(), editContent.trim())
      setEditId(null)
      await loadTemplates()
    } catch (err) {
      console.error('[PromptTemplatePanel] 更新模板失败:', err instanceof Error ? err.message : String(err))
    }
  }

  const handleDelete = async (id: string, title: string) => {
    if (!window.confirm(`确定删除模板「${title}」？此操作不可撤销。`)) return
    try {
      await window.electronAPI.deletePromptTemplate(id, avatarId)
      await loadTemplates()
    } catch (err) {
      console.error('[PromptTemplatePanel] 删除模板失败:', err instanceof Error ? err.message : String(err))
    }
  }

  const startEdit = (tpl: PromptTemplate) => {
    setEditId(tpl.id)
    setEditTitle(tpl.title)
    setEditContent(tpl.content)
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <PanelHeader
        title="PROMPT TEMPLATES"
        subtitle={`${avatarId} / ${templates.length} 个模板`}
        onClose={onClose}
        actions={
          <button
            onClick={() => setIsCreating(v => !v)}
            className={isCreating ? 'pixel-btn-outline-muted py-1' : 'pixel-btn-outline-light py-1'}
          >
            {isCreating ? 'CANCEL' : '+ NEW'}
          </button>
        }
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 功能说明 */}
        <div className="px-5 py-3 bg-px-bg border-b border-px-border-dim">
          <p className="font-game text-[13px] text-px-text-sec leading-relaxed">
            话术模板是预设的对话指令，帮助你快速发起常用任务 · 点击「USE」将内容填入输入框
          </p>
          <p className="font-game text-[12px] text-px-text-dim mt-1.5">
            无需主动配置 · 按需创建常用提问、分析框架等模板即可提升效率
          </p>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto bg-px-surface">
          {/* 新建表单 */}
          {isCreating && (
            <div className="mx-4 mt-4 border-2 border-px-primary/30 bg-px-bg p-4 flex flex-col gap-3">
              <input
                type="text"
                placeholder="模板名称（如：收益测算分析）"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                className="pixel-input"
              />
              <textarea
                placeholder="模板内容（将作为对话输入发送）..."
                value={newContent}
                onChange={e => setNewContent(e.target.value)}
                rows={4}
                className="pixel-input resize-none"
              />
              <button
                onClick={handleCreate}
                disabled={!newTitle.trim() || !newContent.trim()}
                className="pixel-btn-primary py-1.5 self-end"
              >
                SAVE
              </button>
            </div>
          )}

          {/* 空状态 */}
          {templates.length === 0 && !isCreating && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="w-12 h-12 border-2 border-px-primary bg-px-primary/10 flex items-center justify-center mx-auto mb-3">
                  <span className="text-px-primary font-game text-[12px]">T</span>
                </div>
                <p className="font-game text-[13px] text-px-text-dim tracking-wider">暂无提示词模板</p>
                <p className="font-game text-[12px] text-px-text-dim mt-1">点击右上角「+ NEW」创建常用指令模板</p>
              </div>
            </div>
          )}

          {/* 模板列表 */}
          <div className="p-4 flex flex-col gap-3">
            {templates.map(tpl => (
              <div key={tpl.id} className="border-2 border-px-border bg-px-bg p-4 flex flex-col gap-2">
                {editId === tpl.id ? (
                  <>
                    <input
                      type="text"
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      className="pixel-input"
                    />
                    <textarea
                      value={editContent}
                      onChange={e => setEditContent(e.target.value)}
                      rows={4}
                      className="pixel-input resize-none"
                    />
                    <div className="flex gap-2">
                      <button onClick={handleUpdate} className="pixel-btn-primary py-1">SAVE</button>
                      <button onClick={() => setEditId(null)} className="pixel-btn-outline-muted py-1">CANCEL</button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="font-game text-[13px] text-px-text tracking-wider">{tpl.title}</span>
                    <p className="font-game text-[11px] text-px-text-dim line-clamp-2 leading-relaxed">{tpl.content}</p>
                    <div className="flex gap-2 mt-1">
                      {onUse && (
                        <button onClick={() => onUse(tpl.content)} className="pixel-btn-outline-light py-1 text-[11px]">
                          USE
                        </button>
                      )}
                      <button onClick={() => startEdit(tpl)} className="pixel-btn-outline-muted py-1 text-[11px]">
                        EDIT
                      </button>
                      <button onClick={() => handleDelete(tpl.id, tpl.title)}
                        className="pixel-btn-outline-muted py-1 text-[11px] ml-auto
                          hover:!text-px-danger hover:!border-px-danger">
                        DEL
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}
