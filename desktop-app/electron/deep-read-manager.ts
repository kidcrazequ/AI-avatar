/**
 * DeepReadManager：知识库「精读」长任务的主进程编排器。
 *
 * 编排模式照搬人生生成（main.ts life:start-generation，范式：
 * fire-and-forget + AbortController + owner-guard + 进度推送 + 拉式查询）：
 *   - prepare：解析文档 → 切章 → 成本预估（同步 IPC，复用 parse-document 的路径安全策略）
 *   - start  ：消费 prepare 结果，后台跑 runDeepRead，IPC 立即返回
 *   - cancel ：不再发起新 LLM 调用、在飞调用的结果被丢弃（底层 HTTP 不中断，由其
 *              超时自行了结，见 llm-factory BACKEND_API_TIMEOUT_MS）；已落盘章节
 *              保留，重新 prepare+start 按文件存在性续跑
 *   - getStatus：窗口重载后恢复进度 UI 的拉式通道
 *
 * LLM 配置从 SQLite settings 读（creation_* 缺省回退 chat_*，同 buildLifeLLMConfig），
 * API Key 不经 IPC 传输。
 */

import path from 'path'
import fs from 'fs'
import {
  chapterFileName,
  cleanPdfFullText,
  stripDocxToc,
  estimateDeepRead,
  runDeepRead,
  sanitizeFileSegment,
  splitBookIntoChapters,
  DEEP_READ_SYNTHESIS_FILES,
  type BookChapter,
  type DeepReadContentType,
  type DeepReadDepth,
  type DeepReadEstimate,
  type DeepReadProgress,
  type LLMCallFn,
} from '@soul/core'
import type { DocumentParser } from './document-parser'

/** cleanPdfFullText 的硬截断阈值（ocr-html-cleaner.ts MAX_CLEAN_LENGTH=512K）之下的安全线；
 *  超过则改为逐章清洗，避免整本书后半本被截断 */
const FULL_CLEAN_SAFE_CHARS = 400_000

export interface DeepReadPrepareResult {
  bookTitle: string
  fileName: string
  fileType: string
  totalChars: number
  chapterCount: number
  /** 章节预览（标题 + 字符数 + 页码区间），最多 200 条 */
  chapters: Array<{ title: string; chars: number; pageStart?: number; pageEnd?: number }>
  /** 已存在的章节笔记数（>0 表示可断点续跑） */
  existingCount: number
  /** 产物目录（相对 knowledge/） */
  outputDir: string
  /** 四种深度×类型组合的预估，UI 按所选 radio 展示 */
  estimates: Record<DeepReadDepth, Record<DeepReadContentType, DeepReadEstimate>>
}

export interface DeepReadStartParams {
  depth: DeepReadDepth
  contentType: DeepReadContentType
}

export interface DeepReadStatus {
  running: boolean
  progress: DeepReadProgress | null
  /** 终态错误（取消时为「精读已取消」） */
  error: string | null
  /** 终态结果摘要 */
  result: { products: number; failedChapters: string[]; skippedChapters: number; totalChapters: number } | null
}

interface PreparedDeepRead {
  filePath: string
  bookTitle: string
  fileType: string
  outputDir: string
  chapters: BookChapter[]
}

export interface DeepReadManagerDeps {
  documentParser: DocumentParser
  avatarsPath: string
  /** 渲染层传入的绝对路径校验（main.ts assertUserOwnedFile） */
  resolveUserFile: (filePath: string) => string
  getSetting: (key: string) => string | null | undefined
  createLLMFn: (apiKey: string, baseUrl: string, model: string) => LLMCallFn
  /** knowledge/ 相对路径写盘（main.ts getKnowledgeManager(avatarId).writeFile） */
  writeKnowledgeFile: (avatarId: string, relativePath: string, content: string) => void
  /** WikiCompiler.preserveRawFile：原书落 _raw/，返回相对路径 */
  preserveRawFile: (knowledgePath: string, originalFilePath: string) => Promise<string>
  /** 收尾：buildKnowledgeIndex 增量 + invalidateRetriever（main.ts buildIndexAfterBatchImport） */
  buildIndexAfterImport: (avatarId: string) => Promise<void>
  sendToRenderer: (channel: string, payload: unknown) => void
  logActivity: (action: string, detail: string) => void
  logError: (action: string, err: Error) => void
}

