import { useState, useEffect, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore, nextMessageId } from '../stores/chatStore'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import SkillProposalCard from './SkillProposalCard'
import TaskListPanel from './TaskListPanel'
import L3EventsPanel from './L3EventsPanel'
import AskQuestionCard from './AskQuestionCard'
import { ModelConfig } from '../services/llm-service'
import { localDateString } from '@soul/core/browser'
import { TOOL_NAME_MAP } from '../lib/tool-name-map'

/** 九层重构 #12 ask_question：当前等待用户回答的问题 payload（null = 无问题） */
interface PendingAskQuestion {
  question: string
  options: string[]
  allowCustom: boolean
}

/** 九层重构 #17 switch_mode：模式徽章颜色映射 */
const MODE_BADGE_STYLE: Record<'agent' | 'plan' | 'ask', { label: string; cls: string }> = {
  agent: { label: 'AGENT', cls: 'text-px-success border-px-success' },
  plan: { label: 'PLAN', cls: 'text-px-warning border-px-warning' },
  ask: { label: 'ASK', cls: 'text-px-text-dim border-px-border' },
}

const QUICK_QUESTIONS: string[] = []

interface Props {
  conversationId: string
  avatarId: string
  onConversationUpdate: () => void
  visionModel?: ModelConfig
  /** 外部填充输入框文本（用于提示词模板一键填入） */
  fillText?: string
  /** 分身头像值（用于消息气泡展示） */
  avatarImage?: string
  /** 分身名称（用于消息气泡展示） */
  avatarName?: string
}

