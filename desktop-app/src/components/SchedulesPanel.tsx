/**
 * SchedulesPanel — 用户自定义定时任务面板（#11 Scheduled Tasks，2026-05-09）。
 *
 * 功能：
 *   - 列表：当前分身下所有 schedules（含启停 / 立即触发 / 删除）
 *   - 创建 / 编辑：cron 表达式简易模式（每天 / 每周 / 每月 / 每 N 小时）+ 高级模式
 *     高级模式用 cronstrue 中文实时释义；下 3 次触发由主进程 schedule:get-next-runs 计算
 *   - 历史日志：选中 schedule 后显示最近 100 条 runs
 *
 * 设计：
 *   - 不引入新依赖（cronstrue 已在子任务 2 装入）
 *   - 风格：与 PromptTemplatePanel 一致的 pixel UI（PanelHeader + Modal 即可）
 *   - 错误统一 toast + logEvent，遵守 .cursor/rules/react-renderer.mdc
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import cronstrue from 'cronstrue/i18n'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  onClose: () => void
}

/** cron 简易模式预设 */
type SimpleMode =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; dow: number; hour: number; minute: number }
  | { kind: 'monthly'; dom: number; hour: number; minute: number }
  | { kind: 'hourly'; everyNHours: number }

/** 把简易模式编译为 cron 表达式（标准 5 字段：min hour dom month dow） */
function compileSimpleToCron(s: SimpleMode): string {
  switch (s.kind) {
    case 'daily':
      return `${s.minute} ${s.hour} * * *`
    case 'weekly':
      return `${s.minute} ${s.hour} * * ${s.dow}`
    case 'monthly':
      return `${s.minute} ${s.hour} ${s.dom} * *`
    case 'hourly':
      return `0 */${s.everyNHours} * * *`
    default: {
      const _exhaustive: never = s
      return _exhaustive
    }
  }
}

/** 把 cronstrue 解析失败转化成中文友好的提示，避免向用户抛英文 trace */
function describeCron(expr: string): { ok: boolean; text: string } {
  try {
    const text = cronstrue.toString(expr, { locale: 'zh_CN', use24HourTimeFormat: true })
    return { ok: true, text }
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) }
  }
}

/** Unix ms → 用户本地时区可读字符串 */
function fmtLocalTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const DEFAULT_SIMPLE: SimpleMode = { kind: 'daily', hour: 9, minute: 0 }

const STATUS_LABEL: Record<ScheduleRunRow['status'], string> = {
  running: '运行中',
  success: '成功',
  failed: '失败',
  missed: '错过',
}

