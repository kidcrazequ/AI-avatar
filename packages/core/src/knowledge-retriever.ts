import fs from 'fs'
import path from 'path'
import { collectFilesRecursive } from './utils/common'
import { resolveUnderRoot } from './utils/path-security'

// segmentit 仅发布 CJS 格式，不支持 ESM import
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useDefault, Segment } = require('segmentit')

/**
 * 每个 chunk 的最大字符数。超过此阈值的章节按段落二次切分。
 */
const CHUNK_SPLIT_THRESHOLD = 4000

/**
 * BM25 参数
 * k1: 词频饱和系数（越大，高频词贡献越多；通常 1.2~2.0）
 * b:  文档长度归一化系数（0=不考虑长度，1=完全归一化；通常 0.75）
 */
const BM25_K1 = 1.5
const BM25_B = 0.75

/** 中文分词器（segmentit，纯 JS 实现） */
const segmentit = useDefault(new Segment())

/**
 * Chunk 数据结构
 *
 * @author zhi.qu
 * @date 2026-04-03
 */
interface Chunk {
  file: string
  heading: string
  content: string
  /** 上下文索引描述（由 LLM 在索引阶段生成的 1 句话摘要） */
  context?: string
  /** 预计算的分词结果缓存（避免重复分词） */
  tokens?: string[]
}

/**
 * 对文本进行中文分词。
 * 先按 ASCII/CJK 边界切分（保留型号如 ENS-L262），再对 CJK 部分用 segmentit 分词。
 *
 * @author zhi.qu
 * @date 2026-04-03
 */
export function tokenize(text: string): string[] {
  const parts = text.split(
    /(?<=[^\u4e00-\u9fa5])(?=[\u4e00-\u9fa5])|(?<=[\u4e00-\u9fa5])(?=[^\u4e00-\u9fa5])/
  )

  const tokens: string[] = []
  for (const part of parts) {
    if (/[\u4e00-\u9fa5]/.test(part)) {
      const words: string[] = segmentit.doSegment(part, { simple: true })
      for (const w of words) {
        if (w.length >= 2) tokens.push(w)
      }
    } else {
      const cleaned = part.replace(/^[-\s]+|[-\s]+$/g, '')
      if (cleaned.length >= 2) tokens.push(cleaned)
    }
  }
  return tokens
}

/**
 * 检测 chunk 是否为纯文档元数据（封面页、版权页、页脚等），这类 chunk 不含实质技术内容。
 * 元数据 chunk 包含产品型号关键词，会在 BM25/向量检索中排名虚高，干扰检索质量。
 *
 * @author zhi.qu
 * @date 2026-04-03
 */
function isMetadataChunk(heading: string, content: string, file?: string): boolean {
  if (file?.toLowerCase() === 'readme.md') return true
  const metaKeywords = ['文档标题', '版权信息', '页码', '公司标识', '公司名称', '品牌标识']
  const headingLower = heading.toLowerCase()
  if (headingLower.includes('前言') && headingLower.includes('目录')) return true
  if (/^(附：|附:).*元数据/.test(heading)) return true
  const matchCount = metaKeywords.filter(kw => content.includes(kw)).length
  return matchCount >= 3
}

/**
 * 计算 BM25 得分
 *
 * @param queryTokens - 查询分词结果
 * @param docTokens - 文档 chunk 分词结果
 * @param avgDl - 全部 chunk 的平均 token 数
 * @param df - 每个词的文档频率（在多少个 chunk 中出现）
 * @param totalDocs - chunk 总数
 *
 * @author zhi.qu
 * @date 2026-04-03
 */
function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  avgDl: number,
  df: Map<string, number>,
  totalDocs: number,
): number {
  const dl = docTokens.length
  const tf = new Map<string, number>()
  for (const t of docTokens) {
    tf.set(t, (tf.get(t) || 0) + 1)
  }

  let score = 0
  for (const q of queryTokens) {
    const termFreq = tf.get(q) || 0
    if (termFreq === 0) continue

    const docFreq = df.get(q) || 0
    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1)
    // TF 饱和: (tf * (k1+1)) / (tf + k1 * (1 - b + b * dl/avgDl))
    const tfNorm = (termFreq * (BM25_K1 + 1)) /
      (termFreq + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgDl))

    score += idf * tfNorm
  }
  return score
}

