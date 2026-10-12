export interface RerankableChunk {
  file: string
  heading?: string
  content: string
  score: number
}

export interface RerankOptions {
  maxChunks?: number
  maxPerFile?: number
  similarityThreshold?: number
  minDistinctFiles?: number
}

const DEFAULT_OPTIONS: Required<RerankOptions> = {
  maxChunks: 12,
  maxPerFile: 4,
  similarityThreshold: 0.8,
  minDistinctFiles: 3,
}

function tokenizeLite(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)

  if (tokens.length > 1) return new Set(tokens)

  const compact = normalized.replace(/\s+/g, '')
  if (compact.length < 2) return new Set(tokens)

  const grams = new Set<string>()
  for (let i = 0; i < compact.length - 1; i++) {
    grams.add(compact.slice(i, i + 2))
  }
  return grams
}

export function computeJaccardSimilarity(a: string, b: string): number {
  const setA = tokenizeLite(a)
  const setB = tokenizeLite(b)
  if (setA.size === 0 || setB.size === 0) return 0

  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection++
  }
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : intersection / union
}

function chunkFingerprint(chunk: Pick<RerankableChunk, 'content'>): string {
  return chunk.content.slice(0, 300)
}

/**
 * 对检索结果做轻量去重 + 来源多样性约束。
 * 目标不是替代 cross-encoder，而是在本地低成本减少“同文件重复片段挤满 topK”的现象。
 */
export function rerankChunksWithDiversity<T extends RerankableChunk>(
  chunks: T[],
  options: RerankOptions = {},
): T[] {
  const {
    maxChunks,
    maxPerFile,
    similarityThreshold,
    minDistinctFiles,
  } = { ...DEFAULT_OPTIONS, ...options }

  const ordered = [...chunks].sort((a, b) => b.score - a.score)
  const selected: T[] = []
  const fileCounts = new Map<string, number>()
  const distinctFiles = new Set<string>()

  const canSelect = (candidate: T, relaxedFileCap = false): boolean => {
    const fingerprint = chunkFingerprint(candidate)
    for (const chosen of selected) {
      const chosenFingerprint = chunkFingerprint(chosen)
      if (computeJaccardSimilarity(fingerprint, chosenFingerprint) >= similarityThreshold) {
        return false
      }
    }
    const currentFileCount = fileCounts.get(candidate.file) ?? 0
    if (!relaxedFileCap && currentFileCount >= maxPerFile) {
      return false
    }
    return true
  }

  for (const chunk of ordered) {
    if (selected.length >= maxChunks) break
    if (!canSelect(chunk)) continue
    selected.push(chunk)
    fileCounts.set(chunk.file, (fileCounts.get(chunk.file) ?? 0) + 1)
    distinctFiles.add(chunk.file)
  }

  if (distinctFiles.size < minDistinctFiles) {
    for (const chunk of ordered) {
      if (selected.length >= maxChunks) break
      if (distinctFiles.has(chunk.file)) continue
      if (!canSelect(chunk, true)) continue
      selected.push(chunk)
      fileCounts.set(chunk.file, (fileCounts.get(chunk.file) ?? 0) + 1)
      distinctFiles.add(chunk.file)
      if (distinctFiles.size >= minDistinctFiles) break
    }
  }

  return selected
}
