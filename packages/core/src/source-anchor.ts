export interface KnowledgeSourceAnchor {
  kind: 'knowledge'
  file: string
  heading?: string
  lineStart?: number
  lineEnd?: number
}

export interface ExcelSourceAnchor {
  kind: 'excel'
  file: string
  sheet: string
  rowStart?: number
  rowEnd?: number
}

export type SourceAnchor = KnowledgeSourceAnchor | ExcelSourceAnchor

export interface ParsedSourceAnchor {
  raw: string
  anchor: SourceAnchor
}

export type SourceAnchorSegment =
  | { type: 'text'; text: string }
  | { type: 'anchor'; raw: string; anchor: SourceAnchor }

export const SOURCE_ANCHOR_REGEX = /\[来源:\s*([^\]]+)\]/g

const KNOWLEDGE_ANCHOR_PATTERN = /^knowledge\/(.+?)(?:#L(\d+)(?:-L(\d+))?)?$/
const EXCEL_ANCHOR_PATTERN = /^knowledge\/_excel\/(.+?)\.json#sheet=([^&]+?)(?:&rows=(\d+)(?:-(\d+))?)?$/

function normalizeLineForMatch(line: string): string {
  return line
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function nonEmptySnippetLines(snippet: string): string[] {
  return snippet
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 4)
}

function findMatchingLineIndex(lines: string[], candidates: string[], startIndex = 0): number | undefined {
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeLineForMatch(candidate)
    if (!normalizedCandidate) continue
    for (let i = startIndex; i < lines.length; i++) {
      const normalizedLine = normalizeLineForMatch(lines[i] ?? '')
      if (!normalizedLine) continue
      if (
        normalizedLine === normalizedCandidate
        || normalizedLine.includes(normalizedCandidate)
        || normalizedCandidate.includes(normalizedLine)
      ) {
        return i
      }
    }
  }
  return undefined
}

function estimateLineRange(markdown: string, snippet: string, heading?: string): { lineStart?: number; lineEnd?: number } {
  const lines = markdown.replace(/\r/g, '').split('\n')
  if (lines.length === 0) return {}

  const snippetLines = nonEmptySnippetLines(snippet)
  const headingCandidates = heading
    ? [heading, `# ${heading}`, `## ${heading}`, `### ${heading}`, `#### ${heading}`]
    : []
  const startCandidates = [...headingCandidates, ...snippetLines.slice(0, 4)]
  const startIdx = findMatchingLineIndex(lines, startCandidates)
  if (startIdx === undefined) return {}

  const endCandidates = [...snippetLines.slice(-3).reverse()]
  const endIdx = findMatchingLineIndex(lines, endCandidates, startIdx)
  if (endIdx === undefined) {
    const approxSpan = Math.max(0, snippetLines.length - 1)
    return {
      lineStart: startIdx + 1,
      lineEnd: Math.min(lines.length, startIdx + 1 + approxSpan),
    }
  }

  return {
    lineStart: startIdx + 1,
    lineEnd: Math.max(startIdx + 1, endIdx + 1),
  }
}

export function buildKnowledgeSourceAnchor(
  file: string,
  markdown: string,
  snippet: string,
  heading?: string,
): KnowledgeSourceAnchor {
  const estimated = estimateLineRange(markdown, snippet, heading)
  return {
    kind: 'knowledge',
    file,
    heading,
    lineStart: estimated.lineStart,
    lineEnd: estimated.lineEnd,
  }
}

export function buildWholeFileKnowledgeAnchor(file: string, markdown: string, heading?: string): KnowledgeSourceAnchor {
  const totalLines = markdown.replace(/\r/g, '').split('\n').length
  return {
    kind: 'knowledge',
    file,
    heading,
    lineStart: 1,
    lineEnd: totalLines,
  }
}

