import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatMessage } from '../stores/chatStore'

interface Props {
  message: ChatMessage
  /** 上一条用户消息内容（用于 SAVE 时作为 question） */
  previousUserMessage?: string
  /** 沉淀回答到 wiki/qa/ 的回调 */
  onSaveAnswer?: (question: string, answer: string) => void
}

export default function MessageBubble({ message, previousUserMessage, onSaveAnswer }: Props) {
  const isUser = message.role === 'user'
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    if (!onSaveAnswer || !previousUserMessage || saved) return
    onSaveAnswer(previousUserMessage, message.content)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-fade-in`}>
      <div className={`max-w-[75%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        {/* 角色标签 */}
        <div className={`font-game text-[12px] tracking-widest mb-1.5
          ${isUser ? 'text-right text-px-primary' : 'text-left text-px-accent'}`}>
          {isUser ? '你' : '专家'}
        </div>

        {/* 消息体 */}
        <div
          className={`relative group px-5 py-4 border-2 font-body text-[14px] leading-relaxed
            ${isUser
              ? 'bg-px-primary/10 text-px-text border-px-primary/30 shadow-pixel-brand'
              : 'bg-px-surface text-px-text border-px-border shadow-pixel-white'
            }`}
        >
          {/* 助手消息的 SAVE 按钮（hover 时显示） */}
          {!isUser && onSaveAnswer && previousUserMessage && (
            <button
              onClick={handleSave}
              disabled={saved}
              className="absolute top-2 right-2 opacity-0 group-hover:opacity-100
                font-game text-[10px] tracking-wider px-2 py-0.5
                border border-px-border bg-px-elevated text-px-text-dim
                hover:text-px-primary hover:border-px-primary
                disabled:text-px-success disabled:border-px-success
                transition-opacity"
              title="沉淀到知识百科"
            >
              {saved ? 'SAVED' : 'SAVE'}
            </button>
          )}

          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="prose prose-sm prose-invert max-w-none prose-pixel
              prose-headings:font-game prose-headings:font-bold prose-headings:tracking-wider prose-headings:text-px-text
              prose-p:text-px-text prose-p:leading-[1.75] prose-p:text-[14px] prose-p:font-body
              prose-code:text-px-accent prose-code:bg-px-bg prose-code:px-1.5 prose-code:py-0.5 prose-code:border prose-code:border-px-border prose-code:text-[13px] prose-code:font-mono
              prose-pre:bg-px-bg prose-pre:text-px-text prose-pre:border-2 prose-pre:border-px-border prose-pre:font-mono
              prose-table:border-2 prose-table:border-px-border
              prose-th:border-2 prose-th:border-px-border prose-th:bg-px-elevated prose-th:text-px-text prose-th:px-3 prose-th:py-2 prose-th:font-game
              prose-td:border-2 prose-td:border-px-border prose-td:px-3 prose-td:py-2 prose-td:text-px-text-sec prose-td:font-body
              prose-strong:font-bold prose-strong:text-px-text
              prose-a:text-px-primary prose-a:no-underline hover:prose-a:underline
              prose-li:text-px-text-sec prose-li:marker:text-px-primary prose-li:font-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
