import { simulateReferenceWorkflow, type SimulateReferenceWorkflowResult } from './reference-simulation'
import {
  clearResolvedSourceAnchorCache,
  validateAnswerSourceAnchors,
  type ValidateAnswerSourceAnchorsResult,
} from './source-anchor-resolver'
import type { ChatMessage } from './chat-types'

export interface ManualQaScenarioRoutingResult {
  contextStrategy: string
  toolProfile: string
  reason: string
  modelKind: 'chat' | 'vision'
  fastPath: boolean
}

export interface ManualQaScenarioResult {
  id: 'knowledge-fact' | 'excel-numeric' | 'follow-up' | 'anti-fake-citation'
  title: string
  routing?: ManualQaScenarioRoutingResult
  workflow?: {
    totalReferenceCount: number
    clickableReferenceCount: number
    currentContextReferenceCount: number
    openedPreviewKinds: string[]
    assistantSummaries: Array<{
      messageId: string
      referenceCount: number
      currentContextReferenceCount: number
      primaryRefIndexes: number[]
      summaryStatus: string
      cards: Array<{
        refIndex: number
        title: string
        subtitle: string
        clickable: boolean
        inCurrentContext: boolean
      }>
    }>
  }
  validation?: {
    removedUnsupportedCount: number
    validAnchors: string[]
    invalidAnchors: string[]
    unsupportedAnchors: string[]
    text: string
  }
}

export interface ManualQaScenarioSuiteResult {
  scenarios: ManualQaScenarioResult[]
}

type ResolveEntry = {
  anchor: string
  resolved: unknown
}

type MinimalDiagnosticSummary = {
  routing: {
    contextStrategy: string
    toolProfile: string
    reason: string
    modelKind: 'chat' | 'vision'
  }
  flags: {
    fastPath: boolean
  }
}

function inferRoutingSummary(content: string): MinimalDiagnosticSummary {
  const normalized = content.toLowerCase()
  const isExcel = /机型|月份|按月|数值|指标|总表|sheet|rows|\d{4}\s*年/.test(content)
  const isKnowledge = /政策|手册|规定|制度|依据/.test(content)
  const isImage = /图片|图像|照片|截图/.test(content)

  if (isImage) {
    return {
      routing: {
        contextStrategy: 'no-rag',
        toolProfile: 'minimal',
        reason: 'images',
        modelKind: 'vision',
      },
      flags: { fastPath: true },
    }
  }

  if (isExcel) {
    return {
      routing: {
        contextStrategy: 'excel-first',
        toolProfile: 'chart',
        reason: 'excel-structured-data',
        modelKind: 'chat',
      },
      flags: { fastPath: false },
    }
  }

  if (isKnowledge || normalized.includes('policy')) {
    return {
      routing: {
        contextStrategy: 'light-rag',
        toolProfile: 'standard',
        reason: 'factual-question',
        modelKind: 'chat',
      },
      flags: { fastPath: false },
    }
  }

  return {
    routing: {
      contextStrategy: 'no-rag',
      toolProfile: 'minimal',
      reason: 'short-or-ack',
      modelKind: 'chat',
    },
    flags: { fastPath: true },
  }
}

async function summarizeConversationCompat(content: string): Promise<MinimalDiagnosticSummary> {
  return inferRoutingSummary(content)
}