export class DeepReadManager {
  private prepared = new Map<string, PreparedDeepRead>()
  private controllers = new Map<string, AbortController>()
  private statuses = new Map<string, DeepReadStatus>()

  constructor(private readonly deps: DeepReadManagerDeps) {}

  private knowledgePath(avatarId: string): string {
    return path.join(this.deps.avatarsPath, avatarId, 'knowledge')
  }

  isRunning(avatarId: string): boolean {
    return this.controllers.has(avatarId)
  }

  getStatus(avatarId: string): DeepReadStatus {
    return this.statuses.get(avatarId) ?? { running: false, progress: null, error: null, result: null }
  }

  /**
   * 解析 + 切章 + 预估。同步等待（大 PDF 可能分钟级，与 parse-document 一致）。
   * 结果暂存内存，等 start 消费；重复 prepare 直接覆盖。
   */
  async prepare(avatarId: string, filePath: string): Promise<DeepReadPrepareResult> {
    if (this.controllers.has(avatarId)) {
      throw new Error('该分身已有精读任务在进行中，请先取消或等待完成')
    }
    // 上一轮的终态 status 保留到这里才清（窗口重载后 getStatus 要能拉到终态恢复 UI）；
    // 键数 = 分身数，不会无界增长
    this.statuses.delete(avatarId)
    const resolved = this.deps.resolveUserFile(filePath)
    const parsed = await this.deps.documentParser.parseFile(resolved)
    if (!parsed.text || parsed.text.trim().length < 1000) {
      throw new Error(
        `文档提取文本过少（${parsed.text.trim().length} 字符），无法精读。扫描版 PDF 请先走普通导入的 OCR 流程`,
      )
    }

    const cleaned = this.cleanText(parsed.text, parsed.fileType)
    const chapters = splitBookIntoChapters(cleaned)
    if (chapters.length === 0) {
      throw new Error('未能从文档中切分出章节，无法精读')
    }

    const bookTitle = parsed.fileName.replace(/\.[^.]+$/, '')
    const outputDir = `精读/${sanitizeFileSegment(bookTitle).slice(0, 60)}`
    const knowledgePath = this.knowledgePath(avatarId)
    const existingCount = chapters.filter(ch =>
      fs.existsSync(path.join(knowledgePath, outputDir, chapterFileName(ch, chapters.length))),
    ).length

    this.prepared.set(avatarId, { filePath: resolved, bookTitle, fileType: parsed.fileType, outputDir, chapters })

    // 续跑时只对"还没有笔记的章节"估算成本（已存在章节会被 shouldSkip 跳过，不烧 LLM）
    const pendingChapters = existingCount === 0
      ? chapters
      : chapters.filter(ch => !fs.existsSync(path.join(knowledgePath, outputDir, chapterFileName(ch, chapters.length))))
    const estimates = {
      study: {
        technical: estimateDeepRead(pendingChapters, 'study', 'technical'),
        text: estimateDeepRead(pendingChapters, 'study', 'text'),
      },
      reference: {
        technical: estimateDeepRead(pendingChapters, 'reference', 'technical'),
        text: estimateDeepRead(pendingChapters, 'reference', 'text'),
      },
    }

    return {
      bookTitle,
      fileName: parsed.fileName,
      fileType: parsed.fileType,
      totalChars: cleaned.length,
      chapterCount: chapters.length,
      chapters: chapters.slice(0, 200).map(ch => ({
        title: ch.title,
        chars: ch.content.length,
        ...(ch.pageStart !== undefined ? { pageStart: ch.pageStart } : {}),
        ...(ch.pageEnd !== undefined ? { pageEnd: ch.pageEnd } : {}),
      })),
      existingCount,
      outputDir,
      estimates,
    }
  }

