/**
 * @file LifePanel.tsx — AI 分身「人生经历」主面板
 *
 * 状态机（5 态，由 deriveLifePanelMode 集中决策）：
 *   - no-life      manifest = null → 显示「立即为分身设计一场人生」入口
 *   - generating   生成中 → 显示进度条 + 取消按钮 + 已完成事件列表
 *   - failed       生成失败 → 显示错误 + 重试按钮
 *   - ready        complete → 完整时间轴 + 事件详情 + 工具栏
 *   - growing      growing → 同 ready，但顶栏标识"持续生长中"
 *
 * 实时刷新：订阅 life:progress 事件（仅当前 avatarId）。
 *
 * 错误处理（react-renderer.mdc 强约束）：
 *   - 所有 IPC 调用 try/catch + Toast + window.electronAPI.logEvent
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'
import LifeTimeline from './life/LifeTimeline'
import LifeEpisodeViewer from './life/LifeEpisodeViewer'
import LifeTimeScaleModal from './life/LifeTimeScaleModal'
import {
  loadLifeBundle,
  subscribeLifeProgress,
  formatNextGrowthEta,
  formatTimeScaleLabel,
  formatAgeFromMonths,
  countRemembered,
  deriveLifePanelMode,
  computeProgressPercent,
  type LifeBundle,
  type LifePanelMode,
  type LifeTimeScale,
  VALID_TIME_SCALES,
} from '../services/life-service'

interface Props {
  avatarId: string
  /** 用于显示给用户的分身名（manifest.personaName 可能不同） */
  avatarName: string
  /** 是否已配置 chat_api_key（缺失则禁用启动按钮） */
  hasChatApiKey: boolean
  /** creation_api_key 是否已配置（缺失时显示黄色 fallback 提示） */
  hasCreationApiKey: boolean
  /** 关闭面板 */
  onClose: () => void
  /** 共享 Toast */
  onToast: (message: string, type?: 'success' | 'error') => void
  /** 用户点击"去设置"链接时的回调 */
  onOpenSettings: () => void
}

