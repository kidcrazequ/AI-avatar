import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  onClose: () => void
}

type PalaceTab = 'rooms' | 'commitments' | 'inbox' | 'profile'

const INBOX_KINDS: Array<{ value: PalaceInboxKindDTO; label: string }> = [
  { value: 'fact', label: '事实' },
  { value: 'person', label: '人物' },
  { value: 'project', label: '项目' },
  { value: 'commitment', label: '承诺' },
  { value: 'writing', label: '写法' },
  { value: 'route', label: '路线' },
  { value: 'other', label: '其他' },
]

const TARGETS: Array<{ value: PalaceSedimentTargetDTO; label: string }> = [
  { value: 'profile', label: 'profile' },
  { value: 'company', label: 'company' },
  { value: 'people', label: 'people' },
  { value: 'projects', label: 'projects' },
  { value: 'meetings', label: 'meetings' },
  { value: 'reports', label: 'reports' },
  { value: 'decisions', label: 'decisions' },
  { value: 'achievements', label: 'achievements' },
  { value: 'wiki', label: 'wiki' },
  { value: 'commitments', label: 'commitments' },
  { value: 'rooms', label: 'rooms' },
  { value: 'inbox', label: 'inbox' },
]

const URGENCY_LABEL: Record<PalaceCommitmentUrgencyDTO, string> = {
  overdue: '已逾期',
  due_today: '今天到期',
  due_soon: '近期到期',
  scheduled: '已排期',
  no_due: '无截止日',
  closed: '已关闭',
}

const STATUS_LABEL: Record<PalaceCommitmentStatusDTO, string> = {
  proposed: '待确认',
  open: '进行中',
  done: '已完成',
  blocked: '阻塞',
  dropped: '已作废',
}

const INBOX_STATUS_LABEL: Record<PalaceInboxStatusDTO, string> = {
  pending: '待确认',
  accepted: '已接受',
  rejected: '已拒绝',
}

