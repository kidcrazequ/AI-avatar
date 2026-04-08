import { useState, useEffect } from 'react'
import { DEFAULT_CHAT_MODEL, DEFAULT_VISION_MODEL, DEFAULT_OCR_MODEL, DEFAULT_CREATION_MODEL } from '../services/llm-service'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  onClose: () => void
}

interface ModelSlot {
  label: string
  keyPrefix: string
  defaults: { baseUrl: string; model: string }
  helpText: string
  tag: string
}

const MODEL_SLOTS: ModelSlot[] = [
  {
    label: '对话模型',
    keyPrefix: 'chat',
    defaults: DEFAULT_CHAT_MODEL,
    helpText: '用于日常问答和方案设计，默认 DeepSeek Chat',
    tag: 'CHAT',
  },
  {
    label: '创作模型',
    keyPrefix: 'creation',
    defaults: DEFAULT_CREATION_MODEL,
    helpText: '用于生成 soul.md、技能文件，默认 Qwen-Max。未配置时自动使用对话模型',
    tag: 'CREATE',
  },
  {
    label: '视觉模型',
    keyPrefix: 'vision',
    defaults: DEFAULT_VISION_MODEL,
    helpText: '用于识别图片内容，默认 Qwen VL Plus',
    tag: 'VISION',
  },
  {
    label: 'OCR 模型',
    keyPrefix: 'ocr',
    defaults: DEFAULT_OCR_MODEL,
    helpText: '用于从文档图片提取文字，默认 Qwen VL OCR',
    tag: 'OCR',
  },
]

interface ModelValues {
  apiKey: string
  baseUrl: string
  model: string
  showApiKey: boolean
}

