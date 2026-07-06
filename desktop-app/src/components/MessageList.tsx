import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Virtuoso, type StateSnapshot, type VirtuosoHandle } from 'react-virtuoso'
import MessageBubble from './MessageBubble'
import { ChatMessage } from '../stores/chatStore'

const conversationScrollSnapshots = new Map<string, StateSnapshot>()
const MAX_CONVERSATION_SCROLL_SNAPSHOTS = 100

interface Props {
  conversationId: string
  messages: ChatMessage[]
  isLoading?: boolean
  /** 本轮 sendMessage 的累计耗时（秒）。仅对"最后一条且 isLoading"的 assistant 有意义；
   *  v19 后由 MessageList 透传给 MessageBubble，让"思考中..."占位在每条消息底下渲染。 */
  elapsedSec?: number
  quickQuestions?: string[]
  onQuickQuestion?: (question: string) => void
  /** 沉淀回答到 wiki/qa/ 的回调 */
  onSaveAnswer?: (question: string, answer: string) => void
  /** 分身头像（用于 AI 消息气泡展示） */
  avatarImage?: string
  /** 分身名称（用于 AI 消息气泡展示） */
  avatarName?: string
  /** 分身角色标签（短文本，展示在 avatarName 旁边的 chip 里） */
  avatarRole?: string
  /** 当前对话所属分身 ID，透传给 MessageBubble 用于 [来源:] chip 解析原始文件 */
  avatarId: string
}

export default function MessageList({ conversationId, messages, isLoading, elapsedSec, quickQuestions, onQuickQuestion, onSaveAnswer, avatarImage, avatarName, avatarRole, avatarId }: Props) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const previousMessageIdsRef = useRef<string[]>([])

  const restoreStateFrom = useMemo(() => {
    return conversationScrollSnapshots.get(conversationId)
  }, [conversationId])

  const rememberScrollState = useCallback(() => {
    if (messages.length === 0) return
    virtuosoRef.current?.getState((state) => {
      conversationScrollSnapshots.set(conversationId, state)
      if (conversationScrollSnapshots.size > MAX_CONVERSATION_SCROLL_SNAPSHOTS) {
        const oldestKey = conversationScrollSnapshots.keys().next().value
        if (oldestKey) conversationScrollSnapshots.delete(oldestKey)
      }
    })
  }, [conversationId, messages.length])

  const shouldFollowOutput = useCallback((isAtBottom: boolean) => {
    const previousIds = previousMessageIdsRef.current
    const appendedToCurrentList = previousIds.length > 0 &&
      previousIds.length < messages.length &&
      previousIds.every((id, index) => messages[index]?.id === id)
    return isAtBottom && appendedToCurrentList ? 'smooth' : false
  }, [messages])

  useEffect(() => {
    previousMessageIdsRef.current = messages.map((message) => message.id)
  }, [messages])

  useEffect(() => {
    return () => rememberScrollState()
  }, [rememberScrollState])

  /**
   * 预计算 previousUserMessage Map（单次线性扫描），避免在 itemContent 内 O(n) 查找。
   * 仅在 messages 引用变更时重建。
   *
   * 原实现用两个 useRef + 在渲染中比对更新，触发 react-hooks/refs 规则；
   * 改用 useMemo 语义等价且更符合 React 心智模型。
   */
  const prevUserMap = useMemo<Map<string, string>>(() => {
    let lastUserContent = ''
    const map = new Map<string, string>()
    for (const msg of messages) {
      if (msg.role === 'assistant' && lastUserContent) {
        map.set(msg.id, lastUserContent)
      }
      if (msg.role === 'user') {
        lastUserContent = msg.content
      }
    }
    return map
  }, [messages])

  // 最后一条 user 消息的下标：重新生成只对「最后一轮」开放（其后无 user 消息的 assistant），
  // 否则 sendMessage 重建会把新答案追加到末尾、破坏历史时间线（见 regenerateAssistantMessage）。
  const lastUserIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return i
    }
    return -1
  }, [messages])

  const itemContent = useCallback((index: number) => {
    const message = messages[index]
    // 判定本条是不是"还在直播"：最后一条 assistant + 全局 isLoading
    // 用于让 MessageBubble 在自己的工具调用时间线末尾追加"思考中... · Xs"占位行。
    const isLive = isLoading === true && index === messages.length - 1 && message.role === 'assistant'
    const canRegenerate = message.role === 'assistant' && index > lastUserIdx
    return (
      <div className="px-6 py-3">
        <MessageBubble
          message={message}
          previousUserMessage={prevUserMap.get(message.id)}
          onSaveAnswer={onSaveAnswer}
          avatarImage={avatarImage}
          avatarName={avatarName}
          avatarRole={avatarRole}
          avatarId={avatarId}
          isLive={isLive}
          canRegenerate={canRegenerate}
          elapsedSec={isLive ? elapsedSec : undefined}
        />
      </div>
    )
  }, [messages, prevUserMap, onSaveAnswer, avatarImage, avatarName, avatarRole, avatarId, isLoading, elapsedSec, lastUserIdx])

  /** 空对话且正在 loading：首条消息生成中，显示加载占位 */
  if (messages.length === 0 && isLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-px-bg">
        <div className="flex items-center gap-3 text-px-text-dim">
          <div className="w-4 h-4 border-2 border-px-primary border-t-transparent rounded-full animate-spin" />
          <span className="font-game text-[13px] tracking-wider">思考中...</span>
        </div>
      </div>
    )
  }

  /** 空对话：快捷问题建议 */
  if (messages.length === 0 && !isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-6 px-6 bg-px-bg">
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
    )
  }

  return (
    <Virtuoso
      ref={virtuosoRef}
      className="h-full bg-px-bg"
      data={messages}
      itemContent={itemContent}
      computeItemKey={(_, message) => message.id}
      restoreStateFrom={restoreStateFrom}
      isScrolling={(scrolling) => {
        if (!scrolling) rememberScrollState()
      }}
      rangeChanged={rememberScrollState}
      // 仅同一消息链尾部追加时自动滚底；打开/切换历史会话的 DB 回填不触发滚动。
      followOutput={shouldFollowOutput}
      // 底部额外留白，避免最后一条消息紧贴边缘
      style={{ height: '100%' }}
    />
  )
}