export default function PalacePanel({ avatarId, onClose }: Props) {
  const [tab, setTab] = useState<PalaceTab>('commitments')
  const [overview, setOverview] = useState<PalaceOverviewDTO | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [showResolvedInbox, setShowResolvedInbox] = useState(false)
  const [showClosedCommitments, setShowClosedCommitments] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [draftKind, setDraftKind] = useState<PalaceInboxKindDTO>('fact')
  const [draftTarget, setDraftTarget] = useState<PalaceSedimentTargetDTO>('wiki')
  const [draftSource, setDraftSource] = useState('manual')
  const [editingRoom, setEditingRoom] = useState<PalaceRoomDTO | 'new' | null>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const loadSeqRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(statusTimerRef.current)
    }
  }, [])

  const showStatus = useCallback((message: string) => {
    if (!mountedRef.current) return
    setStatusMsg(message)
    clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setStatusMsg('')
    }, 2400)
  }, [])

  const loadOverview = useCallback(async () => {
    const seq = ++loadSeqRef.current
    setIsLoading(true)
    try {
      const next = await window.electronAPI.palace.getOverview(avatarId)
      if (loadSeqRef.current !== seq || !mountedRef.current) return
      setOverview(next)
    } catch (error) {
      if (loadSeqRef.current !== seq || !mountedRef.current) return
      const msg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('error', 'palace-panel-load', msg)
      showStatus('LOAD FAILED')
    } finally {
      if (loadSeqRef.current === seq && mountedRef.current) setIsLoading(false)
    }
  }, [avatarId, showStatus])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadOverview()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadOverview])

  const openCommitments = useMemo(
    () => (overview?.commitments ?? []).filter(item => item.status !== 'done' && item.status !== 'dropped'),
    [overview],
  )
  const visibleCommitments = useMemo(
    () => showClosedCommitments ? (overview?.commitments ?? []) : openCommitments,
    [openCommitments, overview, showClosedCommitments],
  )
  const pendingInbox = useMemo(
    () => (overview?.inbox ?? []).filter(item => item.status === 'pending'),
    [overview],
  )
  const visibleInbox = useMemo(
    () => showResolvedInbox ? (overview?.inbox ?? []) : pendingInbox,
    [overview, pendingInbox, showResolvedInbox],
  )

  const handleCommitmentStatus = async (id: string, status: PalaceCommitmentStatusDTO) => {
    setIsSaving(true)
    try {
      const appendNote = status === 'blocked'
        ? (window.prompt('阻塞原因（可空）', '') ?? undefined)
        : undefined
      await window.electronAPI.palace.updateCommitment(avatarId, id, { status, appendNote })
      showStatus('SAVED')
      await loadOverview()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('error', 'palace-commitment-update', msg)
      showStatus('FAILED')
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const handleInboxStatus = async (id: string, status: PalaceInboxStatusDTO) => {
    setIsSaving(true)
    try {
      await window.electronAPI.palace.updateInboxItem(avatarId, id, { status })
      showStatus('SAVED')
      await loadOverview()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('error', 'palace-inbox-update', msg)
      showStatus('FAILED')
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const handleAddInbox = async () => {
    const title = draftTitle.trim()
    const content = draftContent.trim()
    if (!title || !content) {
      showStatus('标题或正文为空')
      return
    }
    setIsSaving(true)
    try {
      await window.electronAPI.palace.addInboxItem(avatarId, {
        title,
        content,
        kind: draftKind,
        target: draftTarget,
        source: draftSource.trim() || 'manual',
      })
      setDraftTitle('')
      setDraftContent('')
      showStatus('SAVED')
      await loadOverview()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('error', 'palace-inbox-add', msg)
      showStatus('FAILED')
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const handleSaveRoom = async (input: PalaceRoomInputDTO) => {
    setIsSaving(true)
    try {
      await window.electronAPI.palace.writeRoom(avatarId, input)
      setEditingRoom(null)
      showStatus('SAVED')
      await loadOverview()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('error', 'palace-room-write', msg)
      showStatus(msg.includes('id') ? 'BAD ID' : 'FAILED')
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const handleDeleteRoom = async (roomId: string) => {
    if (!window.confirm(`确定删除路线卡「${roomId}」？此操作不可撤销。`)) return
    setIsSaving(true)
    try {
      await window.electronAPI.palace.deleteRoom(avatarId, roomId)
      if (editingRoom !== 'new' && editingRoom?.id === roomId) setEditingRoom(null)
      showStatus('SAVED')
      await loadOverview()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('error', 'palace-room-delete', msg)
      showStatus('FAILED')
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const subtitle = overview
    ? `${overview.rooms.length} routes · ${openCommitments.length} open · ${pendingInbox.length} pending`
    : avatarId

  return (
    <Modal isOpen={true} onClose={onClose} size="xl">
      <PanelHeader
        title="职场环境记忆"
        subtitle={subtitle}
        onClose={onClose}
        actions={(
          <>
            {statusMsg && (
              <span className={`font-game text-[11px] ${statusMsg.includes('SAVE') ? 'text-px-success' : statusMsg.includes('FAIL') ? 'text-px-danger' : 'text-px-primary'}`}>
                {statusMsg}
              </span>
            )}
            <button type="button" className="pixel-btn-outline-muted py-1 text-[11px]" onClick={() => window.electronAPI.palace.reveal(avatarId)}>
              Finder
            </button>
            <button type="button" className="pixel-btn-outline-light py-1 text-[11px]" disabled={isLoading} onClick={() => void loadOverview()}>
              {isLoading ? '...' : '刷新'}
            </button>
          </>
        )}
      />

      <div className="flex-1 flex flex-col min-h-0 bg-px-surface">
        <div className="flex items-center gap-1 px-3 py-2 bg-px-elevated border-b-2 border-px-border">
          <TabButton active={tab === 'rooms'} onClick={() => setTab('rooms')}>路线</TabButton>
          <TabButton active={tab === 'commitments'} onClick={() => setTab('commitments')}>承诺</TabButton>
          <TabButton active={tab === 'inbox'} onClick={() => setTab('inbox')}>沉淀</TabButton>
          <TabButton active={tab === 'profile'} onClick={() => setTab('profile')}>档案</TabButton>
        </div>

        <div className="grid grid-cols-3 gap-2 px-4 py-3 bg-px-bg border-b border-px-border-dim">
          <Metric label="路线卡" value={overview?.rooms.length ?? 0} />
          <Metric label="未关闭承诺" value={openCommitments.length} tone={openCommitments.some(c => c.urgency === 'overdue') ? 'danger' : 'primary'} />
          <Metric label="待确认沉淀" value={pendingInbox.length} tone={pendingInbox.length > 0 ? 'warning' : 'primary'} />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {!overview && isLoading ? (
            <div className="font-game text-[13px] text-px-text-dim text-center py-12">LOADING...</div>
          ) : tab === 'rooms' ? (
            editingRoom !== null ? (
              <RoomEditor
                initial={editingRoom === 'new' ? null : editingRoom}
                disabled={isSaving}
                onCancel={() => setEditingRoom(null)}
                onSave={(input) => void handleSaveRoom(input)}
              />
            ) : (
              <RoomsTab
                rooms={overview?.rooms ?? []}
                onNew={() => setEditingRoom('new')}
                onEdit={(room) => setEditingRoom(room)}
                onDelete={(id) => void handleDeleteRoom(id)}
              />
            )
          ) : tab === 'commitments' ? (
            <CommitmentsTab
              commitments={visibleCommitments}
              showClosed={showClosedCommitments}
              onToggleClosed={() => setShowClosedCommitments(v => !v)}
              onUpdateStatus={(id, status) => void handleCommitmentStatus(id, status)}
              disabled={isSaving}
            />
          ) : tab === 'inbox' ? (
            <InboxTab
              items={visibleInbox}
              showResolved={showResolvedInbox}
              onToggleResolved={() => setShowResolvedInbox(v => !v)}
              onUpdateStatus={(id, status) => void handleInboxStatus(id, status)}
              disabled={isSaving}
              draft={{
                title: draftTitle,
                content: draftContent,
                kind: draftKind,
                target: draftTarget,
                source: draftSource,
                setTitle: setDraftTitle,
                setContent: setDraftContent,
                setKind: setDraftKind,
                setTarget: setDraftTarget,
                setSource: setDraftSource,
                submit: () => void handleAddInbox(),
              }}
            />
          ) : (
            <ProfileTab profile={overview?.profile ?? ''} company={overview?.company ?? ''} />
          )}
        </div>
      </div>
    </Modal>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 font-game text-[11px] tracking-wider border-2 ${active ? 'border-px-primary bg-px-primary/15 text-px-text' : 'border-px-border text-px-text-dim'}`}
    >
      {children}
    </button>
  )
}

function Metric({ label, value, tone = 'primary' }: { label: string; value: number; tone?: 'primary' | 'warning' | 'danger' }) {
  const color = tone === 'danger' ? 'text-px-danger' : tone === 'warning' ? 'text-px-warning' : 'text-px-primary'
  return (
    <div className="border-2 border-px-border bg-px-elevated px-3 py-2 min-w-0">
      <div className="font-game text-[10px] text-px-text-dim">{label}</div>
      <div className={`font-mono text-[22px] leading-tight ${color}`}>{value}</div>
    </div>
  )
}

function RoomsTab({
  rooms,
  onNew,
  onEdit,
  onDelete,
}: {
  rooms: PalaceRoomDTO[]
  onNew: () => void
  onEdit: (room: PalaceRoomDTO) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="space-y-3">
      <div className="border-2 border-px-border-dim bg-px-bg px-4 py-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] text-px-text-sec leading-relaxed">
            <span className="font-game text-[11px] text-px-primary mr-1">路线卡</span>
            = 教分身「遇到某类任务先看什么、按什么顺序、避开什么坑」。
          </p>
          <p className="text-[12px] text-px-text-dim mt-1 leading-relaxed">
            最快上手：点下面任意示例卡的「编辑」照着改。想从头建，点右边按钮。
          </p>
        </div>
        <button type="button" className="pixel-btn-primary py-1 text-[12px] shrink-0" onClick={onNew}>+ 新建路线卡</button>
      </div>
      {rooms.length === 0 ? (
        <EmptyState label="还没有路线卡。点「+ 新建路线卡」从头建一张" />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {rooms.map(room => (
            <section key={room.id} className="border-2 border-px-border bg-px-elevated p-4 min-w-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-game text-[13px] text-px-text truncate">{room.name}</h3>
                  <p className="font-mono text-[11px] text-px-text-dim mt-1">{room.id} · priority {room.priority}</p>
                </div>
                <span className={`font-game text-[10px] border px-2 py-1 ${room.enabled ? 'border-px-success text-px-success' : 'border-px-border text-px-text-dim'}`}>
                  {room.enabled ? 'ON' : 'OFF'}
                </span>
              </div>
              {room.description && <p className="text-[13px] text-px-text-sec mt-3 leading-relaxed">{room.description}</p>}
              <CompactList title="触发" items={room.triggers} />
              <CompactList title="必读" items={room.readOrder.length > 0 ? room.readOrder : room.requiredFiles} />
              {room.conditionalReads.length > 0 && <CompactList title="条件读" items={room.conditionalReads} />}
              <CompactList title="坑" items={room.pitfalls} />
              {room.toneGuidance && (
                <div className="mt-3 text-[12px] text-px-text-sec leading-relaxed">
                  <span className="font-game text-[10px] text-px-text-dim mr-1">口径</span>{room.toneGuidance}
                </div>
              )}
              <div className="mt-3 font-mono text-[11px] text-px-text-dim truncate">
                输出：{room.outputLocation || 'inbox/'} · 沉淀：{room.sedimentTargets.join(' / ') || 'inbox'}
              </div>
              <div className="mt-3 flex gap-2">
                <button type="button" className="pixel-btn-outline-light py-1 text-[11px]" onClick={() => onEdit(room)}>编辑</button>
                <button type="button" className="pixel-btn-outline-muted py-1 text-[11px] text-px-danger border-px-danger" onClick={() => onDelete(room.id)}>删除</button>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

const ROOM_TARGET_VALUES: PalaceSedimentTargetDTO[] = TARGETS.map(t => t.value)

const ROOM_TARGET_LABELS: Record<PalaceSedimentTargetDTO, string> = {
  profile: '画像',
  company: '组织',
  people: '人物',
  projects: '项目',
  meetings: '会议',
  reports: '汇报',
  decisions: '决策',
  achievements: '成果',
  wiki: '知识',
  commitments: '承诺',
  rooms: '路线卡',
  inbox: '收件箱',
}

function RoomEditor({
  initial,
  disabled,
  onCancel,
  onSave,
}: {
  initial: PalaceRoomDTO | null
  disabled: boolean
  onCancel: () => void
  onSave: (input: PalaceRoomInputDTO) => void
}) {
  const isEdit = initial !== null
  const [id, setId] = useState(initial?.id ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [triggers, setTriggers] = useState(linesOf(initial?.triggers))
  const [requiredFiles, setRequiredFiles] = useState(linesOf(initial?.requiredFiles))
  const [readOrder, setReadOrder] = useState(linesOf(initial?.readOrder))
  const [conditionalReads, setConditionalReads] = useState(linesOf(initial?.conditionalReads))
  const [pitfalls, setPitfalls] = useState(linesOf(initial?.pitfalls))
  const [outputLocation, setOutputLocation] = useState(initial?.outputLocation ?? 'inbox/')
  const [toneGuidance, setToneGuidance] = useState(initial?.toneGuidance ?? '')
  const [sedimentTargets, setSedimentTargets] = useState<PalaceSedimentTargetDTO[]>(initial?.sedimentTargets ?? ['inbox'])
  const [priority, setPriority] = useState(String(initial?.priority ?? 50))
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [body, setBody] = useState(initial?.body ?? '')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const autoId = slugify(name)
  const effectiveId = isEdit ? (initial?.id ?? '') : (id.trim() || autoId)

  const submit = () => {
    if (!name.trim()) { window.alert('先给这张卡起个名字，比如「给老板写邮件」'); return }
    if (arrayOf(triggers).length === 0) { window.alert('填一下「什么时候用这张卡」（触发词），否则分身不知道何时该用它'); return }
    if (!effectiveId) { window.alert('生成不出 id，请展开「高级」手填一个英文 id'); return }
    const n = Number(priority)
    onSave({
      id: effectiveId,
      name: name.trim(),
      description: description.trim(),
      triggers: arrayOf(triggers),
      requiredFiles: arrayOf(requiredFiles),
      readOrder: arrayOf(readOrder),
      conditionalReads: arrayOf(conditionalReads),
      pitfalls: arrayOf(pitfalls),
      outputLocation: outputLocation.trim() || 'inbox/',
      toneGuidance: toneGuidance.trim(),
      sedimentTargets,
      priority: Number.isFinite(n) ? n : 50,
      enabled,
      body: body.trim() ? body : undefined,
    })
  }

  const toggleTarget = (value: PalaceSedimentTargetDTO) => {
    setSedimentTargets(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value])
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-game text-[13px] text-px-primary">{isEdit ? `编辑 · ${initial?.name}` : '新建路线卡'}</h3>
        <div className="flex gap-2">
          <button type="button" disabled={disabled} className="pixel-btn-outline-muted py-1 text-[11px]" onClick={onCancel}>取消</button>
          <button type="button" disabled={disabled} className="pixel-btn-primary py-1 text-[12px]" onClick={submit}>保存</button>
        </div>
      </div>

      <div className="space-y-3 border-2 border-px-border bg-px-elevated p-3">
        <Field label="名字" required hint="这张卡叫什么，给人看的">
          <input value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="例：给老板写邮件" />
        </Field>
        <Field label="什么时候用这张卡（触发词，每行一个）" required hint="用户说到这些词，分身就自动用这张卡">
          <textarea value={triggers} onChange={e => setTriggers(e.target.value)} className={areaCls} placeholder={'例：\n写邮件\n给王总'} />
        </Field>
        <Field label="必读（按顺序，每行一个文件/目录）" hint="做这类任务前，先看哪些材料">
          <textarea value={requiredFiles} onChange={e => setRequiredFiles(e.target.value)} className={areaCls} placeholder={'例：\nprofile.md\ncompany.md\npeople/'} />
        </Field>
        <Field label="坑 / 别踩（每行一个）" hint="这类任务最容易犯的错">
          <textarea value={pitfalls} onChange={e => setPitfalls(e.target.value)} className={areaCls} placeholder={'例：\n别写成流水账\n别承诺没定的工期'} />
        </Field>
      </div>

      <button
        type="button"
        onClick={() => setShowAdvanced(v => !v)}
        className="w-full text-left font-game text-[11px] text-px-text-dim border-2 border-px-border-dim px-3 py-2"
      >
        {showAdvanced ? '▾' : '▸'} 高级选项（条件读 / 建议口径 / 沉淀目标 / 正文 / id）
      </button>

      {showAdvanced && (
        <div className="space-y-3 border-l-2 border-px-border-dim pl-3">
          <Field label="id（文件名）" hint={isEdit ? '已建卡的 id 不能改' : `留空就用名字自动生成：${autoId || '（先填名字）'}`}>
            <input value={id} disabled={isEdit} onChange={e => setId(e.target.value)} className={inputCls} placeholder={autoId || 'daily-room'} />
          </Field>
          <Field label="一句话说明" hint="给这张卡写个简介（可选）">
            <input value={description} onChange={e => setDescription(e.target.value)} className={inputCls} />
          </Field>
          <Field label="条件读（每行「涉及 X → 重点看 Y」）" hint="按场景追加读，不是固定必读">
            <textarea value={conditionalReads} onChange={e => setConditionalReads(e.target.value)} className={areaCls} placeholder="例：涉及报价 → 重点看最新 reports/" />
          </Field>
          <Field label="建议口径" hint="给分身定对外措辞 / 语气基调">
            <textarea value={toneGuidance} onChange={e => setToneGuidance(e.target.value)} className={areaCls} placeholder="例：结论先行，只给数字和风险" />
          </Field>
          <Field label="任务做完后把新发现归到哪些文件夹" hint="默认进收件箱等你确认；不确定就别动">
            <div className="flex flex-wrap gap-1">
              {ROOM_TARGET_VALUES.map(value => (
                <button
                  key={value}
                  type="button"
                  onClick={() => toggleTarget(value)}
                  className={`font-mono text-[11px] border px-2 py-0.5 ${sedimentTargets.includes(value) ? 'border-px-primary text-px-primary bg-px-primary/10' : 'border-px-border-dim text-px-text-dim'}`}
                >
                  {ROOM_TARGET_LABELS[value]}<span className="opacity-50 ml-1">{value}</span>
                </button>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
            <Field label="阅读顺序（覆盖必读的展示顺序）" hint="一般不用填">
              <textarea value={readOrder} onChange={e => setReadOrder(e.target.value)} className={areaCls} />
            </Field>
            <Field label="输出位置" hint="任务产物默认存哪">
              <input value={outputLocation} onChange={e => setOutputLocation(e.target.value)} className={inputCls} />
            </Field>
            <Field label="排序权重（0-100）" hint="多卡命中时分高的优先">
              <input type="number" value={priority} onChange={e => setPriority(e.target.value)} className={inputCls} />
            </Field>
          </div>
          <label className="flex items-center gap-2 font-mono text-[12px] text-px-text">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> 启用这张卡
          </label>
          <Field label="正文（Markdown，可选）" hint="给人读的完整路线说明；留空会自动生成骨架">
            <textarea value={body} onChange={e => setBody(e.target.value)} className="w-full min-h-[140px] px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px] text-px-text" />
          </Field>
        </div>
      )}
    </div>
  )
}

const inputCls = 'w-full px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px] text-px-text'
const areaCls = 'w-full min-h-[70px] px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px] text-px-text'

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <div className="font-game text-[10px] text-px-text-sec mb-0.5">
        {label}{required && <span className="text-px-danger ml-1">*</span>}
      </div>
      {hint && <div className="text-[11px] text-px-text-dim mb-1 leading-snug">{hint}</div>}
      {children}
    </div>
  )
}

function linesOf(items: string[] | undefined): string {
  return (items ?? []).join('\n')
}

function arrayOf(text: string): string[] {
  return text.split('\n').map(s => s.trim()).filter(Boolean)
}

/** 从名字推一个安全的文件名 id：空白和点转连字符、去路径分隔符；中文原样保留。 */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, '-')
    .replace(/[/\\]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function CommitmentsTab({
  commitments,
  showClosed,
  onToggleClosed,
  onUpdateStatus,
  disabled,
}: {
  commitments: PalaceCommitmentDTO[]
  showClosed: boolean
  onToggleClosed: () => void
  onUpdateStatus: (id: string, status: PalaceCommitmentStatusDTO) => void
  disabled: boolean
}) {
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button type="button" className="pixel-btn-outline-muted py-1 text-[11px]" onClick={onToggleClosed}>
          {showClosed ? '隐藏关闭项' : '显示关闭项'}
        </button>
      </div>
      {commitments.length === 0 ? (
        <EmptyState label="暂无承诺" />
      ) : commitments.map(item => (
        <section key={item.id} className="border-2 border-px-border bg-px-elevated p-4">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-game text-[13px] text-px-text">{item.title}</h3>
                <Badge label={STATUS_LABEL[item.status]} tone={item.status === 'done' ? 'success' : item.status === 'blocked' ? 'danger' : 'primary'} />
                <Badge label={URGENCY_LABEL[item.urgency]} tone={item.urgency === 'overdue' ? 'danger' : item.urgency === 'due_today' || item.urgency === 'due_soon' ? 'warning' : 'muted'} />
              </div>
              <p className="text-[13px] text-px-text-sec mt-2 leading-relaxed">{item.promise}</p>
              <div className="font-mono text-[11px] text-px-text-dim mt-2">
                {item.counterparty} · {item.direction} {item.dueAt ? `· due ${item.dueAt}` : ''}
              </div>
            </div>
            {item.status !== 'done' && item.status !== 'dropped' && (
              <div className="flex flex-wrap gap-2 shrink-0">
                <button type="button" disabled={disabled} className="pixel-btn-outline-light py-1 text-[11px]" onClick={() => onUpdateStatus(item.id, 'done')}>完成</button>
                <button type="button" disabled={disabled} className="pixel-btn-outline-muted py-1 text-[11px]" onClick={() => onUpdateStatus(item.id, 'blocked')}>阻塞</button>
                <button type="button" disabled={disabled} className="pixel-btn-outline-muted py-1 text-[11px] text-px-danger border-px-danger" onClick={() => onUpdateStatus(item.id, 'dropped')}>作废</button>
              </div>
            )}
          </div>
          {item.notes && item.notes.length > 0 && <CompactList title="备注" items={item.notes} />}
        </section>
      ))}
    </div>
  )
}

function InboxTab({
  items,
  showResolved,
  onToggleResolved,
  onUpdateStatus,
  disabled,
  draft,
}: {
  items: PalaceInboxItemDTO[]
  showResolved: boolean
  onToggleResolved: () => void
  onUpdateStatus: (id: string, status: PalaceInboxStatusDTO) => void
  disabled: boolean
  draft: {
    title: string
    content: string
    kind: PalaceInboxKindDTO
    target: PalaceSedimentTargetDTO
    source: string
    setTitle: (v: string) => void
    setContent: (v: string) => void
    setKind: (v: PalaceInboxKindDTO) => void
    setTarget: (v: PalaceSedimentTargetDTO) => void
    setSource: (v: string) => void
    submit: () => void
  }
}) {
  return (
    <div className="space-y-3">
      <section className="border-2 border-px-border bg-px-bg p-3">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-2">
          <input value={draft.title} onChange={e => draft.setTitle(e.target.value)} className="px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px] text-px-text" placeholder="标题" />
          <select value={draft.kind} onChange={e => draft.setKind(e.target.value as PalaceInboxKindDTO)} className="px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px] text-px-text">
            {INBOX_KINDS.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
          </select>
          <select value={draft.target} onChange={e => draft.setTarget(e.target.value as PalaceSedimentTargetDTO)} className="px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px] text-px-text">
            {TARGETS.map(target => <option key={target.value} value={target.value}>{target.label}</option>)}
          </select>
          <input value={draft.source} onChange={e => draft.setSource(e.target.value)} className="px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px] text-px-text" placeholder="source" />
        </div>
        <textarea value={draft.content} onChange={e => draft.setContent(e.target.value)} className="mt-2 w-full min-h-[76px] px-2 py-1 bg-px-surface border border-px-border font-mono text-[13px] text-px-text" placeholder="正文" />
        <div className="flex justify-between items-center gap-2 mt-2">
          <button type="button" className="pixel-btn-outline-muted py-1 text-[11px]" onClick={onToggleResolved}>
            {showResolved ? '隐藏已处理' : '显示已处理'}
          </button>
          <button type="button" disabled={disabled} className="pixel-btn-primary py-1 text-[12px]" onClick={draft.submit}>添加沉淀候选</button>
        </div>
      </section>

      {items.length === 0 ? (
        <EmptyState label="暂无沉淀项" />
      ) : items.map(item => (
        <section key={item.id} className="border-2 border-px-border bg-px-elevated p-4">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-game text-[13px] text-px-text">{item.title}</h3>
                <Badge label={INBOX_STATUS_LABEL[item.status]} tone={item.status === 'accepted' ? 'success' : item.status === 'rejected' ? 'danger' : 'warning'} />
                <Badge label={item.kind} tone="muted" />
                {item.target && <Badge label={item.target} tone="primary" />}
              </div>
              <p className="text-[13px] text-px-text-sec mt-2 leading-relaxed whitespace-pre-wrap">{item.content}</p>
              <div className="font-mono text-[11px] text-px-text-dim mt-2">
                {item.source ?? 'manual'} · {item.updatedAt}
              </div>
            </div>
            {item.status === 'pending' && (
              <div className="flex flex-wrap gap-2 shrink-0">
                <button type="button" disabled={disabled} className="pixel-btn-outline-light py-1 text-[11px]" onClick={() => onUpdateStatus(item.id, 'accepted')}>接受</button>
                <button type="button" disabled={disabled} className="pixel-btn-outline-muted py-1 text-[11px] text-px-danger border-px-danger" onClick={() => onUpdateStatus(item.id, 'rejected')}>拒绝</button>
              </div>
            )}
          </div>
          {item.tags && item.tags.length > 0 && <CompactList title="标签" items={item.tags} />}
        </section>
      ))}
    </div>
  )
}

function ProfileTab({ profile, company }: { profile: string; company: string }) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
      <TextBlock title="profile.md" text={profile} />
      <TextBlock title="company.md" text={company} />
    </div>
  )
}

function TextBlock({ title, text }: { title: string; text: string }) {
  return (
    <section className="border-2 border-px-border bg-px-elevated p-4 min-w-0">
      <h3 className="font-game text-[13px] text-px-primary mb-3">{title}</h3>
      <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-px-text-sec max-h-[520px] overflow-auto">{text || '暂无内容'}</pre>
    </section>
  )
}

function CompactList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className="mt-3">
      <div className="font-game text-[10px] text-px-text-dim mb-1">{title}</div>
      <div className="flex flex-wrap gap-1">
        {items.slice(0, 8).map(item => (
          <span key={item} className="font-mono text-[11px] text-px-text-sec border border-px-border-dim px-2 py-0.5 max-w-full truncate">{item}</span>
        ))}
      </div>
    </div>
  )
}

function Badge({ label, tone }: { label: string; tone: 'primary' | 'success' | 'warning' | 'danger' | 'muted' }) {
  const cls = tone === 'success'
    ? 'border-px-success text-px-success'
    : tone === 'warning'
      ? 'border-px-warning text-px-warning'
      : tone === 'danger'
        ? 'border-px-danger text-px-danger'
        : tone === 'muted'
          ? 'border-px-border text-px-text-dim'
          : 'border-px-primary text-px-primary'
  return <span className={`font-game text-[10px] border px-2 py-0.5 ${cls}`}>{label}</span>
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="border-2 border-dashed border-px-border bg-px-bg px-4 py-10 text-center">
      <p className="font-game text-[12px] text-px-text-dim">{label}</p>
    </div>
  )
}
