import fs from 'fs'
import path from 'path'
import { extractFrontmatterField, extractBetweenDelimiters, extractListItems } from '@soul/core'

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

  // 读取所有测试用例
  getTestCases(avatarId: string): TestCase[] {
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
    const casesPath = path.join(this.avatarsPath, avatarId, 'tests', 'cases')

    if (!fs.existsSync(casesPath)) {
      return undefined
    }

    const files = fs.readdirSync(casesPath).filter(f => f.endsWith('.md'))

    for (const file of files) {
      const filePath = path.join(casesPath, file)
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const parsed = this.parseTestCase(content, filePath)
        if (parsed && parsed.id === caseId) {
          return parsed
        }
      } catch (error) {
        console.error(`解析测试用例失败: ${filePath}`, error)
      }
    }

    return undefined
  }

  // 创建测试用例
  createTestCase(avatarId: string, testCase: Omit<TestCase, 'filePath'>): string {
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
    const casesPath = path.join(this.avatarsPath, avatarId, 'tests', 'cases')
    const filePath = path.join(casesPath, `${caseId}.md`)

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }

  // 保存测试报告
  saveTestReport(avatarId: string, report: TestReport): string {
    const reportsPath = path.join(this.avatarsPath, avatarId, 'tests', 'reports')
    if (!fs.existsSync(reportsPath)) {
      fs.mkdirSync(reportsPath, { recursive: true })
    }

    const fileName = `report-${Date.now()}.json`
    const filePath = path.join(reportsPath, fileName)
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8')
    return fileName
  }

  // 获取最近的测试报告
  getLatestReport(avatarId: string): TestReport | null {
    const reportsPath = path.join(this.avatarsPath, avatarId, 'tests', 'reports')
    if (!fs.existsSync(reportsPath)) return null

    const files = fs.readdirSync(reportsPath)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()

    if (files.length === 0) return null

    const content = fs.readFileSync(path.join(reportsPath, files[0]), 'utf-8')
    return JSON.parse(content) as TestReport
  }

  // 获取所有测试报告列表
  getReportList(avatarId: string): Array<{ fileName: string; timestamp: number; passed: number; total: number }> {
    const reportsPath = path.join(this.avatarsPath, avatarId, 'tests', 'reports')
    if (!fs.existsSync(reportsPath)) return []

    return fs.readdirSync(reportsPath)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const content = fs.readFileSync(path.join(reportsPath, f), 'utf-8')
        const report = JSON.parse(content) as TestReport
        return {
          fileName: f,
          timestamp: report.timestamp,
          passed: report.passedCases,
          total: report.totalCases,
        }
      })
      .sort((a, b) => b.timestamp - a.timestamp)
  }

  // 解析测试用例 Markdown
  private parseTestCase(content: string, filePath: string): TestCase | null {
    const id = extractFrontmatterField(content, 'id')
    const name = extractFrontmatterField(content, 'name')
    const category = extractFrontmatterField(content, 'category') || '未分类'
    const timeout = parseInt(extractFrontmatterField(content, 'timeout') || '60', 10)

    if (!id || !name) return null

    const body = content.slice(content.indexOf('---', 3) + 3)

    const prompt = extractBetweenDelimiters(body, 'PROMPT:', '---').trim()
    const rubricsSection = extractBetweenDelimiters(body, 'RUBRICS:', '---')
    const rubrics = extractListItems(rubricsSection)
    const mustContainSection = extractBetweenDelimiters(body, 'MUST_CONTAIN:', '---')
    const mustContain = mustContainSection.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    const mustNotContainSection = extractBetweenDelimiters(body, 'MUST_NOT_CONTAIN:', '---')
    const mustNotContain = mustNotContainSection.split('\n').map(l => l.trim()).filter(l => l.length > 0)

    return { id, name, category, timeout, prompt, rubrics, mustContain, mustNotContain, filePath }
  }

  /** BUG1 修复：将 TestCase 对象序列化为 Markdown 格式 */
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
    lines.push('---')
    lines.push(testCase.prompt)
    lines.push('---')
    lines.push('')
    lines.push('RUBRICS:')
    lines.push('---')
    testCase.rubrics.forEach(r => lines.push(`- ${r}`))
    lines.push('---')
    lines.push('')
    lines.push('MUST_CONTAIN:')
    lines.push('---')
    testCase.mustContain.forEach(m => lines.push(m))
    lines.push('---')
    lines.push('')
    lines.push('MUST_NOT_CONTAIN:')
    lines.push('---')
    testCase.mustNotContain.forEach(m => lines.push(m))
    lines.push('---')
    return lines.join('\n')
  }
}