export default function SchedulesPanel({ avatarId, onClose }: Props) {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [runs, setRuns] = useState<ScheduleRunRow[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const loadSeqRef = useRef(0)

  // ─── 表单字段（创建 / 编辑共享） ─────────────────────────────────────────
  const [name, setName] = useState('')
  const [promptText, setPromptText] = useState('')
  const [conversationId, setConversationId] = useState<string>('') // 空串 = 每次新建
  const [cronMode, setCronMode] = useState<'simple' | 'advanced'>('simple')
  const [simple, setSimple] = useState<SimpleMode>(DEFAULT_SIMPLE)
  const [advancedExpr, setAdvancedExpr] = useState('0 9 * * *')
  const [timezone, setTimezone] = useState<string>(DEFAULT_TIMEZONE)
  const [enabled, setEnabled] = useState(true)
  const [nextRuns, setNextRuns] = useState<number[]>([])

  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2500)
  }

  const reportError = useCallback(async (action: string, err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[SchedulesPanel] ${action} 失败:`, detail)
    showToast(`${action}失败：${detail.slice(0, 80)}`)
    try {
      await window.electronAPI.logEvent('error', `schedule-panel:${action}`, detail)
    } catch (logErr) {
      console.warn('[SchedulesPanel] logEvent 失败:', logErr)
    }
  }, [])

  // ─── 加载 ────────────────────────────────────────────────────────────────
  const loadSchedules = useCallback(async () => {
    const seq = ++loadSeqRef.current
    try {
      const list = await window.electronAPI.scheduleList(avatarId)
      if (loadSeqRef.current !== seq) return
      setSchedules(list)
    } catch (err) {
      void reportError('加载列表', err)
    }
  }, [avatarId, reportError])

  const loadRuns = useCallback(async (scheduleId: string) => {
    try {
      const list = await window.electronAPI.scheduleListRuns(scheduleId, 100)
      setRuns(list)
    } catch (err) {
      void reportError('加载历史', err)
    }
  }, [reportError])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadSchedules() }, [loadSchedules])

  // ─── 表单 ↔ schedule 同步 ────────────────────────────────────────────────
  const resetForm = useCallback(() => {
    setName('')
    setPromptText('')
    setConversationId('')
    setCronMode('simple')
    setSimple(DEFAULT_SIMPLE)
    setAdvancedExpr('0 9 * * *')
    setTimezone(DEFAULT_TIMEZONE)
    setEnabled(true)
    setNextRuns([])
  }, [])

  const fillFormFromSchedule = useCallback((row: ScheduleRow) => {
    setName(row.name)
    setPromptText(row.prompt_text)
    setConversationId(row.conversation_id ?? '')
    setCronMode('advanced') // 编辑已有 schedule 默认走高级（保留原表达式不被简易模式重写）
    setAdvancedExpr(row.cron_expr)
    setTimezone(row.timezone)
    setEnabled(row.enabled === 1)
  }, [])

  useEffect(() => {
    if (isCreating) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      resetForm()
      return
    }
    if (selectedId) {
      const row = schedules.find((s) => s.id === selectedId)
      if (row) {
        fillFormFromSchedule(row)
        void loadRuns(row.id)
      }
    }
  }, [isCreating, selectedId, schedules, resetForm, fillFormFromSchedule, loadRuns])

  // ─── 动态计算当前表达式与下次触发时间预览 ─────────────────────────────────
  const currentCronExpr = useMemo(
    () => (cronMode === 'simple' ? compileSimpleToCron(simple) : advancedExpr.trim()),
    [cronMode, simple, advancedExpr],
  )

  const cronDescription = useMemo(() => describeCron(currentCronExpr), [currentCronExpr])

  // 表达式变化时，请求主进程算下 3 次触发（仅高级模式 + 表达式有效时计算，避免抖动）
  useEffect(() => {
    if (!cronDescription.ok) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNextRuns([])
      return
    }
    let cancelled = false
    void window.electronAPI.scheduleGetNextRuns(currentCronExpr, timezone, 3)
      .then((arr) => { if (!cancelled) setNextRuns(arr) })
      .catch((err) => { if (!cancelled) console.warn('[SchedulesPanel] getNextRuns 失败:', err) })
    return () => { cancelled = true }
  }, [currentCronExpr, timezone, cronDescription.ok])

  // ─── 操作 ────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!name.trim()) { showToast('请填写任务名称'); return }
    if (!promptText.trim()) { showToast('请填写提示词内容'); return }
    if (!cronDescription.ok) { showToast(`cron 表达式非法：${cronDescription.text.slice(0, 60)}`); return }
    try {
      if (isCreating) {
        const created = await window.electronAPI.scheduleCreate({
          name: name.trim(),
          avatarId,
          cronExpr: currentCronExpr,
          timezone,
          promptText: promptText.trim(),
          conversationId: conversationId.trim() || null,
          enabled,
        })
        showToast('创建成功')
        setIsCreating(false)
        setSelectedId(created.id)
        await loadSchedules()
      } else if (selectedId) {
        await window.electronAPI.scheduleUpdate(selectedId, {
          name: name.trim(),
          cronExpr: currentCronExpr,
          timezone,
          promptText: promptText.trim(),
          conversationId: conversationId.trim() || null,
          enabled,
        })
        showToast('更新成功')
        await loadSchedules()
        await loadRuns(selectedId)
      }
    } catch (err) {
      void reportError('保存', err)
    }
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm('删除该定时任务？历史日志会一并删除，且不可恢复。')) return
    try {
      await window.electronAPI.scheduleDelete(id)
      showToast('已删除')
      if (selectedId === id) setSelectedId(null)
      await loadSchedules()
    } catch (err) {
      void reportError('删除', err)
    }
  }

  const handleToggleEnabled = async (row: ScheduleRow) => {
    try {
      await window.electronAPI.scheduleSetEnabled(row.id, row.enabled !== 1)
      await loadSchedules()
    } catch (err) {
      void reportError('启停', err)
    }
  }

  const handleTriggerNow = async (row: ScheduleRow) => {
    try {
      const r = await window.electronAPI.scheduleTriggerNow(row.id)
      if (r.conflict) {
        showToast('当前时刻已有触发记录，已跳过（幂等）')
      } else {
        showToast('已触发，等待对话生成')
      }
      // 给主进程一点时间写 running 行，然后刷新
      window.setTimeout(() => { void loadRuns(row.id) }, 800)
    } catch (err) {
      void reportError('立即触发', err)
    }
  }

  // ─── 渲染辅助 ────────────────────────────────────────────────────────────
  const renderListItem = (row: ScheduleRow) => {
    const active = selectedId === row.id && !isCreating
    return (
      <div
        key={row.id}
        className={`p-3 mb-2 border-2 ${active ? 'border-px-primary bg-px-primary/10' : 'border-px-border bg-px-bg-sec'} cursor-pointer hover:bg-px-bg-tert`}
        onClick={() => { setSelectedId(row.id); setIsCreating(false) }}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="font-game text-[13px] text-px-text truncate flex-1 mr-2">{row.name}</span>
          <span className={`font-game text-[10px] px-2 py-0.5 ${row.enabled === 1 ? 'bg-px-primary/20 text-px-primary' : 'bg-gray-500/20 text-gray-400'}`}>
            {row.enabled === 1 ? 'ON' : 'OFF'}
          </span>
        </div>
        <div className="font-game text-[11px] text-px-text-sec">
          {describeCron(row.cron_expr).text}
        </div>
        <div className="font-game text-[10px] text-px-text-sec mt-1">
          下次：{fmtLocalTime(row.next_run_at)}
        </div>
      </div>
    )
  }

  const renderForm = () => (
    <div className="space-y-3">
      <div>
        <label className="font-game text-[11px] text-px-text-sec block mb-1">任务名称</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          className="w-full px-2 py-1 bg-px-bg-sec border-2 border-px-border font-game text-[12px] text-px-text"
          placeholder="如：每日早安"
        />
      </div>

      <div>
        <label className="font-game text-[11px] text-px-text-sec block mb-1">触发频率</label>
        <div className="flex gap-2 mb-2">
          {([
            ['simple', '简易'],
            ['advanced', '高级 (cron)'],
          ] as const).map(([key, lab]) => (
            <button
              key={key}
              onClick={() => setCronMode(key)}
              className={`px-3 py-1 font-game text-[11px] border-2 ${cronMode === key ? 'border-px-primary bg-px-primary/20 text-px-primary' : 'border-px-border bg-px-bg-sec text-px-text-sec'}`}
            >
              {lab}
            </button>
          ))}
        </div>

        {cronMode === 'simple' ? (
          <div className="border-2 border-px-border bg-px-bg-sec p-2 space-y-2">
            <select
              value={simple.kind}
              onChange={(e) => {
                const k = e.target.value as SimpleMode['kind']
                if (k === 'daily') setSimple({ kind: 'daily', hour: 9, minute: 0 })
                else if (k === 'weekly') setSimple({ kind: 'weekly', dow: 1, hour: 9, minute: 0 })
                else if (k === 'monthly') setSimple({ kind: 'monthly', dom: 1, hour: 9, minute: 0 })
                else setSimple({ kind: 'hourly', everyNHours: 6 })
              }}
              className="px-2 py-1 bg-px-bg border-2 border-px-border font-game text-[12px] text-px-text"
            >
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
              <option value="hourly">每 N 小时</option>
            </select>

            {(simple.kind === 'daily' || simple.kind === 'weekly' || simple.kind === 'monthly') && (
              <div className="flex items-center gap-2 font-game text-[12px] text-px-text">
                {simple.kind === 'weekly' && (
                  <select
                    value={simple.dow}
                    onChange={(e) => setSimple({ ...simple, dow: Number(e.target.value) })}
                    className="px-2 py-1 bg-px-bg border-2 border-px-border"
                  >
                    {['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((lab, i) => (
                      <option key={i} value={i}>{lab}</option>
                    ))}
                  </select>
                )}
                {simple.kind === 'monthly' && (
                  <>
                    <span>每月</span>
                    <input
                      type="number"
                      min={1}
                      max={28}
                      value={simple.dom}
                      onChange={(e) => setSimple({ ...simple, dom: Number(e.target.value) })}
                      className="w-14 px-2 py-1 bg-px-bg border-2 border-px-border"
                    />
                    <span>日</span>
                  </>
                )}
                <span>{simple.kind === 'daily' ? '每天' : ''}</span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={simple.hour}
                  onChange={(e) => setSimple({ ...simple, hour: Number(e.target.value) })}
                  className="w-14 px-2 py-1 bg-px-bg border-2 border-px-border"
                />
                <span>:</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={simple.minute}
                  onChange={(e) => setSimple({ ...simple, minute: Number(e.target.value) })}
                  className="w-14 px-2 py-1 bg-px-bg border-2 border-px-border"
                />
              </div>
            )}
            {simple.kind === 'hourly' && (
              <div className="flex items-center gap-2 font-game text-[12px] text-px-text">
                <span>每</span>
                <input
                  type="number"
                  min={1}
                  max={23}
                  value={simple.everyNHours}
                  onChange={(e) => setSimple({ ...simple, everyNHours: Number(e.target.value) })}
                  className="w-14 px-2 py-1 bg-px-bg border-2 border-px-border"
                />
                <span>小时（每天 0:00 起算）</span>
              </div>
            )}
          </div>
        ) : (
          <input
            type="text"
            value={advancedExpr}
            onChange={(e) => setAdvancedExpr(e.target.value)}
            maxLength={200}
            className="w-full px-2 py-1 bg-px-bg-sec border-2 border-px-border font-mono text-[12px] text-px-text"
            placeholder="如：0 9 * * *"
          />
        )}

        {/* cron 释义 + 下 3 次触发 */}
        <div className={`mt-2 p-2 border-2 ${cronDescription.ok ? 'border-px-border bg-px-bg-sec' : 'border-red-500/50 bg-red-500/10'}`}>
          <div className={`font-game text-[11px] ${cronDescription.ok ? 'text-px-primary' : 'text-red-400'}`}>
            {cronDescription.ok ? `→ ${cronDescription.text}` : `× ${cronDescription.text}`}
          </div>
          {cronDescription.ok && nextRuns.length > 0 && (
            <div className="font-game text-[10px] text-px-text-sec mt-1">
              下 3 次触发：{nextRuns.map(fmtLocalTime).join('  /  ')}
            </div>
          )}
        </div>
      </div>

      <div>
        <label className="font-game text-[11px] text-px-text-sec block mb-1">时区（IANA）</label>
        <input
          type="text"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          maxLength={64}
          className="w-full px-2 py-1 bg-px-bg-sec border-2 border-px-border font-game text-[12px] text-px-text"
          placeholder="Asia/Shanghai"
        />
      </div>

      <div>
        <label className="font-game text-[11px] text-px-text-sec block mb-1">提示词内容</label>
        <textarea
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          maxLength={8000}
          rows={4}
          className="w-full px-2 py-1 bg-px-bg-sec border-2 border-px-border font-game text-[12px] text-px-text"
          placeholder="触发时发送给分身的消息，如：写一句今日的早安祝福"
        />
      </div>

      <div>
        <label className="font-game text-[11px] text-px-text-sec block mb-1">对话 ID（可选，留空则每次新建对话）</label>
        <input
          type="text"
          value={conversationId}
          onChange={(e) => setConversationId(e.target.value)}
          maxLength={200}
          className="w-full px-2 py-1 bg-px-bg-sec border-2 border-px-border font-mono text-[11px] text-px-text"
          placeholder="conv_..."
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          id="schedule-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <label htmlFor="schedule-enabled" className="font-game text-[12px] text-px-text">启用</label>
      </div>

      <div className="flex gap-2 pt-2">
        <button
          onClick={handleSave}
          className="px-4 py-1.5 bg-px-primary text-px-bg font-game text-[12px] border-2 border-px-primary"
        >
          {isCreating ? '创建' : '保存'}
        </button>
        {!isCreating && selectedId && (
          <button
            onClick={() => { setIsCreating(false); setSelectedId(null); resetForm() }}
            className="px-4 py-1.5 bg-px-bg-sec text-px-text-sec font-game text-[12px] border-2 border-px-border"
          >
            取消选择
          </button>
        )}
        {isCreating && (
          <button
            onClick={() => { setIsCreating(false) }}
            className="px-4 py-1.5 bg-px-bg-sec text-px-text-sec font-game text-[12px] border-2 border-px-border"
          >
            取消
          </button>
        )}
      </div>
    </div>
  )

  const renderRuns = (row: ScheduleRow) => (
    <div className="mt-4 border-t-2 border-px-border pt-3">
      <div className="flex items-center justify-between mb-2">
        <span className="font-game text-[12px] text-px-primary">触发历史（最近 100 条）</span>
        <div className="flex gap-2">
          <button
            onClick={() => { void handleTriggerNow(row) }}
            className="px-2 py-1 bg-px-bg-sec text-px-text font-game text-[11px] border-2 border-px-border hover:border-px-primary"
          >
            ▶ 立即触发
          </button>
          <button
            onClick={() => { void handleToggleEnabled(row) }}
            className="px-2 py-1 bg-px-bg-sec text-px-text font-game text-[11px] border-2 border-px-border hover:border-px-primary"
          >
            {row.enabled === 1 ? '⏸ 停用' : '▶ 启用'}
          </button>
          <button
            onClick={() => { void handleDelete(row.id) }}
            className="px-2 py-1 bg-red-500/20 text-red-400 font-game text-[11px] border-2 border-red-500/50 hover:bg-red-500/30"
          >
            ✕ 删除
          </button>
        </div>
      </div>
      {runs.length === 0 ? (
        <div className="font-game text-[11px] text-px-text-sec p-3 border-2 border-px-border bg-px-bg-sec text-center">
          暂无触发记录
        </div>
      ) : (
        <div className="max-h-[260px] overflow-y-auto">
          {runs.map((r) => (
            <div key={r.id} className="p-2 mb-1 border-2 border-px-border bg-px-bg-sec font-game text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-px-text">{fmtLocalTime(r.fired_at_utc)}</span>
                <span className={`px-2 py-0.5 ${
                  r.status === 'success' ? 'bg-px-primary/20 text-px-primary'
                  : r.status === 'failed' ? 'bg-red-500/20 text-red-400'
                  : r.status === 'running' ? 'bg-yellow-500/20 text-yellow-400'
                  : 'bg-gray-500/20 text-gray-400'
                }`}>
                  {STATUS_LABEL[r.status]}
                </span>
              </div>
              {r.conversation_id && (
                <div className="text-px-text-sec mt-1 truncate">对话：{r.conversation_id}</div>
              )}
              {r.duration_ms !== null && r.duration_ms !== undefined && (
                <div className="text-px-text-sec mt-1">耗时：{(r.duration_ms / 1000).toFixed(1)}s</div>
              )}
              {r.error_message && (
                <div className="text-red-400 mt-1 break-words">错误：{r.error_message}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )

  // ─── 渲染 ────────────────────────────────────────────────────────────────
  const selectedRow = selectedId ? schedules.find((s) => s.id === selectedId) : null

  return (
    <div className="fixed inset-0 z-50 bg-px-bg flex flex-col">
      <PanelHeader
        title="定时任务"
        subtitle={`${schedules.length} 项 · ${avatarId}`}
        onClose={onClose}
        actions={
          <button
            onClick={() => { setIsCreating(true); setSelectedId(null) }}
            className="px-3 py-1 bg-px-primary text-px-bg font-game text-[11px] border-2 border-px-primary"
          >
            + 新建
          </button>
        }
      />

      <div className="flex-1 overflow-hidden flex">
        {/* 左栏：列表 */}
        <div className="w-[320px] border-r-2 border-px-border overflow-y-auto p-3 bg-px-bg">
          {schedules.length === 0 ? (
            <div className="font-game text-[12px] text-px-text-sec p-3 border-2 border-px-border bg-px-bg-sec text-center">
              暂无定时任务，点击右上角「+ 新建」创建
            </div>
          ) : (
            schedules.map(renderListItem)
          )}
        </div>

        {/* 右栏：表单 / 详情 */}
        <div className="flex-1 overflow-y-auto p-4 bg-px-bg">
          {!isCreating && !selectedRow && (
            <div className="font-game text-[12px] text-px-text-sec p-6 text-center">
              从左侧选择一项以查看与编辑，或点击右上角「+ 新建」
            </div>
          )}
          {(isCreating || selectedRow) && renderForm()}
          {!isCreating && selectedRow && renderRuns(selectedRow)}
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 bg-px-bg border-2 border-px-primary font-game text-[12px] text-px-text shadow-pixel-glow">
          {toast}
        </div>
      )}
    </div>
  )
}
