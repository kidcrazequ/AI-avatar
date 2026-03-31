import { createParser } from 'eventsource-parser'

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class DeepSeekService {
  private apiKey: string
  private baseURL = 'https://api.deepseek.com/v1'

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async chat(
    messages: Message[],
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (error: Error) => void
  ): Promise<void> {
    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages,
          stream: true,
        }),
      })

      if (!response.ok) {
        throw new Error(`API 请求失败: ${response.statusText}`)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('无法读取响应流')
      }

      const decoder = new TextDecoder()
      const parser = createParser({
        onEvent: (event) => {
          if (event.data === '[DONE]') {
            onDone()
            return
          }

          try {
            const data = JSON.parse(event.data)
            const content = data.choices[0]?.delta?.content
            if (content) {
              onChunk(content)
            }
          } catch (e) {
            console.error('解析 SSE 数据失败:', e)
          }
        },
      })

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        parser.feed(chunk)
      }
    } catch (error) {
      onError(error as Error)
    }
  }
}
