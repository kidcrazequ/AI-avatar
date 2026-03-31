import { useState, useEffect } from 'react'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  onClose: () => void
  /** GAP3: 技能切换后回调，用于刷新 system prompt */
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

  // GAP3: 切换技能后触发 prompt 刷新
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
      setSaveMsg('✓ 保存成功')
      // GAP6: 编辑保存后触发 prompt 刷新
      onSkillsChanged?.()
      setTimeout(() => setSaveMsg(''), 2000)
    } catch (error) {
      console.error('保存技能失败:', error)
      setSaveMsg('✗ 保存失败')
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
        subtitle={`${enabledCount} ENABLED · ${disabledCount} DISABLED`}
        onClose={onClose}
      />

      <div className="flex-1 overflow-hidden flex">
        {/* 左侧：技能列表 */}
        <div className="w-1/3 border-r-2 border-px-line flex flex-col">
          <div className="px-4 py-3 border-b-2 border-px-line bg-px-mid">
            <h3 className="font-pixel text-[10px] text-px-white tracking-wider">SKILL LIST</h3>
          </div>
          <div className="flex-1 overflow-y-auto bg-px-dark">
            {skills.map((skill) => (
              <button
                key={skill.id}
                onClick={() => setSelectedSkill(skill)}
                className={`w-full text-left px-4 py-3 border-b-2 border-px-line
                  ${selectedSkill?.id === skill.id
                    ? 'bg-px-black text-px-white border-l-4 border-l-px-white'
                    : 'bg-transparent text-px-white hover:bg-px-mid'
                  }`}
              >
                <div className="flex items-start gap-3">
                  {/* 像素风 Toggle */}
                  <div
                    role="checkbox"
                    aria-checked={skill.enabled}
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); handleToggleSkill(skill.id, !skill.enabled) }}
                    onKeyDown={(e) => e.key === ' ' && handleToggleSkill(skill.id, !skill.enabled)}
                    className={`w-5 h-5 border-2 flex items-center justify-center cursor-pointer mt-0.5 flex-shrink-0
                      font-pixel text-[8px] select-none
                      ${skill.enabled
                        ? 'bg-px-white border-px-white text-px-black'
                        : 'bg-transparent border-px-line text-transparent'
                      } ${selectedSkill?.id === skill.id ? 'border-px-white' : ''}`}
                  >
                    ✓
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm font-medium truncate">{skill.name}</span>
                      {!skill.enabled && (
                        <span className="font-pixel text-[8px] px-1.5 py-0.5 border border-px-line text-px-muted tracking-wider">
                          OFF
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="font-pixel text-[8px] text-px-muted">{skill.version}</span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 右侧：技能详情 */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {selectedSkill ? (
            <>
              <div className="px-6 py-4 border-b-2 border-px-line bg-px-mid flex items-center justify-between">
                <div>
                  <h3 className="font-mono text-base font-semibold text-px-white">{selectedSkill.name}</h3>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="font-pixel text-[8px] text-px-muted">{selectedSkill.version}</span>
                    <span className={`font-pixel text-[8px] ${selectedSkill.enabled ? 'text-green-400' : 'text-px-muted'}`}>
                      {selectedSkill.enabled ? '● ON' : '○ OFF'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {saveMsg && (
                    <span className={`font-pixel text-[8px] ${saveMsg.includes('✓') ? 'text-green-400' : 'text-px-danger'}`}>
                      {saveMsg}
                    </span>
                  )}
                  {!isEditing ? (
                    <button onClick={handleEdit} className="pixel-btn-outline-light">
                      [/] EDIT
                    </button>
                  ) : (
                    <div className="flex gap-2">
                      <button onClick={handleCancel} className="pixel-btn-outline-muted">
                        CANCEL
                      </button>
                      <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="pixel-btn-outline-light disabled:opacity-40"
                      >
                        {isSaving ? 'SAVING...' : '[✓] SAVE'}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6 bg-px-dark">
                {!isEditing ? (
                  <pre className="whitespace-pre-wrap font-mono text-sm text-px-warm bg-px-black border-2 border-px-line p-4 leading-relaxed">
                    {selectedSkill.content}
                  </pre>
                ) : (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="pixel-input-dark w-full h-full resize-none font-mono text-sm"
                    placeholder="编辑技能内容（Markdown 格式）..."
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full bg-px-dark">
              <p className="font-pixel text-[10px] text-px-muted tracking-wider">SELECT A SKILL</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
