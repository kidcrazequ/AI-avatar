/**
 * CommunitySkillTab — 社区技能 Tab
 *
 * 管理社区技能源：添加/移除 GitHub 仓库，同步安装，为分身启用/禁用。
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import { useState, useEffect, useRef, useCallback } from 'react'

interface Props {
  avatarId: string
}

export default function CommunitySkillTab({ avatarId }: Props) {
  const [sources, setSources] = useState<CommunitySkillSource[]>([])
  const [installed, setInstalled] = useState<InstalledCommunityPack[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState('')

  const [showAddForm, setShowAddForm] = useState(false)
  const [newRepo, setNewRepo] = useState('')
  const [newRef, setNewRef] = useState('main')
  const [newName, setNewName] = useState('')
  const [addError, setAddError] = useState('')

  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [srcList, installedList] = await Promise.all([
        window.electronAPI.communityListSources(),
        window.electronAPI.communityListInstalled(),
      ])
      if (!mountedRef.current) return
      setSources(srcList)
      setInstalled(installedList)
    } catch (err) {
      if (mountedRef.current) {
        console.error('[CommunitySkillTab] 加载失败:', err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  useEffect(() => {
    const unsub = window.electronAPI.onCommunitySyncProgress((progress) => {
      if (!mountedRef.current) return
      if (progress.phase === 'error') {
        setSyncStatus(`${progress.sourceName}: 失败 - ${progress.detail || '未知错误'}`)
      } else if (progress.phase === 'done') {
        setSyncStatus(`${progress.sourceName}: 完成 (${progress.current}/${progress.total})`)
      } else {
        setSyncStatus(`${progress.sourceName}: ${progress.phase} (${progress.current}/${progress.total})`)
      }
    })
    return unsub
  }, [])

  const handleAddSource = async () => {
    setAddError('')
    const repo = newRepo.trim()
    const ref = newRef.trim() || 'main'
    let name = newName.trim()

    if (!repo) { setAddError('请输入仓库 URL'); return }
    if (!repo.startsWith('https://')) { setAddError('仓库 URL 必须以 https:// 开头'); return }

    if (!name) {
      const match = repo.match(/\/([^/]+?)(\.git)?$/)
      name = match?.[1] || 'unnamed'
    }

    if (!/^[a-z0-9_-]+$/.test(name)) {
      setAddError('名称仅支持小写字母、数字、连字符、下划线')
      return
    }

    try {
      await window.electronAPI.communityAddSource({ name, repo, ref })
      if (!mountedRef.current) return
      setShowAddForm(false)
      setNewRepo('')
      setNewRef('main')
      setNewName('')
      await loadData()
    } catch (err) {
      if (mountedRef.current) {
        setAddError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const handleRemoveSource = async (name: string) => {
    if (!confirm(`确认移除技能源 "${name}"？将同时删除已安装的技能文件。`)) return
    try {
      await window.electronAPI.communityRemoveSource(name)
      if (!mountedRef.current) return
      await loadData()
    } catch (err) {
      if (mountedRef.current) {
        window.electronAPI.logEvent('error', 'community:remove', err instanceof Error ? err.message : String(err))
      }
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    setSyncStatus('开始同步...')
    try {
      await window.electronAPI.communitySync()
      if (!mountedRef.current) return
      setSyncStatus('同步完成')
      await loadData()
    } catch (err) {
      if (mountedRef.current) {
        setSyncStatus(`同步失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      if (mountedRef.current) setSyncing(false)
    }
  }

  const handleEnableSkill = async (skillName: string, packName: string) => {
    try {
      await window.electronAPI.communityEnableForAvatar(avatarId, skillName, packName)
    } catch (err) {
      window.electronAPI.logEvent('error', 'community:enable', err instanceof Error ? err.message : String(err))
    }
  }

  const handleDisableSkill = async (skillName: string) => {
    try {
      await window.electronAPI.communityDisableForAvatar(avatarId, skillName)
    } catch (err) {
      window.electronAPI.logEvent('error', 'community:disable', err instanceof Error ? err.message : String(err))
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
      {/* 添加技能源 */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-game text-[14px] text-px-text tracking-wider">社区技能</h3>
          <div className="flex items-center gap-2">
            {sources.length > 0 && (
              <button
                type="button"
                onClick={handleSync}
                disabled={syncing}
                className="pixel-btn-outline-light text-[11px]"
              >
                {syncing ? '同步中...' : '同步全部'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowAddForm(!showAddForm)}
              className="pixel-btn-primary text-[11px]"
            >
              {showAddForm ? '取消' : '+ 添加源'}
            </button>
          </div>
        </div>

        {syncStatus && (
          <p className="font-body text-[11px] text-px-text-dim mb-2">{syncStatus}</p>
        )}

        {showAddForm && (
          <div className="border-2 border-px-primary/50 bg-px-bg p-4 mb-4">
            <div className="space-y-3">
              <div>
                <label className="font-game text-[11px] text-px-text-dim tracking-wider block mb-1">
                  GitHub 仓库 URL *
                </label>
                <input
                  type="text"
                  value={newRepo}
                  onChange={(e) => setNewRepo(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  className="pixel-input w-full text-[13px]"
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="font-game text-[11px] text-px-text-dim tracking-wider block mb-1">
                    版本 / Tag / Branch
                  </label>
                  <input
                    type="text"
                    value={newRef}
                    onChange={(e) => setNewRef(e.target.value)}
                    placeholder="main"
                    className="pixel-input w-full text-[13px]"
                  />
                </div>
                <div className="flex-1">
                  <label className="font-game text-[11px] text-px-text-dim tracking-wider block mb-1">
                    本地名称（可选）
                  </label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="自动从 URL 提取"
                    className="pixel-input w-full text-[13px]"
                  />
                </div>
              </div>
              {addError && (
                <p className="font-game text-[11px] text-px-danger tracking-wider">{addError}</p>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleAddSource}
                  className="pixel-btn-primary text-[11px]"
                >
                  确认添加
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 已安装列表 */}
      {installed.length === 0 && sources.length === 0 ? (
        <div className="border-2 border-px-border-dim bg-px-bg p-8 text-center">
          <p className="font-game text-[12px] text-px-text-dim tracking-wider mb-2">
            暂无社区技能源
          </p>
          <p className="font-body text-[11px] text-px-text-dim">
            点击"+ 添加源"从 GitHub 安装社区共享的技能包
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {sources.map((source) => {
            const pack = installed.find(p => p.name === source.name)
            return (
              <div key={source.name} className="border-2 border-px-border bg-px-bg p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-game text-[13px] text-px-text">{source.name}</span>
                      <span className="font-game text-[10px] text-px-text-dim">{source.ref}</span>
                      {pack && <span className="pixel-badge text-[9px]">已安装</span>}
                    </div>
                    <p className="font-body text-[11px] text-px-text-dim mt-0.5 truncate max-w-md">
                      {source.repo}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleRemoveSource(source.name)}
                      className="pixel-btn-outline-muted text-[10px] text-px-danger"
                    >
                      卸载
                    </button>
                  </div>
                </div>

                {pack && pack.skills.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-px-border-dim">
                    <p className="font-game text-[10px] text-px-text-dim tracking-wider mb-2">
                      {pack.skillCount} 个技能 · 同步于 {pack.syncedAt.slice(0, 10)}
                    </p>
                    <div className="space-y-1">
                      {pack.skills.map((skill) => (
                        <div key={skill.name} className="flex items-center justify-between py-1 px-2 hover:bg-px-surface/50">
                          <div className="flex items-center gap-2">
                            <span className="font-body text-[12px] text-px-text">{skill.name}</span>
                            {skill.domain && (
                              <span className="font-game text-[9px] text-px-text-dim">[{skill.domain}]</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleEnableSkill(skill.name, source.name)}
                              className="font-game text-[10px] text-px-primary hover:underline"
                            >
                              启用
                            </button>
                            <span className="text-px-text-dim">|</span>
                            <button
                              type="button"
                              onClick={() => handleDisableSkill(skill.name)}
                              className="font-game text-[10px] text-px-text-dim hover:text-px-danger"
                            >
                              禁用
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
