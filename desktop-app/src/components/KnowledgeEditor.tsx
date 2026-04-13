import Editor, { Monaco } from '@monaco-editor/react'
import { useRef, useEffect, useMemo } from 'react'

interface Props {
  content: string
  onChange: (value: string | undefined) => void
  onSave: () => void
}

/** 大文件阈值：超过此字符数 Monaco 性能堪忧，禁止编辑 */
const EDITOR_MAX_CHARS = 100_000

/** 检测是否是 Excel 自动生成的 .md（顶部有 source: excel frontmatter） */
function detectExcelSource(content: string): boolean {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return false
  const endMatch = content.match(/\n---\r?\n/)
  if (!endMatch || endMatch.index === undefined) return false
  const fmText = content.slice(4, endMatch.index)
  return /^\s*source\s*:\s*excel\s*$/m.test(fmText)
}

export default function KnowledgeEditor({ content, onChange, onSave }: Props) {
  const onSaveRef = useRef(onSave)
  useEffect(() => { onSaveRef.current = onSave }, [onSave])

  const isExcel = useMemo(() => detectExcelSource(content), [content])
  const isTooLarge = content.length > EDITOR_MAX_CHARS

  // Excel 自动生成的文件 → 只读提示，禁止编辑
  if (isExcel) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 bg-px-elevated border-b-2 border-px-border">
          <span className="font-game text-[12px] text-px-warning tracking-wider">⚠ 只读 · Excel 自动生成</span>
        </div>
        <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
          <div className="border-2 border-px-warning bg-px-bg p-4 max-w-2xl">
            <div className="font-game text-[13px] text-px-warning tracking-wider mb-3">
              ⚠ 此文件不可编辑
            </div>
            <p className="text-[13px] text-px-text font-body leading-[1.7] mb-3">
              这是从 Excel / CSV 自动导入生成的知识文件，<strong className="text-px-text">手动编辑不会反映到结构化数据</strong>
              （<code className="text-px-accent">_excel/*.json</code>），还会被下次重新导入覆盖。
            </p>
            <p className="text-[13px] text-px-text font-body leading-[1.7]">
              <strong className="text-px-text">如需修改</strong>：编辑源 .xlsx 文件，回到知识库面板用 IMPORT 重新导入即可。
            </p>
          </div>
        </div>
      </div>
    )
  }

  // 超大文件 → Monaco 性能差，禁止编辑
  if (isTooLarge) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 bg-px-elevated border-b-2 border-px-border">
          <span className="font-game text-[12px] text-px-warning tracking-wider">⚠ 只读 · 文件过大</span>
        </div>
        <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
          <div className="border-2 border-px-warning bg-px-bg p-4 max-w-2xl">
            <div className="font-game text-[13px] text-px-warning tracking-wider mb-3">
              ⚠ 文件超过 {(EDITOR_MAX_CHARS / 1000).toFixed(0)}k 字符
            </div>
            <p className="text-[13px] text-px-text font-body leading-[1.7]">
              当前文件 <strong>{content.length.toLocaleString()}</strong> 字符，
              在 Monaco 编辑器中加载会卡顿，已禁用在线编辑。请在外部编辑器（VS Code 等）打开源文件修改。
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 bg-px-elevated border-b-2 border-px-border">
        <span className="font-game text-[12px] text-px-text-sec tracking-wider">编辑模式</span>
        <button
          onClick={onSave}
          className="pixel-btn-primary py-1"
        >
          保存
        </button>
      </div>
      <div className="flex-1">
        <Editor
          height="100%"
          defaultLanguage="markdown"
          value={content}
          onChange={onChange}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            fontFamily: '"JetBrains Mono", "Courier New", monospace',
            wordWrap: 'on',
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            renderLineHighlight: 'all',
            lineHeight: 24,
          }}
          onMount={(editor, monaco: Monaco) => {
            editor.addCommand(
              monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
              () => onSaveRef.current()
            )
          }}
        />
      </div>
    </div>
  )
}
