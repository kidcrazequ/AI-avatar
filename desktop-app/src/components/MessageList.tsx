import { useEffect, useRef } from 'react'
import MessageBubble from './MessageBubble'
import { ChatMessage } from '../stores/chatStore'

interface Props {
  messages: ChatMessage[]
  isLoading?: boolean
  quickQuestions?: string[]
  onQuickQuestion?: (question: string) => void
  /** 沉淀回答到 wiki/qa/ 的回调 */
  onSaveAnswer?: (question: string, answer: string) => void
}

export default function MessageList({ messages, isLoading, quickQuestions, onQuickQuestion, onSaveAnswer }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  return (
    <div className="h-full overflow-y-auto px-6 py-6 space-y-6 bg-px-bg">
      {messages.map((message, index) => {
        const previousUserMessage = message.role === 'assistant' && index > 0
          ? messages.slice(0, index).reverse().find(m => m.role === 'user')?.content
          : undefined

        return (
          <MessageBubble
            key={index}
            message={message}
            previousUserMessage={previousUserMessage}
            onSaveAnswer={onSaveAnswer}
          />
        )
      })}

      {/* 空对话 — 快捷问题建议 */}
      {messages.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center h-full gap-6">
          <div className="w-10 h-10 border-2 border-px-primary bg-px-primary/10 flex items-center justify-center">
            <span className="text-px-primary font-game text-[14px]">?</span>
          </div>
          <p className="font-game text-[14px] text-px-text-dim">
            选择一个问题开始，或直接输入
          </p>
          {quickQuestions && quickQuestions.length > 0 && onQuickQuestion && (
            <div className="flex flex-col gap-2 w-full max-w-lg">
              {quickQuestions.map((q, i) => (
                <button
                  key={i}
                  onClick={() => onQuickQuestion(q)}
                  className="w-full text-left px-4 py-3 border-2 border-px-border bg-px-surface
                    font-game text-[14px] text-px-text-sec
                    hover:bg-px-primary/10 hover:text-px-text hover:border-px-primary/40
                    transition-none"
                >
                  <span className="text-px-primary font-game text-[12px] mr-2">&gt;</span>
                  {q}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  )
}
