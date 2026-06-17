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
        title="PALACE"
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
      <div className="flex justify-end">
        <button type="button" className="pixel-btn-primary py-1 text-[12px]" onClick={onNew}>+ 新建房间</button>
      </div>
      {rooms.length === 0 ? (
        <EmptyState label="暂无路线卡，点「+ 新建房间」创建第一张" />
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

  const submit = () => {
    const trimmedId = id.trim()
    const trimmedName = name.trim()
    if (!trimmedId) { window.alert('id 不能为空（仅小写字母/数字/连字符，如 daily-room）'); return }
    if (!trimmedName) { window.alert('name 不能为空'); return }
    const n = Number(priority)
    onSave({
      id: trimmedId,
      name: trimmedName,
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
        <h3 className="font-game text-[13px] text-px-primary">{isEdit ? `编辑路线卡 · ${initial?.id}` : '新建路线卡'}</h3>
        <div className="flex gap-2">
          <button type="button" disabled={disabled} className="pixel-btn-outline-muted py-1 text-[11px]" onClick={onCancel}>取消</button>
          <button type="button" disabled={disabled} className="pixel-btn-primary py-1 text-[12px]" onClick={submit}>保存</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        <Field label="id（文件名，小写/数字/连字符）">
          <input value={id} disabled={isEdit} onChange={e => setId(e.target.value)} className={inputCls} placeholder="daily-room" />
        </Field>
        <Field label="name（显示名）">
          <input value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="今日驾驶舱" />
        </Field>
      </div>

      <Field label="description（一句话说明）">
        <input value={description} onChange={e => setDescription(e.target.value)} className={inputCls} />
      </Field>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        <Field label="触发关键词（每行一个）"><textarea value={triggers} onChange={e => setTriggers(e.target.value)} className={areaCls} /></Field>
        <Field label="必读文件/目录（每行一个）"><textarea value={requiredFiles} onChange={e => setRequiredFiles(e.target.value)} className={areaCls} /></Field>
        <Field label="阅读顺序（每行一个）"><textarea value={readOrder} onChange={e => setReadOrder(e.target.value)} className={areaCls} /></Field>
        <Field label="条件读（每行「涉及X → 重点看Y」）"><textarea value={conditionalReads} onChange={e => setConditionalReads(e.target.value)} className={areaCls} /></Field>
        <Field label="坑/敏感点（每行一个）"><textarea value={pitfalls} onChange={e => setPitfalls(e.target.value)} className={areaCls} /></Field>
        <Field label="建议口径"><textarea value={toneGuidance} onChange={e => setToneGuidance(e.target.value)} className={areaCls} /></Field>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
        <Field label="输出位置"><input value={outputLocation} onChange={e => setOutputLocation(e.target.value)} className={inputCls} /></Field>
        <Field label="priority（0-100）"><input type="number" value={priority} onChange={e => setPriority(e.target.value)} className={inputCls} /></Field>
        <Field label="启用">
          <label className="flex items-center gap-2 font-mono text-[12px] text-px-text px-1 py-1">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> enabled
          </label>
        </Field>
      </div>

      <Field label="沉淀目标（多选）">
        <div className="flex flex-wrap gap-1">
          {ROOM_TARGET_VALUES.map(value => (
            <button
              key={value}
              type="button"
              onClick={() => toggleTarget(value)}
              className={`font-mono text-[11px] border px-2 py-0.5 ${sedimentTargets.includes(value) ? 'border-px-primary text-px-primary bg-px-primary/10' : 'border-px-border-dim text-px-text-dim'}`}
            >
              {value}
            </button>
          ))}
        </div>
      </Field>

      <Field label="正文（Markdown，可选）">
        <textarea value={body} onChange={e => setBody(e.target.value)} className="w-full min-h-[140px] px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px] text-px-text" />
      </Field>
    </div>
  )
}

const inputCls = 'w-full px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px] text-px-text'
const areaCls = 'w-full min-h-[70px] px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px] text-px-text'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="font-game text-[10px] text-px-text-dim mb-1">{label}</div>
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
