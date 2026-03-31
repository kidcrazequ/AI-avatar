import { DeepSeekService, Message } from './deepseek'

export class TestRunner {
  private systemPrompt: string
  private deepseek: DeepSeekService

  constructor(apiKey: string, systemPrompt: string) {
    this.systemPrompt = systemPrompt
    this.deepseek = new DeepSeekService(apiKey)
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
      onProgress?.(`测试失败: ${(error as Error).message}`)

      return {
        caseId: testCase.id,
        caseName: testCase.name,
        passed: false,
        score: 0,
        response: '',
        feedback: `测试执行失败: ${(error as Error).message}`,
        timestamp: Date.now(),
        duration,
      }
    }
  }

  // 运行多个测试用例（并发执行）
  async runTestCases(
    testCases: TestCase[],
    onProgress?: (current: number, total: number, message: string) => void
  ): Promise<TestResult[]> {
    let completedCount = 0
    const total = testCases.length

    // 并发运行所有测试用例
    const promises = testCases.map(async (testCase) => {
      const result = await this.runTestCase(testCase, (msg) => {
        onProgress?.(completedCount, total, msg)
      })

      completedCount++
      onProgress?.(completedCount, total, `已完成 ${completedCount}/${total}`)

      return result
    })

    // 等待所有测试完成
    return Promise.all(promises)
  }

  // 获取 AI 回复
  private async getAIResponse(prompt: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let response = ''
      let timeoutId: ReturnType<typeof setTimeout>

      const messages: Message[] = [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: prompt },
      ]

      // 设置超时
      timeoutId = setTimeout(() => {
        reject(new Error(`测试超时 (${timeout}秒)`))
      }, timeout * 1000)

      this.deepseek.chat(
        messages,
        (chunk) => {
          response += chunk
        },
        () => {
          clearTimeout(timeoutId)
          resolve(response)
        },
        (error) => {
          clearTimeout(timeoutId)
          reject(error)
        }
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

    // 使用 AI 评估 RUBRICS
    if (testCase.rubrics.length > 0) {
      const rubricEvaluation = await this.evaluateRubrics(testCase, response)
      feedbackParts.push(...rubricEvaluation.feedback)
      score = Math.min(score, rubricEvaluation.score)
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

    await new Promise<void>((resolve, reject) => {
      this.deepseek.chat(
        [{ role: 'user', content: evaluationPrompt }],
        (chunk) => { evaluationResult += chunk },
        () => resolve(),
        (error) => reject(error)
      )
    })

    // 解析评估结果
    const lines = evaluationResult.split('\n')
    let totalScore = 80 // 默认分数

    for (const line of lines) {
      if (line.includes('未通过') || line.includes('不满足') || line.includes('缺少')) {
        feedback.push(`⚠️ ${line.trim()}`)
      }

      const scoreMatch = line.match(/总分[：:]\s*(\d+)/i)
      if (scoreMatch) {
        totalScore = parseInt(scoreMatch[1], 10)
      }
    }

    return { score: totalScore, feedback }
  }
}
