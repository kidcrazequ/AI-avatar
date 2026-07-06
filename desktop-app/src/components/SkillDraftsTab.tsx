/**
 * 技能草稿 tab（工作流技能·入口 2）：评审「对话沉淀」（入口 1）生成的
 * 工作流技能草稿——预览 markdown 原文、编辑 skillId 后晋升为正式技能、删除草稿。
 *
 * 数据源：window.electronAPI.listSkillDrafts / promoteSkillDraft / deleteSkillDraft。
 * promoteSkillDraft 返回 errors 非空 = 校验失败未晋升，逐条展示不吞错。
 */

import { useState, useEffect, useRef, useCallback } from 'react'

/** 草稿元信息（与 listSkillDrafts 返回结构一致） */
interface SkillDraft {
  filename: string
  title: string
  createdAt: number
  content: string
}

interface Props {
  avatarId: string
  /** 晋升成功后回调（父组件刷新技能列表 + 通知上层上下文变更） */
  onPromoted?: () => void
}

/**
 * 从草稿推导默认 skillId：优先 frontmatter 的 name 字段，
 * 其次文件名去掉 .md 扩展名；两者都清洗为 [A-Za-z0-9_-] 合法字符集。
 */
function deriveDefaultSkillId(draft: SkillDraft): string {
  const sanitize = (raw: string): string =>
    raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  // frontmatter 块：文件开头 --- 与下一个 --- 之间
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(draft.content)
  if (fmMatch) {
    const nameMatch = /^name:\s*(.+)$/m.exec(fmMatch[1])
    if (nameMatch) {
      const id = sanitize(nameMatch[1])
      if (id) return id
    }
  }
  return sanitize(draft.filename.replace(/\.md$/i, ''))
}

