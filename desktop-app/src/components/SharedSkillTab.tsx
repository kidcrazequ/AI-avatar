/**
 * SharedSkillTab — 公共技能 Tab
 *
 * 从 shared/skills/*.md 扫出所有可用公共技能，渲染列表 + 一键启用/禁用开关。
 * 切换开关时由主进程编辑分身的 skill-index.yaml（保留其他段不变）。
 *
 * @author zhi.qu
 * @date 2026-05-18
 */

import { useState, useEffect, useRef, useCallback } from 'react'

interface Props {
  avatarId: string
}

interface SharedSkillItem {
  name: string
  filename: string
  description: string
  domain: string
  enabled: boolean
}

export default function SharedSkillTab({ avatarId }: Props) {
  const [items, setItems] = useState<SharedSkillItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [togglingName, setTogglingName] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.electronAPI.getAvailableSharedSkills(avatarId)
      if (!mountedRef.current) return
      setItems(list)
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [avatarId])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load() 是 async + setState 在 await 后跑，规则误判
  useEffect(() => { load() }, [load])

  const handleToggle = async (name: string, next: boolean) => {
    setTogglingName(name)
    // 乐观更新：立即翻 UI，失败时回滚
    setItems(prev => prev.map(it => it.name === name ? { ...it, enabled: next } : it))
    try {
      await window.electronAPI.toggleSharedSkill(avatarId, name, next)
    } catch (err) {
      // 回滚
      setItems(prev => prev.map(it => it.name === name ? { ...it, enabled: !next } : it))
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current) setTogglingName(null)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-px-surface">
        <p className="font-game text-[13px] text-px-text-dim tracking-wider animate-pulse">加载中...</p>
      </div>
    )
  }

  const enabledCount = items.filter(i => i.enabled).length

  return (
    <div className="flex-1 overflow-y-auto bg-px-surface p-6">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h3 className="font-game text-[14px] text-px-text tracking-wider mb-1">公共技能</h3>
          <p className="font-body text-[12px] text-px-text-dim">
            来自 <span className="font-mono text-px-primary">shared/skills/</span> 的跨分身共享技能。勾选即可加入当前分身，自动写入 <span className="font-mono text-px-primary">skill-index.yaml</span>。
          </p>
        </div>
        <div className="font-game text-[11px] text-px-text-dim tracking-wider whitespace-nowrap">
          {enabledCount} / {items.length} ON
        </div>
      </div>

      {error && (
        <div className="border-2 border-px-danger bg-px-danger/10 p-3 mb-3">
          <p className="font-game text-[12px] text-px-danger">⚠ {error}</p>
        </div>
      )}

      {items.length === 0 ? (
        <div className="border-2 border-px-border-dim bg-px-bg p-8 text-center">
          <p className="font-game text-[12px] text-px-text-dim tracking-wider">shared/skills/ 目录下没有公共技能</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const busy = togglingName === item.name
            return (
              <label
                key={item.name}
                className={`flex items-start gap-3 border-2 ${item.enabled ? 'border-px-primary' : 'border-px-border'} bg-px-bg px-4 py-3 cursor-pointer transition-none hover:bg-px-elevated`}
              >
                <div
                  role="checkbox"
                  aria-checked={item.enabled}
                  aria-busy={busy}
                  className="pixel-checkbox mt-0.5 flex-shrink-0"
                  data-checked={item.enabled}
                  onClick={(e) => {
                    e.preventDefault()
                    if (!busy) handleToggle(item.name, !item.enabled)
                  }}
                >
                  ✓
                </div>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={item.enabled}
                  disabled={busy}
                  onChange={(e) => handleToggle(item.name, e.target.checked)}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-game text-[13px] text-px-text font-medium">{item.name}</span>
                    <span className="pixel-badge text-[10px]">SHARED</span>
                    {item.enabled && <span className="font-game text-[10px] text-px-success tracking-wider">ON</span>}
                    {busy && <span className="font-game text-[10px] text-px-text-dim animate-pulse">…</span>}
                    {item.domain && (
                      <span className="font-game text-[10px] text-px-text-dim">· {item.domain}</span>
                    )}
                  </div>
                  {item.description && (
                    <p className="font-body text-[11px] text-px-text-dim mt-1 line-clamp-2">
                      {item.description}
                    </p>
                  )}
                  <p className="font-mono text-[10px] text-px-text-dim mt-1">
                    shared/skills/{item.filename}
                  </p>
                </div>
              </label>
            )
          })}
        </div>
      )}

      <div className="mt-6 border-t-2 border-px-border-dim pt-4">
        <p className="font-body text-[11px] text-px-text-dim leading-relaxed">
          <span className="text-px-warning">注意</span>：启用后默认 <span className="font-mono">keywords: []</span> + <span className="font-mono">priority: 5</span>。
          如需让分身按用户关键词自动路由到该技能，到 <span className="font-mono">avatars/{avatarId}/skills/skill-index.yaml</span> 手动补充 keywords。
          不补充也不影响 AI 通过 <span className="font-mono">load_skill</span> 工具按需加载。
        </p>
      </div>
    </div>
  )
}
