/**
 * SkillMarketplaceTab — 技能市场（skills.sh）
 *
 * 从 skills.sh 搜索开源技能，对当前分身安装 / 更新 / 卸载（avatars/<id>/skills/，source: local）。
 * - 已装技能（按 skillId 与本地技能 id 比对）显示「更新 / 卸载」，否则显示「安装」。
 * - 「详情」按需拉取 SKILL.md 描述（/api/search 不返回描述）。
 * 状态全部 component-local（与 CommunitySkillTab 一致，不引入 store）。
 */

import { useState, useEffect, useRef, useCallback } from 'react'

interface Props {
  avatarId: string
  /** 安装 / 更新 / 卸载后回调（父面板据此刷新本地技能列表与计数） */
  onChanged?: () => void
}

/** 在途操作枚举；action map 里非这些值的字符串视为错误信息 */
const BUSY = new Set<string>(['installing', 'updating', 'uninstalling'])

export default function SkillMarketplaceTab({ avatarId, onChanged }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SkillsShSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState('')
  /** 当前分身已装技能 id 集合（用于判定结果是否「已安装」） */
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set())
  /** item.id -> 在途状态或错误信息 */
  const [action, setAction] = useState<Record<string, string | undefined>>({})
  /** item.id -> 是否展开详情 */
  const [descOpen, setDescOpen] = useState<Record<string, boolean>>({})
  /** item.id -> 描述（'loading' 表示拉取中） */
  const [descCache, setDescCache] = useState<Record<string, string>>({})

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const loadInstalled = useCallback(async () => {
    try {
      const skills = await window.electronAPI.getSkills(avatarId)
      if (!mountedRef.current) return
      setInstalledIds(new Set(skills.map((s) => s.id)))
    } catch {
      /* 装/卸状态展示降级，不阻塞搜索 */
    }
  }, [avatarId])

  useEffect(() => { loadInstalled() }, [loadInstalled])

  const isInstalled = (item: SkillsShSearchResult) => installedIds.has(item.skillId)

  const handleSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setError('')
    try {
      const list = await window.electronAPI.skillsShSearch(q, 30)
      if (!mountedRef.current) return
      setResults(list)
      setSearched(true)
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current) setSearching(false)
    }
  }, [query])

  const doInstall = async (item: SkillsShSearchResult, overwrite: boolean) => {
    const key = item.id
    setAction((s) => ({ ...s, [key]: overwrite ? 'updating' : 'installing' }))
    try {
      await window.electronAPI.skillsShInstall(avatarId, item, overwrite ? { overwrite: true } : undefined)
      if (!mountedRef.current) return
      setAction((s) => ({ ...s, [key]: undefined }))
      await loadInstalled()
      onChanged?.()
    } catch (err) {
      if (mountedRef.current) setAction((s) => ({ ...s, [key]: err instanceof Error ? err.message : String(err) }))
    }
  }

  const handleUninstall = async (item: SkillsShSearchResult) => {
    if (!confirm(`确认卸载「${item.name}」？将删除 avatars/${avatarId}/skills/${item.skillId}/ 整个目录。`)) return
    const key = item.id
    setAction((s) => ({ ...s, [key]: 'uninstalling' }))
    try {
      await window.electronAPI.deleteSkill(avatarId, item.skillId)
      if (!mountedRef.current) return
      setAction((s) => ({ ...s, [key]: undefined }))
      await loadInstalled()
      onChanged?.()
    } catch (err) {
      if (mountedRef.current) setAction((s) => ({ ...s, [key]: err instanceof Error ? err.message : String(err) }))
    }
  }

  const toggleDesc = async (item: SkillsShSearchResult) => {
    const key = item.id
    const open = !descOpen[key]
    setDescOpen((s) => ({ ...s, [key]: open }))
    if (!open || item.description || descCache[key] !== undefined) return
    setDescCache((s) => ({ ...s, [key]: 'loading' }))
    try {
      const d = await window.electronAPI.skillsShDescribe(item.source, item.skillId)
      if (!mountedRef.current) return
      setDescCache((s) => ({ ...s, [key]: d || '（该技能未提供描述）' }))
    } catch {
      if (mountedRef.current) setDescCache((s) => ({ ...s, [key]: '（描述获取失败，可去 skills.sh 查看）' }))
    }
  }

  const errMsg = (st: string | undefined) => (st && !BUSY.has(st) ? st : '')

  return (
    <div className="flex-1 overflow-y-auto bg-px-surface p-6">
      {/* 搜索栏 */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-game text-[14px] text-px-text tracking-wider">技能市场 · skills.sh</h3>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
            placeholder="搜索开源技能，例如 react / commit / pdf ..."
            className="pixel-input flex-1 text-[13px]"
          />
          <button
            type="button"
            onClick={handleSearch}
            disabled={searching || !query.trim()}
            className="pixel-btn-primary text-[11px]"
          >
            {searching ? '搜索中...' : '搜索'}
          </button>
        </div>
        <p className="font-body text-[11px] text-px-text-dim mt-2">
          安装的技能为当前分身专属（写入 avatars/{avatarId}/skills/），也可在「本地技能」中查看、停用或删除。
        </p>
        {error && (
          <p className="font-game text-[11px] text-px-danger tracking-wider mt-2">搜索失败：{error}</p>
        )}
      </div>

      {/* 结果列表 */}
      {!searched ? (
        <div className="border-2 border-px-border-dim bg-px-bg p-8 text-center">
          <p className="font-game text-[12px] text-px-text-dim tracking-wider mb-2">输入关键词搜索技能</p>
          <p className="font-body text-[11px] text-px-text-dim">
            来源：skills.sh（Vercel 开源 Agent Skills 目录），按安装量排序
          </p>
        </div>
      ) : results.length === 0 ? (
        <div className="border-2 border-px-border-dim bg-px-bg p-8 text-center">
          <p className="font-game text-[12px] text-px-text-dim tracking-wider">没有匹配的技能</p>
        </div>
      ) : (
        <div className="space-y-3">
          {results.map((item) => {
            const st = action[item.id]
            const busy = st !== undefined && BUSY.has(st)
            const installed = isInstalled(item)
            const err = errMsg(st)
            const description = item.description || descCache[item.id]
            return (
              <div key={item.id} className="border-2 border-px-border bg-px-bg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-game text-[13px] text-px-text break-all">{item.name}</span>
                      <span className="font-game text-[9px] text-px-text-dim">★ {item.installs.toLocaleString()}</span>
                      {installed && <span className="pixel-badge text-[9px]">已安装</span>}
                    </div>
                    <p className="font-body text-[11px] text-px-text-dim mt-0.5 truncate">{item.source}</p>
                    <button
                      type="button"
                      onClick={() => toggleDesc(item)}
                      className="font-game text-[10px] text-px-primary hover:underline mt-1"
                    >
                      {descOpen[item.id] ? '收起' : '详情'}
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {installed ? (
                      <>
                        <button
                          type="button"
                          onClick={() => doInstall(item, true)}
                          disabled={busy}
                          className="pixel-btn-outline-light text-[11px]"
                        >
                          {st === 'updating' ? '更新中...' : '更新'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUninstall(item)}
                          disabled={busy}
                          className="pixel-btn-outline-muted text-[11px] text-px-danger"
                        >
                          {st === 'uninstalling' ? '卸载中...' : '卸载'}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => doInstall(item, false)}
                        disabled={busy}
                        className="pixel-btn-primary text-[11px]"
                      >
                        {st === 'installing' ? '安装中...' : '安装'}
                      </button>
                    )}
                  </div>
                </div>

                {descOpen[item.id] && (
                  <p className="font-body text-[11px] text-px-text-sec mt-2 pt-2 border-t border-px-border-dim leading-relaxed">
                    {descCache[item.id] === 'loading' ? '加载描述…' : (description || '（该技能未提供描述）')}
                  </p>
                )}
                {err && (
                  <p className="font-game text-[10px] text-px-danger tracking-wider mt-2 break-all">{err}</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
