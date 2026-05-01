/**
 * Lightweight reference simulation for QA scenario tests.
 *
 * @author zhi.qu
 * @date 2026-04-24
 */

import type { ChatMessage } from './chat-types'
import { extractSourceAnchors, isAnchorCoveredByAvailable, parseSourceAnchor } from './source-anchor-resolver'

type ReferenceCard = {
  refIndex: number
  title: string
  subtitle: string
  clickable: boolean
  inCurrentContext: boolean
}

type AssistantSummary = {
  messageId: string
  referenceCount: number
  clickableReferenceCount: number
  currentContextReferenceCount: number
  primaryRefIndexes: number[]
  summary: {
    status: string
  }
  cards: ReferenceCard[]
}

type OpenedPreview = {
  kind: 'knowledge' | 'excel'
  anchor: string
}

export interface SimulateReferenceWorkflowOptions {
  avatarId: string
  messages: ChatMessage[]
  openRequests?: Array<{
    messageId: string
    refIndex: number
  }>
  openPrimaryByDefault?: boolean
}

export interface SimulateReferenceWorkflowResult {
  totalReferenceCount: number
  clickableReferenceCount: number
  currentContextReferenceCount: number
  assistantSummaries: AssistantSummary[]
  openedPreviews: OpenedPreview[]
}

type ResolveSourceAnchorsFn = (avatarId: string, anchors: string[]) => Promise<Array<{ anchor: string; resolved: unknown }>>

function getResolveSourceAnchors(): ResolveSourceAnchorsFn | undefined {
  const win = globalThis as unknown as {
    window?: {
      electronAPI?: {
        resolveSourceAnchors?: ResolveSourceAnchorsFn
      }
    }
  }
  return win.window?.electronAPI?.resolveSourceAnchors
}

function buildCardSubtitle(anchor: string): string {
  const parsed = parseSourceAnchor(anchor)
  if (!parsed) return anchor

  if (parsed.kind === 'knowledge') {
    if (parsed.lineStart !== undefined && parsed.lineEnd !== undefined) {
      return `knowledge/${parsed.file} · L${parsed.lineStart}-L${parsed.lineEnd}`
    }
    return `knowledge/${parsed.file}`
  }

  if (parsed.rowStart !== undefined && parsed.rowEnd !== undefined) {
    return `knowledge/_excel/${parsed.file} · sheet ${parsed.sheet} · rows ${parsed.rowStart}-${parsed.rowEnd}`
  }
  return `knowledge/_excel/${parsed.file} · sheet ${parsed.sheet}`
}

function buildCardTitle(anchor: string): string {
  const parsed = parseSourceAnchor(anchor)
  if (!parsed) return 'source'
  return parsed.kind === 'knowledge' ? parsed.file.split('/').pop() ?? parsed.file : parsed.file.split('/').pop() ?? parsed.file
}

function buildPreviewKind(anchor: string): 'knowledge' | 'excel' {
  const parsed = parseSourceAnchor(anchor)
  return parsed?.kind === 'excel' ? 'excel' : 'knowledge'
}

function collectContextAnchors(messages: ChatMessage[], assistantIndex: number): string[] {
  const contextAnchors: string[] = []
  for (let i = 0; i < assistantIndex; i++) {
    const msg = messages[i]
    if (msg.role === 'assistant') continue
    contextAnchors.push(...extractSourceAnchors(msg.content))
  }
  return contextAnchors
}

export async function simulateReferenceWorkflow(
  options: SimulateReferenceWorkflowOptions,
): Promise<SimulateReferenceWorkflowResult> {
  const openPrimaryByDefault = options.openPrimaryByDefault ?? true
  const resolver = getResolveSourceAnchors()

  const assistantSummaries: AssistantSummary[] = []
  const openedPreviews: OpenedPreview[] = []
  const explicitOpenRequests = options.openRequests ?? []

  let totalReferenceCount = 0
  let clickableReferenceCount = 0
  let currentContextReferenceCount = 0

  for (let i = 0; i < options.messages.length; i++) {
    const msg = options.messages[i]
    if (msg.role !== 'assistant') continue

    const refs = extractSourceAnchors(msg.content)
    totalReferenceCount += refs.length
    const contextAnchors = collectContextAnchors(options.messages, i)

    if (resolver && refs.length > 0) {
      await resolver(options.avatarId, refs)
    }

    const cards: ReferenceCard[] = refs.map((anchor, idx) => {
      const inCurrentContext = isAnchorCoveredByAvailable(anchor, contextAnchors)
      if (inCurrentContext) currentContextReferenceCount++
      clickableReferenceCount++
      return {
        refIndex: idx + 1,
        title: buildCardTitle(anchor),
        subtitle: buildCardSubtitle(anchor),
        clickable: true,
        inCurrentContext,
      }
    })

    const assistantCurrentCount = cards.filter((card) => card.inCurrentContext).length
    const primaryRefIndexes = cards.length > 0 ? [cards[0].refIndex] : []

    assistantSummaries.push({
      messageId: msg.id,
      referenceCount: cards.length,
      clickableReferenceCount: cards.length,
      currentContextReferenceCount: assistantCurrentCount,
      primaryRefIndexes,
      summary: {
        status: assistantCurrentCount === cards.length ? 'all-current-context' : 'partial-or-none',
      },
      cards,
    })

    const requested = explicitOpenRequests.filter((request) => request.messageId === msg.id)
    if (requested.length > 0) {
      for (const request of requested) {
        const anchor = refs[request.refIndex - 1]
        if (!anchor) continue
        openedPreviews.push({ kind: buildPreviewKind(anchor), anchor })
      }
      continue
    }

    if (openPrimaryByDefault && refs.length > 0) {
      openedPreviews.push({ kind: buildPreviewKind(refs[0]), anchor: refs[0] })
    }
  }

  return {
    totalReferenceCount,
    clickableReferenceCount,
    currentContextReferenceCount,
    assistantSummaries,
    openedPreviews,
  }
}