export default function ChatWindow({ conversationId, avatarId, onConversationUpdate, visionModel, fillText, avatarImage, avatarName }: Props) {
  const { messages, isLoading, toolCallStatus, skillProposals, clearSkillProposals, resetTransientState, sendMessage, setMessages, bindConversation, mode, setMode } = useChatStore(
    useShallow(s => ({
      messages: s.messages,
      isLoading: s.isLoading,
      toolCallStatus: s.toolCallStatus,
      skillProposals: s.skillProposals,
      clearSkillProposals: s.clearSkillProposals,
      resetTransientState: s.resetTransientState,
      sendMessage: s.sendMessage,
      setMessages: s.setMessages,
      bindConversation: s.bindConversation,
      mode: s.mode,
      setMode: s.setMode,
    }))
  )
  /** 九层重构 #12 ask_question：当前等待用户回答的问题 */
  const [pendingAsk, setPendingAsk] = useState<PendingAskQuestion | null>(null)
  const [isInitialized, setIsInitialized] = useState(false)
  const [isRunningTests, setIsRunningTests] = useState(false)
  const [exportStatus, setExportStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId
  /** L3 桌面工具事件触发的临时输入填充（来自 inspector / form / canva 等卡片） */
  const [l3InjectedFill, setL3InjectedFill] = useState<string | undefined>(undefined)
  const handleInjectPrompt = useCallback((text: string) => {
    setL3InjectedFill(text)
  }, [])
  /** RAG 检索阶段（"正在检索…/正在分析关联组件…/正在拼装上下文…"），由 main 进程通过 onRagProgress 推送。
   *  状态在每次新提问时自动清空（done 阶段清空），避免上一轮残留。 */
  const [ragProgress, setRagProgress] = useState<{ phase: string; detail?: string } | null>(null)
  /** 已耗时（秒，精度 0.1s），isLoading 期间递增，用于在"思考中..."旁显示进度感知 */
  const [elapsedSec, setElapsedSec] = useState(0)

  useEffect(() => {
    if (!isLoading) {
      setElapsedSec(0)
      return
    }
    const timer = setInterval(() => setElapsedSec(s => +(s + 0.1).toFixed(1)), 100)
    return () => clearInterval(timer)
  }, [isLoading])

  useEffect(() => {
    return () => {
      if (exportTimerRef.current) clearTimeout(exportTimerRef.current)
    }
  }, [])

  // 监听 RAG 检索进度推送：只接受当前 avatarId 的事件，避免跨分身串
  useEffect(() => {
    const unsubscribe = window.electronAPI.onRagProgress((data) => {
      if (data.avatarId !== avatarId) return
      if (data.phase === 'done') {
        setRagProgress(null)
      } else {
        setRagProgress({ phase: data.phase, detail: data.detail })
      }
    })
    return () => unsubscribe()
  }, [avatarId])

  /**
   * 九层重构 #12 ask_question：监听主进程推送，弹出 AskQuestionCard。
   * 仅响应当前会话的事件；切换会话时自动清掉旧问题。
   */
  useEffect(() => {
    const unsubscribe = window.electronAPI.onChatAskQuestion((payload) => {
      if (payload.conversationId !== conversationId) return
      setPendingAsk({
        question: payload.question,
        options: payload.options,
        allowCustom: payload.allowCustom,
      })
    })
    return () => unsubscribe()
  }, [conversationId])

  /**
   * 九层重构 #17 switch_mode：监听主进程推送，更新 chatStore.mode。
   * setMode 已做去重（同值不触发 set），不会引发多余渲染。
   */
  useEffect(() => {
    const unsubscribe = window.electronAPI.onChatModeChanged((payload) => {
      if (payload.conversationId !== conversationId) return
      setMode(payload.mode)
    })
    return () => unsubscribe()
  }, [conversationId, setMode])

  // isLoading 变成 false 时强制清掉 ragProgress（兜底）
  useEffect(() => {
    if (!isLoading) setRagProgress(null)
  }, [isLoading])

  useEffect(() => {
    resetTransientState()
    // Stage 三 P2 范围外 1：绑定当前会话并从 DB 恢复任务列表（异步，失败兜底为空列表）
    bindConversation(conversationId).catch((err) => {
      console.warn('[ChatWindow] bindConversation 失败:', err instanceof Error ? err.message : String(err))
    })
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
  }, [conversationId, setMessages, resetTransientState, bindConversation])

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
        try { await window.electronAPI.saveMessage(startConvId, 'user', '/test-self') } catch (e1) { void e1 /* best-effort */ }
        try { await window.electronAPI.saveMessage(startConvId, 'assistant', reply) } catch (e2) { void e2 /* best-effort */ }
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
      try { await window.electronAPI.saveMessage(startConvId, 'user', '/test-self') } catch (e3) { void e3 /* best-effort */ }
      try { await window.electronAPI.saveMessage(startConvId, 'assistant', summary) } catch (e4) { void e4 /* best-effort */ }
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
      {/* 顶栏：模式徽章 + 工具按钮（九层重构 #17） */}
      <div className="flex items-center justify-end px-4 py-1.5 border-b border-px-border-dim bg-px-surface gap-2">
        {/* 模式徽章：点击循环 agent → plan → ask → agent，方便快速切换 */}
        <button
          onClick={() => {
            const next: 'agent' | 'plan' | 'ask' = mode === 'agent' ? 'plan' : mode === 'plan' ? 'ask' : 'agent'
            setMode(next)
          }}
          className={`font-game text-[11px] px-2 py-0.5 border tracking-widest ${MODE_BADGE_STYLE[mode].cls} hover:opacity-80`}
          title={`当前模式：${MODE_BADGE_STYLE[mode].label}（点击切换；plan 禁写、ask 禁所有工具）`}
          aria-label="切换工作模式"
        >
          {MODE_BADGE_STYLE[mode].label}
        </button>
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
          avatarImage={avatarImage}
          avatarName={avatarName}
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

      {/* Agent 任务列表（todo_write 工具产出）：tasks 为空时组件内部自动隐藏，不占位 */}
      <TaskListPanel />

      {/* 九层重构 #12 ask_question：用户多选卡片（无问题时不渲染） */}
      {pendingAsk && (
        <AskQuestionCard
          question={pendingAsk.question}
          options={pendingAsk.options}
          allowCustom={pendingAsk.allowCustom}
          onAnswer={(answer) => {
            setPendingAsk(null)
            // 把答案作为下一条 user 消息送出，让 LLM 在工具循环中收到
            void handleSendMessage(`[ask_question answer] ${answer}`)
          }}
          onCancel={() => setPendingAsk(null)}
        />
      )}

      {/* 工具调用 / RAG 检索 / 思考状态 */}
      {(isLoading || isRunningTests) && (
        <div className="px-6 py-2 bg-px-surface border-t-2 border-px-border">
          <div className="flex items-center gap-2">
            {/* 三点跳动动画 */}
            <div className="flex items-center gap-0.5">
              <div className="w-1.5 h-1.5 rounded-full bg-px-primary animate-bounce" style={{ animationDelay: '0ms', animationDuration: '1s' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-px-primary animate-bounce" style={{ animationDelay: '150ms', animationDuration: '1s' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-px-primary animate-bounce" style={{ animationDelay: '300ms', animationDuration: '1s' }} />
            </div>
            <span className="font-game text-[13px] text-px-text-sec tracking-wider">
              {toolCallStatus
                ? `${TOOL_NAME_MAP[toolCallStatus] ?? toolCallStatus}...`
                : isRunningTests
                  ? '正在运行测试...'
                  : ragProgress
                    ? (ragProgress.detail ?? `${ragProgress.phase}...`)
                    : '思考中...'}
              {isLoading && !isRunningTests && (
                <span className="ml-1 opacity-60">{elapsedSec.toFixed(1)}s</span>
              )}
            </span>
          </div>
        </div>
      )}

      {/* L3 桌面工具事件卡片：表单 / inspector / verifier / 下载 / canva / github / snip */}
      <L3EventsPanel conversationId={conversationId} onInjectPrompt={handleInjectPrompt} />

      {/* 输入区 */}
      <div className="border-t-2 border-px-border bg-px-surface/50 p-4">
        <MessageInput
          key={conversationId}
          onSend={handleSendMessage}
          disabled={isLoading || isRunningTests}
          fillText={l3InjectedFill ?? fillText}
        />
      </div>
    </div>
  )
}