export function buildExcelSourceAnchor(
  file: string,
  sheet: string,
  rowStart?: number,
  rowEnd?: number,
): ExcelSourceAnchor {
  return {
    kind: 'excel',
    file,
    sheet,
    rowStart,
    rowEnd,
  }
}

export function formatKnowledgeSourceAnchor(anchor: KnowledgeSourceAnchor): string {
  if (anchor.lineStart && anchor.lineEnd) {
    const linePart = anchor.lineStart === anchor.lineEnd
      ? `#L${anchor.lineStart}`
      : `#L${anchor.lineStart}-L${anchor.lineEnd}`
    return `[来源: knowledge/${anchor.file}${linePart}]`
  }
  return `[来源: knowledge/${anchor.file}]`
}

export function formatExcelSourceAnchor(anchor: ExcelSourceAnchor): string {
  const rowPart = anchor.rowStart
    ? anchor.rowEnd && anchor.rowEnd !== anchor.rowStart
      ? `&rows=${anchor.rowStart}-${anchor.rowEnd}`
      : `&rows=${anchor.rowStart}`
    : ''
  return `[来源: knowledge/_excel/${anchor.file}.json#sheet=${anchor.sheet}${rowPart}]`
}

export function formatSourceAnchor(anchor: SourceAnchor): string {
  return anchor.kind === 'knowledge'
    ? formatKnowledgeSourceAnchor(anchor)
    : formatExcelSourceAnchor(anchor)
}

export function buildSourceAnchorPromptHint(): string {
  return [
    '[来源引用规则]',
    '1. 当上下文或工具结果已经给出 `[来源: ...]` 锚点时，最终回答中的关键事实、数字、政策条款、表格结论应尽量复用这些锚点。',
    '2. 不要自行编造文件名、行号或 sheet / rows；若上下文没有来源锚点，就明确说明“当前上下文未提供可引用来源”。',
    '3. Excel 数据优先引用 `knowledge/_excel/...#sheet=...&rows=...`，知识片段优先引用 `knowledge/...#Lx-Ly`。',
  ].join('\n')
}

export function extractSourceAnchors(text: string): string[] {
  return Array.from(text.matchAll(SOURCE_ANCHOR_REGEX), (match) => match[0])
}

export function parseSourceAnchor(anchorText: string): SourceAnchor | undefined {
  const raw = anchorText.trim()
  const inner = raw.match(/^\[来源:\s*(.+?)\]$/)?.[1]?.trim()
  if (!inner) return undefined

  const excelMatch = inner.match(EXCEL_ANCHOR_PATTERN)
  if (excelMatch) {
    const [, file, sheet, rowStartText, rowEndText] = excelMatch
    const rowStart = rowStartText ? Number.parseInt(rowStartText, 10) : undefined
    const rowEnd = rowEndText ? Number.parseInt(rowEndText, 10) : rowStart
    return {
      kind: 'excel',
      file,
      sheet,
      rowStart,
      rowEnd,
    }
  }

  const knowledgeMatch = inner.match(KNOWLEDGE_ANCHOR_PATTERN)
  if (knowledgeMatch) {
    const [, file, lineStartText, lineEndText] = knowledgeMatch
    const lineStart = lineStartText ? Number.parseInt(lineStartText, 10) : undefined
    const lineEnd = lineEndText ? Number.parseInt(lineEndText, 10) : lineStart
    return {
      kind: 'knowledge',
      file,
      lineStart,
      lineEnd,
    }
  }

  return undefined
}

export function extractParsedSourceAnchors(text: string): ParsedSourceAnchor[] {
  return Array.from(text.matchAll(SOURCE_ANCHOR_REGEX), (match) => {
    const raw = match[0]
    const anchor = parseSourceAnchor(raw)
    return anchor ? { raw, anchor } : undefined
  }).filter((value): value is ParsedSourceAnchor => Boolean(value))
}

