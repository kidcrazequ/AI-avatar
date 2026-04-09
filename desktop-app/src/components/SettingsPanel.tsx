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
  // 特殊 Tab 标识
  const LOG_TAB = -1
  const WIKI_TAB = -2
  const [isExporting, setIsExporting] = useState(false)
  const [logMsg, setLogMsg] = useState('')
  // Wiki 设置状态
  const [wikiInjectRag, setWikiInjectRag] = useState(false)
  const [wikiAutoSediment, setWikiAutoSediment] = useState(false)
  const [wikiStatusMsg, setWikiStatusMsg] = useState('')

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

    // 加载 Wiki 设置
    const wikiInject = await window.electronAPI.getSetting('wiki_inject_rag')
    setWikiInjectRag(wikiInject === 'true')
    const wikiSediment = await window.electronAPI.getSetting('wiki_auto_sediment')
    setWikiAutoSediment(wikiSediment === 'true')
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

  /** 保存 Wiki 设置 */
  const handleSaveWikiSettings = async () => {
    try {
      await window.electronAPI.setSetting('wiki_inject_rag', wikiInjectRag ? 'true' : 'false')
      await window.electronAPI.setSetting('wiki_auto_sediment', wikiAutoSediment ? 'true' : 'false')
      setWikiStatusMsg('SAVED')
      window.dispatchEvent(new CustomEvent('settings-updated'))
      setTimeout(() => setWikiStatusMsg(''), 2000)
    } catch (error) {
      setWikiStatusMsg(`FAILED - ${(error as Error).message}`)
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
          {/* Wiki 百科 Tab */}
          <button
            onClick={() => setActiveTab(WIKI_TAB)}
            className={`text-left px-4 py-3 border-l-3 border-t-2 border-t-px-border transition-none
              ${activeTab === WIKI_TAB
                ? 'border-l-px-primary bg-px-surface text-px-text'
                : 'border-l-transparent text-px-text-sec hover:bg-px-surface/50 hover:text-px-text'
              }`}
          >
            <span className="font-game text-[12px] tracking-wider">WIKI</span>
            <span className="block font-game text-[13px] mt-0.5 text-px-text-dim">知识百科</span>
          </button>
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
          {activeTab === WIKI_TAB ? (
            /* ── 知识百科设置面板 ── */
            <>
              <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
                <div className="max-w-lg space-y-6">
                  <div className="border-l-3 border-px-primary pl-4 py-1">
                    <h3 className="font-game text-[16px] font-bold text-px-text mb-1">知识百科</h3>
                    <p className="font-game text-[14px] text-px-text-sec">融合 Karpathy Wiki 思想的知识增强功能</p>
                  </div>

                  {/* 注入百科到 RAG 开关 */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <span
                        className="pixel-checkbox"
                        role="checkbox"
                        aria-checked={wikiInjectRag}
                        data-checked={wikiInjectRag || undefined}
                        onClick={() => setWikiInjectRag(!wikiInjectRag)}
                        onKeyDown={(e) => e.key === ' ' && setWikiInjectRag(!wikiInjectRag)}
                        tabIndex={0}
                      />
                      <div>
                        <div className="font-game text-[14px] text-px-text">注入百科到 RAG</div>
                        <div className="font-game text-[12px] text-px-text-dim mt-0.5">
                          启用后，RAG 检索时同时搜索 wiki/concepts/ 中的概念页，作为补充参考注入问答
                        </div>
                      </div>
                    </label>
                  </div>

                  {/* 自动沉淀优质回答 开关 */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <span
                        className="pixel-checkbox"
                        role="checkbox"
                        aria-checked={wikiAutoSediment}
                        data-checked={wikiAutoSediment || undefined}
                        onClick={() => setWikiAutoSediment(!wikiAutoSediment)}
                        onKeyDown={(e) => e.key === ' ' && setWikiAutoSediment(!wikiAutoSediment)}
                        tabIndex={0}
                      />
                      <div>
                        <div className="font-game text-[14px] text-px-text">自动沉淀优质回答</div>
                        <div className="font-game text-[12px] text-px-text-dim mt-0.5">
                          启用后，当回答满足质量规则（长度 &gt; 300 字、含来源引用）时自动保存到 wiki/qa/
                        </div>
                      </div>
                    </label>
                  </div>

                  {/* 说明 */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-2">
                    <p className="font-game text-[12px] text-px-primary tracking-wider">功能说明</p>
                    <ul className="space-y-1.5">
                      {[
                        '百科内容由知识库面板的 WIKI 按钮编译生成，保存在 wiki/concepts/ 目录',
                        '注入 RAG 时百科仅作为补充参考，以知识库原文为准',
                        '自动沉淀的问答保存到 wiki/qa/，也可在消息气泡上手动点击 SAVE',
                        '所有 Wiki 功能不修改 knowledge/ 中的任何文件',
                      ].map((item, i) => (
                        <li key={i} className="flex gap-2 font-game text-[13px] text-px-text-sec">
                          <span className="text-px-primary flex-shrink-0">-</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>

              {/* 底部保存栏 */}
              <div className="flex items-center justify-between px-6 py-3 border-t-2 border-px-border bg-px-elevated">
                <span className={`font-game text-[12px] tracking-wider ${
                  wikiStatusMsg.includes('SAVED') ? 'text-px-success' :
                  wikiStatusMsg.includes('FAIL') ? 'text-px-danger' : 'text-px-text-dim'
                }`}>
                  {wikiStatusMsg}
                </span>
                <div className="flex gap-2">
                  <button onClick={onClose} className="pixel-btn-ghost">CANCEL</button>
                  <button onClick={handleSaveWikiSettings} className="pixel-btn-primary">SAVE</button>
                </div>
              </div>
            </>
          ) : activeTab === LOG_TAB ? (
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
