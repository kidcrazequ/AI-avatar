import { useState, useEffect, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore, nextMessageId, tryExtractDocumentAttachment, extractDocumentAttachmentsFromText, type AttachmentRef, type ChatMessage } from '../stores/chatStore'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import SkillProposalCard from './SkillProposalCard'
import TaskListPanel from './TaskListPanel'
import L3EventsPanel from './L3EventsPanel'
import AskQuestionCard from './AskQuestionCard'
import { ModelConfig, getModelTier, type ModelTier } from '../services/llm-service'
import type { DocumentAttachment } from '../services/chat-types'
import { localDateString } from '@soul/core/browser'
// v19：ToolCallTimeline 不再由 ChatWindow 直接渲染（挪到了 MessageBubble 内）；
// 保留组件文件供 MessageBubble 引用即可。
import EventViewer from './EventViewer'

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

/**
 * 端云 / 端侧 pill 颜色映射（2026-05-22 Marvis 借鉴）。
 *
 * 状态由 store.chatModelMode 受控驱动（不是 baseUrl 自动推导）：
 * - local: 用 localChatModel（端侧 slot，通常指向本机 Ollama / lm-studio / vllm）
 * - cloud: 用 chatModel（云端 slot，DeepSeek / Claude / Qwen 等）
 *
 * unknown 不会出现——mode 是受控二态。
 */
const TIER_BADGE_STYLE: Record<'local' | 'cloud', { label: string; cls: string; title: string }> = {
  local: { label: '🟢 端侧', cls: 'text-px-success border-px-success', title: '当前走端侧模型 slot：数据发到 localChatModel.baseUrl（默认本机 Ollama），不出本机（隐私模式）。' },
  cloud: { label: '🟡 端云', cls: 'text-px-warning border-px-warning', title: '当前走云端模型 slot：问题与上下文会发到 chatModel.baseUrl 配置的云服务商（效率模式）。' },
}

const QUICK_QUESTIONS: string[] = []

