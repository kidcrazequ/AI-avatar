/**
 * @file LifeEpisodeViewer.tsx — 单事件正文 + 元数据 + 遗忘曲线 + 删除入口
 *
 * 渲染流：
 *   1. 顶部 meta：[X 岁 · YYYY.MM]、标题、分类、情感、状态徽章；
 *   2. 中部 markdown 正文（用 react-markdown + prose-pixel）；
 *   3. 底部：遗忘曲线条形图 + AI 复盘理由 + 删除按钮（二次确认）；
 *   4. selected 切换时取消上一次 fetch（seqRef 防竞态，同 MemoryPanel:32）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { estimateMemoryStrength } from '../../services/life-service'

interface Props {
  avatarId: string
  /** 当前选中的 timeline 条目；为 null 时显示"请从时间轴选择事件" */
  selected: LifeTimelineEntry | null
  /** 分身当前岁数（取自 manifest.currentAgeMonths/12），用于估算遗忘强度 */
  currentAgeYears: number
  /** 删除事件成功后回调 */
  onDeleted: (episodeId: string) => void
  /** 共享 Toast */
  onToast: (message: string, type?: 'success' | 'error') => void
}

const STATUS_LABEL: Record<LifeConsolidationStatus, string> = {
  remembered: '◆ 关键瞬间（永久记得）',
  blurred: '◇ 已模糊（留下气味）',
  forgotten: '○ 已淡忘',
}

const CATEGORY_LABEL: Record<LifeEventCategory, string> = {
  formative: '塑造',
  daily: '日常',
  trauma: '创伤',
  joy: '喜悦',
  professional: '专业',
  loss: '失去',
}

const EMOTION_LABEL: Record<LifeEmotionType, string> = {
  joy: '喜悦',
  sorrow: '悲伤',
  anger: '愤怒',
  fear: '恐惧',
  wonder: '惊奇',
  shame: '羞愧',
  love: '爱',
}

