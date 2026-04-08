import { LLMService, ModelConfig, LLMMessage } from './llm-service'

/**
 * 从知识文件内容自动生成测试用例（GAP12）。
 * 基于 templates/test-case-template.md 的规范，调用 LLM 生成覆盖 6 个维度的测试用例。
 *
 * @author zhi.qu
 * @date 2026-04-02
 */
export async function generateTestCasesFromContent(
  knowledgeContent: string,
  fileName: string,
  chatModel: ModelConfig,
  count: number = 6
): Promise<GeneratedTestCase[]> {
  if (!chatModel.apiKey) {
    throw new Error('请先配置 Chat API Key')
  }

  // 从后端获取基于 test-case-template.md 构建的 system prompt
  let systemPrompt = ''
  try {
    systemPrompt = await window.electronAPI.getTestCreationPrompt()
  } catch (e) {
    console.error('[TestGenerator] 获取测试模板 system prompt 失败，使用降级方案', e)
  }

  const userPrompt = `请根据以下知识文件内容，生成 ${count} 个测试用例。

## 知识文件：${fileName}

${knowledgeContent.slice(0, 4000)}

---

要求：
- 必须覆盖知识准确性、知识库约束、数据溯源这 3 个核心类别
- 问题要针对知识内容中的具体细节和数据
- 期望包含要是该知识中的关键事实或数字
- 不应包含要列出编造数据或模糊表述的典型错误
- 评分标准要可量化`

  const messages: LLMMessage[] = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  messages.push({ role: 'user', content: userPrompt })

  const llm = new LLMService(chatModel)
  const response = await llm.complete(messages, { maxTokens: 3000 })

  return parseGeneratedTestCases(response)
}

export interface GeneratedTestCase {
  name: string
  category: string
  prompt: string
  mustContain: string[]
  mustNotContain: string[]
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
      mustNotContain: [],
      rubrics: [],
    }

    let currentField: 'mustContain' | 'mustNotContain' | 'rubrics' | null = null

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
      } else if (line.startsWith('不应包含:')) {
        const inline = line.replace('不应包含:', '').trim()
        if (inline) testCase.mustNotContain!.push(inline)
        currentField = 'mustNotContain'
      } else if (line.startsWith('评分标准:')) {
        const inline = line.replace('评分标准:', '').trim()
        if (inline) testCase.rubrics!.push(inline)
        currentField = 'rubrics'
      } else if (currentField === 'mustContain') {
        testCase.mustContain!.push(line.replace(/^[-*]/, '').trim())
      } else if (currentField === 'mustNotContain') {
        testCase.mustNotContain!.push(line.replace(/^[-*]/, '').trim())
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
        mustNotContain: testCase.mustNotContain!.filter(Boolean),
        rubrics: testCase.rubrics!.filter(Boolean),
      })
    }
  }

  return cases
}
