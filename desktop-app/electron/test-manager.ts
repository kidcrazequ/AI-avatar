import fs from 'fs'
import path from 'path'
import { extractFrontmatterField, extractBetweenDelimiters, extractListItems, assertSafeSegment } from '@soul/core'

export interface TestCase {
  id: string
  name: string
  category: string
  timeout: number
  prompt: string
  rubrics: string[]
  mustContain: string[]
  mustNotContain: string[]
  filePath: string
}

export interface TestResult {
  caseId: string
  caseName: string
  passed: boolean
  score: number
  response: string
  feedback: string
  timestamp: number
  duration: number
}

export interface TestReport {
  avatarId: string
  totalCases: number
  passedCases: number
  failedCases: number
  averageScore: number
  results: TestResult[]
  timestamp: number
  duration: number
}

export class TestManager {
  private avatarsPath: string

  constructor(avatarsPath: string) {
    this.avatarsPath = avatarsPath
  }

  getTestCases(avatarId: string): TestCase[] {
    assertSafeSegment(avatarId, '分身ID')
    const casesPath = path.join(this.avatarsPath, avatarId, 'tests', 'cases')

    if (!fs.existsSync(casesPath)) {
      return []
    }

    const files = fs.readdirSync(casesPath).filter(f => f.endsWith('.md'))
    const cases: TestCase[] = []

    for (const file of files) {
      const filePath = path.join(casesPath, file)
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const parsed = this.parseTestCase(content, filePath)
        if (parsed) {
          cases.push(parsed)
        }
      } catch (error) {
        console.error(`解析测试用例失败: ${filePath}`, error)
      }
    }

