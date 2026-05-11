import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Sidebar from './components/Sidebar'
import ChatWindow from './components/ChatWindow'
import KnowledgePanel from './components/KnowledgePanel'
import SettingsPanel from './components/SettingsPanel'
import AvatarSelector from './components/AvatarSelector'
import CreateAvatarWizard from './components/CreateAvatarWizard'
import TestPanel from './components/TestPanel'
import SkillsPanel from './components/SkillsPanel'
import MemoryPanel from './components/MemoryPanel'
import LifePanel from './components/LifePanel'
import UserProfilePanel from './components/UserProfilePanel'
import SoulEditorPanel from './components/SoulEditorPanel'
import PromptTemplatePanel from './components/PromptTemplatePanel'
import SchedulesPanel from './components/SchedulesPanel'
import BatchRegressionPanel from './components/BatchRegressionPanel'
import ExpertPackPanel from './components/ExpertPackPanel'
import PixelNavBar from './components/PixelNavBar'
import AvatarImage from './components/AvatarImage'
import Toast from './components/shared/Toast'
import { useShallow } from 'zustand/react/shallow'
import { useThemeStore } from './stores/themeStore'
import { useChatStore } from './stores/chatStore'
import { localDateString, MEMORY_CHAR_LIMIT, MEMORY_WARN_THRESHOLD } from '@soul/core/browser'
import { ModelConfig, DEFAULT_CHAT_MODEL, DEFAULT_VISION_MODEL, DEFAULT_OCR_MODEL, DEFAULT_CREATION_MODEL, resolveCreationModel } from './services/llm-service'
import { registerSoulProxyApiBridge } from './services/proxy-api-bridge'
import { registerScheduleTriggerListener } from './services/schedule-trigger-handler'

function conversationProjectId(c: Conversation): string {
  return c.project_id && c.project_id.length > 0 ? c.project_id : 'default'
}

function getAvatarDomainTag(avatar: Avatar): string {
  const source = `${avatar.name} ${avatar.id}`.toLowerCase()
  if (source.includes('项目')) return '项目管理'
  if (source.includes('市场')) return '市场分析'
  if (source.includes('法务') || source.includes('legal')) return '法律合规'
  if (source.includes('hr')) return '人力资源'
  if (source.includes('产品')) return '产品策略'
  if (source.includes('电气') || source.includes('electrical')) return '电气工程'
  if (source.includes('财务') || source.includes('finance')) return '财务分析'
  if (source.includes('设计') || source.includes('design')) return '设计体验'
  if (source.includes('储') || source.includes('storage')) return '工商储能'
  return '专业分身'
}

function getAvatarFallbackAbility(avatar: Avatar): string {
  const tag = getAvatarDomainTag(avatar)
  switch (tag) {
    case '项目管理':
      return '项目计划、风险跟踪、里程碑与交付协同'
    case '市场分析':
      return '市场研究、竞品对比、趋势洞察与机会判断'
    case '法律合规':
      return '合同审阅、条款风险识别与合规草案建议'
    case '人力资源':
      return '制度解读、劳动关系沟通、招聘与绩效建议'
    case '产品策略':
      return '需求分析、PRD 拆解、指标设计与路线图规划'
    case '电气工程':
      return '图纸理解、标准核查、电气方案与技术答疑'
    case '财务分析':
      return '报表阅读、经营分析、预算测算与风险提示'
    case '设计体验':
      return '界面评审、体验优化、视觉系统与原型建议'
    case '工商储能':
      return '工商业储能方案设计、收益测算与政策解读'
    default:
      return '围绕专属知识库提供可追溯的专业问答与任务协作'
  }
}

function isInternalAvatarDescription(description: string): boolean {
  const normalized = description.toLowerCase()
  return [
    '行为准则',
    '灵魂文档',
    'soul.md',
    'agents.md',
    'claude.md',
    '模板',
    'g1-g4',
    '继承根目录',
    '请先阅读',
  ].some(keyword => normalized.includes(keyword.toLowerCase()))
}

function getAvatarAbilityDescription(avatar: Avatar): string {
  const description = avatar.description.trim()
  if (!description || isInternalAvatarDescription(description)) {
    return getAvatarFallbackAbility(avatar)
  }
  return description
}

