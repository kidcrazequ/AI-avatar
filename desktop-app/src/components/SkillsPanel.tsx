import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  onClose: () => void
  onSkillsChanged?: () => void
}

/** 新建技能时的默认模板 */
const NEW_SKILL_TEMPLATE = `---
name: {{skillId}}
description: 描述这个技能做什么，什么时候该用它。LLM 会读这段描述判断是否触发技能。
---

# {{skillId}}

> **级别**：[■] 基础
> **版本**：v1.0

## 技能说明

在这里写清楚这个技能的用途、触发场景、输入输出、工作流程。

## 触发条件

当用户问题包含以下关键词时使用：

- ...

## 输出格式

...

## 示例

...
`

export default function SkillsPanel({ avatarId, onClose, onSkillsChanged }: Props) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const saveMsgTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // 新建技能 state
  const [isCreating, setIsCreating] = useState(false)
  const [newSkillId, setNewSkillId] = useState('')
  const [newSkillContent, setNewSkillContent] = useState('')
  // 删除确认 state
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; clearTimeout(saveMsgTimerRef.current) } }, [])

  const loadSkills = useCallback(async (preserveSelection = true) => {
    try {
      const skillList = await window.electronAPI.getSkills(avatarId)
      if (!mountedRef.current) return
      setSkills(skillList)
      if (preserveSelection) {
        setSelectedSkill(prev => {
          if (!prev) return skillList.length > 0 ? skillList[0] : null
          return skillList.find(s => s.id === prev.id) ?? (skillList.length > 0 ? skillList[0] : null)
        })
      } else {
        setSelectedSkill(skillList.length > 0 ? skillList[0] : null)
        setIsEditing(false)
      }
    } catch (err) {
      if (mountedRef.current) console.error('[SkillsPanel] 加载技能失败:', err instanceof Error ? err.message : String(err))
    }
  }, [avatarId])

  useEffect(() => {
    loadSkills(false)
  }, [loadSkills])

  const handleToggleSkill = async (skillId: string, enabled: boolean) => {
    try {
      await window.electronAPI.toggleSkill(avatarId, skillId, enabled)
      if (!mountedRef.current) return
      await loadSkills()
      onSkillsChanged?.()
    } catch (err) {
      if (!mountedRef.current) return
      console.error('[SkillsPanel] 切换技能失败:', err instanceof Error ? err.message : String(err))
      setSaveMsg('TOGGLE FAILED')
      clearTimeout(saveMsgTimerRef.current)
      saveMsgTimerRef.current = setTimeout(() => { if (mountedRef.current) setSaveMsg('') }, 2000)
    }
  }

  const handleEdit = () => {
    if (selectedSkill) {
      setEditContent(selectedSkill.content)
      setIsEditing(true)
    }
  }

  const handleSave = async () => {
    if (!selectedSkill) return
    setIsSaving(true)
    try {
      await window.electronAPI.updateSkill(avatarId, selectedSkill.id, editContent)
      if (!mountedRef.current) return
      await loadSkills()
      if (!mountedRef.current) return
      setIsEditing(false)
      setSaveMsg('SAVED')
      onSkillsChanged?.()
      clearTimeout(saveMsgTimerRef.current)
      saveMsgTimerRef.current = setTimeout(() => { if (mountedRef.current) setSaveMsg('') }, 2000)
    } catch (error) {
      if (!mountedRef.current) return
      console.error('保存技能失败:', error)
      setSaveMsg('FAILED')
      clearTimeout(saveMsgTimerRef.current)
      saveMsgTimerRef.current = setTimeout(() => { if (mountedRef.current) setSaveMsg('') }, 2000)
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const handleCancel = () => {
    setIsEditing(false)
    setEditContent('')
  }

  const handleNewSkill = () => {
    setIsCreating(true)
    setNewSkillId('')
    setNewSkillContent(NEW_SKILL_TEMPLATE)
    setIsEditing(false)
    setPendingDeleteId(null)
  }

  const handleCreateCancel = () => {
    setIsCreating(false)
    setNewSkillId('')
    setNewSkillContent('')
  }

  const handleCreateSubmit = async () => {
    const id = newSkillId.trim()
    if (!id) {
      setSaveMsg('NEED ID')
      clearTimeout(saveMsgTimerRef.current)
      saveMsgTimerRef.current = setTimeout(() => { if (mountedRef.current) setSaveMsg('') }, 2000)
      return
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      setSaveMsg('ID INVALID')
      clearTimeout(saveMsgTimerRef.current)
      saveMsgTimerRef.current = setTimeout(() => { if (mountedRef.current) setSaveMsg('') }, 2000)
      return
    }
    setIsSaving(true)
    try {
      // 展开模板里的 {{skillId}} 占位符
      const content = newSkillContent.replace(/\{\{skillId\}\}/g, id)
      const created = await window.electronAPI.createSkill(avatarId, id, content)
      if (!mountedRef.current) return
      await loadSkills()
      if (!mountedRef.current) return
      setIsCreating(false)
      setNewSkillId('')
      setNewSkillContent('')
      setSelectedSkill(created)
      setSaveMsg('CREATED')
      onSkillsChanged?.()
      clearTimeout(saveMsgTimerRef.current)
      saveMsgTimerRef.current = setTimeout(() => { if (mountedRef.current) setSaveMsg('') }, 2000)
    } catch (error) {
      if (!mountedRef.current) return
      console.error('创建技能失败:', error)
      setSaveMsg('CREATE FAILED')
      clearTimeout(saveMsgTimerRef.current)
      saveMsgTimerRef.current = setTimeout(() => { if (mountedRef.current) setSaveMsg('') }, 3000)
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const handleRequestDelete = () => {
    if (selectedSkill) setPendingDeleteId(selectedSkill.id)
  }

  const handleConfirmDelete = async () => {
    if (!pendingDeleteId) return
    setIsSaving(true)
    try {
      await window.electronAPI.deleteSkill(avatarId, pendingDeleteId)
      if (!mountedRef.current) return
      setPendingDeleteId(null)
      setIsEditing(false)
      setSelectedSkill(null)
      await loadSkills(false)
      onSkillsChanged?.()
      setSaveMsg('DELETED')
      clearTimeout(saveMsgTimerRef.current)
      saveMsgTimerRef.current = setTimeout(() => { if (mountedRef.current) setSaveMsg('') }, 2000)
    } catch (error) {
      if (!mountedRef.current) return
      console.error('删除技能失败:', error)
      setSaveMsg('DELETE FAILED')
      clearTimeout(saveMsgTimerRef.current)
      saveMsgTimerRef.current = setTimeout(() => { if (mountedRef.current) setSaveMsg('') }, 3000)
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const handleCancelDelete = () => setPendingDeleteId(null)

  const { enabledCount, disabledCount } = useMemo(() => {
    let enabled = 0
    for (const s of skills) { if (s.enabled) enabled++ }
    return { enabledCount: enabled, disabledCount: skills.length - enabled }
  }, [skills])

  return (
    <Modal isOpen={true} onClose={onClose} size="lg">
      <PanelHeader
        title="SKILLS"
        subtitle={`${enabledCount} ON / ${disabledCount} OFF`}
        onClose={onClose}
      />

      <div className="flex-1 overflow-hidden flex">
        {/* 左侧列表 */}
        <div className="w-1/3 border-r-2 border-px-border flex flex-col">
          <div className="px-4 py-3 border-b-2 border-px-border bg-px-elevated flex items-center justify-between gap-2">
            <h3 className="font-game text-[13px] text-px-text tracking-wider">技能列表</h3>
            <button
              type="button"
              onClick={handleNewSkill}
              className="pixel-btn-outline-light text-[11px] px-2 py-0.5"
              aria-label="新建技能"
              title="新建技能"
            >
              [+ NEW]
            </button>
          </div>
          <div className="flex-1 overflow-y-auto bg-px-bg">
            {skills.length === 0 ? (
              <div className="flex items-center justify-center h-full py-12">
                <p className="font-game text-[13px] text-px-text-dim tracking-wider">暂无技能</p>
              </div>
            ) : skills.map((skill) => (
              <button
                key={skill.id}
                onClick={() => setSelectedSkill(skill)}
                className={`w-full text-left px-4 py-3 border-b border-px-border-dim transition-none
                  ${selectedSkill?.id === skill.id
                    ? 'bg-px-surface text-px-text border-l-3 border-l-px-primary'
                    : 'bg-transparent text-px-text-sec hover:bg-px-surface/50 border-l-3 border-l-transparent'
                  }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    role="checkbox"
                    aria-checked={skill.enabled}
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); handleToggleSkill(skill.id, !skill.enabled) }}
                    onKeyDown={(e) => e.key === ' ' && handleToggleSkill(skill.id, !skill.enabled)}
                    className="pixel-checkbox mt-0.5 flex-shrink-0"
                    data-checked={skill.enabled}
                  >
                    ✓
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-game text-[14px] font-medium truncate">{skill.name}</span>
                      {!skill.enabled && (
                        <span className="pixel-badge">OFF</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="font-game text-[12px] text-px-text-dim">{skill.version}</span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 右侧详情 */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {isCreating ? (
            <>
              <div className="px-6 py-4 border-b-2 border-px-border bg-px-elevated flex items-center justify-between">
                <div>
                  <h3 className="font-game text-[16px] font-bold text-px-text">新建技能</h3>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="font-game text-[12px] text-px-text-dim tracking-wider">
                      技能 ID 仅支持英文字母、数字、连字符或下划线
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {saveMsg && (
                    <span className={`font-game text-[12px] tracking-wider ${saveMsg === 'CREATED' ? 'text-px-success' : 'text-px-danger'}`}>
                      {saveMsg}
                    </span>
                  )}
                  <button onClick={handleCreateCancel} className="pixel-btn-outline-muted">CANCEL</button>
                  <button onClick={handleCreateSubmit} disabled={isSaving} className="pixel-btn-primary">
                    {isSaving ? '...' : 'CREATE'}
                  </button>
                </div>
              </div>
              <div className="p-6 border-b-2 border-px-border bg-px-surface">
                <label className="font-game text-[12px] text-px-text-dim tracking-wider block mb-2">
                  技能 ID (文件名)
                </label>
                <input
                  type="text"
                  value={newSkillId}
                  onChange={(e) => setNewSkillId(e.target.value)}
                  placeholder="例如: draw-mermaid / export-pptx / filter-open-tasks"
                  className="pixel-input w-full text-[14px] font-mono"
                  autoFocus
                />
              </div>
              <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
                <label className="font-game text-[12px] text-px-text-dim tracking-wider block mb-2">
                  技能内容 (Markdown，{`{{skillId}}`} 会被替换为 ID)
                </label>
                <textarea
                  value={newSkillContent}
                  onChange={(e) => setNewSkillContent(e.target.value)}
                  className="pixel-input w-full h-[calc(100%-2rem)] resize-none font-mono text-[13px]"
                  placeholder="技能 markdown 内容..."
                />
              </div>
            </>
          ) : selectedSkill ? (
            <>
              <div className="px-6 py-4 border-b-2 border-px-border bg-px-elevated flex items-center justify-between">
                <div>
                  <h3 className="font-game text-[16px] font-bold text-px-text">{selectedSkill.name}</h3>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="font-game text-[13px] text-px-text-dim">{selectedSkill.version}</span>
                    <span className={`font-game text-[12px] tracking-wider ${selectedSkill.enabled ? 'text-px-success' : 'text-px-text-dim'}`}>
                      {selectedSkill.enabled ? '启用' : '禁用'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {saveMsg && (
                    <span className={`font-game text-[12px] tracking-wider ${saveMsg === 'SAVED' || saveMsg === 'DELETED' ? 'text-px-success' : 'text-px-danger'}`}>
                      {saveMsg}
                    </span>
                  )}
                  {pendingDeleteId === selectedSkill.id ? (
                    <div className="flex gap-2 items-center">
                      <span className="font-game text-[11px] text-px-danger tracking-wider">确认删除？</span>
                      <button onClick={handleCancelDelete} className="pixel-btn-outline-muted">CANCEL</button>
                      <button onClick={handleConfirmDelete} disabled={isSaving} className="pixel-btn-outline-light text-px-danger border-px-danger">
                        {isSaving ? '...' : 'DELETE'}
                      </button>
                    </div>
                  ) : !isEditing ? (
                    <>
                      <button onClick={handleRequestDelete} className="pixel-btn-outline-muted text-px-danger">DELETE</button>
                      <button onClick={handleEdit} className="pixel-btn-outline-light">EDIT</button>
                    </>
                  ) : (
                    <div className="flex gap-2">
                      <button onClick={handleCancel} className="pixel-btn-outline-muted">CANCEL</button>
                      <button onClick={handleSave} disabled={isSaving} className="pixel-btn-primary">
                        {isSaving ? '...' : 'SAVE'}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
                {!isEditing ? (
                  <div className="prose prose-sm prose-invert max-w-none prose-pixel font-body
                    prose-headings:font-game prose-headings:font-bold prose-headings:text-px-text prose-headings:tracking-wider
                    prose-p:text-px-text-sec prose-p:leading-[1.75] prose-p:text-[14px] prose-p:font-body
                    prose-code:text-px-accent prose-code:bg-px-bg prose-code:px-1.5 prose-code:py-0.5 prose-code:border prose-code:border-px-border prose-code:text-[13px] prose-code:font-mono
                    prose-pre:bg-px-bg prose-pre:border-2 prose-pre:border-px-border prose-pre:font-mono
                    prose-table:border-2 prose-table:border-px-border
                    prose-th:border-2 prose-th:border-px-border prose-th:bg-px-elevated prose-th:text-px-text prose-th:px-3 prose-th:py-2 prose-th:font-game
                    prose-td:border-2 prose-td:border-px-border prose-td:px-3 prose-td:py-2 prose-td:text-px-text-sec prose-td:font-body
                    prose-strong:text-px-text prose-strong:font-bold
                    prose-a:text-px-primary prose-a:no-underline hover:prose-a:underline
                    prose-li:text-px-text-sec prose-li:marker:text-px-primary prose-li:font-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedSkill.content}</ReactMarkdown>
                  </div>
                ) : (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="pixel-input w-full h-full resize-none font-mono text-[14px]"
                    placeholder="编辑技能内容（Markdown 格式）..."
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full bg-px-surface">
              <div className="text-center">
                <div className="w-12 h-12 border-2 border-px-primary bg-px-primary/10 flex items-center justify-center mx-auto mb-3">
                  <span className="text-px-primary font-game text-[12px]">S</span>
                </div>
                <p className="font-game text-[12px] text-px-text-dim tracking-wider">选择一个技能</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
