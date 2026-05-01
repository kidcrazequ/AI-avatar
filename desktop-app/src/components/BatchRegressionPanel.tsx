/**
 * BatchRegressionPanel.tsx — 批量回归测试面板
 *
 * 功能：
 *   - 加载/生成题库（kb-question-generator 产出的 1063 题）
 *   - 一键运行：逐题在隔离会话里跑真实 chatStore 工作流
 *   - 实时镜像：右栏跟随当前题，显示助手消息 / 工具调用 / 任务清单
 *   - 跑完落盘报告（result.json + report.md + report.html）+ 自动清理临时会话
 *   - 历史 run 下拉，可一键打开 HTML 报告（系统浏览器）
 *
 * 三栏布局：
 *   左 (280px)  : 题库统计 + Case 列表（带状态徽章）
 *   中 (flex-1) : 实时镜像（当前 prompt / 助手消息 / 工具调用流 / 任务清单）
 *   右 (300px)  : 总进度 / 当前断言 / 历史 run / 操作按钮
 *
 * 关键设计：
 *   - 不嵌 ChatWindow：自渲染镜像样式更紧凑、避免输入框污染
 *   - sendMessage 适配器：先 ensureConversation → bindConversation → sendMessage
 *   - waitForIdle 适配器：轮询 chatStore.isLoading
 *   - LLM 根因分析直连 chatModel API（OpenAI 兼容协议）
 *   - 跑完调 cleanupConversations 删除所有 regression-{runId}-* 会话
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useShallow } from 'zustand/react/shallow'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'
import { fetchWithTimeout } from '@soul/core/browser'
import { useChatStore } from '../stores/chatStore'
import {
  runBatchRegression,
  type GeneratedQuestion,
  type CaseResult,
  type BatchRunResult,
  type BatchProgressEvent,
} from '../services/batch-regression-runner'
import {
  aggregateReport,
  requestRootCauseAnalysis,
  renderMarkdownReport,
  renderHtmlReport,
  type RootCauseAnalysis,
  type CallLLMFn,
} from '../services/batch-report-generator'

// ─── 类型 ──────────────────────────────────────────────────────────────

interface Props {
  avatarId: string
  avatarName?: string
  onClose: () => void
}

type RunState = 'idle' | 'loading-bank' | 'running' | 'finishing' | 'done' | 'cancelled' | 'error'

interface SavedReportPaths {
  resultJsonPath: string
  reportMdPath: string
  reportHtmlPath: string
}

// ─── Helper ────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<string, string> = {
  L1_excel_fact: 'Excel 单点',
  L2_excel_compare: 'Excel 对比',
  L3_excel_aggregate: 'Excel 聚合',
  L4_chart: '图表生成',
  L5_bom: 'BOM 物料',
  L6_protocol: '协议条款',
  L7_certification: '认证报告',
  L8_traceability: '溯源验证',
  L9_redline: '红线越界',
  L10_personality: '人格一致性',
}

function shortRunId(): string {
  // 浏览器原生 randomUUID（chromium 113+，Electron 25+ 内置）
  const uuid = globalThis.crypto?.randomUUID?.() ?? `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // 取前 8 字符做短 ID，避免目录名太长
  return uuid.replace(/-/g, '').slice(0, 12)
}

function fmtTimeShort(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtDurationShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return `${min}m${sec}s`
}

/** 简易 sleep，支持 abort */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
  })
}

// ─── 主组件 ────────────────────────────────────────────────────────────

