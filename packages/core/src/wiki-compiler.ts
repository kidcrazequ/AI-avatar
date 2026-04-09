/**
 * 知识百科编译器（融合 Karpathy LLM Wiki 思想）。
 *
 * 在 avatar 的 wiki/ 目录下生成：
 *   - concepts/          实体概念页（聚合同一实体在不同知识文件中的出现）
 *   - qa/                沉淀的优质问答
 *   - lint-report.json   自检报告
 *
 * 安全保证：wiki/ 目录独立于 knowledge/，不影响现有 SoulLoader、
 * KnowledgeRetriever、RAG 流程。所有数据只在 wiki/ 目录下读写。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */

import fs from 'fs'
import path from 'path'
import type { LLMCallFn } from './document-formatter'
import { tokenize } from './knowledge-retriever'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 知识 chunk 数据（由 KnowledgeRetriever.getFullChunks 提供） */
export interface ChunkData {
  file: string
  heading: string
  content: string
}

/** 实体出现信息 */
export interface EntityAppearance {
  file: string
  heading: string
  excerpt: string
}

/** 提取到的实体信息 */
export interface EntityInfo {
  name: string
  frequency: number
  fileCount: number
  appearances: EntityAppearance[]
}

/** 概念页数据 */
export interface ConceptPage {
  entity: string
  summary: string
  relatedEntities: string[]
  appearances: EntityAppearance[]
  generatedAt: string
}

/** 自检问题 */
export interface LintIssue {
  type: 'contradiction' | 'gap' | 'duplicate'
  severity: 'warning' | 'error'
  description: string
  locations: Array<{ file: string; heading: string; excerpt: string }>
}

/** 自检报告 */
export interface LintReport {
  timestamp: string
  totalChunks: number
  totalFiles: number
  issueCount: number
  issues: LintIssue[]
}

/** Wiki 元数据 */
export interface WikiMeta {
  lastCompiled: string
  entityCount: number
  conceptPageCount: number
  qaCount: number
}

/** 沉淀的问答 */
export interface WikiAnswer {
  id: string
  question: string
  answer: string
  sources: string[]
  savedAt: string
}

/** 编译进度 */
export interface WikiCompileProgress {
  phase: 'entity-extraction' | 'concept-generation' | 'done'
  current: number
  total: number
  detail?: string
}

/**
 * 知识演化差异项。
 * 描述新文件与已有知识之间的单个差异。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
export interface EvolutionDiff {
  entity: string
  type: 'new' | 'updated' | 'contradiction'
  description: string
  oldSource: { file: string; excerpt: string }
  newExcerpt: string
}

/**
 * 知识演化检测报告。
 * 导入新文件时自动生成，仅报告不修改任何现有文件。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
export interface EvolutionReport {
  timestamp: string
  newFile: string
  diffs: EvolutionDiff[]
}

// ─── 常量 ──────────────────────────────────────────────────────────────────────

const META_FILE = '_meta.json'
const CONCEPTS_DIR = 'concepts'
const QA_DIR = 'qa'
const LINT_FILE = 'lint-report.json'
const EVOLUTION_FILE = 'evolution-report.json'

/**
 * 中文停用词表（通用语法词，不含可能作为实体的技术名词）。
 * 过滤这些词后保留有意义的技术术语用于实体识别。
 */
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '那', '这个', '那个', '被', '从', '把', '让', '给', '向', '与',
  '以', '及', '或', '对', '但', '可以', '因为', '所以', '如果', '虽然', '已经',
  '还是', '而且', '同时', '通过', '进行', '使用', '其中', '以及', '可能', '需要',
  '具有', '用于', '提供', '支持', '包括', '以下', '如下', '相关', '实现',
  '采用', '主要', '基于', '根据', '方式', '情况', '条件', '要求', '范围',
  '内容', '方面', '过程', '能够', '应该', '建议', '注意', '确保',
])

/**
 * 概念页生成 Prompt。
 * 要求 LLM 从多个知识文件中聚合同一实体的信息，生成结构化概念页。
 */
const CONCEPT_PAGE_PROMPT = `你是一个知识百科编辑。请为指定实体生成一个概念页面。

要求：
1. 用 1-2 段话概述该实体是什么、用途、关键特性
2. 用表格整理该实体的关键参数/属性（如果片段中有的话）
3. 在最后一行输出"相关实体："，后跟逗号分隔的相关实体名称
4. 所有信息必须来自提供的片段，不添加任何片段中没有的数据
5. 使用 Markdown 格式输出
6. 不要在末尾附加总结或自评`

