# Phase 2: DeepSeek API 集成与对话功能

**预计时间**: 4-5 天

**目标**: 实现基础对话界面，接入 DeepSeek API，支持流式响应

---

## 前置条件

- Phase 1 已完成
- 应用可以正常启动

---

## 任务清单

### 2.1 安装额外依赖

```bash
npm install react-markdown react-syntax-highlighter
npm install -D @types/react-syntax-highlighter
npm install eventsource-parser  # 用于解析 SSE 流
```

### 2.2 创建 DeepSeek API 服务

创建 `src/services/deepseek.ts`:

```typescript
import axios from 'axios'
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
      const parser = createParser((event) => {
        if (event.type === 'event') {
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
        }
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
```

### 2.3 创建 Soul 加载器

创建 `electron/soul-loader.ts`:

```typescript
import fs from 'fs'
import path from 'path'

export interface AvatarConfig {
  id: string
  name: string
  systemPrompt: string
}

export class SoulLoader {
  private avatarsPath: string

  constructor(avatarsPath: string) {
    this.avatarsPath = avatarsPath
  }

  loadAvatar(avatarId: string): AvatarConfig {
    const avatarPath = path.join(this.avatarsPath, avatarId)

    // 读取 CLAUDE.md
    const claudeMd = this.readFile(path.join(avatarPath, 'CLAUDE.md'))

    // 读取 soul.md
    const soulMd = this.readFile(path.join(avatarPath, 'soul.md'))

    // 读取 knowledge/ 目录下的所有文件
    const knowledgePath = path.join(avatarPath, 'knowledge')
    const knowledgeFiles = this.readDirectory(knowledgePath)

    // 读取 skills/ 目录下的所有文件
    const skillsPath = path.join(avatarPath, 'skills')
    const skillsFiles = this.readDirectory(skillsPath)

    // 组合成完整的 System Prompt
    const systemPrompt = [
      claudeMd,
      '\n\n---\n\n',
      soulMd,
      '\n\n---\n\n# 知识库\n\n',
      ...knowledgeFiles.map(f => f.content),
      '\n\n---\n\n# 技能定义\n\n',
      ...skillsFiles.map(f => f.content),
    ].join('')

    return {
      id: avatarId,
      name: this.extractAvatarName(claudeMd),
      systemPrompt,
    }
  }

  private readFile(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch (error) {
      console.error(`读取文件失败: ${filePath}`, error)
      return ''
    }
  }

  private readDirectory(dirPath: string): Array<{ path: string; content: string }> {
    const files: Array<{ path: string; content: string }> = []

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)

        if (entry.isDirectory()) {
          // 递归读取子目录
          files.push(...this.readDirectory(fullPath))
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push({
            path: fullPath,
            content: this.readFile(fullPath),
          })
        }
      }
    } catch (error) {
      console.error(`读取目录失败: ${dirPath}`, error)
    }

    return files
  }

  private extractAvatarName(claudeMd: string): string {
    const match = claudeMd.match(/^#\s+(.+)$/m)
    return match ? match[1] : '未命名分身'
  }
}
```

### 2.4 在主进程中添加 IPC 处理器

编辑 `electron/main.ts`，添加：

```typescript
import { SoulLoader } from './soul-loader'
import path from 'path'

const avatarsPath = path.join(app.getPath('userData'), '../../../avatars')
const soulLoader = new SoulLoader(avatarsPath)

// 加载分身配置
ipcMain.handle('load-avatar', async (_, avatarId: string) => {
  return soulLoader.loadAvatar(avatarId)
})
```

编辑 `electron/preload.ts`，添加：

```typescript
contextBridge.exposeInMainWorld('electronAPI', {
  ping: () => ipcRenderer.invoke('ping'),
  loadAvatar: (avatarId: string) => ipcRenderer.invoke('load-avatar', avatarId),
})
```

### 2.5 创建对话状态管理

创建 `src/stores/chatStore.ts`:

