import { create } from 'zustand'
import { LLMService, LLMMessage, LLMTool, ToolCall, ModelConfig, DEFAULT_CHAT_MODEL } from '../services/llm-service'
import { MEMORY_CHAR_LIMIT, localDateString } from '@soul/core'

/** GAP2: 从 AI 回复中提取 memory 更新标记的正则 */
const MEMORY_UPDATE_REGEX = /\[MEMORY_UPDATE\]([\s\S]*?)\[\/MEMORY_UPDATE\]/g

/** Feature 3: 从 AI 回复中提取用户画像更新标记的正则 */
const USER_UPDATE_REGEX = /\[USER_UPDATE\]([\s\S]*?)\[\/USER_UPDATE\]/g

/** Feature 6: 从 AI 回复中提取技能创建建议的正则 */
const SKILL_CREATE_REGEX = /\[SKILL_CREATE\]([\s\S]*?)\[\/SKILL_CREATE\]/g

/** 从回复文本中提取并移除 memory 更新标记 */
function extractMemoryUpdates(text: string): { cleanText: string; updates: string[] } {
  const updates: string[] = []
  const cleanText = text.replace(MEMORY_UPDATE_REGEX, (_, content) => {
    updates.push(content.trim())
    return ''
  }).trim()
  return { cleanText, updates }
}

/** 从回复文本中提取并移除用户画像更新标记 */
function extractUserUpdates(text: string): { cleanText: string; updates: string[] } {
  const updates: string[] = []
  const cleanText = text.replace(USER_UPDATE_REGEX, (_, content) => {
    updates.push(content.trim())
    return ''
  }).trim()
  return { cleanText, updates }
}

/** 从回复文本中提取并移除技能创建建议，保留原文不删除（用于展示确认卡片） */
function extractSkillCreate(text: string): { cleanText: string; proposals: string[] } {
  const proposals: string[] = []
  const cleanText = text.replace(SKILL_CREATE_REGEX, (_, content) => {
    proposals.push(content.trim())
    return ''
  }).trim()
  return { cleanText, proposals }
}

/**
 * 启发式判断回答是否值得自动沉淀到 wiki/qa/。
 * 条件：长度 > 300、含来源引用、非错误消息。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
function shouldSediment(answer: string): boolean {
  if (answer.length < 300) return false
  if (answer.startsWith('抱歉，发生了错误')) return false
  const hasSource = /来源[：:]/.test(answer) || /\[来源/.test(answer) || /【参考/.test(answer)
  return hasSource
}

/** 使用时间戳+随机数生成唯一消息 ID，避免页面刷新后 ID 冲突 */
export function nextMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export interface ChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatStore {
  messages: ChatMessage[]
  isLoading: boolean
  systemPrompt: string
  chatModel: ModelConfig
  /** GAP8: 当前正在执行的工具名称，用于 UI 可视化 */
  toolCallStatus: string
  /** Feature 6: 待确认的技能创建建议 */
  skillProposals: string[]
  /**
   * 已折叠的助手消息 id 集合。
   * 放在 store 中是因为 react-virtuoso 会把滚出视窗的 MessageBubble 卸载，
   * 组件级 useState 会丢失；store 的状态跨组件卸载/HMR 持久。
   */
  collapsedMessageIds: Set<string>

  setSystemPrompt: (prompt: string) => void
  setChatModel: (config: ModelConfig) => void
  setMessages: (messages: ChatMessage[]) => void
  sendMessage: (content: string, conversationId: string, avatarId: string, images?: string[], visionModel?: ModelConfig) => Promise<void>
  clearMessages: () => void
  resetTransientState: () => void
  /** Feature 6: 清除技能创建建议 */
  clearSkillProposals: () => void
  /** 切换某条消息的折叠状态 */
  toggleMessageCollapsed: (id: string) => void
}