  /** 启动后台精读。立即返回；进度走 'deep-read:progress' 事件 + getStatus 拉式查询。 */
  start(avatarId: string, params: DeepReadStartParams): { started: true } {
    if (this.controllers.has(avatarId)) {
      throw new Error('该分身已有精读任务在进行中，请先取消再重试')
    }
    const prepared = this.prepared.get(avatarId)
    if (!prepared) {
      throw new Error('没有待执行的精读任务，请先选择文档（prepare）')
    }
    if (params.depth !== 'study' && params.depth !== 'reference') {
      throw new Error(`非法 depth: ${String(params.depth)}`)
    }
    if (params.contentType !== 'technical' && params.contentType !== 'text') {
      throw new Error(`非法 contentType: ${String(params.contentType)}`)
    }

    const callLLM = this.buildLLM()
    // 立即消费 prepare 结果：整本书章节文本不再驻留 Map（避免用户放弃后内存滞留）
    this.prepared.delete(avatarId)
    const ac = new AbortController()
    this.controllers.set(avatarId, ac)
    const status: DeepReadStatus = { running: true, progress: null, error: null, result: null }
    this.statuses.set(avatarId, status)

    // 后台异步执行；不 await，直接返回让 IPC 响应（同 spawnLifeGeneration）
    void (async () => {
      try {
        const result = await this.runJob(avatarId, prepared, params, callLLM, ac.signal, status)
        status.running = false
        status.result = {
          products: result.products.length,
          failedChapters: result.failedChapters.map(f => f.title),
          skippedChapters: result.skippedChapters,
          totalChapters: result.totalChapters,
        }
        this.deps.logActivity('deep-read', `avatar=${avatarId} 完成：${result.products.length} 个产物，${result.failedChapters.length} 章失败`)
      } catch (err) {
        status.running = false
        if (err instanceof Error && err.name === 'AbortError') {
          status.error = '精读已取消（已完成章节已保留，可续跑）'
          this.deps.logActivity('deep-read', `avatar=${avatarId} 已取消`)
        } else {
          status.error = err instanceof Error ? err.message : String(err)
          this.deps.logError('deep-read', err instanceof Error ? err : new Error(String(err)))
        }
      } finally {
        // owner-guard：仅当仍是本次任务的 controller 时才删（防 retry 竞态，见 life 同款注释）
        if (this.controllers.get(avatarId) === ac) {
          this.controllers.delete(avatarId)
        }
      }
    })()

    return { started: true }
  }