export default function LifePanel({
  avatarId, avatarName, hasChatApiKey, hasCreationApiKey,
  onClose, onToast, onOpenSettings,
}: Props) {
  const [bundle, setBundle] = useState<LifeBundle | null>(null)
  const [bundleError, setBundleError] = useState<string>('')
  const [loadingBundle, setLoadingBundle] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showTimeScaleModal, setShowTimeScaleModal] = useState(false)
  const [showConsolidated, setShowConsolidated] = useState(false)
  const [showStartForm, setShowStartForm] = useState(false)
  const [actionBusy, setActionBusy] = useState<'' | 'pause' | 'resume' | 'cancel' | 'restart'>('')
  const [tickNow, setTickNow] = useState(() => new Date())  // 倒计时 tick
  const mountedRef = useRef(true)
  const loadSeqRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 每分钟刷一下倒计时显示（避免每秒 setState 造成性能浪费）
  useEffect(() => {
    const id = setInterval(() => {
      if (mountedRef.current) setTickNow(new Date())
    }, 60 * 1000)
    return () => clearInterval(id)
  }, [])

  const refreshBundle = useCallback(async () => {
    if (!avatarId) return
    const seq = ++loadSeqRef.current
    setBundleError('')
    setLoadingBundle(true)
    try {
      const fresh = await loadLifeBundle(avatarId)
      if (loadSeqRef.current !== seq || !mountedRef.current) return
      setBundle(fresh)
    } catch (err) {
      if (loadSeqRef.current !== seq || !mountedRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      console.error('[LifePanel] 加载人生数据失败:', err)
      window.electronAPI.logEvent('error', 'life-load-bundle-error', message)
      setBundleError(message)
      onToast('读取人生数据失败：' + message, 'error')
    } finally {
      if (loadSeqRef.current === seq && mountedRef.current) setLoadingBundle(false)
    }
  }, [avatarId, onToast])

  useEffect(() => {
    refreshBundle()
  }, [refreshBundle])

  // 订阅 life:progress 实时刷新（仅本 avatarId）
  useEffect(() => {
    const unsub = subscribeLifeProgress(avatarId, (payload) => {
      if (!mountedRef.current) return
      let needRefreshManifest = false
      setBundle(prev => {
        if (!prev) {
          // 极早期：bundle 自身还没初始化（首次 loadBundle 还没回来）→ 也写一份 progress
          needRefreshManifest = true
          return { manifest: null, timeline: [], progress: payload.progress, consolidated: '' }
        }
        // 第一次拿到 progress 但 manifest 还是 null → 触发一次 refresh，把刚写好的 manifest 拉回来
        if (!prev.manifest) needRefreshManifest = true
        return { ...prev, progress: payload.progress }
      })
      // stage 跨过关键节点时回拉一次完整 bundle（manifest 字段会变）
      const stage = payload.progress.stage
      const stageJustChanged =
        stage === 'complete' ||
        stage === 'failed' ||
        stage === 'forgetting' ||
        stage === 'manifest' ||
        stage === 'outline'
      if (needRefreshManifest || stageJustChanged) {
        // 防止递归触发：异步触发，setBundle 完成后再 refresh
        setTimeout(() => { if (mountedRef.current) refreshBundle() }, 100)
      }
    })
    return () => unsub()
  }, [avatarId, refreshBundle])

  const mode: LifePanelMode = useMemo(
    () => deriveLifePanelMode(bundle?.manifest ?? null, bundle?.progress ?? null),
    [bundle?.manifest, bundle?.progress],
  )

  // 选中事件兜底：如果 selectedId 在 timeline 中已被删，自动清空
  const selectedEntry: LifeTimelineEntry | null = useMemo(() => {
    if (!bundle || !selectedId) return null
    return bundle.timeline.find(e => e.id === selectedId) ?? null
  }, [bundle, selectedId])

  /**
   * 乐观更新：在主进程首次推送 life:progress 之前先把 UI 切到 generating 态。
   * 关键：必须**同时**覆盖 progress.stage 和 manifest.generationStatus——
   * 否则 deriveLifePanelMode 的 "progress.stage='failed' / manifest.generationStatus='failed'"
   * 兜底会一直把 mode 死锁在 'failed'，看不到任何进度反馈。
   *
   * 真实进度到达后会自动覆盖此乐观值。
   */
  const applyOptimisticGenerating = useCallback((usedFallback: boolean) => {
    const optimisticProgress: LifeProgress = {
      stage: 'manifest',
      completedEpisodes: 0,
      totalEpisodes: 0,
      failedEpisodes: [],
      usedFallback,
      lastError: '',
      updatedAt: new Date().toISOString(),
      consolidationLastTotalEpisodes: 0,
    }
    setBundle(prev => {
      if (!prev) {
        return { manifest: null, timeline: [], progress: optimisticProgress, consolidated: '' }
      }
      const nextManifest: LifeManifest | null = prev.manifest
        ? { ...prev.manifest, generationStatus: 'generating' as LifeGenerationStatus }
        : null
      return { ...prev, manifest: nextManifest, progress: optimisticProgress }
    })
  }, [])

  // 工具栏：开始 / 重启
  const handleStartGeneration = async (currentAge: number, timeScale: LifeTimeScale, growthEnabled: boolean, extraHints: string) => {
    if (!hasChatApiKey) {
      onToast('请先在「设置」中配置对话模型 API Key', 'error')
      return
    }
    setActionBusy('restart')
    try {
      const result = await window.electronAPI.life.startGeneration(avatarId, {
        avatarName,
        currentAge,
        timeScale,
        growthEnabled,
        extraHints,
      })
      if (!mountedRef.current) return
      setShowStartForm(false)
      onToast(
        result.usedFallback
          ? '已开始为分身生成人生（使用对话模型 fallback）'
          : '已开始为分身生成人生',
        'success',
      )
      applyOptimisticGenerating(result.usedFallback)
      // 仍然 refresh 一次（拉首次 IO 写出的 manifest，可能 1-3 秒后才到位，
      // 这里失败也无妨——progress 推送会兜底）
      await refreshBundle()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[LifePanel] 启动生成失败:', err)
      window.electronAPI.logEvent('error', 'life-start-generation-error', message)
      if (mountedRef.current) onToast('启动生成失败：' + message, 'error')
    } finally {
      if (mountedRef.current) setActionBusy('')
    }
  }

  const handleCancelGeneration = async () => {
    setActionBusy('cancel')
    try {
      const result = await window.electronAPI.life.cancelGeneration(avatarId)
      if (!mountedRef.current) return
      onToast(result.cancelled ? '已取消生成' : '当前没有正在生成的任务', 'success')
      await refreshBundle()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[LifePanel] 取消生成失败:', err)
      window.electronAPI.logEvent('error', 'life-cancel-generation-error', message)
      if (mountedRef.current) onToast('取消失败：' + message, 'error')
    } finally {
      if (mountedRef.current) setActionBusy('')
    }
  }

  const handleRetry = async () => {
    if (!bundle?.manifest) return
    setActionBusy('restart')
    try {
      const initialAge = Math.max(3, Math.min(65, bundle.manifest.initialAge))
      const ts = bundle.manifest.timeScale
      const validTs: LifeTimeScale = (VALID_TIME_SCALES as readonly number[]).includes(ts)
        ? (ts as LifeTimeScale)
        : 1
      const result = await window.electronAPI.life.retryGeneration(avatarId, {
        avatarName,
        currentAge: initialAge,
        timeScale: validTs,
        growthEnabled: bundle.manifest.growthEnabled,
        extraHints: '',
      })
      if (!mountedRef.current) return
      onToast('已重新启动生成（断点续传）', 'success')
      // 关键：retry 时 manifest.generationStatus 残留 'failed' + progress.stage 残留 'failed'
      // 会让 deriveLifePanelMode 死锁在 FailedView。乐观更新立即破除死锁。
      applyOptimisticGenerating(result.usedFallback)
      await refreshBundle()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[LifePanel] 重新生成失败:', err)
      window.electronAPI.logEvent('error', 'life-retry-generation-error', message)
      if (mountedRef.current) onToast('重新生成失败：' + message, 'error')
    } finally {
      if (mountedRef.current) setActionBusy('')
    }
  }

  const handleToggleGrowth = async () => {
    if (!bundle?.manifest) return
    const newEnabled = !bundle.manifest.growthEnabled
    setActionBusy(newEnabled ? 'resume' : 'pause')
    try {
      await window.electronAPI.life.toggleGrowth(avatarId, newEnabled)
      if (!mountedRef.current) return
      onToast(newEnabled ? '已恢复持续生长' : '已暂停持续生长', 'success')
      await refreshBundle()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[LifePanel] 切换生长开关失败:', err)
      window.electronAPI.logEvent('error', 'life-toggle-growth-error', message)
      if (mountedRef.current) onToast('切换失败：' + message, 'error')
    } finally {
      if (mountedRef.current) setActionBusy('')
    }
  }

  const handleEpisodeDeleted = (deletedId: string) => {
    if (!bundle) return
    setSelectedId(prev => (prev === deletedId ? null : prev))
    // 直接从本地 bundle 摘掉，避免重读 IPC 时的瞬时空白
    setBundle({
      ...bundle,
      timeline: bundle.timeline.filter(e => e.id !== deletedId),
    })
    // 异步刷新（拉一次最新的 manifest.totalEpisodes 等）
    refreshBundle()
  }

  // ─── 各 mode 的子标题文案 ────────────────────────────────────────
  const subtitle = useMemo(() => {
    if (!bundle?.manifest) return avatarId
    const m = bundle.manifest
    const ageStr = formatAgeFromMonths(m.currentAgeMonths)
    const remembered = countRemembered(bundle.timeline)
    return `${m.personaName || avatarName} · ${ageStr} · ${m.totalEpisodes} 事件 · 还记得 ${remembered} 件`
  }, [bundle, avatarName, avatarId])

  // ─── 渲染入口 ────────────────────────────────────────────────────
  return (
    <Modal isOpen={true} onClose={onClose} size="lg">
      <PanelHeader
        title="LIFE / 人生"
        subtitle={subtitle}
        onClose={onClose}
      />

      {/* fallback 黄色提示（creationModel 缺失） */}
      {!hasCreationApiKey && (
        <div className="flex-shrink-0 px-4 py-2 bg-yellow-400/10 border-b-2 border-yellow-400/40 flex items-center justify-between gap-3">
          <span className="font-game text-[11px] text-yellow-400 tracking-wider">
            ⚠ 创作模型未配置，将使用对话模型生成人生事件
          </span>
          <button
            onClick={onOpenSettings}
            className="font-game text-[11px] text-yellow-400 underline hover:text-yellow-300 tracking-wider whitespace-nowrap"
          >
            → 去设置配置
          </button>
        </div>
      )}

      {/* 副子标题：生长状态 */}
      {bundle?.manifest && (mode === 'ready' || mode === 'growing') && (
        <div className="flex-shrink-0 px-4 py-2 bg-px-elevated border-b-2 border-px-border-dim flex items-center justify-between gap-3">
          <span className="font-game text-[11px] text-px-text-dim tracking-wider">
            下次生长：{formatNextGrowthEta(
              bundle.manifest.lastAdvancedAt,
              bundle.manifest.timeScale,
              bundle.manifest.growthEnabled,
              bundle.manifest.generationStatus,
              tickNow,
            )}
          </span>
          <span className="font-game text-[11px] text-px-text-dim tracking-wider">
            {formatTimeScaleLabel(bundle.manifest.timeScale)}
            {mode === 'growing' && <span className="ml-2 text-px-primary">● 持续生长中</span>}
          </span>
        </div>
      )}

      {/* 主体（按 mode 切换） */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {loadingBundle && !bundle ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="font-game text-[12px] text-px-text-dim tracking-wider">LOADING...</span>
          </div>
        ) : bundleError ? (
          <ErrorView message={bundleError} onRetry={refreshBundle} />
        ) : mode === 'no-life' ? (
          showStartForm ? (
            <LifeStartForm
              avatarName={avatarName}
              hasChatApiKey={hasChatApiKey}
              busy={actionBusy === 'restart'}
              onCancel={() => setShowStartForm(false)}
              onSubmit={handleStartGeneration}
            />
          ) : (
            <NoLifeView
              avatarName={avatarName}
              onStart={() => setShowStartForm(true)}
              hasChatApiKey={hasChatApiKey}
              onOpenSettings={onOpenSettings}
            />
          )
        ) : mode === 'generating' ? (
          <GeneratingView
            progress={bundle?.progress ?? null}
            manifest={bundle?.manifest ?? null}
            onCancel={handleCancelGeneration}
            cancelBusy={actionBusy === 'cancel'}
          />
        ) : mode === 'failed' ? (
          <FailedView
            progress={bundle?.progress ?? null}
            onRetry={handleRetry}
            retryBusy={actionBusy === 'restart'}
          />
        ) : (
          // ready or growing
          <ReadyView
            bundle={bundle as LifeBundle}
            avatarId={avatarId}
            selectedEntry={selectedEntry}
            onSelect={(e) => setSelectedId(e.id)}
            onEpisodeDeleted={handleEpisodeDeleted}
            onToast={onToast}
            onOpenTimeScale={() => setShowTimeScaleModal(true)}
            onOpenConsolidated={() => setShowConsolidated(true)}
            onToggleGrowth={handleToggleGrowth}
            onRestart={handleRetry}
            actionBusy={actionBusy}
          />
        )}
      </div>

      {/* 子模态：时间速度 */}
      {showTimeScaleModal && bundle?.manifest && (
        <LifeTimeScaleModal
          avatarId={avatarId}
          manifest={bundle.manifest}
          onClose={() => setShowTimeScaleModal(false)}
          onApplied={refreshBundle}
          onToast={onToast}
        />
      )}

      {/* 子模态：完整复盘 consolidated.md */}
      {showConsolidated && bundle && (
        <ConsolidatedView
          content={bundle.consolidated}
          onClose={() => setShowConsolidated(false)}
        />
      )}
    </Modal>
  )
}