/**
 * 知识矛盾检测 Prompt。
 * 要求 LLM 对比不同文件中关于同一实体的描述，发现数值矛盾。
 */
const LINT_PROMPT = `你是知识库质量审查员。比较以下来自不同文件的段落，检查关于指定实体的矛盾或不一致。

要求：
1. 只报告明确的数值矛盾（如同一参数在不同文件中给出了不同数值）
2. 不要把"缺少信息"当作矛盾
3. 如果没有矛盾，只输出"无矛盾"
4. 如果有矛盾，每条矛盾一行，格式：矛盾：[描述，包括具体数值和来源文件]`

/**
 * 知识演化检测 Prompt。
 * 对比新导入内容与已有知识中同一实体的描述，识别新增/更新/矛盾。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
const EVOLUTION_PROMPT = `你是知识库演化分析师。对比以下【新内容】和【已有内容】中关于指定实体的描述。

输出 JSON 数组，每项包含：
- type: "new"（已有知识中完全没有的信息）、"updated"（已有知识有但数据更新了）、"contradiction"（新旧数据矛盾）
- description: 一句话描述差异内容

规则：
1. 只关注明确的事实差异，忽略表述差异
2. 如果没有差异，返回空数组 []
3. 输出纯 JSON，不要包含其他文字`

// ─── WikiCompiler 类 ──────────────────────────────────────────────────────────

/**
 * 知识百科编译器。
 *
 * 核心功能：
 * - extractEntities：从知识 chunks 中提取高频实体（纯本地计算，不调 LLM）
 * - compileConceptPages：为跨文件实体生成概念聚合页（调 LLM）
 * - lintKnowledge：检测知识库中的矛盾和重复（调 LLM）
 * - sedimentAnswer：沉淀优质问答到 wiki/qa/
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
export class WikiCompiler {
  private wikiPath: string

  constructor(avatarPath: string) {
    this.wikiPath = path.join(avatarPath, 'wiki')
  }

  /** 确保 wiki 目录结构存在 */
  private ensureDirs(): void {
    const dirs = [
      this.wikiPath,
      path.join(this.wikiPath, CONCEPTS_DIR),
      path.join(this.wikiPath, QA_DIR),
    ]
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
  }

  /**
   * 从知识 chunks 中提取实体（基于词频 × 跨文件分布）。
   * 不调用 LLM，纯本地计算。标题中出现的术语权重加倍。
   *
   * @param chunks 知识 chunks 列表
   * @returns 按重要性排序的实体列表（最多 50 个）
   */
  extractEntities(chunks: ChunkData[]): EntityInfo[] {
    const termMap = new Map<string, {
      files: Set<string>
      total: number
      appearances: EntityAppearance[]
    }>()

    const headingTerms = new Set<string>()
    for (const chunk of chunks) {
      for (const t of tokenize(chunk.heading)) {
        headingTerms.add(t)
      }
    }

    for (const chunk of chunks) {
      const tokens = tokenize(chunk.heading + ' ' + chunk.content)
      const seenInThisChunk = new Set<string>()

      for (const token of tokens) {
        if (STOP_WORDS.has(token) || token.length < 2) continue
        if (/^[\d.,%]+$/.test(token)) continue

        if (!termMap.has(token)) {
          termMap.set(token, { files: new Set(), total: 0, appearances: [] })
        }
        const entry = termMap.get(token)!
        entry.total++
        entry.files.add(chunk.file)

        if (!seenInThisChunk.has(token)) {
          seenInThisChunk.add(token)
          entry.appearances.push({
            file: chunk.file,
            heading: chunk.heading,
            excerpt: chunk.content.slice(0, 150),
          })
        }
      }
    }

    const entities: EntityInfo[] = []
    for (const [name, data] of termMap) {
      if (data.files.size < 2 && data.total < 6) continue

      const headingBoost = headingTerms.has(name) ? 2 : 1
      const score = data.total * Math.log2(data.files.size + 1) * headingBoost
      if (score < 3) continue

      entities.push({
        name,
        frequency: data.total,
        fileCount: data.files.size,
        appearances: data.appearances.slice(0, 20),
      })
    }

    entities.sort((a, b) => {
      const scoreA = a.frequency * Math.log2(a.fileCount + 1)
      const scoreB = b.frequency * Math.log2(b.fileCount + 1)
      return scoreB - scoreA
    })

    return entities.slice(0, 50)
  }

  /**
   * 编译概念页面：为每个高频跨文件实体生成聚合概念页。
   *
   * @param chunks  全量知识 chunks
   * @param callLLM LLM 调用函数
   * @param onProgress 可选进度回调
   * @returns 生成的概念页列表
   */
  async compileConceptPages(
    chunks: ChunkData[],
    callLLM: LLMCallFn,
    onProgress?: (progress: WikiCompileProgress) => void,
  ): Promise<ConceptPage[]> {
    this.ensureDirs()

    const entities = this.extractEntities(chunks)
    if (onProgress) {
      onProgress({
        phase: 'entity-extraction',
        current: entities.length,
        total: entities.length,
        detail: `发现 ${entities.length} 个实体`,
      })
    }

    const topEntities = entities.filter(e => e.fileCount >= 2).slice(0, 20)
    const conceptPages: ConceptPage[] = []

    for (let i = 0; i < topEntities.length; i++) {
      const entity = topEntities[i]
      if (onProgress) {
        onProgress({
          phase: 'concept-generation',
          current: i + 1,
          total: topEntities.length,
          detail: entity.name,
        })
      }

      const relatedChunks = chunks.filter(c =>
        (c.heading + ' ' + c.content).includes(entity.name),
      )

      const excerpts = relatedChunks.slice(0, 10).map((c, idx) =>
        `【片段${idx + 1}·来源：${c.file} > ${c.heading}】\n${c.content.slice(0, 800)}`,
      ).join('\n\n---\n\n')

      const userPrompt = `请为实体"${entity.name}"生成概念页面。` +
        `该实体在 ${entity.fileCount} 个知识文件中出现了 ${entity.frequency} 次。\n\n` +
        `以下是相关片段：\n\n${excerpts}`

      try {
        const pageContent = await callLLM(CONCEPT_PAGE_PROMPT, userPrompt, 2000)

        const relatedMatch = pageContent.match(/相关实体[：:]\s*(.+)$/m)
        const relatedEntities = relatedMatch
          ? relatedMatch[1].split(/[,，、]/).map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 20)
          : []

        const now = new Date().toISOString().slice(0, 10)
        const page: ConceptPage = {
          entity: entity.name,
          summary: pageContent,
          relatedEntities,
          appearances: entity.appearances.slice(0, 10),
          generatedAt: now,
        }
        conceptPages.push(page)

        const safeName = entity.name.replace(/[/\\?%*:|"<>]/g, '_')
        const mdContent = [
          `# ${entity.name}`,
          '',
          `> 自动编译的概念页 | 来源：${entity.fileCount} 个知识文件 | 出现 ${entity.frequency} 次 | 编译日期：${now}`,
          '',
          '---',
          '',
          pageContent,
          '',
          '---',
          '',
          '## 出处',
          '',
          ...entity.appearances.slice(0, 10).map(a => `- ${a.file} > ${a.heading}`),
          '',
        ].join('\n')

        fs.writeFileSync(
          path.join(this.wikiPath, CONCEPTS_DIR, `${safeName}.md`),
          mdContent,
          'utf-8',
        )
      } catch (err) {
        console.warn(`[WikiCompiler] 概念页生成失败 (${entity.name}): ${(err as Error).message}`)
      }
    }

    // 第二遍：交叉引用（backlinks）
    this.buildBacklinks(conceptPages)

    this.updateMeta({
      entityCount: entities.length,
      conceptPageCount: conceptPages.length,
    })

    if (onProgress) {
      onProgress({ phase: 'done', current: topEntities.length, total: topEntities.length })
    }

    return conceptPages
  }

  /**
   * 为概念页生成交叉引用（backlinks）。
   * 扫描每个概念页的内容，如果引用了其他概念页的实体，则在被引用页末尾追加反向链接。
   * 纯本地操作，不调用 LLM。
   *
   * @author zhi.qu
   * @date 2026-04-09
   */
  private buildBacklinks(conceptPages: ConceptPage[]): void {
    const backlinks = new Map<string, Set<string>>()

    for (const page of conceptPages) {
      for (const other of conceptPages) {
        if (other.entity === page.entity) continue
        if (other.summary.includes(page.entity)) {
          if (!backlinks.has(page.entity)) backlinks.set(page.entity, new Set())
          backlinks.get(page.entity)!.add(other.entity)
        }
      }
    }

    for (const [entity, links] of backlinks) {
      const safeName = entity.replace(/[/\\?%*:|"<>]/g, '_')
      const filePath = path.join(this.wikiPath, CONCEPTS_DIR, `${safeName}.md`)
      if (!fs.existsSync(filePath)) continue

      const existing = fs.readFileSync(filePath, 'utf-8')
      if (existing.includes('## 相关概念页')) continue

      const backlinkSection = '\n## 相关概念页\n\n' +
        [...links].map(l => `- [[${l}]]`).join('\n') + '\n'
      fs.appendFileSync(filePath, backlinkSection, 'utf-8')
    }
  }

  /**
   * 知识自检（Lint）：检测知识库中的矛盾和重复。
   * 对跨文件出现的实体，用 LLM 对比不同文件中的描述，发现数值矛盾。
   * 同时用内容指纹检测跨文件重复内容。
   *
   * @param chunks  全量知识 chunks
   * @param callLLM LLM 调用函数
   * @returns 自检报告
   */
  async lintKnowledge(
    chunks: ChunkData[],
    callLLM: LLMCallFn,
  ): Promise<LintReport> {
    this.ensureDirs()

    const entities = this.extractEntities(chunks)
    const crossFileEntities = entities.filter(e => e.fileCount >= 2).slice(0, 15)
    const issues: LintIssue[] = []

    // 矛盾检测：对跨文件实体用 LLM 对比
    for (const entity of crossFileEntities) {
      const fileChunks = new Map<string, ChunkData[]>()
      for (const chunk of chunks) {
        if ((chunk.heading + ' ' + chunk.content).includes(entity.name)) {
          if (!fileChunks.has(chunk.file)) {
            fileChunks.set(chunk.file, [])
          }
          fileChunks.get(chunk.file)!.push(chunk)
        }
      }

      if (fileChunks.size < 2) continue

      const fileExcerpts = [...fileChunks.entries()].slice(0, 5).map(([file, fChunks]) =>
        `【来源：${file}】\n${fChunks[0].content.slice(0, 600)}`,
      )

      try {
        const result = await callLLM(
          LINT_PROMPT.replace('指定实体', entity.name),
          fileExcerpts.join('\n\n---\n\n'),
          500,
        )

        if (result && !result.includes('无矛盾')) {
          issues.push({
            type: 'contradiction',
            severity: 'warning',
            description: `${entity.name}：${result.replace(/^矛盾[：:]\s*/gm, '').trim()}`,
            locations: [...fileChunks.entries()].slice(0, 3).map(([file, fChunks]) => ({
              file,
              heading: fChunks[0].heading,
              excerpt: fChunks[0].content.slice(0, 200),
            })),
          })
        }
      } catch (err) {
        console.warn(`[WikiCompiler] Lint 检查失败 (${entity.name}): ${(err as Error).message}`)
      }
    }

    // 重复内容检测：基于内容指纹
    const contentHashes = new Map<string, { file: string; heading: string }>()
    for (const chunk of chunks) {
      const fingerprint = chunk.content.slice(0, 100).replace(/\s+/g, '')
      if (fingerprint.length < 50) continue

      if (contentHashes.has(fingerprint)) {
        const existing = contentHashes.get(fingerprint)!
        if (existing.file !== chunk.file) {
          issues.push({
            type: 'duplicate',
            severity: 'warning',
            description: `发现疑似重复内容：${existing.file} 和 ${chunk.file} 中存在高度相似的段落`,
            locations: [
              { file: existing.file, heading: existing.heading, excerpt: fingerprint.slice(0, 100) },
              { file: chunk.file, heading: chunk.heading, excerpt: chunk.content.slice(0, 100) },
            ],
          })
        }
      } else {
        contentHashes.set(fingerprint, { file: chunk.file, heading: chunk.heading })
      }
    }

    const files = new Set(chunks.map(c => c.file))
    const report: LintReport = {
      timestamp: new Date().toISOString(),
      totalChunks: chunks.length,
      totalFiles: files.size,
      issueCount: issues.length,
      issues,
    }

    fs.writeFileSync(
      path.join(this.wikiPath, LINT_FILE),
      JSON.stringify(report, null, 2),
      'utf-8',
    )

    return report
  }

  /**
   * 沉淀优质问答到 wiki/qa/。
   * 将高质量的对话回答保存为知识页面，供后续浏览和参考。
   *
   * @param qa 问答数据
   */
  sedimentAnswer(qa: WikiAnswer): void {
    this.ensureDirs()

    const safeName = qa.id.replace(/[/\\?%*:|"<>]/g, '_')
    const content = [
      `# Q: ${qa.question}`,
      '',
      `> 沉淀时间：${qa.savedAt} | 来源：${qa.sources.join(', ') || '对话'}`,
      '',
      '---',
      '',
      qa.answer,
      '',
    ].join('\n')

    fs.writeFileSync(
      path.join(this.wikiPath, QA_DIR, `${safeName}.md`),
      content,
      'utf-8',
    )

    const meta = this.getMeta()
    this.updateMeta({ qaCount: (meta?.qaCount ?? 0) + 1 })
  }

  /**
   * 获取所有沉淀的问答列表。
   */
  getAnswers(): WikiAnswer[] {
    const qaDir = path.join(this.wikiPath, QA_DIR)
    if (!fs.existsSync(qaDir)) return []

    const answers: WikiAnswer[] = []
    try {
      const files = fs.readdirSync(qaDir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        const raw = fs.readFileSync(path.join(qaDir, file), 'utf-8')
        const questionMatch = raw.match(/^#\s+Q:\s+(.+)$/m)
        const timeMatch = raw.match(/沉淀时间：([^\s|]+)/)
        const sourceMatch = raw.match(/来源：(.+)/)
        const bodyMatch = raw.match(/---\n\n([\s\S]+)$/)

        answers.push({
          id: file.replace(/\.md$/, ''),
          question: questionMatch?.[1] ?? '',
          answer: bodyMatch?.[1]?.trim() ?? '',
          sources: sourceMatch?.[1]?.split(', ').filter(Boolean) ?? [],
          savedAt: timeMatch?.[1] ?? '',
        })
      }
    } catch {
      // 目录读取失败时返回空
    }

    return answers.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  }

  /**
   * 获取所有概念页列表。
   */
  getConceptPages(): Array<{ name: string; entity: string; generatedAt: string }> {
    const conceptDir = path.join(this.wikiPath, CONCEPTS_DIR)
    if (!fs.existsSync(conceptDir)) return []

    const pages: Array<{ name: string; entity: string; generatedAt: string }> = []
    try {
      const files = fs.readdirSync(conceptDir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        const raw = fs.readFileSync(path.join(conceptDir, file), 'utf-8')
        const entityMatch = raw.match(/^#\s+(.+)$/m)
        const dateMatch = raw.match(/编译日期：([\d-]+)/)

        pages.push({
          name: file.replace(/\.md$/, ''),
          entity: entityMatch?.[1] ?? file,
          generatedAt: dateMatch?.[1] ?? '',
        })
      }
    } catch {
      // ignore
    }

    return pages
  }

  /**
   * 读取指定概念页内容。
   *
   * @param name 概念页文件名（不含 .md 后缀）
   */
  readConceptPage(name: string): string {
    const filePath = path.join(this.wikiPath, CONCEPTS_DIR, `${name}.md`)
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch {
      throw new Error(`概念页不存在: ${name}`)
    }
  }

  /**
   * 获取最近的 Lint 报告。
   */
  getLintReport(): LintReport | null {
    const reportPath = path.join(this.wikiPath, LINT_FILE)
    if (!fs.existsSync(reportPath)) return null

    try {
      return JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as LintReport
    } catch {
      return null
    }
  }

  /**
   * 获取 wiki 元数据（编译状态）。
   */
  getMeta(): WikiMeta | null {
    const metaPath = path.join(this.wikiPath, META_FILE)
    if (!fs.existsSync(metaPath)) return null

    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as WikiMeta
    } catch {
      return null
    }
  }

  /** 更新 wiki 元数据 */
  private updateMeta(updates: Partial<WikiMeta>): void {
    const existing = this.getMeta() || {
      lastCompiled: '',
      entityCount: 0,
      conceptPageCount: 0,
      qaCount: 0,
    }

    const meta: WikiMeta = {
      ...existing,
      ...updates,
      lastCompiled: new Date().toISOString(),
    }

    fs.writeFileSync(
      path.join(this.wikiPath, META_FILE),
      JSON.stringify(meta, null, 2),
      'utf-8',
    )
  }

  /**
   * 检测新导入文件与已有知识的演化差异。
   * 提取新内容中的实体，在已有 chunks 中搜索同名实体，用 LLM 对比差异。
   * 结果保存到 wiki/evolution-report.json，不修改任何现有文件。
   *
   * @param newContent   新导入文件的内容
   * @param newFileName  新导入文件的名称
   * @param existingChunks 已有知识库的全量 chunks
   * @param callLLM      LLM 调用函数
   * @returns 演化检测报告
   *
   * @author zhi.qu
   * @date 2026-04-09
   */
  async detectEvolution(
    newContent: string,
    newFileName: string,
    existingChunks: ChunkData[],
    callLLM: LLMCallFn,
  ): Promise<EvolutionReport> {
    this.ensureDirs()

    const report: EvolutionReport = {
      timestamp: new Date().toISOString(),
      newFile: newFileName,
      diffs: [],
    }

    // 1. 从新内容中提取实体（频率 > 2）
    const tokens = tokenize(newContent)
    const termFreq = new Map<string, number>()
    for (const t of tokens) {
      if (t.length < 2 || /^[\d.,%]+$/.test(t)) continue
      termFreq.set(t, (termFreq.get(t) || 0) + 1)
    }
    const newEntities = [...termFreq.entries()]
      .filter(([, freq]) => freq > 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name]) => name)

    if (newEntities.length === 0) {
      fs.writeFileSync(
        path.join(this.wikiPath, EVOLUTION_FILE),
        JSON.stringify(report, null, 2),
        'utf-8',
      )
      return report
    }

    // 2. 在已有 chunks 中搜索包含这些实体的片段
    for (const entity of newEntities) {
      const matchingChunks = existingChunks.filter(c =>
        (c.heading + ' ' + c.content).includes(entity),
      )
      if (matchingChunks.length === 0) continue

      // 3. 提取新内容中关于该实体的段落
      const lines = newContent.split('\n')
      const relevantLines = lines.filter(l => l.includes(entity))
      const newExcerpt = relevantLines.slice(0, 10).join('\n').slice(0, 1000)
      if (newExcerpt.trim().length < 20) continue

      // 4. 提取已有内容中关于该实体的描述
      const oldExcerpt = matchingChunks
        .slice(0, 3)
        .map(c => `【来源：${c.file} > ${c.heading}】\n${c.content.slice(0, 500)}`)
        .join('\n\n')

      // 5. 用 LLM 对比
      try {
        const userPrompt = `实体：${entity}\n\n【新内容】\n${newExcerpt}\n\n【已有内容】\n${oldExcerpt}`
        const result = await callLLM(EVOLUTION_PROMPT, userPrompt, 800)

        const jsonMatch = result.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
          const diffs = JSON.parse(jsonMatch[0]) as Array<{
            type: 'new' | 'updated' | 'contradiction'
            description: string
          }>
          for (const diff of diffs) {
            report.diffs.push({
              entity,
              type: diff.type,
              description: diff.description,
              oldSource: {
                file: matchingChunks[0].file,
                excerpt: matchingChunks[0].content.slice(0, 200),
              },
              newExcerpt: newExcerpt.slice(0, 200),
            })
          }
        }
      } catch (err) {
        console.warn(`[WikiCompiler] 演化检测失败 (${entity}): ${(err as Error).message}`)
      }
    }

    // 保存报告
    fs.writeFileSync(
      path.join(this.wikiPath, EVOLUTION_FILE),
      JSON.stringify(report, null, 2),
      'utf-8',
    )

    return report
  }

  /**
   * 获取最近的知识演化检测报告。
   *
   * @author zhi.qu
   * @date 2026-04-09
   */
  getEvolutionReport(): EvolutionReport | null {
    const filePath = path.join(this.wikiPath, EVOLUTION_FILE)
    if (!fs.existsSync(filePath)) return null
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as EvolutionReport
    } catch {
      return null
    }
  }

  /**
   * 保存原始文件到 knowledge/_raw/。
   * 只做文件复制，不影响知识文件的 .md 过滤逻辑。
   * 同名文件自动添加时间戳后缀避免覆盖。
   *
   * @param knowledgePath 知识库根路径
   * @param originalFilePath 原始文件的绝对路径
   * @returns 保存后的相对路径（相对于 knowledgePath）
   */
  static preserveRawFile(knowledgePath: string, originalFilePath: string): string {
    const rawDir = path.join(knowledgePath, '_raw')
    if (!fs.existsSync(rawDir)) {
      fs.mkdirSync(rawDir, { recursive: true })
    }

    const fileName = path.basename(originalFilePath)
    let targetPath = path.join(rawDir, fileName)

    if (fs.existsSync(targetPath)) {
      const ext = path.extname(fileName)
      const base = path.basename(fileName, ext)
      targetPath = path.join(rawDir, `${base}-${Date.now()}${ext}`)
    }

    fs.copyFileSync(originalFilePath, targetPath)
    return path.relative(knowledgePath, targetPath)
  }
}