export default function BatchRegressionPanel({ avatarId, avatarName, onClose }: Props) {
  // ── 状态 ──
  const [bank, setBank] = useState<RegressionQuestionBank | null>(null)
  const [bankCached, setBankCached] = useState(false)
  const [bankErr, setBankErr] = useState<string | null>(null)
  const [runState, setRunState] = useState<RunState>('idle')
  const [runErr, setRunErr] = useState<string | null>(null)
  const [currentRunId, setCurrentRunId] = useState<string | null>(null)
  const [currentCaseIdx, setCurrentCaseIdx] = useState(-1)
  const [currentConvId, setCurrentConvId] = useState<string | null>(null)
  const [caseResults, setCaseResults] = useState<CaseResult[]>([])
  const [historyRuns, setHistoryRuns] = useState<RegressionRunMeta[]>([])
  const [savedReport, setSavedReport] = useState<SavedReportPaths | null>(null)
  const [enableAiAnalysis, setEnableAiAnalysis] = useState(true)
  const [maxCasesOverride, setMaxCasesOverride] = useState<number>(0) // 0 = 全部
  const [aiAnalysisStatus, setAiAnalysisStatus] = useState<string>('')

  const abortControllerRef = useRef<AbortController | null>(null)
  const caseListRef = useRef<HTMLDivElement>(null)
  const isMountedRef = useRef(true)

  // ── chatStore 镜像订阅 ──
  // 只订阅当前题需要的字段，避免无关重渲染
  const { messages, isLoading, toolCallStatus, tasks, chatModel } = useChatStore(useShallow(s => ({
    messages: s.messages,
    isLoading: s.isLoading,
    toolCallStatus: s.toolCallStatus,
    tasks: s.tasks,
    chatModel: s.chatModel,
  })))

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      abortControllerRef.current?.abort()
    }
  }, [])

  // ── 初次加载题库 + 历史 ──
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setRunState('loading-bank')
      try {
        const [bankRes, runs] = await Promise.all([
          window.electronAPI.regressionLoadOrGenerateBank(avatarId),
          window.electronAPI.regressionListRuns(avatarId),
        ])
        if (cancelled) return
        setBank(bankRes.bank)
        setBankCached(bankRes.cached)
        setHistoryRuns(runs)
        setRunState('idle')
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setBankErr(msg)
        setRunState('error')
      }
    }
    void load()
    return () => { cancelled = true }
  }, [avatarId])

  // ── 当前题自动滚动到可见 ──
  useEffect(() => {
    if (currentCaseIdx < 0) return
    const el = caseListRef.current?.querySelector<HTMLDivElement>(`[data-case-idx="${currentCaseIdx}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [currentCaseIdx])

  // ── 派生：当前题 + 当前断言 ──
  const currentQuestion: GeneratedQuestion | null = useMemo(() => {
    if (!bank || currentCaseIdx < 0 || currentCaseIdx >= bank.questions.length) return null
    return bank.questions[currentCaseIdx] as GeneratedQuestion
  }, [bank, currentCaseIdx])

  const currentCaseResult: CaseResult | undefined = useMemo(() => {
    return caseResults.find(c => c.questionId === currentQuestion?.id)
  }, [caseResults, currentQuestion])

  // ── 进度统计 ──
  const stats = useMemo(() => {
    const total = bank?.questions.length ?? 0
    const passed = caseResults.filter(c => c.pass).length
    const failed = caseResults.filter(c => !c.pass).length
    const remaining = total - caseResults.length
    const passRate = caseResults.length === 0 ? 0 : passed / caseResults.length
    return { total, passed, failed, completed: caseResults.length, remaining, passRate }
  }, [bank, caseResults])

  // ── LLM 适配器（用于 AI 根因分析） ──
  const callLLM = useCallback<CallLLMFn>(async (prompt, signal) => {
    if (!chatModel.apiKey) throw new Error('未配置聊天模型 API Key')
    const res = await fetchWithTimeout(`${chatModel.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${chatModel.apiKey}`,
      },
      body: JSON.stringify({
        model: chatModel.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      }),
      signal,
      // AI 根因分析单次调用，3 分钟兜底
      timeoutMs: 180_000,
    })
    if (!res.ok) throw new Error(`LLM 接口错误 ${res.status}: ${await res.text().catch(() => '')}`)
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    const text = data.choices?.[0]?.message?.content ?? ''
    if (!text) throw new Error('LLM 返回空内容')
    return text
  }, [chatModel])

  // ── 主流程：运行 ──
  const handleRun = useCallback(async (): Promise<void> => {
    if (!bank || bank.questions.length === 0) {
      setRunErr('题库未加载')
      return
    }
    if (!chatModel.apiKey) {
      setRunErr('请先在设置中配置聊天模型 API Key')
      return
    }
    const runId = shortRunId()
    const questions = (maxCasesOverride > 0
      ? bank.questions.slice(0, maxCasesOverride)
      : bank.questions
    ) as unknown as GeneratedQuestion[]

    setCurrentRunId(runId)
    setCaseResults([])
    setRunErr(null)
    setSavedReport(null)
    setAiAnalysisStatus('')
    setRunState('running')
    setCurrentCaseIdx(0)
    setCurrentConvId(null)

    const controller = new AbortController()
    abortControllerRef.current = controller

    // sendMessage 适配器：注册临时会话 → 镜像跟随 → 调真实 sendMessage
    const sendMessageAdapter = async (content: string, conversationId: string, ava: string): Promise<void> => {
      await window.electronAPI.regressionEnsureConversation(ava, conversationId, content.slice(0, 80))
      if (!isMountedRef.current) return
      setCurrentConvId(conversationId)
      // 让 chatStore 切到新会话：bindConversation 只切 currentConversationId/tasks，不重置 messages；
      // 这里必须显式清空 in-memory messages，否则上一题的对话会被累加到下一题的 LLM 上下文里，
      // 导致模型从第 3 题开始走"我已经答过类似问题"的捷径而跳过 query_excel 工具。
      // 回归会话是临时新建的，DB 历史一定为空，直接清空内存即可，不必再发 IPC。
      await useChatStore.getState().bindConversation(conversationId)
      if (!isMountedRef.current) return
      useChatStore.getState().setMessages([])
      await useChatStore.getState().sendMessage(content, conversationId, ava)
    }

    // waitForIdle：轮询 isLoading（间隔 200ms，给 UI 喘息）
    const waitForIdleAdapter = async (signal: AbortSignal): Promise<void> => {
      // 给 sendMessage 一帧时间把 isLoading 置 true
      await sleep(50, signal)
      while (useChatStore.getState().isLoading && !signal.aborted) {
        await sleep(200, signal)
      }
    }

    let finalResult: BatchRunResult | null = null
    try {
      finalResult = await runBatchRegression({
        runId,
        avatarId,
        questions,
        sendMessage: sendMessageAdapter,
        waitForIdle: waitForIdleAdapter,
        perCaseTimeoutMs: 600_000, // 10 分钟单题超时（包含 LLM 长链路）
        interCaseDelayMs: 300,
        signal: controller.signal,
        onProgress: (event: BatchProgressEvent) => {
          if (!isMountedRef.current) return
          setCaseResults(prev => [...prev, event.caseResult])
          if (event.current < event.total) {
            setCurrentCaseIdx(event.current) // 切到下一题
          }
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('aborted')) {
        setRunState('cancelled')
      } else {
        setRunErr(msg)
        setRunState('error')
      }
      return
    }

    if (!isMountedRef.current) return
    setRunState('finishing')

    // 聚合 + 可选 LLM 分析 + 渲染 + 落盘 + 清理
    try {
      const summary = aggregateReport(finalResult)
      let analysis: RootCauseAnalysis | null = null
      if (enableAiAnalysis && summary.failCount > 0) {
        setAiAnalysisStatus('AI 根因分析中...')
        analysis = await requestRootCauseAnalysis(summary, finalResult.cases, callLLM)
        setAiAnalysisStatus(analysis.ok ? `AI 分析完成（采样 ${analysis.sampledCases} 例）` : `AI 分析失败：${analysis.error}`)
      }

      const reportMd = renderMarkdownReport(summary, analysis)
      const reportHtml = renderHtmlReport(summary, analysis)
      const saveRes = await window.electronAPI.regressionSaveRunResult(avatarId, {
        runId,
        startedAt: finalResult.startedAt,
        finishedAt: finalResult.finishedAt,
        totalCases: finalResult.totalCases,
        passCount: finalResult.passCount,
        failCount: finalResult.failCount,
        errorCount: finalResult.errorCount,
        resultJson: JSON.stringify(finalResult, null, 2),
        reportMd,
        reportHtml,
      })
      setSavedReport({
        resultJsonPath: saveRes.resultJsonPath,
        reportMdPath: saveRes.reportMdPath,
        reportHtmlPath: saveRes.reportHtmlPath,
      })

      // 清理临时会话（CASCADE 删消息）
      try {
        await window.electronAPI.regressionCleanupConversations(runId)
      } catch (cleanErr) {
        console.warn('[BatchRegressionPanel] 清理会话失败（不影响报告）:', cleanErr)
      }

      // 刷新历史列表
      try {
        const newHistory = await window.electronAPI.regressionListRuns(avatarId)
        if (isMountedRef.current) setHistoryRuns(newHistory)
      } catch (listErr) {
        // 历史刷新失败不阻塞主流程，仅 warn 让排查时能看到
        console.warn('[BatchRegressionPanel] 刷新历史列表失败:', listErr instanceof Error ? listErr.message : String(listErr))
      }

      if (isMountedRef.current) setRunState('done')
    } catch (err) {
      if (!isMountedRef.current) return
      setRunErr(`报告生成失败：${err instanceof Error ? err.message : String(err)}`)
      setRunState('error')
    }
  }, [bank, avatarId, chatModel, enableAiAnalysis, maxCasesOverride, callLLM])

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort()
  }, [])

  const handleOpenReport = useCallback(async (htmlPath: string): Promise<void> => {
    try {
      await window.electronAPI.regressionOpenReport(htmlPath)
    } catch (err) {
      setRunErr(`打开报告失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const handleRegenerateBank = useCallback(async (): Promise<void> => {
    if (runState === 'running') return
    setRunState('loading-bank')
    setBankErr(null)
    try {
      const res = await window.electronAPI.regressionLoadOrGenerateBank(avatarId, { force: true })
      setBank(res.bank)
      setBankCached(false)
      setRunState('idle')
    } catch (err) {
      setBankErr(err instanceof Error ? err.message : String(err))
      setRunState('error')
    }
  }, [avatarId, runState])

  // ── 渲染 ──
  const headerActions = (
    <div className="flex items-center gap-2">
      {runState === 'running' || runState === 'finishing' ? (
        <button onClick={handleStop} className="pixel-btn-outline-muted py-1">停止</button>
      ) : (
        <button
          onClick={handleRun}
          disabled={!bank || runState === 'loading-bank'}
          className="pixel-btn-primary py-1 disabled:opacity-50"
        >
          {runState === 'done' || runState === 'cancelled' || runState === 'error' ? '重新运行' : '开始运行'}
        </button>
      )}
    </div>
  )

  return (
    <Modal isOpen onClose={onClose} size="xl">
      <div className="flex flex-col h-full bg-px-bg">
        <PanelHeader
          title="批量回归测试"
          subtitle={avatarName || avatarId}
          onClose={onClose}
          actions={headerActions}
        />

        <div className="flex flex-1 overflow-hidden">
          {/* ── 左：题库统计 + Case 列表 ── */}
          <div className="w-[280px] border-r-2 border-px-border flex flex-col bg-px-surface">
            {/* 题库统计 */}
            <div className="px-4 py-3 border-b-2 border-px-border flex-shrink-0">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-game text-[12px] text-px-text tracking-wider">题库</h3>
                <button
                  onClick={handleRegenerateBank}
                  disabled={runState === 'running' || runState === 'finishing'}
                  className="font-game text-[10px] text-px-text-dim hover:text-px-primary disabled:opacity-30"
                  title="重新生成题库（基于当前知识库）"
                >
                  重建
                </button>
              </div>
              {bankErr && (
                <p className="font-mono text-[11px] text-px-danger break-all">{bankErr}</p>
              )}
              {bank && (
                <>
                  <div className="font-game text-[11px] text-px-text-sec mb-1">
                    {bank.questions.length} 题 · {bankCached ? '缓存' : '新生成'}
                  </div>
                  <div className="font-game text-[10px] text-px-text-dim mb-2">
                    {bank.knowledgeSnapshot.mdFiles} md · {bank.knowledgeSnapshot.excelFiles} xlsx
                  </div>
                  <div className="space-y-0.5">
                    {Object.entries(bank.summary)
                      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                      .map(([cat, count]) => (
                        <div key={cat} className="flex justify-between font-game text-[10px]">
                          <span className="text-px-text-dim">{CATEGORY_LABEL[cat] ?? cat}</span>
                          <span className="text-px-text-sec">{count}</span>
                        </div>
                      ))}
                  </div>
                  {/* 跑题数限制（仅 idle 时可改） */}
                  {runState === 'idle' && (
                    <div className="mt-3 pt-2 border-t border-px-border">
                      <label className="font-game text-[10px] text-px-text-dim block mb-1">跑题数（0=全部）</label>
                      <input
                        type="number"
                        min={0}
                        max={bank.questions.length}
                        value={maxCasesOverride}
                        onChange={(e) => setMaxCasesOverride(Math.max(0, parseInt(e.target.value || '0', 10)))}
                        className="w-full px-2 py-1 bg-px-bg border border-px-border font-mono text-[11px] text-px-text"
                      />
                      <label className="font-game text-[10px] text-px-text-dim flex items-center gap-1 mt-2">
                        <input
                          type="checkbox"
                          checked={enableAiAnalysis}
                          onChange={(e) => setEnableAiAnalysis(e.target.checked)}
                        />
                        启用 AI 根因分析
                      </label>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Case 列表 */}
            <div ref={caseListRef} className="flex-1 overflow-y-auto">
              {bank?.questions.map((q, idx) => {
                const result = caseResults.find(c => c.questionId === q.id)
                const isCurrent = idx === currentCaseIdx && (runState === 'running' || runState === 'finishing')
                const status: '✓' | '✗' | '!' | '▶' | '·' =
                  result?.pass ? '✓'
                  : result?.error ? '!'
                  : result ? '✗'
                  : isCurrent ? '▶'
                  : '·'
                const colorClass =
                  status === '✓' ? 'text-px-success'
                  : status === '✗' ? 'text-px-danger'
                  : status === '!' ? 'text-px-warning'
                  : status === '▶' ? 'text-px-primary'
                  : 'text-px-text-dim'
                const bgClass = isCurrent ? 'bg-px-primary/10' : ''
                return (
                  <div
                    key={q.id}
                    data-case-idx={idx}
                    className={`px-3 py-1.5 border-b border-px-border flex items-center gap-2 ${bgClass} hover:bg-px-bg/40`}
                  >
                    <span className={`font-mono text-[12px] flex-shrink-0 w-3 ${colorClass}`}>{status}</span>
                    <span className="font-game text-[10px] text-px-text-dim flex-shrink-0 w-12">{q.category.split('_')[0]}</span>
                    <span className="font-body text-[11px] text-px-text-sec truncate" title={q.prompt}>
                      {q.prompt.slice(0, 40)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── 中：实时镜像 ── */}
          <div className="flex-1 flex flex-col bg-px-bg overflow-hidden">
            {/* 当前题 prompt */}
            <div className="px-5 py-3 border-b-2 border-px-border flex-shrink-0 bg-px-surface">
              <div className="flex items-center justify-between mb-1">
                <span className="font-game text-[10px] text-px-text-dim tracking-wider">
                  {currentCaseIdx >= 0 && bank
                    ? `当前 ${currentCaseIdx + 1} / ${bank.questions.length}`
                    : '等待开始'}
                </span>
                {currentConvId && (
                  <span className="font-mono text-[10px] text-px-text-dim truncate ml-2">{currentConvId}</span>
                )}
              </div>
              {currentQuestion ? (
                <p className="font-body text-[13px] text-px-text leading-relaxed">{currentQuestion.prompt}</p>
              ) : (
                <p className="font-game text-[12px] text-px-text-dim">点击右上角"开始运行"</p>
              )}
            </div>

            {/* 工具调用状态条 */}
            {(toolCallStatus || isLoading) && (
              <div className="px-5 py-1.5 border-b border-px-border flex-shrink-0 bg-px-primary/5">
                <span className="font-mono text-[11px] text-px-primary">
                  {toolCallStatus ? `[工具] ${toolCallStatus}` : '[思考中...]'}
                </span>
              </div>
            )}

            {/* 任务清单（折叠） */}
            {tasks.length > 0 && (
              <div className="px-5 py-2 border-b border-px-border flex-shrink-0 bg-px-surface max-h-[120px] overflow-y-auto">
                <div className="font-game text-[10px] text-px-text-dim mb-1.5">任务清单 ({tasks.length})</div>
                {tasks.map(t => (
                  <div key={t.id} className="flex items-start gap-2 font-game text-[11px] mb-0.5">
                    <span className={
                      t.status === 'completed' ? 'text-px-success'
                      : t.status === 'in_progress' ? 'text-px-primary'
                      : t.status === 'cancelled' ? 'text-px-text-dim'
                      : 'text-px-text-dim'
                    }>
                      {t.status === 'completed' ? '✓'
                       : t.status === 'in_progress' ? '▶'
                       : t.status === 'cancelled' ? '×'
                       : '○'}
                    </span>
                    <span className="text-px-text-sec flex-1">{t.content}</span>
                  </div>
                ))}
              </div>
            )}

            {/* 助手消息流 */}
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {messages.length === 0 && currentQuestion && (
                <div className="font-game text-[12px] text-px-text-dim text-center py-8">
                  发送中...
                </div>
              )}
              {messages.filter(m => m.role !== 'system').map(m => (
                <div key={m.id} className={`p-3 border ${
                  m.role === 'user'
                    ? 'border-px-border bg-px-surface'
                    : 'border-px-primary/30 bg-px-primary/5'
                }`}>
                  <div className="font-game text-[10px] text-px-text-dim mb-1.5 tracking-wider">
                    {m.role === 'user' ? 'USER' : 'ASSISTANT'}
                  </div>
                  <div className="prose prose-sm prose-invert max-w-none font-body
                    prose-p:text-px-text-sec prose-p:leading-relaxed prose-p:text-[13px]
                    prose-code:text-px-accent prose-code:bg-px-bg prose-code:px-1 prose-code:text-[12px] prose-code:font-mono
                    prose-strong:text-px-text">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── 右：进度 + 当前断言 + 历史 + 报告 ── */}
          <div className="w-[300px] border-l-2 border-px-border flex flex-col bg-px-surface overflow-y-auto">
            {/* 总进度 */}
            <div className="px-4 py-3 border-b-2 border-px-border">
              <div className="flex items-center justify-between mb-2">
                <span className="font-game text-[12px] text-px-text tracking-wider">总览</span>
                {currentRunId && (
                  <span className="font-mono text-[10px] text-px-text-dim">{currentRunId.slice(0, 8)}</span>
                )}
              </div>
              <div className="space-y-1.5 font-game text-[11px]">
                <div className="flex justify-between">
                  <span className="text-px-text-dim">已完成</span>
                  <span className="text-px-text-sec">{stats.completed} / {stats.total}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-px-text-dim">通过</span>
                  <span className="text-px-success">{stats.passed}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-px-text-dim">失败</span>
                  <span className="text-px-danger">{stats.failed}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-px-text-dim">通过率</span>
                  <span className="text-px-primary">{(stats.passRate * 100).toFixed(1)}%</span>
                </div>
              </div>
              {/* 进度条 */}
              <div className="mt-3 h-2 bg-px-bg border border-px-border">
                <div
                  className="h-full bg-px-primary transition-all duration-200"
                  style={{ width: stats.total === 0 ? '0%' : `${(stats.completed / stats.total) * 100}%` }}
                />
              </div>
              {(runState === 'running' || runState === 'finishing') && (
                <p className="font-game text-[10px] text-px-text-dim mt-2 italic">
                  {runState === 'finishing' ? (aiAnalysisStatus || '正在生成报告...') : '运行中...'}
                </p>
              )}
              {runErr && (
                <p className="font-mono text-[10px] text-px-danger mt-2 break-all">{runErr}</p>
              )}
            </div>

            {/* 当前题断言 */}
            {currentQuestion && (
              <div className="px-4 py-3 border-b-2 border-px-border">
                <div className="font-game text-[12px] text-px-text mb-2 tracking-wider">当前题断言</div>
                {currentCaseResult ? (
                  <div className="space-y-1">
                    {currentCaseResult.assertions.map(a => (
                      <div key={a.name} className="font-game text-[10px] flex items-start gap-1.5">
                        <span className={a.pass ? 'text-px-success' : 'text-px-danger'}>
                          {a.pass ? '✓' : '✗'}
                        </span>
                        <div className="flex-1">
                          <div className="text-px-text-sec">{a.name}</div>
                          {!a.pass && a.reason && (
                            <div className="text-px-text-dim text-[10px] mt-0.5">{a.reason.slice(0, 100)}</div>
                          )}
                        </div>
                      </div>
                    ))}
                    <div className="font-game text-[10px] text-px-text-dim mt-2 pt-1.5 border-t border-px-border">
                      耗时 {fmtDurationShort(currentCaseResult.durationMs)} · {currentCaseResult.toolCallSequence.length} 工具调用
                    </div>
                  </div>
                ) : (
                  <p className="font-game text-[11px] text-px-text-dim">尚未完成</p>
                )}
                {currentQuestion.expectedTools && currentQuestion.expectedTools.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-px-border">
                    <div className="font-game text-[10px] text-px-text-dim mb-0.5">期望工具</div>
                    <div className="font-mono text-[10px] text-px-text-sec">{currentQuestion.expectedTools.join(', ')}</div>
                  </div>
                )}
                {currentQuestion.sourceFile && (
                  <div className="mt-1.5">
                    <div className="font-game text-[10px] text-px-text-dim mb-0.5">来源</div>
                    <div className="font-mono text-[10px] text-px-text-sec break-all">{currentQuestion.sourceFile}</div>
                  </div>
                )}
              </div>
            )}

            {/* 当前 run 报告 */}
            {savedReport && (
              <div className="px-4 py-3 border-b-2 border-px-border">
                <div className="font-game text-[12px] text-px-text mb-2 tracking-wider">本次报告</div>
                <button
                  onClick={() => handleOpenReport(savedReport.reportHtmlPath)}
                  className="pixel-btn-primary py-1.5 w-full mb-1.5 text-[11px]"
                >
                  浏览器打开 HTML
                </button>
                <div className="font-mono text-[9px] text-px-text-dim break-all">
                  {savedReport.reportHtmlPath}
                </div>
              </div>
            )}

            {/* 历史 run */}
            <div className="px-4 py-3 flex-1">
              <div className="font-game text-[12px] text-px-text mb-2 tracking-wider">
                历史 ({historyRuns.length})
              </div>
              {historyRuns.length === 0 ? (
                <p className="font-game text-[11px] text-px-text-dim">暂无历史</p>
              ) : (
                <div className="space-y-1.5">
                  {historyRuns.slice(0, 10).map(run => {
                    const passRate = run.totalCases === 0 ? 0 : run.passCount / run.totalCases
                    return (
                      <div
                        key={run.runId}
                        className="border border-px-border p-2 hover:border-px-primary cursor-pointer"
                        onClick={() => void handleOpenReport(run.reportHtmlPath)}
                      >
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="font-mono text-[10px] text-px-text-sec">{run.runId.slice(0, 8)}</span>
                          <span className="font-game text-[10px] text-px-text-dim">
                            {fmtTimeShort(run.startedAt)}
                          </span>
                        </div>
                        <div className="font-game text-[10px] flex justify-between">
                          <span className="text-px-text-dim">{run.totalCases} 题</span>
                          <span className={passRate >= 0.8 ? 'text-px-success' : passRate >= 0.5 ? 'text-px-warning' : 'text-px-danger'}>
                            {(passRate * 100).toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
