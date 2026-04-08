import { create } from 'zustand'
import { LLMService, LLMMessage, LLMTool, ToolCall, ModelConfig, DEFAULT_CHAT_MODEL } from '../services/llm-service'

/** GAP2: 从 AI 回复中提取 memory 更新标记的正则 */
const MEMORY_UPDATE_REGEX = /\[MEMORY_UPDATE\]([\s\S]*?)\[\/MEMORY_UPDATE\]/g

/** 从回复文本中提取并移除 memory 更新标记 */
function extractMemoryUpdates(text: string): { cleanText: string; updates: string[] } {
  const updates: string[] = []
  const cleanText = text.replace(MEMORY_UPDATE_REGEX, (_, content) => {
    updates.push(content.trim())
    return ''
  }).trim()
  return { cleanText, updates }
}

export interface ChatMessage {
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

  setSystemPrompt: (prompt: string) => void
  setChatModel: (config: ModelConfig) => void
  setMessages: (messages: ChatMessage[]) => void
  sendMessage: (content: string, conversationId: string, avatarId: string, images?: string[], visionModel?: ModelConfig) => Promise<void>
  clearMessages: () => void
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
]

/** 最大工具调用循环轮数，防止无限循环 */
const MAX_TOOL_ROUNDS = 5

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  isLoading: false,
  systemPrompt: '',
  chatModel: DEFAULT_CHAT_MODEL,
  toolCallStatus: '',

  setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),

  setChatModel: (config) => set({ chatModel: config }),

  setMessages: (messages) => set({ messages }),

  sendMessage: async (content: string, conversationId: string, avatarId: string, images?: string[], visionModel?: ModelConfig) => {
    const { messages, systemPrompt, chatModel } = get()

    // GAP9b: 有图片时使用视觉模型
    const activeModel = (images && images.length > 0 && visionModel?.apiKey) ? visionModel : chatModel

    if (!activeModel.apiKey) {
      const errorMsg = '请先在设置中配置 API Key'
      set({
        messages: [...messages, { role: 'user', content }, { role: 'assistant', content: errorMsg }],
      })
      await window.electronAPI.saveMessage(conversationId, 'user', content)
      await window.electronAPI.saveMessage(conversationId, 'assistant', errorMsg)
      return
    }

    const userMessage: ChatMessage = { role: 'user', content }
    set({ messages: [...messages, userMessage], isLoading: true })
    await window.electronAPI.saveMessage(conversationId, 'user', content, undefined, images)

    // 程序化 RAG：纯文字消息时，通过多跳检索 + 5 规则增强 user 消息
    let enhancedContent = content
    if (!images || images.length === 0) {
      try {
        const ragApiKey = await window.electronAPI.getSetting('ocr_api_key') || chatModel.apiKey
        const ragBaseUrl = await window.electronAPI.getSetting('ocr_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        if (ragApiKey) {
          enhancedContent = await window.electronAPI.ragRetrieve(avatarId, content, ragApiKey, ragBaseUrl)
        }
      } catch (err) {
        console.warn('RAG 检索失败，使用原始消息:', err)
      }
    }

    // 构建用户消息内容（纯文字 or 多模态）
    const userContent: LLMMessage['content'] = (images && images.length > 0)
      ? [
          ...images.map(url => ({ type: 'image_url' as const, image_url: { url } })),
          { type: 'text' as const, text: content || '请描述图片内容' },
        ]
      : enhancedContent

    // 构建 API 消息列表（包含 system prompt）
    const apiMessages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userContent },
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

    const runRound = (): Promise<void> =>
      new Promise((resolve, reject) => {
        assistantText = ''

        llm.chat(
          apiMessages,
          // onChunk: 流式更新界面
          (chunk) => {
            assistantText += chunk
            set((state) => {
              const withoutLast = state.messages.at(-1)?.role === 'assistant'
                ? state.messages.slice(0, -1)
                : state.messages
              return {
                messages: [...withoutLast, { role: 'assistant', content: assistantText }],
              }
            })
          },
          // onDone
          (_fullText, toolCalls) => {
            pendingToolCalls = toolCalls
            resolve()
          },
          // onError
          (error) => reject(error),
          { tools: tools.length > 0 ? tools : undefined }
        )
      })

    try {
      await runRound()

      while (pendingToolCalls && pendingToolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
        round++

        // 将 LLM 的工具调用请求追加到消息历史
        apiMessages.push({
          role: 'assistant',
          content: '',
          tool_calls: pendingToolCalls,
        })

        // 执行所有工具调用
        for (const tc of pendingToolCalls) {
          // GAP8: 更新工具调用状态，供 UI 显示
          set({ toolCallStatus: tc.function.name })

          let toolArgs: Record<string, unknown> = {}
          try {
            toolArgs = JSON.parse(tc.function.arguments || '{}')
          } catch {
            // 忽略解析错误
          }

          const result = await window.electronAPI.executeToolCall(avatarId, tc.function.name, toolArgs)
          const resultText = result.error
            ? `工具执行失败: ${result.error}`
            : result.content

          // 将工具结果追加到消息历史
          apiMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: resultText,
          })

          // 保存工具结果到数据库
          await window.electronAPI.saveMessage(conversationId, 'tool', resultText, tc.id)
        }
        set({ toolCallStatus: '' })

        // 继续下一轮对话
        await runRound()
      }

      // 所有工具调用结束，处理最终回复
      const { cleanText, updates } = extractMemoryUpdates(assistantText)
      const displayText = cleanText || assistantText

      // GAP2: 如果有 memory 更新，追加写入记忆文件
      if (updates.length > 0) {
        try {
          const currentMemory = await window.electronAPI.readMemory(avatarId)
          const timestamp = new Date().toLocaleDateString('zh-CN')
          const newEntries = updates.map(u => `\n<!-- ${timestamp} -->\n${u}`).join('\n')
          await window.electronAPI.writeMemory(avatarId, currentMemory + newEntries)
        } catch (err) {
          console.error('写入记忆失败:', err)
        }
      }

      set((state) => {
        const withoutLast = state.messages.at(-1)?.role === 'assistant'
          ? state.messages.slice(0, -1)
          : state.messages
        return {
          messages: [...withoutLast, { role: 'assistant', content: displayText }],
          isLoading: false,
          toolCallStatus: '',
        }
      })

      await window.electronAPI.saveMessage(conversationId, 'assistant', displayText)
    } catch (error) {
      console.error('对话失败:', error)
      const errorMessage = `抱歉，发生了错误：${(error as Error).message}`
      set({
        messages: [
          ...get().messages,
          { role: 'assistant', content: errorMessage },
        ],
        isLoading: false,
        toolCallStatus: '',
      })
      await window.electronAPI.saveMessage(conversationId, 'assistant', errorMessage)
    }
  },

  clearMessages: () => set({ messages: [] }),
}))
