import { LLMService, ModelConfig, LLMMessage } from './llm-service'
import { validateSoulContent, buildSupplementPrompt, ValidationResult } from './soul-validator'

/**
 * SoulStepGenerator: 分步生成 soul.md，每步聚焦 1-2 个约束。
 * 解决 DeepSeek 等弱模型在一次性生成时丢失约束的问题。
 *
 * 生成分为 5 步：
 *   Step 1: Identity + Background（章节 1-2）
 *   Step 2: Style + 好例子 + 坏例子 + 口头禅（章节 3）
 *   Step 3: Principles + 数据溯源红线（章节 4）
 *   Step 4: Workflow + Collaboration + Growth（章节 5-7）
 *   Step 5: Commitment（章节 8）
 *
 * 生成完成后自动校验，缺失项自动补全。
 *
 * @author zhi.qu
 * @date 2026-04-02
 */

export interface StepProgress {
  currentStep: number
  totalSteps: number
  stepName: string
  phase: 'generating' | 'validating' | 'supplementing' | 'done'
}

export interface GenerationResult {
  content: string
  validation: ValidationResult
  supplemented: boolean
}

const STEPS = [
  {
    name: '身份与背景',
    chapters: '## 1. Identity + ## 2. Background',
    prompt: (avatarName: string, description: string) => `请为分身「${avatarName}」生成 soul.md 的前两个章节。

${description ? `分身描述：${description}` : ''}

## 要求

直接输出以下两个章节的 Markdown 内容（不要加代码块标记）：

## 1. Identity — 我是谁

- 用第一人称写，有温度
- 明确说"我不是工具/搜索引擎，我是你的搭档"
- 说清楚服务谁、做什么、知识来源
- 100-200 字

## 2. Background — 我的专业背景

- 列出熟悉的领域和方向（用 - 列表）
- 列出"经历过"的场景类型
- 150 字以内`,
  },
  {
    name: '说话风格与示例',
    chapters: '## 3. Style',
    prompt: (avatarName: string, _description: string, prevContent: string) => `以下是分身「${avatarName}」已经生成的身份和背景：

${prevContent}

---

现在请生成「## 3. Style — 我怎么说话」章节。这个章节非常重要，包含 4 个子部分：

### 说话方式
- 2-3 条具体的说话习惯（不要用"简洁""专业"这种模糊词，要用具体行为描述）

### 好的回答示例（必须 3 组，不可少于 3 组）

#### 场景 1：知识库有数据时的正常回答
> 展示结论先行、数据说话、标注来源的风格

#### 场景 2：知识库没数据时的诚实应答
> 诚实说"知识库中没有这个数据"，不编造，给判断框架，引导补充

#### 场景 3：不靠谱需求时的反驳
> 用数据和逻辑反驳，但态度是搭档式的

### 不好的回答示例（必须 2 组，不可少于 2 组）

#### 反面教材 1：通用 AI 风格（车轱辘话）
> 写一个空洞的、多维度分析但没有结论的回答，然后用分身语气吐槽

#### 反面教材 2：编造数据或模糊应答
> 写一个看似专业但编造数据的回答，然后用分身语气吐槽

### 口头禅
- 至少 3 条，要具体真实，不能是"注重质量"之类的空话
- 用引号包裹

直接输出 Markdown，不要加代码块标记。`,
  },
  {
    name: '原则与数据红线',
    chapters: '## 4. Principles',
    prompt: (avatarName: string, _description: string, prevContent: string) => `以下是分身「${avatarName}」已经生成的内容：

${summarizeContent(prevContent)}

---

现在请生成「## 4. Principles — 我的原则」章节，包含 4 个子部分：

### 安全红线 — 这些事我绝对不会自动做
用表格：| 操作 | 我的做法 |
列出 2-3 个该领域的危险操作

### 数据溯源红线 — 数据必须可追溯（重要！必须包含）
用表格：| 数据情况 | 我的做法 |
必须包含以下 4 行：
1. 知识库有数据 → 直接引用，标注来源文件
2. 知识库没数据 → 诚实说没有，给判断框架，引导补充
3. 数据不确定 → 标注"估算"或"待确认"，说明置信度
4. **绝对禁止** → 用模型通用知识冒充专业知识

### 诚实红线 — 这些事我绝对不会做
- 3 条，用第一人称

### 学习红线 — 这些事我会特别注意
- 3 条，用第一人称

直接输出 Markdown，不要加代码块标记。`,
  },
  {
    name: '工作流与协作',
    chapters: '## 5. Workflow + ## 6. Collaboration + ## 7. Growth',
    prompt: (avatarName: string, _description: string, prevContent: string) => `以下是分身「${avatarName}」已经生成的内容：

${summarizeContent(prevContent)}

---

现在请生成以下 3 个章节：

## 5. Workflow — 我怎么工作
- 分 3 个阶段描述工作流程
- 每个阶段有具体的子步骤
- 要与分身的专业背景匹配

## 6. Collaboration — 我找谁帮忙
用表格：| 我搞不定的事 | 我会找谁 | 怎么找 |
列出 2-3 种场景（如果暂无其他分身可协作，写"建议创建 @xxx 分身"）

## 7. Growth — 我的成长目标
用表格：| 阶段 | 我能做什么 | 你需要做什么 |
分 3 个阶段：第 1 个月 / 第 3 个月 / 第 6 个月
里程碑要具体可衡量

直接输出 Markdown，不要加代码块标记。`,
  },
  {
    name: '承诺',
    chapters: '## 8. Commitment',
    prompt: (avatarName: string, _description: string, prevContent: string) => `以下是分身「${avatarName}」已经生成的内容：

${summarizeContent(prevContent)}

---

现在请生成最后一个章节：

## 8. Commitment — 我的承诺

要求：
- 5 条承诺，用编号列表
- **第 1 条必须是关于「数据可溯源」**：我给你的每个关键数据都有出处，没出处的我会标注"估算"或"待确认"
- 第 2 条关于记忆：你教我的、纠正过的，我会一直记得
- 第 3 条关于成长
- 第 4 条关于不替用户做决定
- 第 5 条是该工种特有的承诺
- 每条用 **加粗关键词。** 的格式

直接输出 Markdown，不要加代码块标记。`,
  },
]