function collectDocumentAttachmentsByAssistantId(
  dbMessages: DbMessage[],
  conversationId: string,
): Map<string, DocumentAttachment[]> {
  const byAssistantId = new Map<string, DocumentAttachment[]>()
  let pending: DocumentAttachment[] = []

  for (const message of dbMessages) {
    if (message.role === 'tool') {
      // 老 payload（2026-05 之前）没有 conversation_id 字段；用当前会话兜底，
      // 否则 tryExtractDocumentAttachment 会返回 null，历史 FileCard 全丢。
      //
      // toolName 传 ''——历史 tool 行实际 name 没入库，统一传 'export_excel'
      // 会让无 format 字段的 generate_document 结果被兜底成 xlsx 误判格式。
      // tryExtractDocumentAttachment 内部已改为优先按 file_path 扩展名推断，
      // toolName 只在两条都识别不出时兜底，传空就是放弃兜底（安全选择）。
      const attachment = tryExtractDocumentAttachment('', message.content, conversationId)
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
  /** 分身角色标签（短文本，如"财务分析专家"，展示在消息气泡 avatarName 旁的 chip 里） */
  avatarRole?: string
  /** App 全局 toast，供"沉淀知识"等操作给用户明确反馈 */
  showToast?: (message: string, type?: 'success' | 'error') => void
}

export default function ChatWindow({ conversationId, avatarId, onConversationUpdate, visionModel, fillText, avatarImage, avatarName, avatarRole, showToast }: Props) {
  const { messages, isLoading, skillProposals, clearSkillProposals, resetTransientState, sendMessage, setMessages, setConversationTree, bindConversation, restoreInflightStreamingMessage, mode, setMode, conversationModelOverride, setConversationModel, chatModel, localChatModel, chatModelMode, setChatModelMode } = useChatStore(
    useShallow(s => ({
      messages: s.messages,
      isLoading: s.isLoading,
      skillProposals: s.skillProposals,
      clearSkillProposals: s.clearSkillProposals,
      resetTransientState: s.resetTransientState,
      sendMessage: s.sendMessage,
      setMessages: s.setMessages,
      setConversationTree: s.setConversationTree,
      bindConversation: s.bindConversation,
      restoreInflightStreamingMessage: s.restoreInflightStreamingMessage,
      mode: s.mode,
      setMode: s.setMode,
      conversationModelOverride: s.conversationModelOverrides[conversationId] ?? null,
      setConversationModel: s.setConversationModel,
      chatModel: s.chatModel,
      localChatModel: s.localChatModel,
      chatModelMode: s.chatModelMode,
      setChatModelMode: s.setChatModelMode,
    }))
  )

  // 端云/端侧 pill：由 chatModelMode（受控全局态）直接驱动，不再用 getModelTier 推导。
  // getModelTier 仍保留导出供其它地方诊断 baseUrl 实际指向；这里 pill 主色跟 mode 一一对应。
  // 缺配置警示：mode='local' 但 localChatModel 还在默认 ollama / qwen2.5:7b 且没改过，
  // 用户可能没装本地推理服务——点 pill 切到 local 后发送会报 ECONNREFUSED。
  // 这里轻量检测："baseUrl 是默认 ollama 端口"且"apiKey 是默认的 'ollama'" → 视为"未自定义配置"，
  // 不显示警示，因为这就是 Ollama 默认环境（已装则可用）。判定保守，不打扰用户。
  const pillTier: ModelTier = chatModelMode === 'local' ? 'local' : 'cloud'
  const tieredModel = chatModelMode === 'local' ? localChatModel : chatModel
  // 仅用于诊断显示（title 提示），不参与主色判定
  const diagnosticTier = getModelTier(tieredModel.model, tieredModel.baseUrl)

  /** 会话内可临时切换的模型循环菜单（与子任务 7 配套；默认 = 走分身 defaultModel） */
  const MODEL_CYCLE: Array<{ value: string | null; label: string }> = [
    { value: null, label: '默认' },
    { value: 'claude-opus-4-7', label: 'Opus 4.7' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    { value: 'deepseek-chat', label: 'DeepSeek' },
  ]
  const modelIdx = Math.max(0, MODEL_CYCLE.findIndex(m => m.value === conversationModelOverride))
  const currentModelLabel = MODEL_CYCLE[modelIdx].label
  const cycleModel = (): void => {
    const next = MODEL_CYCLE[(modelIdx + 1) % MODEL_CYCLE.length]
    setConversationModel(conversationId, next.value)
  }
  /** 九层重构 #12 ask_question：当前等待用户回答的问题 */
  const [pendingAsk, setPendingAsk] = useState<PendingAskQuestion | null>(null)
  const [isInitialized, setIsInitialized] = useState(false)
  const [initializedConversationId, setInitializedConversationId] = useState<string | null>(null)
  const [isRunningTests, setIsRunningTests] = useState(false)
  const [exportStatus, setExportStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // v17 事件 viewer：调试 JSONL 事件流（记忆/模型/模式/子分身派发的真相）
  const [eventViewerOpen, setEventViewerOpen] = useState(false)
  const conversationIdRef = useRef(conversationId)
  // eslint-disable-next-line react-hooks/refs -- 让事件回调（emit 给 main 的 async path）能拿到最新 conversationId，render-期同步写比 effect 同步更新及时（effect 写会让 event 期间读到旧值）
  conversationIdRef.current = conversationId
  const lastLoadedConversationIdRef = useRef(conversationId)
  /** L3 桌面工具事件触发的临时输入填充（来自 inspector / form / canva 等卡片） */
  const [l3InjectedFill, setL3InjectedFill] = useState<string | undefined>(undefined)
  /**
   * Project 上下文缓存：当 conversation.project_id 不是 default 时，
   * 自动读 projects/<pid>/knowledge/{README,notes}.md，发送时作为 inline file 注入。
   * 通过 projectsReadContextFile IPC，主进程会优先 canonical 路径并回退到
   * 老路径 knowledge/projects/<pid>/<file>。key 用 `${conversationId}` 隔离。
   */
  // 绑 conversationId：切换会话时立刻失效，handleSendMessage 校验匹配再注入；
  // 否则切到 default/B 项目立刻发送会带上 A 项目的 README/notes（"幽灵上下文"）
  const [projectContext, setProjectContext] = useState<{
    name: string
    text: string
    conversationId: string
  } | null>(null)
  const handleInjectPrompt = useCallback((text: string) => {
    // 立刻重置回 undefined，避免 l3InjectedFill 永久遮蔽模板 fillText（?? 短路），
    // 并让同文案二次注入也能重新触发 MessageInput 的 fill effect（同 App.tsx 模板填充模式）
    setL3InjectedFill(text)
    setTimeout(() => setL3InjectedFill(undefined), 0)
  }, [])
  /** 已耗时（秒），isLoading 期间递增，用于在"思考中..."旁显示进度感知 */
  const [elapsedSec, setElapsedSec] = useState(0)

  useEffect(() => {
    if (!isLoading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- isLoading 切换到 false 时重置计时显示，合法的 effect 联动
      setElapsedSec(0)
      return
    }
    const timer = setInterval(() => setElapsedSec(s => s + 1), 1000)
    return () => clearInterval(timer)
  }, [isLoading])

  useEffect(() => {
    return () => {
      if (exportTimerRef.current) clearTimeout(exportTimerRef.current)
    }
  }, [])

  /**
   * 九层重构 #12 ask_question：监听主进程推送，弹出 AskQuestionCard。
   * 仅响应当前会话的事件；切换会话时自动清掉旧问题。
   */
  useEffect(() => {
    // 切换会话时清掉上个会话的旧问题卡片，否则在 B 会话回答 A 的卡片会把答案
    // 注入到 B（handleSendMessage 闭包到当前 conversationId）——跨会话"幽灵上下文"泄漏
    // eslint-disable-next-line react-hooks/set-state-in-effect -- conversationId 变化时清旧卡片，合法的 effect 联动
    setPendingAsk(null)
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

  // 版本切换器（v21·phase2）：切分支后 MessageBubble 派发 soul-reload-active-path，
  // 这里 bump nonce → 重跑下面的 loadMessages，重新拉活动路径 + 会话树。
  const [reloadNonce, setReloadNonce] = useState(0)
  useEffect(() => {
    const onReload = (e: Event) => {
      const detail = (e as CustomEvent<{ conversationId?: string }>).detail
      if (detail?.conversationId === conversationId) setReloadNonce((n) => n + 1)
    }
    window.addEventListener('soul-reload-active-path', onReload)
    return () => window.removeEventListener('soul-reload-active-path', onReload)
  }, [conversationId])

  useEffect(() => {
    const switchedConversation = lastLoadedConversationIdRef.current !== conversationId
    lastLoadedConversationIdRef.current = conversationId
    if (switchedConversation) {
      // 切换会话时先进入当前会话的加载态，避免用上一会话的消息和滚动位置过渡渲染。
      setIsInitialized(false)
      setMessages([])
    }
    resetTransientState()
    // Stage 三 P2 范围外 1：绑定当前会话并从 DB 恢复任务列表（异步，失败兜底为空列表）
    bindConversation(conversationId).catch((err) => {
      console.warn('[ChatWindow] bindConversation 失败:', err instanceof Error ? err.message : String(err))
    })
    let cancelled = false
    const loadMessages = async () => {
      try {
        // 并发拉消息、附件、会话树（版本切换器用），避免历史会话首屏多等几次 IPC
        const [dbMessages, dbAttachments, dbTree] = await Promise.all([
          window.electronAPI.getMessages(conversationId),
          window.electronAPI.listAttachments(conversationId).catch(() => [] as Attachment[]),
          window.electronAPI.getConversationTree(conversationId).catch(() => []),
        ])
        if (cancelled) return
        setConversationTree(dbTree)

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
        const documentAttachmentsByAssistantId = collectDocumentAttachmentsByAssistantId(dbMessages, conversationId)

        const dbChatMessages = dbMessages
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
              ? extractDocumentAttachmentsFromText(
                m.content,
                conversationId,
                documentAttachmentsByAssistantId.get(m.id) ?? [],
              )
              : undefined
            // v17：从 DB 的 uncertain_markers / reconsider_markers 列恢复 chip。
            // 列存 JSON 数组字符串；NULL/损坏/非数组都退化为 undefined（与无 chip 等价）。
            const parseMarkers = (raw: string | null | undefined): string[] | undefined => {
              if (!raw) return undefined
              try {
                const parsed = JSON.parse(raw)
                if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') && parsed.length > 0) {
                  return parsed as string[]
                }
              } catch { /* swallow: 损坏列等价于无 chip */ }
              return undefined
            }
            // v19：工具调用时间线从 DB tool_call_timeline_json 列恢复，让切换会话回来时
            // 仍能完整看到每条 assistant 当时调用了哪些工具（之前是全局 store 状态，
            // 切对话就被清空）。损坏/非数组的列退化为 undefined。
            const parseTimeline = (raw: string | null | undefined) => {
              if (!raw) return undefined
              try {
                const parsed = JSON.parse(raw)
                if (Array.isArray(parsed) && parsed.length > 0) {
                  return parsed as ChatMessage['toolCallTimeline']
                }
              } catch { /* swallow: 损坏列等价于无时间线 */ }
              return undefined
            }
            return {
              // 直接用 DB 的 messageId 作为 UI bubble id——便于 deleteMessage(uiId)
              // 直接命中 DB 行（"重新生成"按钮路径）。之前包成 db-${conv}-${id}
              // 让 DB 删不到导致旧回答刷新后复活。i 兜底防 m.id 缺失（理论不发生）
              id: m.id || `local-${conversationId}-${i}`,
              role,
              content: m.content,
              imageUrls,
              attachments,
              documentAttachments,
              // thinking 模型的思考过程从 DB reasoning_content 列恢复（v13 schema 起持久化），
              // 让切换回该会话时折叠区能复现；历史无此列的行返回 NULL，与 undefined 同行为
              reasoning: m.reasoning_content || undefined,
              uncertainMarkers: parseMarkers(m.uncertain_markers),
              reconsiderMarkers: parseMarkers(m.reconsider_markers),
              toolCallTimeline: parseTimeline(m.tool_call_timeline_json),
            }
          })

        const liveState = useChatStore.getState()
        const liveMessages = liveState.currentConversationId === conversationId ? liveState.messages : []
        const dbMessageIds = new Set(dbChatMessages.map(m => m.id))
        const now = Date.now()
        const hasFreshLocalOnlyMessage = liveMessages.some((m) => {
          const match = /^msg-(\d+)-/.exec(m.id)
          if (!match || dbMessageIds.has(m.id)) return false
          return now - Number(match[1]) < 30_000
        })
        if (!hasFreshLocalOnlyMessage) {
          setMessages(dbChatMessages)
        }
        // 切走→切回会话时回灌 in-flight streaming：DB 里还没有落盘的 assistant 消息，
        // 此处把 sendMessage 闭包累积的 text/reasoning/toolCallTimeline 从 snapshot 拼到末尾，
        // 避免用户切回时看到空白（2026-05-22 回归修复）。
        // 返回 { startedAt } 时同步校准"思考中... · Xs"计时器，避免从 0 重新算给"流刚开始"
        // 的错觉（用户上次反馈"计时从 0 开始"的根因）。
        const restored = restoreInflightStreamingMessage(conversationId)
        if (restored) {
          const elapsedSec = Math.max(0, +(((Date.now() - restored.startedAt) / 1000).toFixed(1)))
          setElapsedSec(elapsedSec)
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[ChatWindow] 加载消息失败:', err instanceof Error ? err.message : String(err))
          const liveState = useChatStore.getState()
          const liveMessages = liveState.currentConversationId === conversationId ? liveState.messages : []
          const now = Date.now()
          const hasFreshLocalMessage = liveMessages.some((m) => {
            const match = /^msg-(\d+)-/.exec(m.id)
            return Boolean(match) && now - Number(match?.[1]) < 30_000
          })
          if (!hasFreshLocalMessage) setMessages([])
        }
      } finally {
        if (!cancelled) {
          setInitializedConversationId(conversationId)
          setIsInitialized(true)
        }
      }
    }
    loadMessages()
    return () => { cancelled = true }
  }, [conversationId, reloadNonce, setMessages, setConversationTree, resetTransientState, bindConversation, restoreInflightStreamingMessage])

  // 加载当前 conversation 的 project 上下文（README + notes），用于发送时自动注入
  useEffect(() => {
    let cancelled = false
    // effect 开头先清掉旧 context——异步加载期间用户可能立刻发送；不清就把上一个
    // conversation/project 的 README 注进新会话（即"幽灵上下文"）
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 切 conv 必须同步清掉旧 context 才能挡住"切完立刻发送"的窗口
    setProjectContext(null)
    void (async () => {
      try {
        const conv = await window.electronAPI.getConversation(conversationId)
        if (cancelled) return
        const pid = conv?.project_id && conv.project_id.length > 0 ? conv.project_id : 'default'
        if (pid === 'default') { setProjectContext(null); return }
        const parts: string[] = []
        try {
          const readme = await window.electronAPI.projectsReadContextFile(avatarId, pid, 'README.md')
          if (readme && readme.trim()) parts.push(`## README\n\n${readme}`)
        } catch { /* 不存在 OK */ }
        try {
          const notes = await window.electronAPI.projectsReadContextFile(avatarId, pid, 'notes.md')
          if (notes && notes.trim()) parts.push(`## NOTES\n\n${notes}`)
        } catch { /* 不存在 OK */ }
        if (cancelled) return
        if (parts.length > 0) {
          setProjectContext({
            name: pid,
            text: `# 当前任务包：${pid}\n\n（以下内容由系统自动注入，作为本次对话的背景上下文。）\n\n${parts.join('\n\n')}`,
            conversationId,
          })
        } else {
          setProjectContext(null)
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('[ChatWindow] 加载 project 上下文失败:', err instanceof Error ? err.message : String(err))
          setProjectContext(null)
        }
      }
    })()
    return () => { cancelled = true }
  }, [conversationId, avatarId])

  const handleSendMessage = async (
    content: string,
    images?: string[],
    attachments?: AttachmentRef[],
    inlineFiles?: Array<{ name: string; ext: string; mime: string; text: string; persist?: boolean }>,
  ) => {
    if (content.trim() === '/test-self') {
      await handleTestSelf()
      return
    }
    // 自动注入 project 上下文（prepend 到 inlineFiles，让分身在 system / user prompt 拼装时看到）。
    // persist:false——项目 README/notes 每轮重新加载并拼装，不进用户消息 snapshot；
    // 否则每条用户消息都会带一份 README/notes，对话历史 / DB / 气泡线性膨胀。
    // 用户自己 @ 出来的引用走 sendMessage 默认（persist 缺省 = true）正常 snapshot。
    // 校验 projectContext.conversationId === 当前 conversationId：切换会话时 effect
    // 异步加载新 context，期间用户立刻发送会读到 stale state（上一会话的项目）；
    // 不匹配就跳过注入，避免 A 的 README 漏进 B 的会话
    const ctxMatches = projectContext && projectContext.conversationId === conversationId
    const finalInlineFiles = ctxMatches
      ? [
          {
            name: `@project/${projectContext.name}.md`,
            ext: '.md',
            mime: 'text/markdown',
            text: projectContext.text,
            persist: false,
          },
          ...(inlineFiles || []),
        ]
      : inlineFiles
    await sendMessage(content, conversationId, avatarId, images, visionModel, attachments, finalInlineFiles)
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
      // v19：之前只把 saved 状态在按钮上闪 3s，用户感受不到落盘是否真的成功，
      // 反馈为「SAVE 功能失效」。这里改用全局 toast 给出可见的"已沉淀"提示。
      showToast?.('已沉淀到知识百科', 'success')
    } catch (err) {
      console.warn('答案沉淀失败:', err)
      showToast?.(`沉淀失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }, [avatarId, showToast])

  if (!isInitialized || initializedConversationId !== conversationId) {
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
    <div className="flex flex-col h-full min-h-0 bg-px-bg">
      {/* 顶栏：模式徽章 + 工具按钮（九层重构 #17） */}
      <div className="flex items-center justify-end px-4 py-1.5 border-b border-px-border-dim bg-px-surface gap-2">
        {/*
         * 端云 / 端侧 pill（2026-05-22 Marvis 借鉴）
         * 点击切换 app 全局 master slot：cloud（chatModel）↔ local（localChatModel）。
         * 切换后立即 setSetting 落 sqlite，下次启动保持上次 mode。
         * diagnosticTier !== pillTier 时（如 mode='local' 但 baseUrl 实际是云）追加 ⚠ 提示。
         */}
        <button
          type="button"
          onClick={() => {
            const next: 'cloud' | 'local' = chatModelMode === 'cloud' ? 'local' : 'cloud'
            setChatModelMode(next)
            void window.electronAPI.setSetting('chat_model_mode', next)
            // 切换 toast：cloud→local 提醒需本地推理服务已起；local→cloud 简短确认
            // 降低"切了但没视觉反馈"的体验断点，再发送消息时不会"突然报 ECONNREFUSED 不知道为啥"
            if (showToast) {
              if (next === 'local') {
                showToast(
                  `已切到 🟢 端侧 · 数据走 ${localChatModel.baseUrl} (${localChatModel.model})。需 Ollama / lm-studio 已启动并 pull 过该模型——发送前请确认。`,
                  'success',
                )
              } else {
                showToast('已切到 🟡 端云 · 数据走云端 API', 'success')
              }
            }
          }}
          className={`font-game text-[11px] px-2 py-0.5 border tracking-widest hover:opacity-80 ${TIER_BADGE_STYLE[pillTier].cls}`}
          title={`${TIER_BADGE_STYLE[pillTier].title}（点击切换到${chatModelMode === 'cloud' ? '端侧' : '端云'}）${diagnosticTier !== pillTier && diagnosticTier !== 'unknown' ? `\n⚠ 当前 baseUrl 实际指向 ${diagnosticTier === 'local' ? '本机' : '云端'}，与 pill 状态不一致——请在设置里核对。` : ''}`}
          aria-label={`切换到${chatModelMode === 'cloud' ? '端侧' : '端云'}模式`}
        >
          {TIER_BADGE_STYLE[pillTier].label}
          {diagnosticTier !== pillTier && diagnosticTier !== 'unknown' ? ' ⚠' : ''}
        </button>
        {/*
         * 模型切换：点击循环 默认/Opus/Sonnet/Haiku/DeepSeek，会话级生效。
         * 端侧模式下禁用：循环列表里都是云端模型名，落到 localhost:11434 上要么 model not found
         * 要么 ECONNREFUSED——禁掉避免用户在 local 模式下点了循环按钮然后困惑为啥发不出去。
         * 想用别的本地模型 → 设置 → 端侧（本地）slot 改 model 名。
         */}
        <button
          onClick={cycleModel}
          disabled={chatModelMode === 'local'}
          className={`font-game text-[11px] px-2 py-0.5 border tracking-widest border-px-border ${
            chatModelMode === 'local'
              ? 'text-px-text-dim opacity-50 cursor-not-allowed'
              : 'text-px-text-sec hover:opacity-80'
          }`}
          title={
            chatModelMode === 'local'
              ? '端侧模式下，模型名由「设置 → 端侧（本地）slot」配置，循环按钮已禁用。要换本地模型请去设置。'
              : `当前模型：${currentModelLabel}（点击循环切换；"默认"使用分身 defaultModel 或 chat slot）`
          }
          aria-label="切换会话模型"
        >
          {chatModelMode === 'local' ? `🟢 ${localChatModel.model}` : currentModelLabel}
        </button>
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
        {/* v17 事件 viewer：查看会话 JSONL 事件流（调试用） */}
        <button
          onClick={() => setEventViewerOpen(true)}
          title="查看会话事件流（v17：记忆/模型/模式/子分身派发的事件日志）"
          className="font-game text-[11px] text-px-text-dim hover:text-px-primary px-2 py-0.5
            border border-transparent hover:border-px-primary/50 transition-none"
          aria-label="查看会话事件流"
        >
          ◊ 事件
        </button>
        {(['markdown', 'html'] as const).map((fmt) => (
          <button
            key={fmt}
            onClick={async () => {
              try {
                await window.electronAPI.exportConversation(conversationId, fmt)
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
            title={fmt === 'markdown' ? '导出对话为 Markdown' : '导出对话为单文件 HTML（可分享）'}
            className="font-game text-[11px] text-px-text-dim hover:text-px-primary px-2 py-0.5
              border border-transparent hover:border-px-primary/50 transition-none"
            aria-label={fmt === 'markdown' ? '导出对话为 Markdown' : '导出对话为 HTML'}
          >
            {fmt === 'markdown' ? '↓ MD' : '↓ HTML'}
          </button>
        ))}
      </div>

      {/* 消息列表 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <MessageList
          conversationId={conversationId}
          messages={messages}
          isLoading={isLoading || isRunningTests}
          elapsedSec={elapsedSec}
          onQuickQuestion={handleSendMessage}
          quickQuestions={messages.length === 0 ? QUICK_QUESTIONS : undefined}
          onSaveAnswer={handleSaveAnswer}
          avatarImage={avatarImage}
          avatarName={avatarName}
          avatarRole={avatarRole}
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

      {/*
        v19：原来 ChatWindow 底部全局唯一一份工具调用时间线，切对话 / 重启就丢。
        现在改成挂到每条 assistant 消息上（MessageBubble 内部用 ToolCallTimeline 渲染），
        通过 messages.tool_call_timeline_json 持久化。本处不再需要全局渲染。
      */}

      {/* 兜底：仅回归测试运行时显示。 */}
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
          avatarId={avatarId}
        />
      </div>

      {/* v17 事件 viewer：查看会话 JSONL 事件流 */}
      <EventViewer
        conversationId={conversationId}
        isOpen={eventViewerOpen}
        onClose={() => setEventViewerOpen(false)}
      />
    </div>
  )
}
