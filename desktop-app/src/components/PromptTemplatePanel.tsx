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

interface Props {
  avatarId: string
  /** 点击「使用」时的回调，将模板内容传给父组件填入输入框 */
  onUse?: (content: string) => void
}

export default function PromptTemplatePanel({ avatarId, onUse }: Props) {
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
    <div className="flex flex-col h-full bg-px-bg px-4 py-4 gap-4 overflow-y-auto">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <span className="font-game text-[13px] text-px-text tracking-wider">提示词模板库</span>
        <button
          onClick={() => setIsCreating(v => !v)}
          className="font-game text-[11px] text-px-primary border border-px-primary/50 px-2 py-0.5
            hover:bg-px-primary/10 transition-none"
        >
          {isCreating ? '取消' : '+ 新建'}
        </button>
      </div>

      {/* 新建表单 */}
      {isCreating && (
        <div className="border-2 border-px-primary/30 bg-px-surface p-3 flex flex-col gap-2">
          <input
            type="text"
            placeholder="模板名称"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            className="w-full px-2 py-1.5 bg-px-elevated text-px-text border border-px-border-dim
              font-game text-[13px] focus:outline-none focus:border-px-primary"
          />
          <textarea
            placeholder="模板内容..."
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            rows={4}
            className="w-full px-2 py-1.5 bg-px-elevated text-px-text border border-px-border-dim
              font-game text-[13px] focus:outline-none focus:border-px-primary resize-none"
          />
          <button
            onClick={handleCreate}
            disabled={!newTitle.trim() || !newContent.trim()}
            className="font-game text-[12px] text-px-bg bg-px-primary border border-px-primary px-3 py-1
              hover:bg-px-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-none"
          >
            保存模板
          </button>
        </div>
      )}

      {/* 模板列表 */}
      {templates.length === 0 && !isCreating && (
        <p className="font-game text-[12px] text-px-text-dim text-center py-8">
          暂无模板，点击「新建」创建第一个
        </p>
      )}

      {templates.map(tpl => (
        <div key={tpl.id} className="border border-px-border bg-px-surface p-3 flex flex-col gap-2">
          {editId === tpl.id ? (
            <>
              <input
                type="text"
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                className="w-full px-2 py-1 bg-px-elevated text-px-text border border-px-border-dim
                  font-game text-[13px] focus:outline-none focus:border-px-primary"
              />
              <textarea
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                rows={4}
                className="w-full px-2 py-1 bg-px-elevated text-px-text border border-px-border-dim
                  font-game text-[13px] focus:outline-none focus:border-px-primary resize-none"
              />
              <div className="flex gap-2">
                <button onClick={handleUpdate}
                  className="font-game text-[11px] text-px-bg bg-px-primary px-2 py-0.5 transition-none">
                  保存
                </button>
                <button onClick={() => setEditId(null)}
                  className="font-game text-[11px] text-px-text-dim border border-px-border-dim px-2 py-0.5 transition-none">
                  取消
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="font-game text-[13px] text-px-text">{tpl.title}</span>
              <p className="font-game text-[11px] text-px-text-dim line-clamp-2">{tpl.content}</p>
              <div className="flex gap-2 mt-1">
                {onUse && (
                  <button onClick={() => onUse(tpl.content)}
                    className="font-game text-[11px] text-px-primary border border-px-primary/50 px-2 py-0.5
                      hover:bg-px-primary/10 transition-none">
                    使用
                  </button>
                )}
                <button onClick={() => startEdit(tpl)}
                  className="font-game text-[11px] text-px-text-dim border border-px-border-dim px-2 py-0.5
                    hover:text-px-text transition-none">
                  编辑
                </button>
                <button onClick={() => handleDelete(tpl.id, tpl.title)}
                  className="font-game text-[11px] text-px-danger/70 border border-px-danger/30 px-2 py-0.5
                    hover:text-px-danger transition-none ml-auto">
                  删除
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
