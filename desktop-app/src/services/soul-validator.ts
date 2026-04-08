/**
 * SoulValidator: 校验 AI 生成的 soul.md 结构完整性。
 * 对照 templates/soul-template.md 的 8 章结构，逐项检查是否缺失。
 * 返回缺失项列表，用于驱动 LLM 自动补全。
 *
 * @author zhi.qu
 * @date 2026-04-02
 */

export interface ValidationResult {
  isValid: boolean
  missing: MissingItem[]
  score: number
}

export interface MissingItem {
  id: string
  chapter: string
  description: string
  severity: 'critical' | 'warning'
}

/**
 * 校验 soul.md 内容的结构完整性。
 * @param content 生成的 soul.md 全文
 * @returns 校验结果，包含缺失项列表和完整度评分
 */
export function validateSoulContent(content: string): ValidationResult {
  const missing: MissingItem[] = []

  // 章节 1: Identity
  if (!hasHeading(content, '1', 'Identity')) {
    missing.push({ id: 'ch1', chapter: 'Identity', description: '缺少「## 1. Identity — 我是谁」章节', severity: 'critical' })
  }

  // 章节 2: Background
  if (!hasHeading(content, '2', 'Background')) {
    missing.push({ id: 'ch2', chapter: 'Background', description: '缺少「## 2. Background — 我的专业背景」章节', severity: 'critical' })
  }

  // 章节 3: Style
  if (!hasHeading(content, '3', 'Style')) {
    missing.push({ id: 'ch3', chapter: 'Style', description: '缺少「## 3. Style — 我怎么说话」章节', severity: 'critical' })
  }

  // 好的回答示例：至少 3 组
  const goodExampleCount = countGoodExamples(content)
  if (goodExampleCount < 3) {
    missing.push({
      id: 'good_examples',
      chapter: 'Style',
      description: `好的回答示例只有 ${goodExampleCount} 组，需要至少 3 组（知识库有数据 / 没数据 / 不靠谱需求）`,
      severity: 'critical',
    })
  }

  // 坏的回答示例：至少 2 组
  const badExampleCount = countBadExamples(content)
  if (badExampleCount < 2) {
    missing.push({
      id: 'bad_examples',
      chapter: 'Style',
      description: `不好的回答示例只有 ${badExampleCount} 组，需要至少 2 组（通用 AI 风格 / 编造数据）`,
      severity: 'critical',
    })
  }

  // 口头禅
  if (!hasSection(content, '口头禅')) {
    missing.push({ id: 'catchphrases', chapter: 'Style', description: '缺少口头禅', severity: 'warning' })
  } else {
    const catchphrases = extractCatchphrases(content)
    if (catchphrases.length < 2) {
      missing.push({ id: 'catchphrases_count', chapter: 'Style', description: `口头禅只有 ${catchphrases.length} 条，建议至少 2 条`, severity: 'warning' })
    }
    const generic = catchphrases.filter(p => isGenericPhrase(p))
    if (generic.length > 0) {
      missing.push({ id: 'catchphrases_generic', chapter: 'Style', description: `口头禅过于空泛：${generic.join('、')}`, severity: 'warning' })
    }
  }

  // 章节 4: Principles
  if (!hasHeading(content, '4', 'Principles')) {
    missing.push({ id: 'ch4', chapter: 'Principles', description: '缺少「## 4. Principles — 我的原则」章节', severity: 'critical' })
  }

  // 数据溯源红线表格
  if (!hasDataTraceabilityTable(content)) {
    missing.push({ id: 'data_traceability', chapter: 'Principles', description: '缺少「数据溯源红线」表格（| 数据情况 | 我的做法 |）', severity: 'critical' })
  }

  // 章节 5: Workflow
  if (!hasHeading(content, '5', 'Workflow')) {
    missing.push({ id: 'ch5', chapter: 'Workflow', description: '缺少「## 5. Workflow — 我怎么工作」章节', severity: 'warning' })
  }

  // 章节 6: Collaboration
  if (!hasHeading(content, '6', 'Collaboration')) {
    missing.push({ id: 'ch6', chapter: 'Collaboration', description: '缺少「## 6. Collaboration — 我找谁帮忙」章节', severity: 'warning' })
  }

  // 章节 7: Growth
  if (!hasHeading(content, '7', 'Growth')) {
    missing.push({ id: 'ch7', chapter: 'Growth', description: '缺少「## 7. Growth — 我的成长目标」章节', severity: 'warning' })
  }

  // 章节 8: Commitment
  if (!hasHeading(content, '8', 'Commitment')) {
    missing.push({ id: 'ch8', chapter: 'Commitment', description: '缺少「## 8. Commitment — 我的承诺」章节', severity: 'critical' })
  }

  // 第一条承诺必须关于数据溯源
  if (hasHeading(content, '8', 'Commitment') && !hasFirstCommitmentAboutTraceability(content)) {
    missing.push({ id: 'commitment_first', chapter: 'Commitment', description: '第 1 条承诺应该是关于「数据可溯源」', severity: 'warning' })
  }

  const criticalCount = missing.filter(m => m.severity === 'critical').length
  const warningCount = missing.filter(m => m.severity === 'warning').length
  const totalChecks = 13
  const score = Math.round(((totalChecks - criticalCount * 2 - warningCount) / totalChecks) * 100)

  return {
    isValid: criticalCount === 0,
    missing,
    score: Math.max(0, Math.min(100, score)),
  }
}

