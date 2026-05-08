import { useState, useEffect, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore, nextMessageId, tryExtractDocumentAttachment, type AttachmentRef } from '../stores/chatStore'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import SkillProposalCard from './SkillProposalCard'
import TaskListPanel from './TaskListPanel'
import L3EventsPanel from './L3EventsPanel'
import AskQuestionCard from './AskQuestionCard'
import { ModelConfig } from '../services/llm-service'
import type { DocumentAttachment } from '../services/chat-types'
import { localDateString } from '@soul/core/browser'
import ToolCallTimeline from './ToolCallTimeline'

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

function collectDocumentAttachmentsByAssistantId(dbMessages: DbMessage[]): Map<string, DocumentAttachment[]> {
  const byAssistantId = new Map<string, DocumentAttachment[]>()
  let pending: DocumentAttachment[] = []

  for (const message of dbMessages) {
    if (message.role === 'tool') {
      const attachment = tryExtractDocumentAttachment('export_excel', message.content)
      if (attachment) pending = [...pending, attachment]
      continue
    }

    if (message.role === 'assistant' && pending.length > 0) {
      byAssistantId.set(message.id, pending)
      pending = []
    }
  }

  return byAssistantId
}

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
  const { messages, isLoading, toolCallTimeline, appendToolCallTimeline, skillProposals, clearSkillProposals, resetTransientState, sendMessage, setMessages, bindConversation, mode, setMode } = useChatStore(
    useShallow(s => ({
      messages: s.messages,
      isLoading: s.isLoading,
      toolCallTimeline: s.toolCallTimeline,
      appendToolCallTimeline: s.appendToolCallTimeline,
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

  /**
   * 监听主进程 RAG / Skill 进度推送，把每个 phase 作为一条 timeline entry 追加，
   * 让用户在普通问答（无 function-calling）场景下也能看到完整检索链路。
   *
   * duration 计算：每条 entry 的耗时 = 收到本 phase 时刻 - 收到上一 phase 时刻；
   * 第一条用 0（无前置阶段可减）。done 不 push，仅用于关闭活动状态。
   *
   * 跨分身隔离：只接受当前 avatarId 的事件；切换分身时 ref 会随 effect 销毁清空。
   */
  const ragLastEventAtRef = useRef<number | null>(null)
  useEffect(() => {
    ragLastEventAtRef.current = null
    const unsubscribe = window.electronAPI.onRagProgress((data) => {
      if (data.avatarId !== avatarId) return
      const now = Date.now()
      if (data.phase === 'done') {
        ragLastEventAtRef.current = null
        return
      }

      // skill-loaded 是主进程在 skillRouter 命中后单独 emit 的伪 phase（不在 RAGProgressPhase 枚举内）。
      const isSkill = data.phase === 'skill-loaded'
      const last = ragLastEventAtRef.current
      const durationMs = last === null ? 0 : Math.max(0, now - last)
      ragLastEventAtRef.current = now
      try {
        appendToolCallTimeline({
          id: `${isSkill ? 'skill' : 'rag'}-${now}`,
          name: data.phase,
          argsPreview: data.detail || '',
          resultPreview: '',
          durationMs,
          ok: true,
          startedAt: now,
          kind: isSkill ? 'skill' : 'rag',
        })
      } catch (pushErr) {
        const msg = pushErr instanceof Error ? pushErr.message : String(pushErr)
        window.electronAPI.logEvent('warn', 'append-rag-timeline-failed', `${data.phase}: ${msg}`)
      }
    })
    return () => unsubscribe()
  }, [avatarId, appendToolCallTimeline])

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

  useEffect(() => {
    resetTransientState()
    // Stage 三 P2 范围外 1：绑定当前会话并从 DB 恢复任务列表（异步，失败兜底为空列表）
    bindConversation(conversationId).catch((err) => {
      console.warn('[ChatWindow] bindConversation 失败:', err instanceof Error ? err.message : String(err))
    })
    let cancelled = false
    const loadMessages = async () => {
      try {
        // 并发拉消息和附件，避免历史会话首屏多等一次 IPC
        const [dbMessages, dbAttachments] = await Promise.all([
          window.electronAPI.getMessages(conversationId),
          window.electronAPI.listAttachments(conversationId).catch(() => [] as Attachment[]),
        ])
        if (cancelled) return

        // 按 messageId 分组附件，O(N) 一次过滤
        const attachmentsByMsgId = new Map<string, AttachmentRef[]>()
        for (const att of dbAttachments) {
          if (!att.message_id) continue
          const ref: AttachmentRef = {
            id: att.id,
            name: att.name,
            mime: att.mime,
            size: att.size,
            summary: att.summary,
            outline: att.outline,
          }
          const list = attachmentsByMsgId.get(att.message_id) ?? []
          list.push(ref)
          attachmentsByMsgId.set(att.message_id, list)
        }
        const documentAttachmentsByAssistantId = collectDocumentAttachmentsByAssistantId(dbMessages)

        setMessages(
          dbMessages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map((m, i) => {
              const role = m.role as 'user' | 'assistant'
              // 修复历史会话重开时 image_urls 丢失的 bug：
              // 原实现完全忽略了 m.image_urls，所以重开后只剩文字。这里复原成 string[]。
              let imageUrls: string[] | undefined
              if (m.image_urls) {
                try {
                  const parsed = JSON.parse(m.image_urls)
                  if (Array.isArray(parsed) && parsed.every(u => typeof u === 'string')) {
                    imageUrls = parsed as string[]
                  }
                } catch (parseErr) {
                  void parseErr
                }
              }
              const attachments = role === 'user' ? attachmentsByMsgId.get(m.id) : undefined
              const documentAttachments = role === 'assistant'
                ? documentAttachmentsByAssistantId.get(m.id)
                : undefined
              return {
                // 用 DB 的真实 messageId，便于后续 attachments 用 message_id 精确关联
                id: `db-${conversationId}-${m.id || i}`,
                role,
                content: m.content,
                imageUrls,
                attachments,
                documentAttachments,
              }
            })
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

  const handleSendMessage = async (
    content: string,
    images?: string[],
    attachments?: AttachmentRef[],
    inlineFiles?: Array<{ name: string; ext: string; mime: string; text: string }>,
  ) => {
    if (content.trim() === '/test-self') {
      await handleTestSelf()
      return
    }
    await sendMessage(content, conversationId, avatarId, images, visionModel, attachments, inlineFiles)
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
          avatarId={avatarId}
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

      {/* 工具调用时间线（仿 Cursor）：完整展示本轮所有工具调用历史 */}
      <ToolCallTimeline
        entries={toolCallTimeline}
        isLoading={isLoading}
        elapsedSec={elapsedSec}
      />

      {/* 兜底：仅回归测试运行时显示（RAG 阶段已并入 ToolCallTimeline；
          ragProgress state 仍保留但不再渲染，作为内部状态供未来其他用途读取）。 */}
      {isRunningTests && (
        <div className="px-6 py-2 bg-px-surface border-t-2 border-px-border">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5">
              <div className="w-1.5 h-1.5 rounded-full bg-px-primary animate-bounce" style={{ animationDelay: '0ms', animationDuration: '1s' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-px-primary animate-bounce" style={{ animationDelay: '150ms', animationDuration: '1s' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-px-primary animate-bounce" style={{ animationDelay: '300ms', animationDuration: '1s' }} />
            </div>
            <span className="font-game text-[13px] text-px-text-sec tracking-wider">
              正在运行测试...
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
          conversationId={conversationId}
        />
      </div>
    </div>
  )
}
