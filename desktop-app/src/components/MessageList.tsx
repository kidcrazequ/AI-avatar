import { useEffect, useRef } from 'react'
import MessageBubble from './MessageBubble'
import { ChatMessage } from '../stores/chatStore'

interface Props {
  messages: ChatMessage[]
  isLoading?: boolean
  /** GAP8: 快捷问题列表，在空对话时展示 */
  quickQuestions?: string[]
  /** GAP8: 点击快捷问题时的回调 */
  onQuickQuestion?: (question: string) => void
}

export default function MessageList({ messages, isLoading, quickQuestions, onQuickQuestion }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  return (
    <div className="h-full overflow-y-auto px-6 py-6 space-y-6 bg-px-black">
      {messages.map((message, index) => (
        <MessageBubble key={index} message={message} />
      ))}

      {/* GAP8: 空对话 — 快捷问题建议 */}
      {messages.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center h-full gap-6">
          <p className="font-pixel text-[9px] text-px-muted tracking-wider">
            {'// awaiting input...'}
          </p>
          {quickQuestions && quickQuestions.length > 0 && onQuickQuestion && (
            <div className="flex flex-col gap-2 w-full max-w-md">
              <p className="font-pixel text-[8px] text-px-muted tracking-widest text-center mb-1">
                QUICK START
              </p>
              {quickQuestions.map((q, i) => (
                <button
                  key={i}
                  onClick={() => onQuickQuestion(q)}
                  className="w-full text-left px-4 py-3 border-2 border-px-line bg-px-dark
                    font-mono text-sm text-px-white hover:bg-px-white hover:text-px-black
                    hover:border-px-white transition-none"
                >
                  <span className="font-pixel text-[8px] text-px-muted mr-2">&gt;</span>
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
