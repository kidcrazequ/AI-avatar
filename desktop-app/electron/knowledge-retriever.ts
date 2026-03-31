import fs from 'fs'
import path from 'path'

/**
 * KnowledgeRetriever: 负责按需检索知识库内容（GAP1）。
 * 提供基于关键词匹配的轻量级全文检索，无需外部依赖。
 * 按需读取 knowledge/ 子目录文件（products/、policies/ 等），
 * 只有检索命中时才将内容返回给 LLM。
 */
export class KnowledgeRetriever {
  private knowledgePath: string

  constructor(knowledgePath: string) {
    this.knowledgePath = knowledgePath
  }

  /**
   * 按需检索：搜索 knowledge/ 目录（包括子目录）中的相关内容片段。
   * 返回命中率最高的前 N 个片段（按标题分割）。
   */
  searchChunks(query: string, topN: number = 5): Array<{ file: string; heading: string; content: string; score: number }> {
    const allChunks = this.buildChunks()
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 1)

    const scored = allChunks.map(chunk => {
      const text = (chunk.heading + ' ' + chunk.content).toLowerCase()
      let score = 0
      for (const kw of keywords) {
        const count = (text.match(new RegExp(kw, 'g')) || []).length
        score += count
      }
      return { ...chunk, score }
    })

    return scored
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
  }

  /**
   * 读取指定相对路径的文件完整内容
   */
  readFile(relativePath: string): string {
    const fullPath = path.join(this.knowledgePath, relativePath)
    try {
      return fs.readFileSync(fullPath, 'utf-8')
    } catch {
      throw new Error(`文件不存在: ${relativePath}`)
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

  /** 将所有知识文件按 h2/h3 标题切片 */
  private buildChunks(): Array<{ file: string; heading: string; content: string }> {
    const chunks: Array<{ file: string; heading: string; content: string }> = []
    const files = this.collectFiles(this.knowledgePath)

    for (const filePath of files) {
      const relativePath = path.relative(this.knowledgePath, filePath)
      let content: string
      try {
        content = fs.readFileSync(filePath, 'utf-8')
      } catch {
        continue
      }

      // 按 h2/h3 标题切片
      const sections = content.split(/^#{2,3}\s+/m)
      const headingMatches = [...content.matchAll(/^#{2,3}\s+(.+)$/gm)]

      if (sections.length <= 1) {
        // 无子标题：整个文件作为一个 chunk
        chunks.push({ file: relativePath, heading: relativePath, content: content.slice(0, 800) })
      } else {
        sections.forEach((section, i) => {
          if (!section.trim()) return
          const heading = headingMatches[i - 1]?.[1] ?? relativePath
          chunks.push({ file: relativePath, heading, content: section.slice(0, 800) })
        })
      }
    }

    return chunks
  }

  /** 递归收集 .md 文件路径 */
  private collectFiles(dirPath: string): string[] {
    const results: string[] = []
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          results.push(...this.collectFiles(fullPath))
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(fullPath)
        }
      }
    } catch {
      // 忽略
    }
    return results
  }
}
