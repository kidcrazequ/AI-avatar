import { LLMService, ModelConfig, LLMMessage } from './llm-service'

/**
 * 从知识文件内容自动生成测试用例（GAP12）。
 * 调用 LLM 分析知识内容，返回结构化的测试用例列表。
 */
export async function generateTestCasesFromContent(
  knowledgeContent: string,
  fileName: string,
  chatModel: ModelConfig,
  count: number = 3
): Promise<GeneratedTestCase[]> {
  if (!chatModel.apiKey) {
    throw new Error('请先配置 Chat API Key')
  }

  const prompt = `你是一个专业的 AI 测试工程师。请根据以下知识内容，生成 ${count} 个高质量的测试用例。

## 知识文件：${fileName}

${knowledgeContent.slice(0, 3000)}

---

请生成 ${count} 个测试用例，每个测试用例用以下格式输出（严格遵守格式，不要添加额外内容）：

===TEST_CASE===
名称: [测试用例名称]
类别: [知识验证/计算能力/推理分析/政策解读 中选一]
用户问题: [用户会问的具体问题，要自然真实]
期望包含: [回答中必须包含的关键词，每行一个，最多3个]
评分标准: [评估回答质量的标准，每行一个，最多3条]
===END===

注意：
- 问题要针对知识内容中的具体细节
- 期望包含要是该知识中的关键事实或数字
- 评分标准要可量化`

  const messages: LLMMessage[] = [
    { role: 'user', content: prompt }
  ]

  const llm = new LLMService(chatModel)
  const response = await llm.complete(messages, { maxTokens: 2000 })

  return parseGeneratedTestCases(response)
}

export interface GeneratedTestCase {
  name: string
  category: string
  prompt: string
  mustContain: string[]
  rubrics: string[]
}

/** 解析 LLM 生成的测试用例文本 */
function parseGeneratedTestCases(text: string): GeneratedTestCase[] {
  const cases: GeneratedTestCase[] = []
  const blocks = text.split('===TEST_CASE===').slice(1)

  for (const block of blocks) {
    const content = block.split('===END===')[0].trim()
    if (!content) continue

    const lines = content.split('\n').map(l => l.trim()).filter(Boolean)
    const testCase: Partial<GeneratedTestCase> = {
      mustContain: [],
      rubrics: [],
    }

    let currentField: 'mustContain' | 'rubrics' | null = null

    for (const line of lines) {
      if (line.startsWith('名称:')) {
        testCase.name = line.replace('名称:', '').trim()
        currentField = null
      } else if (line.startsWith('类别:')) {
        testCase.category = line.replace('类别:', '').trim()
        currentField = null
      } else if (line.startsWith('用户问题:')) {
        testCase.prompt = line.replace('用户问题:', '').trim()
        currentField = null
      } else if (line.startsWith('期望包含:')) {
        const inline = line.replace('期望包含:', '').trim()
        if (inline) testCase.mustContain!.push(inline)
        currentField = 'mustContain'
      } else if (line.startsWith('评分标准:')) {
        const inline = line.replace('评分标准:', '').trim()
        if (inline) testCase.rubrics!.push(inline)
        currentField = 'rubrics'
      } else if (currentField === 'mustContain') {
        testCase.mustContain!.push(line.replace(/^[-*]/, '').trim())
      } else if (currentField === 'rubrics') {
        testCase.rubrics!.push(line.replace(/^[-*]/, '').trim())
      }
    }

    if (testCase.name && testCase.prompt) {
      cases.push({
        name: testCase.name,
        category: testCase.category || '知识验证',
        prompt: testCase.prompt,
        mustContain: testCase.mustContain!.filter(Boolean),
        rubrics: testCase.rubrics!.filter(Boolean),
      })
    }
  }

  return cases
}
