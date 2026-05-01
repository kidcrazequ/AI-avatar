/**
 * SkillProposalCard: AI 技能创建建议确认卡片。
 *
 * 当 AI 回复中包含 [SKILL_CREATE]...[/SKILL_CREATE] 标签时，
 * 渲染此卡片提示用户确认是否创建新技能。
 * 用户确认后调用 writeSkillFile IPC 写入技能文件。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */

import { useState, useRef, useEffect } from 'react'

interface Props {
  avatarId: string
  proposals: string[]
  onDismiss: () => void
}

/** 从技能内容中提取第一行 # 标题作为文件名（index 用作无标题时的稳定回退） */
function extractSkillId(content: string, index: number): string {
  const match = content.match(/^#\s+(.+)$/m)
  if (!match) return `skill-${index}`
  const normalized = match[1].trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
  return normalized || `skill-${index}`
}

export default function SkillProposalCard({ avatarId, proposals, onDismiss }: Props) {
  const [saving, setSaving] = useState<number | null>(null)
  const [saved, setSaved] = useState<Set<number>>(new Set())
  const [statusMsg, setStatusMsg] = useState('')
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(statusTimerRef.current)
    }
  }, [])

  useEffect(() => {
    setSaved(new Set())
    setSaving(null)
    setStatusMsg('')
  }, [proposals])

  const handleCreate = async (index: number, content: string) => {
    setSaving(index)
    try {
      const skillId = extractSkillId(content, index)
      const fileName = `${skillId}.md`
      await window.electronAPI.writeSkillFile(avatarId, fileName, content)
      if (!mountedRef.current) return
      setSaved(prev => new Set(prev).add(index))
      setStatusMsg(`技能已创建: ${fileName}`)
      clearTimeout(statusTimerRef.current)
      statusTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setStatusMsg('')
      }, 3000)
    } catch (error) {
      if (!mountedRef.current) return
      console.error('创建技能失败:', error)
      setStatusMsg(`创建失败: ${error instanceof Error ? error.message : String(error)}`)
      clearTimeout(statusTimerRef.current)
      statusTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setStatusMsg('')
      }, 5000)
    } finally {
      if (mountedRef.current) setSaving(null)
    }
  }

  if (proposals.length === 0) return null

  return (
    <div className="mx-4 my-2 border-2 border-px-primary bg-px-elevated p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-game text-[12px] text-px-primary tracking-wider">SKILL PROPOSAL</span>
          <span className="font-game text-[11px] text-px-text-dim">AI 建议创建 {proposals.length} 个新技能</span>
        </div>
        <button onClick={onDismiss} className="font-game text-[12px] text-px-text-dim hover:text-px-text">✕</button>
      </div>

      {statusMsg && (
        <div className={`font-game text-[12px] px-3 py-1.5 ${statusMsg.includes('失败') ? 'text-px-danger bg-px-danger/10' : 'text-px-success bg-px-success/10'}`}>
          {statusMsg}
        </div>
      )}

      {proposals.map((content, i) => {
        const skillId = extractSkillId(content, i)
        const isSaved = saved.has(i)
        return (
          <div key={`${skillId}-${i}`} className="border border-px-border bg-px-surface p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-game text-[13px] text-px-text">{skillId}.md</span>
              <div className="flex gap-2">
                {isSaved ? (
                  <span className="font-game text-[12px] text-px-success">CREATED</span>
                ) : (
                  <button
                    onClick={() => handleCreate(i, content)}
                    disabled={saving === i}
                    className="pixel-btn-primary py-1 text-[12px]"
                  >
                    {saving === i ? '创建中...' : '创建技能'}
                  </button>
                )}
              </div>
            </div>
            <pre className="font-mono text-[12px] text-px-text-sec overflow-auto max-h-32 bg-px-bg p-2 border border-px-border-dim">
              {content.slice(0, 300)}{content.length > 300 ? '...' : ''}
            </pre>
          </div>
        )
      })}
    </div>
  )
}
