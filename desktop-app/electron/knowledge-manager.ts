import fs from 'fs'
import path from 'path'

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
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
