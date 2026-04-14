import { useMemo, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

interface Props {
  content: string
}

/**
 * 解析 YAML frontmatter（仅支持 key: value 和简单数组，不引 yaml 依赖）。
 * 返回 { meta, body }；无 frontmatter 时 meta 为空对象。
 */
function parseFrontmatter(src: string): { meta: Record<string, unknown>; body: string } {
  if (!src.startsWith('---\n') && !src.startsWith('---\r\n')) {
    return { meta: {}, body: src }
  }
  const endMatch = src.match(/\n---\r?\n/)
  if (!endMatch || endMatch.index === undefined) {
    return { meta: {}, body: src }
  }
  const fmText = src.slice(4, endMatch.index)
  const body = src.slice(endMatch.index + endMatch[0].length)
  const meta: Record<string, unknown> = {}
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const raw = m[2].trim()
    if (raw === 'true') meta[key] = true
    else if (raw === 'false') meta[key] = false
    else if (raw.startsWith('[') && raw.endsWith(']')) {
      meta[key] = raw.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      meta[key] = raw.replace(/^["']|["']$/g, '')
    }
  }
  return { meta, body }
}

/** 大文件阈值：超过此字符数的 markdown 不直接渲染（react-markdown 处理巨型表格会卡死渲染器） */
const LARGE_FILE_THRESHOLD = 50_000

export default function KnowledgeViewer({ content }: Props) {
  const { meta, body } = useMemo(() => parseFrontmatter(content), [content])

  // 自动生成的 rag_only 数据源 → 显示摘要而非全量内容
  const source = typeof meta.source === 'string' ? meta.source : null
  if (source === 'excel' || source === 'pptx' || meta.rag_only === true) {
    const sheets = Array.isArray(meta.sheets) ? (meta.sheets as string[]) : []
    const excelJson = typeof meta.excel_json === 'string' ? meta.excel_json : null
    const lineCount = body.split('\n').length

    const sourceConfig: Record<string, { label: string; desc: ReactNode; reimport: string }> = {
      excel: {
        label: '📊 EXCEL 数据源',
        desc: (
          <>这是从 Excel / CSV 自动生成的知识文件。<strong className="text-px-text">整张表格不在 system prompt 中</strong>，
          通过 <code className="text-px-accent">query_excel</code> 工具按条件精确查询。</>
        ),
        reimport: '编辑源 .xlsx 后重新导入',
      },
      pptx: {
        label: '📽️ POWERPOINT 数据源',
        desc: (
          <>这是从 PowerPoint 自动生成的知识文件。<strong className="text-px-text">全文不在 system prompt 中</strong>，
          通过 <code className="text-px-accent">search_knowledge</code> 工具按语义检索相关幻灯片。</>
        ),
        reimport: '编辑源 .pptx 后重新导入',
      },
    }
    const cfg = sourceConfig[source ?? ''] ?? {
      label: '📄 大文件数据源',
      desc: (
        <>这是自动生成的大文件知识。<strong className="text-px-text">全文不在 system prompt 中</strong>，
        通过 <code className="text-px-accent">search_knowledge</code> 工具按语义检索。</>
      ),
      reimport: '编辑源文件后重新导入',
    }

    return (
      <div className="h-full overflow-y-auto p-6 bg-px-surface">
        <div className="border-2 border-px-primary bg-px-bg p-4 mb-4">
          <div className="font-game text-[12px] text-px-primary tracking-wider mb-2">
            {cfg.label}
          </div>
          <p className="text-[13px] text-px-text font-body leading-[1.7] mb-3">
            {cfg.desc}
          </p>
          {sheets.length > 0 && (
            <div className="text-[12px] text-px-text-sec font-body mb-2">
              <span className="text-px-text-dim">Sheets：</span>
              {sheets.map((s, i) => (
                <span key={i} className="ml-2 px-2 py-0.5 border border-px-border bg-px-elevated text-px-accent font-mono text-[11px]">
                  {s}
                </span>
              ))}
            </div>
          )}
          {excelJson && (
            <div className="text-[11px] text-px-text-dim font-mono mt-2">
              结构化数据：<code>{excelJson}</code>
            </div>
          )}
          <div className="mt-3 text-[11px] text-px-text-dim font-body leading-[1.6]">
            如需修改内容，请<strong className="text-px-text">{cfg.reimport}</strong>。
            直接编辑此 .md 文件不会反映到源文件。
          </div>
        </div>
        <details className="border border-px-border bg-px-bg p-3">
          <summary className="font-game text-[11px] text-px-text-dim tracking-wider cursor-pointer hover:text-px-primary">
            查看原始 markdown 头部（前 200 行 / 共 {lineCount} 行）
          </summary>
          <pre className="mt-3 text-[11px] text-px-text-sec font-mono whitespace-pre overflow-x-auto max-h-[60vh]">
            {body.split('\n').slice(0, 200).join('\n')}
            {lineCount > 200 ? `\n\n... 还有 ${lineCount - 200} 行未显示 ...\n` : ''}
          </pre>
        </details>
      </div>
    )
  }

  // 超大普通文件 → 显示截断警告 + 前 N 字符纯文本预览
  if (body.length > LARGE_FILE_THRESHOLD) {
    return (
      <div className="h-full overflow-y-auto p-6 bg-px-surface">
        <div className="border-2 border-px-warning bg-px-bg p-4 mb-4">
          <div className="font-game text-[12px] text-px-warning tracking-wider mb-2">
            ⚠ 超大文件
          </div>
          <p className="text-[13px] text-px-text font-body leading-[1.7]">
            该文件 {body.length.toLocaleString()} 字符，为避免渲染卡顿，
            仅显示前 50,000 字符的纯文本预览（不渲染 markdown）。完整内容请查看源文件或使用 search_knowledge 检索。
          </p>
        </div>
        <pre className="text-[11px] text-px-text-sec font-mono whitespace-pre-wrap">
          {body.slice(0, LARGE_FILE_THRESHOLD)}
          {'\n\n... 已截断 ...'}
        </pre>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6 bg-px-surface">
      <div className="prose prose-sm prose-invert max-w-none prose-pixel font-body
        prose-headings:font-game prose-headings:font-bold prose-headings:text-px-text prose-headings:tracking-wider
        prose-p:text-px-text-sec prose-p:leading-[1.75] prose-p:text-[14px] prose-p:font-body
        prose-code:text-px-accent prose-code:bg-px-bg prose-code:px-1.5 prose-code:py-0.5 prose-code:border prose-code:border-px-border prose-code:text-[13px] prose-code:font-mono
        prose-pre:bg-px-bg prose-pre:border-2 prose-pre:border-px-border prose-pre:font-mono
        prose-table:border-2 prose-table:border-px-border
        prose-th:border-2 prose-th:border-px-border prose-th:bg-px-elevated prose-th:text-px-text prose-th:px-3 prose-th:py-2 prose-th:font-game
        prose-td:border-2 prose-td:border-px-border prose-td:px-3 prose-td:py-2 prose-td:text-px-text-sec prose-td:font-body
        prose-strong:text-px-text prose-strong:font-bold
        prose-a:text-px-primary prose-a:no-underline hover:prose-a:underline
        prose-li:text-px-text-sec prose-li:marker:text-px-primary prose-li:font-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code(props) {
              const { children, className, ...rest } = props
              const match = /language-(\w+)/.exec(className || '')
              return match ? (
                <SyntaxHighlighter
                  style={oneDark as Record<string, CSSProperties>}
                  language={match[1]}
                  PreTag="div"
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              ) : (
                <code className={className} {...rest}>
                  {children}
                </code>
              )
            },
          }}
        >
          {body}
        </ReactMarkdown>
      </div>
    </div>
  )
}
