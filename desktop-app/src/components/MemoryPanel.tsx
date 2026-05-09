import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  MEMORY_CHAR_LIMIT,
  MEMORY_WARN_THRESHOLD,
  STRUCTURED_MEMORY_FILENAME,
  formatStructuredMemoryDateLabel,
} from '@soul/core/browser'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  onClose: () => void
}

type MemoryTab = 'entries' | 'markdown'

const DEFAULT_CATEGORIES = ['preference', 'correction', 'project', 'decision', 'other'] as const

function newUuid(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export default function MemoryPanel({ avatarId, onClose }: Props) {
  const [tab, setTab] = useState<MemoryTab>('entries')
  const [content, setContent] = useState('')
  const [editedContent, setEditedContent] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isConsolidating, setIsConsolidating] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [stats, setStats] = useState<{ chars: number; ratio: number; entries: number } | null>(null)
  const [memoryDoc, setMemoryDoc] = useState<StructuredMemoryDocumentDTO>({ schemaVersion: 1, entries: [] })
  const [draftCategory, setDraftCategory] = useState('preference')
  const [draftContent, setDraftContent] = useState('')
  const [draftSource, setDraftSource] = useState('manual')
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(statusTimerRef.current)
    }
  }, [])

  const loadSeqRef = useRef(0)

  const loadAll = useCallback(async () => {
    const seq = ++loadSeqRef.current
    try {
      const [memContent, store, memStats] = await Promise.all([
        window.electronAPI.readMemory(avatarId),
        window.electronAPI.readMemoryStore(avatarId),
        window.electronAPI.getMemoryStats(avatarId),
      ])
      if (loadSeqRef.current !== seq) return
      setContent(memContent)
      setEditedContent(memContent)
      setMemoryDoc(store.schemaVersion === 1 ? store : { schemaVersion: 1, entries: [] })
      setStats(memStats)
    } catch (error) {
      if (loadSeqRef.current !== seq) return
      const msg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('error', 'memory-panel-load', msg)
      showStatus('LOAD FAILED')
    }
  }, [avatarId])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const showStatus = (msg: string) => {
    if (!mountedRef.current) return
    setStatusMsg(msg)
    clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => { if (mountedRef.current) setStatusMsg('') }, 2500)
  }

  const handleSaveMarkdown = async () => {
    setIsSaving(true)
    try {
      await window.electronAPI.writeMemory(avatarId, editedContent)
      if (!mountedRef.current) return
      setContent(editedContent)
      setIsEditing(false)
      const memStats = await window.electronAPI.getMemoryStats(avatarId)
      if (!mountedRef.current) return
      setStats(memStats)
      showStatus('SAVED')
    } catch (error) {
      if (!mountedRef.current) return
      const msg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('error', 'memory-md-save', msg)
      showStatus('FAILED')
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const handleSaveStore = async (next: StructuredMemoryDocumentDTO) => {
    setIsSaving(true)
    try {
      await window.electronAPI.writeMemoryStore(avatarId, next)
      if (!mountedRef.current) return
      setMemoryDoc(next)
      const memStats = await window.electronAPI.getMemoryStats(avatarId)
      if (!mountedRef.current) return
      setStats(memStats)
      showStatus('SAVED')
    } catch (error) {
      if (!mountedRef.current) return
      const msg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('error', 'memory-store-save', msg)
      showStatus('FAILED')
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const handleAddEntry = async () => {
    const text = draftContent.trim()
    if (!text) {
      showStatus('内容为空')
      return
    }
    const now = new Date().toISOString()
    const entry: StructuredMemoryEntryDTO = {
      id: newUuid(),
      createdAt: now,
      updatedAt: now,
      category: draftCategory.trim() || 'other',
      content: text,
      source: draftSource.trim() || undefined,
    }
    await handleSaveStore({ schemaVersion: 1, entries: [...memoryDoc.entries, entry] })
    setDraftContent('')
  }

  const handleDeleteEntry = async (id: string) => {
    await handleSaveStore({
      schemaVersion: 1,
      entries: memoryDoc.entries.filter(e => e.id !== id),
    })
    if (editingEntryId === id) setEditingEntryId(null)
  }

  const handleUpdateEntry = async (id: string, patch: Partial<StructuredMemoryEntryDTO>) => {
    const now = new Date().toISOString()
    await handleSaveStore({
      schemaVersion: 1,
      entries: memoryDoc.entries.map(e =>
        e.id === id ? { ...e, ...patch, updatedAt: now } : e
      ),
    })
    setEditingEntryId(null)
  }

  const handleConsolidate = async () => {
    setIsConsolidating(true)
    try {
      const apiKey = await window.electronAPI.getSetting('chat_api_key') ?? ''
      if (!apiKey) {
        showStatus('请先在设置中配置 API Key')
        return
      }
      const baseUrl = await window.electronAPI.getSetting('chat_base_url') ?? ''
      const consolidated = await window.electronAPI.consolidateMemory(avatarId, content, apiKey, baseUrl)
      if (!mountedRef.current) return
      await window.electronAPI.writeMemory(avatarId, consolidated)
      if (!mountedRef.current) return
      setContent(consolidated)
      setEditedContent(consolidated)
      const memStats = await window.electronAPI.getMemoryStats(avatarId)
      if (!mountedRef.current) return
      setStats(memStats)
      showStatus('CONSOLIDATED')
    } catch (error) {
      if (!mountedRef.current) return
      const msg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('error', 'memory-consolidate', msg)
      showStatus('CONSOLIDATE FAILED')
    } finally {
      if (mountedRef.current) setIsConsolidating(false)
    }
  }

  const handleClearMarkdown = async () => {
    const defaultMemory = `# Memory Index\n\n本文件用于记录长期记忆。\n\n## 偏好记录\n\n## 纠偏记录\n\n## 项目记录\n\n## 决策记录\n`
    setEditedContent(defaultMemory)
    showStatus('RESET (unsaved)')
  }

  const getCapacityColor = () => {
    if (!stats) return 'bg-px-primary'
    if (stats.ratio >= 1.0) return 'bg-px-danger'
    if (stats.ratio >= MEMORY_WARN_THRESHOLD) return 'bg-yellow-400'
    return 'bg-px-primary'
  }

  const fileLabel = tab === 'entries' ? STRUCTURED_MEMORY_FILENAME : 'memory/MEMORY.md'

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <PanelHeader
        title="MEMORY"
        subtitle={`${avatarId} · ${tab === 'entries' ? `${memoryDoc.entries.length} 条` : `${content.split('\n').length} lines`}`}
        onClose={onClose}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center gap-1 px-3 py-2 bg-px-elevated border-b-2 border-px-border">
          <button
            type="button"
            onClick={() => setTab('entries')}
            className={`px-3 py-1 font-game text-[11px] tracking-wider border-2 ${tab === 'entries' ? 'border-px-primary bg-px-primary/15 text-px-text' : 'border-px-border text-px-text-dim'}`}
          >
            条目
          </button>
          <button
            type="button"
            onClick={() => setTab('markdown')}
            className={`px-3 py-1 font-game text-[11px] tracking-wider border-2 ${tab === 'markdown' ? 'border-px-primary bg-px-primary/15 text-px-text' : 'border-px-border text-px-text-dim'}`}
          >
            MEMORY.md
          </button>
        </div>

        <div className="flex items-center justify-between px-4 py-2 bg-px-elevated border-b-2 border-px-border">
          <div className="flex items-center gap-2">
            <span className="font-game text-[12px] text-px-text-dim">{fileLabel}</span>
            {statusMsg && (
              <span className={`font-game text-[12px] tracking-wider ${statusMsg.includes('SAVED') || statusMsg.includes('CONSOLIDATED') ? 'text-px-success' : statusMsg.includes('FAIL') ? 'text-px-danger' : 'text-px-primary'}`}>
                {statusMsg}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {tab === 'markdown' ? (
              isEditing ? (
                <>
                  <button type="button" onClick={handleClearMarkdown} className="pixel-btn-outline-muted py-1">RESET</button>
                  <button type="button" onClick={() => { setIsEditing(false); setEditedContent(content) }} className="pixel-btn-outline-muted py-1">CANCEL</button>
                  <button type="button" onClick={() => void handleSaveMarkdown()} disabled={isSaving} className="pixel-btn-primary py-1">
                    {isSaving ? '...' : 'SAVE'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void handleConsolidate()}
                    disabled={isConsolidating}
                    title="仅整理 MEMORY.md（结构化条目请在「条目」页编辑）"
                    className="pixel-btn-outline-muted py-1 text-[12px]"
                  >
                    {isConsolidating ? '整理中...' : 'CONSOLIDATE'}
                  </button>
                  <button type="button" onClick={() => setIsEditing(true)} className="pixel-btn-outline-light py-1">EDIT</button>
                </>
              )
            ) : null}
          </div>
        </div>

        {stats && (
          <div className="px-4 py-2 bg-px-bg border-b border-px-border-dim">
            <div className="flex items-center justify-between mb-1">
              <span className="font-game text-[11px] text-px-text-dim">注入体积（条目 + MEMORY.md）</span>
              <span className={`font-game text-[11px] ${stats.ratio >= 1.0 ? 'text-px-danger' : stats.ratio >= MEMORY_WARN_THRESHOLD ? 'text-yellow-400' : 'text-px-text-dim'}`}>
                {stats.chars} / {MEMORY_CHAR_LIMIT} 字符
                {stats.ratio >= 1.0 && ' ⚠ 已超限，建议整理'}
                {stats.ratio >= MEMORY_WARN_THRESHOLD && stats.ratio < 1.0 && ' · 接近上限'}
              </span>
            </div>
            <div className="w-full h-1.5 bg-px-border rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${getCapacityColor()}`}
                style={{ width: `${Math.min(stats.ratio * 100, 100)}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-hidden bg-px-surface">
          {tab === 'markdown' ? (
            isEditing ? (
              <textarea
                value={editedContent}
                onChange={(e) => setEditedContent(e.target.value)}
                className="w-full h-full resize-none p-6 font-mono text-[14px] bg-px-surface text-px-text border-none outline-none
                  focus:shadow-none leading-relaxed"
                placeholder="# Memory Index..."
              />
            ) : (
              <div className="h-full overflow-y-auto p-6">
                {content ? (
                  <div className="prose prose-sm prose-invert max-w-none prose-pixel font-body
                  prose-headings:font-game prose-headings:font-bold prose-headings:text-px-text prose-headings:tracking-wider
                  prose-p:text-px-text-sec prose-p:leading-[1.75] prose-p:text-[14px] prose-p:font-body
                  prose-code:text-px-accent prose-code:bg-px-bg prose-code:px-1.5 prose-code:py-0.5 prose-code:border prose-code:border-px-border prose-code:text-[13px] prose-code:font-mono
                  prose-strong:text-px-text prose-strong:font-bold
                  prose-a:text-px-primary prose-a:no-underline hover:prose-a:underline
                  prose-li:text-px-text-sec prose-li:marker:text-px-primary prose-li:font-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                      <div className="w-12 h-12 border-2 border-px-primary bg-px-primary/10 flex items-center justify-center mx-auto mb-3">
                        <span className="text-px-primary font-game text-[12px]">M</span>
                      </div>
                      <p className="font-game text-[13px] text-px-text-dim tracking-wider">暂无记录</p>
                      <p className="font-game text-[12px] text-px-text-dim mt-1">切换「MEMORY.md」编辑或写结构化条目</p>
                    </div>
                  </div>
                )}
              </div>
            )
          ) : (
            <div className="h-full overflow-y-auto p-4 flex flex-col gap-4">
              <div className="border-2 border-px-border p-3 bg-px-bg space-y-2">
                <p className="font-game text-[11px] text-px-text-dim">新增条目（写入 {STRUCTURED_MEMORY_FILENAME}，与 SoulLoader 长期记忆注入同源）</p>
                <div className="flex flex-wrap gap-1">
                  {DEFAULT_CATEGORIES.map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setDraftCategory(c)}
                      className={`px-2 py-0.5 font-mono text-[11px] border ${draftCategory === c ? 'border-px-primary text-px-primary' : 'border-px-border text-px-text-dim'}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={draftCategory}
                  onChange={(e) => setDraftCategory(e.target.value)}
                  className="w-full px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px] text-px-text"
                  placeholder="类别（可自定）"
                />
                <input
                  type="text"
                  value={draftSource}
                  onChange={(e) => setDraftSource(e.target.value)}
                  className="w-full px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px] text-px-text"
                  placeholder="来源（可选，如 manual）"
                />
                <textarea
                  value={draftContent}
                  onChange={(e) => setDraftContent(e.target.value)}
                  className="w-full min-h-[88px] px-2 py-1 bg-px-surface border border-px-border font-mono text-[13px] text-px-text"
                  placeholder="正文…"
                />
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => void handleAddEntry()}
                  className="pixel-btn-primary py-1 text-[12px]"
                >
                  添加并保存
                </button>
              </div>

              <div className="space-y-2">
                {memoryDoc.entries.length === 0 ? (
                  <p className="font-game text-[12px] text-px-text-dim text-center py-8">尚无结构化条目；模型自动写入的记忆仍在 MEMORY.md。</p>
                ) : (
                  memoryDoc.entries
                    .slice()
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                    .map(entry => (
                      <div key={entry.id} className="border-2 border-px-border p-3 bg-px-elevated/40">
                        {editingEntryId === entry.id ? (
                          <EntryEditor
                            entry={entry}
                            onCancel={() => setEditingEntryId(null)}
                            onSave={(patch) => void handleUpdateEntry(entry.id, patch)}
                            isSaving={isSaving}
                          />
                        ) : (
                          <>
                            <div className="flex justify-between items-start gap-2">
                              <div>
                                <span className="font-game text-[12px] text-px-primary">{entry.category}</span>
                                <span className="font-game text-[10px] text-px-text-dim ml-2">
                                  {formatStructuredMemoryDateLabel(entry.updatedAt)}
                                  {entry.source ? ` · ${entry.source}` : ''}
                                </span>
                                <p className="text-[13px] text-px-text-sec mt-2 whitespace-pre-wrap">{entry.content}</p>
                                <p className="font-mono text-[10px] text-px-text-dim mt-1">id: {entry.id}</p>
                              </div>
                              <div className="flex flex-col gap-1 shrink-0">
                                <button type="button" className="pixel-btn-outline-muted py-0.5 text-[11px]" onClick={() => setEditingEntryId(entry.id)}>编辑</button>
                                <button type="button" className="pixel-btn-outline-muted py-0.5 text-[11px] text-px-danger border-px-danger" onClick={() => void handleDeleteEntry(entry.id)}>删除</button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function EntryEditor({
  entry,
  onCancel,
  onSave,
  isSaving,
}: {
  entry: StructuredMemoryEntryDTO
  onCancel: () => void
  onSave: (patch: Partial<StructuredMemoryEntryDTO>) => void
  isSaving: boolean
}) {
  const [category, setCategory] = useState(entry.category)
  const [body, setBody] = useState(entry.content)
  const [source, setSource] = useState(entry.source ?? '')
  return (
    <div className="space-y-2">
      <input
        type="text"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        className="w-full px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px]"
      />
      <input
        type="text"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        className="w-full px-2 py-1 bg-px-surface border border-px-border font-mono text-[12px]"
        placeholder="来源"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="w-full min-h-[100px] px-2 py-1 bg-px-surface border border-px-border font-mono text-[13px]"
      />
      <div className="flex gap-2">
        <button type="button" className="pixel-btn-outline-muted py-1 text-[11px]" onClick={onCancel}>取消</button>
        <button
          type="button"
          disabled={isSaving}
          className="pixel-btn-primary py-1 text-[11px]"
          onClick={() => onSave({
            category: category.trim() || 'other',
            content: body,
            source: source.trim() || undefined,
          })}
        >
          保存
        </button>
      </div>
    </div>
  )
}
