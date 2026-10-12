import path from 'path'

export interface KnowledgeLinkEntry {
  file: string
  content: string
}

export type LinkGraph = Record<string, string[]>

export interface LinkedFileCandidate {
  file: string
  depth: number
  relationCount: number
}

export interface ExpandLinkedFilesOptions {
  maxDepth?: number
  maxFiles?: number
}

export interface SelectRelevantSnippetOptions {
  maxChars?: number
  maxSections?: number
}

const DEFAULT_EXPAND_OPTIONS: Required<ExpandLinkedFilesOptions> = {
  maxDepth: 1,
  maxFiles: 6,
}

const DEFAULT_SNIPPET_OPTIONS: Required<SelectRelevantSnippetOptions> = {
  maxChars: 700,
  maxSections: 2,
}

function normalizePosix(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown
  const end = markdown.indexOf('\n---', 4)
  if (end === -1) return markdown
  return markdown.slice(end + 4).replace(/^\s+/, '')
}

function normalizeRelativeKnowledgePath(currentFile: string, target: string): string | null {
  const withoutAnchor = target.split('#')[0]?.trim()
  if (!withoutAnchor) return null

  let normalized = normalizePosix(withoutAnchor)
  if (normalized.startsWith('knowledge/')) {
    normalized = normalized.slice('knowledge/'.length)
  } else if (normalized.startsWith('./') || normalized.startsWith('../')) {
    const currentDir = path.posix.dirname(normalizePosix(currentFile))
    normalized = path.posix.normalize(path.posix.join(currentDir, normalized))
  }

  normalized = normalized.replace(/^\.\//, '')
  if (!normalized.endsWith('.md')) return null
  if (normalized.startsWith('../')) return null
  return normalized
}

function buildBasenameMap(files: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const file of files) {
    const base = path.posix.basename(normalizePosix(file), path.posix.extname(file)).toLowerCase()
    if (!map.has(base)) map.set(base, [])
    map.get(base)!.push(normalizePosix(file))
  }
  return map
}

export function extractExplicitLinks(currentFile: string, markdown: string, knownFiles: string[]): string[] {
  const current = normalizePosix(currentFile)
  const normalizedKnown = knownFiles.map(normalizePosix)
  const knownSet = new Set(normalizedKnown)
  const basenameMap = buildBasenameMap(normalizedKnown)
  const found = new Set<string>()

  const addCandidate = (candidate: string | null): void => {
    if (!candidate || candidate === current || !knownSet.has(candidate)) return
    found.add(candidate)
  }

  const markdownLinkRegex = /\[[^\]]*\]\(([^)]+)\)/g
  for (const match of markdown.matchAll(markdownLinkRegex)) {
    addCandidate(normalizeRelativeKnowledgePath(current, match[1] ?? ''))
  }

  const inlineFileRegex = /@file:([^\s)\]]+)/g
  for (const match of markdown.matchAll(inlineFileRegex)) {
    addCandidate(normalizeRelativeKnowledgePath(current, match[1] ?? ''))
  }

  const wikiLinkRegex = /\[\[([^\]|#]+)(?:#[^\]]+)?(?:\|[^\]]+)?\]\]/g
  for (const match of markdown.matchAll(wikiLinkRegex)) {
    const raw = (match[1] ?? '').trim()
    if (!raw) continue
    const normalized = raw.endsWith('.md') ? raw.slice(0, -3) : raw
    const hits = basenameMap.get(normalized.toLowerCase())
    if (hits && hits.length === 1) found.add(hits[0])
  }

  return Array.from(found).sort()
}

export function buildKnowledgeLinkGraph(entries: KnowledgeLinkEntry[]): LinkGraph {
  const files = entries.map((entry) => normalizePosix(entry.file))
  const graph: LinkGraph = {}
  for (const entry of entries) {
    const file = normalizePosix(entry.file)
    graph[file] = extractExplicitLinks(file, entry.content, files)
  }
  return graph
}

function buildReverseGraph(graph: LinkGraph): LinkGraph {
  const reverse: LinkGraph = {}
  for (const [source, targets] of Object.entries(graph)) {
    if (!reverse[source]) reverse[source] = []
    for (const target of targets) {
      if (!reverse[target]) reverse[target] = []
      reverse[target].push(source)
    }
  }
  return reverse
}

export function expandLinkedFiles(
  graph: LinkGraph,
  seedFiles: string[],
  options: ExpandLinkedFilesOptions = {},
): LinkedFileCandidate[] {
  const { maxDepth, maxFiles } = { ...DEFAULT_EXPAND_OPTIONS, ...options }
  const normalizedSeeds = Array.from(new Set(seedFiles.map(normalizePosix)))
  const seedSet = new Set(normalizedSeeds)
  const reverse = buildReverseGraph(graph)
  const queue: Array<{ file: string; depth: number }> = normalizedSeeds.map((file) => ({ file, depth: 0 }))
  const seenDepth = new Map<string, number>()
  const relationCount = new Map<string, number>()

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth >= maxDepth) continue
    const neighbors = new Set<string>([
      ...(graph[current.file] ?? []),
      ...(reverse[current.file] ?? []),
    ])
    for (const next of neighbors) {
      if (seedSet.has(next)) continue
      relationCount.set(next, (relationCount.get(next) ?? 0) + 1)
      const nextDepth = current.depth + 1
      const previousDepth = seenDepth.get(next)
      if (previousDepth === undefined || nextDepth < previousDepth) {
        seenDepth.set(next, nextDepth)
        queue.push({ file: next, depth: nextDepth })
      }
    }
  }

  return Array.from(seenDepth.entries())
    .map(([file, depth]) => ({
      file,
      depth,
      relationCount: relationCount.get(file) ?? 1,
    }))
    .sort((a, b) => a.depth - b.depth || b.relationCount - a.relationCount || a.file.localeCompare(b.file))
    .slice(0, maxFiles)
}