export default function SkillDraftsTab({ avatarId, onPromoted }: Props) {
  const [drafts, setDrafts] = useState<SkillDraft[]>([])
  const [isLoadingList, setIsLoadingList] = useState(true)
  const [selected, setSelected] = useState<SkillDraft | null>(null)
  /** 晋升用 skillId（默认从 frontmatter/文件名推导，可编辑） */
  const [skillIdInput, setSkillIdInput] = useState('')
  const [isPromoting, setIsPromoting] = useState(false)
  /** promote 返回的校验错误（非空 = 未晋升），逐条展示 */
  const [promoteErrors, setPromoteErrors] = useState<string[]>([])
  /** 删除确认态：等于当前草稿 filename 时显示"确认删除？"（防误删两段式） */
  const [pendingDeleteFilename, setPendingDeleteFilename] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** 当前选中 filename 的同步镜像：loadDrafts 重拉后据此保持选中 */
  const selectedFilenameRef = useRef<string | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; clearTimeout(statusTimerRef.current) }
  }, [])

  const flashStatus = useCallback((msg: string, ms = 2500) => {
    setStatusMsg(msg)
    clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => { if (mountedRef.current) setStatusMsg('') }, ms)
  }, [])

  /** 切换选中草稿：同步重置 skillId 默认值 / 校验错误 / 删除确认态 */
  const applySelection = useCallback((draft: SkillDraft | null) => {
    selectedFilenameRef.current = draft?.filename ?? null
    setSelected(draft)
    setSkillIdInput(draft ? deriveDefaultSkillId(draft) : '')
    setPromoteErrors([])
    setPendingDeleteFilename(null)
  }, [])

  const loadDrafts = useCallback(async (preserveSelection = true) => {
    setIsLoadingList(true)
    try {
      const list = await window.electronAPI.listSkillDrafts(avatarId)
      if (!mountedRef.current) return
      // 新草稿在前
      const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt)
      setDrafts(sorted)
      const keep = preserveSelection
        ? sorted.find(d => d.filename === selectedFilenameRef.current)
        : undefined
      applySelection(keep ?? sorted[0] ?? null)
    } catch (err) {
      if (mountedRef.current) {
        console.error('[SkillDraftsTab] 加载草稿失败:', err instanceof Error ? err.message : String(err))
        flashStatus('加载草稿失败', 3000)
      }
    } finally {
      if (mountedRef.current) setIsLoadingList(false)
    }
  }, [avatarId, applySelection, flashStatus])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadDrafts 是 async + setState 在 await 后跑，规则误判（同 SkillsPanel.loadSkills）
    void loadDrafts(false)
  }, [loadDrafts])

  /** 晋升为正式技能：errors 非空 = 校验失败未晋升，逐条展示 */
  const handlePromote = async () => {
    if (!selected || isPromoting) return
    const id = skillIdInput.trim()
    if (id && !/^[A-Za-z0-9_-]+$/.test(id)) {
      setPromoteErrors(['技能 ID 仅支持字母、数字、下划线、连字符'])
      return
    }
    setIsPromoting(true)
    setPromoteErrors([])
    try {
      const result = await window.electronAPI.promoteSkillDraft({
        avatarId,
        filename: selected.filename,
        ...(id ? { skillId: id } : {}),
      })
      if (!mountedRef.current) return
      if (result.errors.length > 0) {
        // 校验失败未晋升：错误逐条留在面板上，不吞
        setPromoteErrors(result.errors)
        return
      }
      // indexUpdated=false 也要说出来（fail loud）：技能文件已落盘但索引没更新
      flashStatus(result.indexUpdated ? '已晋升为技能 ✓' : '已晋升，但 skill-index 未自动更新，请手动检查', 4000)
      await loadDrafts(false)
      onPromoted?.()
    } catch (err) {
      if (!mountedRef.current) return
      setPromoteErrors([`晋升失败：${err instanceof Error ? err.message : String(err)}`])
    } finally {
      if (mountedRef.current) setIsPromoting(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (!selected || isDeleting) return
    setIsDeleting(true)
    try {
      await window.electronAPI.deleteSkillDraft({ avatarId, filename: selected.filename })
      if (!mountedRef.current) return
      setPendingDeleteFilename(null)
      flashStatus('草稿已删除')
      await loadDrafts(false)
    } catch (err) {
      if (!mountedRef.current) return
      console.error('[SkillDraftsTab] 删除草稿失败:', err instanceof Error ? err.message : String(err))
      flashStatus(`删除失败：${err instanceof Error ? err.message : String(err)}`, 4000)
    } finally {
      if (mountedRef.current) setIsDeleting(false)
    }
  }

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* 左侧列表：标题 + 生成时间 */}
      <div className="w-1/3 border-r-2 border-px-border flex flex-col">
        <div className="px-4 py-3 border-b-2 border-px-border bg-px-elevated flex items-center justify-between gap-2">
          <h3 className="font-game text-[13px] text-px-text tracking-wider">技能草稿</h3>
          <span className="font-game text-[11px] text-px-text-dim">{drafts.length} 份</span>
        </div>
        <div className="flex-1 overflow-y-auto bg-px-bg">
          {isLoadingList ? (
            <div className="flex items-center justify-center h-full py-12">
              <p className="font-game text-[13px] text-px-text-dim tracking-wider">加载中...</p>
            </div>
          ) : drafts.length === 0 ? (
            <div className="flex items-center justify-center h-full py-12 px-4">
              <p className="font-game text-[12px] text-px-text-dim tracking-wider leading-relaxed text-center">
                暂无草稿<br />在对话窗口点「◆ 沉淀技能」生成
              </p>
            </div>
          ) : drafts.map((draft) => (
            <button
              key={draft.filename}
              onClick={() => applySelection(draft)}
              className={`w-full text-left px-4 py-3 border-b border-px-border-dim transition-none
                ${selected?.filename === draft.filename
                  ? 'bg-px-surface text-px-text border-l-3 border-l-px-primary'
                  : 'bg-transparent text-px-text-sec hover:bg-px-surface/50 border-l-3 border-l-transparent'
                }`}
            >
              <div className="font-game text-[14px] font-medium truncate">{draft.title || draft.filename}</div>
              <div className="font-mono text-[10px] text-px-text-dim mt-0.5">
                {new Date(draft.createdAt).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 右侧详情：预览 + 晋升 / 删除 */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {selected ? (
          <>
            <div className="px-6 py-4 border-b-2 border-px-border bg-px-elevated flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-game text-[16px] font-bold text-px-text truncate">{selected.title || selected.filename}</h3>
                <div className="flex items-center gap-3 mt-1">
                  <span className="font-mono text-[11px] text-px-text-dim truncate">{selected.filename}</span>
                  <span className="font-game text-[11px] text-px-text-dim flex-shrink-0">
                    {new Date(selected.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {statusMsg && (
                  <span className={`font-game text-[12px] tracking-wider ${statusMsg.includes('失败') || statusMsg.includes('未自动更新') ? 'text-px-danger' : 'text-px-success'}`}>
                    {statusMsg}
                  </span>
                )}
                {pendingDeleteFilename === selected.filename ? (
                  <div className="flex gap-2 items-center">
                    <span className="font-game text-[11px] text-px-danger tracking-wider">确认删除？</span>
                    <button onClick={() => setPendingDeleteFilename(null)} className="pixel-btn-outline-muted">CANCEL</button>
                    <button
                      onClick={() => void handleConfirmDelete()}
                      disabled={isDeleting}
                      className="pixel-btn-outline-light text-px-danger border-px-danger"
                    >
                      {isDeleting ? '...' : 'DELETE'}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setPendingDeleteFilename(selected.filename)}
                    disabled={isPromoting}
                    className="pixel-btn-outline-muted text-px-danger"
                  >
                    删除
                  </button>
                )}
              </div>
            </div>

            {/* 晋升行：可编辑 skillId + 晋升按钮 */}
            <div className="px-6 py-3 border-b-2 border-px-border bg-px-surface flex items-center gap-2">
              <label className="font-game text-[11px] text-px-text-dim tracking-wider flex-shrink-0">
                技能 ID
              </label>
              <input
                type="text"
                value={skillIdInput}
                onChange={(e) => setSkillIdInput(e.target.value)}
                placeholder="留空由后端按建议 ID 处理（仅支持 a-z 0-9 _ -）"
                disabled={isPromoting}
                className="pixel-input flex-1 text-[13px] font-mono disabled:opacity-40"
                aria-label="晋升后的技能 ID"
              />
              <button
                onClick={() => void handlePromote()}
                disabled={isPromoting}
                className="pixel-btn-primary text-[12px] px-4 py-1.5"
              >
                {isPromoting ? '晋升中...' : '晋升为技能'}
              </button>
            </div>

            {/* 校验错误：逐条展示，不吞 */}
            {promoteErrors.length > 0 && (
              <div className="px-6 py-3 border-b-2 border-px-danger bg-px-danger/10">
                <div className="font-game text-[12px] text-px-danger tracking-wider mb-1">
                  校验未通过，草稿未晋升：
                </div>
                <ul className="space-y-0.5">
                  {promoteErrors.map((err, i) => (
                    <li key={i} className="font-body text-[12px] text-px-danger">
                      • {err}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 草稿 markdown 原文预览 */}
            <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
              <pre className="whitespace-pre-wrap break-words font-mono text-[13px] text-px-text-sec leading-relaxed">
                {selected.content}
              </pre>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full bg-px-surface">
            <div className="text-center">
              <div className="w-12 h-12 border-2 border-px-primary bg-px-primary/10 flex items-center justify-center mx-auto mb-3">
                <span className="text-px-primary font-game text-[12px]">D</span>
              </div>
              <p className="font-game text-[12px] text-px-text-dim tracking-wider">选择一份草稿</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
