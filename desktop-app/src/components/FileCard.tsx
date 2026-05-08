/**
 * FileCard：对话气泡内嵌的工具落盘文件卡片。
 *
 * 决策 B3：把 generate_document（PDF/DOCX/MD）和 export_excel 都接到统一的
 * UI 上——assistant 消息内显示一行文件卡片，点击直接用系统默认应用打开。
 *
 * 设计：
 *   - 主按钮 [打开]：调 window.electronAPI.openDocument(absolutePath)，
 *     失败时 toast + logEvent；成功时按钮短暂高亮反馈
 *   - 次按钮 [显示在文件夹]：调 showDocumentInFolder
 *   - 引用来源（cite 块抽出）：默认折叠，点击展开
 *   - 像素游戏风格与 AskQuestionCard 对齐（pixel-* / font-game / px-* 配色）
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import { useState, type ReactElement } from 'react'
import type { DocumentAttachment } from '../services/chat-types'

interface Props {
  attachment: DocumentAttachment
}

const FORMAT_ICON: Record<DocumentAttachment['format'], string> = {
  md: '[MD]',
  pdf: '[PDF]',
  docx: '[DOC]',
  xlsx: '[XLS]',
}

const FORMAT_LABEL: Record<DocumentAttachment['format'], string> = {
  md: 'Markdown 文档',
  pdf: 'PDF 报告',
  docx: 'Word 文档',
  xlsx: 'Excel 表格',
}

/** 把字节数格式化为 KB / MB（保留 1 位小数；< 1KB 显示字节）。 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export default function FileCard({ attachment }: Props): ReactElement {
  const [opening, setOpening] = useState(false)
  const [openOk, setOpenOk] = useState(false)
  const [openErr, setOpenErr] = useState<string | null>(null)
  const [sourcesExpanded, setSourcesExpanded] = useState(false)

  const handleOpen = async (): Promise<void> => {
    if (opening) return
    setOpening(true)
    setOpenErr(null)
    setOpenOk(false)
    try {
      const errMsg = await window.electronAPI.openDocument(attachment.absolutePath)
      if (errMsg && errMsg.length > 0) {
        setOpenErr(errMsg)
        window.electronAPI.logEvent('warn', 'file-card-open-failed', `${attachment.filename}: ${errMsg}`)
      } else {
        setOpenOk(true)
        window.electronAPI.logEvent('info', 'file-card-open-ok', attachment.filename)
        // 1.5 秒后清掉成功提示，避免 UI 一直高亮
        setTimeout(() => setOpenOk(false), 1500)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setOpenErr(msg)
      window.electronAPI.logEvent('error', 'file-card-open-error', `${attachment.filename}: ${msg}`)
    } finally {
      setOpening(false)
    }
  }

  const handleShowInFolder = async (): Promise<void> => {
    try {
      const result = await window.electronAPI.showDocumentInFolder(attachment.absolutePath)
      if (!result.ok) {
        setOpenErr(result.error ?? '无法在文件夹中显示')
        window.electronAPI.logEvent('warn', 'file-card-reveal-failed', `${attachment.filename}: ${result.error ?? ''}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setOpenErr(msg)
      window.electronAPI.logEvent('error', 'file-card-reveal-error', `${attachment.filename}: ${msg}`)
    }
  }

  const sources = attachment.sources ?? []
  const sourcesCount = sources.length

  return (
    <div className="not-prose mt-3 border-2 border-px-border bg-px-elevated">
      {/* 主行：图标 + 文件名 + 大小 + 操作 */}
      <div className="flex items-center gap-3 px-3 py-2">
        <span
          className="font-game text-[12px] tracking-wider text-px-accent"
          aria-label={FORMAT_LABEL[attachment.format]}
        >
          {FORMAT_ICON[attachment.format]}
        </span>
        <div className="flex-1 min-w-0">
          <div
            className="font-body text-[13px] text-px-text truncate"
            title={attachment.filePath}
          >
            {attachment.filename}
          </div>
          <div className="font-game text-[10px] tracking-wider text-px-text-dim">
            {FORMAT_LABEL[attachment.format]} · {formatBytes(attachment.sizeBytes)}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={handleOpen}
            disabled={opening}
            className={`font-game text-[11px] tracking-wider px-3 py-1 border-2 transition-none
              ${openOk
                ? 'border-px-success text-px-success bg-px-success/10'
                : 'border-px-primary text-px-primary bg-px-surface hover:bg-px-primary/10'}
              disabled:opacity-50 disabled:cursor-not-allowed`}
            aria-label={`打开 ${attachment.filename}`}
          >
            {opening ? 'OPENING…' : openOk ? 'OPENED' : '打开'}
          </button>
          <button
            type="button"
            onClick={handleShowInFolder}
            className="font-game text-[11px] tracking-wider px-3 py-1 border-2 border-px-border
              text-px-text-dim bg-px-surface hover:text-px-primary hover:border-px-primary
              transition-none"
            aria-label={`在文件夹中显示 ${attachment.filename}`}
            title="打开所在目录"
          >
            目录
          </button>
        </div>
      </div>

      {/* 错误反馈（操作失败时） */}
      {openErr && (
        <div className="px-3 py-1.5 border-t border-px-border-dim font-game text-[10px] text-px-danger">
          失败：{openErr}
        </div>
      )}

      {/* 引用来源（cite 块抽出）— 折叠展示 */}
      {sourcesCount > 0 && (
        <div className="border-t border-px-border-dim">
          <button
            type="button"
            onClick={() => setSourcesExpanded(v => !v)}
            className="w-full text-left px-3 py-1.5 font-game text-[10px] tracking-wider
              text-px-text-dim hover:text-px-primary"
          >
            {sourcesExpanded ? '[▼]' : '[▶]'} 引用来源（{sourcesCount}）
          </button>
          {sourcesExpanded && (
            <ul className="px-3 pb-2 space-y-0.5">
              {sources.map((s, i) => (
                <li
                  key={`src-${i}`}
                  className="font-mono text-[11px] text-px-text-sec break-all"
                >
                  {s.source}
                  {s.page !== undefined && (
                    <span className="text-px-text-dim"> · 第 {s.page} 页</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