// ─── 子组件：错误态 ─────────────────────────────────────────────────────────
function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-px-bg p-8">
      <div className="text-center max-w-md">
        <div className="w-12 h-12 border-2 border-px-danger bg-px-danger/10 flex items-center justify-center mx-auto mb-4">
          <span className="text-px-danger font-game text-[14px]">!</span>
        </div>
        <p className="font-game text-[13px] text-px-danger tracking-wider mb-2">读取失败</p>
        <p className="font-game text-[12px] text-px-text-dim mb-4 break-all">{message}</p>
        <button onClick={onRetry} className="pixel-btn-primary py-2">重试</button>
      </div>
    </div>
  )
}

// ─── 子组件：尚未生成态 ─────────────────────────────────────────────────────
function NoLifeView({
  avatarName, onStart, hasChatApiKey, onOpenSettings,
}: { avatarName: string; onStart: () => void; hasChatApiKey: boolean; onOpenSettings: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-px-bg p-8">
      <div className="text-center max-w-lg">
        <div className="w-16 h-16 border-2 border-px-primary bg-px-primary/10 flex items-center justify-center mx-auto mb-5">
          <span className="text-px-primary font-game text-[24px]">❀</span>
        </div>
        <h3 className="font-game text-[16px] text-px-text font-bold tracking-wider mb-3">
          还没有为「{avatarName}」设计人生
        </h3>
        <p className="font-game text-[12px] text-px-text-dim mb-6 leading-relaxed tracking-wider">
          点击下方开始，AI 会为分身想象一段从 0 岁到现在的完整人生，
          <br />
          根据遗忘机制筛选「还记得的关键瞬间」注入对话。
          <br />
          预计 80~100 个事件，5~10 分钟。
        </p>
        {hasChatApiKey ? (
          <button onClick={onStart} className="pixel-btn-primary px-6 py-3">
            [▶] 立即开始
          </button>
        ) : (
          <>
            <p className="font-game text-[12px] text-yellow-400 tracking-wider mb-3">
              ⚠ 请先配置对话模型 API Key
            </p>
            <button onClick={onOpenSettings} className="pixel-btn-outline-light px-6 py-3">
              → 去设置
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── 子组件：开始生成表单（简易版，Phase 4 创建向导是完整版） ─────────────
function LifeStartForm({
  avatarName, hasChatApiKey, busy, onCancel, onSubmit,
}: {
  avatarName: string
  hasChatApiKey: boolean
  busy: boolean
  onCancel: () => void
  onSubmit: (currentAge: number, timeScale: LifeTimeScale, growthEnabled: boolean, extraHints: string) => void
}) {
  const [currentAge, setCurrentAge] = useState(30)
  const [timeScale, setTimeScale] = useState<LifeTimeScale>(1)
  const [growthEnabled, setGrowthEnabled] = useState(true)
  const [extraHints, setExtraHints] = useState('')

  const ageInvalid = !Number.isFinite(currentAge) || currentAge < 3 || currentAge > 65
  const handleSubmit = () => {
    if (ageInvalid || busy) return
    onSubmit(currentAge, timeScale, growthEnabled, extraHints.trim())
  }

  return (
    <div className="flex-1 overflow-y-auto bg-px-surface px-8 py-6">
      <div className="max-w-xl mx-auto">
        <h3 className="font-game text-[16px] text-px-text font-bold tracking-wider mb-1">
          为「{avatarName}」设计人生
        </h3>
        <p className="font-game text-[12px] text-px-text-dim tracking-wider mb-6">
          填写参数后开始；过程会在后台运行，可关闭面板继续聊天
        </p>

        <div className="mb-5">
          <label className="block font-game text-[12px] text-px-text tracking-wider mb-2">
            分身现在的年龄
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={3}
              max={65}
              value={Number.isFinite(currentAge) ? currentAge : ''}
              onChange={e => setCurrentAge(parseInt(e.target.value, 10))}
              className="w-24 px-3 py-2 bg-px-bg border-2 border-px-border-dim font-game text-[14px] text-px-text focus:border-px-primary focus:outline-none"
            />
            <span className="font-game text-[12px] text-px-text-dim tracking-wider">岁（3 ~ 65）</span>
          </div>
          {ageInvalid && (
            <p className="font-game text-[11px] text-px-danger tracking-wider mt-1">年龄须在 3~65 之间</p>
          )}
        </div>

        <div className="mb-5">
          <label className="block font-game text-[12px] text-px-text tracking-wider mb-2">
            时间生长速度
          </label>
          <div className="space-y-2">
            {[
              { v: 1 as LifeTimeScale, label: '1× 真实同步（1 月 → 1 月，最自然）' },
              { v: 12 as LifeTimeScale, label: '12× 加速（1 月 → 1 年，快速看到分身长大）' },
              { v: 52 as LifeTimeScale, label: '52× 加速（1 周 → 1 年，仅适合短期实验）' },
              { v: 0 as LifeTimeScale, label: '冻结（不随真实时间生长）' },
            ].map(opt => (
              <label key={opt.v} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="initial-time-scale"
                  checked={timeScale === opt.v}
                  onChange={() => setTimeScale(opt.v)}
                  className="accent-px-primary"
                />
                <span className="font-game text-[12px] text-px-text-sec tracking-wider">{opt.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="mb-5">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={growthEnabled}
              onChange={e => setGrowthEnabled(e.target.checked)}
              className="accent-px-primary"
            />
            <span className="font-game text-[12px] text-px-text-sec tracking-wider">
              启用持续生长（cron 每天检查一次）
            </span>
          </label>
        </div>

        <div className="mb-6">
          <label className="block font-game text-[12px] text-px-text tracking-wider mb-2">
            额外要求（可选）
          </label>
          <textarea
            value={extraHints}
            onChange={e => setExtraHints(e.target.value)}
            rows={3}
            placeholder="例如：想让分身的人生有海外经历，专业起步早"
            className="w-full px-3 py-2 bg-px-bg border-2 border-px-border-dim font-body text-[13px] text-px-text focus:border-px-primary focus:outline-none resize-none"
          />
        </div>

        <div className="px-3 py-2 bg-px-bg border-2 border-px-border-dim mb-5">
          <p className="font-game text-[11px] text-px-text-dim tracking-wider leading-relaxed">
            ⓘ 预估：80~100 个事件 · 8~10 万字 · 5~10 分钟
            <br />
            ⓘ 后台运行，可关闭此面板继续对话；进度会随时刷新
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="pixel-btn-outline-muted py-2 disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={busy || ageInvalid || !hasChatApiKey}
            className="pixel-btn-primary py-2 disabled:opacity-50"
          >
            {busy ? '...' : '开始生成'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 子组件：生成中态 ───────────────────────────────────────────────────────
function GeneratingView({
  progress, manifest, onCancel, cancelBusy,
}: {
  progress: LifeProgress | null
  manifest: LifeManifest | null
  onCancel: () => void
  cancelBusy: boolean
}) {
  const pct = computeProgressPercent(progress)
  const stageLabel = (() => {
    if (!progress) return '准备中…'
    switch (progress.stage) {
      case 'manifest': return 'Stage 0：设计人生骨架'
      case 'outline': return 'Stage 1：列每个阶段的事件大纲'
      case 'episodes': return `Stage 2：逐事件生成传记（${progress.completedEpisodes}/${progress.totalEpisodes}）`
      case 'forgetting': return 'Stage 3：双重遗忘筛选 + AI 复盘'
      case 'complete': return '✓ 完成'
      case 'failed': return '✗ 失败'
      case 'growing': return '持续生长中'
      default: return '初始化中…'
    }
  })()

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-px-bg p-8">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-5">
          <div className="w-12 h-12 border-2 border-px-primary bg-px-primary/10 flex items-center justify-center mx-auto mb-3 animate-pulse">
            <span className="text-px-primary font-game text-[16px]">⏳</span>
          </div>
          <p className="font-game text-[13px] text-px-primary tracking-wider mb-1">人生生成中</p>
          <p className="font-game text-[11px] text-px-text-dim tracking-wider">{stageLabel}</p>
        </div>

        {/* 进度条 */}
        <div className="mb-3">
          <div className="flex justify-between mb-1">
            <span className="font-game text-[11px] text-px-text-dim tracking-wider">进度</span>
            <span className="font-game text-[11px] text-px-primary tracking-wider">{pct}%</span>
          </div>
          <div className="w-full h-3 bg-px-border-dim border-2 border-px-border overflow-hidden">
            <div
              className="h-full bg-px-primary transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* fallback 提示 */}
        {progress?.usedFallback && (
          <div className="mb-3 px-3 py-2 bg-yellow-400/10 border-2 border-yellow-400/40">
            <p className="font-game text-[11px] text-yellow-400 tracking-wider">
              ⚠ 创作模型未配置，正在使用对话模型 fallback 生成
            </p>
          </div>
        )}

        {/* manifest 摘要 */}
        {manifest && (
          <div className="px-3 py-2 bg-px-elevated border-2 border-px-border-dim mb-3">
            <p className="font-game text-[11px] text-px-text-dim tracking-wider">
              {manifest.personaName} · {manifest.birthYear} 年生 · {manifest.initialAge} 岁
            </p>
          </div>
        )}

        {/* 失败列表 */}
        {progress && progress.failedEpisodes.length > 0 && (
          <div className="px-3 py-2 bg-px-elevated border-2 border-px-danger/40 mb-3">
            <p className="font-game text-[11px] text-px-danger tracking-wider mb-1">
              ⚠ {progress.failedEpisodes.length} 个事件生成失败（不影响其他）
            </p>
          </div>
        )}

        <div className="flex justify-center gap-2 mt-5">
          <button onClick={onCancel} disabled={cancelBusy} className="pixel-btn-outline-muted py-2 disabled:opacity-50">
            {cancelBusy ? '...' : '取消生成'}
          </button>
        </div>

        <p className="text-center mt-4 font-game text-[11px] text-px-text-dim tracking-wider">
          已落盘的事件不会丢失；可关闭面板继续对话
        </p>
      </div>
    </div>
  )
}

// ─── 子组件：失败态 ─────────────────────────────────────────────────────────
function FailedView({
  progress, onRetry, retryBusy,
}: { progress: LifeProgress | null; onRetry: () => void; retryBusy: boolean }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-px-bg p-8">
      <div className="text-center max-w-lg">
        <div className="w-12 h-12 border-2 border-px-danger bg-px-danger/10 flex items-center justify-center mx-auto mb-4">
          <span className="text-px-danger font-game text-[14px]">!</span>
        </div>
        <p className="font-game text-[13px] text-px-danger tracking-wider mb-2">人生生成失败</p>
        {progress?.lastError && (
          <p className="font-game text-[11px] text-px-text-dim mb-4 break-all leading-relaxed">
            {progress.lastError}
          </p>
        )}
        <p className="font-game text-[11px] text-px-text-dim mb-4 tracking-wider">
          已生成的 {progress?.completedEpisodes ?? 0} 个事件不会丢失；点击重试将断点续传
        </p>
        <button onClick={onRetry} disabled={retryBusy} className="pixel-btn-primary py-2 disabled:opacity-50">
          {retryBusy ? '...' : '↻ 重新生成'}
        </button>
      </div>
    </div>
  )
}

// ─── 子组件：就绪态（完整面板，timeline + 详情 + 工具栏） ─────────────────
function ReadyView({
  bundle, avatarId, selectedEntry, onSelect, onEpisodeDeleted, onToast,
  onOpenTimeScale, onOpenConsolidated, onToggleGrowth, onRestart, actionBusy,
}: {
  bundle: LifeBundle
  avatarId: string
  selectedEntry: LifeTimelineEntry | null
  onSelect: (entry: LifeTimelineEntry) => void
  onEpisodeDeleted: (id: string) => void
  onToast: (m: string, t?: 'success' | 'error') => void
  onOpenTimeScale: () => void
  onOpenConsolidated: () => void
  onToggleGrowth: () => void
  onRestart: () => void
  actionBusy: '' | 'pause' | 'resume' | 'cancel' | 'restart'
}) {
  const m = bundle.manifest
  if (!m) return null
  const currentAgeYears = m.currentAgeMonths / 12
  const failedCount = bundle.progress?.failedEpisodes.length ?? 0

  return (
    <>
      {/* 主体两栏：左 32% + 右 68%
          关键：每个内层 flex 子元素都要 min-h-0 + min-w-0，否则 flex 默认 min-size:auto
          会让子元素拒绝缩小到 < 内容尺寸，导致 overflow-* / truncate 全部失效（symptom：
          时间轴 footer LEGEND 与 list 重叠、右侧详情文字被裁切） */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className="w-[32%] min-w-[180px] max-w-[280px] flex min-h-0">
          <LifeTimeline
            timeline={bundle.timeline}
            selectedId={selectedEntry?.id ?? null}
            onSelect={onSelect}
            currentAgeMonths={m.currentAgeMonths}
            generationStatus={m.generationStatus}
            growthEnabled={m.growthEnabled}
          />
        </div>
        <div className="flex-1 flex min-h-0 min-w-0">
          <LifeEpisodeViewer
            avatarId={avatarId}
            selected={selectedEntry}
            currentAgeYears={currentAgeYears}
            onDeleted={onEpisodeDeleted}
            onToast={onToast}
          />
        </div>
      </div>

      {/* 底部工具栏 */}
      <div className="flex-shrink-0 flex items-center flex-wrap gap-2 px-4 py-3 bg-px-bg border-t-2 border-px-border">
        <span className="font-game text-[11px] text-px-text-dim tracking-wider mr-2">
          ✔ {m.totalEpisodes} 事件
          {failedCount > 0 && <span className="ml-2 text-px-danger">⚠ {failedCount} 失败</span>}
        </span>
        <div className="flex-1" />
        <button
          onClick={onToggleGrowth}
          disabled={actionBusy === 'pause' || actionBusy === 'resume'}
          className="pixel-btn-outline-muted py-1 text-[11px] disabled:opacity-50"
          title={m.growthEnabled ? '暂停后 cron 跳过该分身' : '恢复后 cron 会按 timeScale 推进'}
        >
          {m.growthEnabled ? '⏸ 暂停生长' : '▶ 恢复生长'}
        </button>
        <button
          onClick={onOpenTimeScale}
          className="pixel-btn-outline-muted py-1 text-[11px]"
        >
          ⚙ 时间速度
        </button>
        <button
          onClick={onOpenConsolidated}
          className="pixel-btn-outline-muted py-1 text-[11px]"
        >
          📜 复盘
        </button>
        <button
          onClick={onRestart}
          disabled={actionBusy === 'restart'}
          className="pixel-btn-outline-muted py-1 text-[11px] disabled:opacity-50"
          title="按当前年龄/速度重新生成（断点续传）"
        >
          {actionBusy === 'restart' ? '...' : '↻ 重新生成'}
        </button>
      </div>
    </>
  )
}

// ─── 子组件：完整复盘 consolidated.md 阅读器 ────────────────────────────────
function ConsolidatedView({ content, onClose }: { content: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-px-surface border-2 border-px-border shadow-pixel-glow w-[80vw] h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <PanelHeader title="CONSOLIDATED" subtitle="完整复盘 consolidated.md" onClose={onClose} />
        <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
          {content ? (
            <div className="prose prose-sm prose-invert max-w-none prose-pixel font-body
              prose-headings:font-game prose-headings:font-bold prose-headings:text-px-text prose-headings:tracking-wider
              prose-p:text-px-text-sec prose-p:leading-[1.85] prose-p:text-[14px] prose-p:font-body
              prose-strong:text-px-text prose-strong:font-bold
              prose-blockquote:text-px-text-dim prose-blockquote:border-l-px-primary
              prose-li:text-px-text-sec prose-li:marker:text-px-primary prose-li:font-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          ) : (
            <p className="font-game text-[13px] text-px-text-dim tracking-wider text-center mt-12">
              （复盘文件还不存在，等首次 reconsolidate 后生成）
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
