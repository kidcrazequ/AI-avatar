/**
 * Source anchor validation helpers for renderer-side workflows.
 *
 * @author zhi.qu
 * @date 2026-04-24
 */

export interface ValidateAnswerSourceAnchorsOptions {
  availableAnchors?: string[]
}

export interface ValidateAnswerSourceAnchorsResult {
  text: string
  validAnchors: string[]
  invalidAnchors: string[]
  unsupportedAnchors: string[]
  removedUnsupportedCount: number
}

type ParsedKnowledgeAnchor = {
  kind: 'knowledge'
  file: string
  lineStart?: number
  lineEnd?: number
}

type ParsedExcelAnchor = {
  kind: 'excel'
  file: string
  sheet: string
  rowStart?: number
  rowEnd?: number
}

type ParsedAnchor = ParsedKnowledgeAnchor | ParsedExcelAnchor

type ResolveSourceAnchorsFn = (avatarId: string, anchors: string[]) => Promise<Array<{ anchor: string; resolved: unknown }>>

const resolvedSourceAnchorCache = new Map<string, unknown>()
const SOURCE_ANCHOR_REGEX = /\[来源:\s*[^\]]+\]/g

function normalizeAnchor(anchor: string): string {
  return anchor.trim()
}

function parseInteger(input: string | undefined): number | undefined {
  if (!input) return undefined
  const value = Number.parseInt(input, 10)
  return Number.isNaN(value) ? undefined : value
}

export function extractSourceAnchors(text: string): string[] {
  const matches = text.match(SOURCE_ANCHOR_REGEX) ?? []
  const deduped = new Set<string>()
  for (const match of matches) deduped.add(normalizeAnchor(match))
  return Array.from(deduped)
}

export function parseSourceAnchor(anchor: string): ParsedAnchor | undefined {
  const normalized = normalizeAnchor(anchor)
  const m = normalized.match(/^\[来源:\s*(.+)\]$/)
  if (!m) return undefined
  const payload = m[1]

  const knowledge = payload.match(/^knowledge\/(.+?)#L(\d+)(?:-L?(\d+))?$/)
  if (knowledge) {
    const lineStart = parseInteger(knowledge[2])
    const lineEnd = parseInteger(knowledge[3]) ?? lineStart
    return {
      kind: 'knowledge',
      file: knowledge[1],
      lineStart,
      lineEnd,
    }
  }

  const excel = payload.match(/^knowledge\/_excel\/(.+?)#sheet=([^&]+)(?:&rows=(\d+)(?:-(\d+))?)?$/)
  if (excel) {
    const rowStart = parseInteger(excel[3])
    const rowEnd = parseInteger(excel[4]) ?? rowStart
    return {
      kind: 'excel',
      file: excel[1],
      sheet: excel[2],
      rowStart,
      rowEnd,
    }
  }

  return undefined
}

function isRangeCovered(
  availableStart: number | undefined,
  availableEnd: number | undefined,
  targetStart: number | undefined,
  targetEnd: number | undefined,
): boolean {
  if (availableStart === undefined || availableEnd === undefined) return true
  if (targetStart === undefined || targetEnd === undefined) return true
  return targetStart >= availableStart && targetEnd <= availableEnd
}

export function isAnchorCoveredByAvailable(anchor: string, availableAnchors: string[]): boolean {
  if (availableAnchors.length === 0) return true

  const parsedAnchor = parseSourceAnchor(anchor)
  if (!parsedAnchor) return availableAnchors.includes(anchor)

  for (const candidate of availableAnchors) {
    const parsedCandidate = parseSourceAnchor(candidate)
    if (!parsedCandidate || parsedCandidate.kind !== parsedAnchor.kind) continue

    if (parsedAnchor.kind === 'knowledge' && parsedCandidate.kind === 'knowledge') {
      if (parsedAnchor.file !== parsedCandidate.file) continue
      if (isRangeCovered(parsedCandidate.lineStart, parsedCandidate.lineEnd, parsedAnchor.lineStart, parsedAnchor.lineEnd)) {
        return true
      }
      continue
    }

    if (parsedAnchor.kind === 'excel' && parsedCandidate.kind === 'excel') {
      if (parsedAnchor.file !== parsedCandidate.file || parsedAnchor.sheet !== parsedCandidate.sheet) continue
      if (isRangeCovered(parsedCandidate.rowStart, parsedCandidate.rowEnd, parsedAnchor.rowStart, parsedAnchor.rowEnd)) {
        return true
      }
    }
  }

  return false
}

function stripUnsupportedAnchors(text: string, unsupportedAnchors: string[]): string {
  if (unsupportedAnchors.length === 0) return text
  let next = text
  for (const anchor of unsupportedAnchors) {
    next = next.split(anchor).join('')
  }
  return next.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

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

export function clearResolvedSourceAnchorCache(): void {
  resolvedSourceAnchorCache.clear()
}

export async function validateAnswerSourceAnchors(
  avatarId: string,
  text: string,
  options: ValidateAnswerSourceAnchorsOptions = {},
): Promise<ValidateAnswerSourceAnchorsResult> {
  const anchors = extractSourceAnchors(text)
  const availableAnchors = (options.availableAnchors ?? []).map(normalizeAnchor)

  const resolver = getResolveSourceAnchors()
  const toResolve = anchors.filter((anchor) => !resolvedSourceAnchorCache.has(`${avatarId}:${anchor}`))
  if (resolver && toResolve.length > 0) {
    const resolvedEntries = await resolver(avatarId, toResolve)
    for (const entry of resolvedEntries) {
      resolvedSourceAnchorCache.set(`${avatarId}:${normalizeAnchor(entry.anchor)}`, entry.resolved)
    }
  }

  const invalidAnchors: string[] = []
  const unsupportedAnchors: string[] = []
  const validAnchors: string[] = []

  for (const anchor of anchors) {
    const key = `${avatarId}:${anchor}`
    const resolved = resolvedSourceAnchorCache.get(key)
    if (resolved === null) {
      invalidAnchors.push(anchor)
      continue
    }
    if (!isAnchorCoveredByAvailable(anchor, availableAnchors)) {
      unsupportedAnchors.push(anchor)
      continue
    }
    validAnchors.push(anchor)
  }

  return {
    text: stripUnsupportedAnchors(text, unsupportedAnchors),
    validAnchors,
    invalidAnchors,
    unsupportedAnchors,
    removedUnsupportedCount: unsupportedAnchors.length,
  }
}