/**
 * KnowledgeRetriever: 知识库检索引擎。
 *
 * 支持三层检索策略：
 * 1. BM25 关键词检索（segmentit 中文分词 + BM25 评分）
 * 2. 上下文索引补充（可选，通过 setContexts 注入 LLM 生成的摘要）
 * 3. 向量语义检索 + RRF 融合（可选，通过 setEmbeddings 注入）
 *
 * @author zhi.qu
 * @date 2026-04-03
 */
export class KnowledgeRetriever {
  private knowledgePath: string
  /** 缓存的 chunk 列表（懒加载） */
  private chunksCache: Chunk[] | null = null
  /** 上下文索引描述映射：key = "file::heading" */
  private contextMap = new Map<string, string>()
  /** 向量 embedding 映射：key = "file::heading" */
  private embeddingMap = new Map<string, number[]>()
  /**
   * BM25 token 缓存映射：key = "file::heading"，value = 分词后的 token 数组。
   * 通过 setTokens 从 _index/tokens.json 注入（持久化跨 session），避免每次重启都
   * 重新跑 segmentit 中文分词（CPU 重活）。新分词的 chunks 也会回填进此 map，
   * 然后由 ToolRouter / 调用方决定何时 saveTokensCache 落盘。
   */
  private tokensMap = new Map<string, string[]>()
  /** 标记 tokensMap 是否在 searchChunks 期间被新增了条目，供调用方判断是否需要落盘 */
  private tokensDirty = false
  /** BM25 预计算缓存：df、avgDl，以及倒排索引（token → chunk 索引集合） */
  private bm25Cache: {
    df: Map<string, number>
    avgDl: number
    totalDocs: number
    /** 倒排索引：token → 包含该 token 的 chunk 在 allChunks 数组中的索引集合 */
    invertedIndex: Map<string, Set<number>>
    /** 关联的 chunksCache 引用，用于快速检测缓存是否仍有效 */
    sourceChunks: Chunk[]
  } | null = null

  /** 文档数超过此阈值时启用倒排索引粗筛，小规模下走全量扫描（避免额外开销） */
  private static readonly BM25_INVERTED_INDEX_THRESHOLD = 200

  constructor(knowledgePath: string) {
    this.knowledgePath = knowledgePath
  }