```typescript
import { create } from 'zustand'
import { DeepSeekService, Message } from '../services/deepseek'

interface ChatStore {
  messages: Message[]
  isLoading: boolean
  systemPrompt: string
  apiKey: string

  setSystemPrompt: (prompt: string) => void
  setApiKey: (key: string) => void
  sendMessage: (content: string) => Promise<void>
  clearMessages: () => void
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  isLoading: false,
  systemPrompt: '',
  apiKey: '',

  setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),

  setApiKey: (key) => set({ apiKey: key }),

  sendMessage: async (content: string) => {
    const { messages, systemPrompt, apiKey } = get()

    // 添加用户消息
    const userMessage: Message = { role: 'user', content }
    set({ messages: [...messages, userMessage], isLoading: true })

    // 准备发送给 API 的消息
    const apiMessages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
      userMessage,
    ]

    // 创建 DeepSeek 服务
    const deepseek = new DeepSeekService(apiKey)

    // AI 回复消息
    let assistantMessage = ''

    await deepseek.chat(
      apiMessages,
      // onChunk
      (chunk) => {
        assistantMessage += chunk
        set((state) => ({
          messages: [
            ...state.messages.slice(0, -1),
            userMessage,
            { role: 'assistant', content: assistantMessage },
          ],
        }))
      },
      // onDone
      () => {
        set({ isLoading: false })
      },
      // onError
      (error) => {
        console.error('对话失败:', error)
        set({
          messages: [
            ...get().messages,
            {
              role: 'assistant',
              content: `抱歉，发生了错误：${error.message}`,
            },
          ],
          isLoading: false,
        })
      }
    )
  },

  clearMessages: () => set({ messages: [] }),
}))
```

### 2.6 创建对话界面组件

创建 `src/components/ChatWindow.tsx`:

```typescript
import { useState, useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import MessageList from './MessageList'
import MessageInput from './MessageInput'

export default function ChatWindow() {
  const { messages, isLoading, sendMessage, setSystemPrompt, setApiKey } = useChatStore()
  const [isInitialized, setIsInitialized] = useState(false)

  useEffect(() => {
    // 加载小堵的配置
    window.electronAPI.loadAvatar('ci-storage-expert').then((config) => {
      setSystemPrompt(config.systemPrompt)
      setIsInitialized(true)
    })

    // TODO: 从设置中加载 API Key
    setApiKey('your-deepseek-api-key')
  }, [])

  if (!isInitialized) {
    return <div className="flex items-center justify-center h-screen">加载中...</div>
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold">小堵 - 工商储专家</h1>
      </header>

      <div className="flex-1 overflow-hidden">
        <MessageList messages={messages} />
      </div>

      <div className="border-t bg-white p-4">
        <MessageInput
          onSend={sendMessage}
          disabled={isLoading}
        />
      </div>
    </div>
  )
}
```

创建 `src/components/MessageList.tsx`:

```typescript
import { useEffect, useRef } from 'react'
import { Message } from '../services/deepseek'
import MessageBubble from './MessageBubble'

interface Props {
  messages: Message[]
}

export default function MessageList({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="h-full overflow-y-auto px-6 py-4 space-y-4">
      {messages.filter(m => m.role !== 'system').map((message, index) => (
        <MessageBubble key={index} message={message} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
```

创建 `src/components/MessageBubble.tsx`:

```typescript
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Message } from '../services/deepseek'

interface Props {
  message: Message
}

export default function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-3xl rounded-lg px-4 py-3 ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-white border border-gray-200'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <ReactMarkdown
            className="prose prose-sm max-w-none"
            components={{
              code({ node, inline, className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '')
                return !inline && match ? (
                  <SyntaxHighlighter
                    style={oneDark}
                    language={match[1]}
                    PreTag="div"
                    {...props}
                  >
                    {String(children).replace(/\n$/, '')}
                  </SyntaxHighlighter>
                ) : (
                  <code className={className} {...props}>
                    {children}
                  </code>
                )
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  )
}
```

创建 `src/components/MessageInput.tsx`:

```typescript
import { useState, KeyboardEvent } from 'react'

interface Props {
  onSend: (message: string) => void
  disabled: boolean
}

export default function MessageInput({ onSend, disabled }: Props) {
  const [input, setInput] = useState('')

  const handleSend = () => {
    if (input.trim() && !disabled) {
      onSend(input.trim())
      setInput('')
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex gap-2">
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
        disabled={disabled}
        className="flex-1 resize-none rounded-lg border border-gray-300 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
        rows={3}
      />
      <button
        onClick={handleSend}
        disabled={disabled || !input.trim()}
        className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        发送
      </button>
    </div>
  )
}
```

### 2.7 更新 App.tsx

编辑 `src/App.tsx`:

```typescript
import ChatWindow from './components/ChatWindow'

function App() {
  return <ChatWindow />
}

export default App
```

---

## 验证标准

运行应用并测试：

```bash
npm run dev
```

**测试场景**：

1. 输入："广东工商储现在值得做吗？"
2. 观察小堵的回复是否：
   - ✅ 以上海人口吻回复（使用"侬"、"伐"等）
   - ✅ 结论先行，不绕弯子
   - ✅ 提到需要数据才能判断
   - ✅ 回复内容实时流式显示（逐字出现）

3. 继续对话，测试多轮上下文记忆

4. 测试 Markdown 渲染：
   - 代码块高亮
   - 表格显示
   - 列表格式

---

## 下一步

完成 Phase 2 后，进入 Phase 3: 对话历史与会话管理