function keywordTokens(text: string): string[] {
  const lower = stripFrontmatter(text).toLowerCase()
  const matches = lower.match(/[\p{Script=Han}\p{L}\p{N}]{2,}/gu) ?? []
  return Array.from(new Set(matches.map((token) => token.trim()).filter(Boolean)))
}

function trimToLength(text: string, maxChars: number): string {
  const compact = text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (compact.length <= maxChars) return compact
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

interface MarkdownSection {
  heading?: string
  content: string
}

function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const body = stripFrontmatter(markdown)
  const lines = body.split(/\r?\n/)
  const sections: MarkdownSection[] = []
  let currentHeading: string | undefined
  let buffer: string[] = []

  const flush = (): void => {
    const content = buffer.join('\n').trim()
    if (content) sections.push({ heading: currentHeading, content })
    buffer = []
  }

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/)
    if (headingMatch) {
      flush()
      currentHeading = headingMatch[1]?.trim()
      continue
    }
    buffer.push(line)
  }
  flush()

  if (sections.length > 0) return sections
  return [{ content: body.trim() }].filter((section) => section.content.length > 0)
}

export function selectRelevantSnippet(
  markdown: string,
  query: string,
  options: SelectRelevantSnippetOptions = {},
): { heading?: string; content: string } {
  const { maxChars, maxSections } = { ...DEFAULT_SNIPPET_OPTIONS, ...options }
  const sections = splitMarkdownSections(markdown)
  if (sections.length === 0) return { content: '' }

  const queryTokens = keywordTokens(query)
  const scored = sections.map((section, index) => {
    const haystack = `${section.heading ?? ''}\n${section.content}`.toLowerCase()
    const score = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0)
    return { ...section, score, index }
  })

  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  const best = scored.filter((section) => section.content.trim().length > 0).slice(0, Math.max(1, maxSections))
  const combined = best.map((section) => section.content).join('\n\n')

  return {
    heading: best[0]?.heading,
    content: trimToLength(combined || sections[0].content, maxChars),
  }
}