  /**
   * 异步预热 chunk 缓存：用 fs.promises.readFile 读取文件，不阻塞主线程。
   * 在 load-avatar 返回后 fire-and-forget 调用，用户提问前 chunks 已就绪。
   * 如果预热未完成用户就提问了，searchChunks 会回退到同步 buildChunks。
   */
  async warmUpAsync(): Promise<void> {
    if (this.chunksCache) return
    const files = this.collectFiles(this.knowledgePath)
    const chunks: Chunk[] = []
    for (const filePath of files) {
      const relativePath = path.relative(this.knowledgePath, filePath)
      let content: string
      try {
        content = await fs.promises.readFile(filePath, 'utf-8')
      } catch (err) {
        console.warn(`[KnowledgeRetriever] 预热跳过 ${relativePath}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      const sections = content.split(/^#{2,3}\s+/m)
      const headingMatches = [...content.matchAll(/^#{2,3}\s+(.+)$/gm)]
      if (sections.length <= 1) {
        this.pushChunks(chunks, relativePath, relativePath, content)
      } else {
        sections.forEach((section, i) => {
          if (!section.trim()) return
          const heading = headingMatches[i - 1]?.[1] ?? relativePath
          this.pushChunks(chunks, relativePath, heading, section)
        })
      }
    }
    // 仅在 chunksCache 仍为空时写入（防止与同步 buildChunks 竞态）
    if (!this.chunksCache) {
      for (const chunk of chunks) {
        const key = `${chunk.file}::${chunk.heading}`
        const ctx = this.contextMap.get(key)
        if (ctx) chunk.context = ctx
      }
      this.chunksCache = chunks
    }
  }

  /**
   * 注入 LLM 生成的上下文索引描述。
   * 每个 chunk 对应一句话摘要，在检索时拼接到 chunk 文本前面参与 BM25 评分。
   */
  setContexts(contexts: Map<string, string>): void {
    this.contextMap = contexts
    this.chunksCache = null
    this.bm25Cache = null
  }

  /**
   * 注入向量 embedding（浅拷贝，防止外部修改破坏内部状态）。
   * 启用后 searchChunks 自动执行 BM25 + 向量 的 RRF 融合排序。
   *
   * 约定：embedding 与 contexts 须来自同一次索引构建（buildKnowledgeIndex 原子输出）。
   * 若需仅更新 embedding 格式而保留 chunk 数据，需确保 chunk key 集合不变；
   * 否则应同时调用 setContexts 触发 chunksCache 和 bm25Cache 失效以保持一致。
   */
  setEmbeddings(embeddings: Map<string, number[]>): void {
    this.embeddingMap = new Map(embeddings)
  }

  /**
   * 获取当前 embedding Map 的浅拷贝，用于 RAG 时注入 __query__ 向量。
   * 返回副本防止外部意外篡改内部状态。
   */
  getEmbeddings(): Map<string, number[]> {
    return new Map(this.embeddingMap)
  }

  /** 是否已注入向量 embedding（用于判断是否启用 RRF 融合检索） */
  hasEmbeddings(): boolean {
    return this.embeddingMap.size > 0
  }

  /**
   * 直接在内部 embeddingMap 上设置查询向量（零拷贝）。
   * 必须在 per-retriever 串行锁保护下使用，完成后调用 clearQueryVector 恢复。
   */
  injectQueryVector(vec: number[]): void {
    this.embeddingMap.set('__query__', vec)
  }

  /** 移除临时注入的查询向量，恢复 embeddingMap 原始状态 */
  clearQueryVector(): void {
    this.embeddingMap.delete('__query__')
  }

  /** 手动失效 BM25 缓存，在知识文件更新后调用 */
  invalidateCache(): void {
    this.chunksCache = null
    this.bm25Cache = null
  }

  /**
   * 注入持久化的 token 缓存（从 _index/tokens.json 加载）。
   * 后续 searchChunks 的 lazy tokenize 阶段优先查此 map，cache miss 才调 segmentit。
   * 调用此方法不会影响 chunksCache / bm25Cache（tokens 是独立维度）。
   */
  setTokens(tokens: Map<string, string[]>): void {
    this.tokensMap = new Map(tokens)
    this.tokensDirty = false
  }

  /**
   * 导出当前所有 tokens（含 setTokens 注入的 + searchChunks 期间新分词的）。
   * 供调用方序列化到 _index/tokens.json。
   */
  getTokens(): Map<string, string[]> {
    return new Map(this.tokensMap)
  }

  /** 是否有未落盘的新 token（searchChunks 期间填充了新条目）。供调用方决定是否 saveTokensCache。 */
  isTokensDirty(): boolean {
    return this.tokensDirty
  }

  /** 重置 dirty 标志（saveTokensCache 落盘后调用）。 */
  clearTokensDirty(): void {
    this.tokensDirty = false
  }

  /**
   * 检索知识库中与查询最相关的 chunk。
   *
   * 评分策略：
   * - 仅 BM25：当未注入 embedding 时，用 segmentit 分词 + BM25 评分
   * - BM25 + 向量 RRF：当注入了 embedding 时，两路检索结果用 RRF 融合
   */
  searchChunks(
    query: string,
    topN: number = 5,
  ): Array<{ file: string; heading: string; content: string; score: number }> {
    // 过滤掉内容过短或纯元数据的 chunk
    const MIN_CHUNK_LENGTH = 80
    const allChunks = this.getChunks().filter(c =>
      c.content.length >= MIN_CHUNK_LENGTH && !isMetadataChunk(c.heading, c.content, c.file),
    )
    if (allChunks.length === 0) return []

    // ── BM25 检索 ──
    const queryTokens = tokenize(query.toLowerCase())
    if (queryTokens.length === 0) return []

    // 预计算所有 chunk 的分词（三层缓存）：
    //   1. chunk.tokens 内存缓存（同一 retriever 实例多次 search 复用）
    //   2. tokensMap 持久化缓存（从 _index/tokens.json 加载，跨 session 复用）
    //   3. 都没有 → 调 segmentit tokenize（CPU 重活），结果回填到 tokensMap + 标记 dirty
    for (const chunk of allChunks) {
      if (chunk.tokens) continue
      const cacheKey = `${chunk.file}::${chunk.heading}`
      const persistedTokens = this.tokensMap.get(cacheKey)
      if (persistedTokens) {
        chunk.tokens = persistedTokens
        continue
      }
      const searchableText = (chunk.context ? chunk.context + ' ' : '') +
        chunk.heading + ' ' + chunk.content
      const fresh = tokenize(searchableText.toLowerCase())
      chunk.tokens = fresh
      this.tokensMap.set(cacheKey, fresh)
      this.tokensDirty = true
    }

    // 复用或构建 BM25 统计缓存（通过 chunksCache 引用比对检测内容变化，避免每次构建巨大指纹字符串）
    const currentChunks = this.chunksCache
    if (!this.bm25Cache || this.bm25Cache.sourceChunks !== currentChunks) {
      const df = new Map<string, number>()
      const invertedIndex = new Map<string, Set<number>>()
      for (let idx = 0; idx < allChunks.length; idx++) {
        const chunk = allChunks[idx]
        const uniqueTokens = new Set(chunk.tokens!)
        for (const t of uniqueTokens) {
          df.set(t, (df.get(t) || 0) + 1)
          // 同时构建倒排索引
          let set = invertedIndex.get(t)
          if (!set) { set = new Set(); invertedIndex.set(t, set) }
          set.add(idx)
        }
      }
      const rawAvgDl = allChunks.reduce((sum, c) => sum + c.tokens!.length, 0) / allChunks.length
      const avgDl = Math.max(rawAvgDl, 1)
      this.bm25Cache = { df, avgDl, totalDocs: allChunks.length, invertedIndex, sourceChunks: currentChunks! }
    }

    const { df, avgDl, invertedIndex } = this.bm25Cache

    // 文档数超过阈值时，用倒排索引取候选集合，避免全量 BM25 扫描
    let candidateChunks = allChunks
    if (allChunks.length >= KnowledgeRetriever.BM25_INVERTED_INDEX_THRESHOLD) {
      const candidateSet = new Set<number>()
      for (const token of queryTokens) {
        const matches = invertedIndex.get(token)
        if (matches) {
          for (const idx of matches) candidateSet.add(idx)
        }
      }
      if (candidateSet.size > 0) {
        candidateChunks = [...candidateSet].map(idx => allChunks[idx])
      }
    }

    const bm25Results = candidateChunks.map(chunk => ({
      file: chunk.file,
      heading: chunk.heading,
      content: chunk.content,
      score: bm25Score(queryTokens, chunk.tokens!, avgDl, df, allChunks.length),
    }))
    if (this.embeddingMap.size > 0) {
      return this.rrfFusion(query, bm25Results, allChunks, topN)
    }

    // ── 纯 BM25 ──
    return bm25Results
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
  }

  /**
   * 多跳检索：首次检索 + 按实体二次检索 → 合并去重。
   * 调用方负责从首次结果中提取实体列表，传入 entities 参数。
   *
   * @param primaryQuery - 用户原始查询
   * @param entities - 从首次检索结果中提取的实体/组件名列表
   * @param topN - 最终返回数量
   *
   * @author zhi.qu
   * @date 2026-04-03
   */
  multiHopSearch(
    primaryQuery: string,
    entities: string[],
    topN: number = 10,
  ): Array<{ file: string; heading: string; content: string; score: number; hop: number }> {
    // 第一跳：原始查询
    const hop1 = this.searchChunks(primaryQuery, topN).map(c => ({ ...c, hop: 1 }))
    const seen = new Set(hop1.map(c => `${c.file}::${c.heading}`))

    // 第二跳：按每个实体分别检索
    const hop2: Array<{ file: string; heading: string; content: string; score: number; hop: number }> = []
    for (const entity of entities) {
      const entityQuery = `${entity} 参数 规格 技术`
      const results = this.searchChunks(entityQuery, 5)
      for (const r of results) {
        const key = `${r.file}::${r.heading}`
        if (!seen.has(key)) {
          seen.add(key)
          hop2.push({ ...r, hop: 2 })
        }
      }
    }

    // 合并：第一跳优先，第二跳按 score 排序追加
    hop2.sort((a, b) => b.score - a.score)
    const merged = [...hop1, ...hop2]
    return merged.slice(0, topN)
  }

  /**
   * score = 1/(k + rank_bm25) + 1/(k + rank_vector)
   */
  private rrfFusion(
    query: string,
    bm25Results: Array<{ file: string; heading: string; content: string; score: number }>,
    allChunks: Chunk[],
    topN: number,
  ): Array<{ file: string; heading: string; content: string; score: number }> {
    const k = 60

    // BM25 排名
    const bm25Sorted = [...bm25Results]
      .sort((a, b) => b.score - a.score)
    const bm25Rank = new Map<string, number>()
    bm25Sorted.forEach((r, i) => bm25Rank.set(`${r.file}::${r.heading}`, i + 1))

    // 向量排名
    const queryKey = `__query__`
    const queryEmb = this.embeddingMap.get(queryKey)
    if (!queryEmb) {
      // 没有查询向量，退回纯 BM25
      return bm25Sorted.filter(c => c.score > 0).slice(0, topN)
    }

    const vectorScored = allChunks.map(chunk => {
      const chunkKey = `${chunk.file}::${chunk.heading}`
      const chunkEmb = this.embeddingMap.get(chunkKey)
      const sim = chunkEmb ? cosineSimilarity(queryEmb, chunkEmb) : 0
      return { key: chunkKey, sim }
    }).sort((a, b) => b.sim - a.sim)

    const vectorRank = new Map<string, number>()
    vectorScored.forEach((r, i) => vectorRank.set(r.key, i + 1))

    // RRF 融合：取 BM25 和向量排名前 N 的候选的并集，确保不遗漏向量匹配的候选
    const candidateWindow = Math.min(topN * 10, allChunks.length)
    const bm25Candidates = new Set(bm25Sorted.slice(0, candidateWindow).map(r => `${r.file}::${r.heading}`))
    const vectorCandidates = new Set(vectorScored.slice(0, candidateWindow).map(r => r.key))

    // 构建 chunk 查找表（用于取回 vector-only 候选的 content）
    const chunkByKey = new Map<string, Chunk>()
    for (const chunk of allChunks) {
      chunkByKey.set(`${chunk.file}::${chunk.heading}`, chunk)
    }

    // 合并两个候选集的 key
    const allCandidateKeys = new Set<string>()
    for (const key of bm25Candidates) allCandidateKeys.add(key)
    for (const key of vectorCandidates) allCandidateKeys.add(key)

    const fusedResults: Array<{ file: string; heading: string; content: string; score: number }> = []
    for (const key of allCandidateKeys) {
      const br = bm25Rank.get(key) ?? (bm25Sorted.length + 1)
      const vr = vectorRank.get(key) ?? (allChunks.length + 1)
      const rrfScore = 1 / (k + br) + 1 / (k + vr)
      const chunk = chunkByKey.get(key)
      if (chunk) {
        fusedResults.push({ file: chunk.file, heading: chunk.heading, content: chunk.content, score: rrfScore })
      }
    }

    return fusedResults
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
  }

  /**
   * 获取所有 chunk（带缓存）
   */
  private getChunks(): Chunk[] {
    if (!this.chunksCache) {
      this.chunksCache = this.buildChunks()
      // 注入上下文索引描述
      for (const chunk of this.chunksCache) {
        const key = `${chunk.file}::${chunk.heading}`
        const ctx = this.contextMap.get(key)
        if (ctx) chunk.context = ctx
      }
    }
    return this.chunksCache
  }

  /**
   * 读取指定相对路径的文件完整内容
   */
  readFile(relativePath: string): string {
    const resolved = resolveUnderRoot(this.knowledgePath, relativePath)
    try {
      return fs.readFileSync(resolved, 'utf-8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new Error(`文件不存在: ${relativePath}`)
      }
      throw new Error(`读取文件失败 (${code ?? 'UNKNOWN'}): ${relativePath}`)
    }
  }

  /**
   * 列出所有知识文件路径
   */
  listFiles(): string[] {
    return this.collectFiles(this.knowledgePath).map(f =>
      path.relative(this.knowledgePath, f)
    )
  }

  /**
   * 获取所有 chunk 的 key 列表（用于外部生成上下文和 embedding）
   */
  getChunkKeys(): Array<{ key: string; file: string; heading: string; contentPreview: string }> {
    return this.getChunks().map(c => ({
      key: `${c.file}::${c.heading}`,
      file: c.file,
      heading: c.heading,
      contentPreview: c.content,
    }))
  }

  /**
   * 获取所有 chunk 的完整数据（含完整内容）。
   * 供 WikiCompiler 等外部模块使用，不改变现有检索逻辑。
   *
   * @author zhi.qu
   * @date 2026-04-09
   */
  getFullChunks(): Array<{ file: string; heading: string; content: string }> {
    return this.getChunks().map(c => ({
      file: c.file,
      heading: c.heading,
      content: c.content,
    }))
  }

  /** 将所有知识文件按 h2/h3 标题切片 */
  private buildChunks(): Chunk[] {
    const chunks: Chunk[] = []
    const files = this.collectFiles(this.knowledgePath)

    for (const filePath of files) {
      const relativePath = path.relative(this.knowledgePath, filePath)
      let content: string
      try {
        content = fs.readFileSync(filePath, 'utf-8')
      } catch (err) {
        console.warn(`[KnowledgeRetriever] 跳过文件 ${relativePath}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }

      const sections = content.split(/^#{2,3}\s+/m)
      const headingMatches = [...content.matchAll(/^#{2,3}\s+(.+)$/gm)]

      if (sections.length <= 1) {
        this.pushChunks(chunks, relativePath, relativePath, content)
      } else {
        sections.forEach((section, i) => {
          if (!section.trim()) return
          const heading = headingMatches[i - 1]?.[1] ?? relativePath
          this.pushChunks(chunks, relativePath, heading, section)
        })
      }
    }

    return chunks
  }

  /**
   * 将章节内容加入 chunk 列表。
   * 保留章节完整内容，仅对超长章节（> CHUNK_SPLIT_THRESHOLD）按段落二次切分。
   */
  private pushChunks(
    chunks: Chunk[],
    file: string,
    heading: string,
    section: string,
  ): void {
    if (section.length <= CHUNK_SPLIT_THRESHOLD) {
      chunks.push({ file, heading, content: section })
      return
    }

    const paragraphs = section.split(/\n{2,}/)
    let current = ''
    let partNum = 1

    for (const para of paragraphs) {
      const candidate = current ? `${current}\n\n${para}` : para
      if (candidate.length > CHUNK_SPLIT_THRESHOLD && current) {
        chunks.push({ file, heading: `${heading}（${partNum}）`, content: current })
        current = para
        partNum++
      } else {
        current = candidate
      }
    }

    if (current.trim()) {
      chunks.push({
        file,
        heading: partNum > 1 ? `${heading}（${partNum}）` : heading,
        content: current,
      })
    }
  }

  /** 递归收集 .md 文件路径（委托给共享工具函数，避免各模块各自实现） */
  private collectFiles(dirPath: string): string[] {
    return collectFilesRecursive(dirPath, '.md')
  }
}

/**
 * 余弦相似度
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dotProduct / denominator
}
