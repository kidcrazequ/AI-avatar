import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  onClose: () => void
  onSkillsChanged?: () => void
}

export default function SkillsPanel({ avatarId, onClose, onSkillsChanged }: Props) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  useEffect(() => {
    loadSkills()
  }, [avatarId])

  const loadSkills = async () => {
    const skillList = await window.electronAPI.getSkills(avatarId)
    setSkills(skillList)
    if (skillList.length > 0 && !selectedSkill) {
      setSelectedSkill(skillList[0])
    }
  }

  const handleToggleSkill = async (skillId: string, enabled: boolean) => {
    await window.electronAPI.toggleSkill(avatarId, skillId, enabled)
    await loadSkills()
    onSkillsChanged?.()
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
      await loadSkills()
      setIsEditing(false)
      setSaveMsg('SAVED')
      onSkillsChanged?.()
      setTimeout(() => setSaveMsg(''), 2000)
    } catch (error) {
      console.error('保存技能失败:', error)
      setSaveMsg('FAILED')
      setTimeout(() => setSaveMsg(''), 2000)
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancel = () => {
    setIsEditing(false)
    setEditContent('')
  }

  const enabledCount = skills.filter(s => s.enabled).length
  const disabledCount = skills.filter(s => !s.enabled).length

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
          <div className="px-4 py-3 border-b-2 border-px-border bg-px-elevated">
            <h3 className="font-game text-[13px] text-px-text tracking-wider">技能列表</h3>
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
          {selectedSkill ? (
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
                    <span className={`font-game text-[12px] tracking-wider ${saveMsg === 'SAVED' ? 'text-px-success' : 'text-px-danger'}`}>
                      {saveMsg}
                    </span>
                  )}
                  {!isEditing ? (
                    <button onClick={handleEdit} className="pixel-btn-outline-light">EDIT</button>
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
