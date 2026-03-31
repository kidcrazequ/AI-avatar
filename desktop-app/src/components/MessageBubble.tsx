import ReactMarkdown from 'react-markdown'
import { ChatMessage } from '../stores/chatStore'

interface Props {
  message: ChatMessage
}

export default function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        {/* 角色标签 */}
        <div className={`font-pixel text-[9px] tracking-wider mb-2
          ${isUser ? 'text-right text-px-subtle' : 'text-left text-px-muted'}`}>
          {isUser ? 'YOU' : 'EXPERT'}
        </div>

        {/* 消息体 */}
        <div
          className={`px-5 py-4 border-2 font-mono text-sm leading-relaxed
            ${isUser
              ? 'bg-px-white text-px-black border-px-white shadow-pixel-white'
              : 'bg-px-dark text-px-white border-px-line shadow-[3px_3px_0_0_rgba(250,250,250,0.1)]'
            }`}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="prose prose-sm max-w-none
              prose-headings:font-pixel prose-headings:text-[10px] prose-headings:tracking-wider prose-headings:text-px-white
              prose-p:font-mono prose-p:text-px-white prose-p:leading-relaxed
              prose-code:bg-px-mid prose-code:px-1 prose-code:border prose-code:border-px-line prose-code:font-mono prose-code:text-[12px] prose-code:text-px-warm
              prose-pre:bg-px-black prose-pre:text-px-white prose-pre:border-2 prose-pre:border-px-line prose-pre:font-mono
              prose-table:border-2 prose-table:border-px-line
              prose-th:border-2 prose-th:border-px-line prose-th:bg-px-mid prose-th:text-px-white prose-th:px-3 prose-th:py-2
              prose-td:border-2 prose-td:border-px-line prose-td:px-3 prose-td:py-2 prose-td:text-px-warm
              prose-strong:font-semibold prose-strong:text-px-white
              prose-ul:list-none prose-ul:pl-0
              prose-li:text-px-warm prose-li:before:content-['-_'] prose-li:before:text-px-muted">
              <ReactMarkdown>
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
