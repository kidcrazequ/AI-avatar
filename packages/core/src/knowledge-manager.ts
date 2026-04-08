import fs from 'fs'
import path from 'path'

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

/**
 * 知识文件元数据，用于回填 README.md
 *
 * @author zhi.qu
 * @date 2026-04-02
 */
export interface KnowledgeFileInfo {
  filename: string
  description: string
  source: string
}

/**
 * 图片知识元数据，用于回填 README.md
 *
 * @author zhi.qu
 * @date 2026-04-02
 */
export interface ImageKnowledgeInfo {
  filename: string
  description: string
  targetSection: string
}

export class KnowledgeManager {
  private knowledgePath: string

  constructor(knowledgePath: string) {
    this.knowledgePath = knowledgePath
  }

  // 获取知识库文件树
  getKnowledgeTree(): FileNode[] {
    return this.buildTree(this.knowledgePath)
  }

  private buildTree(dirPath: string): FileNode[] {
    const nodes: FileNode[] = []

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        const relativePath = path.relative(this.knowledgePath, fullPath)

        if (entry.isDirectory()) {
          nodes.push({
            name: entry.name,
            path: relativePath,
            type: 'directory',
            children: this.buildTree(fullPath),
          })
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          nodes.push({
            name: entry.name,
            path: relativePath,
            type: 'file',
          })
        }
      }
    } catch (error) {
      console.error(`读取目录失败: ${dirPath}`, error)
    }

    return nodes.sort((a, b) => {
      // 目录排在前面
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  }

  // 读取文件内容
  readFile(relativePath: string): string {
    try {
      const fullPath = path.join(this.knowledgePath, relativePath)
      return fs.readFileSync(fullPath, 'utf-8')
    } catch (error) {
      console.error(`读取文件失败: ${relativePath}`, error)
      throw error
    }
  }

  // 写入文件内容
  writeFile(relativePath: string, content: string): void {
    try {
      const fullPath = path.join(this.knowledgePath, relativePath)
      const dir = path.dirname(fullPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(fullPath, content, 'utf-8')
    } catch (error) {
      console.error(`写入文件失败: ${relativePath}`, error)
      throw error
    }
  }

  // 创建文件
  createFile(relativePath: string, content: string = ''): void {
    try {
      const fullPath = path.join(this.knowledgePath, relativePath)
      const dir = path.dirname(fullPath)

      // 确保目录存在
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      fs.writeFileSync(fullPath, content, 'utf-8')
    } catch (error) {
      console.error(`创建文件失败: ${relativePath}`, error)
      throw error
    }
  }

  // 删除文件
  deleteFile(relativePath: string): void {
    try {
      const fullPath = path.join(this.knowledgePath, relativePath)
      fs.unlinkSync(fullPath)
    } catch (error) {
      console.error(`删除文件失败: ${relativePath}`, error)
      throw error
    }
  }

  /**
   * 回填 README.md：用实际的知识文件和图片信息替换模板占位符
   *
   * @param agentName 分身显示名称
   * @param files 知识文件元数据列表
   * @param images 图片知识元数据列表
   * @author zhi.qu
   * @date 2026-04-02
   */
  updateReadme(
    agentName: string,
    files: KnowledgeFileInfo[],
    images: ImageKnowledgeInfo[]
  ): void {
    const filesTable = files.length > 0
      ? files.map(f => `| \`${f.filename}\` | ${f.description} | ${f.source} |`).join('\n')
      : '| _(暂无，待添加)_ | | |'

    const imagesTable = images.length > 0
      ? images.map(img => `| \`${img.filename}\` | ${img.description} | ${img.targetSection} |`).join('\n')
      : '| _(暂无，待添加)_ | | |'

    // 扫描实际目录结构生成树
    const actualFiles = this.scanDirectoryTree(this.knowledgePath, '')

    const readme = `# ${agentName} - 知识库

本目录存放 ${agentName} 分身的领域知识文件。分身在工作时会基于这些文件内容进行回答。

## 当前知识文件

| 文件 | 内容 | 来源 |
|------|------|------|
${filesTable}

## 图片知识补充

\`images/\` 目录下存放从文档中提取的关键页面图片（PNG 格式），用于图片内容的识别和学习。以下图片信息已被提取并补充到对应的 Markdown 知识文件中：

| 图片 | 内容 | 已补充到 |
|------|------|---------|
${imagesTable}

## 使用说明

1. 所有知识文件采用 **Markdown 格式**，分身可以直接读取
2. 添加新知识时，请将原始文档（PDF/DOCX 等）转换为 Markdown 后放入本目录
3. PDF 中的图片需要提取并识别后，将关键数据补充到 Markdown 文件中
4. 分身回答时会标注知识来源，格式为 \`[来源: knowledge/文件名]\`
5. 如果知识库中没有相关内容，分身会明确告知并建议补充

## 目录结构

\`\`\`
knowledge/
${actualFiles}
\`\`\`

## 知识文件命名规范

- 使用 **中文名称 + 简短后缀** 命名，如 \`产品名-用户手册.md\`、\`场景名-最佳实践.md\`
- 多产品/多文档对比速查表以 \`-对比表.md\` 结尾
- 从图片识别衍生的独立文件以 \`-从图片识别.md\` 结尾
- 文件名不使用空格，用 \`-\` 分隔

## 知识质量标准

- [${files.every(f => f.source) ? 'x' : ' '}] 每个知识文件开头包含来源说明（原始文档名称和版本）
- [x] 关键数值已标注单位
- [${images.length > 0 ? 'x' : ' '}] 图片中的数据已被识别并写入 Markdown
- [x] 本 README 的知识文件表格已同步更新
`

    fs.writeFileSync(path.join(this.knowledgePath, 'README.md'), readme, 'utf-8')
  }

  /**
   * 扫描目录生成树形结构字符串
   */
  private scanDirectoryTree(dirPath: string, prefix: string): string {
    const lines: string[] = []
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1
          return a.name.localeCompare(b.name)
        })

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        const isLast = i === entries.length - 1
        const connector = isLast ? '└── ' : '├── '
        const childPrefix = isLast ? '    ' : '│   '

        if (entry.isDirectory()) {
          lines.push(`${prefix}${connector}${entry.name}/`)
          const childPath = path.join(dirPath, entry.name)
          const childTree = this.scanDirectoryTree(childPath, prefix + childPrefix)
          if (childTree) lines.push(childTree)
        } else {
          lines.push(`${prefix}${connector}${entry.name}`)
        }
      }
    } catch {
      // 目录不存在时静默忽略
    }
    return lines.join('\n')
  }

  // 搜索文件内容
  searchFiles(query: string): Array<{ path: string; matches: string[] }> {
    const results: Array<{ path: string; matches: string[] }> = []
    const searchLower = query.toLowerCase()

    const searchInDirectory = (dirPath: string) => {
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })

        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name)

          if (entry.isDirectory()) {
            searchInDirectory(fullPath)
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            const content = fs.readFileSync(fullPath, 'utf-8')
            const lines = content.split('\n')
            const matches: string[] = []

            lines.forEach((line, index) => {
              if (line.toLowerCase().includes(searchLower)) {
                matches.push(`${index + 1}: ${line.trim()}`)
              }
            })

            if (matches.length > 0) {
              const relativePath = path.relative(this.knowledgePath, fullPath)
              results.push({ path: relativePath, matches: matches.slice(0, 5) }) // 最多返回 5 个匹配
            }
          }
        }
      } catch (error) {
        console.error(`搜索目录失败: ${dirPath}`, error)
      }
    }

    searchInDirectory(this.knowledgePath)
    return results
  }
}