/**
 * 分步生成 soul.md 的完整内容。
 *
 * @param avatarName 分身名称
 * @param description 用户输入的描述
 * @param chatModel LLM 配置
 * @param onProgress 进度回调
 * @param onContentUpdate 内容更新回调（每步追加后触发）
 * @returns 最终生成结果，包含内容、校验结果和是否经过补全
 */
export async function generateSoulStepByStep(
  avatarName: string,
  description: string,
  chatModel: ModelConfig,
  onProgress: (progress: StepProgress) => void,
  onContentUpdate: (content: string) => void,
): Promise<GenerationResult> {
  const llm = new LLMService(chatModel)
  const totalSteps = STEPS.length
  let accumulated = `# ${avatarName} 灵魂文档\n\n> **版本**：v1.0\n> **说明**：本文档定义 ${avatarName} 的完整人格，是它一切行为的底层规则。\n\n---\n\n`

  // 读取 soul-template.md 和 soul-guide.md 作为 system prompt
  let systemPrompt = ''
  try {
    systemPrompt = await window.electronAPI.getSoulCreationPrompt(avatarName)
  } catch (e) {
    console.error('[SoulStepGenerator] 获取灵魂模板 system prompt 失败，使用降级方案', e)
  }

  onContentUpdate(accumulated)

  // 分步生成
  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i]
    onProgress({ currentStep: i + 1, totalSteps, stepName: step.name, phase: 'generating' })

    const userPrompt = step.prompt(avatarName, description, accumulated)

    const messages: LLMMessage[] = []
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    messages.push({ role: 'user', content: userPrompt })

    let stepContent = ''
    await new Promise<void>((resolve, reject) => {
      llm.chat(
        messages,
        (chunk) => {
          stepContent += chunk
          onContentUpdate(accumulated + stepContent + '\n\n---\n\n')
        },
        () => resolve(),
        (error) => reject(error),
      )
    })

    accumulated += stepContent.trim() + '\n\n---\n\n'
    onContentUpdate(accumulated)
  }

  // 校验
  onProgress({ currentStep: totalSteps, totalSteps, stepName: '结构校验', phase: 'validating' })
  let validation = validateSoulContent(accumulated)

  // 自动补全
  let supplemented = false
  const criticalMissing = validation.missing.filter(m => m.severity === 'critical')

  if (criticalMissing.length > 0) {
    onProgress({ currentStep: totalSteps, totalSteps, stepName: '自动补全', phase: 'supplementing' })

    const supplementPrompt = buildSupplementPrompt(accumulated, validation.missing)
    const messages: LLMMessage[] = [
      { role: 'user', content: supplementPrompt },
    ]

    let supplement = ''
    await new Promise<void>((resolve, reject) => {
      llm.chat(
        messages,
        (chunk) => {
          supplement += chunk
          onContentUpdate(accumulated + '\n\n' + supplement)
        },
        () => resolve(),
        (error) => reject(error),
      )
    })

    accumulated = mergeSupplementIntoContent(accumulated, supplement)
    onContentUpdate(accumulated)

    validation = validateSoulContent(accumulated)
    supplemented = true
  }

  onProgress({ currentStep: totalSteps, totalSteps, stepName: '完成', phase: 'done' })

  return { content: accumulated, validation, supplemented }
}

