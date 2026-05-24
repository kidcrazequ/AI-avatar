/**
 * 全局搜索面板（Cmd+P / Ctrl+P 唤起）：
 * 跨分身搜消息 + 当前分身的知识库片段。
 *
 * 设计：
 *   - 顶部输入框自动聚焦
 *   - 输入 debounce 250ms 后并行调 searchMessages + searchKnowledgeChunks
 *   - 结果分两组（消息 / 知识库）显示，键盘可跨组上下移动
 *   - Enter 跳转，Esc 关闭
 *
 * 跨分身策略：消息搜全分身，知识库仅搜当前分身（避免 N 次 IPC 卡顿）。
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import { useState, useEffect, useRef, useCallback, useMemo, KeyboardEvent } from 'react'

interface AvatarMeta {
  id: string
  name: string
}

/** 统一的结果项（消息 / 知识库 / 记忆） */
interface SearchHit {
  kind: 'message' | 'knowledge' | 'memory'
  /** 唯一 key */
  key: string
  /** 标题（如对话标题 / 文件名 / 记忆行） */
  title: string
  /** 副标题（如 snippet / heading / context） */
  subtitle: string
  /** 第三行（如所属分身 + 时间，仅消息有） */
  meta?: string
  /** 跳转所需信息 */
  avatarId?: string
  conversationId?: string
  knowledgeFile?: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  /** 当前活动 avatar（用于知识库搜索范围） */
  currentAvatarId: string
  /** 导航到某个对话（已切到对应分身） */
  onNavigateToConversation: (avatarId: string, conversationId: string) => void
  /** 导航到某个知识库文件 */
  onNavigateToKnowledgeFile: (avatarId: string, relativePath: string) => void
  /** 导航到某个分身的 memory panel */
  onNavigateToMemory: (avatarId: string) => void
}

/** 输入 debounce 周期 */
const DEBOUNCE_MS = 250

