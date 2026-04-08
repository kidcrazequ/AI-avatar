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
import SoulEditorPanel from './components/SoulEditorPanel'
import Toast from './components/shared/Toast'
import { useChatStore } from './stores/chatStore'
import { ModelConfig, DEFAULT_CHAT_MODEL, DEFAULT_VISION_MODEL, DEFAULT_OCR_MODEL, DEFAULT_CREATION_MODEL, resolveCreationModel } from './services/llm-service'

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [showKnowledgePanel, setShowKnowledgePanel] = useState(false)
  const [showSettingsPanel, setShowSettingsPanel] = useState(false)
  const [showCreateWizard, setShowCreateWizard] = useState(false)
  const [showTestPanel, setShowTestPanel] = useState(false)
  const [showSkillsPanel, setShowSkillsPanel] = useState(false)
  const [showMemoryPanel, setShowMemoryPanel] = useState(false)
  const [showSoulEditor, setShowSoulEditor] = useState(false)
  const [activeAvatarId, setActiveAvatarId] = useState<string>('')
  const [activeAvatarName, setActiveAvatarName] = useState<string>('')
  const [avatarList, setAvatarList] = useState<Avatar[]>([])
  const [toast, setToast] = useState<{ message: string; type?: 'success' | 'error' } | null>(null)

  const [visionModel, setVisionModel] = useState<ModelConfig>(DEFAULT_VISION_MODEL)
  const [ocrModel, setOcrModel] = useState<ModelConfig>(DEFAULT_OCR_MODEL)
  const [creationModel, setCreationModel] = useState<ModelConfig>(DEFAULT_CREATION_MODEL)

  const [testBadge, setTestBadge] = useState<{ failed: number } | null>(null)

  const { clearMessages, setSystemPrompt, setChatModel, chatModel, systemPrompt } = useChatStore()

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 2500)
  }, [])

  const loadConversations = useCallback(async () => {
    if (!activeAvatarId) return
    const convs = await window.electronAPI.getConversations(activeAvatarId)
    setConversations(convs)
  }, [activeAvatarId])

  const loadAvatarConfig = useCallback(async (avatarId: string) => {
    if (!avatarId) return
    const config = await window.electronAPI.loadAvatar(avatarId)
    setSystemPrompt(config.systemPrompt)
    return config
  }, [setSystemPrompt])

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
    const creationApiKey = await window.electronAPI.getSetting('creation_api_key')
    const creationBaseUrl = await window.electronAPI.getSetting('creation_base_url')
    const creationModelName = await window.electronAPI.getSetting('creation_model')

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
    setCreationModel({
      baseUrl: creationBaseUrl || DEFAULT_CREATION_MODEL.baseUrl,
      model: creationModelName || DEFAULT_CREATION_MODEL.model,
      apiKey: creationApiKey || '',
    })
  }, [setChatModel])

  const refreshAvatarList = useCallback(async () => {
    const avatars = await window.electronAPI.listAvatars()
    setAvatarList(avatars)
    return avatars
  }, [])

  useEffect(() => {
    loadModelConfigs()
    refreshAvatarList()

    const handleSettingsUpdate = () => {
      loadModelConfigs()
    }
    window.addEventListener('settings-updated', handleSettingsUpdate)

    window.electronAPI.onScheduledTestTrigger((avatarId) => {
      handleSelectAvatar(avatarId).then(() => setShowTestPanel(true))
    })

    window.electronAPI.onTestResultBadge((data) => {
      if (data.failed > 0) {
        setTestBadge({ failed: data.failed })
        showToast(`自检完成：${data.failed}/${data.total} 个用例失败`, 'error')
      } else {
        setTestBadge(null)
      }
    })

    return () => window.removeEventListener('settings-updated', handleSettingsUpdate)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeAvatarId) {
      loadConversations()
      loadAvatarConfig(activeAvatarId)
    }
  }, [activeAvatarId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectAvatar = async (avatarId: string) => {
    setActiveAvatarId(avatarId)
    await loadAvatarConfig(avatarId)
    setActiveConversationId(null)
    clearMessages()
    const convs = await window.electronAPI.getConversations(avatarId)
    setConversations(convs)

    const avatars = await window.electronAPI.listAvatars()
    setAvatarList(avatars)
    const avatar = avatars.find(a => a.id === avatarId)
    if (avatar) setActiveAvatarName(avatar.name)
  }

  const handleAvatarCreated = async (avatarId: string) => {
    setShowCreateWizard(false)
    await handleSelectAvatar(avatarId)
  }

  // 并发锁：防止双击或同时点击两个"新建对话"按钮导致重复创建
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)

  const handleNewConversation = async () => {
    if (!activeAvatarId || isCreatingConversation) return
    setIsCreatingConversation(true)
    try {
      const id = await window.electronAPI.createConversation('新对话', activeAvatarId)
      await loadConversations()
      setActiveConversationId(id)
      clearMessages()
    } finally {
      setIsCreatingConversation(false)
    }
  }

  const handleSelectConversation = (id: string) => {
    setActiveConversationId(id)
  }

  const handleDeleteConversation = async (id: string) => {
    await window.electronAPI.deleteConversation(id)
    await loadConversations()
    if (activeConversationId === id) {
      setActiveConversationId(null)
      clearMessages()
    }
  }

  const handleSkillsChanged = useCallback(async () => {
    if (!activeAvatarId) return
    await loadAvatarConfig(activeAvatarId)
    showToast('技能已更新，上下文已刷新')
  }, [activeAvatarId, loadAvatarConfig, showToast])

  const handleKnowledgeSaved = useCallback(async () => {
    if (!activeAvatarId) return
    await loadAvatarConfig(activeAvatarId)
    showToast('知识已保存，上下文已刷新')
  }, [activeAvatarId, loadAvatarConfig, showToast])

  const handleSoulChanged = useCallback(async () => {
    if (!activeAvatarId) return
    await loadAvatarConfig(activeAvatarId)
    showToast('人格已保存，上下文已刷新')
  }, [activeAvatarId, loadAvatarConfig, showToast])

  /** 顶栏导航按钮 */
  const navButtons = [
    { label: '人格', key: 'soul', onClick: () => setShowSoulEditor(true), active: showSoulEditor },
    { label: '技能', key: 'skills', onClick: () => setShowSkillsPanel(true), active: showSkillsPanel },
    {
      label: '测试', key: 'test',
      onClick: () => { setShowTestPanel(true); setTestBadge(null) },
      active: showTestPanel, badge: testBadge?.failed,
    },
    { label: '知识库', key: 'docs', onClick: () => setShowKnowledgePanel(true), active: showKnowledgePanel },
    { label: '记忆', key: 'mem', onClick: () => setShowMemoryPanel(true), active: showMemoryPanel },
    { label: '设置', key: 'set', onClick: () => setShowSettingsPanel(true), active: showSettingsPanel },
  ]

  /** 未选择分身时的引导页 */
  const renderAvatarSelectPage = () => (
    <div className="flex items-center justify-center h-screen bg-px-bg relative overflow-hidden">
      <div className="absolute inset-0 pixel-grid opacity-50" />

      <div className="text-center max-w-lg px-8 relative z-10 animate-fade-in">
        <div className="inline-flex items-center justify-center w-20 h-20 border-2 border-px-primary bg-px-primary/10 mb-8 shadow-pixel-glow">
          <span className="font-game text-[24px] text-px-primary leading-none">S</span>
        </div>

        <div className="font-game text-[20px] text-px-primary tracking-widest mb-4">
          SOUL DESKTOP
        </div>
        <p className="font-game text-[14px] text-px-text-sec tracking-wider mb-8">
          AI 分身专家系统
        </p>

        {avatarList.length > 0 ? (
          <div className="space-y-2 mb-8">
            {avatarList.map((avatar) => (
              <button
                key={avatar.id}
                onClick={() => handleSelectAvatar(avatar.id)}
                className="w-full flex items-center gap-4 px-5 py-4 border-2 border-px-border bg-px-surface
                  hover:border-px-primary hover:bg-px-primary/5 transition-none text-left"
              >
                <div className="w-10 h-10 bg-px-primary flex items-center justify-center flex-shrink-0 shadow-pixel-brand">
                  <span className="font-game text-[14px] text-white leading-none">
                    {avatar.name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-game text-[16px] text-px-text font-bold truncate">{avatar.name}</p>
                  <p className="font-game text-[13px] text-px-text-dim mt-0.5 truncate">{avatar.description || avatar.id}</p>
                </div>
                <span className="font-game text-[12px] text-px-text-dim">&gt;</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="font-game text-[14px] text-px-text-dim tracking-wider mb-8">暂无分身，请先创建</p>
        )}

        <div className="flex justify-center gap-3">
          <button
            onClick={() => setShowCreateWizard(true)}
            className="pixel-btn-primary px-6 py-3"
          >
            [+] 新建分身
          </button>
          <button
            onClick={() => setShowSettingsPanel(true)}
            className="pixel-btn-outline-muted px-6 py-3"
          >
            设置
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <>
      {!activeAvatarId ? (
        renderAvatarSelectPage()
      ) : (
        <Sidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          onNewConversation={handleNewConversation}
          isCreatingConversation={isCreatingConversation}
        >
          {activeConversationId ? (
            <div className="flex flex-col h-screen">
              {/* ── 顶部操作栏 ── */}
              <div className="flex items-center justify-between px-5 py-2.5 bg-px-surface border-b-2 border-px-border">
                <div className="flex items-center gap-4">
                  <AvatarSelector
                    activeAvatarId={activeAvatarId}
                    onSelectAvatar={handleSelectAvatar}
                    onCreateAvatar={() => setShowCreateWizard(true)}
                  />
                </div>
                <div className="flex gap-2">
                  {navButtons.map(btn => (
                    <button
                      key={btn.key}
                      onClick={btn.onClick}
                      className={`relative px-5 py-2 font-game text-[15px] tracking-wider
                        border-2 transition-none select-none
                        ${btn.active
                          ? 'border-px-primary text-px-primary bg-px-primary/10'
                          : btn.key === 'set'
                            ? 'border-transparent text-px-text-dim hover:text-px-text-sec hover:border-px-border-dim'
                            : 'border-px-border-dim text-px-text-sec hover:border-px-border hover:text-px-text'
                        }`}
                      aria-label={btn.label}
                    >
                      {btn.label}
                      {btn.badge && btn.badge > 0 && (
                        <span className="absolute -top-1.5 -right-1.5 bg-px-danger text-white
                          font-game text-[10px] w-4 h-4 flex items-center justify-center
                          border border-px-surface">
                          {btn.badge}
                        </span>
                      )}
                    </button>
                  ))}
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
            /* ── 已选分身，未选对话 ── */
            <div className="flex items-center justify-center h-screen bg-px-bg relative overflow-hidden">
              <div className="absolute inset-0 pixel-grid opacity-50" />

              <div className="text-center max-w-md px-8 relative z-10 animate-fade-in">
                <div className="inline-flex items-center justify-center w-20 h-20 border-2 border-px-primary bg-px-primary/10 mb-8 shadow-pixel-glow">
                  <span className="font-game text-[24px] text-px-primary leading-none">
                    {activeAvatarName.charAt(0)?.toUpperCase() || 'A'}
                  </span>
                </div>

                <div className="border-2 border-px-border bg-px-surface/50 px-6 py-4 mb-6">
                  <div className="font-game text-[13px] text-px-primary tracking-widest mb-3">
                    分身就绪
                  </div>
                  <div className="font-game text-[18px] text-px-text font-bold tracking-wide">
                    {activeAvatarName}
                  </div>
                  <div className="pixel-divider my-3" />
                  <div className="font-game text-[14px] text-px-text-sec">
                    AI 分身专家系统
                  </div>
                </div>

                <p className="font-game text-px-text-dim text-[14px]">
                  点击左侧「[+] NEW CHAT」开始第一条对话
                </p>
              </div>
            </div>
          )}
        </Sidebar>
      )}

      {showKnowledgePanel && activeAvatarId && (
        <KnowledgePanel
          avatarId={activeAvatarId}
          onClose={() => setShowKnowledgePanel(false)}
          onSaved={handleKnowledgeSaved}
          ocrModel={ocrModel}
          chatModel={chatModel}
          creationModel={resolveCreationModel(creationModel, chatModel)}
        />
      )}

      {showCreateWizard && (
        <CreateAvatarWizard
          chatModel={chatModel}
          creationModel={resolveCreationModel(creationModel, chatModel)}
          onClose={() => setShowCreateWizard(false)}
          onCreated={handleAvatarCreated}
        />
      )}

      {showSettingsPanel && (
        <SettingsPanel
          onClose={() => setShowSettingsPanel(false)}
        />
      )}

      {showTestPanel && activeAvatarId && (
        <TestPanel
          avatarId={activeAvatarId}
          chatModel={chatModel}
          systemPrompt={systemPrompt}
          onClose={() => setShowTestPanel(false)}
        />
      )}

      {showSkillsPanel && activeAvatarId && (
        <SkillsPanel
          avatarId={activeAvatarId}
          onClose={() => setShowSkillsPanel(false)}
          onSkillsChanged={handleSkillsChanged}
        />
      )}

      {showMemoryPanel && activeAvatarId && (
        <MemoryPanel
          avatarId={activeAvatarId}
          onClose={() => setShowMemoryPanel(false)}
        />
      )}

      {showSoulEditor && activeAvatarId && (
        <SoulEditorPanel
          avatarId={activeAvatarId}
          onClose={() => setShowSoulEditor(false)}
          onSoulChanged={handleSoulChanged}
        />
      )}

      {toast && (
        <Toast message={toast.message} type={toast.type} />
      )}
    </>
  )
}

export default App
