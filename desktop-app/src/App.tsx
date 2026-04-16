import { useState, useEffect, useCallback, useRef } from 'react'
import Sidebar from './components/Sidebar'
import ChatWindow from './components/ChatWindow'
import KnowledgePanel from './components/KnowledgePanel'
import SettingsPanel from './components/SettingsPanel'
import AvatarSelector from './components/AvatarSelector'
import CreateAvatarWizard from './components/CreateAvatarWizard'
import TestPanel from './components/TestPanel'
import SkillsPanel from './components/SkillsPanel'
import MemoryPanel from './components/MemoryPanel'
import UserProfilePanel from './components/UserProfilePanel'
import SoulEditorPanel from './components/SoulEditorPanel'
import PromptTemplatePanel from './components/PromptTemplatePanel'
import PixelNavBar from './components/PixelNavBar'
import AvatarImage from './components/AvatarImage'
import Toast from './components/shared/Toast'
import { useShallow } from 'zustand/react/shallow'
import { useThemeStore } from './stores/themeStore'
import { useChatStore } from './stores/chatStore'
import { MEMORY_CHAR_LIMIT, MEMORY_WARN_THRESHOLD } from '@soul/core'
import { ModelConfig, DEFAULT_CHAT_MODEL, DEFAULT_VISION_MODEL, DEFAULT_OCR_MODEL, DEFAULT_CREATION_MODEL, resolveCreationModel } from './services/llm-service'

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [activePanel, setActivePanel] = useState<
    'knowledge' | 'settings' | 'createWizard' | 'test' | 'skills' | 'memory' | 'userProfile' | 'soulEditor' | 'promptTemplate' | null
  >(null)
  const showKnowledgePanel = activePanel === 'knowledge'
  const showSettingsPanel = activePanel === 'settings'
  const showCreateWizard = activePanel === 'createWizard'
  const showTestPanel = activePanel === 'test'
  const showSkillsPanel = activePanel === 'skills'
  const showMemoryPanel = activePanel === 'memory'
  const showUserProfilePanel = activePanel === 'userProfile'
  const showSoulEditor = activePanel === 'soulEditor'
  const showPromptTemplatePanel = activePanel === 'promptTemplate'
  const [templateFillText, setTemplateFillText] = useState<string | undefined>(undefined)
  const [activeAvatarId, setActiveAvatarId] = useState<string>('')
  const [activeAvatarName, setActiveAvatarName] = useState<string>('')
  const [avatarList, setAvatarList] = useState<Avatar[]>([])
  const [toast, setToast] = useState<{ message: string; type?: 'success' | 'error' } | null>(null)
  const [updateInfo, setUpdateInfo] = useState<{ latestVersion: string; downloadUrl: string; releaseNotes?: string } | null>(null)

  const [visionModel, setVisionModel] = useState<ModelConfig>(DEFAULT_VISION_MODEL)
  const [ocrModel, setOcrModel] = useState<ModelConfig>(DEFAULT_OCR_MODEL)
  const [creationModel, setCreationModel] = useState<ModelConfig>(DEFAULT_CREATION_MODEL)

  const [testBadge, setTestBadge] = useState<{ failed: number } | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const cronMemoryRunningRef = useRef(false)
  const cronKnowledgeRunningRef = useRef(false)
  const avatarSwitchSeqRef = useRef(0)
  const skipEffectLoadRef = useRef(false)

  const themeId = useThemeStore(s => s.themeId)

  const { clearMessages, resetTransientState, setSystemPrompt, setChatModel, chatModel, systemPrompt } = useChatStore(
    useShallow(s => ({
      clearMessages: s.clearMessages,
      resetTransientState: s.resetTransientState,
      setSystemPrompt: s.setSystemPrompt,
      setChatModel: s.setChatModel,
      chatModel: s.chatModel,
      systemPrompt: s.systemPrompt,
    }))
  )

  useEffect(() => () => { clearTimeout(toastTimerRef.current) }, [])

  // 启动时检查更新（静默，失败不影响使用）
  useEffect(() => {
    window.electronAPI.checkUpdate().then(result => {
      if (result.hasUpdate && result.downloadUrl && result.latestVersion) {
        setUpdateInfo({
          latestVersion: result.latestVersion,
          downloadUrl: result.downloadUrl,
          releaseNotes: result.releaseNotes,
        })
      }
    }).catch(() => { /* 静默 */ })
  }, [])

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type })
    clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 2500)
  }, [])

  const loadConversations = useCallback(async () => {
    if (!activeAvatarId) return
    try {
      const convs = await window.electronAPI.getConversations(activeAvatarId)
      setConversations(convs)
    } catch (err) {
      console.error('[App] 加载会话列表失败:', err)
      window.electronAPI.logEvent('error', 'load-conversations-error', err instanceof Error ? err.message : String(err))
    }
  }, [activeAvatarId])

  const loadAvatarConfig = useCallback(async (avatarId: string) => {
    if (!avatarId) return
    try {
      const config = await window.electronAPI.loadAvatar(avatarId)
      setSystemPrompt(config.systemPrompt)
      return config
    } catch (err) {
      console.error('[App] 加载分身配置失败:', err)
      window.electronAPI.logEvent('error', 'load-avatar-config-error', err instanceof Error ? err.message : String(err))
    }
  }, [setSystemPrompt])

  const loadModelConfigs = useCallback(async () => {
    const [
      chatApiKey, chatBaseUrl, chatModelName,
      visionApiKey, visionBaseUrl, visionModelName,
      ocrApiKey, ocrBaseUrl, ocrModelName,
      creationApiKey, creationBaseUrl, creationModelName,
    ] = await Promise.all([
      window.electronAPI.getSetting('chat_api_key'),
      window.electronAPI.getSetting('chat_base_url'),
      window.electronAPI.getSetting('chat_model'),
      window.electronAPI.getSetting('vision_api_key'),
      window.electronAPI.getSetting('vision_base_url'),
      window.electronAPI.getSetting('vision_model'),
      window.electronAPI.getSetting('ocr_api_key'),
      window.electronAPI.getSetting('ocr_base_url'),
      window.electronAPI.getSetting('ocr_model'),
      window.electronAPI.getSetting('creation_api_key'),
      window.electronAPI.getSetting('creation_base_url'),
      window.electronAPI.getSetting('creation_model'),
    ])

    setChatModel({
      baseUrl: chatBaseUrl || DEFAULT_CHAT_MODEL.baseUrl,
      model: chatModelName || DEFAULT_CHAT_MODEL.model,
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
    loadModelConfigs().catch(err => console.error('[App] 加载模型配置失败:', err))
    refreshAvatarList().catch(err => console.error('[App] 加载分身列表失败:', err))

    const handleSettingsUpdate = () => {
      loadModelConfigs().catch(err => console.error('[App] 刷新模型配置失败:', err))
    }
    window.addEventListener('settings-updated', handleSettingsUpdate)

    const removeScheduledTest = window.electronAPI.onScheduledTestTrigger((avatarId) => {
      handleSelectAvatar(avatarId).then(() => setActivePanel('test')).catch(err => {
        console.error('[App] 定时自检触发切换分身失败:', err instanceof Error ? err.message : String(err))
      })
    })

    const removeTestBadge = window.electronAPI.onTestResultBadge((data) => {
      if (data.failed > 0) {
        setTestBadge({ failed: data.failed })
        showToast(`自检完成：${data.failed}/${data.total} 个用例失败`, 'error')
      } else {
        setTestBadge(null)
      }
    })

    const removeCronMemory = window.electronAPI.onCronMemoryConsolidate(async (avatarId) => {
      if (cronMemoryRunningRef.current) return
      cronMemoryRunningRef.current = true
      try {
        if (!avatarId) return
        const apiKey = await window.electronAPI.getSetting('chat_api_key') ?? ''
        const baseUrl = await window.electronAPI.getSetting('chat_base_url') ?? ''
        if (!apiKey) return
        const content = await window.electronAPI.readMemory(avatarId)
        if (!content || content.length < MEMORY_CHAR_LIMIT * MEMORY_WARN_THRESHOLD) return
        const consolidated = await window.electronAPI.consolidateMemory(avatarId, content, apiKey, baseUrl)
        await window.electronAPI.writeMemory(avatarId, consolidated)
      } catch (err) {
        console.error('[Cron] 定时记忆整理失败:', err)
      } finally {
        cronMemoryRunningRef.current = false
      }
    })

    const removeCronKnowledge = window.electronAPI.onCronKnowledgeCheck(async (avatarId) => {
      if (cronKnowledgeRunningRef.current) return
      cronKnowledgeRunningRef.current = true
      try {
        const apiKey = await window.electronAPI.getSetting('ocr_api_key') ||
          await window.electronAPI.getSetting('chat_api_key') || ''
        const baseUrl = await window.electronAPI.getSetting('ocr_base_url') ||
          'https://dashscope.aliyuncs.com/compatible-mode/v1'
        if (!apiKey || !avatarId) return
        await window.electronAPI.buildKnowledgeIndex(avatarId, apiKey, baseUrl)
      } catch (err) {
        console.error('[Cron] 定时知识检查失败:', err)
      } finally {
        cronKnowledgeRunningRef.current = false
      }
    })

    return () => {
      window.removeEventListener('settings-updated', handleSettingsUpdate)
      removeScheduledTest?.()
      removeTestBadge?.()
      removeCronMemory?.()
      removeCronKnowledge?.()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeAvatarId) return
    // handleSelectAvatar 已完成数据拉取时跳过，避免双重请求竞态
    if (skipEffectLoadRef.current) {
      skipEffectLoadRef.current = false
      return
    }
    loadConversations()
    loadAvatarConfig(activeAvatarId)
  }, [activeAvatarId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectAvatar = async (avatarId: string) => {
    const seq = ++avatarSwitchSeqRef.current
    resetTransientState()
    skipEffectLoadRef.current = true
    setActiveAvatarId(avatarId)
    setActiveConversationId(null)
    clearMessages()

    try {
      const [, convs, avatars] = await Promise.all([
        loadAvatarConfig(avatarId),
        window.electronAPI.getConversations(avatarId),
        window.electronAPI.listAvatars(),
      ])

      if (avatarSwitchSeqRef.current !== seq) return
      setConversations(convs)
      setAvatarList(avatars)
      const avatar = avatars.find(a => a.id === avatarId)
      if (avatar) setActiveAvatarName(avatar.name)
    } catch (err) {
      console.error('[App] 切换分身失败:', err instanceof Error ? err.message : String(err))
      window.electronAPI.logEvent('error', 'select-avatar-error', err instanceof Error ? err.message : String(err))
    }
  }

  const handleAvatarCreated = async (avatarId: string) => {
    setActivePanel(null)
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
    resetTransientState()
    setActiveConversationId(id)
  }

  const handleDeleteConversation = async (id: string) => {
    try {
      await window.electronAPI.deleteConversation(id)
      await loadConversations()
      if (activeConversationId === id) {
        setActiveConversationId(null)
        clearMessages()
      }
    } catch (err) {
      console.error('[App] 删除会话失败:', err instanceof Error ? err.message : String(err))
      window.electronAPI.logEvent('error', 'delete-conversation-error', err instanceof Error ? err.message : String(err))
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
    { label: '人设', icon: '♦', key: 'soul', onClick: () => setActivePanel('soulEditor'), active: showSoulEditor },
    { label: '技能', icon: '★', key: 'skills', onClick: () => setActivePanel('skills'), active: showSkillsPanel },
    {
      label: '测试', icon: '▶', key: 'test',
      onClick: () => { setActivePanel('test'); setTestBadge(null) },
      active: showTestPanel, badge: testBadge?.failed,
    },
    { label: '知识库', icon: '◆', key: 'docs', onClick: () => setActivePanel('knowledge'), active: showKnowledgePanel },
    { label: '记忆', icon: '◇', key: 'mem', onClick: () => setActivePanel('memory'), active: showMemoryPanel },
    { label: '画像', icon: '●', key: 'user', onClick: () => setActivePanel('userProfile'), active: showUserProfilePanel },
    { label: '话术', icon: '□', key: 'tpl', onClick: () => setActivePanel('promptTemplate'), active: showPromptTemplatePanel },
    { label: '设置', icon: '✦', key: 'set', onClick: () => setActivePanel('settings'), active: showSettingsPanel },
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
                <AvatarImage avatarImage={avatar.avatarImage} name={avatar.name} size="md" className="flex-shrink-0" />
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
            onClick={() => setActivePanel('createWizard')}
            className="pixel-btn-primary px-6 py-3"
          >
            [+] 新建分身
          </button>
          <button
            onClick={() => setActivePanel('settings')}
            className="pixel-btn-outline-muted px-6 py-3"
          >
            设置
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="crt-scanlines" data-theme={themeId}>
      {!activeAvatarId ? (
        renderAvatarSelectPage()
      ) : (
        <Sidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          activeAvatarId={activeAvatarId}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          onNewConversation={handleNewConversation}
          isCreatingConversation={isCreatingConversation}
        >
          {activeConversationId ? (
            <div className="flex flex-col h-screen">
              {/* ── 更新提示横幅 ── */}
              {updateInfo && (
                <div className="flex items-center justify-between px-4 py-2 bg-px-primary/10 border-b border-px-primary/30 text-[12px]">
                  <span className="text-px-primary font-game tracking-wider">
                    NEW v{updateInfo.latestVersion} 可用
                    {updateInfo.releaseNotes && ` — ${updateInfo.releaseNotes.split('\n')[0].slice(0, 60)}`}
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => window.open(updateInfo.downloadUrl, '_blank')}
                      className="pixel-btn-sm text-[11px]"
                    >
                      下载更新
                    </button>
                    <button
                      onClick={() => setUpdateInfo(null)}
                      className="text-px-text-dim hover:text-px-text text-[11px]"
                    >
                      忽略
                    </button>
                  </div>
                </div>
              )}
              {/* ── 顶部操作栏 ── */}
              <div className="flex items-center justify-between px-5 py-2.5 bg-px-surface border-b-2 border-px-border">
                <div className="flex items-center gap-4">
                  <AvatarSelector
                    activeAvatarId={activeAvatarId}
                    onSelectAvatar={handleSelectAvatar}
                    onCreateAvatar={() => setActivePanel('createWizard')}
                    onAvatarsChanged={async () => {
                      await refreshAvatarList()
                    }}
                    showToast={showToast}
                  />
                </div>
                <PixelNavBar items={navButtons} />
              </div>
              <div className="flex-1 overflow-hidden">
                <ChatWindow
                  conversationId={activeConversationId}
                  avatarId={activeAvatarId}
                  onConversationUpdate={loadConversations}
                  visionModel={visionModel}
                  fillText={templateFillText}
                  avatarImage={avatarList.find(a => a.id === activeAvatarId)?.avatarImage}
                  avatarName={activeAvatarName}
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
          onClose={() => setActivePanel(null)}
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
          onClose={() => setActivePanel(null)}
          onCreated={handleAvatarCreated}
        />
      )}

      {showSettingsPanel && (
        <SettingsPanel
          activeAvatarId={activeAvatarId}
          onClose={() => setActivePanel(null)}
        />
      )}

      {showTestPanel && activeAvatarId && (
        <TestPanel
          avatarId={activeAvatarId}
          chatModel={chatModel}
          systemPrompt={systemPrompt}
          onClose={() => setActivePanel(null)}
        />
      )}

      {showSkillsPanel && activeAvatarId && (
        <SkillsPanel
          avatarId={activeAvatarId}
          onClose={() => setActivePanel(null)}
          onSkillsChanged={handleSkillsChanged}
        />
      )}

      {showMemoryPanel && activeAvatarId && (
        <MemoryPanel
          avatarId={activeAvatarId}
          onClose={() => setActivePanel(null)}
        />
      )}

      {showUserProfilePanel && activeAvatarId && (
        <UserProfilePanel
          avatarId={activeAvatarId}
          onClose={() => setActivePanel(null)}
        />
      )}

      {showPromptTemplatePanel && activeAvatarId && (
        <PromptTemplatePanel
          avatarId={activeAvatarId}
          onClose={() => setActivePanel(null)}
          onUse={(content) => {
            setTemplateFillText(content)
            setActivePanel(null)
            setTimeout(() => setTemplateFillText(undefined), 0)
          }}
        />
      )}

      {showSoulEditor && activeAvatarId && (
        <SoulEditorPanel
          avatarId={activeAvatarId}
          onClose={() => setActivePanel(null)}
          onSoulChanged={handleSoulChanged}
        />
      )}

      {toast && (
        <Toast message={toast.message} type={toast.type} />
      )}
    </div>
  )
}

export default App