/**
 * 将补全内容合并回原始内容。
 * 补全内容中如果包含已有章节标题，则替换对应区块；否则追加到末尾。
 */
function mergeSupplementIntoContent(original: string, supplement: string): string {
  const supplementHeadings = supplement.match(/^##\s+\d+\..+$/gm)

  if (!supplementHeadings || supplementHeadings.length === 0) {
    return original + '\n\n' + supplement
  }

  let result = original

  for (const heading of supplementHeadings) {
    const headingNum = heading.match(/##\s+(\d+)\./)?.[1]
    if (!headingNum) continue

    const sectionPattern = new RegExp(
      `(##\\s+${headingNum}\\..*?)(?=\\n##\\s+\\d+\\.|$)`,
      's'
    )

    const supplementSection = extractSupplementSection(supplement, headingNum)
    if (!supplementSection) continue

    if (sectionPattern.test(result)) {
      result = result.replace(sectionPattern, supplementSection.trim())
    } else {
      result += '\n\n' + supplementSection.trim()
    }
  }

  // 补全可能包含不以 ## 数字 开头的子章节（如 ### 好的回答示例）
  const subSections = supplement.match(/^###\s+.+$/gm)
  if (subSections) {
    for (const sub of subSections) {
      const keyword = sub.replace(/^###\s+/, '').trim()
      if (!new RegExp(`###\\s+.*${escapeRegex(keyword)}`, 'im').test(result)) {
        const subContent = extractSubSection(supplement, keyword)
        if (subContent) {
          // 插入到 Style 章节末尾（在 ## 4. 之前）
          const insertPoint = result.match(/##\s+4\.\s/)
          if (insertPoint && insertPoint.index !== undefined) {
            result = result.slice(0, insertPoint.index) + subContent + '\n\n' + result.slice(insertPoint.index)
          } else {
            result += '\n\n' + subContent
          }
        }
      }
    }
  }

  return result
}

function extractSupplementSection(text: string, chapterNum: string): string | null {
  const pattern = new RegExp(
    `(##\\s+${chapterNum}\\..*?)(?=\\n##\\s+\\d+\\.|$)`,
    's'
  )
  const match = text.match(pattern)
  return match ? match[1] : null
}

function extractSubSection(text: string, keyword: string): string | null {
  const pattern = new RegExp(
    `(###\\s+.*${escapeRegex(keyword)}.*?)(?=\\n###\\s+|\\n##\\s+|$)`,
    's'
  )
  const match = text.match(pattern)
  return match ? match[1] : null
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 摘要已有内容，避免上下文过长 */
function summarizeContent(content: string): string {
  if (content.length <= 2000) return content

  const lines = content.split('\n')
  const summary: string[] = []
  let inBlock = false

  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('### ')) {
      summary.push(line)
      inBlock = true
    } else if (inBlock && line.trim().startsWith('-')) {
      summary.push(line)
    } else if (line.startsWith('>')) {
      if (summary.length < 60) summary.push(line)
    } else {
      inBlock = false
    }
  }

  return summary.join('\n')
}
