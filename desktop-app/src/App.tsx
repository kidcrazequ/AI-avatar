import { useState, useEffect, useCallback } from 'react'
import Sidebar from './components/Sidebar'
import ChatWindow from './components/ChatWindow'
import KnowledgePanel from './components/KnowledgePanel'
import SettingsPanel from './components/SettingsPanel'
import AvatarSelector from './components/AvatarSelector'
import CreateAvatarWizard from './components/CreateAvatarWizard'
import TestPanel from './components/TestPanel'
import SkillsPanel from './components/SkillsPanel'
import MemoryPanel from './components/MemoryPanel'
import Toast from './components/shared/Toast'
import { useChatStore } from './stores/chatStore'
import { ModelConfig, DEFAULT_CHAT_MODEL, DEFAULT_VISION_MODEL, DEFAULT_OCR_MODEL } from './services/llm-service'

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [showKnowledgePanel, setShowKnowledgePanel] = useState(false)
  const [showSettingsPanel, setShowSettingsPanel] = useState(false)
  const [showCreateWizard, setShowCreateWizard] = useState(false)
  const [showTestPanel, setShowTestPanel] = useState(false)
  const [showSkillsPanel, setShowSkillsPanel] = useState(false)
  const [showMemoryPanel, setShowMemoryPanel] = useState(false)
  const [activeAvatarId, setActiveAvatarId] = useState<string>('ci-storage-expert')
  const [activeAvatarName, setActiveAvatarName] = useState<string>('AI分身')
  const [toast, setToast] = useState<{ message: string; type?: 'success' | 'error' } | null>(null)

  // 多模型配置
  const [visionModel, setVisionModel] = useState<ModelConfig>(DEFAULT_VISION_MODEL)
  const [ocrModel, setOcrModel] = useState<ModelConfig>(DEFAULT_OCR_MODEL)

  // GAP14: 测试红点状态
  const [testBadge, setTestBadge] = useState<{ failed: number } | null>(null)

  const { clearMessages, setSystemPrompt, setChatModel, chatModel, systemPrompt } = useChatStore()

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 2500)
  }, [])

  const loadConversations = useCallback(async () => {
    const convs = await window.electronAPI.getConversations(activeAvatarId)
    setConversations(convs)
  }, [activeAvatarId])

  // GAP6: 重新加载分身配置（技能/知识编辑后调用此函数刷新 system prompt）
  const loadAvatarConfig = useCallback(async (avatarId: string) => {
    const config = await window.electronAPI.loadAvatar(avatarId)
    setSystemPrompt(config.systemPrompt)
    return config
  }, [setSystemPrompt])

  // 从 settings 加载模型配置
  const loadModelConfigs = useCallback(async () => {
    const chatApiKey = await window.electronAPI.getSetting('chat_api_key')
    const chatBaseUrl = await window.electronAPI.getSetting('chat_base_url')
    const chatModel = await window.electronAPI.getSetting('chat_model')
    const visionApiKey = await window.electronAPI.getSetting('vision_api_key')
    const visionBaseUrl = await window.electronAPI.getSetting('vision_base_url')
    const visionModelName = await window.electronAPI.getSetting('vision_model')
    const ocrApiKey = await window.electronAPI.getSetting('ocr_api_key')
    const ocrBaseUrl = await window.electronAPI.getSetting('ocr_base_url')
    const ocrModelName = await window.electronAPI.getSetting('ocr_model')

    setChatModel({
      baseUrl: chatBaseUrl || DEFAULT_CHAT_MODEL.baseUrl,
      model: chatModel || DEFAULT_CHAT_MODEL.model,
      apiKey: chatApiKey || '',
    })
    setVisionModel({
      baseUrl: visionBaseUrl || DEFAULT_VISION_MODEL.baseUrl,
      model: visionModelName || DEFAULT_VISION_MODEL.model,
      apiKey: visionApiKey || '',
    })
    setOcrModel({
      baseUrl: ocrBaseUrl || DEFAULT_OCR_MODEL.baseUrl,
      model: ocrModelName || DEFAULT_OCR_MODEL.model,
      apiKey: ocrApiKey || '',
    })
  }, [setChatModel])

  // 初始化
  useEffect(() => {
    loadConversations()
    loadAvatarConfig(activeAvatarId)
    loadModelConfigs()

    // 加载分身名称
    window.electronAPI.listAvatars().then((avatars) => {
      const avatar = avatars.find(a => a.id === activeAvatarId)
      if (avatar) setActiveAvatarName(avatar.name)
    })

    // 监听设置更新事件
    const handleSettingsUpdate = () => {
      loadModelConfigs()
    }
    window.addEventListener('settings-updated', handleSettingsUpdate)

    // GAP14: 监听定时自检触发事件
    window.electronAPI.onScheduledTestTrigger((avatarId) => {
      // 触发后切换到对应分身并打开测试面板
      handleSelectAvatar(avatarId).then(() => setShowTestPanel(true))
    })

    // GAP14: 监听测试结果红点更新
    window.electronAPI.onTestResultBadge((data) => {
      if (data.failed > 0) {
        setTestBadge({ failed: data.failed })
        showToast(`⚠ 自检完成：${data.failed}/${data.total} 个用例失败`, 'error')
      } else {
        setTestBadge(null)
      }
    })

    return () => window.removeEventListener('settings-updated', handleSettingsUpdate)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 切换分身
  const handleSelectAvatar = async (avatarId: string) => {
    setActiveAvatarId(avatarId)
    await loadAvatarConfig(avatarId)
    setActiveConversationId(null)
    clearMessages()
    const convs = await window.electronAPI.getConversations(avatarId)
    setConversations(convs)

    const avatars = await window.electronAPI.listAvatars()
    const avatar = avatars.find(a => a.id === avatarId)
    if (avatar) setActiveAvatarName(avatar.name)
  }

  const handleAvatarCreated = async (avatarId: string) => {
    setShowCreateWizard(false)
    await handleSelectAvatar(avatarId)
  }

  const handleNewConversation = async () => {
    const id = await window.electronAPI.createConversation('新对话', activeAvatarId)
    await loadConversations()
    setActiveConversationId(id)
    clearMessages()
  }

  const handleSelectConversation = (id: string) => {
    setActiveConversationId(id)
  }

  // GAP15 UX: 使用 Toast 替代 confirm() 的内联确认
  const handleDeleteConversation = async (id: string) => {
    await window.electronAPI.deleteConversation(id)
    await loadConversations()
    if (activeConversationId === id) {
      setActiveConversationId(null)
      clearMessages()
    }
  }

  // GAP3: 技能切换后刷新 system prompt
  const handleSkillsChanged = useCallback(async () => {
    await loadAvatarConfig(activeAvatarId)
    showToast('技能已更新，上下文已刷新')
  }, [activeAvatarId, loadAvatarConfig, showToast])

  // GAP6: 知识编辑后刷新 system prompt
  const handleKnowledgeSaved = useCallback(async () => {
    await loadAvatarConfig(activeAvatarId)
    showToast('知识已保存，上下文已刷新')
  }, [activeAvatarId, loadAvatarConfig, showToast])

  return (
    <>
      <Sidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={handleDeleteConversation}
        onNewConversation={handleNewConversation}
      >
        {activeConversationId ? (
          <div className="flex flex-col h-screen">
            {/* 顶部操作栏 */}
            <div className="flex items-center justify-between px-6 py-3 bg-px-black border-b-2 border-px-black">
              <div className="flex items-center gap-4">
                <AvatarSelector
                  activeAvatarId={activeAvatarId}
                  onSelectAvatar={handleSelectAvatar}
                  onCreateAvatar={() => setShowCreateWizard(true)}
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowSkillsPanel(true)}
                  className="pixel-btn-outline-light"
                  aria-label="技能管理"
                >
                  [⚡] SKILLS
                </button>
                <button
                  onClick={() => { setShowTestPanel(true); setTestBadge(null) }}
                  className="pixel-btn-outline-light relative"
                  aria-label="自检测试"
                >
                  [▶] TEST
                  {testBadge && testBadge.failed > 0 && (
                    <span className="absolute -top-1 -right-1 bg-red-500 text-white
                      font-pixel text-[6px] w-4 h-4 flex items-center justify-center
                      border border-px-black">
                      {testBadge.failed}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setShowKnowledgePanel(true)}
                  className="pixel-btn-outline-light"
                  aria-label="知识库"
                >
                  [≡] DOCS
                </button>
                <button
                  onClick={() => setShowMemoryPanel(true)}
                  className="pixel-btn-outline-light"
                  aria-label="记忆管理"
                >
                  [◈] MEM
                </button>
                <button
                  onClick={() => setShowSettingsPanel(true)}
                  className="pixel-btn-outline-muted"
                  aria-label="设置"
                >
                  [⚙] SET
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <ChatWindow
                conversationId={activeConversationId}
                avatarId={activeAvatarId}
                onConversationUpdate={loadConversations}
                visionModel={visionModel}
              />
            </div>
          </div>
        ) : (
          /* GAP15 UX: 欢迎页 Terminal 风格 */
          <div className="flex items-center justify-center h-screen bg-px-black">
            <div className="text-center max-w-lg px-8">
              <div className="border-2 border-px-line inline-block px-8 py-5 mb-8 select-none">
                <div className="font-pixel text-[8px] text-px-muted tracking-wider mb-3 text-left">
                  AVATAR LOADED
                </div>
                <div className="font-mono text-base text-px-white tracking-wide mb-2">
                  {activeAvatarName}
                </div>
                <div className="h-[1px] bg-px-line mb-2" />
                <div className="font-mono text-sm text-px-muted">
                  AI 分身专家系统
                </div>
              </div>
              <p className="font-mono text-px-muted text-sm mb-8">
                {'// ready for input...'}
              </p>
              <button
                onClick={handleNewConversation}
                className="pixel-btn-primary"
              >
                [+] START NEW CHAT
              </button>
            </div>
          </div>
        )}
      </Sidebar>

      {showKnowledgePanel && (
        <KnowledgePanel
          avatarId={activeAvatarId}
          onClose={() => setShowKnowledgePanel(false)}
          onSaved={handleKnowledgeSaved}
          ocrModel={ocrModel}
          chatModel={chatModel}
        />
      )}

      {showCreateWizard && (
        <CreateAvatarWizard
          chatModel={chatModel}
          onClose={() => setShowCreateWizard(false)}
          onCreated={handleAvatarCreated}
        />
      )}

      {showSettingsPanel && (
        <SettingsPanel
          onClose={() => setShowSettingsPanel(false)}
        />
      )}

      {showTestPanel && (
        <TestPanel
          avatarId={activeAvatarId}
          chatModel={chatModel}
          systemPrompt={systemPrompt}
          onClose={() => setShowTestPanel(false)}
        />
      )}

      {showSkillsPanel && (
        <SkillsPanel
          avatarId={activeAvatarId}
          onClose={() => setShowSkillsPanel(false)}
          onSkillsChanged={handleSkillsChanged}
        />
      )}

      {showMemoryPanel && (
        <MemoryPanel
          avatarId={activeAvatarId}
          onClose={() => setShowMemoryPanel(false)}
        />
      )}

      {toast && (
        <Toast message={toast.message} type={toast.type} />
      )}
    </>
  )
}

export default App
