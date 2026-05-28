/**
 * ProjectManagerPanel — 分身下的任务包管理面板。
 *
 * 能力：
 *   - 列出当前分身的所有 project（含归档 + 会话数）
 *   - 创建：name + description
 *   - 编辑：name（rename 时迁移 conversations.project_id）/ description
 *   - 归档 / 取消归档
 *   - 删除：弹 confirm，可选迁移目标 project
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  onClose: () => void
  /** project 列表变化时回调（用于 App 重新拉 knownProjectIds） */
  onProjectsChanged?: () => void
}

interface FormState {
  /** 正在编辑的 project id；null = 新建 */
  id: string | null
  name: string
  description: string
}

const EMPTY_FORM: FormState = { id: null, name: '', description: '' }

export default function ProjectManagerPanel({ avatarId, onClose, onProjectsChanged }: Props) {
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [editing, setEditing] = useState<FormState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [statusMsg, setStatusMsg] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string>('default')
  const mountedRef = useRef(true)

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  const reload = useCallback(async () => {
    try {
      const list = await window.electronAPI.projectsList(avatarId)
      if (!mountedRef.current) return
      setProjects(list)
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [avatarId])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- reload() 内 setState 在 await 后跑且有 mountedRef 守卫；规则的"同步 setState"检测在此为误判
  useEffect(() => { void reload() }, [reload])

  const handleSubmit = async () => {
    if (!editing) return
    const name = editing.name.trim()
    const description = editing.description.trim()
    if (!name) { setError('名称不能为空'); return }
    if (!/^[\w-]+$/.test(name)) { setError('名称仅允许字母数字下划线连字符'); return }
    // 'default' 是保留项目桶（侧栏固定显示，不是实体项目），不能创建/rename 到 default
    if (name === 'default') { setError('"default" 是保留名，请换一个名称'); return }
    setError('')
    setBusy(true)
    try {
      if (editing.id) {
        await window.electronAPI.projectsUpdate(editing.id, { name, description })
        setStatusMsg(`已更新 ${name}`)
      } else {
        await window.electronAPI.projectsCreate(avatarId, name, description)
        setStatusMsg(`已创建 ${name}`)
      }
      setEditing(null)
      await reload()
      onProjectsChanged?.()
      setTimeout(() => { if (mountedRef.current) setStatusMsg('') }, 2500)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const handleArchive = async (id: string, archived: boolean) => {
    setBusy(true)
    try {
      await window.electronAPI.projectsArchive(id, archived)
      await reload()
      onProjectsChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    setBusy(true)
    try {
      await window.electronAPI.projectsDelete(id, { migrateConversationsTo: deleteTarget || 'default' })
      setConfirmDeleteId(null)
      setStatusMsg('已删除（会话已迁移）')
      await reload()
      onProjectsChanged?.()
      setTimeout(() => { if (mountedRef.current) setStatusMsg('') }, 2500)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="lg">
      <PanelHeader
        title="任务包"
        subtitle={`${projects.filter(p => !p.archived).length} 活跃 / ${projects.filter(p => p.archived).length} 归档`}
        onClose={onClose}
      />

      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-game text-[11px] text-px-text-dim">
            任务包是分身下的子工作空间：独立的会话列表，建议把每个客户 / 项目分开。
          </div>
          <button
            onClick={() => { setError(''); setEditing({ ...EMPTY_FORM }) }}
            className="pixel-btn-primary text-[12px] px-3 py-1"
            disabled={busy}
          >
            + 新建
          </button>
        </div>

        {statusMsg && <div className="font-game text-[11px] text-px-success">{statusMsg}</div>}
        {error && <div className="font-game text-[11px] text-px-danger">{error}</div>}

        {projects.length === 0 ? (
          <div className="font-game text-[12px] text-px-text-dim text-center py-6 border border-dashed border-px-border">
            还没有任务包；点击「+ 新建」开始创建
          </div>
        ) : (
          <div className="space-y-2">
            {projects.map(p => (
              <div key={p.id} className={`border-2 ${p.archived ? 'border-px-border/40 opacity-60' : 'border-px-border'} bg-px-elevated px-3 py-2`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="font-mono text-[13px] text-px-text truncate">{p.name}</span>
                    {p.archived && <span className="font-game text-[10px] text-px-text-dim tracking-wider px-1.5 py-0.5 border border-px-border">归档</span>}
                    <span className="font-game text-[11px] text-px-text-dim">{p.conversation_count} 个会话</span>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    {p.name === 'default' ? (
                      // default 是保留项目桶（侧栏固定显示，不是实体 project 行），
                      // 不允许编辑/归档/删除——IPC + DB 层也会拦，但 UI 层把按钮去掉
                      // 比让用户点了再吃报错更好
                      <span className="font-game text-[10px] text-px-text-dim tracking-wider px-1.5 py-0.5">保留</span>
                    ) : (
                      <>
                        <button onClick={() => { setError(''); setEditing({ id: p.id, name: p.name, description: p.description }) }} className="pixel-btn-ghost text-[11px] px-2 py-0.5" disabled={busy}>编辑</button>
                        <button onClick={() => handleArchive(p.id, !p.archived)} className="pixel-btn-ghost text-[11px] px-2 py-0.5" disabled={busy}>{p.archived ? '取消归档' : '归档'}</button>
                        <button onClick={() => { setDeleteTarget('default'); setConfirmDeleteId(p.id) }} className="pixel-btn-ghost text-[11px] px-2 py-0.5 text-px-danger" disabled={busy}>删除</button>
                      </>
                    )}
                  </div>
                </div>
                {p.description && (
                  <div className="font-game text-[11px] text-px-text-dim mt-1">{p.description}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ProjectEditModal
          form={editing}
          busy={busy}
          error={error}
          onChange={setEditing}
          onCancel={() => { setEditing(null); setError('') }}
          onSubmit={handleSubmit}
        />
      )}

      {confirmDeleteId && (
        <DeleteConfirmModal
          target={projects.find(p => p.id === confirmDeleteId)?.name || ''}
          allTargets={projects.filter(p => p.id !== confirmDeleteId && !p.archived).map(p => p.name)}
          chosen={deleteTarget}
          onChange={setDeleteTarget}
          busy={busy}
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => handleDelete(confirmDeleteId)}
        />
      )}
    </Modal>
  )
}

function ProjectEditModal({ form, busy, error, onChange, onCancel, onSubmit }: {
  form: FormState
  busy: boolean
  error: string
  onChange: (f: FormState) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <Modal isOpen={true} onClose={onCancel} size="md">
      <PanelHeader title={form.id ? `编辑 ${form.name}` : '新建任务包'} onClose={onCancel} />
      <div className="p-4 space-y-3">
        <label className="block space-y-1">
          <span className="font-game text-[11px] text-px-text-dim tracking-wider">名称（字母数字下划线连字符）</span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
            disabled={busy}
            className="w-full px-3 py-2 bg-px-bg border-2 border-px-border text-px-text font-mono text-[12px] focus:border-px-primary focus:outline-none"
            autoFocus
          />
        </label>
        <label className="block space-y-1">
          <span className="font-game text-[11px] text-px-text-dim tracking-wider">描述（可选）</span>
          <textarea
            value={form.description}
            onChange={(e) => onChange({ ...form, description: e.target.value })}
            disabled={busy}
            className="w-full px-3 py-2 bg-px-bg border-2 border-px-border text-px-text font-game text-[12px] focus:border-px-primary focus:outline-none"
            rows={3}
          />
        </label>
        {error && <div className="font-game text-[11px] text-px-danger">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onCancel} disabled={busy} className="pixel-btn-ghost">CANCEL</button>
          <button onClick={onSubmit} disabled={busy} className="pixel-btn-primary">{busy ? '...' : 'SAVE'}</button>
        </div>
      </div>
    </Modal>
  )
}

function DeleteConfirmModal({ target, allTargets, chosen, onChange, busy, onCancel, onConfirm }: {
  target: string
  allTargets: string[]
  chosen: string
  onChange: (n: string) => void
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const options = ['default', ...allTargets.filter(t => t !== 'default')]
  return (
    <Modal isOpen={true} onClose={onCancel} size="sm">
      <PanelHeader title={`删除任务包 ${target}`} onClose={onCancel} />
      <div className="p-4 space-y-3">
        <div className="font-game text-[12px] text-px-text-dim">
          此操作不可撤销。该任务包下的所有会话将迁移到下面选定的目标任务包：
        </div>
        <select
          value={chosen}
          onChange={(e) => onChange(e.target.value)}
          disabled={busy}
          className="w-full px-3 py-2 bg-px-bg border-2 border-px-border text-px-text font-mono text-[12px]"
        >
          {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
        </select>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onCancel} disabled={busy} className="pixel-btn-ghost">CANCEL</button>
          <button onClick={onConfirm} disabled={busy} className="pixel-btn-primary bg-px-danger border-px-danger hover:bg-px-danger">
            {busy ? '...' : '确认删除'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