/**
 * GAP4: 工具定义（JSON Schema），传给 LLM 供 function calling 使用。
 * 每个工具对应 tool-router.ts 中的一个实现。
 */
const AVATAR_TOOLS: LLMTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: '在分身的知识库中全文检索相关内容片段。当需要查询产品参数、政策文件、案例等详细信息时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词或问题描述' },
          top_n: { type: 'number', description: '返回结果数量，默认 5', default: 5 },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_knowledge_file',
      description: '读取知识库中特定文件的完整内容。需要先通过 search_knowledge 或 list_knowledge_files 获取文件路径。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件相对路径，如 products/battery-500kwh.md' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_knowledge_files',
      description: '列出知识库中所有可用文件的路径列表，用于了解有哪些知识文件可以读取。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_excel',
      description: '精确查询已导入的 Excel / CSV 数据源。**Excel 数据必须用此工具，禁止用 search_knowledge**。⚠️ 严格规则：必须用 filter 把结果缩小到几行到几十行，禁止 dump 整张表（会撞破 LLM context 上限）。如果不确定数据格式，先用一个小 filter 试探（如 limit:5），看清字段后再做完整查询。一次返回硬上限：200 行 / 8000 字符，超过会被截断且 truncated_by_size=true。',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Excel 文件 basename（不含后缀），见 system prompt 的"可查询 Excel 数据源"列表',
          },
          sheet: {
            type: 'string',
            description: 'sheet 名，从 system prompt 的 schema 摘要里挑',
          },
          filter: {
            type: 'object',
            description: '【强烈建议】MongoDB 风格过滤。示例: {"机型":"215","月份":{"$gte":"2026-01","$lte":"2026-03"}}。支持 $eq(默认)/$ne/$gt/$gte/$lt/$lte/$in。不传 filter 又不传 columns 又不传 limit 会被工具拒绝执行（防止 dump 全表）。',
          },
          columns: {
            type: 'array',
            items: { type: 'string' },
            description: '只返回指定列（强烈推荐：把要画图的 X 轴 + Y 轴列名列出来，避免拉无关字段）',
          },
          limit: {
            type: 'number',
            description: '最多返回行数，默认 50，硬上限 200。画图通常 12-30 行就够了。',
            default: 50,
          },
        },
        required: ['file', 'sheet'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_roi',
      description: '计算工商业储能项目的收益和投资回报率（ROI/IRR）。根据储能容量、电价、循环次数等参数逐年测算。',
      parameters: {
        type: 'object',
        properties: {
          capacity_kwh: { type: 'number', description: '储能系统总容量（kWh）' },
          power_kw: { type: 'number', description: '充放电功率（kW）' },
          peak_price: { type: 'number', description: '峰时电价（元/kWh）' },
          valley_price: { type: 'number', description: '谷时电价（元/kWh）' },
          daily_cycles: { type: 'number', description: '每日充放电循环次数，默认 1', default: 1 },
          dod: { type: 'number', description: '放电深度（0-1），默认 0.9', default: 0.9 },
          efficiency: { type: 'number', description: '系统往返效率（0-1），默认 0.9', default: 0.9 },
          annual_degradation: { type: 'number', description: '年容量衰减率（0-1），默认 0.03', default: 0.03 },
          project_life_years: { type: 'number', description: '项目寿命（年），默认 10', default: 10 },
          investment_per_kwh: { type: 'number', description: '单位容量投资成本（元/kWh），默认 1800', default: 1800 },
          demand_charge_saving: { type: 'number', description: '需量管理每年节省费用（元），默认 0', default: 0 },
          annual_opex: { type: 'number', description: '年运维费用（元），默认 0', default: 0 },
        },
        required: ['capacity_kwh', 'power_kw', 'peak_price', 'valley_price'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_policy',
      description: '查询指定省份的工商业储能相关政策、电价或补贴信息。',
      parameters: {
        type: 'object',
        properties: {
          province: { type: 'string', description: '省份名称，如"浙江"、"广东"、"江苏"' },
          policy_type: { type: 'string', description: '政策类型，如"电价"、"补贴"、"峰谷电价"', default: '电价' },
        },
        required: ['province'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_products',
      description: '对比多款储能产品的技术参数、价格、特点等。',
      parameters: {
        type: 'object',
        properties: {
          products: {
            type: 'array',
            items: { type: 'string' },
            description: '产品名称列表，如 ["500kWh柜机", "1MWh集装箱"]',
          },
        },
        required: ['products'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: '加载指定技能的完整定义内容。当需要执行某项技能时，先调用此工具获取完整的技能步骤和规则。',
      parameters: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: '技能 ID（对应 skills/ 目录下的文件名，不含 .md）' },
        },
        required: ['skill_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delegate_task',
      description: '将子任务委派给独立的子代理并行执行。子代理使用相同的知识库，但独立的对话上下文。用于需要并行处理多个独立子任务时。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '子任务的详细描述，需要子代理独立完成' },
        },
        required: ['task'],
      },
    },
  },
]

/** 周期性记忆 Nudge 提示文本 */
const MEMORY_NUDGE_TEXT = `[系统提示] 请回顾本次对话，如果有以下信息值得长期记住，请在回复末尾用 [MEMORY_UPDATE]...[/MEMORY_UPDATE] 标签记录：
1. 用户纠正过的错误理解
2. 用户明确表达的偏好
3. 项目相关的关键决策
如果没有需要记忆的内容，不需要添加标签，正常回答即可。`

/**
 * 最大工具调用循环轮数，防止无限循环。
 *
 * 典型场景的轮数预算（v0.5.x 后）：
 *   - load_skill('chart-from-knowledge') ─┐
 *   - load_skill('draw-chart')            ├─ 渐进披露技能加载 1-2 轮
 *   - query_excel(...) 第一次              ├─ 数据查询 1 轮
 *   - query_excel(...) 修正参数            ├─ 容错 1-2 轮
 *   - 最终带 ```chart 代码块的回答         ┘
 *
 * 5 轮太紧（v0.5.0 默认值）→ 用户看到 "工具调用轮数达到上限" 没有图表。
 * 10 轮给容错和探索留余量，同时仍能兜底防止真正的死循环。
 */
const MAX_TOOL_ROUNDS = 10
/** 上下文窗口最大消息条数，超出时截取最近的消息 */
const MAX_CONTEXT_MESSAGES = 40
/** 单轮 LLM 调用超时（3 分钟），防止流式响应挂死永久阻塞 */
const ROUND_TIMEOUT_MS = 180_000

/**
 * 工具结果压缩阈值（字符数）。
 * 当一轮工具调用完成后、进入下一轮 LLM 调用前，
 * 将 apiMessages 中超过此阈值的旧 tool 结果截断为摘要，
 * 防止 query_excel 等工具的大 JSON 累积撑爆 context。
 */
const TOOL_RESULT_COMPRESS_THRESHOLD = 2000

/**
 * 压缩 apiMessages 中已完成轮次的 tool 结果。
 * 只保留最近一轮的 tool 结果原文，更早的 tool 结果截断为摘要。
 * 这样 LLM 仍能看到最新数据，但不会被历史工具返回值撑爆 context。
 */
function compressOldToolResults(messages: LLMMessage[]): void {
  // 找到最后一个 assistant 消息的位置（即最近一轮工具调用的起点）
  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }
  if (lastAssistantIdx <= 0) return

  // 压缩 lastAssistantIdx 之前的所有 tool 结果
  for (let i = 0; i < lastAssistantIdx; i++) {
    const msg = messages[i]
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > TOOL_RESULT_COMPRESS_THRESHOLD) {
      // 保留前 500 字符作为摘要 + 截断提示
      messages[i] = {
        ...msg,
        content: msg.content.slice(0, 500) + `\n\n[... 已压缩，原文 ${msg.content.length} 字符。如需完整数据请重新调用工具查询]`,
      }
    }
  }
}

