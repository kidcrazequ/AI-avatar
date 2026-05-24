/**
 * @ 引用 namespace 的 resolver 集合：
 * 给定 namespace + 可选 query，返回 entry 列表；给定 entry，返回展开后的 inlineFile。
 *
 * 复用现有 IPC：
 *   - @knowledge / @decision / @excel  → getKnowledgeTree + readKnowledgeFile
 *   - @conversation                    → getConversations + getMessages
 *   - @web                             → 不进面板，特殊路径（由 caller 直接处理）
 *
 * 设计前提：上下文体量受控（每个 entry 展开后限制大小），过大文件按头部 + 尾部截断。
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import type { ContextEntry } from '../components/ContextReferencePalette'

/** 展开后的 inline 文件结构（与 MessageInput 现有 inlineFiles 契约一致） */
export interface ResolvedInlineFile {
  name: string
  ext: string
  mime: string
  text: string
}

/** 单 entry 展开内容大小上限（字符数；超出按头尾截断） */
const MAX_REFERENCE_CHARS = 40_000
/** 引用 conversation 时最多回看的消息条数 */
const MAX_CONVERSATION_MESSAGES = 30

/** 递归 FileNode 树，按谓词收集 file 节点 */
function flattenFiles(nodes: FileNode[], predicate: (path: string) => boolean): FileNode[] {
  const out: FileNode[] = []
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.type === 'file' && predicate(node.path)) out.push(node)
      else if (node.type === 'directory' && node.children) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** 用 query 过滤 entries（路径或标题包含 query，忽略大小写） */
function filterByQuery<T extends { title: string; subtitle?: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter(it => it.title.toLowerCase().includes(q) || (it.subtitle?.toLowerCase().includes(q) ?? false))
}

/** 头尾截断（中间放省略提示），避免长文件吃光上下文 */
function truncate(text: string, limit = MAX_REFERENCE_CHARS): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.6)
  const tail = limit - head - 200
  return text.slice(0, head) + `\n\n... [省略 ${text.length - head - tail} 字符] ...\n\n` + text.slice(-tail)
}

/**
 * 列出某 namespace 下的所有可引用 entry（不读内容，只列元信息）。
 *
 * @param namespace 引用类别
 * @param avatarId  当前分身（@conversation 也只看本分身下的会话）
 * @param query     过滤关键词
 */
export async function listEntries(
  namespace: 'knowledge' | 'decision' | 'excel' | 'conversation',
  avatarId: string,
  query: string,
  /** 排除的会话 ID（通常是当前会话，避免引用自己） */
  excludeConversationId?: string,
): Promise<ContextEntry[]> {
  if (namespace === 'knowledge') {
    const tree = await window.electronAPI.getKnowledgeTree(avatarId)
    const mdFiles = flattenFiles(tree, (p) => {
      if (!p.endsWith('.md')) return false
      // @knowledge 排除 decisions / _excel / _raw 子树（它们有自己的 namespace）
      if (p.includes('/decisions/') || p.startsWith('decisions/')) return false
      if (p.includes('/_excel/') || p.startsWith('_excel/')) return false
      if (p.includes('/_raw/') || p.startsWith('_raw/')) return false
      return true
    })
    const entries: ContextEntry[] = mdFiles.map(f => ({
      id: f.path,
      title: f.name,
      subtitle: f.path,
      namespace,
    }))
    return filterByQuery(entries, query).slice(0, 100)
  }

  if (namespace === 'decision') {
    const tree = await window.electronAPI.getKnowledgeTree(avatarId)
    const decisions = flattenFiles(tree, (p) => {
      if (!p.endsWith('.md')) return false
      return p.includes('/decisions/') || p.startsWith('decisions/')
    })
    const entries: ContextEntry[] = decisions.map(f => ({
      id: f.path,
      title: f.name,
      subtitle: f.path,
      namespace,
    }))
    return filterByQuery(entries, query).slice(0, 100)
  }

  if (namespace === 'excel') {
    const tree = await window.electronAPI.getKnowledgeTree(avatarId)
    // 兼容两种位置：knowledge/_excel/*.json（中间产物）和 knowledge/**/*.xlsx（原始文件）
    const xlsx = flattenFiles(tree, (p) => /\.(xlsx|xls)$/i.test(p))
    const excelMd = flattenFiles(tree, (p) => p.endsWith('.md') && (p.includes('/_excel/') || p.startsWith('_excel/')))
    const all = [...xlsx, ...excelMd]
    const entries: ContextEntry[] = all.map(f => ({
      id: f.path,
      title: f.name,
      subtitle: f.path,
      namespace,
    }))
    return filterByQuery(entries, query).slice(0, 100)
  }

  if (namespace === 'conversation') {
    const all = await window.electronAPI.getConversations(avatarId)
    const list = excludeConversationId ? all.filter(c => c.id !== excludeConversationId) : all
    // 按 updated_at 倒序
    list.sort((a, b) => b.updated_at - a.updated_at)
    const entries: ContextEntry[] = list.map(c => ({
      id: c.id,
      title: c.title || '(未命名会话)',
      subtitle: new Date(c.updated_at).toLocaleString('zh-CN'),
      namespace,
    }))
    return filterByQuery(entries, query).slice(0, 50)
  }

  return []
}

