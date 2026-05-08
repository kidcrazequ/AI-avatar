/**
 * SharedSkillTab — 公共技能 Tab
 *
 * 展示 shared/skills/ 下的公共技能列表。
 * 当前分身可通过 skill-index.yaml 引用这些公共技能。
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import { useState, useEffect, useRef } from 'react'

interface Props {
  avatarId: string
}

export default function SharedSkillTab({ avatarId }: Props) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    loadSharedSkills()
  }, [avatarId])

  const loadSharedSkills = async () => {
    setLoading(true)
    try {
      const allSkills = await window.electronAPI.getSkills(avatarId)
      if (!mountedRef.current) return
      const shared = allSkills.filter(s => s.source === 'shared')
      setSkills(shared)
    } catch (err) {
      if (mountedRef.current) {
        console.error('[SharedSkillTab] 加载公共技能失败:', err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-px-surface">
        <p className="font-game text-[13px] text-px-text-dim tracking-wider animate-pulse">加载中...</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto bg-px-surface p-6">
      <div className="mb-4">
        <h3 className="font-game text-[14px] text-px-text tracking-wider mb-1">公共技能</h3>
        <p className="font-body text-[12px] text-px-text-dim">
          来自 shared/skills/ 目录的跨分身共享技能。在分身的 skill-index.yaml 中添加引用即可启用。
        </p>
      </div>

      {skills.length === 0 ? (
        <div className="border-2 border-px-border-dim bg-px-bg p-8 text-center">
          <p className="font-game text-[12px] text-px-text-dim tracking-wider mb-2">当前分身未引用公共技能</p>
          <p className="font-body text-[11px] text-px-text-dim">
            在 skill-index.yaml 中添加 source: shared 的技能条目即可在此显示
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {skills.map((skill) => (
            <div
              key={skill.id}
              className="border-2 border-px-border bg-px-bg px-4 py-3 flex items-center justify-between"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-game text-[13px] text-px-text">{skill.name}</span>
                  <span className="pixel-badge text-[10px]">SHARED</span>
                  {skill.enabled && <span className="font-game text-[10px] text-px-success">ON</span>}
                </div>
                <p className="font-body text-[11px] text-px-text-dim mt-0.5 truncate">
                  {skill.description || '无描述'}
                </p>
              </div>
              <div className="flex items-center gap-2 ml-3">
                <span className="font-game text-[11px] text-px-text-dim">{skill.version}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