function installElectronApiMock(): void {
  const win = globalThis as unknown as {
    window: {
      electronAPI: {
        resolveSourceAnchors: (avatarId: string, anchors: string[]) => Promise<ResolveEntry[]>
        readKnowledgeFile: (avatarId: string, relativePath: string) => Promise<string>
        revealKnowledgeFile: (avatarId: string, relativePath: string) => Promise<string>
      }
    }
  }

  win.window = {
    electronAPI: {
      resolveSourceAnchors: async (_avatarId, anchors) => anchors.map((anchor) => {
        if (anchor.includes('knowledge/policy.md')) {
          return {
            anchor,
            resolved: {
              kind: 'knowledge',
              anchor,
              relativePath: 'knowledge/policy.md',
              absolutePath: '/tmp/knowledge/policy.md',
              lineStart: 10,
              lineEnd: 16,
              preview: '10: 返点审核周期为每月复核一次。',
            },
          }
        }

        if (anchor.includes('knowledge/manual.md')) {
          return {
            anchor,
            resolved: {
              kind: 'knowledge',
              anchor,
              relativePath: 'knowledge/manual.md',
              absolutePath: '/tmp/knowledge/manual.md',
              lineStart: 20,
              lineEnd: 26,
              preview: '20: 安装说明与政策问答无关。',
            },
          }
        }

        if (anchor.includes('knowledge/_excel/kpi.json')) {
          const rowMatch = anchor.match(/rows=(\d+)(?:-(\d+))?/) ?? []
          const rowStart = rowMatch[1] ? Number.parseInt(rowMatch[1], 10) : undefined
          const rowEnd = rowMatch[2] ? Number.parseInt(rowMatch[2], 10) : rowStart
          return {
            anchor,
            resolved: {
              kind: 'excel',
              anchor,
              relativePath: 'knowledge/_excel/kpi.json',
              absolutePath: '/tmp/knowledge/_excel/kpi.json',
              sheet: '总表',
              rowStart,
              rowEnd,
              previewRows: [
                { month: '2026-01', model: '215', value: 91 },
                { month: '2026-02', model: '215', value: 94 },
                { month: '2026-03', model: '215', value: 96 },
              ],
            },
          }
        }

        return { anchor, resolved: null }
      }),
      readKnowledgeFile: async (_avatarId, relativePath) => {
        if (relativePath === 'policy.md') {
          return '# 政策\n10: 返点审核周期为每月复核一次。\n11: 逾期需补充说明。\n'
        }
        if (relativePath === 'manual.md') {
          return '# 手册\n20: 安装说明与政策问答无关。\n'
        }
        if (relativePath === '_excel/kpi.json') {
          return JSON.stringify({
            file: 'kpi.json',
            sheets: {
              '总表': [
                { row: 3, month: '2026-01', model: '215', value: 91 },
                { row: 4, month: '2026-02', model: '215', value: 94 },
                { row: 5, month: '2026-03', model: '215', value: 96 },
              ],
            },
          })
        }
        return `content:${relativePath}`
      },
      revealKnowledgeFile: async (_avatarId, relativePath) => `/reveal/${relativePath}`,
    },
  }
}

export function resetManualQaScenarioEnvironment(): void {
  clearResolvedSourceAnchorCache()
  ;(globalThis as { window?: unknown }).window = undefined
}

function compactWorkflow(result: SimulateReferenceWorkflowResult): ManualQaScenarioResult['workflow'] {
  return {
    totalReferenceCount: result.totalReferenceCount,
    clickableReferenceCount: result.clickableReferenceCount,
    currentContextReferenceCount: result.currentContextReferenceCount,
    openedPreviewKinds: result.openedPreviews.map((preview) => preview.kind),
    assistantSummaries: result.assistantSummaries.map((summary) => ({
      messageId: summary.messageId,
      referenceCount: summary.referenceCount,
      currentContextReferenceCount: summary.currentContextReferenceCount,
      primaryRefIndexes: summary.primaryRefIndexes.slice(),
      summaryStatus: summary.summary.status,
      cards: summary.cards.map((card) => ({
        refIndex: card.refIndex,
        title: card.title,
        subtitle: card.subtitle,
        clickable: card.clickable,
        inCurrentContext: card.inCurrentContext,
      })),
    })),
  }
}

function compactValidation(result: ValidateAnswerSourceAnchorsResult): NonNullable<ManualQaScenarioResult['validation']> {
  return {
    removedUnsupportedCount: result.removedUnsupportedCount,
    validAnchors: result.validAnchors.slice(),
    invalidAnchors: result.invalidAnchors.slice(),
    unsupportedAnchors: result.unsupportedAnchors.slice(),
    text: result.text,
  }
}

async function runKnowledgeFactScenario(): Promise<ManualQaScenarioResult> {
  installElectronApiMock()

  const routingSummary = await summarizeConversationCompat('政策手册里关于返点审核周期是怎么规定的？')

  const messages: ChatMessage[] = [
    {
      id: 'u1',
      role: 'user',
      content: '请根据政策手册回答返点审核周期。[来源: knowledge/policy.md#L1-L20]',
    },
    {
      id: 'a1',
      role: 'assistant',
      content: '返点审核周期为每月复核一次。[来源: knowledge/policy.md#L10-L16]',
    },
  ]

  const workflow = await simulateReferenceWorkflow({
    avatarId: 'avatar-a',
    messages,
  })

  return {
    id: 'knowledge-fact',
    title: '知识库事实问答',
    routing: {
      contextStrategy: routingSummary.routing.contextStrategy,
      toolProfile: routingSummary.routing.toolProfile,
      reason: routingSummary.routing.reason,
      modelKind: routingSummary.routing.modelKind,
      fastPath: routingSummary.flags.fastPath,
    },
    workflow: compactWorkflow(workflow),
  }
}

