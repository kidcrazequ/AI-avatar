export interface HistoryMessageLike {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ApiMessageLike {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
  tool_calls?: unknown
  tool_call_id?: string
  name?: string
}

function estimateContentChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    return content.reduce((sum, item) => sum + estimateContentChars(item), 0)
  }
  if (content && typeof content === 'object') {
    const textValue = (content as { text?: unknown }).text
    if (typeof textValue === 'string') return textValue.length
    try {
      return JSON.stringify(content).length
    } catch {
      return String(content).length
    }
  }
  return String(content ?? '').length
}

function estimateMessagesChars(messages: ApiMessageLike[]): number {
  return messages.reduce((sum, message) => sum + estimateContentChars(message.content), 0)
}

export interface BuildApiMessagesOptions {
  stableSystemPrompt: string
  dynamicSystemPrompts?: string[]
  history: HistoryMessageLike[]
  userContent: unknown
  maxContextMessages?: number
  recentFullAssistantCount?: number
  assistantCompressThreshold?: number
  compressedAssistantChars?: number
  maxEstimatedChars?: number
  minHistoryMessages?: number
}

function compressHistoryMessages(
  history: HistoryMessageLike[],
  recentFullAssistantCount: number,
  assistantCompressThreshold: number,
  compressedAssistantChars: number,
): HistoryMessageLike[] {
  let assistantCount = 0
  const keepFullIndices = new Set<number>()

  for (let i = history.length - 1; i >= 0 && assistantCount < recentFullAssistantCount; i--) {
    if (history[i].role === 'assistant') {
      keepFullIndices.add(i)
      assistantCount++
    }
  }

  return history.map((message, index) => {
    if (
      message.role === 'assistant'
      && !keepFullIndices.has(index)
      && typeof message.content === 'string'
      && message.content.length > assistantCompressThreshold
    ) {
      return {
        ...message,
        content: message.content.slice(0, compressedAssistantChars) + '\n\n[... 早期回答已压缩]',
      }
    }
    return message
  })
}

export function buildApiMessages(options: BuildApiMessagesOptions): ApiMessageLike[] {
  const {
    stableSystemPrompt,
    dynamicSystemPrompts = [],
    history,
    userContent,
    maxContextMessages = 40,
    recentFullAssistantCount = 4,
    assistantCompressThreshold = 3000,
    compressedAssistantChars = 800,
    maxEstimatedChars = 55_000,
    minHistoryMessages = 8,
  } = options

  const recentMessages = history.length > maxContextMessages
    ? history.slice(-maxContextMessages)
    : history

  const compressedHistory = compressHistoryMessages(
    recentMessages,
    recentFullAssistantCount,
    assistantCompressThreshold,
    compressedAssistantChars,
  )

  const systemMessages: ApiMessageLike[] = [{ role: 'system', content: stableSystemPrompt }]
  for (const prompt of dynamicSystemPrompts) {
    if (prompt.trim().length > 0) {
      systemMessages.push({ role: 'system', content: prompt })
    }
  }

  const buildCandidateMessages = (historyMessages: HistoryMessageLike[]): ApiMessageLike[] => {
    const apiMessages: ApiMessageLike[] = [...systemMessages]
    for (const msg of historyMessages) {
      apiMessages.push({ role: msg.role, content: msg.content })
    }
    apiMessages.push({ role: 'user', content: userContent })
    return apiMessages
  }

  let retainedHistory = [...compressedHistory]
  let apiMessages = buildCandidateMessages(retainedHistory)

  while (retainedHistory.length > minHistoryMessages && estimateMessagesChars(apiMessages) > maxEstimatedChars) {
    retainedHistory = retainedHistory.slice(1)
    apiMessages = buildCandidateMessages(retainedHistory)
  }

  while (retainedHistory.length > 0 && estimateMessagesChars(apiMessages) > maxEstimatedChars) {
    retainedHistory = retainedHistory.slice(1)
    apiMessages = buildCandidateMessages(retainedHistory)
  }

  return apiMessages
}