/** resolveEntryContent 可选参数 */
export interface ResolveOptions {
  /** conversation 引用时回看的消息数（默认 30） */
  conversationMessageCount?: number
}

/**
 * 展开某个 entry 为 inlineFile。
 *
 * 注意：知识库 .md 直接读全文；conversation 取最近 N 条消息文本拼接。
 *      内容超过上限时头尾截断。
 */
export async function resolveEntryContent(
  entry: ContextEntry,
  avatarId: string,
  options: ResolveOptions = {},
): Promise<ResolvedInlineFile | null> {
  try {
    if (entry.namespace === 'knowledge' || entry.namespace === 'decision' || entry.namespace === 'excel') {
      // .xlsx 引用：读 knowledge/_excel/<basename>.json schema + samples，转 markdown 表格
      if (/\.(xlsx|xls)$/i.test(entry.id)) {
        const basename = (entry.id.split('/').pop() || '').replace(/\.(xlsx|xls)$/i, '')
        const jsonPath = `_excel/${basename}.json`
        try {
          const raw = await window.electronAPI.readKnowledgeFile(avatarId, jsonPath)
          const parsed = JSON.parse(raw) as {
            fileName?: string
            sheets?: Array<{
              name: string
              rowCount: number
              columns: Array<{ name: string; dtype: string; samples?: unknown[]; uniqueCount?: number }>
            }>
          }
          const lines: string[] = [`# Excel 引用：${parsed.fileName || entry.id}`, '']
          for (const sheet of parsed.sheets || []) {
            lines.push(`## Sheet: ${sheet.name}（共 ${sheet.rowCount} 行）`)
            lines.push('')
            lines.push('| 列名 | 类型 | 唯一值数 | 样本值 |')
            lines.push('|------|------|----------|--------|')
            for (const col of sheet.columns || []) {
              const samples = (col.samples || []).slice(0, 5).map(s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' / ')
              lines.push(`| ${col.name} | ${col.dtype} | ${col.uniqueCount ?? '-'} | ${samples} |`)
            }
            lines.push('')
          }
          lines.push('（以上是 schema + 列样本，完整行数据请让分身调用 `query_excel` 工具按行查询。）')
          return {
            name: parsed.fileName || entry.id,
            ext: entry.id.slice(entry.id.lastIndexOf('.')),
            mime: 'text/markdown',
            text: truncate(lines.join('\n')),
          }
        } catch {
          // _excel/<basename>.json 不存在 / JSON 损坏：回退到 metadata 提示
          return {
            name: entry.id,
            ext: entry.id.slice(entry.id.lastIndexOf('.')),
            mime: 'application/vnd.ms-excel',
            text: `[Excel 引用：${entry.id}]\n（未找到 schema cache，分身可调用 query_excel 工具按行读取此表。）`,
          }
        }
      }
      const text = await window.electronAPI.readKnowledgeFile(avatarId, entry.id)
      return {
        name: entry.id,
        ext: entry.id.slice(entry.id.lastIndexOf('.')),
        mime: 'text/markdown',
        text: truncate(text),
      }
    }

    if (entry.namespace === 'conversation') {
      const msgs = await window.electronAPI.getMessages(entry.id)
      const limit = Math.max(10, Math.min(200, options.conversationMessageCount ?? MAX_CONVERSATION_MESSAGES))
      const recent = msgs.slice(-limit)
      const transcript = recent.map(m => {
        const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '分身' : '工具'
        return `[${role}] ${m.content}`
      }).join('\n\n')
      return {
        name: `conversation/${entry.title}.md`,
        ext: '.md',
        mime: 'text/markdown',
        text: truncate(
          `# 引用会话：${entry.title}\n（最近 ${recent.length} 条消息）\n\n${transcript}`,
        ),
      }
    }

    return null
  } catch (err) {
    window.electronAPI.logEvent(
      'warn',
      'context-resolver-resolve-failed',
      `${entry.namespace}/${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/** 静态 namespace 元数据 */
export const AVAILABLE_NAMESPACES = [
  { key: 'knowledge', label: 'knowledge', description: '引用分身知识库下的 .md 文档' },
  { key: 'decision', label: 'decision', description: '引用 ADR / 决策记录' },
  { key: 'excel', label: 'excel', description: '引用知识库中的 Excel 表格' },
  { key: 'conversation', label: 'conversation', description: '引用本分身的历史会话' },
  { key: 'web', label: 'web', description: '让分身在回答时联网搜索（实验）' },
] as const
