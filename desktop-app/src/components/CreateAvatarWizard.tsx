import { useState, useRef, useEffect } from 'react'
import { LLMService, ModelConfig } from '../services/llm-service'
import { generateSoulStepByStep, StepProgress } from '../services/soul-step-generator'
import { validateSoulContent, ValidationResult } from '../services/soul-validator'

interface Props {
  chatModel: ModelConfig
  creationModel: ModelConfig
  onClose: () => void
  onCreated: (avatarId: string) => void
}

interface KnowledgeFile {
  name: string
  content: string
}

interface CustomSkill {
  name: string
  content: string
}

const STEPS = [
  { en: '01', zh: '基本信息' },
  { en: '02', zh: '人格定义' },
  { en: '03', zh: '知识库' },
  { en: '04', zh: '技能定义' },
  { en: '05', zh: '确认创建' },
]

export default function CreateAvatarWizard({ chatModel, creationModel, onClose, onCreated }: Props) {
  const [currentStep, setCurrentStep] = useState(0)

  const [avatarName, setAvatarName] = useState('')
  const [avatarDescription, setAvatarDescription] = useState('')
  const [personalityInput, setPersonalityInput] = useState('')
  const [soulContent, setSoulContent] = useState('')
  const [isGeneratingSoul, setIsGeneratingSoul] = useState(false)
  const [soulProgress, setSoulProgress] = useState<StepProgress | null>(null)
  const [soulValidation, setSoulValidation] = useState<ValidationResult | null>(null)
  const [knowledgeFiles, setKnowledgeFiles] = useState<KnowledgeFile[]>([])
  const [newFileName, setNewFileName] = useState('')
  const [newFileContent, setNewFileContent] = useState('')
  const [skillInput, setSkillInput] = useState('')
  const [customSkills, setCustomSkills] = useState<CustomSkill[]>([])
  const [isGeneratingSkill, setIsGeneratingSkill] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const mountedRef = useRef(true)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(statusTimerRef.current)
    }
  }, [])

  const showStatus = (msg: string) => {
    if (!mountedRef.current) return
    setStatusMsg(msg)
    clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setStatusMsg('')
    }, 3000)
  }

  const handleGenerateSoul = async () => {
    const soulModel = creationModel.apiKey ? creationModel : chatModel
    if (!personalityInput.trim() || !soulModel.apiKey) return
    setIsGeneratingSoul(true)
    setSoulValidation(null)
    setSoulProgress(null)

    try {
      const result = await generateSoulStepByStep(
        avatarName,
        `${personalityInput}\n${avatarDescription ? `补充说明：${avatarDescription}` : ''}`,
        soulModel,
        (progress) => { if (mountedRef.current) setSoulProgress(progress) },
        (content) => { if (mountedRef.current) setSoulContent(content) },
      )

      if (!mountedRef.current) return
      setSoulValidation(result.validation)

      if (result.supplemented) {
        showStatus(`已自动补全 ${result.validation.missing.length > 0 ? '部分' : '全部'}缺失项`)
      }
    } catch (error) {
      showStatus(`生成失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (mountedRef.current) {
        setIsGeneratingSoul(false)
        setSoulProgress(null)
      }
    }
  }

  const handleValidateSoul = () => {
    if (!soulContent.trim()) return
    const result = validateSoulContent(soulContent)
    setSoulValidation(result)
  }

  const handleGenerateSkill = async () => {
    const skillModel = creationModel.apiKey ? creationModel : chatModel
    if (!skillInput.trim() || !skillModel.apiKey) return
    setIsGeneratingSkill(true)
    const llm = new LLMService(skillModel)
    let result = ''

    let systemPrompt = ''
    try {
      systemPrompt = await window.electronAPI.getSkillCreationPrompt()
    } catch (e) {
      console.error('[CreateAvatar] 获取技能模板 system prompt 失败，使用降级方案', e)
    }

    const userPrompt = `请根据以下描述，为分身「${avatarName}」生成一份技能定义文件：

${skillInput}`

    const messages: Array<{ role: 'system' | 'user'; content: string }> = []
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    messages.push({ role: 'user', content: userPrompt })

    await llm.chat(
      messages,
      (chunk) => { result += chunk },
      () => {
        if (!mountedRef.current) return
        const nameMatch = result.match(/^#\s+(.+)$/m)
        const skillName = nameMatch ? nameMatch[1].trim() : '自定义技能'
        const fileName = skillName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5-]/g, '-').toLowerCase() + '.md'
        setCustomSkills(prev => [...prev, { name: fileName, content: result }])
        setSkillInput('')
        setIsGeneratingSkill(false)
      },
      (error) => {
        if (!mountedRef.current) return
        showStatus(`生成失败: ${error.message}`)
        setIsGeneratingSkill(false)
      }
    )
  }

  const handleAddKnowledgeFile = () => {
    if (!newFileName.trim() || !newFileContent.trim()) return
    const fileName = newFileName.endsWith('.md') ? newFileName : `${newFileName}.md`
    setKnowledgeFiles(prev => [...prev, { name: fileName, content: newFileContent }])
    setNewFileName('')
    setNewFileContent('')
  }

  const handleCreate = async () => {
    setIsCreating(true)
    try {
      const avatarId = avatarName
        .replace(/[^a-zA-Z0-9\u4e00-\u9fa5-]/g, '-')
        .toLowerCase()
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        || `avatar-${Date.now()}`

      await window.electronAPI.createAvatar(avatarId, soulContent, [], knowledgeFiles)
      if (!mountedRef.current) return

      for (const skill of customSkills) {
        await window.electronAPI.writeSkillFile(avatarId, skill.name, skill.content)
        if (!mountedRef.current) return
      }

      if (mountedRef.current) onCreated(avatarId)
    } catch (error) {
      if (!mountedRef.current) return
      console.error('创建分身失败:', error)
      showStatus('创建失败，请重试')
    } finally {
      if (mountedRef.current) setIsCreating(false)
    }
  }

  const canProceed = () => {
    switch (currentStep) {
      case 0: return avatarName.trim().length > 0
      case 1: return soulContent.trim().length > 0
      default: return true
    }
  }

  const getProgressText = (): string => {
    if (!soulProgress) return '生成中...'
    const { currentStep: step, totalSteps, stepName, phase } = soulProgress
    const phaseLabel = phase === 'generating' ? '生成中'
      : phase === 'validating' ? '校验中'
      : phase === 'supplementing' ? '补全中'
      : '完成'
    return `[${step}/${totalSteps}] ${stepName} · ${phaseLabel}`
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-[2px] flex items-center justify-center z-50 animate-fade-in">
      <div className="bg-px-surface border-2 border-px-border shadow-pixel-glow w-[800px] max-h-[90vh] flex flex-col animate-pixel-expand">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 bg-px-bg text-px-text border-b-2 border-px-border">
          <div className="flex items-center gap-3">
            <div className="w-1.5 h-6 bg-px-primary" />
            <div>
              <h2 className="font-game text-[14px] tracking-wider">创建分身</h2>
              {statusMsg && <p className="font-game text-[13px] text-px-danger mt-0.5">{statusMsg}</p>}
            </div>
          </div>
          <button onClick={onClose} className="pixel-close-btn">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="square" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 步骤指示器 */}
        <div className="flex items-center px-6 py-3 border-b-2 border-px-border bg-px-elevated overflow-x-auto">
          {STEPS.map((step, index) => (
            <div key={step.en} className="flex items-center flex-shrink-0">
              <div className={`flex items-center gap-2 ${index <= currentStep ? 'text-px-text' : 'text-px-text-dim'}`}>
                <div className={`w-7 h-7 border-2 flex items-center justify-center font-game text-[12px]
                  ${index < currentStep ? 'bg-px-primary border-px-primary text-px-bg'
                  : index === currentStep ? 'border-px-primary text-px-primary'
                  : 'border-px-border text-px-text-dim'}`}>
                  {index < currentStep ? '✓' : index + 1}
                </div>
                <span className="font-game text-[14px] hidden sm:block">{step.zh}</span>
              </div>
              {index < STEPS.length - 1 && (
                <div className={`w-6 h-0.5 mx-2 ${index < currentStep ? 'bg-px-primary' : 'bg-px-border'}`} />
              )}
            </div>
          ))}
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
          {currentStep === 0 && (
            <div className="space-y-5 max-w-lg">
              <div>
                <label className="pixel-label">分身名称 *</label>
                <input type="text" value={avatarName} onChange={(e) => setAvatarName(e.target.value)}
                  placeholder="例如：小李 — 光伏专家" className="pixel-input w-full" />
              </div>
              <div>
                <label className="pixel-label">一句话描述</label>
                <input type="text" value={avatarDescription} onChange={(e) => setAvatarDescription(e.target.value)}
                  placeholder="例如：专注光伏电站设计与收益测算" className="pixel-input w-full" />
                <p className="mt-1 font-game text-[12px] text-px-text-dim">会作为补充信息传给 AI，帮助生成更贴合的人格定义。不填也不影响创建。</p>
              </div>
            </div>
          )}

          {currentStep === 1 && (
            <div className="space-y-5">
              <p className="font-game text-[14px] text-px-text-sec">必填。用自然语言描述分身人格，AI 生成灵魂文档。创建后可在「人格」面板中继续编辑。</p>
              <div>
                <label className="pixel-label">用自然语言描述分身人格</label>
                <textarea value={personalityInput} onChange={(e) => setPersonalityInput(e.target.value)}
                  placeholder="例如：我想创建一个光伏电站设计专家，叫小李。严谨专业，喜欢用数据说话..."
                  className="pixel-input w-full" rows={4} />
                <button onClick={handleGenerateSoul}
                  disabled={isGeneratingSoul || !personalityInput.trim() || !(creationModel.apiKey || chatModel.apiKey)}
                  className="mt-2 pixel-btn-primary">
                  {isGeneratingSoul ? getProgressText() : '生成'}
                </button>
                {creationModel.apiKey && (
                  <p className="mt-1 font-game text-[12px] text-px-text-dim">模型: {creationModel.model}</p>
                )}
                {!(creationModel.apiKey || chatModel.apiKey) && (
                  <p className="mt-1 font-game text-[12px] text-px-danger">请先在设置中配置 API Key</p>
                )}
              </div>

              {/* 生成进度条 */}
              {isGeneratingSoul && soulProgress && (
                <div className="border-2 border-px-border p-4 bg-px-elevated">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-game text-[12px] text-px-primary tracking-wider">
                      步骤 {soulProgress.currentStep}/{soulProgress.totalSteps}
                    </span>
                    <span className="font-game text-[14px] text-px-text-sec">{soulProgress.stepName}</span>
                  </div>
                  <div className="w-full h-2 border-2 border-px-border bg-px-bg">
                    <div
                      className="h-full bg-px-primary transition-none"
                      style={{ width: `${(soulProgress.currentStep / soulProgress.totalSteps) * 100}%` }}
                    />
                  </div>
                  <div className="mt-1.5 font-game text-[12px] text-px-text-dim">
                    {soulProgress.phase === 'generating' && '正在生成...'}
                    {soulProgress.phase === 'validating' && '校验结构完整性...'}
                    {soulProgress.phase === 'supplementing' && '自动补全缺失项...'}
                    {soulProgress.phase === 'done' && '生成完成'}
                  </div>
                </div>
              )}

              {/* 校验结果 */}
              {soulValidation && !isGeneratingSoul && (
                <div className={`border-2 p-4 ${soulValidation.isValid ? 'border-px-success bg-px-success/5' : 'border-px-warning bg-px-warning/5'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-game text-[12px] tracking-wider text-px-text">
                      {soulValidation.isValid ? '通过' : '警告'}
                    </span>
                    <span className="font-game text-[14px] text-px-text-sec">
                      {soulValidation.score}%
                    </span>
                  </div>
                  {soulValidation.missing.length > 0 && (
                    <ul className="space-y-1">
                      {soulValidation.missing.map((item) => (
                        <li key={item.id} className="font-game text-[14px] flex items-start gap-2">
                          <span className={item.severity === 'critical' ? 'text-px-danger' : 'text-px-warning'}>
                            {item.severity === 'critical' ? '✗' : '!'}
                          </span>
                          <span className="text-px-text-sec">
                            [{item.chapter}] {item.description}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {soulContent && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="pixel-label mb-0">生成结果（可编辑）</label>
                    <div className="flex items-center gap-3">
                      <button onClick={handleValidateSoul}
                        className="font-game text-[12px] text-px-primary hover:underline tracking-wider">
                        校验
                      </button>
                      <span className="font-game text-[12px] text-px-text-dim">{soulContent.length} 字</span>
                    </div>
                  </div>
                  <textarea value={soulContent} onChange={(e) => { setSoulContent(e.target.value); setSoulValidation(null) }}
                    className="pixel-input w-full font-mono text-[14px]" rows={15} />
                </div>
              )}
            </div>
          )}

          {currentStep === 2 && (
            <div className="space-y-5">
              <p className="font-game text-[14px] text-px-text-sec">添加知识文件。可跳过，后续在知识库管理中添加。</p>
              {knowledgeFiles.length > 0 && (
                <div className="space-y-2">
                  {knowledgeFiles.map((file, index) => (
                    <div key={index} className="flex items-center justify-between p-3 bg-px-elevated border-2 border-px-border">
                      <span className="font-game text-[14px] font-medium text-px-text">{file.name}</span>
                      <button onClick={() => setKnowledgeFiles(prev => prev.filter((_, i) => i !== index))}
                        className="font-game text-[12px] text-px-danger hover:underline tracking-wider">删除</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-2 border-px-border p-4 space-y-3 bg-px-elevated">
                <input type="text" value={newFileName} onChange={(e) => setNewFileName(e.target.value)}
                  placeholder="文件名，例如：policy.md" className="pixel-input w-full" />
                <textarea value={newFileContent} onChange={(e) => setNewFileContent(e.target.value)}
                  placeholder="粘贴知识内容（Markdown 格式）..."
                  className="pixel-input w-full" rows={8} />
                <button onClick={handleAddKnowledgeFile}
                  disabled={!newFileName.trim() || !newFileContent.trim()}
                  className="pixel-btn-primary">[+] 添加</button>
              </div>
            </div>
          )}

          {currentStep === 3 && (
            <div className="space-y-5">
              <div className="space-y-1">
                <p className="font-game text-[14px] text-px-text-sec">用自然语言描述技能，AI 自动生成。可跳过，后续在技能面板中添加。</p>
                <div className="font-game text-[12px] text-px-text-dim space-y-0.5 pl-3 border-l-2 border-px-border">
                  <p>描述时建议包含：</p>
                  <p>· 技能名称和用途（做什么）</p>
                  <p>· 触发关键词（用户说什么时激活，如"算收益""回收期"）</p>
                  <p>· 必须参数（用户必须提供的信息，如储能容量、所在地区）</p>
                  <p>· 可选参数（有则更好，如投资金额、充放电策略）</p>
                  <p>· 执行逻辑（大致的计算/分析步骤）</p>
                </div>
              </div>
              {customSkills.length > 0 && (
                <div className="space-y-2">
                  {customSkills.map((skill, index) => (
                    <div key={index} className="flex items-center justify-between p-3 bg-px-elevated border-2 border-px-border">
                      <span className="font-game text-[14px] font-medium text-px-text">{skill.name}</span>
                      <button onClick={() => setCustomSkills(prev => prev.filter((_, i) => i !== index))}
                        className="font-game text-[12px] text-px-danger hover:underline tracking-wider">删除</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-2 border-px-border p-4 space-y-3 bg-px-elevated">
                <textarea value={skillInput} onChange={(e) => setSkillInput(e.target.value)}
                  placeholder={`例如：我需要一个收益测算技能。\n当用户提到"收益测算""算收益""回收期""IRR"时触发。\n用户需要提供：储能容量（必须）、所在地区（必须）、投资金额（可选）、充放电策略（可选）。\n执行流程：确定投资参数 → 计算峰谷套利收益 → 计算财务指标 → 敏感性分析，输出乐观/中性/保守三档。`}
                  className="pixel-input w-full" rows={5} />
                <button onClick={handleGenerateSkill}
                  disabled={isGeneratingSkill || !skillInput.trim() || !(creationModel.apiKey || chatModel.apiKey)}
                  className="pixel-btn-primary">
                  {isGeneratingSkill ? '...' : '生成'}
                </button>
              </div>
            </div>
          )}

          {currentStep === 4 && (
            <div className="space-y-5 max-w-lg">
              <div className="border-l-3 border-px-primary pl-4 py-1">
                <h3 className="font-game text-[14px] text-px-text tracking-wider">确认创建</h3>
                <p className="font-game text-[13px] text-px-text-sec mt-1">检查以下信息，确认无误后点击创建</p>
              </div>

              <div className="bg-px-elevated border-2 border-px-border p-5 space-y-3 font-game text-[14px]">
                {[
                  ['名称', avatarName],
                  ['描述', avatarDescription || '（未填写）'],
                  ['人格定义', `${soulContent.length} 字`],
                  ['知识文件', `${knowledgeFiles.length} 个`],
                  ['自定义技能', `${customSkills.length} 个`],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between py-1 border-b border-px-border last:border-b-0">
                    <span className="text-px-text-sec">{label}</span>
                    <span className="font-medium text-px-text">{value}</span>
                  </div>
                ))}
              </div>

              {soulValidation && (
                <div className={`border-l-3 p-4 bg-px-elevated ${soulValidation.isValid ? 'border-l-px-success' : 'border-l-px-warning'}`}>
                  <p className="font-game text-[14px] text-px-text-sec">
                    完整度: {soulValidation.score}%
                    {soulValidation.isValid ? ' — 完成' : ` — ${soulValidation.missing.length} 项缺失`}
                  </p>
                </div>
              )}

              <div className="border-l-3 border-l-px-accent p-4 bg-px-elevated">
                <p className="font-game text-[13px] text-px-text-sec">
                  自动生成: CLAUDE.md / soul.md / knowledge/README.md / memory/MEMORY.md
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between px-6 py-4 border-t-2 border-px-border bg-px-elevated">
          <button
            onClick={() => currentStep > 0 ? setCurrentStep(currentStep - 1) : onClose()}
            className="pixel-btn-outline-muted"
          >
            {currentStep > 0 ? '上一步' : '取消'}
          </button>

          {currentStep < STEPS.length - 1 ? (
            <button
              onClick={() => setCurrentStep(currentStep + 1)}
              disabled={!canProceed()}
              className="pixel-btn-primary"
            >
              下一步
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="pixel-btn-primary"
            >
              {isCreating ? '...' : '创建'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
