/**
 * @file LifeTimeScaleModal.tsx — 时间速度子模态（plan 4.3）
 *
 * 功能：
 *   1. 4 选 1 单选 timeScale：1× / 12× / 52× / 冻结（→ 0）；
 *   2. 显示当前模式 + 上次推进 + 「按新速度落后 X 月」预估；
 *   3. 应用按钮：先 setTimeScale → 再 advanceNow（catch-up）；
 *   4. 整个 advance 过程会同步阻塞 30s+，用 disabled overlay 防止用户误关。
 *
 * 错误处理（react-renderer.mdc）：
 *   - try/catch + onToast(message, 'error')
 *   - window.electronAPI.logEvent('error', ...)
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { useState, useEffect, useRef } from 'react'
import Modal from '../shared/Modal'
import PanelHeader from '../shared/PanelHeader'
import {
  VALID_TIME_SCALES,
  formatTimeScaleLabel,
  estimateBacklogMonths,
  formatAvatarMonths,
} from '../../services/life-service'

interface Props {
  /** 当前分身 ID（IPC 调用必须） */
  avatarId: string
  /** 当前 manifest（读 timeScale / lastAdvancedAt） */
  manifest: LifeManifest
  /** 关闭模态 */
  onClose: () => void
  /** 应用成功后回调（父组件刷新 manifest） */
  onApplied: () => void
  /** 共享 Toast；失败时调用 */
  onToast: (message: string, type?: 'success' | 'error') => void
}

const SCALE_OPTIONS: ReadonlyArray<{ value: number; label: string; hint: string }> = [
  { value: 1, label: '1× 真实同步', hint: '真实 1 月 → 分身 1 月（最自然）' },
  { value: 12, label: '12× 加速', hint: '真实 1 月 → 分身 1 年（快速看到分身长大）' },
  { value: 52, label: '52× 加速', hint: '真实 1 周 → 分身 1 年（仅适合短期实验）' },
  { value: 0, label: '冻结', hint: '不随真实时间生长' },
]

