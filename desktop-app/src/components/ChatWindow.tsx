import { useState, useEffect } from 'react'
import { useChatStore } from '../stores/chatStore'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import { ModelConfig } from '../services/llm-service'

const QUICK_QUESTIONS: string[] = []

const TOOL_NAME_MAP: Record<string, string> = {
  search_knowledge: '检索知识库',
  read_knowledge_file: '读取知识文件',
  list_knowledge_files: '列出知识文件',
  calculate_roi: '计算储能收益',
  lookup_policy: '查询电价政策',
  compare_products: '对比产品参数',
}

interface Props {
  conversationId: string
  avatarId: string
  onConversationUpdate: () => void
  visionModel?: ModelConfig
}

export default function ChatWindow({ conversationId, avatarId, onConversationUpdate, visionModel }: Props) {
  const { messages, isLoading, toolCallStatus, sendMessage, setMessages } = useChatStore()
  const [isInitialized, setIsInitialized] = useState(false)
  const [isRunningTests, setIsRunningTests] = useState(false)

  useEffect(() => {
    const loadMessages = async () => {
      const dbMessages = await window.electronAPI.getMessages(conversationId)
      setMessages(
        dbMessages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      )
      setIsInitialized(true)
    }
    loadMessages()
  }, [conversationId, setMessages])

  const handleSendMessage = async (content: string, images?: string[]) => {
    if (content.trim() === '/test-self') {
      await handleTestSelf()
      return
    }
    await sendMessage(content, conversationId, avatarId, images, visionModel)
    onConversationUpdate()
  }

  const handleTestSelf = async () => {
    setIsRunningTests(true)
    const userMsg = { role: 'user' as const, content: '/test-self' }
    setMessages([...messages, userMsg])

    try {
      const testCases = await window.electronAPI.getTestCases(avatarId)
      if (testCases.length === 0) {
        const reply = '[ 自检结果 ] 暂无测试用例。请先在「测试中心」添加测试用例，然后再运行 /test-self。'
        setMessages([...messages, userMsg, { role: 'assistant', content: reply }])
        return
      }

      const summary = [
        `[ 自检报告 ] 共 ${testCases.length} 个测试用例`,
        '',
        ...testCases.map((tc, i) => `${i + 1}. **${tc.name}** — ${tc.category}  \n   > ${tc.prompt.slice(0, 60)}...`),
        '',
        '请前往「测试中心」查看完整测试结果并运行测试。',
      ].join('\n')

      setMessages([...messages, userMsg, { role: 'assistant', content: summary }])
      await window.electronAPI.saveMessage(conversationId, 'user', '/test-self')
      await window.electronAPI.saveMessage(conversationId, 'assistant', summary)
    } catch (err) {
      console.error('自检失败:', err)
      const errorMsg = `[ 自检失败 ] ${(err as Error).message}`
      setMessages([...messages, userMsg, { role: 'assistant', content: errorMsg }])
    } finally {
      setIsRunningTests(false)
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
  const handleSaveAnswer = async (question: string, answer: string) => {
    try {
      const qa: WikiAnswerData = {
        id: `qa-${Date.now()}`,
        question,
        answer,
        sources: [],
        savedAt: new Date().toISOString().slice(0, 10),
      }
      await window.electronAPI.saveWikiAnswer(avatarId, qa)
    } catch (err) {
      console.warn('答案沉淀失败:', err)
    }
  }

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
          onSend={handleSendMessage}
          disabled={isLoading || isRunningTests}
        />
      </div>
    </div>
  )
}
