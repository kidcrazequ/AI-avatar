import type React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

interface Props {
  content: string
}

export default function KnowledgeViewer({ content }: Props) {
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
                  style={oneDark as Record<string, React.CSSProperties>}
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
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
