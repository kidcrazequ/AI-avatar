import { useState, useEffect } from 'react'
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

  useEffect(() => {
    loadTestCases()
  }, [avatarId])

  const showAlert = (msg: string) => {
    setAlertMsg(msg)
    setTimeout(() => setAlertMsg(''), 3000)
  }

  const loadTestCases = async () => {
    const cases = await window.electronAPI.getTestCases(avatarId)
    setTestCases(cases)
    setSelectedCases(new Set(cases.map(c => c.id)))
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
      showAlert('请先在设置中配置 API Key')
      return
    }

    setIsRunning(true)
    setResults([])
    setShowResults(false)

    const casesToRun = testCases.filter(c => selectedCases.has(c.id))
    const testRunner = new TestRunner(chatModel.apiKey, systemPrompt)

    try {
      const testResults = await testRunner.runTestCases(
        casesToRun,
        (current, total, message) => {
          setProgress({ current, total, message })
        }
      )

      setResults(testResults)
      setShowResults(true)

      const report = {
        avatarId,
        totalCases: testResults.length,
        passedCases: testResults.filter(r => r.passed).length,
        failedCases: testResults.filter(r => !r.passed).length,
        averageScore: testResults.reduce((sum, r) => sum + r.score, 0) / testResults.length,
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

  const passedCount = results.filter(r => r.passed).length
  const failedCount = results.filter(r => !r.passed).length

  const groupedCases = testCases.reduce((acc, tc) => {
    if (!acc[tc.category]) acc[tc.category] = []
    acc[tc.category].push(tc)
    return acc
  }, {} as Record<string, TestCase[]>)

  return (
    <Modal isOpen={true} onClose={onClose} size="lg">
      <PanelHeader title="自检测试" onClose={onClose} />

      {/* 内联提示信息 */}
      {alertMsg && (
        <div className="px-6 py-2 bg-px-mid border-b-2 border-px-danger">
          <span className="font-pixel text-[9px] text-px-danger tracking-wider">{alertMsg}</span>
        </div>
      )}

      {!showResults ? (
        /* ─── 测试用例列表 ─────────────────────────────── */
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* 工具栏 */}
          <div className="px-6 py-3 border-b-2 border-px-line bg-px-mid flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button onClick={handleSelectAll} className="pixel-btn-outline-muted">
                {selectedCases.size === testCases.length ? '取消全选' : '[ ] 全选'}
              </button>
              <span className="font-mono text-sm text-px-muted">
                已选择 {selectedCases.size} / {testCases.length} 个测试用例
              </span>
            </div>
            <button
              onClick={handleRunTests}
              disabled={isRunning || selectedCases.size === 0}
              className="pixel-btn-outline-light disabled:opacity-40"
            >
              {isRunning ? 'RUNNING...' : '[▶] 运行测试'}
            </button>
          </div>

          {/* 运行进度条 */}
          {isRunning && (
            <div className="px-6 py-3 border-b-2 border-px-line bg-px-dark">
              <div className="flex items-center justify-between mb-2">
                <span className="font-pixel text-[9px] text-px-muted tracking-wider">
                  TESTING {progress.current} / {progress.total}
                </span>
                <span className="font-mono text-xs text-px-muted">{progress.message}</span>
              </div>
              {/* 像素进度条 */}
              <div className="w-full h-2 border-2 border-px-line bg-px-black">
                <div
                  className="h-full bg-px-white transition-none"
                  style={{ width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '0%' }}
                />
              </div>
            </div>
          )}

          {/* 用例列表 */}
          <div className="flex-1 overflow-y-auto p-6 bg-px-dark">
            {testCases.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="font-pixel text-[10px] text-px-muted tracking-wider">NO TEST CASES</p>
              </div>
            ) : (
              Object.entries(groupedCases).map(([category, cases]) => (
                <div key={category} className="mb-6">
                  <h3 className="font-pixel text-[9px] text-px-muted tracking-wider mb-3 uppercase">
                    {category}
                  </h3>
                  <div className="space-y-2">
                    {cases.map((tc) => (
                      <label
                        key={tc.id}
                        className="flex items-start gap-3 p-3 border-2 border-px-line bg-px-dark
                          hover:bg-px-mid cursor-pointer transition-none"
                      >
                        {/* 像素风 checkbox */}
                        <div
                          className={`w-5 h-5 border-2 flex items-center justify-center flex-shrink-0 mt-0.5
                            font-pixel text-[8px] select-none cursor-pointer
                            ${selectedCases.has(tc.id)
                              ? 'bg-px-white border-px-white text-px-black'
                              : 'bg-transparent border-px-line text-transparent'
                            }`}
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
                          <div className="font-mono text-sm text-px-white font-medium">{tc.name}</div>
                          <div className="font-mono text-xs text-px-muted mt-1">
                            {tc.id} · 超时: {tc.timeout}s · {tc.rubrics.length} 个评分标准
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
        /* ─── 测试结果 ─────────────────────────────────── */
        <div className="flex-1 overflow-hidden flex">
          {/* 左侧：结果列表 */}
          <div className="w-1/3 border-r-2 border-px-line flex flex-col">
            <div className="px-4 py-3 border-b-2 border-px-line bg-px-mid">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-pixel text-[10px] text-px-white tracking-wider">TEST RESULTS</h3>
                <button onClick={() => setShowResults(false)} className="pixel-btn-outline-muted text-[8px] px-2 py-1">
                  ← BACK
                </button>
              </div>
              <div className="flex gap-4 font-mono text-sm">
                <span className="text-green-400">✓ {passedCount} 通过</span>
                <span className="text-px-danger">✗ {failedCount} 失败</span>
                <span className="text-px-muted">
                  {results.length > 0 ? Math.round((passedCount / results.length) * 100) : 0}%
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto bg-px-dark">
              {results.map((result) => (
                <button
                  key={result.caseId}
                  onClick={() => setSelectedResult(result)}
                  className={`w-full text-left px-4 py-3 border-b-2 border-px-line
                    ${selectedResult?.caseId === result.caseId
                      ? 'bg-px-black border-l-4 border-l-px-white'
                      : 'hover:bg-px-mid'
                    }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={result.passed ? 'text-green-400 font-pixel text-[9px]' : 'text-px-danger font-pixel text-[9px]'}>
                      {result.passed ? '✓' : '✗'}
                    </span>
                    <span className="font-mono text-sm text-px-white flex-1 truncate">
                      {result.caseName}
                    </span>
                    <span className="font-pixel text-[8px] text-px-muted">{result.score}分</span>
                  </div>
                  <div className="font-mono text-xs text-px-muted mt-0.5 pl-5">
                    {(result.duration / 1000).toFixed(1)}s
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 右侧：详细信息 */}
          <div className="flex-1 overflow-y-auto p-6 bg-px-dark">
            {selectedResult ? (
              <div className="space-y-5">
                <div>
                  <h3 className="font-mono text-base font-semibold text-px-white mb-2">
                    {selectedResult.caseName}
                  </h3>
                  <div className="flex items-center gap-4 font-mono text-sm">
                    <span className={selectedResult.passed ? 'text-green-400' : 'text-px-danger'}>
                      {selectedResult.passed ? '✓ 通过' : '✗ 失败'}
                    </span>
                    <span className="text-px-muted">得分: {selectedResult.score}/100</span>
                    <span className="text-px-muted">耗时: {(selectedResult.duration / 1000).toFixed(1)}s</span>
                  </div>
                </div>

                <div>
                  <h4 className="font-pixel text-[9px] text-px-muted tracking-wider mb-2 uppercase">评估反馈</h4>
                  <pre className="bg-px-black border-2 border-px-line p-4 font-mono text-sm text-px-warm whitespace-pre-wrap leading-relaxed">
                    {selectedResult.feedback}
                  </pre>
                </div>

                <div>
                  <h4 className="font-pixel text-[9px] text-px-muted tracking-wider mb-2 uppercase">AI 回复</h4>
                  <pre className="bg-px-black border-2 border-px-line p-4 font-mono text-sm text-px-warm whitespace-pre-wrap leading-relaxed">
                    {selectedResult.response}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <p className="font-pixel text-[10px] text-px-muted tracking-wider">SELECT A RESULT</p>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