export default function GlobalSearchPalette({
  isOpen,
  onClose,
  currentAvatarId,
  onNavigateToConversation,
  onNavigateToKnowledgeFile,
  onNavigateToMemory,
}: Props) {
  const [query, setQuery] = useState('')
  const [messages, setMessages] = useState<MessageSearchResult[]>([])
  const [knowledge, setKnowledge] = useState<Array<{ file: string; heading: string; content: string; score: number }>>([])
  const [memory, setMemory] = useState<Array<{ avatarId: string; lineNo: number; line: string; context: string }>>([])
  const [avatars, setAvatars] = useState<AvatarMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 打开时聚焦 + 拉 avatar 列表 + 重置
  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setMessages([])
    setKnowledge([])
    setMemory([])
    setSelectedIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
    window.electronAPI.listAvatars().then(list => {
      if (!mountedRef.current) return
      setAvatars(list.map(a => ({ id: a.id, name: a.name })))
    }).catch(() => { /* 忽略：avatar 名字缺失时回退到 id */ })
  }, [isOpen])

  const avatarNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of avatars) map.set(a.id, a.name)
    return map
  }, [avatars])

  // debounce 搜索
  useEffect(() => {
    if (!isOpen) return
    const trimmed = query.trim()
    if (!trimmed) { setMessages([]); setKnowledge([]); setMemory([]); setLoading(false); return }
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const tasks: Array<Promise<unknown>> = [
          window.electronAPI.searchMessages(trimmed).then(r => { if (mountedRef.current) setMessages(r) }),
          window.electronAPI.searchMemory(trimmed).then(r => { if (mountedRef.current) setMemory(r) }).catch(() => { /* 记忆扫描失败静默 */ }),
        ]
        if (currentAvatarId) {
          tasks.push(
            window.electronAPI.searchKnowledgeChunks(currentAvatarId, trimmed, 8).then(r => {
              if (mountedRef.current) setKnowledge(r)
            }).catch(() => { /* 知识库未建索引时静默 */ }),
          )
        }
        await Promise.allSettled(tasks)
      } finally {
        if (mountedRef.current) {
          setLoading(false)
          setSelectedIndex(0)
        }
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, isOpen, currentAvatarId])

  /** 合并为统一 hit 列表，消息组在前，知识组在后 */
  const hits = useMemo<SearchHit[]>(() => {
    const out: SearchHit[] = []
    for (const m of messages) {
      const avatarName = avatarNameById.get(m.avatarId) || m.avatarId
      out.push({
        kind: 'message',
        key: `msg:${m.messageId}`,
        title: m.conversationTitle || '(未命名对话)',
        subtitle: m.snippet,
        meta: `${avatarName} · ${new Date(m.createdAt).toLocaleString('zh-CN')}`,
        avatarId: m.avatarId,
        conversationId: m.conversationId,
      })
    }
    for (const k of knowledge) {
      out.push({
        kind: 'knowledge',
        key: `kb:${k.file}:${k.heading}`,
        title: k.heading || k.file,
        subtitle: k.content.slice(0, 200),
        meta: `知识库 · ${k.file}`,
        avatarId: currentAvatarId,
        knowledgeFile: k.file,
      })
    }
    for (const m of memory) {
      const avatarName = avatarNameById.get(m.avatarId) || m.avatarId
      out.push({
        kind: 'memory',
        key: `mem:${m.avatarId}:${m.lineNo}`,
        title: m.line.trim().slice(0, 80) || '(空行)',
        subtitle: m.context,
        meta: `记忆 · ${avatarName} · 第 ${m.lineNo} 行`,
        avatarId: m.avatarId,
      })
    }
    return out
  }, [messages, knowledge, memory, avatarNameById, currentAvatarId])

  const handleSelectHit = useCallback((hit: SearchHit) => {
    if (hit.kind === 'message' && hit.avatarId && hit.conversationId) {
      onNavigateToConversation(hit.avatarId, hit.conversationId)
      onClose()
    } else if (hit.kind === 'knowledge' && hit.avatarId && hit.knowledgeFile) {
      onNavigateToKnowledgeFile(hit.avatarId, hit.knowledgeFile)
      onClose()
    } else if (hit.kind === 'memory' && hit.avatarId) {
      onNavigateToMemory(hit.avatarId)
      onClose()
    }
  }, [onNavigateToConversation, onNavigateToKnowledgeFile, onNavigateToMemory, onClose])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (hits.length > 0) setSelectedIndex(i => Math.min(i + 1, hits.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[selectedIndex]
      if (hit) handleSelectHit(hit)
    }
  }, [hits, selectedIndex, handleSelectHit, onClose])

  // 选中项滚入视口
  useEffect(() => {
    const ul = listRef.current
    if (!ul) return
    const el = ul.querySelector<HTMLLIElement>(`li[data-index="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] bg-black/50"
      onMouseDown={onClose}
    >
      <div
        className="w-[640px] max-w-[92vw] bg-px-surface border-2 border-px-border shadow-pixel-brand flex flex-col max-h-[70vh]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b-2 border-px-border px-3 py-2 bg-px-elevated">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索所有对话和当前分身的知识库...  (Esc 关闭)"
            className="w-full bg-transparent text-px-text font-game text-[13px] outline-none placeholder:text-px-text-dim"
            aria-label="全局搜索"
          />
        </div>

        <div className="px-3 py-1 border-b-2 border-px-border bg-px-bg/40 flex items-center justify-between">
          <div className="font-game text-[10px] text-px-text-dim tracking-wider uppercase">
            ↑↓ 选择 · Enter 跳转 · Esc 取消
          </div>
          <div className="font-mono text-[10px] text-px-text-dim">
            {loading ? '搜索中…' : hits.length > 0 ? `${hits.length} 条结果` : query ? '无结果' : ''}
          </div>
        </div>

        <ul ref={listRef} className="overflow-y-auto flex-1">
          {hits.length === 0 && !loading && query && (
            <li className="px-4 py-6 font-game text-[12px] text-px-text-dim text-center">
              没有匹配项
            </li>
          )}
          {hits.length === 0 && !query && (
            <li className="px-4 py-6 font-game text-[11px] text-px-text-dim text-center">
              开始输入以搜索对话与知识
            </li>
          )}
          {hits.map((hit, index) => {
            const active = index === selectedIndex
            return (
              <li
                key={hit.key}
                data-index={index}
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(e) => { e.preventDefault(); handleSelectHit(hit) }}
                className={`px-3 py-2 cursor-pointer border-b border-px-border/40 last:border-b-0
                  ${active ? 'bg-px-primary/10 border-l-2 border-l-px-primary' : 'hover:bg-px-elevated/60'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-game text-[12px] text-px-text tracking-wider truncate flex-1">
                    {hit.title}
                  </div>
                  <span className="font-mono text-[9px] text-px-text-dim px-1.5 py-0.5 border border-px-border/60 flex-shrink-0 uppercase">
                    {hit.kind === 'message' ? '对话' : hit.kind === 'knowledge' ? '知识' : '记忆'}
                  </span>
                </div>
                <div className="font-game text-[10px] text-px-text-dim mt-0.5 line-clamp-2"
                  dangerouslySetInnerHTML={{ __html: escapeAndHighlight(hit.subtitle) }}
                />
                {hit.meta && (
                  <div className="font-mono text-[9px] text-px-text-dim/80 mt-0.5 truncate">
                    {hit.meta}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/** FTS5 snippet 返回的 [keyword] 标记转 <mark>；其它 HTML 字符全部转义 */
function escapeAndHighlight(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  // FTS5 在 snippet 用了 '[' ']' 包围匹配片段；现在已经被转义为 &lt; / &gt; 不存在了，
  // 所以匹配原始字符 '[' ']'（在 escaped 中仍然是原字符）
  return escaped.replace(/\[([^\]]+)\]/g, '<mark class="bg-px-primary/30 text-px-primary px-0.5">$1</mark>')
}