async function runExcelNumericScenario(): Promise<ManualQaScenarioResult> {
  installElectronApiMock()

  const routingSummary = await summarizeConversationCompat('请给出 215 机型 2026 年 1 月到 3 月分别是多少，并按月列出具体数值。')

  const messages: ChatMessage[] = [
    {
      id: 'u1',
      role: 'user',
      content: '请给出 215 机型 2026 年 1 月到 3 月效率分别是多少。[来源: knowledge/_excel/kpi.json#sheet=总表&rows=1-12]',
    },
    {
      id: 't1',
      role: 'tool',
      content: 'query_excel 返回 215 机型结果。[来源: knowledge/_excel/kpi.json#sheet=总表&rows=3-5]',
    },
    {
      id: 'a1',
      role: 'assistant',
      content: '215 机型 1-3 月分别为 91、94、96。[来源: knowledge/_excel/kpi.json#sheet=总表&rows=3-5]',
    },
  ]

  const workflow = await simulateReferenceWorkflow({
    avatarId: 'avatar-a',
    messages,
    openRequests: [{ messageId: 'a1', refIndex: 1 }],
  })

  return {
    id: 'excel-numeric',
    title: 'Excel 精确数值问答',
    routing: {
      contextStrategy: routingSummary.routing.contextStrategy,
      toolProfile: routingSummary.routing.toolProfile,
      reason: routingSummary.routing.reason,
      modelKind: routingSummary.routing.modelKind,
      fastPath: routingSummary.flags.fastPath,
    },
    workflow: compactWorkflow(workflow),
  }
}

async function runFollowUpScenario(): Promise<ManualQaScenarioResult> {
  installElectronApiMock()

  const messages: ChatMessage[] = [
    {
      id: 'u1',
      role: 'user',
      content: '先看 215 机型 1-3 月总表。[来源: knowledge/_excel/kpi.json#sheet=总表&rows=1-12]',
    },
    {
      id: 't1',
      role: 'tool',
      content: 'query_excel 首轮结果。[来源: knowledge/_excel/kpi.json#sheet=总表&rows=3-5]',
    },
    {
      id: 'a1',
      role: 'assistant',
      content: '1-3 月分别为 91、94、96。[来源: knowledge/_excel/kpi.json#sheet=总表&rows=3-5]',
    },
    {
      id: 'u2',
      role: 'user',
      content: '那继续看 2 月单独数值，并沿用同一张总表来源。[来源: knowledge/_excel/kpi.json#sheet=总表&rows=1-12]',
    },
    {
      id: 't2',
      role: 'tool',
      content: 'query_excel 第二轮只看 2 月。[来源: knowledge/_excel/kpi.json#sheet=总表&rows=4-4]',
    },
    {
      id: 'a2',
      role: 'assistant',
      content: '2 月单独数值为 94。[来源: knowledge/_excel/kpi.json#sheet=总表&rows=4-4]',
    },
  ]

  const workflow = await simulateReferenceWorkflow({
    avatarId: 'avatar-a',
    messages,
    openPrimaryByDefault: false,
  })

  return {
    id: 'follow-up',
    title: '连续两轮追问',
    workflow: compactWorkflow(workflow),
  }
}

async function runAntiFakeCitationScenario(): Promise<ManualQaScenarioResult> {
  installElectronApiMock()

  const answerText = '返点审核周期为每月复核一次。[来源: knowledge/policy.md#L10-L16] 另外还有安装要求。[来源: knowledge/manual.md#L20-L26]'
  const validation = await validateAnswerSourceAnchors('avatar-a', answerText, {
    availableAnchors: ['[来源: knowledge/policy.md#L1-L20]'],
  })

  const messages: ChatMessage[] = [
    {
      id: 'u1',
      role: 'user',
      content: '只根据政策手册回答返点审核周期。[来源: knowledge/policy.md#L1-L20]',
    },
    {
      id: 'a1',
      role: 'assistant',
      content: validation.text,
    },
  ]

  const workflow = await simulateReferenceWorkflow({
    avatarId: 'avatar-a',
    messages,
    openPrimaryByDefault: false,
  })

  return {
    id: 'anti-fake-citation',
    title: '诱导系统乱引用',
    validation: compactValidation(validation),
    workflow: compactWorkflow(workflow),
  }
}

export async function runManualQaScenarioSuite(): Promise<ManualQaScenarioSuiteResult> {
  resetManualQaScenarioEnvironment()
  const scenarios: ManualQaScenarioResult[] = []

  scenarios.push(await runKnowledgeFactScenario())
  resetManualQaScenarioEnvironment()

  scenarios.push(await runExcelNumericScenario())
  resetManualQaScenarioEnvironment()

  scenarios.push(await runFollowUpScenario())
  resetManualQaScenarioEnvironment()

  scenarios.push(await runAntiFakeCitationScenario())
  resetManualQaScenarioEnvironment()

  return { scenarios }
}