/**
 * 将缺失项列表转为 LLM 可理解的补全提示。
 */
export function buildSupplementPrompt(content: string, missing: MissingItem[]): string {
  const criticals = missing.filter(m => m.severity === 'critical')
  const warnings = missing.filter(m => m.severity === 'warning')

  let prompt = `以下是已经生成的 soul.md 内容，但校验发现存在缺失项，请补全。

## 当前内容

${content}

## 需要补全的内容（按重要性排序）

### 必须补全（critical）
${criticals.map((m, i) => `${i + 1}. [${m.chapter}] ${m.description}`).join('\n')}
`

  if (warnings.length > 0) {
    prompt += `
### 建议补全（warning）
${warnings.map((m, i) => `${i + 1}. [${m.chapter}] ${m.description}`).join('\n')}
`
  }

  prompt += `
## 输出要求

- 只输出需要补全的部分，用对应的 Markdown 章节标题标记位置
- 保持与已有内容的风格和人称一致
- 直接输出 Markdown，不要加代码块标记
- 好的回答示例必须分 3 个场景（知识库有数据 / 没数据 / 不靠谱需求），每个场景用 #### 标记
- 坏的回答示例必须分 2 个反面教材（通用 AI 风格 / 编造数据），每个用 #### 标记
- 数据溯源红线必须用表格（| 数据情况 | 我的做法 |），包含 4 行`

  return prompt
}

// ─── 内部检测函数 ──────────────────────────────────────────────────

function hasHeading(content: string, num: string, keyword: string): boolean {
  const pattern = new RegExp(`^##\\s+${num}\\.?\\s*.*${keyword}`, 'im')
  return pattern.test(content)
}

function hasSection(content: string, keyword: string): boolean {
  const pattern = new RegExp(`^###\\s+.*${keyword}`, 'im')
  return pattern.test(content)
}

function countGoodExamples(content: string): number {
  const patterns = [
    /####\s*场景\s*\d/g,
    /####\s*示例\s*\d/g,
    /####\s*好的.*\d/g,
  ]

  // 在"好的回答示例"区域内计数
  const goodSection = extractSectionContent(content, '好的回答示例', '不好的回答示例')
  if (!goodSection) {
    const altSection = extractSectionContent(content, '好的回答', '不好的回答')
    if (!altSection) return 0
    return countH4Headings(altSection)
  }
  return countH4Headings(goodSection)
}

function countBadExamples(content: string): number {
  const badSection = extractSectionContent(content, '不好的回答示例', '口头禅')
    || extractSectionContent(content, '不好的回答', '口头禅')
    || extractSectionContent(content, '反面教材', '口头禅')
  if (!badSection) return 0
  return countH4Headings(badSection)
}

function countH4Headings(text: string): number {
  const matches = text.match(/^####\s+/gm)
  return matches ? matches.length : 0
}

function extractSectionContent(content: string, startKeyword: string, endKeyword: string): string | null {
  const startPattern = new RegExp(`###\\s+.*${startKeyword}`, 'i')
  const startMatch = content.match(startPattern)
  if (!startMatch || startMatch.index === undefined) return null

  const startIdx = startMatch.index
  const endPattern = new RegExp(`###\\s+.*${endKeyword}`, 'i')
  const remaining = content.slice(startIdx + startMatch[0].length)
  const endMatch = remaining.match(endPattern)

  if (endMatch && endMatch.index !== undefined) {
    return remaining.slice(0, endMatch.index)
  }
  return remaining
}

function extractCatchphrases(content: string): string[] {
  const section = extractSectionContent(content, '口头禅', '---')
  if (!section) return []
  const matches = section.match(/^[-*]\s*"(.+?)"/gm) || section.match(/^[-*]\s*「(.+?)」/gm) || section.match(/^[-*]\s+(.+)$/gm)
  if (!matches) return []
  return matches.map(m => m.replace(/^[-*]\s*["「]?/, '').replace(/["」]?\s*$/, '').trim())
}

function isGenericPhrase(phrase: string): boolean {
  const genericPatterns = [
    '注重质量', '追求卓越', '不断学习', '持续改进',
    '专业严谨', '用心服务', '精益求精', '与时俱进',
  ]
  return genericPatterns.some(p => phrase.includes(p))
}

function hasDataTraceabilityTable(content: string): boolean {
  return /数据溯源/.test(content) && /\|\s*.*数据.*\|.*做法.*\|/i.test(content)
}

function hasFirstCommitmentAboutTraceability(content: string): boolean {
  const commitSection = extractSectionContent(content, 'Commitment', '')
  if (!commitSection) return false
  const firstItem = commitSection.match(/1\.\s*\*\*(.+?)\*\*/)
  if (!firstItem) return false
  return /溯源|可追溯|出处/.test(firstItem[1])
}
