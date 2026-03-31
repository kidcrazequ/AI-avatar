import { useState } from 'react'
import { LLMService, ModelConfig } from '../services/llm-service'

interface Props {
  chatModel: ModelConfig
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

const STEPS = ['基本信息', '人格定义', '知识库', '技能定义', '预览与创建']

export default function CreateAvatarWizard({ chatModel, onClose, onCreated }: Props) {
  const [currentStep, setCurrentStep] = useState(0)

  const [avatarName, setAvatarName] = useState('')
  const [avatarDescription, setAvatarDescription] = useState('')
  const [personalityInput, setPersonalityInput] = useState('')
  const [soulContent, setSoulContent] = useState('')
  const [isGeneratingSoul, setIsGeneratingSoul] = useState(false)
  const [knowledgeFiles, setKnowledgeFiles] = useState<KnowledgeFile[]>([])
  const [newFileName, setNewFileName] = useState('')
  const [newFileContent, setNewFileContent] = useState('')
  const [skillInput, setSkillInput] = useState('')
  const [customSkills, setCustomSkills] = useState<CustomSkill[]>([])
  const [isGeneratingSkill, setIsGeneratingSkill] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')

  const showStatus = (msg: string) => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(''), 3000)
  }

  const handleGenerateSoul = async () => {
    if (!personalityInput.trim() || !chatModel.apiKey) return
    setIsGeneratingSoul(true)
    const llm = new LLMService(chatModel)
    let result = ''

    const prompt = `请根据以下描述，生成一份完整的 AI 分身灵魂文档（soul.md）。

用户描述：
${personalityInput}

分身名称：${avatarName}

请严格按以下格式生成（直接输出 Markdown，不要加代码块标记）：

# ${avatarName}灵魂文档

## 1. Identity — 我是谁
## 2. Background — 我的专业背景
## 3. Style — 我怎么说话
### 说话方式
### 口头禅
## 4. Principles — 我的原则
## 5. Workflow — 我怎么工作
## 6. Commitment — 我的承诺`

    await llm.chat(
      [{ role: 'user', content: prompt }],
      (chunk) => { result += chunk; setSoulContent(result) },
      () => setIsGeneratingSoul(false),
      (error) => { showStatus(`生成失败: ${error.message}`); setIsGeneratingSoul(false) }
    )
  }

  const handleGenerateSkill = async () => {
    if (!skillInput.trim() || !chatModel.apiKey) return
    setIsGeneratingSkill(true)
    const llm = new LLMService(chatModel)
    let result = ''

    const prompt = `请根据以下描述，生成一份 AI 分身技能定义文件。

用户描述：
${skillInput}

请按以下格式生成（直接输出 Markdown，不要加代码块标记）：

# 技能名称

> **级别**：🟢 基础
> **版本**：v1.0

## 技能说明
## 触发条件
## 输入
## 执行流程
## 输出格式
## 质量标准`

    await llm.chat(
      [{ role: 'user', content: prompt }],
      (chunk) => { result += chunk },
      () => {
        const nameMatch = result.match(/^#\s+(.+)$/m)
        const skillName = nameMatch ? nameMatch[1].trim() : '自定义技能'
        const fileName = skillName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5-]/g, '-').toLowerCase() + '.md'
        setCustomSkills(prev => [...prev, { name: fileName, content: result }])
        setSkillInput('')
        setIsGeneratingSkill(false)
      },
      (error) => { showStatus(`生成失败: ${error.message}`); setIsGeneratingSkill(false) }
    )
  }

  const handleAddKnowledgeFile = () => {
    if (!newFileName.trim() || !newFileContent.trim()) return
    const fileName = newFileName.endsWith('.md') ? newFileName : `${newFileName}.md`
    setKnowledgeFiles(prev => [...prev, { name: fileName, content: newFileContent }])
    setNewFileName('')
    setNewFileContent('')
  }

  // BUG8 修复：正确传入 customSkills 到 createAvatar
  const handleCreate = async () => {
    setIsCreating(true)
    try {
      const avatarId = avatarName
        .replace(/[^a-zA-Z0-9\u4e00-\u9fa5-]/g, '-')
        .toLowerCase()
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        || `avatar-${Date.now()}`

      // 创建分身骨架
      await window.electronAPI.createAvatar(avatarId, soulContent, [], knowledgeFiles)

      // 写入自定义技能文件
      for (const skill of customSkills) {
        await window.electronAPI.writeSkillFile(avatarId, skill.name, skill.content)
      }

      onCreated(avatarId)
    } catch (error) {
      console.error('创建分身失败:', error)
      showStatus('创建失败，请重试')
    } finally {
      setIsCreating(false)
    }
  }

  const canProceed = () => {
    switch (currentStep) {
      case 0: return avatarName.trim().length > 0
      case 1: return soulContent.trim().length > 0
      default: return true
    }
  }

  return (
    <div className="fixed inset-0 bg-px-black/80 flex items-center justify-center z-50">
      <div className="bg-px-dark border-2 border-px-line shadow-pixel-xl w-[800px] max-h-[90vh] flex flex-col">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 bg-px-black text-px-white border-b-2 border-px-black">
          <div>
            <h2 className="font-pixel text-sm tracking-wider">CREATE AVATAR</h2>
            {statusMsg && <p className="font-pixel text-[8px] text-px-danger mt-0.5">{statusMsg}</p>}
          </div>
          <button onClick={onClose} className="pixel-close-btn">X</button>
        </div>

        {/* 步骤指示器 */}
        <div className="flex items-center px-6 py-3 border-b-2 border-px-line bg-px-mid overflow-x-auto">
          {STEPS.map((step, index) => (
            <div key={step} className="flex items-center flex-shrink-0">
              <div className={`flex items-center gap-2 ${index <= currentStep ? 'text-px-white' : 'text-px-muted'}`}>
                <div className={`w-6 h-6 border-2 flex items-center justify-center font-mono text-xs font-bold
                  ${index < currentStep ? 'bg-px-white border-px-white text-px-black'
                  : index === currentStep ? 'border-px-white text-px-white'
                  : 'border-px-line text-px-muted'}`}>
                  {index < currentStep ? '✓' : index + 1}
                </div>
                <span className="font-mono text-xs hidden sm:block">{step}</span>
              </div>
              {index < STEPS.length - 1 && (
                <div className={`w-4 h-0.5 mx-2 ${index < currentStep ? 'bg-px-white' : 'bg-px-line'}`} />
              )}
            </div>
          ))}
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto p-6 bg-px-dark">
          {currentStep === 0 && (
            <div className="space-y-4">
              <div>
                <label className="pixel-label text-px-white">分身名称 *</label>
                <input type="text" value={avatarName} onChange={(e) => setAvatarName(e.target.value)}
                  placeholder="例如：小李 - 光伏专家" className="pixel-input-dark w-full" />
              </div>
              <div>
                <label className="pixel-label text-px-white">一句话描述</label>
                <input type="text" value={avatarDescription} onChange={(e) => setAvatarDescription(e.target.value)}
                  placeholder="例如：专注光伏电站设计与收益测算" className="pixel-input-dark w-full" />
              </div>
            </div>
          )}

          {currentStep === 1 && (
            <div className="space-y-4">
              <div>
                <label className="pixel-label text-px-white">用自然语言描述分身人格</label>
                <textarea value={personalityInput} onChange={(e) => setPersonalityInput(e.target.value)}
                  placeholder="例如：我想创建一个光伏电站设计专家，叫小李。严谨专业，喜欢用数据说话..."
                  className="pixel-input-dark w-full font-mono" rows={4} />
                <button onClick={handleGenerateSoul}
                  disabled={isGeneratingSoul || !personalityInput.trim() || !chatModel.apiKey}
                  className="mt-2 pixel-btn-outline-light disabled:opacity-40">
                  {isGeneratingSoul ? 'GENERATING...' : '[AI] 生成人格定义'}
                </button>
                {!chatModel.apiKey && (
                  <p className="mt-1 font-pixel text-[8px] text-px-danger">请先在设置中配置 API Key</p>
                )}
              </div>
              {soulContent && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="pixel-label text-px-white mb-0">生成结果（可编辑）</label>
                    <span className="font-pixel text-[8px] text-px-muted">{soulContent.length} 字</span>
                  </div>
                  <textarea value={soulContent} onChange={(e) => setSoulContent(e.target.value)}
                    className="pixel-input-dark w-full font-mono text-sm" rows={15} />
                </div>
              )}
            </div>
          )}

          {currentStep === 2 && (
            <div className="space-y-4">
              <p className="font-mono text-sm text-px-muted">添加知识文件。可跳过，后续在知识库管理中添加。</p>
              {knowledgeFiles.length > 0 && (
                <div className="space-y-2">
                  {knowledgeFiles.map((file, index) => (
                    <div key={index} className="flex items-center justify-between p-3 bg-px-mid border-2 border-px-line">
                      <span className="font-mono text-sm font-medium text-px-white">{file.name}</span>
                      <button onClick={() => setKnowledgeFiles(prev => prev.filter((_, i) => i !== index))}
                        className="font-pixel text-[8px] text-px-danger hover:text-px-white">DEL</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-2 border-px-line p-4 space-y-3">
                <input type="text" value={newFileName} onChange={(e) => setNewFileName(e.target.value)}
                  placeholder="文件名，例如：policy.md" className="pixel-input-dark w-full" />
                <textarea value={newFileContent} onChange={(e) => setNewFileContent(e.target.value)}
                  placeholder="粘贴知识内容（Markdown 格式）..."
                  className="pixel-input-dark w-full font-mono text-sm" rows={8} />
                <button onClick={handleAddKnowledgeFile}
                  disabled={!newFileName.trim() || !newFileContent.trim()}
                  className="pixel-btn-outline-light disabled:opacity-40">[+] 添加文件</button>
              </div>
            </div>
          )}

          {currentStep === 3 && (
            <div className="space-y-4">
              <p className="font-mono text-sm text-px-muted">用自然语言描述技能，AI 自动生成。可跳过。</p>
              {customSkills.length > 0 && (
                <div className="space-y-2">
                  {customSkills.map((skill, index) => (
                    <div key={index} className="flex items-center justify-between p-3 bg-px-mid border-2 border-px-line">
                      <span className="font-mono text-sm font-medium text-px-white">{skill.name}</span>
                      <button onClick={() => setCustomSkills(prev => prev.filter((_, i) => i !== index))}
                        className="font-pixel text-[8px] text-px-danger hover:text-px-white">DEL</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-2 border-px-line p-4 space-y-3">
                <textarea value={skillInput} onChange={(e) => setSkillInput(e.target.value)}
                  placeholder="例如：我需要一个技能，当用户问到光伏组件选型时，能够根据项目规模推荐合适的组件..."
                  className="pixel-input-dark w-full" rows={4} />
                <button onClick={handleGenerateSkill}
                  disabled={isGeneratingSkill || !skillInput.trim() || !chatModel.apiKey}
                  className="pixel-btn-outline-light disabled:opacity-40">
                  {isGeneratingSkill ? 'GENERATING...' : '[AI] 生成技能'}
                </button>
              </div>
            </div>
          )}

          {currentStep === 4 && (
            <div className="space-y-4">
              <h3 className="font-pixel text-[10px] text-px-white tracking-wider">CONFIRM</h3>
              <div className="bg-px-mid border-2 border-px-line p-4 space-y-3 font-mono text-sm">
                {[
                  ['名称', avatarName],
                  ['描述', avatarDescription || '（未填写）'],
                  ['人格定义', `${soulContent.length} 字`],
                  ['知识文件', `${knowledgeFiles.length} 个`],
                  ['自定义技能', `${customSkills.length} 个`],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between">
                    <span className="text-px-muted">{label}</span>
                    <span className="font-medium text-px-white">{value}</span>
                  </div>
                ))}
              </div>
              <div className="bg-px-mid border-l-2 border-l-px-white p-4">
                <p className="font-mono text-sm text-px-muted">
                  将自动生成：CLAUDE.md · soul.md · memory/MEMORY.md
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between px-6 py-4 border-t-2 border-px-line bg-px-mid">
          <button
            onClick={() => currentStep > 0 ? setCurrentStep(currentStep - 1) : onClose()}
            className="pixel-btn-outline-muted"
          >
            {currentStep > 0 ? '← BACK' : 'CANCEL'}
          </button>

          {currentStep < STEPS.length - 1 ? (
            <button
              onClick={() => setCurrentStep(currentStep + 1)}
              disabled={!canProceed()}
              className="pixel-btn-outline-light disabled:opacity-40"
            >
              NEXT →
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="pixel-btn-outline-light disabled:opacity-40"
            >
              {isCreating ? 'CREATING...' : '[✓] CREATE'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