let activeChatRequest: { id: number; conversationId: string } | null = null
let chatRequestSeq = 0
let pendingChunkUpdate: number | null = null
let activeAbortController: AbortController | null = null

/** 更新或追加最后一条 assistant 消息（消除 4 处重复代码） */
function upsertLastAssistant(
  messages: ChatMessage[],
  id: string,
  content: string,
): ChatMessage[] {
  const withoutLast = messages.at(-1)?.role === 'assistant'
    ? messages.slice(0, -1)
    : messages
  return [...withoutLast, { id, role: 'assistant', content }]
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  isLoading: false,
  systemPrompt: '',
  chatModel: DEFAULT_CHAT_MODEL,
  toolCallStatus: '',
  skillProposals: [],
  collapsedMessageIds: new Set<string>(),

  setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),

  setChatModel: (config) => set({ chatModel: config }),

  setMessages: (messages) => set({ messages }),

  clearSkillProposals: () => set({ skillProposals: [] }),

  toggleMessageCollapsed: (id) => set((state) => {
    const next = new Set(state.collapsedMessageIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { collapsedMessageIds: next }
  }),

  resetTransientState: () => {
    activeChatRequest = null
    if (activeAbortController) {
      activeAbortController.abort()
      activeAbortController = null
    }
    set({ isLoading: false, toolCallStatus: '', skillProposals: [] })
  },

  sendMessage: async (content: string, conversationId: string, avatarId: string, images?: string[], visionModel?: ModelConfig) => {
    if (get().isLoading) return
    set({ isLoading: true })
    const requestId = ++chatRequestSeq
    activeChatRequest = { id: requestId, conversationId }
    if (activeAbortController) activeAbortController.abort()
    const abortController = new AbortController()
    activeAbortController = abortController
    const isStale = () =>
      !activeChatRequest
      || activeChatRequest.id !== requestId
      || activeChatRequest.conversationId !== conversationId

    const { messages, systemPrompt, chatModel } = get()

    // GAP9b: 有图片时使用视觉模型
    const activeModel = (images && images.length > 0 && visionModel?.apiKey) ? visionModel : chatModel

    if (!activeModel.apiKey) {
      const errorMsg = '请先在设置中配置 API Key'
      set({
        messages: [...messages, { id: nextMessageId(), role: 'user', content }, { id: nextMessageId(), role: 'assistant', content: errorMsg }],
        isLoading: false,
      })
      await window.electronAPI.saveMessage(conversationId, 'user', content)
      await window.electronAPI.saveMessage(conversationId, 'assistant', errorMsg)
      return
    }

    // 多分身 @提及：检测 @分身ID，并发拉取所有目标分身 soul.md 前缀，追加到 system prompt
    let effectiveSystemPrompt = systemPrompt
    const atMentions = [...new Set([...content.matchAll(/@([\w-]+)/g)].map(m => m[1]).filter(id => id !== avatarId))]
    if (atMentions.length > 0) {
      const introResults = await Promise.allSettled(
        atMentions.map(id => window.electronAPI.getAvatarSoulIntro(id).then(intro => ({ id, intro })))
      )
      const intros = introResults
        .filter(r => r.status === 'fulfilled' && r.value.intro)
        .map(r => {
          const { id, intro } = (r as PromiseFulfilledResult<{ id: string; intro: string | null }>).value
          return `[协作分身 @${id} 的身份简介]\n${intro}`
        })
      if (intros.length > 0) {
        effectiveSystemPrompt = `${systemPrompt}\n\n---\n${intros.join('\n\n')}\n---`
      }
    }

    const userMessage: ChatMessage = { id: nextMessageId(), role: 'user', content }
    set({ messages: [...messages, userMessage] })
    try {
      await window.electronAPI.saveMessage(conversationId, 'user', content, undefined, images)
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('error', 'save-user-message-error', errMsg)
      set((state) => ({
        messages: [...state.messages, { id: nextMessageId(), role: 'assistant', content: `抱歉，保存消息失败：${errMsg}` }],
        isLoading: false,
        toolCallStatus: '',
      }))
      return
    }

    // 程序化 RAG：纯文字消息且长度足够时，通过多跳检索 + 5 规则增强 user 消息
    // 短消息（<4字符）如"好的""谢谢"等不含实质查询意图，跳过 RAG 避免浪费 API 调用
    const MIN_RAG_QUERY_LENGTH = 4
    let enhancedContent = content
    if (!images || images.length === 0) {
      if (content.trim().length >= MIN_RAG_QUERY_LENGTH) {
        try {
          const [rawRagKey, rawRagUrl] = await Promise.all([
            window.electronAPI.getSetting('ocr_api_key'),
            window.electronAPI.getSetting('ocr_base_url'),
          ])
          const ragApiKey = rawRagKey || chatModel.apiKey
          const ragBaseUrl = rawRagUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
          if (ragApiKey) {
            enhancedContent = await window.electronAPI.ragRetrieve(avatarId, content, ragApiKey, ragBaseUrl)
          }
        } catch (err) {
          const ragErr = err instanceof Error ? err.message : String(err)
          console.warn('RAG 检索失败，使用原始消息:', ragErr)
          window.electronAPI.logEvent('warn', 'rag-retrieve-error', ragErr)
        }
      }
    }

    // 构建用户消息内容（纯文字 or 多模态）
    const userContent: LLMMessage['content'] = (images && images.length > 0)
      ? [
          ...images.map(url => ({ type: 'image_url' as const, image_url: { url } })),
          { type: 'text' as const, text: content || '请描述图片内容' },
        ]
      : enhancedContent

    // Feature 2: 周期性记忆 Nudge（每 N 轮提醒 AI 是否有内容需要记忆）
    // 合并到 user 内容末尾，避免在 user 消息后插入 system 消息导致 API 兼容性问题
    let nudgedUserContent: LLMMessage['content'] = userContent
    try {
      const nudgeIntervalStr = await window.electronAPI.getSetting('memory_nudge_interval')
      const nudgeInterval = nudgeIntervalStr ? parseInt(nudgeIntervalStr, 10) : 5
      if (!isNaN(nudgeInterval) && nudgeInterval > 0) {
        const userRounds = messages.filter(m => m.role === 'user').length + 1
        if (userRounds > 0 && userRounds % nudgeInterval === 0) {
          // 仅文字消息时拼接，多模态消息不附加（视觉模型一般不处理记忆提醒）
          if (typeof nudgedUserContent === 'string') {
            nudgedUserContent = nudgedUserContent + '\n\n' + MEMORY_NUDGE_TEXT
          }
        }
      }
    } catch (nudgeErr) {
      // Nudge 失败不影响正常对话
      void nudgeErr
    }

    // 构建 API 消息列表（包含 system prompt），截取最近消息避免 token 超限
    const recentMessages = messages.length > MAX_CONTEXT_MESSAGES
      ? messages.slice(-MAX_CONTEXT_MESSAGES)
      : messages

    // 跨轮次 context 压缩：只保留最近 4 条 assistant 消息完整内容，
    // 更早的超长回答截断为摘要。从末尾往前数，确保最近的不被截断。
    const RECENT_FULL_ASSISTANT_COUNT = 4
    const ASSISTANT_COMPRESS_THRESHOLD = 3000
    let assistantCount = 0
    // 先从末尾数出最近 N 条 assistant 的索引
    const keepFullIndices = new Set<number>()
    for (let i = recentMessages.length - 1; i >= 0 && assistantCount < RECENT_FULL_ASSISTANT_COUNT; i--) {
      if (recentMessages[i].role === 'assistant') {
        keepFullIndices.add(i)
        assistantCount++
      }
    }
    const compressedRecentMessages = recentMessages.map((m, i) => {
      if (m.role === 'assistant' && !keepFullIndices.has(i) && typeof m.content === 'string' && m.content.length > ASSISTANT_COMPRESS_THRESHOLD) {
        return { ...m, content: m.content.slice(0, 800) + '\n\n[... 早期回答已压缩]' }
      }
      return m
    })

    const apiMessages: LLMMessage[] = [
      { role: 'system', content: effectiveSystemPrompt },
      ...compressedRecentMessages.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: nudgedUserContent },
    ]

    const llm = new LLMService(activeModel)

    // 有图片时不传工具（视觉模型可能不支持），无图片时传完整工具列表
    const tools = (images && images.length > 0) ? [] : AVATAR_TOOLS

    /**
     * GAP4: 工具调用循环
     * 每轮：调用 LLM → 如有 tool_calls 则执行并追加结果 → 再次调用 → 直至无工具调用或达到上限
     */
    let round = 0
    let assistantText = ''
    let pendingToolCalls: ToolCall[] | undefined
    const assistantMsgId = nextMessageId()

    /** 取消残留的 rAF，防止跨对话消息污染 */
    const cancelPendingChunk = () => {
      if (pendingChunkUpdate !== null) {
        cancelAnimationFrame(pendingChunkUpdate)
        pendingChunkUpdate = null
      }
    }

    const runRound = (): Promise<void> =>
      new Promise((resolve, reject) => {
        assistantText = ''

        llm.chat(
          apiMessages,
          (chunk) => {
            if (isStale()) return
            assistantText += chunk
            // 工具调用中间轮次（round > 0）不实时显示文字给用户，
            // 避免 LLM 在中间轮输出半成品分析后最终轮又重复一遍。
            // 只在第一轮（用户刚发消息）和最终轮（下面 resolve 后判断无 tool_calls 再刷新）时显示。
            if (round === 0 && pendingChunkUpdate === null) {
              pendingChunkUpdate = requestAnimationFrame(() => {
                pendingChunkUpdate = null
                if (isStale()) return
                const text = assistantText
                set((state) => ({
                  messages: upsertLastAssistant(state.messages, assistantMsgId, text),
                }))
              })
            }
          },
          (_fullText, toolCalls) => {
            cancelPendingChunk()
            if (isStale()) {
              pendingToolCalls = undefined
              resolve()
              return
            }
            pendingToolCalls = toolCalls
            // 本轮没有 tool_calls → 最终轮，立即刷新显示最终文字
            if (!toolCalls || toolCalls.length === 0) {
              const text = assistantText
              set((state) => ({
                messages: upsertLastAssistant(state.messages, assistantMsgId, text),
              }))
            }
            resolve()
          },
          (error) => {
            cancelPendingChunk()
            reject(error)
          },
          { tools: tools.length > 0 ? tools : undefined, signal: abortController.signal }
        )
      })

    /** 带超时的 runRound，防止 LLM 流式响应挂死 */
    const runRoundWithTimeout = () => Promise.race([
      runRound(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('LLM 响应超时，请重试')), ROUND_TIMEOUT_MS)
      ),
    ])

    try {
      await runRoundWithTimeout()
      if (isStale()) return

      while (pendingToolCalls && pendingToolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
        if (isStale()) return
        round++

        // 将 LLM 的工具调用请求追加到消息历史（保留 LLM 在工具调用前生成的文本）
        apiMessages.push({
          role: 'assistant',
          content: assistantText,
          tool_calls: pendingToolCalls,
        })

        // 执行所有工具调用
        for (const tc of pendingToolCalls) {
          if (isStale()) return
          // GAP8: 更新工具调用状态，供 UI 显示
          set({ toolCallStatus: tc.function.name })

          let toolArgs: Record<string, unknown> = {}
          try {
            toolArgs = JSON.parse(tc.function.arguments || '{}')
          } catch (parseErr) {
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr)
            console.warn(`[chatStore] 工具参数 JSON 解析失败 (${tc.function.name}):`, msg)
            window.electronAPI.logEvent('warn', 'tool-args-parse-error', `${tc.function.name}: ${msg}`)
          }

          let resultText = ''
          try {
            const result = await window.electronAPI.executeToolCall(avatarId, tc.function.name, toolArgs)
            if (isStale()) return
            resultText = result.error
              ? `工具执行失败: ${result.error}`
              : result.content
          } catch (toolErr) {
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr)
            resultText = `工具执行失败: ${msg}`
          }

          // 将工具结果追加到消息历史
          apiMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: resultText,
          })

          // 保存工具结果到数据库
          try {
            await window.electronAPI.saveMessage(conversationId, 'tool', resultText, tc.id)
          } catch (saveErr) {
            const msg = saveErr instanceof Error ? saveErr.message : String(saveErr)
            window.electronAPI.logEvent('warn', 'save-tool-message-failed', msg)
          }
          if (isStale()) return
        }
        set({ toolCallStatus: '' })

        // 压缩更早轮次的 tool 结果，防止累积撑爆 context
        compressOldToolResults(apiMessages)

        // 继续下一轮对话
        await runRoundWithTimeout()
        if (isStale()) return
      }

      if (pendingToolCalls && pendingToolCalls.length > 0 && round >= MAX_TOOL_ROUNDS) {
        assistantText = `${assistantText}\n\n[系统提示] 工具调用轮数达到上限，已提前结束本轮。`
        pendingToolCalls = undefined
      }

      // 所有工具调用结束，处理最终回复
      const { cleanText: memCleanText, updates: memUpdates } = extractMemoryUpdates(assistantText)
      const { cleanText: userCleanText, updates: userUpdates } = extractUserUpdates(memCleanText)
      const { cleanText, proposals: skillProposals } = extractSkillCreate(userCleanText)
      const hasUpdates = memUpdates.length > 0 || userUpdates.length > 0 || skillProposals.length > 0
      const displayText = cleanText || assistantText || (hasUpdates ? '（已更新记忆/画像/技能）' : '')

      // GAP2: 如果有 memory 更新，追加写入记忆文件（含容量管理）
      if (memUpdates.length > 0) {
        try {
          const currentMemory = await window.electronAPI.readMemory(avatarId)
          const timestamp = localDateString()
          const newEntries = memUpdates.map(u => `\n<!-- ${timestamp} -->\n${u}`).join('\n')
          const merged = currentMemory + newEntries

          // 容量管理：超过上限时先备份再调用 LLM 整理
          let finalContent = merged
          if (merged.length >= MEMORY_CHAR_LIMIT) {
            try {
              // 备份当前记忆，防止 LLM 整理结果异常导致数据丢失
              await window.electronAPI.writeMemory(avatarId, merged)
              const [apiKey, baseUrl] = await Promise.all([
                window.electronAPI.getSetting('chat_api_key').then(v => v ?? ''),
                window.electronAPI.getSetting('chat_base_url').then(v => v ?? ''),
              ])
              const consolidated = await window.electronAPI.consolidateMemory(avatarId, merged, apiKey, baseUrl)
              if (consolidated && consolidated.length > 50) {
                finalContent = consolidated
              } else {
                window.electronAPI.logEvent('warn', 'memory-consolidate-too-short', `整理结果过短(${consolidated?.length ?? 0}字)，保留原内容`)
              }
            } catch (consolidateErr) {
              const msg = consolidateErr instanceof Error ? consolidateErr.message : String(consolidateErr)
              console.error('记忆整理失败，保留已备份的原内容:', msg)
              window.electronAPI.logEvent('error', 'memory-consolidate-error', msg)
            }
          }
          await window.electronAPI.writeMemory(avatarId, finalContent)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('写入记忆失败:', msg)
          window.electronAPI.logEvent('error', 'memory-write-error', msg)
        }
      }

      // Feature 3: 如果有用户画像更新，追加写入 USER.md（带容量检查）
      if (userUpdates.length > 0) {
        try {
          const currentProfile = await window.electronAPI.readUserProfile(avatarId)
          const timestamp = localDateString()
          const newEntries = userUpdates.map(u => `\n<!-- ${timestamp} -->\n${u}`).join('\n')
          const mergedProfile = currentProfile + newEntries

          // USER.md 容量检查：超过上限时先整理再写入
          let finalProfile = mergedProfile
          if (mergedProfile.length >= MEMORY_CHAR_LIMIT) {
            try {
              const [apiKey, baseUrl] = await Promise.all([
                window.electronAPI.getSetting('chat_api_key').then(v => v ?? ''),
                window.electronAPI.getSetting('chat_base_url').then(v => v ?? ''),
              ])
              finalProfile = await window.electronAPI.consolidateMemory(avatarId, mergedProfile, apiKey, baseUrl)
            } catch (consolidateErr) {
              const msg = consolidateErr instanceof Error ? consolidateErr.message : String(consolidateErr)
              window.electronAPI.logEvent('warn', 'profile-consolidate-failed', msg)
            }
          }
          await window.electronAPI.writeUserProfile(avatarId, finalProfile)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('写入用户画像失败:', msg)
          window.electronAPI.logEvent('error', 'user-profile-write-error', msg)
        }
      }

      // Phase 2: 自动沉淀优质回答到 wiki/qa/（启发式判断，设置开关控制）
      try {
        const autoSediment = await window.electronAPI.getSetting('wiki_auto_sediment')
        if (autoSediment === 'true' && shouldSediment(displayText)) {
          await window.electronAPI.saveWikiAnswer(avatarId, {
            id: `qa-${Date.now()}`,
            question: content,
            answer: displayText,
            sources: [],
            savedAt: localDateString(),
          })
        }
      } catch (saveErr) {
        // 自动沉淀失败不影响正常对话
        void saveErr
      }

      if (isStale()) return
      set((state) => ({
        messages: upsertLastAssistant(state.messages, assistantMsgId, displayText),
        isLoading: false,
        toolCallStatus: '',
        skillProposals,
      }))

      if (isStale()) return
      try {
        await window.electronAPI.saveMessage(conversationId, 'assistant', displayText)
      } catch (saveErr) {
        const msg = saveErr instanceof Error ? saveErr.message : String(saveErr)
        console.error('[chatStore] 保存助手消息失败:', msg)
        window.electronAPI.logEvent('error', 'save-assistant-message-error', msg)
      }
      if (!isStale()) activeChatRequest = null
    } catch (error) {
      if (isStale()) return
      const errMsg = error instanceof Error ? error.message : String(error)
      console.error('对话失败:', errMsg)
      window.electronAPI.logEvent('error', 'chat-error', errMsg)
      const errorMessage = `抱歉，发生了错误：${errMsg}`
      set((state) => ({
        messages: upsertLastAssistant(state.messages, nextMessageId(), errorMessage),
        isLoading: false,
        toolCallStatus: '',
      }))
      try {
        await window.electronAPI.saveMessage(conversationId, 'assistant', errorMessage)
      } catch (saveErr) {
        console.error('[chatStore] 保存错误消息失败:', saveErr instanceof Error ? saveErr.message : String(saveErr))
      }
      if (!isStale()) activeChatRequest = null
    } finally {
      // 仅在本请求仍是当前活跃请求时重置 isLoading，避免误清另一个请求的状态
      if (activeChatRequest?.id === requestId && get().isLoading) {
        set({ isLoading: false, toolCallStatus: '' })
      }
    }
  },

  clearMessages: () => set({ messages: [], skillProposals: [], toolCallStatus: '', isLoading: false }),
}))