export default function LifeTimeScaleModal({ avatarId, manifest, onClose, onApplied, onToast }: Props) {
  const initialScale: number = VALID_TIME_SCALES.includes(manifest.timeScale as 0 | 1 | 12 | 52)
    ? manifest.timeScale
    : 1
  const [selectedScale, setSelectedScale] = useState<number>(initialScale)
  const [isApplying, setIsApplying] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 落后月数预估（仅在选项变化或挂载时算一次，避免每秒重渲染）
  const backlogMonths = estimateBacklogMonths(manifest.lastAdvancedAt, selectedScale)

  const handleApply = async () => {
    if (isApplying) return
    if (selectedScale === manifest.timeScale) {
      // 没改 → 直接关
      onClose()
      return
    }
    setIsApplying(true)
    setStatusMsg('正在应用新速度…')
    try {
      // Step 1: 落盘 timeScale
      await window.electronAPI.life.setTimeScale(avatarId, selectedScale)
      if (!mountedRef.current) return
      // Step 2: 立即 catch-up（plan 2.3 场景 C：调速后立即按新 scale 补齐落后事件）
      // 仅当新 scale > 0 且确实有落后时才推进；冻结模式跳过
      if (selectedScale > 0 && backlogMonths >= 1) {
        setStatusMsg(`正在按 ${selectedScale}× 补齐 ${backlogMonths} 个月…（可能耗时 30s+）`)
        const result = await window.electronAPI.life.advanceNow(avatarId)
        if (!mountedRef.current) return
        if (result.advanced) {
          onToast(`时间速度已应用，新增 ${result.newEpisodes} 个事件`, 'success')
        } else {
          onToast('时间速度已应用，未产生新事件', 'success')
        }
      } else {
        onToast('时间速度已应用', 'success')
      }
      onApplied()
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[LifeTimeScaleModal] 应用时间速度失败:', err)
      window.electronAPI.logEvent('error', 'life-set-time-scale-error', message)
      if (mountedRef.current) {
        onToast('应用失败：' + message, 'error')
        setStatusMsg('应用失败')
      }
    } finally {
      if (mountedRef.current) setIsApplying(false)
    }
  }

  return (
    <Modal isOpen={true} onClose={isApplying ? () => { /* 应用中禁止关闭 */ } : onClose} size="sm">
      <PanelHeader
        title="TIME SCALE"
        subtitle="时间生长速度"
        onClose={isApplying ? () => { /* 应用中禁止关闭 */ } : onClose}
      />

      <div className="flex-1 overflow-y-auto px-6 py-5 bg-px-surface">
        {/* 当前模式提示 */}
        <div className="mb-4 px-4 py-3 bg-px-bg border-2 border-px-border-dim">
          <div className="font-game text-[12px] text-px-text-dim tracking-wider mb-1">当前模式</div>
          <div className="font-game text-[14px] text-px-primary tracking-wider">
            {formatTimeScaleLabel(manifest.timeScale)}
          </div>
        </div>

        {/* 选项列表 */}
        <div className="space-y-2 mb-4">
          {SCALE_OPTIONS.map(opt => {
            const checked = selectedScale === opt.value
            return (
              <label
                key={opt.value}
                className={`flex items-start gap-3 px-4 py-3 border-2 cursor-pointer transition-none
                  ${checked
                    ? 'border-px-primary bg-px-primary/10'
                    : 'border-px-border-dim bg-px-surface hover:border-px-primary/60'
                  }
                  ${isApplying ? 'opacity-50 cursor-not-allowed' : ''}
                `}
              >
                <input
                  type="radio"
                  name="time-scale"
                  value={opt.value}
                  checked={checked}
                  onChange={() => setSelectedScale(opt.value)}
                  disabled={isApplying}
                  className="mt-1 accent-px-primary"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-game text-[14px] text-px-text font-bold tracking-wider">
                    {opt.label}
                  </div>
                  <div className="font-game text-[12px] text-px-text-dim mt-1 tracking-wider">
                    {opt.hint}
                  </div>
                </div>
                {checked && (
                  <span className="font-game text-[12px] text-px-primary tracking-wider self-center">●</span>
                )}
              </label>
            )
          })}
        </div>

        {/* 落后预估 */}
        <div className="mb-4 px-4 py-3 bg-px-bg border-2 border-px-border-dim">
          <div className="font-game text-[12px] text-px-text-dim tracking-wider mb-1">
            上次推进
          </div>
          <div className="font-game text-[12px] text-px-text-sec mb-3 break-all">
            {manifest.lastAdvancedAt}
          </div>
          {selectedScale > 0 && backlogMonths >= 1 ? (
            <>
              <div className="font-game text-[12px] text-px-text-dim tracking-wider mb-1">
                按 {selectedScale}× 计算落后
              </div>
              <div className="font-game text-[14px] text-yellow-400 tracking-wider">
                {formatAvatarMonths(backlogMonths)}
              </div>
              <div className="font-game text-[11px] text-px-text-dim mt-2 tracking-wider leading-relaxed">
                调整后将立即按新速度补齐落后事件
              </div>
            </>
          ) : selectedScale === 0 ? (
            <div className="font-game text-[12px] text-px-text-dim tracking-wider">
              冻结后不再生成新事件，但已有的人生不丢
            </div>
          ) : (
            <div className="font-game text-[12px] text-px-text-dim tracking-wider">
              暂无落后；调整后下次 cron 按新速度推进
            </div>
          )}
        </div>

        {statusMsg && (
          <div className="mb-3 px-4 py-2 bg-px-elevated border-2 border-px-border">
            <div className="font-game text-[12px] text-px-primary tracking-wider">{statusMsg}</div>
          </div>
        )}
      </div>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-end gap-2 px-6 py-3 bg-px-bg border-t-2 border-px-border">
        <button
          onClick={onClose}
          disabled={isApplying}
          className="pixel-btn-outline-muted py-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          取消
        </button>
        <button
          onClick={handleApply}
          disabled={isApplying}
          className="pixel-btn-primary py-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isApplying ? '...' : '应用'}
        </button>
      </div>
    </Modal>
  )
}
