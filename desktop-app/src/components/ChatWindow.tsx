import { useState, useEffect, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore, nextMessageId } from '../stores/chatStore'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import SkillProposalCard from './SkillProposalCard'
import { ModelConfig } from '../services/llm-service'
import { localDateString } from '@soul/core'

const QUICK_QUESTIONS: string[] = []

const TOOL_NAME_MAP: Record<string, string> = {
  search_knowledge: '检索知识库',
  read_knowledge_file: '读取知识文件',
  list_knowledge_files: '列出知识文件',
  calculate_roi: '计算储能收益',
  lookup_policy: '查询电价政策',
  compare_products: '对比产品参数',
  load_skill: '加载技能定义',
  delegate_task: '委派子任务',
}

interface Props {
  conversationId: string
  avatarId: string
  onConversationUpdate: () => void
  visionModel?: ModelConfig
  /** 外部填充输入框文本（用于提示词模板一键填入） */
  fillText?: string
}

export default function ChatWindow({ conversationId, avatarId, onConversationUpdate, visionModel, fillText }: Props) {
  const { messages, isLoading, toolCallStatus, skillProposals, clearSkillProposals, resetTransientState, sendMessage, setMessages } = useChatStore(
    useShallow(s => ({
      messages: s.messages,
      isLoading: s.isLoading,
      toolCallStatus: s.toolCallStatus,
      skillProposals: s.skillProposals,
      clearSkillProposals: s.clearSkillProposals,
      resetTransientState: s.resetTransientState,
      sendMessage: s.sendMessage,
      setMessages: s.setMessages,
    }))
  )
  const [isInitialized, setIsInitialized] = useState(false)
  const [isRunningTests, setIsRunningTests] = useState(false)
  const [exportStatus, setExportStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId

  useEffect(() => {
    return () => {
      if (exportTimerRef.current) clearTimeout(exportTimerRef.current)
    }
  }, [])

  useEffect(() => {
    resetTransientState()
    let cancelled = false
    const loadMessages = async () => {
      try {
        const dbMessages = await window.electronAPI.getMessages(conversationId)
        if (cancelled) return
        setMessages(
          dbMessages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map((m, i) => ({ id: `db-${conversationId}-${i}`, role: m.role as 'user' | 'assistant', content: m.content }))
        )
      } catch (err) {
        if (!cancelled) {
          console.error('[ChatWindow] 加载消息失败:', err instanceof Error ? err.message : String(err))
          setMessages([])
        }
      } finally {
        if (!cancelled) setIsInitialized(true)
      }
    }
    loadMessages()
    return () => { cancelled = true }
  }, [conversationId, setMessages, resetTransientState])

  const handleSendMessage = async (content: string, images?: string[]) => {
    if (content.trim() === '/test-self') {
      await handleTestSelf()
      return
    }
    await sendMessage(content, conversationId, avatarId, images, visionModel)
    onConversationUpdate()
  }

  const handleTestSelf = async () => {
    const startConvId = conversationId
    const isStale = () => startConvId !== conversationIdRef.current

    setIsRunningTests(true)
    const userMsg = { id: nextMessageId(), role: 'user' as const, content: '/test-self' }
    const currentMessages = useChatStore.getState().messages
    setMessages([...currentMessages, userMsg])

    try {
      const testCases = await window.electronAPI.getTestCases(avatarId)
      if (isStale()) return

      if (testCases.length === 0) {
        const reply = '[ 自检结果 ] 暂无测试用例。请先在「测试中心」添加测试用例，然后再运行 /test-self。'
        setMessages([...useChatStore.getState().messages, { id: nextMessageId(), role: 'assistant', content: reply }])
        try { await window.electronAPI.saveMessage(startConvId, 'user', '/test-self') } catch { /* best-effort */ }
        try { await window.electronAPI.saveMessage(startConvId, 'assistant', reply) } catch { /* best-effort */ }
        return
      }

      const summary = [
        `[ 自检报告 ] 共 ${testCases.length} 个测试用例`,
        '',
        ...testCases.map((tc, i) => {
          const promptPreview = tc.prompt.length > 60 ? `${tc.prompt.slice(0, 60)}...` : tc.prompt
          return `${i + 1}. **${tc.name}** — ${tc.category}  \n   > ${promptPreview}`
        }),
        '',
        '请前往「测试中心」查看完整测试结果并运行测试。',
      ].join('\n')

      if (!isStale()) {
        setMessages([...useChatStore.getState().messages, { id: nextMessageId(), role: 'assistant', content: summary }])
      }
      try { await window.electronAPI.saveMessage(startConvId, 'user', '/test-self') } catch { /* best-effort */ }
      try { await window.electronAPI.saveMessage(startConvId, 'assistant', summary) } catch { /* best-effort */ }
    } catch (err) {
      if (isStale()) return
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error('自检失败:', errMsg)
      const errorMsg = `[ 自检失败 ] ${errMsg}`
      setMessages([...useChatStore.getState().messages, { id: nextMessageId(), role: 'assistant', content: errorMsg }])
    } finally {
      if (!isStale()) setIsRunningTests(false)
      onConversationUpdate()
    }
  }

  /**
   * 沉淀优质回答到 wiki/qa/。
   * 由 MessageBubble 上的 SAVE 按钮触发。
   *
   * @author zhi.qu
   * @date 2026-04-09
   */
  const handleSaveAnswer = useCallback(async (question: string, answer: string) => {
    try {
      const qa: WikiAnswerData = {
        id: `qa-${Date.now()}`,
        question,
        answer,
        sources: [],
        savedAt: localDateString(),
      }
      await window.electronAPI.saveWikiAnswer(avatarId, qa)
    } catch (err) {
      console.warn('答案沉淀失败:', err)
    }
  }, [avatarId])

  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center h-full bg-px-bg">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 bg-px-primary animate-blink" />
          <span className="font-game text-[12px] text-px-text-dim tracking-widest">
            加载中...
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-px-bg">
      {/* 顶栏：工具按钮 */}
      <div className="flex items-center justify-end px-4 py-1.5 border-b border-px-border-dim bg-px-surface gap-2">
        {exportStatus && (
          <span className={`font-game text-[11px] ${exportStatus.type === 'success' ? 'text-px-primary' : 'text-px-danger'}`}>
            {exportStatus.msg}
          </span>
        )}
        <button
          onClick={async () => {
            try {
              await window.electronAPI.exportConversation(conversationId, 'markdown')
              setExportStatus({ type: 'success', msg: '导出成功 ✓' })
              if (exportTimerRef.current) clearTimeout(exportTimerRef.current)
              exportTimerRef.current = setTimeout(() => setExportStatus(null), 3000)
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              window.electronAPI.logEvent('error', 'export-conversation', msg)
              setExportStatus({ type: 'error', msg: `导出失败: ${msg}` })
              if (exportTimerRef.current) clearTimeout(exportTimerRef.current)
              exportTimerRef.current = setTimeout(() => setExportStatus(null), 4000)
            }
          }}
          title="导出对话为 Markdown"
          className="font-game text-[11px] text-px-text-dim hover:text-px-primary px-2 py-0.5
            border border-transparent hover:border-px-primary/50 transition-none"
          aria-label="导出对话为 Markdown"
        >
          ↓ 导出
        </button>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-hidden">
        <MessageList
          messages={messages}
          isLoading={isLoading || isRunningTests}
          onQuickQuestion={handleSendMessage}
          quickQuestions={messages.length === 0 ? QUICK_QUESTIONS : undefined}
          onSaveAnswer={handleSaveAnswer}
        />
      </div>

      {/* Feature 6: 技能创建建议卡片 */}
      {skillProposals.length > 0 && (
        <SkillProposalCard
          avatarId={avatarId}
          proposals={skillProposals}
          onDismiss={clearSkillProposals}
        />
      )}

      {/* 工具调用 / 思考状态 */}
      {(isLoading || isRunningTests) && (
        <div className="px-6 py-2 bg-px-surface border-t-2 border-px-border">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 bg-px-primary animate-pulse-glow" />
            <span className="font-game text-[13px] text-px-text-sec tracking-wider">
              {toolCallStatus
                ? `${TOOL_NAME_MAP[toolCallStatus] ?? toolCallStatus}...`
                : isRunningTests
                  ? '正在运行测试...'
                  : '思考中...'}
            </span>
          </div>
        </div>
      )}

      {/* 输入区 */}
      <div className="border-t-2 border-px-border bg-px-surface/50 p-4">
        <MessageInput
          key={conversationId}
          onSend={handleSendMessage}
          disabled={isLoading || isRunningTests}
          fillText={fillText}
        />
      </div>
    </div>
  )
}