export function splitTextBySourceAnchors(text: string): SourceAnchorSegment[] {
  const segments: SourceAnchorSegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(SOURCE_ANCHOR_REGEX)) {
    const raw = match[0]
    const anchor = parseSourceAnchor(raw)
    const start = match.index ?? 0
    const end = start + raw.length

    if (start > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, start) })
    }

    if (anchor) {
      segments.push({ type: 'anchor', raw, anchor })
    } else {
      segments.push({ type: 'text', text: raw })
    }

    lastIndex = end
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) })
  }

  return segments.length > 0 ? segments : [{ type: 'text', text }]
}


function isIgnorableAnchorSeparator(text: string): boolean {
  return /^[\s，,、；;：:（）()【】[\]<>《》“”"'‘’·\-–—]*$/.test(text)
}

function pushUniqueAnchor(out: string[], anchor: string): void {
  if (!out.includes(anchor)) out.push(anchor)
}

function collectSourceAnchorsFromUnknown(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    for (const anchor of extractSourceAnchors(value)) {
      const parsed = parseSourceAnchor(anchor)
      if (parsed) pushUniqueAnchor(out, formatSourceAnchor(parsed))
    }
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) collectSourceAnchorsFromUnknown(item, out)
    return
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [, nested] of entries) collectSourceAnchorsFromUnknown(nested, out)
  }
}

export interface NormalizeSourceAnchorsResult {
  text: string
  anchors: string[]
  dedupedCount: number
  normalizedCount: number
}

export interface RewriteSourceAnchorsResult {
  text: string
  keptAnchors: string[]
  removedAnchors: string[]
  removedCount: number
  rewrittenCount: number
}

export interface SourceCoverageResult {
  text: string
  answerAnchors: string[]
  availableAnchors: string[]
  addedFallback: boolean
  dedupedCount: number
  normalizedCount: number
}

export interface FilterAvailableSourceAnchorsResult extends RewriteSourceAnchorsResult {
  availableAnchors: string[]
  removedUnsupportedCount: number
}

export interface SourceAnchorReferenceBlockOptions {
  title?: string
  maxAnchors?: number
  compact?: boolean
}

export interface EnsureSourceCoverageOptions {
  fallbackNote?: string
  minTextLength?: number
  appendReferenceBlock?: boolean
  maxFallbackAnchors?: number
}

const FACTUAL_CUE_REGEX = /(?:\d|%|同比|环比|增长|下降|提升|减少|效率|销量|收入|利润|政策|指标|参数|机型|数据|结论|表|图|sheet|rows?|line|行号)/i
const DEFAULT_SOURCE_FALLBACK_NOTE = '（当前回答未直接标注来源；如需可追溯出处，请继续追问“请带来源重答”。）'
const EXISTING_SOURCE_FALLBACK_REGEX = /未直接标注来源|未提供可引用来源|请带来源重答/

export function normalizeSourceAnchorsInText(text: string): NormalizeSourceAnchorsResult {
  const segments = splitTextBySourceAnchors(text)
  const anchors: string[] = []
  const out: string[] = []
  let pendingText = ''
  let lastAnchor: string | undefined
  let dedupedCount = 0
  let normalizedCount = 0

  const flushPendingText = (): void => {
    if (!pendingText) return
    out.push(pendingText)
    pendingText = ''
  }

  for (const segment of segments) {
    if (segment.type === 'text') {
      pendingText += segment.text
      continue
    }

    const normalizedAnchor = formatSourceAnchor(segment.anchor)
    normalizedCount += normalizedAnchor === segment.raw ? 0 : 1
    pushUniqueAnchor(anchors, normalizedAnchor)

    if (lastAnchor === normalizedAnchor && isIgnorableAnchorSeparator(pendingText)) {
      pendingText = ''
      dedupedCount += 1
      continue
    }

    flushPendingText()
    out.push(normalizedAnchor)
    lastAnchor = normalizedAnchor
  }

  flushPendingText()

  return {
    text: out.join(''),
    anchors,
    dedupedCount,
    normalizedCount,
  }
}

