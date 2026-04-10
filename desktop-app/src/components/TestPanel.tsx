import { useState, useEffect, useRef, useMemo } from 'react'
import { TestRunner } from '../services/test-runner'
import { ModelConfig } from '../services/llm-service'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  chatModel: ModelConfig
  systemPrompt: string
  onClose: () => void
}

export default function TestPanel({ avatarId, chatModel, systemPrompt, onClose }: Props) {
  const [testCases, setTestCases] = useState<TestCase[]>([])
  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set())
  const [isRunning, setIsRunning] = useState(false)
  const [results, setResults] = useState<TestResult[]>([])
  const [progress, setProgress] = useState({ current: 0, total: 0, message: '' })
  const [showResults, setShowResults] = useState(false)
  const [selectedResult, setSelectedResult] = useState<TestResult | null>(null)
  const [alertMsg, setAlertMsg] = useState('')
  const alertTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const mountedRef = useRef(true)
  const loadSeqRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(alertTimerRef.current)
    }
  }, [])

  useEffect(() => {
    loadTestCases()
  }, [avatarId])

  const showAlert = (msg: string) => {
    if (!mountedRef.current) return
    setAlertMsg(msg)
    clearTimeout(alertTimerRef.current)
    alertTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setAlertMsg('')
    }, 3000)
  }

  const loadTestCases = async () => {
    const seq = ++loadSeqRef.current
    try {
      const cases = await window.electronAPI.getTestCases(avatarId)
      if (loadSeqRef.current !== seq || !mountedRef.current) return
      setTestCases(cases)
      setSelectedCases(new Set(cases.map(c => c.id)))
    } catch (err) {
      console.error('[TestPanel] 加载测试用例失败:', err instanceof Error ? err.message : String(err))
    }
  }

  const handleToggleCase = (caseId: string) => {
    const newSelected = new Set(selectedCases)
    if (newSelected.has(caseId)) {
      newSelected.delete(caseId)
    } else {
      newSelected.add(caseId)
    }
    setSelectedCases(newSelected)
  }

  const handleSelectAll = () => {
    if (selectedCases.size === testCases.length) {
      setSelectedCases(new Set())
    } else {
      setSelectedCases(new Set(testCases.map(c => c.id)))
    }
  }

  const handleRunTests = async () => {
    if (selectedCases.size === 0) {
      showAlert('请至少选择一个测试用例')
      return
    }
    if (!chatModel.apiKey) {
      showAlert('请先在 SETTINGS 中配置 API Key')
      return
    }

    setIsRunning(true)
    setResults([])
    setShowResults(false)

    const casesToRun = testCases.filter(c => selectedCases.has(c.id))
    const testRunner = new TestRunner(chatModel, systemPrompt)

    try {
      const testResults = await testRunner.runTestCases(
        casesToRun,
        (current, total, message) => {
          if (mountedRef.current) setProgress({ current, total, message })
        }
      )

      if (!mountedRef.current) return
      setResults(testResults)
      setShowResults(true)

      const report = {
        avatarId,
        totalCases: testResults.length,
        passedCases: testResults.filter(r => r.passed).length,
        failedCases: testResults.filter(r => !r.passed).length,
        averageScore: testResults.length > 0 ? testResults.reduce((sum, r) => sum + r.score, 0) / testResults.length : 0,
        results: testResults,
        timestamp: Date.now(),
        duration: testResults.reduce((sum, r) => sum + r.duration, 0),
      }

      await window.electronAPI.saveTestReport(avatarId, report)
    } catch (error) {
      console.error('运行测试失败:', error)
      showAlert('运行测试失败，请重试')
    } finally {
      setIsRunning(false)
    }
  }

  const { passedCount, failedCount } = useMemo(() => {
    let passed = 0
    for (const r of results) { if (r.passed) passed++ }
    return { passedCount: passed, failedCount: results.length - passed }
  }, [results])

  const groupedCases = useMemo(() =>
    testCases.reduce((acc, tc) => {
      if (!acc[tc.category]) acc[tc.category] = []
      acc[tc.category].push(tc)
      return acc
    }, {} as Record<string, TestCase[]>),
  [testCases])

  return (
    <Modal isOpen={true} onClose={onClose} size="lg">
      <PanelHeader title="TEST CENTER" onClose={onClose} />

      {alertMsg && (
        <div className="px-6 py-2 bg-px-danger/10 border-b-2 border-px-danger">
          <span className="font-game text-[13px] text-px-danger tracking-wider">{alertMsg}</span>
        </div>
      )}

      {!showResults ? (
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* 工具栏 */}
          <div className="px-6 py-3 border-b-2 border-px-border bg-px-elevated flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button onClick={handleSelectAll} className="pixel-btn-outline-muted">
                {selectedCases.size === testCases.length ? 'NONE' : 'ALL'}
              </button>
              <span className="font-game text-[13px] text-px-text-sec">
                {selectedCases.size} / {testCases.length}
              </span>
            </div>
            <button
              onClick={handleRunTests}
              disabled={isRunning || selectedCases.size === 0}
              className="pixel-btn-primary"
            >
              {isRunning ? 'RUNNING...' : 'RUN TEST'}
            </button>
          </div>

          {/* 进度条 */}
          {isRunning && (
            <div className="px-6 py-3 border-b-2 border-px-border bg-px-surface">
              <div className="flex items-center justify-between mb-2">
                <span className="font-game text-[12px] text-px-primary tracking-wider">
                  {progress.current} / {progress.total}
                </span>
                <span className="font-game text-[13px] text-px-text-sec">{progress.message}</span>
              </div>
              <div className="w-full h-2 border-2 border-px-border bg-px-bg">
                <div
                  className="h-full bg-px-primary transition-none"
                  style={{ width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '0%' }}
                />
              </div>
            </div>
          )}

          {/* 用例列表 */}
          <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
            {testCases.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <div className="w-12 h-12 border-2 border-px-primary bg-px-primary/10 flex items-center justify-center mx-auto mb-3">
                    <span className="text-px-primary font-game text-[12px]">T</span>
                  </div>
                  <p className="font-game text-[12px] text-px-text-dim tracking-wider">暂无测试用例</p>
                </div>
              </div>
            ) : (
              Object.entries(groupedCases).map(([category, cases]) => (
                <div key={category} className="mb-6">
                  <h3 className="font-game text-[13px] text-px-text-sec tracking-widest mb-3">
                    {category}
                  </h3>
                  <div className="space-y-2">
                    {cases.map((tc) => (
                      <label
                        key={tc.id}
                        className="flex items-start gap-3 p-3 border-2 border-px-border bg-px-elevated
                          hover:bg-px-hover cursor-pointer transition-none"
                      >
                        <div
                          className="pixel-checkbox mt-0.5 flex-shrink-0"
                          data-checked={selectedCases.has(tc.id)}
                          onClick={() => handleToggleCase(tc.id)}
                        >
                          ✓
                        </div>
                        <input
                          type="checkbox"
                          checked={selectedCases.has(tc.id)}
                          onChange={() => handleToggleCase(tc.id)}
                          className="sr-only"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-game text-[14px] text-px-text font-medium">{tc.name}</div>
                          <div className="font-game text-[12px] text-px-text-dim mt-1">
                            {tc.id} · {tc.timeout}s · {tc.rubrics.length} 规则
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        /* ── 测试结果 ── */
        <div className="flex-1 overflow-hidden flex">
          {/* 左侧列表 */}
          <div className="w-1/3 border-r-2 border-px-border flex flex-col">
            <div className="px-4 py-3 border-b-2 border-px-border bg-px-elevated">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-game text-[14px] text-px-text tracking-wider">测试结果</h3>
                <button onClick={() => setShowResults(false)} className="pixel-btn-outline-muted text-[10px] px-2 py-1">返回</button>
              </div>
              <div className="flex gap-4 font-game text-[12px] tracking-wider">
                <span className="text-px-success">通过 {passedCount}</span>
                <span className="text-px-danger">失败 {failedCount}</span>
                <span className="text-px-text-dim">
                  {results.length > 0 ? Math.round((passedCount / results.length) * 100) : 0}%
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto bg-px-bg">
              {results.map((result) => (
                <button
                  key={result.caseId}
                  onClick={() => setSelectedResult(result)}
                  className={`w-full text-left px-4 py-3 border-b border-px-border-dim transition-none
                    ${selectedResult?.caseId === result.caseId
                      ? 'bg-px-surface border-l-3 border-l-px-primary'
                      : 'hover:bg-px-surface/50 border-l-3 border-l-transparent'
                    }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`font-game text-[12px] ${result.passed ? 'text-px-success' : 'text-px-danger'}`}>
                      {result.passed ? '通过' : '失败'}
                    </span>
                    <span className="font-game text-[14px] text-px-text flex-1 truncate">
                      {result.caseName}
                    </span>
                    <span className="font-game text-[12px] text-px-text-dim">{result.score}</span>
                  </div>
                  <div className="font-game text-[12px] text-px-text-dim mt-0.5 pl-12">
                    {(result.duration / 1000).toFixed(1)}s
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 右侧详情 */}
          <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
            {selectedResult ? (
              <div className="space-y-5">
                <div>
                  <h3 className="font-game text-[16px] font-bold text-px-text mb-2">
                    {selectedResult.caseName}
                  </h3>
                  <div className="flex items-center gap-4 font-game text-[12px] tracking-wider">
                    <span className={selectedResult.passed ? 'text-px-success' : 'text-px-danger'}>
                      {selectedResult.passed ? '通过' : '失败'}
                    </span>
                    <span className="text-px-text-sec">{selectedResult.score}/100</span>
                    <span className="text-px-text-sec">{(selectedResult.duration / 1000).toFixed(1)}s</span>
                  </div>
                </div>

                <div>
                  <h4 className="font-game text-[13px] text-px-text-sec tracking-widest mb-2">反馈</h4>
                  <pre className="bg-px-bg border-2 border-px-border p-4 font-game text-[14px] text-px-text-sec whitespace-pre-wrap leading-relaxed">
                    {selectedResult.feedback}
                  </pre>
                </div>

                <div>
                  <h4 className="font-game text-[13px] text-px-text-sec tracking-widest mb-2">AI 回复</h4>
                  <pre className="bg-px-bg border-2 border-px-border p-4 font-game text-[14px] text-px-text-sec whitespace-pre-wrap leading-relaxed">
                    {selectedResult.response}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <div className="w-12 h-12 border-2 border-px-primary bg-px-primary/10 flex items-center justify-center mx-auto mb-3">
                    <span className="text-px-primary font-game text-[12px]">R</span>
                  </div>
                  <p className="font-game text-[12px] text-px-text-dim tracking-wider">选择一个结果</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