  cancel(avatarId: string): { cancelled: boolean } {
    // 同时丢弃未消费的 prepare 结果（用户在确认区点「取消」也走这里，释放整本书文本）
    this.prepared.delete(avatarId)
    const ac = this.controllers.get(avatarId)
    if (!ac) return { cancelled: false }
    ac.abort()
    this.controllers.delete(avatarId)
    this.deps.logActivity('deep-read', `avatar=${avatarId} cancel`)
    return { cancelled: true }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private async runJob(
    avatarId: string,
    prepared: PreparedDeepRead,
    params: DeepReadStartParams,
    callLLM: LLMCallFn,
    abortSignal: AbortSignal,
    status: DeepReadStatus,
  ) {
    const knowledgePath = this.knowledgePath(avatarId)
    const rawFileRelPath = await this.resolveRawFileRelPath(knowledgePath, prepared.filePath)
    // 大文件拷贝期间 abort 无法打断；拷贝完立刻补一次检查，缩小取消后的并发窗口
    if (abortSignal.aborted) {
      const err = new Error('精读已取消')
      err.name = 'AbortError'
      throw err
    }

    // 断点续跑：已有章节笔记读入，供综合件摘要
    const priorChapterNotes: Array<{ relativePath: string; content: string }> = []
    for (const ch of prepared.chapters) {
      const rel = `${prepared.outputDir}/${chapterFileName(ch, prepared.chapters.length)}`
      const abs = path.join(knowledgePath, rel)
      if (fs.existsSync(abs)) {
        try {
          priorChapterNotes.push({ relativePath: rel, content: fs.readFileSync(abs, 'utf-8') })
        } catch {
          // 读失败当作不存在，重新蒸馏
        }
      }
    }
    const existingPaths = new Set(priorChapterNotes.map(n => n.relativePath))
    // 综合件也纳入存在性探测：纯续跑（零新增章节）时 core 据此跳过重付综合 LLM 调用
    for (const fileName of DEEP_READ_SYNTHESIS_FILES) {
      const rel = `${prepared.outputDir}/${fileName}`
      if (fs.existsSync(path.join(knowledgePath, rel))) existingPaths.add(rel)
    }

    const result = await runDeepRead(prepared.chapters, {
      bookTitle: prepared.bookTitle,
      outputDir: prepared.outputDir,
      rawFileRelPath,
      depth: params.depth,
      contentType: params.contentType,
      callLLM,
      abortSignal,
      shouldSkip: (rel: string) => existingPaths.has(rel),
      priorChapterNotes,
      onProgress: progress => {
        // 闭包持有本次任务的 status 对象：取消后残留的旧任务不会污染新任务的状态
        status.progress = progress
        this.deps.sendToRenderer('deep-read:progress', { avatarId, progress })
      },
      onProduct: async product => {
        this.deps.writeKnowledgeFile(avatarId, product.relativePath, product.content)
        this.deps.sendToRenderer('knowledge-file-written', { avatarId, fileName: product.relativePath })
      },
    })

    this.appendReadmeEntry(avatarId, prepared)
    // 一次任务可能写入几十个文件：结束后统一重建索引 + 失效检索缓存
    await this.deps.buildIndexAfterImport(avatarId)
    return result
  }

  /**
   * 原书落 _raw/：同名同大小文件已存在（上次精读/普通导入留下）时直接复用，
   * 避免每次续跑都复制整本书产生 `<名>-<时间戳>` 副本、citation 锚点在新旧笔记间分裂。
   */
  private async resolveRawFileRelPath(knowledgePath: string, filePath: string): Promise<string> {
    const base = path.basename(filePath)
    const existing = path.join(knowledgePath, '_raw', base)
    try {
      if (fs.existsSync(existing) && fs.statSync(existing).size === fs.statSync(filePath).size) {
        return `_raw/${base}`
      }
    } catch {
      // stat 失败走正常落盘路径
    }
    return this.deps.preserveRawFile(knowledgePath, filePath)
  }

  /** README.md 知识文件索引表追加一行（指向精读索引件；逐章笔记不刷表，避免几十行噪音） */
  private appendReadmeEntry(avatarId: string, prepared: PreparedDeepRead): void {
    try {
      const readmePath = path.join(this.knowledgePath(avatarId), 'README.md')
      if (!fs.existsSync(readmePath)) return
      let readme = fs.readFileSync(readmePath, 'utf-8')
      const indexRel = `${prepared.outputDir}/00-索引.md`
      if (readme.includes(indexRel)) return
      if (!readme.includes('| 文件 |') && !readme.includes('| --- |')) {
        readme += '\n## 知识文件索引\n\n| 文件 | 路径 | 来源 |\n| --- | --- | --- |\n'
      }
      readme += `| 《${prepared.bookTitle}》精读 | [${indexRel}](${indexRel}) | 精读导入 |\n`
      this.deps.writeKnowledgeFile(avatarId, 'README.md', readme)
    } catch (err) {
      this.deps.logError('deep-read-readme', err instanceof Error ? err : new Error(String(err)))
    }
  }

  /** creation_* 缺省回退 chat_*（同 main.ts buildLifeLLMConfig） */
  private buildLLM(): LLMCallFn {
    const chatApiKey = this.deps.getSetting('chat_api_key') ?? ''
    const chatBaseUrl = this.deps.getSetting('chat_base_url') ?? 'https://api.deepseek.com/v1'
    const chatModel = this.deps.getSetting('chat_model') ?? 'deepseek-chat'
    const creationApiKey = this.deps.getSetting('creation_api_key') ?? ''
    if (!chatApiKey && !creationApiKey) {
      throw new Error('未配置 LLM API Key，请先在设置里填入对话模型或创作模型的 API Key')
    }
    if (creationApiKey) {
      return this.deps.createLLMFn(
        creationApiKey,
        this.deps.getSetting('creation_base_url') ?? chatBaseUrl,
        this.deps.getSetting('creation_model') ?? chatModel,
      )
    }
    return this.deps.createLLMFn(chatApiKey, chatBaseUrl, chatModel)
  }

  private cleanText(text: string, fileType: string): string {
    if (fileType === 'pdf') {
      if (text.length <= FULL_CLEAN_SAFE_CHARS) return cleanPdfFullText(text)
      // 超长整本：逐段清洗绕开 MAX_CLEAN_LENGTH 截断（按页标记分块，块内仍是同质 PDF 文本）
      const blocks = text.split(/(?=^###\s*第\s*\d+\s*页\s*$)/m)
      const out: string[] = []
      let buffer = ''
      for (const block of blocks) {
        if (buffer.length + block.length > FULL_CLEAN_SAFE_CHARS) {
          out.push(cleanPdfFullText(buffer))
          buffer = block
        } else {
          buffer += block
        }
      }
      if (buffer) out.push(cleanPdfFullText(buffer))
      return out.join('\n')
    }
    if (fileType === 'word') return stripDocxToc(text)
    return text
  }
}

