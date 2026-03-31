import { useState, useEffect } from 'react'
import { useChatStore } from '../stores/chatStore'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import { ModelConfig } from '../services/llm-service'

/** GAP8: 快捷问题建议（展示在空对话时） */
const QUICK_QUESTIONS = [
  '帮我做一个储能项目收益测算',
  '广东省工商业储能政策有哪些？',
  '500kWh 柜式储能产品参数是什么？',
  '如何做需量管理方案设计？',
]

/** GAP8: 工具名称中文映射 */
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
  /** GAP9b: 图片理解模型配置，有图片时使用 */
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
    // GAP8: /test-self 命令拦截
    if (content.trim() === '/test-self') {
      await handleTestSelf()
      return
    }
    await sendMessage(content, conversationId, avatarId, images, visionModel)
    onConversationUpdate()
  }

  /**
   * GAP8: 执行自检命令 /test-self
   * 运行该分身的所有测试用例，将摘要结果作为消息显示在对话中
   */
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

  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center h-full bg-px-black">
        <span className="font-pixel text-[10px] text-px-muted tracking-wider animate-blink">
          LOADING...
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-px-black">
      {/* 消息列表（含空状态快捷问题） */}
      <div className="flex-1 overflow-hidden">
        <MessageList
          messages={messages}
          isLoading={isLoading || isRunningTests}
          onQuickQuestion={handleSendMessage}
          quickQuestions={messages.length === 0 ? QUICK_QUESTIONS : undefined}
        />
      </div>

      {/* GAP8: 工具调用状态可视化 / 思考状态 */}
      {(isLoading || isRunningTests) && (
        <div className="px-6 py-2 bg-px-mid border-t-2 border-px-line">
          <span className="font-pixel text-[9px] text-px-muted tracking-wider">
            {toolCallStatus
              ? `[ TOOL ] ${TOOL_NAME_MAP[toolCallStatus] ?? toolCallStatus}...`
              : isRunningTests
                ? 'RUNNING TESTS▌'
                : 'THINKING▌'}
            {!toolCallStatus && <span className="animate-blink"> </span>}
          </span>
        </div>
      )}

      {/* 输入区 */}
      <div className="border-t-2 border-px-line bg-px-black p-4">
        <MessageInput
          onSend={handleSendMessage}
          disabled={isLoading || isRunningTests}
        />
      </div>
    </div>
  )
}
