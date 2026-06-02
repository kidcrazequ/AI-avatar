/**
 * SkillMarketplaceTab — 技能市场（skills.sh）
 *
 * 从 skills.sh 搜索开源技能，一键安装到当前分身（avatars/<id>/skills/，source: local）。
 * 安装后通过 onInstalled 通知父面板刷新「本地技能」列表。
 *
 * 状态全部 component-local（与 CommunitySkillTab 一致，不引入 store）。
 */

import { useState, useEffect, useRef, useCallback } from 'react'

interface Props {
  avatarId: string
  /** 安装成功后回调（父面板据此刷新本地技能列表） */
  onInstalled?: () => void
}

/** 单项安装状态：undefined=未操作，'loading'=安装中，'done'=已装，其它字符串=错误信息 */
type InstallState = 'loading' | 'done' | string | undefined

export default function SkillMarketplaceTab({ avatarId, onInstalled }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SkillsShSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState<Record<string, InstallState>>({})

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

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

  const handleInstall = async (item: SkillsShSearchResult) => {
    setInstalling((prev) => ({ ...prev, [item.id]: 'loading' }))
    try {
      await window.electronAPI.skillsShInstall(avatarId, item)
      if (!mountedRef.current) return
      setInstalling((prev) => ({ ...prev, [item.id]: 'done' }))
      onInstalled?.()
    } catch (err) {
      if (!mountedRef.current) return
      setInstalling((prev) => ({ ...prev, [item.id]: err instanceof Error ? err.message : String(err) }))
    }
  }

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
          安装的技能为当前分身专属（写入 avatars/{avatarId}/skills/），可在「本地技能」中查看、停用或删除。
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
            const state = installing[item.id]
            return (
              <div key={item.id} className="border-2 border-px-border bg-px-bg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-game text-[13px] text-px-text break-all">{item.name}</span>
                      <span className="font-game text-[9px] text-px-text-dim">
                        ★ {item.installs.toLocaleString()}
                      </span>
                    </div>
                    <p className="font-body text-[11px] text-px-text-dim mt-0.5 truncate">{item.source}</p>
                    {item.description && (
                      <p className="font-body text-[11px] text-px-text-sec mt-1 line-clamp-2">{item.description}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleInstall(item)}
                    disabled={state === 'loading' || state === 'done'}
                    className={`text-[11px] flex-shrink-0 ${state === 'done' ? 'pixel-btn-outline-muted text-px-success' : 'pixel-btn-primary'}`}
                  >
                    {state === 'loading' ? '安装中...' : state === 'done' ? '已安装 ✓' : (typeof state === 'string' && state ? '重试' : '安装')}
                  </button>
                </div>
                {typeof state === 'string' && state !== 'loading' && state !== 'done' && (
                  <p className="font-game text-[10px] text-px-danger tracking-wider mt-2 break-all">{state}</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