export default function LifeEpisodeViewer({
  avatarId, selected, currentAgeYears, onDeleted, onToast,
}: Props) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const loadSeqRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const loadEpisode = useCallback(async (id: string) => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    setContent('')
    try {
      const text = await window.electronAPI.life.readEpisode(avatarId, id)
      if (loadSeqRef.current !== seq || !mountedRef.current) return
      setContent(text ?? '（事件正文文件不存在或已被删除）')
    } catch (err) {
      if (loadSeqRef.current !== seq || !mountedRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      console.error('[LifeEpisodeViewer] 读取事件失败:', err)
      window.electronAPI.logEvent('error', 'life-read-episode-error', `${id}: ${message}`)
      setContent('（读取失败，详见日志）')
      onToast('读取事件失败：' + message, 'error')
    } finally {
      if (loadSeqRef.current === seq && mountedRef.current) setLoading(false)
    }
  }, [avatarId, onToast])

  useEffect(() => {
    setConfirmDelete(false)
    if (!selected) {
      setContent('')
      return
    }
    loadEpisode(selected.id)
  }, [selected, loadEpisode])

  const handleDelete = async () => {
    if (!selected || isDeleting) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setIsDeleting(true)
    try {
      await window.electronAPI.life.deleteEpisode(avatarId, selected.id)
      if (!mountedRef.current) return
      onToast(`已删除事件「${selected.title}」`, 'success')
      onDeleted(selected.id)
      setConfirmDelete(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[LifeEpisodeViewer] 删除事件失败:', err)
      window.electronAPI.logEvent('error', 'life-delete-episode-error', `${selected.id}: ${message}`)
      if (mountedRef.current) onToast('删除失败：' + message, 'error')
    } finally {
      if (mountedRef.current) setIsDeleting(false)
    }
  }

  if (!selected) {
    return (
      <div className="flex-1 flex items-center justify-center bg-px-surface">
        <div className="text-center">
          <div className="w-12 h-12 border-2 border-px-border-dim flex items-center justify-center mx-auto mb-3">
            <span className="font-game text-[14px] text-px-text-dim">❀</span>
          </div>
          <p className="font-game text-[13px] text-px-text-dim tracking-wider">
            从左侧时间轴选择一个事件
          </p>
        </div>
      </div>
    )
  }

  const monthStr = selected.month.toString().padStart(2, '0')
  const strengthPct = estimateMemoryStrength(selected, currentAgeYears)
  const ageGap = Math.max(0, currentAgeYears - selected.age)

  // 像素进度条：每格 5%，共 20 格
  const filledCells = Math.round(strengthPct / 5)
  const totalCells = 20

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-px-surface">
      {/* 顶部 meta */}
      <div className="flex-shrink-0 px-6 py-4 bg-px-elevated border-b-2 border-px-border">
        <div className="font-game text-[12px] text-px-primary tracking-widest mb-2">
          [{selected.age} 岁 · {selected.year}.{monthStr}]
        </div>
        <h3 className="font-game text-[18px] text-px-text font-bold tracking-wider mb-2">
          {selected.title}
        </h3>
        {selected.summary && (
          <p className="font-game text-[12px] text-px-text-sec tracking-wider leading-relaxed">
            {selected.summary}
          </p>
        )}
      </div>

      {/* 正文 */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <span className="font-game text-[12px] text-px-text-dim tracking-wider">LOADING...</span>
          </div>
        ) : content ? (
          <div className="prose prose-sm prose-invert max-w-none prose-pixel font-body
            prose-headings:font-game prose-headings:font-bold prose-headings:text-px-text prose-headings:tracking-wider
            prose-p:text-px-text-sec prose-p:leading-[1.85] prose-p:text-[14px] prose-p:font-body
            prose-strong:text-px-text prose-strong:font-bold
            prose-blockquote:text-px-text-dim prose-blockquote:border-l-px-primary
            prose-li:text-px-text-sec prose-li:marker:text-px-primary prose-li:font-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        ) : (
          <p className="font-game text-[12px] text-px-text-dim tracking-wider">（无正文）</p>
        )}
      </div>

      {/* 底部 meta + 遗忘曲线 + 删除 */}
      <div className="flex-shrink-0 px-6 py-4 bg-px-bg border-t-2 border-px-border">
        {/* 标签行 */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="font-game text-[11px] text-px-text-dim tracking-wider">分类</span>
          <span className="font-game text-[11px] px-2 py-0.5 bg-px-elevated border border-px-border-dim text-px-text">
            {CATEGORY_LABEL[selected.category] ?? selected.category}
          </span>
          {selected.themes.length > 0 && (
            <>
              <span className="font-game text-[11px] text-px-text-dim tracking-wider ml-2">主题</span>
              {selected.themes.map(t => (
                <span key={t} className="font-game text-[11px] px-2 py-0.5 bg-px-elevated border border-px-border-dim text-px-text-sec">
                  {t}
                </span>
              ))}
            </>
          )}
        </div>

        {/* 情感 + 重要性 + 状态 */}
        <div className="flex items-center gap-4 mb-3 flex-wrap">
          <span className="font-game text-[11px] text-px-text-dim tracking-wider">
            情感：<span className="text-px-text">{EMOTION_LABEL[selected.emotionType] ?? selected.emotionType}</span> ({selected.emotion})
          </span>
          <span className="font-game text-[11px] text-px-text-dim tracking-wider">
            重要性：<span className="text-px-text">{selected.importance}/10</span>
          </span>
          <span className={`font-game text-[11px] tracking-wider ${
            selected.consolidationStatus === 'remembered' ? 'text-px-primary' :
            selected.consolidationStatus === 'blurred' ? 'text-yellow-400' :
            'text-px-text-dim'
          }`}>
            状态：{STATUS_LABEL[selected.consolidationStatus]}
          </span>
        </div>

        {/* AI 复盘理由 */}
        {selected.consolidationNote && (
          <div className="mb-3 px-3 py-2 bg-px-elevated border-l-2 border-px-primary">
            <div className="font-game text-[11px] text-px-primary tracking-wider mb-1">AI 复盘</div>
            <p className="font-game text-[12px] text-px-text-sec leading-relaxed">
              {selected.consolidationNote}
            </p>
          </div>
        )}

        {/* 遗忘曲线 */}
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="font-game text-[11px] text-px-text-dim tracking-wider">遗忘曲线</span>
            <span className="font-game text-[11px] text-px-text-dim tracking-wider">
              {strengthPct}% 强度（{ageGap > 0 ? `${ageGap} 年后` : '当前'}）
            </span>
          </div>
          <div className="flex gap-0.5">
            {Array.from({ length: totalCells }, (_, i) => (
              <div
                key={i}
                className={`flex-1 h-2 ${
                  i < filledCells
                    ? selected.consolidationStatus === 'remembered'
                      ? 'bg-px-primary'
                      : selected.consolidationStatus === 'blurred'
                      ? 'bg-yellow-400'
                      : 'bg-px-text-dim'
                    : 'bg-px-border-dim'
                }`}
              />
            ))}
          </div>
        </div>

        {/* 删除按钮（二次确认） */}
        <div className="flex justify-end gap-2">
          {confirmDelete ? (
            <>
              <span className="font-game text-[11px] text-yellow-400 tracking-wider self-center mr-2">
                确定删除？删除后会触发后续重新生成
              </span>
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={isDeleting}
                className="pixel-btn-outline-muted py-1 text-[11px] disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="pixel-btn-danger py-1 text-[11px] disabled:opacity-50"
              >
                {isDeleting ? '...' : '确认删除'}
              </button>
            </>
          ) : (
            <button
              onClick={handleDelete}
              className="pixel-btn-outline-muted py-1 text-[11px]"
              title="删除此事件（不会自动重新生成，下次 cron 推进时密度可能补回）"
            >
              [×] 删除事件
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
