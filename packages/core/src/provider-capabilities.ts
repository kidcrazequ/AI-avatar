export type ProviderName = 'dashscope' | 'deepseek' | 'openai' | 'ollama' | 'generic-openai'

export interface ProviderCapabilities {
  provider: ProviderName
  supportsMultipleSystemMessages: boolean
  supportsSeed: boolean
}

export interface BasicChatMessageLike {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
  tool_calls?: unknown
  tool_call_id?: string
  name?: string
}

function safeHostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return baseUrl.toLowerCase()
  }
}

export function detectProvider(baseUrl: string, model = ''): ProviderName {
  const host = safeHostname(baseUrl)
  const lowerModel = model.toLowerCase()

  if (host.includes('dashscope.aliyuncs.com') || lowerModel.startsWith('qwen')) return 'dashscope'
  if (host.includes('deepseek.com') || lowerModel.startsWith('deepseek')) return 'deepseek'
  if (host.includes('api.openai.com') || lowerModel.startsWith('gpt-')) return 'openai'
  if (host.includes('ollama')) return 'ollama'
  return 'generic-openai'
}

export function getProviderCapabilities(baseUrl: string, model = ''): ProviderCapabilities {
  const provider = detectProvider(baseUrl, model)

  switch (provider) {
    case 'dashscope':
      return {
        provider,
        supportsMultipleSystemMessages: false,
        supportsSeed: true,
      }
    case 'deepseek':
      return {
        provider,
        supportsMultipleSystemMessages: true,
        supportsSeed: true,
      }
    case 'openai':
      return {
        provider,
        supportsMultipleSystemMessages: true,
        supportsSeed: true,
      }
    case 'ollama':
      return {
        provider,
        supportsMultipleSystemMessages: true,
        supportsSeed: true,
      }
    default:
      return {
        provider,
        supportsMultipleSystemMessages: true,
        supportsSeed: true,
      }
  }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item) => contentToText(item)).filter(Boolean).join('\n')
  }
  if (content && typeof content === 'object') {
    const textValue = (content as { text?: unknown }).text
    if (typeof textValue === 'string') return textValue
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return String(content ?? '')
}

/**
 * 对只接受首条 system message 的 OpenAI 兼容供应商，把多条 system 合并成一条。
 * 这样仍能保持 stable prompt 在前、dynamic prompt 在后的顺序，同时避免后续 system 被忽略。
 */
export function normalizeMessagesForProvider<T extends BasicChatMessageLike>(
  messages: T[],
  capabilities: ProviderCapabilities,
): T[] {
  if (capabilities.supportsMultipleSystemMessages) return messages

  const systemMessages = messages.filter((message) => message.role === 'system')
  if (systemMessages.length <= 1) return messages

  const merged = systemMessages.map((message) => contentToText(message.content).trim()).filter(Boolean).join('\n\n---\n\n')
  const firstSystem = systemMessages[0]
  const normalized: T[] = [
    {
      ...firstSystem,
      content: merged,
    },
  ]

  for (const message of messages) {
    if (message.role === 'system') continue
    normalized.push(message)
  }

  return normalized
}