export default function SettingsPanel({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState(0)
  const [slots, setSlots] = useState<ModelValues[]>(
    MODEL_SLOTS.map(s => ({ apiKey: '', baseUrl: s.defaults.baseUrl, model: s.defaults.model, showApiKey: false }))
  )
  const [isSaving, setIsSaving] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [testingIdx, setTestingIdx] = useState<number | null>(null)
  // -1 表示日志与反馈 Tab
  const LOG_TAB = -1
  const [isExporting, setIsExporting] = useState(false)
  const [logMsg, setLogMsg] = useState('')

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    const newSlots = await Promise.all(MODEL_SLOTS.map(async (slot, i) => {
      const apiKey = await window.electronAPI.getSetting(`${slot.keyPrefix}_api_key`) ?? ''
      const baseUrl = await window.electronAPI.getSetting(`${slot.keyPrefix}_base_url`) ?? slot.defaults.baseUrl
      const model = await window.electronAPI.getSetting(`${slot.keyPrefix}_model`) ?? slot.defaults.model
      return { apiKey, baseUrl, model, showApiKey: slots[i]?.showApiKey ?? false }
    }))
    setSlots(newSlots)
  }

  const updateSlot = (idx: number, updates: Partial<ModelValues>) => {
    setSlots(prev => prev.map((s, i) => i === idx ? { ...s, ...updates } : s))
  }

  const handleSave = async () => {
    setIsSaving(true)
    setStatusMsg('')
    try {
      for (let i = 0; i < MODEL_SLOTS.length; i++) {
        const slot = MODEL_SLOTS[i]
        const values = slots[i]
        await window.electronAPI.setSetting(`${slot.keyPrefix}_api_key`, values.apiKey)
        await window.electronAPI.setSetting(`${slot.keyPrefix}_base_url`, values.baseUrl)
        await window.electronAPI.setSetting(`${slot.keyPrefix}_model`, values.model)
      }
      setStatusMsg('SAVED')
      window.dispatchEvent(new CustomEvent('settings-updated'))
      setTimeout(() => setStatusMsg(''), 2000)
    } catch (error) {
      const msg = (error as Error).message || '未知错误'
      console.error('[Settings] Save failed:', error)
      setStatusMsg(`FAILED - ${msg}`)
    } finally {
      setIsSaving(false)
    }
  }

  /** 用 Canvas 生成一张 20x20 测试图片的 data URL（Qwen VL 要求 ≥10x10） */
  const createTestImageDataUrl = (): string => {
    const canvas = document.createElement('canvas')
    canvas.width = 20
    canvas.height = 20
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 20, 20)
    ctx.fillStyle = '#000000'
    ctx.font = '14px sans-serif'
    ctx.fillText('T', 4, 16)
    return canvas.toDataURL('image/png')
  }

  /** 构造测试消息：视觉/OCR 模型需要包含图片，普通模型发送纯文本 */
  const buildTestMessages = (idx: number): Array<Record<string, unknown>> => {
    const slot = MODEL_SLOTS[idx]
    const isVisionOrOcr = slot.keyPrefix === 'vision' || slot.keyPrefix === 'ocr'
    if (isVisionOrOcr) {
      return [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: createTestImageDataUrl() } },
          { type: 'text', text: 'describe' },
        ],
      }]
    }
    return [{ role: 'user', content: 'hi' }]
  }

  const handleTest = async (idx: number) => {
    const values = slots[idx]
    if (!values.apiKey.trim()) {
      setStatusMsg('请先输入 API Key')
      return
    }
    setTestingIdx(idx)
    setStatusMsg('TESTING...')
    try {
      const response = await fetch(`${values.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${values.apiKey}`,
        },
        body: JSON.stringify({
          model: values.model,
          messages: buildTestMessages(idx),
          max_tokens: 5,
        }),
      })
      if (response.ok) {
        setStatusMsg(`PASS - ${MODEL_SLOTS[idx].tag}`)
      } else {
        const data = await response.json().catch(() => ({}))
        setStatusMsg(`FAIL - ${data.error?.message || response.statusText}`)
      }
    } catch (error) {
      setStatusMsg(`FAIL - ${(error as Error).message}`)
    } finally {
      setTestingIdx(null)
      setTimeout(() => setStatusMsg(''), 5000)
    }
  }

  const activeSlot = MODEL_SLOTS[activeTab]
  const activeValues = slots[activeTab]

  /** 打开日志目录（系统文件管理器） */
  const handleOpenLogsFolder = async () => {
    try {
      await window.electronAPI.openLogsFolder()
    } catch (err) {
      setLogMsg(`打开失败：${(err as Error).message}`)
    }
  }

  /** 导出错误日志到桌面 */
  const handleExportErrorLog = async () => {
    setIsExporting(true)
    setLogMsg('')
    try {
      const result = await window.electronAPI.exportErrorLog(3)
      if (result.success) {
        setLogMsg(`已导出到桌面：${result.filePath?.split(/[\\/]/).pop()}`)
      } else {
        setLogMsg(result.message ?? '导出失败')
      }
    } catch (err) {
      setLogMsg(`导出失败：${(err as Error).message}`)
    } finally {
      setIsExporting(false)
      setTimeout(() => setLogMsg(''), 6000)
    }
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <PanelHeader title="SETTINGS" onClose={onClose} />

      <div className="flex-1 flex overflow-hidden">
        {/* 左侧 Tab */}
        <div className="w-48 border-r-2 border-px-border bg-px-bg flex flex-col">
          {MODEL_SLOTS.map((slot, idx) => (
            <button
              key={slot.keyPrefix}
              onClick={() => setActiveTab(idx)}
              className={`text-left px-4 py-3 border-l-3 transition-none
                ${idx === activeTab
                  ? 'border-l-px-primary bg-px-surface text-px-text'
                  : 'border-l-transparent text-px-text-sec hover:bg-px-surface/50 hover:text-px-text'
                }`}
            >
              <span className="font-game text-[12px] tracking-wider">{slot.tag}</span>
              <span className="block font-game text-[13px] mt-0.5 text-px-text-dim">{slot.label}</span>
            </button>
          ))}
          <div className="flex-1" />
          {/* 日志与反馈 Tab */}
          <button
            onClick={() => setActiveTab(LOG_TAB)}
            className={`text-left px-4 py-3 border-l-3 border-t-2 border-t-px-border transition-none
              ${activeTab === LOG_TAB
                ? 'border-l-px-primary bg-px-surface text-px-text'
                : 'border-l-transparent text-px-text-sec hover:bg-px-surface/50 hover:text-px-text'
              }`}
          >
            <span className="font-game text-[12px] tracking-wider">LOG</span>
            <span className="block font-game text-[13px] mt-0.5 text-px-text-dim">日志与反馈</span>
          </button>
          <div className="px-4 py-3 border-t-2 border-px-border">
            <p className="font-game text-[10px] text-px-text-dim tracking-wider">SOUL V1.0</p>
          </div>
        </div>

        {/* 右侧内容区 */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {activeTab === LOG_TAB ? (
            /* ── 日志与反馈面板 ── */
            <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
              <div className="max-w-lg space-y-6">
                <div className="border-l-3 border-px-primary pl-4 py-1">
                  <h3 className="font-game text-[16px] font-bold text-px-text mb-1">日志与反馈</h3>
                  <p className="font-game text-[14px] text-px-text-sec">遇到问题时，将错误日志发给开发者帮助排查</p>
                </div>

                {/* 操作按钮 */}
                <div className="space-y-3">
                  <button
                    onClick={handleOpenLogsFolder}
                    className="w-full flex items-center gap-3 px-5 py-3 border-2 border-px-border
                      bg-px-elevated text-px-text font-game text-[14px] tracking-wider
                      hover:border-px-primary hover:text-px-primary transition-none"
                  >
                    <span className="text-[16px]">📁</span>
                    <div className="text-left">
                      <div>打开日志目录</div>
                      <div className="text-[12px] text-px-text-dim mt-0.5">用文件管理器定位到日志文件夹</div>
                    </div>
                  </button>

                  <button
                    onClick={handleExportErrorLog}
                    disabled={isExporting}
                    className="w-full flex items-center gap-3 px-5 py-3 border-2 border-px-border
                      bg-px-elevated text-px-text font-game text-[14px] tracking-wider
                      hover:border-px-primary hover:text-px-primary transition-none
                      disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span className="text-[16px]">📤</span>
                    <div className="text-left">
                      <div>{isExporting ? '导出中...' : '导出错误日志到桌面'}</div>
                      <div className="text-[12px] text-px-text-dim mt-0.5">将最近 3 天的报错整合为 txt 文件，保存到桌面</div>
                    </div>
                  </button>
                </div>

                {/* 操作结果提示 */}
                {logMsg && (
                  <div className={`px-4 py-3 border-l-3 font-game text-[13px]
                    ${logMsg.includes('失败') ? 'border-l-px-danger text-px-danger bg-px-danger/5' : 'border-l-px-success text-px-success bg-px-success/5'}`}>
                    {logMsg}
                  </div>
                )}

                {/* 使用说明 */}
                <div className="border-2 border-px-border bg-px-elevated p-4 space-y-2">
                  <p className="font-game text-[12px] text-px-primary tracking-wider">如何发送日志</p>
                  <ol className="space-y-1.5">
                    {[
                      '点击「导出错误日志到桌面」',
                      '桌面会生成一个 txt 文件（AI分身-错误日志-xxx.txt）',
                      '将该文件发送给开发者即可',
                    ].map((step, i) => (
                      <li key={i} className="flex gap-2 font-game text-[13px] text-px-text-sec">
                        <span className="text-px-primary flex-shrink-0">{i + 1}.</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                  <div className="pixel-divider mt-3" />
                  <p className="font-game text-[12px] text-px-text-dim">
                    日志文件包含：报错时间、错误信息、系统版本。<br />
                    不含任何对话内容和 API Key。
                  </p>
                </div>
              </div>
            </div>
          ) : (
            /* ── 模型配置表单 ── */
            <>
              <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
                <div className="max-w-lg space-y-5">
                  <div className="border-l-3 border-px-primary pl-4 py-1">
                    <h3 className="font-game text-[16px] font-bold text-px-text mb-1">{activeSlot.label}</h3>
                    <p className="font-game text-[14px] text-px-text-sec">{activeSlot.helpText}</p>
                  </div>

                  <div>
                    <label className="pixel-label">API KEY</label>
                    <div className="flex gap-2">
                      <div className="flex-1 relative">
                        <input
                          type={activeValues?.showApiKey ? 'text' : 'password'}
                          value={activeValues?.apiKey || ''}
                          onChange={(e) => updateSlot(activeTab, { apiKey: e.target.value })}
                          placeholder="sk-..."
                          className="pixel-input w-full pr-10"
                        />
                        <button
                          onClick={() => updateSlot(activeTab, { showApiKey: !activeValues?.showApiKey })}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-px-text-dim hover:text-px-text font-game text-[12px]"
                          aria-label={activeValues?.showApiKey ? '隐藏' : '显示'}
                        >
                          {activeValues?.showApiKey ? 'HIDE' : 'SHOW'}
                        </button>
                      </div>
                      <button
                        onClick={() => handleTest(activeTab)}
                        disabled={testingIdx !== null}
                        className="pixel-btn-outline-light disabled:opacity-40"
                      >
                        {testingIdx === activeTab ? '...' : 'TEST'}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="pixel-label">BASE URL</label>
                    <input
                      type="text"
                      value={activeValues?.baseUrl || ''}
                      onChange={(e) => updateSlot(activeTab, { baseUrl: e.target.value })}
                      placeholder="https://api.xxx.com/v1"
                      className="pixel-input w-full"
                    />
                  </div>

                  <div>
                    <label className="pixel-label">MODEL</label>
                    <input
                      type="text"
                      value={activeValues?.model || ''}
                      onChange={(e) => updateSlot(activeTab, { model: e.target.value })}
                      placeholder="model-name"
                      className="pixel-input w-full"
                    />
                  </div>
                </div>
              </div>

              {/* 底部操作栏（仅模型配置时显示） */}
              <div className="flex items-center justify-between px-6 py-3 border-t-2 border-px-border bg-px-elevated">
                <span className={`font-game text-[12px] tracking-wider ${
                  statusMsg.includes('SAVED') || statusMsg.includes('PASS') ? 'text-px-success' :
                  statusMsg.includes('FAIL') ? 'text-px-danger' : 'text-px-text-dim'
                }`}>
                  {statusMsg}
                </span>
                <div className="flex gap-2">
                  <button onClick={onClose} className="pixel-btn-ghost">CANCEL</button>
                  <button onClick={handleSave} disabled={isSaving} className="pixel-btn-primary">
                    {isSaving ? '...' : 'SAVE'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
