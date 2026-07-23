import { useState } from 'react'

export interface WorkflowSkillDraft {
  suggestedId: string
  filename: string
  title: string
  content: string
}

interface Props {
  avatarId: string
  draft: WorkflowSkillDraft
  onDismiss: () => void
  onPromoted?: (skillId: string) => void
  onRun: (skillId: string) => void
}

export default function WorkflowSkillDraftCard({
  avatarId,
  draft,
  onDismiss,
  onPromoted,
  onRun,
}: Props) {
  const [skillId, setSkillId] = useState(draft.suggestedId)
  const [content, setContent] = useState(draft.content)
  const [isSaving, setIsSaving] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [savedSkillId, setSavedSkillId] = useState('')

  const handleSave = async () => {
    if (isSaving || savedSkillId) return
    setIsSaving(true)
    setErrors([])
    try {
      const result = await window.electronAPI.promoteSkillDraft({
        avatarId,
        filename: draft.filename,
        skillId: skillId.trim(),
        draftContent: content,
      })
      if (result.errors.length > 0 || !result.skillId) {
        setErrors(result.errors.length > 0 ? result.errors : ['技能保存失败'])
        return
      }
      setSavedSkillId(result.skillId)
      onPromoted?.(result.skillId)
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)])
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section className="mx-4 my-2 border-2 border-px-primary bg-px-elevated">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b-2 border-px-border">
        <div>
          <div className="font-game text-[12px] text-px-primary tracking-wider">SOP 技能草稿</div>
          <div className="font-body text-[12px] text-px-text-dim mt-1">
            {savedSkillId ? '已保存并启用，可以立即试用。' : '可直接修改；保存时会同步生成并校验严格 SOP。'}
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="font-game text-[12px] text-px-text-dim hover:text-px-text"
          aria-label="关闭 SOP 技能草稿"
        >
          ✕
        </button>
      </div>

      <div className="p-4 space-y-3">
        <div>
          <label className="font-game text-[11px] text-px-text-dim tracking-wider block mb-1">
            技能 ID
          </label>
          <input
            value={skillId}
            onChange={(event) => setSkillId(event.target.value)}
            disabled={Boolean(savedSkillId) || isSaving}
            className="pixel-input w-full font-mono text-[13px] disabled:opacity-60"
            placeholder="例如：customer-solution-sop"
          />
        </div>

        <div>
          <label className="font-game text-[11px] text-px-text-dim tracking-wider block mb-1">
            技能内容
          </label>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            disabled={Boolean(savedSkillId) || isSaving}
            className="pixel-input w-full h-52 resize-y font-mono text-[12px] leading-relaxed disabled:opacity-60"
            aria-label="SOP 技能草稿内容"
          />
        </div>

        {errors.length > 0 && (
          <ul className="border border-px-danger bg-px-danger/10 px-3 py-2 space-y-1">
            {errors.map((error, index) => (
              <li key={`${error}-${index}`} className="font-body text-[12px] text-px-danger">
                • {error}
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end gap-2">
          {savedSkillId ? (
            <button
              type="button"
              onClick={() => onRun(savedSkillId)}
              className="pixel-btn-primary"
            >
              ▶ 立即试用
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={isSaving || !skillId.trim() || !content.trim()}
              className="pixel-btn-primary"
            >
              {isSaving ? '生成并校验 SOP 中...' : '保存并启用'}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
