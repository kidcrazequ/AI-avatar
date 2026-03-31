import { useState, useEffect } from 'react'
import { DEFAULT_CHAT_MODEL, DEFAULT_VISION_MODEL, DEFAULT_OCR_MODEL } from '../services/llm-service'

interface Props {
  onClose: () => void
}

interface ModelSlot {
  label: string
  keyPrefix: string
  defaults: { baseUrl: string; model: string }
  helpText: string
}

const MODEL_SLOTS: ModelSlot[] = [
  {
    label: 'CHAT MODEL',
    keyPrefix: 'chat',
    defaults: DEFAULT_CHAT_MODEL,
    helpText: '对话模型，用于日常问答和方案设计。默认 DeepSeek Chat。',
  },
  {
    label: 'VISION MODEL',
    keyPrefix: 'vision',
    defaults: DEFAULT_VISION_MODEL,
    helpText: '视觉理解模型，用于识别图片内容。默认 Qwen VL Plus。',
  },
  {
    label: 'OCR MODEL',
    keyPrefix: 'ocr',
    defaults: DEFAULT_OCR_MODEL,
    helpText: '文字提取模型，用于从文档图片提取文字。默认 Qwen VL OCR（费用极低）。',
  },
]

interface ModelValues {
  apiKey: string
  baseUrl: string
  model: string
  showApiKey: boolean
}

export default function SettingsPanel({ onClose }: Props) {
  const [slots, setSlots] = useState<ModelValues[]>(
    MODEL_SLOTS.map(s => ({ apiKey: '', baseUrl: s.defaults.baseUrl, model: s.defaults.model, showApiKey: false }))
  )
  const [isSaving, setIsSaving] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [testingIdx, setTestingIdx] = useState<number | null>(null)

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
      setStatusMsg('✓ SAVED')
      window.dispatchEvent(new CustomEvent('settings-updated'))
      setTimeout(() => setStatusMsg(''), 2000)
    } catch (error) {
      setStatusMsg('✗ SAVE FAILED')
    } finally {
      setIsSaving(false)
    }
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
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
        }),
      })
      if (response.ok) {
        setStatusMsg(`✓ ${MODEL_SLOTS[idx].label} OK`)
      } else {
        const data = await response.json().catch(() => ({}))
        setStatusMsg(`✗ ${data.error?.message || response.statusText}`)
      }
    } catch (error) {
      setStatusMsg(`✗ ${(error as Error).message}`)
    } finally {
      setTestingIdx(null)
      setTimeout(() => setStatusMsg(''), 3000)
    }
  }

  return (
    <div className="fixed inset-0 bg-px-black/80 flex items-center justify-center z-50">
      <div className="bg-px-white border-2 border-px-black shadow-pixel-xl w-[640px] max-h-[85vh] flex flex-col">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 bg-px-black text-px-white border-b-2 border-px-black">
          <h2 className="font-pixel text-sm tracking-wider">SETTINGS</h2>
          <button onClick={onClose} className="pixel-close-btn" aria-label="关闭">X</button>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {MODEL_SLOTS.map((slot, idx) => (
            <div key={slot.keyPrefix} className="space-y-3">
              <div className="flex items-center gap-3">
                <h3 className="font-pixel text-[10px] text-px-black tracking-wider">{slot.label}</h3>
                <div className="h-px flex-1 bg-px-border" />
              </div>
              <p className="font-mono text-xs text-px-muted">{slot.helpText}</p>

              <div className="space-y-2">
                {/* API Key */}
                <div>
                  <label className="pixel-label">API KEY</label>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <input
                        type={slots[idx].showApiKey ? 'text' : 'password'}
                        value={slots[idx].apiKey}
                        onChange={(e) => updateSlot(idx, { apiKey: e.target.value })}
                        placeholder="sk-..."
                        className="pixel-input w-full pr-10"
                      />
                      <button
                        onClick={() => updateSlot(idx, { showApiKey: !slots[idx].showApiKey })}
                        className="absolute right-2 top-1/2 -translate-y-1/2 font-pixel text-[8px] text-px-muted hover:text-px-black"
                        aria-label={slots[idx].showApiKey ? '隐藏' : '显示'}
                      >
                        {slots[idx].showApiKey ? '●' : '○'}
                      </button>
                    </div>
                    <button
                      onClick={() => handleTest(idx)}
                      disabled={testingIdx !== null}
                      className="pixel-btn-secondary text-[10px] disabled:opacity-40"
                    >
                      {testingIdx === idx ? 'TESTING...' : 'TEST'}
                    </button>
                  </div>
                </div>

                {/* Base URL */}
                <div>
                  <label className="pixel-label">BASE URL</label>
                  <input
                    type="text"
                    value={slots[idx].baseUrl}
                    onChange={(e) => updateSlot(idx, { baseUrl: e.target.value })}
                    placeholder="https://api.xxx.com/v1"
                    className="pixel-input w-full"
                  />
                </div>

                {/* Model */}
                <div>
                  <label className="pixel-label">MODEL</label>
                  <input
                    type="text"
                    value={slots[idx].model}
                    onChange={(e) => updateSlot(idx, { model: e.target.value })}
                    placeholder="model-name"
                    className="pixel-input w-full"
                  />
                </div>
              </div>
            </div>
          ))}

          {/* 关于 */}
          <div className="pt-4 border-t-2 border-px-border">
            <h3 className="font-pixel text-[10px] text-px-muted tracking-wider mb-2">ABOUT</h3>
            <p className="font-mono text-xs text-px-muted">小堵 - 工商储产品解决方案专家 v1.0.0</p>
            <p className="font-mono text-xs text-px-muted">基于 Soul 分身系统</p>
          </div>
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-between px-6 py-4 border-t-2 border-px-border bg-px-warm">
          <span className={`font-pixel text-[8px] tracking-wider ${
            statusMsg.includes('✓') ? 'text-green-700' :
            statusMsg.includes('✗') ? 'text-px-danger' : 'text-px-muted'
          }`}>
            {statusMsg}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="pixel-btn-ghost">CANCEL</button>
            <button onClick={handleSave} disabled={isSaving} className="pixel-btn-primary disabled:opacity-40">
              {isSaving ? 'SAVING...' : '[✓] SAVE'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