function cleanupTextAfterAnchorRewrite(text: string): string {
  return text
    .replace(/[ \t]+([，,、；;：:。！？])/g, '$1')
    .replace(/([（(])\s+([^)）])/g, '$1$2')
    .replace(/\s+([)）])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

export function rewriteSourceAnchorsInText(
  text: string,
  mapper: (anchor: SourceAnchor, raw: string) => string | undefined,
): RewriteSourceAnchorsResult {
  const segments = splitTextBySourceAnchors(text)
  const keptAnchors: string[] = []
  const removedAnchors: string[] = []
  const out: string[] = []
  let rewrittenCount = 0

  for (const segment of segments) {
    if (segment.type === 'text') {
      out.push(segment.text)
      continue
    }

    const mapped = mapper(segment.anchor, segment.raw)
    const normalizedRaw = formatSourceAnchor(segment.anchor)
    if (!mapped) {
      pushUniqueAnchor(removedAnchors, normalizedRaw)
      continue
    }

    const parsedMapped = parseSourceAnchor(mapped)
    const normalizedMapped = parsedMapped ? formatSourceAnchor(parsedMapped) : mapped

    if (normalizedMapped !== segment.raw) rewrittenCount += 1
    pushUniqueAnchor(keptAnchors, normalizedMapped)
    out.push(normalizedMapped)
  }

  return {
    text: cleanupTextAfterAnchorRewrite(out.join('')),
    keptAnchors,
    removedAnchors,
    removedCount: removedAnchors.length,
    rewrittenCount,
  }
}

export function filterSourceAnchorsInText(
  text: string,
  predicate: (anchor: SourceAnchor, raw: string) => boolean,
): RewriteSourceAnchorsResult {
  return rewriteSourceAnchorsInText(text, (anchor, raw) => (predicate(anchor, raw) ? raw : undefined))
}

export function extractSourceAnchorsFromContent(content: unknown): string[] {
  const anchors: string[] = []
  collectSourceAnchorsFromUnknown(content, anchors)
  return anchors
}

export function extractSourceAnchorsFromMessages(messages: Array<{ content: unknown }>): string[] {
  const anchors: string[] = []
  for (const message of messages) collectSourceAnchorsFromUnknown(message.content, anchors)
  return anchors
}

function rangeCovers(outerStart: number | undefined, outerEnd: number | undefined, innerStart: number | undefined, innerEnd: number | undefined): boolean {
  if (outerStart === undefined || outerEnd === undefined) return true
  if (innerStart === undefined || innerEnd === undefined) return false
  return outerStart <= innerStart && outerEnd >= innerEnd
}

export function isSourceAnchorCoveredByAvailable(answerAnchor: SourceAnchor, availableAnchor: SourceAnchor): boolean {
  if (answerAnchor.kind !== availableAnchor.kind) return false

  if (answerAnchor.kind === 'knowledge' && availableAnchor.kind === 'knowledge') {
    if (answerAnchor.file !== availableAnchor.file) return false
    return rangeCovers(availableAnchor.lineStart, availableAnchor.lineEnd, answerAnchor.lineStart, answerAnchor.lineEnd)
  }

  if (answerAnchor.kind === 'excel' && availableAnchor.kind === 'excel') {
    if (answerAnchor.file !== availableAnchor.file || answerAnchor.sheet !== availableAnchor.sheet) return false
    return rangeCovers(availableAnchor.rowStart, availableAnchor.rowEnd, answerAnchor.rowStart, answerAnchor.rowEnd)
  }

  return false
}

export function isSourceAnchorCoveredByAnyAvailable(answerAnchor: SourceAnchor, availableAnchors: string[]): boolean {
  const parsedAvailable = availableAnchors
    .map((anchor) => parseSourceAnchor(anchor))
    .filter((anchor): anchor is SourceAnchor => Boolean(anchor))

  return parsedAvailable.some((availableAnchor) => isSourceAnchorCoveredByAvailable(answerAnchor, availableAnchor))
}

export function normalizeAvailableSourceAnchors(anchors: string[], maxAnchors?: number): string[] {
  const normalized = Array.from(new Set(
    anchors
      .map((anchor) => parseSourceAnchor(anchor))
      .filter((anchor): anchor is SourceAnchor => Boolean(anchor))
      .map((anchor) => formatSourceAnchor(anchor))
  ))
  if (!maxAnchors || maxAnchors <= 0 || normalized.length <= maxAnchors) return normalized
  return normalized.slice(0, maxAnchors)
}

export function buildSourceAnchorReferenceBlock(
  anchors: string[],
  options: SourceAnchorReferenceBlockOptions = {},
): string {
  const normalizedAnchors = normalizeAvailableSourceAnchors(anchors, options.maxAnchors)
  if (normalizedAnchors.length === 0) return ''

  const title = options.title?.trim() || '可直接复用的来源锚点'
  if (options.compact) {
    return `${title}：${normalizedAnchors.join('；')}`
  }

  return [
    `[${title}]`,
    ...normalizedAnchors.map((anchor) => `- ${anchor}`),
  ].join('\n')
}

export function filterSourceAnchorsByAvailableContext(
  text: string,
  availableAnchors: string[],
): FilterAvailableSourceAnchorsResult {
  const normalizedAvailableAnchors = normalizeAvailableSourceAnchors(availableAnchors)
  if (normalizedAvailableAnchors.length === 0) {
    return {
      text,
      keptAnchors: [],
      removedAnchors: [],
      removedCount: 0,
      rewrittenCount: 0,
      availableAnchors: [],
      removedUnsupportedCount: 0,
    }
  }

  const filtered = filterSourceAnchorsInText(text, (answerAnchor) => (
    isSourceAnchorCoveredByAnyAvailable(answerAnchor, normalizedAvailableAnchors)
  ))

  return {
    ...filtered,
    availableAnchors: normalizedAvailableAnchors,
    removedUnsupportedCount: filtered.removedCount,
  }
}

export function ensureAnswerSourceCoverage(
  text: string,
  availableAnchors: string[],
  options: EnsureSourceCoverageOptions = {},
): SourceCoverageResult {
  const normalized = normalizeSourceAnchorsInText(text)
  const answerAnchors = normalized.anchors
  const normalizedAvailableAnchors = normalizeAvailableSourceAnchors(availableAnchors)

  const hasAvailableAnchors = normalizedAvailableAnchors.length > 0
  const hasAnswerAnchors = answerAnchors.length > 0
  const minTextLength = options.minTextLength ?? 24
  const looksFactual = FACTUAL_CUE_REGEX.test(normalized.text) || normalized.text.length >= minTextLength
  const shouldAddFallback = hasAvailableAnchors
    && !hasAnswerAnchors
    && looksFactual
    && !EXISTING_SOURCE_FALLBACK_REGEX.test(normalized.text)

  const referenceBlock = shouldAddFallback && (options.appendReferenceBlock ?? true)
    ? buildSourceAnchorReferenceBlock(normalizedAvailableAnchors, {
        title: '参考来源',
        maxAnchors: options.maxFallbackAnchors ?? 3,
        compact: true,
      })
    : ''

  const fallbackParts = [normalized.text.trimEnd()]
  if (referenceBlock) fallbackParts.push(referenceBlock)
  if (shouldAddFallback) fallbackParts.push(options.fallbackNote ?? DEFAULT_SOURCE_FALLBACK_NOTE)
  const finalText = shouldAddFallback ? fallbackParts.join('\n\n') : normalized.text

  return {
    text: finalText,
    answerAnchors,
    availableAnchors: normalizedAvailableAnchors,
    addedFallback: shouldAddFallback,
    dedupedCount: normalized.dedupedCount,
    normalizedCount: normalized.normalizedCount,
  }
}
