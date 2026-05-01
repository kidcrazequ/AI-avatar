import { LLMService, LLMMessage, ModelConfig } from './llm-service'

export class TestRunner {
  private systemPrompt: string
  private llm: LLMService

  constructor(modelConfig: ModelConfig, systemPrompt: string) {
    this.systemPrompt = systemPrompt
    this.llm = new LLMService(modelConfig)
  }

  // 运行单个测试用例
  async runTestCase(
    testCase: TestCase,
    onProgress?: (message: string) => void
  ): Promise<TestResult> {
    const startTime = Date.now()
    onProgress?.(`开始测试: ${testCase.name}`)

    try {
      // 调用 AI 获取回复
      const response = await this.getAIResponse(testCase.prompt, testCase.timeout)
      onProgress?.(`收到回复，开始评估...`)

      // 评估回复
      const evaluation = await this.evaluateResponse(testCase, response)

      const duration = Date.now() - startTime
      onProgress?.(`测试完成: ${evaluation.passed ? '通过' : '失败'} (${evaluation.score}分)`)

      return {
        caseId: testCase.id,
        caseName: testCase.name,
        passed: evaluation.passed,
        score: evaluation.score,
        response,
        feedback: evaluation.feedback,
        timestamp: Date.now(),
        duration,
      }
    } catch (error) {
      const duration = Date.now() - startTime
      const errMsg = error instanceof Error ? error.message : String(error)
      onProgress?.(`测试失败: ${errMsg}`)

      return {
        caseId: testCase.id,
        caseName: testCase.name,
        passed: false,
        score: 0,
        response: '',
        feedback: `测试执行失败: ${errMsg}`,
        timestamp: Date.now(),
        duration,
      }
    }
  }

  /**
   * 运行多个测试用例（顺序执行，避免并发计数竞态）。
   *
   * @author zhi.qu
   * @date 2026-04-09
   */
  async runTestCases(
    testCases: TestCase[],
    onProgress?: (current: number, total: number, message: string) => void
  ): Promise<TestResult[]> {
    const total = testCases.length
    const results: TestResult[] = []

    for (let i = 0; i < testCases.length; i++) {
      const result = await this.runTestCase(testCases[i], (msg) => {
        onProgress?.(i, total, msg)
      })
      results.push(result)
      onProgress?.(i + 1, total, `已完成 ${i + 1}/${total}`)
    }

    return results
  }

  /**
   * 获取 AI 回复，使用 settled 标志防止超时后双重结算。
   *
   * @author zhi.qu
   * @date 2026-04-09
   */
  private async getAIResponse(prompt: string, timeout: number): Promise<string> {
    const abortController = new AbortController()

    return new Promise((resolve, reject) => {
      let response = ''
      let settled = false

      const messages: LLMMessage[] = [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: prompt },
      ]

      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true
          abortController.abort()
          reject(new Error(`测试超时 (${timeout}秒)`))
        }
      }, timeout * 1000)

      this.llm.chat(
        messages,
        (chunk) => {
          if (!settled) response += chunk
        },
        (fullText) => {
          if (!settled) {
            settled = true
            clearTimeout(timeoutId)
            resolve(fullText || response)
          }
        },
        (error) => {
          if (!settled) {
            settled = true
            clearTimeout(timeoutId)
            reject(error)
          }
        },
        { signal: abortController.signal }
      )
    })
  }

  // 评估回复
  private async evaluateResponse(
    testCase: TestCase,
    response: string
  ): Promise<{ passed: boolean; score: number; feedback: string }> {
    const feedbackParts: string[] = []
    let score = 100

    // 检查 MUST_CONTAIN
    for (const keyword of testCase.mustContain) {
      if (!response.includes(keyword)) {
        feedbackParts.push(`❌ 缺少必需内容: "${keyword}"`)
        score -= 20
      }
    }

    // 检查 MUST_NOT_CONTAIN
    for (const keyword of testCase.mustNotContain) {
      if (response.includes(keyword)) {
        feedbackParts.push(`❌ 包含禁止内容: "${keyword}"`)
        score -= 20
      }
    }

    // 使用 AI 评估 RUBRICS（失败时保留关键词评分结果，不丢弃整个测试）
    if (testCase.rubrics.length > 0) {
      try {
        const rubricEvaluation = await this.evaluateRubrics(testCase, response)
        feedbackParts.push(...rubricEvaluation.feedback)
        score = Math.min(score, rubricEvaluation.score)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        feedbackParts.push(`⚠️ AI 评估失败: ${msg}`)
        score = Math.min(score, 50)
      }
    }

    score = Math.max(0, score)
    const passed = score >= 60

    const feedback = feedbackParts.length > 0
      ? feedbackParts.join('\n')
      : '✅ 所有检查项通过'

    return { passed, score, feedback }
  }

  // 使用 AI 评估 RUBRICS
  private async evaluateRubrics(
    testCase: TestCase,
    response: string
  ): Promise<{ score: number; feedback: string[] }> {
    const feedback: string[] = []

    const evaluationPrompt = `你是一个测试评估专家。请根据以下评分标准（RUBRICS）评估 AI 的回复质量。

测试用例：${testCase.name}

用户提问：
${testCase.prompt}

AI 回复：
${response}

评分标准（RUBRICS）：
${testCase.rubrics.map((r, i) => `${i + 1}. ${r}`).join('\n')}

请逐条评估每个标准是否满足，并给出总分（0-100分）。

输出格式：
标准1: [通过/未通过] - 理由
标准2: [通过/未通过] - 理由
...
总分: XX分`

    let evaluationResult = ''
    const evalAbort = new AbortController()
    const evalTimeout = setTimeout(() => evalAbort.abort(), 120_000)

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        this.llm.chat(
          [{ role: 'user', content: evaluationPrompt }],
          (chunk) => { if (!settled) evaluationResult += chunk },
          (fullText) => {
            if (settled) return
            settled = true
            clearTimeout(evalTimeout)
            evaluationResult = fullText || evaluationResult
            resolve()
          },
          (error) => {
            if (settled) return
            settled = true
            clearTimeout(evalTimeout)
            reject(error)
          },
          { signal: evalAbort.signal }
        )
      })
    } finally {
      clearTimeout(evalTimeout)
    }

    // 解析评估结果；若无法提取评分则标记为评估失败而非默认高分
    const lines = evaluationResult.split('\n')
    let totalScore = -1
    let scoreExtracted = false

    for (const line of lines) {
      if (line.includes('未通过') || line.includes('不满足') || line.includes('缺少')) {
        feedback.push(`⚠️ ${line.trim()}`)
      }

      const scoreMatch = line.match(/总分[：:]\s*(\d+)/i)
      if (scoreMatch) {
        const parsed = parseInt(scoreMatch[1], 10)
        if (Number.isFinite(parsed)) {
          totalScore = Math.min(Math.max(parsed, 0), 100)
          scoreExtracted = true
        }
      }
    }

    if (!scoreExtracted) {
      feedback.push('⚠️ AI 评估结果解析失败，无法提取总分')
      totalScore = 50
    }

    return { score: totalScore, feedback }
  }
}