function getAvatarSourceLabel(avatar: Avatar): string {
  const description = avatar.description.trim()
  if (!description) return '来源：默认能力画像'
  if (description.includes('soul.md') || description.includes('灵魂文档')) return '来源：灵魂文档'
  if (description.includes('AGENTS.md') || description.includes('CLAUDE.md') || description.includes('行为准则')) return '来源：行为准则'
  return '来源：能力描述'
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [activePanel, setActivePanel] = useState<
    'knowledge' | 'settings' | 'createWizard' | 'expertPacks' | 'test' | 'skills' | 'memory' | 'life' | 'userProfile' | 'soulEditor' | 'promptTemplate' | 'schedules' | 'batchRegression' | null
  >(null)
  const showKnowledgePanel = activePanel === 'knowledge'
  const showSettingsPanel = activePanel === 'settings'
  const showCreateWizard = activePanel === 'createWizard'
  const showExpertPackPanel = activePanel === 'expertPacks'
  const showTestPanel = activePanel === 'test'
  const showSkillsPanel = activePanel === 'skills'
  const showMemoryPanel = activePanel === 'memory'
  const showLifePanel = activePanel === 'life'
  const showUserProfilePanel = activePanel === 'userProfile'
  const showSoulEditor = activePanel === 'soulEditor'
  const showPromptTemplatePanel = activePanel === 'promptTemplate'
  const showSchedulesPanel = activePanel === 'schedules'
  const showBatchRegression = activePanel === 'batchRegression'
  const [templateFillText, setTemplateFillText] = useState<string | undefined>(undefined)
  const [activeAvatarId, setActiveAvatarId] = useState<string>('')
  /** Avatar 内二级项目（工作区 / 项目知识分区） */
  const [activeProjectId, setActiveProjectId] = useState<string>('default')
  const [knownProjectIds, setKnownProjectIds] = useState<string[]>(['default'])
  const [activeAvatarName, setActiveAvatarName] = useState<string>('')
  const [avatarList, setAvatarList] = useState<Avatar[]>([])
  const [toast, setToast] = useState<{ message: string; type?: 'success' | 'error'; onClick?: () => void } | null>(null)
  const [updateInfo, setUpdateInfo] = useState<{ latestVersion: string; downloadUrl: string; releaseNotes?: string } | null>(null)

  const [visionModel, setVisionModel] = useState<ModelConfig>(DEFAULT_VISION_MODEL)
  const [ocrModel, setOcrModel] = useState<ModelConfig>(DEFAULT_OCR_MODEL)
  const [creationModel, setCreationModel] = useState<ModelConfig>(DEFAULT_CREATION_MODEL)

  const [, setTestBadge] = useState<{ failed: number } | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const cronMemoryRunningRef = useRef(false)
  const cronKnowledgeRunningRef = useRef(false)
  const avatarSwitchSeqRef = useRef(0)
  const skipEffectLoadRef = useRef(false)
  /** TEST CENTER 落盘最新报告后递增，驱动顶栏质量勋章刷新 */
  const [qualityReportNonce, setQualityReportNonce] = useState(0)

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

  useEffect(() => {
    const off = registerSoulProxyApiBridge()
    return off
  }, [])

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

  /**
   * 显示可点击的 Toast（Phase 4 新增）。
   * 点击后立即关闭 Toast 并触发 onClick 回调（如打开 LifePanel）。
   * 显示时长 5s（比普通 Toast 长，给用户点击时间）。
   */
  const showClickableToast = useCallback((message: string, onClick: () => void, type: 'success' | 'error' = 'success') => {
    const handleClick = () => {
      clearTimeout(toastTimerRef.current)
      setToast(null)
      onClick()
    }
    setToast({ message, type, onClick: handleClick })
    clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 5000)
  }, [])

  const loadConversations = useCallback(async () => {
    if (!activeAvatarId) return
    try {
      const convs = await window.electronAPI.getConversations(activeAvatarId)
      setConversations(convs)
      const ids = await window.electronAPI.listProjectIds(activeAvatarId)
      const next = ids.length > 0 ? ids : ['default']
      setKnownProjectIds(next)
      setActiveProjectId((p) => (next.includes(p) ? p : 'default'))
    } catch (err) {
      console.error('[App] 加载会话列表失败:', err)
      window.electronAPI.logEvent('error', 'load-conversations-error', err instanceof Error ? err.message : String(err))
    }
  }, [activeAvatarId])

  const loadAvatarConfig = useCallback(async (avatarId: string, projectId?: string) => {
    if (!avatarId) return
    try {
      const pidArg = projectId && projectId !== 'default' ? projectId : undefined
      const config = await window.electronAPI.loadAvatar(avatarId, pidArg)
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

    // 用户自定义定时任务触发监听器（#11 Scheduled Tasks）
    const removeScheduleTrigger = registerScheduleTriggerListener()

    return () => {
      window.removeEventListener('settings-updated', handleSettingsUpdate)
      removeScheduledTest?.()
      removeTestBadge?.()
      removeCronMemory?.()
      removeCronKnowledge?.()
      removeScheduleTrigger?.()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeAvatarId) return
    // handleSelectAvatar 已完成数据拉取时跳过，避免双重请求竞态
    if (skipEffectLoadRef.current) {
      skipEffectLoadRef.current = false
      return
    }
    void loadConversations()
  }, [activeAvatarId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeAvatarId) return
    void loadAvatarConfig(activeAvatarId, activeProjectId)
  }, [activeAvatarId, activeProjectId, loadAvatarConfig])

  const handleSelectAvatar = async (avatarId: string) => {
    const seq = ++avatarSwitchSeqRef.current
    resetTransientState()
    skipEffectLoadRef.current = true
    setActiveAvatarId(avatarId)
    setActiveProjectId('default')
    setActiveConversationId(null)
    clearMessages()

    try {
      const [, convs, avatars] = await Promise.all([
        loadAvatarConfig(avatarId, 'default'),
        window.electronAPI.getConversations(avatarId),
        window.electronAPI.listAvatars(),
      ])

      if (avatarSwitchSeqRef.current !== seq) return
      setConversations(convs)
      const ids = await window.electronAPI.listProjectIds(avatarId)
      setKnownProjectIds(ids.length > 0 ? ids : ['default'])
      setAvatarList(avatars)
      const avatar = avatars.find(a => a.id === avatarId)
      if (avatar) setActiveAvatarName(avatar.name)
    } catch (err) {
      console.error('[App] 切换分身失败:', err instanceof Error ? err.message : String(err))
      window.electronAPI.logEvent('error', 'select-avatar-error', err instanceof Error ? err.message : String(err))
    }
  }

  const handleAvatarCreated = async (avatarId: string, lifeStarted: boolean) => {
    setActivePanel(null)
    await handleSelectAvatar(avatarId)
    if (lifeStarted) {
      // Phase 4：人生生成已异步启动，提示用户去 LifePanel 看进度
      showClickableToast(
        '分身正在经历人生，可在「人生」面板查看进度',
        () => setActivePanel('life'),
        'success',
      )
    }
  }

  const handleExpertPackInstalled = async (avatarId: string) => {
    await refreshAvatarList()
    await handleSelectAvatar(avatarId)
  }

  // 并发锁：防止双击或同时点击两个"新建对话"按钮导致重复创建
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)

  const handleNewConversation = async () => {
    if (!activeAvatarId || isCreatingConversation) return
    setIsCreatingConversation(true)
    try {
      const id = await window.electronAPI.createConversation('新对话', activeAvatarId, activeProjectId)
      await loadConversations()
      setActiveConversationId(id)
      clearMessages()
    } finally {
      setIsCreatingConversation(false)
    }
  }

  const handleProjectChange = (projectId: string) => {
    setActiveProjectId(projectId)
  }

  const handleCreateProjectId = () => {
    if (!activeAvatarId) return
    const raw = window.prompt('新项目 ID（字母、数字、下划线、连字符；将用于工作区与知识子目录）', '')
    if (raw === null) return
    const id = raw.trim()
    if (!id) return
    if (!/^[\w-]+$/.test(id)) {
      showToast('项目 ID 仅允许字母数字下划线与连字符', 'error')
      return
    }
    setKnownProjectIds((prev) => [...new Set([...prev, id])].sort())
    setActiveProjectId(id)
    showToast(`已切换到项目「${id}」，新建对话将归入该项目`)
  }

  const handleSelectConversation = (id: string) => {
    resetTransientState()
    const conv = conversations.find((c) => c.id === id)
    const pid = conv?.project_id && conv.project_id.length > 0 ? conv.project_id : 'default'
    setActiveProjectId(pid)
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
    await loadAvatarConfig(activeAvatarId, activeProjectId)
    showToast('技能已更新，上下文已刷新')
  }, [activeAvatarId, activeProjectId, loadAvatarConfig, showToast])

  const handleKnowledgeSaved = useCallback(async () => {
    if (!activeAvatarId) return
    await loadAvatarConfig(activeAvatarId, activeProjectId)
    showToast('知识已保存，上下文已刷新')
  }, [activeAvatarId, activeProjectId, loadAvatarConfig, showToast])

  const handleSoulChanged = useCallback(async () => {
    if (!activeAvatarId) return
    await loadAvatarConfig(activeAvatarId, activeProjectId)
    showToast('人格已保存，上下文已刷新')
  }, [activeAvatarId, activeProjectId, loadAvatarConfig, showToast])

  /** 顶栏导航按钮 */
  const sidebarConversations = useMemo(
    () => conversations.filter((c) => conversationProjectId(c) === activeProjectId),
    [conversations, activeProjectId],
  )

  const navButtons = [
    { label: '人设', icon: '♦', key: 'soul', onClick: () => setActivePanel('soulEditor'), active: showSoulEditor },
    { label: '技能', icon: '★', key: 'skills', onClick: () => setActivePanel('skills'), active: showSkillsPanel },
    { label: '知识库', icon: '◆', key: 'docs', onClick: () => setActivePanel('knowledge'), active: showKnowledgePanel },
    { label: '记忆', icon: '◇', key: 'mem', onClick: () => setActivePanel('memory'), active: showMemoryPanel },
    { label: '人生', icon: '❀', key: 'life', onClick: () => setActivePanel('life'), active: showLifePanel },
    { label: '画像', icon: '●', key: 'user', onClick: () => setActivePanel('userProfile'), active: showUserProfilePanel },
    { label: '话术', icon: '□', key: 'tpl', onClick: () => setActivePanel('promptTemplate'), active: showPromptTemplatePanel },
    { label: '定时', icon: '◐', key: 'sched', onClick: () => setActivePanel('schedules'), active: showSchedulesPanel },
    { label: '设置', icon: '✦', key: 'set', onClick: () => setActivePanel('settings'), active: showSettingsPanel },
  ]

  /** 未选择分身时的引导页 */
  const renderAvatarSelectPage = () => (
    <div className="min-h-screen bg-px-bg relative overflow-y-auto">
      <div className="absolute inset-0 pixel-grid opacity-50" />
      <div className="absolute left-1/2 top-10 h-64 w-[560px] -translate-x-1/2 rounded-full bg-px-primary/10 blur-3xl" />

      <div className="w-full max-w-6xl mx-auto px-8 py-8 relative z-10 animate-fade-in">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-8">
          <div className="flex items-center gap-4 text-left">
            <div className="inline-flex items-center justify-center w-16 h-16 border-2 border-px-primary bg-px-primary/10 shadow-pixel-glow">
              <span className="font-game text-[20px] text-px-primary leading-none">S</span>
            </div>
            <div>
              <div className="font-game text-[20px] text-px-primary tracking-widest">
                SOUL DESKTOP
              </div>
              <p className="font-game text-[13px] text-px-text-sec tracking-wider mt-2">
                选择一个 AI 专家，进入对应工作台
              </p>
              <div className="flex items-center gap-3 mt-3 font-game text-[10px] text-px-text-dim tracking-wider">
                <span className="border border-px-border-dim px-2 py-1">专家 {avatarList.length}</span>
                <span className="border border-px-border-dim px-2 py-1">工作台 READY</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 md:pb-1">
            <button
              onClick={() => setActivePanel('createWizard')}
              className="pixel-btn-primary px-5 py-3"
            >
              [+] 新建分身
            </button>
            <button
              onClick={() => setActivePanel('expertPacks')}
              className="pixel-btn-outline-muted px-5 py-3"
            >
              专家包
            </button>
            <button
              onClick={() => setActivePanel('settings')}
              className="pixel-btn-outline-muted px-5 py-3"
            >
              设置
            </button>
          </div>
        </div>

        {avatarList.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {avatarList.map((avatar) => (
              <button
                key={avatar.id}
                onClick={() => handleSelectAvatar(avatar.id)}
                className="group w-full min-h-[150px] flex flex-col justify-between px-5 py-4 border-2 border-px-border bg-px-surface/95
                  hover:border-px-primary hover:bg-px-primary/5 hover:shadow-pixel-glow transition-none text-left"
              >
                <div className="flex items-start gap-4">
                  <AvatarImage avatarImage={avatar.avatarImage} name={avatar.name} size="md" className="flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-game text-[15px] text-px-text font-bold leading-snug line-clamp-2">{avatar.name}</p>
                      <span className="font-game text-[12px] text-px-text-dim group-hover:text-px-primary">&gt;</span>
                    </div>
                    <p className="font-game text-[12px] text-px-text-dim mt-2 line-clamp-2">{getAvatarAbilityDescription(avatar)}</p>
                  </div>
                </div>

                <div className="mt-5 pt-3 border-t border-px-border-dim/70">
                  <div className="mb-3 font-game text-[10px] text-px-text-dim/80 truncate">
                    {getAvatarSourceLabel(avatar)}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-game text-[10px] text-px-primary border border-px-primary/60 px-2 py-1 whitespace-nowrap">
                        {getAvatarDomainTag(avatar)}
                      </span>
                      <span className="font-game text-[10px] text-px-text-dim border border-px-border-dim px-2 py-1 whitespace-nowrap">
                        可用
                      </span>
                    </div>
                    <span className="font-game text-[10px] text-px-text-dim tabular-nums whitespace-nowrap">
                      {localDateString(new Date(avatar.createdAt))}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="border-2 border-dashed border-px-border bg-px-surface/70 px-8 py-14 text-center">
            <p className="font-game text-[15px] text-px-text tracking-wider">暂无分身</p>
            <p className="font-game text-[12px] text-px-text-dim mt-3">先创建一个专家分身，首页会自动生成专家矩阵。</p>
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div className="crt-scanlines" data-theme={themeId}>
      {!activeAvatarId ? (
        renderAvatarSelectPage()
      ) : (
        <Sidebar
          conversations={sidebarConversations}
          activeConversationId={activeConversationId}
          activeAvatarId={activeAvatarId}
          activeProjectId={activeProjectId}
          knownProjectIds={knownProjectIds}
          onProjectChange={handleProjectChange}
          onCreateProjectId={handleCreateProjectId}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          onNewConversation={handleNewConversation}
          isCreatingConversation={isCreatingConversation}
        >
          {activeConversationId ? (
            <div className="flex flex-col h-screen min-w-0">
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
              <div className="grid grid-cols-[240px_minmax(0,1fr)] items-center gap-3 px-5 py-2.5 bg-px-surface border-b-2 border-px-border min-w-0">
                <div className="relative z-30 w-[240px] max-w-[240px]">
                  <AvatarSelector
                    activeAvatarId={activeAvatarId}
                    onSelectAvatar={handleSelectAvatar}
                    onCreateAvatar={() => setActivePanel('createWizard')}
                    onAvatarsChanged={async () => {
                      await refreshAvatarList()
                    }}
                    showToast={showToast}
                    qualityRefreshNonce={qualityReportNonce}
                  />
                </div>
                <div className="min-w-0 flex justify-end">
                  <PixelNavBar items={navButtons} />
                </div>
              </div>
              <div className="flex-1 min-w-0 overflow-hidden">
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
          onOpenSettings={() => setActivePanel('settings')}
        />
      )}

      {showExpertPackPanel && (
        <ExpertPackPanel
          onClose={() => setActivePanel(null)}
          onInstalled={handleExpertPackInstalled}
          onOpenAvatar={handleSelectAvatar}
          showToast={showToast}
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
          onReportSaved={() => setQualityReportNonce((v) => v + 1)}
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

      {showLifePanel && activeAvatarId && (
        <LifePanel
          avatarId={activeAvatarId}
          avatarName={activeAvatarName || activeAvatarId}
          hasChatApiKey={Boolean(chatModel.apiKey)}
          hasCreationApiKey={Boolean(creationModel.apiKey)}
          onClose={() => setActivePanel(null)}
          onToast={showToast}
          onOpenSettings={() => setActivePanel('settings')}
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

      {showSchedulesPanel && activeAvatarId && (
        <SchedulesPanel
          avatarId={activeAvatarId}
          onClose={() => setActivePanel(null)}
        />
      )}

      {showSoulEditor && activeAvatarId && (
        <SoulEditorPanel
          avatarId={activeAvatarId}
          onClose={() => setActivePanel(null)}
          onSoulChanged={handleSoulChanged}
        />
      )}

      {showBatchRegression && activeAvatarId && (
        <BatchRegressionPanel
          avatarId={activeAvatarId}
          avatarName={activeAvatarName}
          onClose={() => setActivePanel(null)}
        />
      )}

      {toast && (
        <Toast message={toast.message} type={toast.type} onClick={toast.onClick} />
      )}
    </div>
  )
}

export default App