    return cases.sort((a, b) => a.id.localeCompare(b.id))
  }

  getTestCase(avatarId: string, caseId: string): TestCase | undefined {
    assertSafeSegment(avatarId, '分身ID')
    assertSafeSegment(caseId, '测试用例ID')
    const casesPath = path.join(this.avatarsPath, avatarId, 'tests', 'cases')
    const filePath = path.join(casesPath, `${caseId}.md`)

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return this.parseTestCase(content, filePath) ?? undefined
    } catch {
      return undefined
    }
  }

  createTestCase(avatarId: string, testCase: Omit<TestCase, 'filePath'>): string {
    assertSafeSegment(avatarId, '分身ID')
    assertSafeSegment(testCase.id, '测试用例ID')
    const casesPath = path.join(this.avatarsPath, avatarId, 'tests', 'cases')
    if (!fs.existsSync(casesPath)) {
      fs.mkdirSync(casesPath, { recursive: true })
    }

    const fileName = `${testCase.id}.md`
    const filePath = path.join(casesPath, fileName)
    const content = this.serializeTestCase(testCase)
    fs.writeFileSync(filePath, content, 'utf-8')
    return fileName
  }

  deleteTestCase(avatarId: string, caseId: string): void {
    assertSafeSegment(avatarId, '分身ID')
    assertSafeSegment(caseId, '测试用例ID')
    const casesPath = path.join(this.avatarsPath, avatarId, 'tests', 'cases')
    const filePath = path.join(casesPath, `${caseId}.md`)

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }

  saveTestReport(avatarId: string, report: TestReport): string {
    assertSafeSegment(avatarId, '分身ID')
    const reportsPath = path.join(this.avatarsPath, avatarId, 'tests', 'reports')
    if (!fs.existsSync(reportsPath)) {
      fs.mkdirSync(reportsPath, { recursive: true })
    }

    const fileName = `report-${Date.now()}.json`
    const filePath = path.join(reportsPath, fileName)
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8')
    return filePath
  }

  // 获取最近的测试报告
  getLatestReport(avatarId: string): TestReport | null {
    assertSafeSegment(avatarId, '分身ID')
    const reportsPath = path.join(this.avatarsPath, avatarId, 'tests', 'reports')
    if (!fs.existsSync(reportsPath)) return null

    const files = fs.readdirSync(reportsPath)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()

    if (files.length === 0) return null

    try {
      const content = fs.readFileSync(path.join(reportsPath, files[0]), 'utf-8')
      return JSON.parse(content) as TestReport
    } catch (err) {
      console.error(`[TestManager] 解析报告失败: ${files[0]}`, err instanceof Error ? err.message : String(err))
      return null
    }
  }

  // 获取所有测试报告列表
  getReportList(avatarId: string): Array<{ fileName: string; timestamp: number; passed: number; total: number }> {
    assertSafeSegment(avatarId, '分身ID')
    const reportsPath = path.join(this.avatarsPath, avatarId, 'tests', 'reports')
    if (!fs.existsSync(reportsPath)) return []

    const results: Array<{ fileName: string; timestamp: number; passed: number; total: number }> = []
    for (const f of fs.readdirSync(reportsPath).filter(f => f.endsWith('.json'))) {
      // 文件名格式为 report-{timestamp}.json，直接从文件名提取时间戳
      // 即使 JSON 解析失败也能保留排序依据
      const tsMatch = f.match(/^report-(\d+)\.json$/)
      const timestamp = tsMatch ? parseInt(tsMatch[1], 10) : 0

      // 仍需读文件获取 passed/total，但跳过时间戳读取
      try {
        const content = fs.readFileSync(path.join(reportsPath, f), 'utf-8')
        const report = JSON.parse(content) as TestReport
        results.push({
          fileName: f,
          timestamp: timestamp || report.timestamp,
          passed: report.passedCases,
          total: report.totalCases,
        })
      } catch (err) {
        console.error(`[TestManager] 解析报告失败: ${f}`, err instanceof Error ? err.message : String(err))
      }
    }
    return results.sort((a, b) => b.timestamp - a.timestamp)
  }

  // 解析测试用例 Markdown
  private parseTestCase(content: string, filePath: string): TestCase | null {
    const id = extractFrontmatterField(content, 'id')
    const name = extractFrontmatterField(content, 'name')
    const category = extractFrontmatterField(content, 'category') || '未分类'
    const rawTimeout = parseInt(extractFrontmatterField(content, 'timeout') || '60', 10)
    const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 60

    if (!id || !name) return null

    const secondDash = content.indexOf('---', 3)
    if (secondDash === -1) return null
    const body = content.slice(secondDash + 3)

    const prompt = extractBetweenDelimiters(body, 'PROMPT:', '---').trim()
    const rubricsSection = extractBetweenDelimiters(body, 'RUBRICS:', '---')
    const rubrics = extractListItems(rubricsSection)
    const mustContainSection = extractBetweenDelimiters(body, 'MUST_CONTAIN:', '---')
    const mustContain = mustContainSection.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    const mustNotContainSection = extractBetweenDelimiters(body, 'MUST_NOT_CONTAIN:', '---')
    const mustNotContain = mustNotContainSection.split('\n').map(l => l.trim()).filter(l => l.length > 0)

    return { id, name, category, timeout, prompt, rubrics, mustContain, mustNotContain, filePath }
  }

  /**
   * 将 TestCase 序列化为 Markdown 格式。
   * 格式需与 parseTestCase 的 extractBetweenDelimiters(body, 'SECTION:', '---') 兼容：
   * 每个 section 的内容在 "SECTION:" 之后、下一个 "---" 之前。
   */
  private serializeTestCase(testCase: Omit<TestCase, 'filePath'>): string {
    const lines: string[] = []
    lines.push('---')
    lines.push(`id: ${testCase.id}`)
    lines.push(`name: ${testCase.name}`)
    lines.push(`category: ${testCase.category}`)
    lines.push(`timeout: ${testCase.timeout}`)
    lines.push('---')
    lines.push('')
    lines.push('PROMPT:')
    lines.push(testCase.prompt)
    lines.push('---')
    lines.push('')
    lines.push('RUBRICS:')
    testCase.rubrics.forEach(r => lines.push(`- ${r}`))
    lines.push('---')
    lines.push('')
    lines.push('MUST_CONTAIN:')
    testCase.mustContain.forEach(m => lines.push(m))
    lines.push('---')
    lines.push('')
    lines.push('MUST_NOT_CONTAIN:')
    testCase.mustNotContain.forEach(m => lines.push(m))
    lines.push('---')
    return lines.join('\n')
  }
}
