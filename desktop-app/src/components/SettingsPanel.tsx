import { useState, useEffect, useRef } from 'react'
import { useThemeStore, THEMES } from '../stores/themeStore'
import { DEFAULT_CHAT_MODEL, DEFAULT_VISION_MODEL, DEFAULT_OCR_MODEL, DEFAULT_CREATION_MODEL } from '../services/llm-service'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'
import { localDateString } from '@soul/core/browser'
import { TOOL_NAME_MAP } from '../lib/tool-name-map'

/**
 * 工具调用审计单行（Stage 三 P2 范围外 3）。
 *
 * 字段对齐 electron/logger.ts 的 ToolCallAuditRecord，但允许部分字段缺失（兼容旧记录）。
 */
interface ToolCallAuditEntry {
  ts: number
  avatarId?: string
  conversationId?: string
  toolName: string
  durationMs?: number
  ok?: boolean
  argsPreview?: string
  resultLen?: number
  error?: string
}

interface Props {
  activeAvatarId?: string
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

/**
 * MCP server 编辑表单的内部状态。
 *
 * args / env 在表单中用 textarea 编辑（每行一项 / 每行 KEY=VALUE），
 * 提交时再转成 string[] / Record。这样表单状态扁平、易渲染。
 *
 * isNew 标识用于：
 *   - 提交时禁止改 name（已有 server 改名 = 删旧建新，不直观）
 *   - title 显示「添加 / 编辑」差异
 */
interface McpFormState {
  isNew: boolean
  name: string
  enabled: boolean
  transport: 'stdio' | 'http' | 'sse'
  command: string
  argsText: string
  envText: string
  cwd: string
  url: string
  timeoutMsText: string
  description: string
}

/** 创建一个空 MCP server 表单（点「添加」时用） */
function createEmptyMcpForm(): McpFormState {
  return {
    isNew: true,
    name: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    argsText: '',
    envText: '',
    cwd: '',
    url: '',
    timeoutMsText: '',
    description: '',
  }
}

/** 从 DB 行回灌表单（点「编辑」时用） */
function mcpRowToForm(row: McpServerListItem): McpFormState {
  return {
    isNew: false,
    name: row.name,
    enabled: row.enabled,
    transport: row.transport,
    command: row.command ?? '',
    argsText: (row.args ?? []).join('\n'),
    envText: Object.entries(row.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    cwd: row.cwd ?? '',
    url: row.url ?? '',
    timeoutMsText: row.timeout_ms ? String(row.timeout_ms) : '',
    description: row.description ?? '',
  }
}

/**
 * 把表单状态转为可发往 main 进程的 McpServerInput。
 * 校验失败时抛 Error（由提交流程捕获并显示在表单错误区）。
 */
function mcpFormToInput(form: McpFormState): McpServerInput {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(form.name)) {
    throw new Error('名称仅允许字母 / 数字 / 下划线 / 连字符，长度 1~32')
  }
  if (form.transport === 'stdio' && !form.command.trim()) {
    throw new Error('stdio 类型必须填 command（如 npx / node / python）')
  }
  if ((form.transport === 'http' || form.transport === 'sse') && !form.url.trim()) {
    throw new Error(`${form.transport} 类型必须填 URL`)
  }

  // args: 按行拆，去空行 + trim
  const args = form.argsText
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  // env: KEY=VALUE，每行一对；忽略空行 / 缺等号的行
  const env: Record<string, string> = {}
  for (const line of form.envText.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const idx = t.indexOf('=')
    if (idx <= 0) continue   // 缺等号或等号在开头都跳过
    const key = t.slice(0, idx).trim()
    const value = t.slice(idx + 1)
    if (key) env[key] = value
  }

  // timeoutMs: 解析为正整数，无效则不传
  const tm = parseInt(form.timeoutMsText, 10)
  const timeoutMs = Number.isFinite(tm) && tm > 0 ? tm : undefined

  return {
    name: form.name.trim(),
    enabled: form.enabled,
    transport: form.transport,
    command: form.transport === 'stdio' ? form.command.trim() : undefined,
    args: form.transport === 'stdio' && args.length > 0 ? args : undefined,
    env: form.transport === 'stdio' && Object.keys(env).length > 0 ? env : undefined,
    cwd: form.transport === 'stdio' && form.cwd.trim() ? form.cwd.trim() : undefined,
    url: (form.transport === 'http' || form.transport === 'sse') ? form.url.trim() : undefined,
    timeoutMs,
    description: form.description.trim() || undefined,
  }
}

/** 状态徽章的样式映射 */
const MCP_STATUS_STYLE: Record<McpServerListItem['status'], { label: string; cls: string }> = {
  idle: { label: 'IDLE', cls: 'text-px-text-dim border-px-border' },
  connecting: { label: 'CONNECTING', cls: 'text-px-warning border-px-warning' },
  connected: { label: 'CONNECTED', cls: 'text-px-success border-px-success' },
  error: { label: 'ERROR', cls: 'text-px-danger border-px-danger' },
  disconnected: { label: 'DISCONNECTED', cls: 'text-px-text-dim border-px-border' },
}

export default function SettingsPanel({ activeAvatarId, onClose }: Props) {
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
  const MEMORY_TAB = -3
  const CRON_TAB = -4
  const THEME_TAB = -5
  const INTEGRATIONS_TAB = -6
  const { themeId, setTheme } = useThemeStore()
  const [isExporting, setIsExporting] = useState(false)
  const [logMsg, setLogMsg] = useState('')
  /**
   * 工具调用审计 modal 状态（Stage 三 P2 范围外 3）。
   *
   * - null  → 关闭
   * - {date, records} → 显示某日审计记录列表（按 ts 倒序）
   *
   * 数据按需加载：点击「查看工具调用审计」时调 readToolCallLog → JSON 解析。
   */
  const [auditModal, setAuditModal] = useState<null | {
    date: string
    records: ToolCallAuditEntry[]
    loading: boolean
    error?: string
  }>(null)
  // Wiki 设置状态
  const [wikiInjectRag, setWikiInjectRag] = useState(false)
  const [wikiAutoSediment, setWikiAutoSediment] = useState(false)
  const [wikiStatusMsg, setWikiStatusMsg] = useState('')
  // 记忆设置状态
  const [nudgeInterval, setNudgeInterval] = useState('5')
  const [memoryStatusMsg, setMemoryStatusMsg] = useState('')
  // 定时任务状态
  const [cronMemoryInterval, setCronMemoryInterval] = useState('0')
  const [cronKnowledgeInterval, setCronKnowledgeInterval] = useState('0')
  const [cronStatusMsg, setCronStatusMsg] = useState('')
  // 工具集成状态（Tavily 搜索 API 等外部工具凭据）
  const [tavilyApiKey, setTavilyApiKey] = useState('')
  /** 九层重构 #16 generate_image：DashScope 通义万相 API Key */
  const [imageApiKey, setImageApiKey] = useState('')
  const [showImageKey, setShowImageKey] = useState(false)
  const [showTavilyKey, setShowTavilyKey] = useState(false)
  const [integrationsStatusMsg, setIntegrationsStatusMsg] = useState('')
  // MCP servers 状态
  const [mcpServers, setMcpServers] = useState<McpServerListItem[]>([])
  const [mcpStatusMsg, setMcpStatusMsg] = useState('')
  const [mcpBusy, setMcpBusy] = useState(false)
  /** 当前在编辑的 MCP server 表单（null = 未打开模态框）。新增时是空模板。 */
  const [editingMcp, setEditingMcp] = useState<McpFormState | null>(null)
  const [mcpFormError, setMcpFormError] = useState('')
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const cronStatusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const logMsgTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const wikiTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const memoryTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const integrationsTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => {
    clearTimeout(statusTimerRef.current)
    clearTimeout(cronStatusTimerRef.current)
    clearTimeout(logMsgTimerRef.current)
    clearTimeout(wikiTimerRef.current)
    clearTimeout(memoryTimerRef.current)
    clearTimeout(integrationsTimerRef.current)
  }, [])

  const loadSeqRef = useRef(0)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    const seq = ++loadSeqRef.current
    try {
      const loadedSlots = await Promise.all(MODEL_SLOTS.map(async (slot) => {
        const apiKey = await window.electronAPI.getSetting(`${slot.keyPrefix}_api_key`) ?? ''
        const baseUrl = await window.electronAPI.getSetting(`${slot.keyPrefix}_base_url`) ?? slot.defaults.baseUrl
        const model = await window.electronAPI.getSetting(`${slot.keyPrefix}_model`) ?? slot.defaults.model
        return { apiKey, baseUrl, model }
      }))
      if (loadSeqRef.current !== seq) return
      setSlots(prev => loadedSlots.map((s, i) => ({ ...s, showApiKey: prev[i]?.showApiKey ?? false })))

      // 并行加载 Wiki / 记忆 / 定时任务 / 工具集成设置
      const [wikiInject, wikiSediment, nudge, cronConfigs, tavilyKey, imageKey] = await Promise.all([
        window.electronAPI.getSetting('wiki_inject_rag'),
        window.electronAPI.getSetting('wiki_auto_sediment'),
        window.electronAPI.getSetting('memory_nudge_interval'),
        window.electronAPI.getCronConfig(),
        window.electronAPI.getSetting('tavily_api_key'),
        window.electronAPI.getSetting('image_api_key'),
      ])
      if (loadSeqRef.current !== seq) return
      setWikiInjectRag(wikiInject === 'true')
      setWikiAutoSediment(wikiSediment === 'true')
      setNudgeInterval(nudge ?? '5')
      for (const cfg of cronConfigs) {
        if (cfg.type === 'memory-consolidate') setCronMemoryInterval(String(cfg.intervalHours))
        if (cfg.type === 'knowledge-check') setCronKnowledgeInterval(String(cfg.intervalHours))
      }
      setTavilyApiKey(tavilyKey ?? '')
      setImageApiKey(imageKey ?? '')

      // MCP servers（独立 try，避免一个面板失败影响其他设置加载）
      try {
        const list = await window.electronAPI.mcpListServers()
        if (loadSeqRef.current === seq) setMcpServers(list)
      } catch (e) {
        console.warn('[Settings] 加载 MCP servers 失败:', e instanceof Error ? e.message : String(e))
      }
    } catch (err) {
      console.error('[Settings] 加载设置失败:', err instanceof Error ? err.message : String(err))
      window.electronAPI.logEvent('error', 'settings-load-error', err instanceof Error ? err.message : String(err))
    }
  }

  const updateSlot = (idx: number, updates: Partial<ModelValues>) => {
    setSlots(prev => prev.map((s, i) => i === idx ? { ...s, ...updates } : s))
  }

  const handleSave = async () => {
    setIsSaving(true)
    setStatusMsg('')
    try {
      await Promise.all(MODEL_SLOTS.flatMap((slot, i) => {
        const values = slots[i]
        return [
          window.electronAPI.setSetting(`${slot.keyPrefix}_api_key`, values.apiKey),
          window.electronAPI.setSetting(`${slot.keyPrefix}_base_url`, values.baseUrl),
          window.electronAPI.setSetting(`${slot.keyPrefix}_model`, values.model),
        ]
      }))
      setStatusMsg('SAVED')
      window.dispatchEvent(new CustomEvent('settings-updated'))
      clearTimeout(statusTimerRef.current)
      statusTimerRef.current = setTimeout(() => setStatusMsg(''), 2000)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[Settings] Save failed:', msg)
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
      let testUrl: URL
      try {
        testUrl = new URL(`${values.baseUrl}/chat/completions`)
      } catch {
        setStatusMsg('FAIL - 无效的 Base URL')
        setTestingIdx(null)
        return
      }
      if (!['https:', 'http:'].includes(testUrl.protocol)) {
        setStatusMsg('FAIL - 仅支持 http/https 协议')
        setTestingIdx(null)
        return
      }
      // 连接测试需在 !ok 时读取 response.json() 的 error.message 展示给用户；
      // fetchWithTimeout 会在 !ok 时抛 HttpError 无法拿到响应体，故此处保留原生 fetch。
      // 超时已通过 AbortSignal.timeout(15_000) 显式控制。
      // eslint-disable-next-line no-restricted-globals
      const response = await fetch(testUrl.href, {
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
        signal: AbortSignal.timeout(15_000),
      })
      if (response.ok) {
        setStatusMsg(`PASS - ${MODEL_SLOTS[idx].tag}`)
      } else {
        const data = await response.json().catch(() => ({}))
        setStatusMsg(`FAIL - ${data.error?.message || response.statusText}`)
      }
    } catch (error) {
      setStatusMsg(`FAIL - ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setTestingIdx(null)
      clearTimeout(statusTimerRef.current)
      statusTimerRef.current = setTimeout(() => setStatusMsg(''), 5000)
    }
  }

  const activeSlot = MODEL_SLOTS[activeTab]
  const activeValues = slots[activeTab]

  /** 打开日志目录（系统文件管理器） */
  const handleOpenLogsFolder = async () => {
    try {
      await window.electronAPI.openLogsFolder()
    } catch (err) {
      setLogMsg(`打开失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 打开当前分身的工作区目录（包含各会话 exports/ 产物）。 */
  const handleOpenWorkspacesFolder = async () => {
    if (!activeAvatarId) {
      setLogMsg('打开失败：当前未选择分身')
      return
    }
    try {
      const result = await window.electronAPI.openAvatarWorkspacesFolder(activeAvatarId)
      if (result.success) {
        setLogMsg('已打开工作区目录')
      } else {
        setLogMsg(`打开失败：${result.error ?? '未知错误'}`)
      }
    } catch (err) {
      setLogMsg(`打开失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 加载并展示某日的工具调用审计日志（Stage 三 P2 范围外 3）。
   *
   * 流程：
   *   1. 默认加载今天的 jsonl
   *   2. 按行 split + JSON.parse 容错（非法行跳过）
   *   3. 倒序排列（最新调用在最上）
   *   4. 失败时 modal 也打开，但展示错误信息
   */
  const handleViewToolCallAudit = async (date?: string) => {
    const d = date ?? localDateString()
    setAuditModal({ date: d, records: [], loading: true })
    try {
      const raw = await window.electronAPI.readToolCallLog(d)
      const records: ToolCallAuditEntry[] = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const obj = JSON.parse(trimmed) as ToolCallAuditEntry
          if (obj && typeof obj.toolName === 'string' && typeof obj.ts === 'number') {
            records.push(obj)
          }
        } catch {
          // 损坏行跳过；不阻塞整体展示
        }
      }
      records.sort((a, b) => b.ts - a.ts)
      setAuditModal({ date: d, records, loading: false })
    } catch (err) {
      setAuditModal({ date: d, records: [], loading: false, error: err instanceof Error ? err.message : String(err) })
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
      setLogMsg(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsExporting(false)
      clearTimeout(logMsgTimerRef.current)
      logMsgTimerRef.current = setTimeout(() => setLogMsg(''), 6000)
    }
  }

  /** 保存 Wiki 设置 */
  const handleSaveWikiSettings = async () => {
    try {
      await Promise.all([
        window.electronAPI.setSetting('wiki_inject_rag', wikiInjectRag ? 'true' : 'false'),
        window.electronAPI.setSetting('wiki_auto_sediment', wikiAutoSediment ? 'true' : 'false'),
      ])
      setWikiStatusMsg('SAVED')
      window.dispatchEvent(new CustomEvent('settings-updated'))
      clearTimeout(wikiTimerRef.current)
      wikiTimerRef.current = setTimeout(() => setWikiStatusMsg(''), 2000)
    } catch (error) {
      setWikiStatusMsg(`FAILED - ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 保存记忆设置 */
  const handleSaveMemorySettings = async () => {
    try {
      const interval = parseInt(nudgeInterval, 10)
      if (isNaN(interval) || interval < 0) {
        setMemoryStatusMsg('INVALID - 请输入非负整数')
        return
      }
      await window.electronAPI.setSetting('memory_nudge_interval', String(interval))
      setMemoryStatusMsg('SAVED')
      clearTimeout(memoryTimerRef.current)
      memoryTimerRef.current = setTimeout(() => setMemoryStatusMsg(''), 2000)
    } catch (error) {
      setMemoryStatusMsg(`FAILED - ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 保存定时任务设置 */
  const handleSaveCronSettings = async () => {
    try {
      const memInterval = Math.max(parseInt(cronMemoryInterval, 10) || 0, 0)
      const knowledgeInterval = Math.max(parseInt(cronKnowledgeInterval, 10) || 0, 0)
      await Promise.all([
        window.electronAPI.scheduleCron('memory-consolidate', memInterval, activeAvatarId),
        window.electronAPI.scheduleCron('knowledge-check', knowledgeInterval, activeAvatarId),
      ])
      setCronStatusMsg('SAVED')
      clearTimeout(cronStatusTimerRef.current)
      cronStatusTimerRef.current = setTimeout(() => setCronStatusMsg(''), 2000)
    } catch (error) {
      setCronStatusMsg(`FAILED - ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 保存「工具集成」设置（Tavily Search API Key 等外部工具凭据）。
   * Key 存入 settings 表，主进程 ToolRouter 通过注入的 getSetting 读取。
   */
  const handleSaveIntegrations = async () => {
    try {
      await Promise.all([
        window.electronAPI.setSetting('tavily_api_key', tavilyApiKey.trim()),
        // 九层重构 #16 generate_image：DashScope API Key
        window.electronAPI.setSetting('image_api_key', imageApiKey.trim()),
      ])
      setIntegrationsStatusMsg('SAVED')
      clearTimeout(integrationsTimerRef.current)
      integrationsTimerRef.current = setTimeout(() => setIntegrationsStatusMsg(''), 2000)
    } catch (error) {
      setIntegrationsStatusMsg(`FAILED - ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ─── MCP server 管理 ──────────────────────────────────────────────────

  /** 重新拉取 server 列表（含运行时状态），写入 mcpServers state */
  const reloadMcpServers = async () => {
    try {
      const list = await window.electronAPI.mcpListServers()
      setMcpServers(list)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[MCP] 加载列表失败:', msg)
      setMcpStatusMsg(`FAILED - ${msg}`)
    }
  }

  /** 提交 MCP 表单（创建或更新）。submitMcpForm 内部已处理校验异常。 */
  const submitMcpForm = async () => {
    if (!editingMcp) return
    setMcpFormError('')
    setMcpBusy(true)
    try {
      const input = mcpFormToInput(editingMcp)
      await window.electronAPI.mcpUpsertServer(input)
      setEditingMcp(null)
      await reloadMcpServers()
      setMcpStatusMsg(editingMcp.isNew ? `SAVED - 已添加 ${input.name}` : `SAVED - 已更新 ${input.name}`)
      window.electronAPI.logEvent('info', 'mcp-upsert-server', input.name)
    } catch (e) {
      setMcpFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setMcpBusy(false)
    }
  }

  /** 删除 server（带 confirm 防误操作） */
  const removeMcpServer = async (name: string) => {
    if (!window.confirm(`确认删除 MCP server '${name}'？该 server 提供的工具将不可用。`)) return
    setMcpBusy(true)
    try {
      await window.electronAPI.mcpRemoveServer(name)
      await reloadMcpServers()
      setMcpStatusMsg(`SAVED - 已删除 ${name}`)
      window.electronAPI.logEvent('info', 'mcp-remove-server', name)
    } catch (e) {
      setMcpStatusMsg(`FAILED - ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setMcpBusy(false)
    }
  }

  /** 重连 server（用于 status=error 后让用户手动重试） */
  const reconnectMcpServer = async (name: string) => {
    setMcpBusy(true)
    try {
      await window.electronAPI.mcpReconnectServer(name)
      await reloadMcpServers()
    } catch (e) {
      setMcpStatusMsg(`FAILED - ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setMcpBusy(false)
    }
  }

  /** 启用/禁用 toggle：禁用时调用 disconnect；启用时走 upsert（保持 enabled=true 落库 + 触发连接） */
  const toggleMcpServer = async (row: McpServerListItem, nextEnabled: boolean) => {
    setMcpBusy(true)
    try {
      if (nextEnabled) {
        // 启用：用现有配置 upsert（enabled=true 会触发连接）
        await window.electronAPI.mcpUpsertServer({
          name: row.name,
          enabled: true,
          transport: row.transport,
          command: row.command,
          args: row.args,
          env: row.env,
          cwd: row.cwd,
          url: row.url,
          timeoutMs: row.timeout_ms,
          description: row.description,
        })
      } else {
        // 禁用：upsert enabled=false 落库 + 主动断开
        await window.electronAPI.mcpUpsertServer({
          name: row.name,
          enabled: false,
          transport: row.transport,
          command: row.command,
          args: row.args,
          env: row.env,
          cwd: row.cwd,
          url: row.url,
          timeoutMs: row.timeout_ms,
          description: row.description,
        })
      }
      await reloadMcpServers()
    } catch (e) {
      setMcpStatusMsg(`FAILED - ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setMcpBusy(false)
    }
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <PanelHeader title="SETTINGS" onClose={onClose} />

      <div className="flex-1 flex overflow-hidden">
        {/* 左侧 Tab */}
        <div className="w-48 border-r-2 border-px-border bg-px-bg flex flex-col overflow-y-auto">
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
          {/* 记忆设置 Tab */}
          <button
            onClick={() => setActiveTab(MEMORY_TAB)}
            className={`text-left px-4 py-3 border-l-3 border-t-2 border-t-px-border transition-none
              ${activeTab === MEMORY_TAB
                ? 'border-l-px-primary bg-px-surface text-px-text'
                : 'border-l-transparent text-px-text-sec hover:bg-px-surface/50 hover:text-px-text'
              }`}
          >
            <span className="font-game text-[12px] tracking-wider">MEMORY</span>
            <span className="block font-game text-[13px] mt-0.5 text-px-text-dim">记忆设置</span>
          </button>
          {/* 定时任务 Tab */}
          <button
            onClick={() => setActiveTab(CRON_TAB)}
            className={`text-left px-4 py-3 border-l-3 border-t-2 border-t-px-border transition-none
              ${activeTab === CRON_TAB
                ? 'border-l-px-primary bg-px-surface text-px-text'
                : 'border-l-transparent text-px-text-sec hover:bg-px-surface/50 hover:text-px-text'
              }`}
          >
            <span className="font-game text-[12px] tracking-wider">CRON</span>
            <span className="block font-game text-[13px] mt-0.5 text-px-text-dim">定时任务</span>
          </button>
          {/* 主题设置 Tab */}
          <button
            onClick={() => setActiveTab(THEME_TAB)}
            className={`text-left px-4 py-3 border-l-3 border-t-2 border-t-px-border transition-none
              ${activeTab === THEME_TAB
                ? 'border-l-px-primary bg-px-surface text-px-text'
                : 'border-l-transparent text-px-text-sec hover:bg-px-surface/50 hover:text-px-text'
              }`}
          >
            <span className="font-game text-[12px] tracking-wider">THEME</span>
            <span className="block font-game text-[13px] mt-0.5 text-px-text-dim">外观主题</span>
          </button>
          {/* 工具集成 Tab（外部 API Key：Tavily 搜索等） */}
          <button
            onClick={() => setActiveTab(INTEGRATIONS_TAB)}
            className={`text-left px-4 py-3 border-l-3 border-t-2 border-t-px-border transition-none
              ${activeTab === INTEGRATIONS_TAB
                ? 'border-l-px-primary bg-px-surface text-px-text'
                : 'border-l-transparent text-px-text-sec hover:bg-px-surface/50 hover:text-px-text'
              }`}
          >
            <span className="font-game text-[12px] tracking-wider">TOOLS</span>
            <span className="block font-game text-[13px] mt-0.5 text-px-text-dim">工具集成</span>
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
            <p className="font-game text-[10px] text-px-text-dim tracking-wider">SOUL V{__APP_VERSION__}</p>
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
                    <p className="font-game text-[14px] text-px-text-sec">将知识库内容提炼为百科词条，让 AI 回答更专业准确</p>
                  </div>

                  {/* 回答时参考百科 */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <span
                        className="pixel-checkbox"
                        role="checkbox"
                        aria-checked={wikiInjectRag}
                        data-checked={wikiInjectRag || undefined}
                        onClick={() => setWikiInjectRag(!wikiInjectRag)}
                        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setWikiInjectRag(!wikiInjectRag) } }}
                        tabIndex={0}
                      />
                      <div>
                        <div className="font-game text-[14px] text-px-text">回答时参考百科</div>
                        <div className="font-game text-[12px] text-px-text-dim mt-0.5">
                          AI 回答问题时自动查阅百科词条，作为补充参考提升回答质量
                        </div>
                      </div>
                    </label>
                  </div>

                  {/* 自动收藏优质回答 */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <span
                        className="pixel-checkbox"
                        role="checkbox"
                        aria-checked={wikiAutoSediment}
                        data-checked={wikiAutoSediment || undefined}
                        onClick={() => setWikiAutoSediment(!wikiAutoSediment)}
                        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setWikiAutoSediment(!wikiAutoSediment) } }}
                        tabIndex={0}
                      />
                      <div>
                        <div className="font-game text-[14px] text-px-text">自动收藏优质回答</div>
                        <div className="font-game text-[12px] text-px-text-dim mt-0.5">
                          当 AI 的回答足够详细且引用了知识来源时，自动收藏到百科中供日后查阅
                        </div>
                      </div>
                    </label>
                  </div>

                  {/* 说明 */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-2">
                    <p className="font-game text-[12px] text-px-primary tracking-wider">使用说明</p>
                    <ul className="space-y-1.5">
                      {[
                        '百科词条由知识库面板的 WIKI 按钮一键生成，无需手动编写',
                        '百科仅作为补充参考，AI 始终以知识库原文为准',
                        '收藏的优质问答也可以在消息气泡上手动点击 SAVE 触发',
                        '百科功能不会修改你的知识库文件，请放心使用',
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
          ) : activeTab === MEMORY_TAB ? (
            /* ── 记忆设置面板 ── */
            <>
              <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
                <div className="max-w-lg space-y-6">
                  <div className="border-l-3 border-px-primary pl-4 py-1">
                    <h3 className="font-game text-[16px] font-bold text-px-text mb-1">记忆设置</h3>
                    <p className="font-game text-[14px] text-px-text-sec">管理 AI 分身的长期记忆行为</p>
                  </div>

                  {/* 记忆检查频率 */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <div>
                      <div className="font-game text-[14px] text-px-text mb-1">自动记忆频率</div>
                      <div className="font-game text-[12px] text-px-text-dim mb-3">
                        AI 每隔几轮对话自动检查是否有值得记住的内容（如你的偏好、重要决定等），保存到长期记忆中
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="font-game text-[13px] text-px-text-sec">每</label>
                        <input
                          type="number"
                          min="0"
                          max="50"
                          value={nudgeInterval}
                          onChange={(e) => setNudgeInterval(e.target.value)}
                          className="pixel-input w-20 text-center"
                        />
                        <label className="font-game text-[13px] text-px-text-sec">轮检查一次</label>
                      </div>
                      <div className="font-game text-[11px] text-px-text-dim mt-2">
                        推荐值 5 · 设为 0 关闭自动记忆 · 一般无需修改
                      </div>
                    </div>
                  </div>

                  {/* 容量说明 */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-2">
                    <p className="font-game text-[12px] text-px-primary tracking-wider">关于记忆</p>
                    <ul className="space-y-1.5">
                      {[
                        '记忆空间有限，存满时 AI 会自动整理：合并重复、清除过时内容',
                        '你纠正过的信息会被优先保留，确保 AI 不会重复犯错',
                        '也可以在「记忆」面板中手动触发整理',
                        '用户画像（沟通偏好等）独立存储，不占用记忆空间',
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
                  memoryStatusMsg.includes('SAVED') ? 'text-px-success' :
                  memoryStatusMsg.includes('FAIL') || memoryStatusMsg.includes('INVALID') ? 'text-px-danger' : 'text-px-text-dim'
                }`}>
                  {memoryStatusMsg}
                </span>
                <div className="flex gap-2">
                  <button onClick={onClose} className="pixel-btn-ghost">CANCEL</button>
                  <button onClick={handleSaveMemorySettings} className="pixel-btn-primary">SAVE</button>
                </div>
              </div>
            </>
          ) : activeTab === CRON_TAB ? (
            /* ── 定时任务面板 ── */
            <>
              <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
                <div className="max-w-lg space-y-6">
                  <div className="border-l-3 border-px-primary pl-4 py-1">
                    <h3 className="font-game text-[16px] font-bold text-px-text mb-1">定时任务</h3>
                    <p className="font-game text-[14px] text-px-text-sec">让 AI 在后台定期自动执行维护工作，保持最佳状态</p>
                  </div>

                  {/* 自动整理记忆 */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <div>
                      <div className="font-game text-[14px] text-px-text mb-1">自动整理记忆</div>
                      <div className="font-game text-[12px] text-px-text-dim mb-3">
                        定期检查记忆是否快满，快满时 AI 自动整理：合并重复、清除过时内容
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="font-game text-[13px] text-px-text-sec">每</label>
                        <input
                          type="number"
                          min="0"
                          max="168"
                          value={cronMemoryInterval}
                          onChange={(e) => setCronMemoryInterval(e.target.value)}
                          className="pixel-input w-20 text-center"
                        />
                        <label className="font-game text-[13px] text-px-text-sec">小时检查一次</label>
                      </div>
                      <div className="font-game text-[11px] text-px-text-dim mt-2">
                        设为 0 关闭 · 一般无需开启，记忆满时会自动触发整理
                      </div>
                    </div>
                  </div>

                  {/* 知识库更新提醒 */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <div>
                      <div className="font-game text-[14px] text-px-text mb-1">知识库更新提醒</div>
                      <div className="font-game text-[12px] text-px-text-dim mb-3">
                        定期发送通知提醒你检查知识库是否需要更新，避免信息过时
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="font-game text-[13px] text-px-text-sec">每</label>
                        <input
                          type="number"
                          min="0"
                          max="168"
                          value={cronKnowledgeInterval}
                          onChange={(e) => setCronKnowledgeInterval(e.target.value)}
                          className="pixel-input w-20 text-center"
                        />
                        <label className="font-game text-[13px] text-px-text-sec">小时提醒一次</label>
                      </div>
                      <div className="font-game text-[11px] text-px-text-dim mt-2">
                        设为 0 关闭 · 建议知识更新频繁时开启
                      </div>
                    </div>
                  </div>

                  {/* 说明 */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-2">
                    <p className="font-game text-[12px] text-px-primary tracking-wider">注意</p>
                    <ul className="space-y-1.5">
                      {[
                        '定时任务只在应用打开时运行，关闭应用后暂停',
                        '自动整理记忆需要先在 CHAT 中配置 API Key',
                        '修改后点击 SAVE 才会生效',
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
                  cronStatusMsg.includes('SAVED') ? 'text-px-success' :
                  cronStatusMsg.includes('FAIL') ? 'text-px-danger' : 'text-px-text-dim'
                }`}>
                  {cronStatusMsg}
                </span>
                <div className="flex gap-2">
                  <button onClick={onClose} className="pixel-btn-ghost">CANCEL</button>
                  <button onClick={handleSaveCronSettings} className="pixel-btn-primary">SAVE</button>
                </div>
              </div>
            </>
          ) : activeTab === INTEGRATIONS_TAB ? (
            /* ── 工具集成面板（外部 API：Tavily 搜索等） ── */
            <>
              <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
                <div className="max-w-lg space-y-6">
                  <div className="border-l-3 border-px-primary pl-4 py-1">
                    <h3 className="font-game text-[16px] font-bold text-px-text mb-1">工具集成</h3>
                    <p className="font-game text-[14px] text-px-text-sec">配置外部工具的 API Key，让 AI 能联网搜索、抓取网页</p>
                  </div>

                  {/* Tavily Search API */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-game text-[14px] text-px-text">Tavily Search</span>
                      <span className="font-game text-[10px] text-px-text-dim tracking-wider">WEB_SEARCH</span>
                    </div>
                    <p className="font-game text-[12px] text-px-text-dim">
                      为 LLM 提供联网搜索能力。免费额度 1000 次/月，注册地址：
                      <span className="text-px-primary ml-1 font-mono">https://tavily.com</span>
                    </p>
                    <div>
                      <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">API KEY</label>
                      <div className="flex gap-2">
                        <input
                          type={showTavilyKey ? 'text' : 'password'}
                          value={tavilyApiKey}
                          onChange={(e) => setTavilyApiKey(e.target.value)}
                          placeholder="tvly-..."
                          className="pixel-input flex-1 font-mono text-[13px]"
                        />
                        <button
                          onClick={() => setShowTavilyKey(!showTavilyKey)}
                          className="pixel-btn-ghost px-3"
                          title={showTavilyKey ? '隐藏' : '显示'}
                        >
                          {showTavilyKey ? '◉' : '○'}
                        </button>
                      </div>
                      <div className="font-game text-[11px] text-px-text-dim mt-1.5">
                        留空则禁用 web_search 工具；本地 sqlite 加密存储，不会上传任何服务器
                      </div>
                    </div>
                  </div>

                  {/* 说明 */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-2">
                    <p className="font-game text-[12px] text-px-primary tracking-wider">什么时候会用到 web_search</p>
                    <ul className="space-y-1.5">
                      {[
                        '用户问到最新政策、行业新闻、最新版本号',
                        '知识库找不到答案，需要联网补充',
                        'AI 主动判断「需要查最新资料」时调用',
                      ].map((item, i) => (
                        <li key={i} className="flex gap-2 font-game text-[13px] text-px-text-sec">
                          <span className="text-px-primary flex-shrink-0">-</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* 九层重构 #16 图片生成（DashScope 通义万相） */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-game text-[14px] text-px-text">图片生成</span>
                      <span className="font-game text-[10px] text-px-text-dim tracking-wider">GENERATE_IMAGE</span>
                    </div>
                    <p className="font-game text-[12px] text-px-text-dim">
                      DashScope 通义万相 wanx2.1-t2i-turbo。注册地址：
                      <span className="text-px-primary ml-1 font-mono">https://dashscope.console.aliyun.com</span>
                    </p>
                    <div>
                      <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">API KEY</label>
                      <div className="flex gap-2">
                        <input
                          type={showImageKey ? 'text' : 'password'}
                          value={imageApiKey}
                          onChange={(e) => setImageApiKey(e.target.value)}
                          placeholder="sk-..."
                          className="pixel-input flex-1 font-mono text-[13px]"
                        />
                        <button
                          onClick={() => setShowImageKey(!showImageKey)}
                          className="pixel-btn-ghost px-3"
                          title={showImageKey ? '隐藏' : '显示'}
                        >
                          {showImageKey ? '◉' : '○'}
                        </button>
                      </div>
                      <div className="font-game text-[11px] text-px-text-dim mt-1.5">
                        留空则禁用 generate_image 工具；本地 sqlite 加密存储，不会上传任何服务器
                      </div>
                    </div>
                  </div>

                  {/* MCP Servers 区块 ─────────────────────────────────────── */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-game text-[14px] text-px-text">MCP Servers</span>
                        <span className="font-game text-[10px] text-px-text-dim tracking-wider ml-2">CALL_MCP_TOOL</span>
                      </div>
                      <button
                        onClick={() => { setMcpFormError(''); setEditingMcp(createEmptyMcpForm()) }}
                        disabled={mcpBusy}
                        className="pixel-btn-primary text-[12px] px-3 py-1 disabled:opacity-50"
                      >
                        + 添加
                      </button>
                    </div>
                    <p className="font-game text-[12px] text-px-text-dim">
                      Model Context Protocol — 接入第三方工具（GitHub / Slack / 数据库 / Tavily 等）。
                      AI 会自动通过 list_mcp_tools / call_mcp_tool 调用。
                    </p>

                    {mcpServers.length === 0 ? (
                      <div className="font-game text-[12px] text-px-text-dim text-center py-4 border border-dashed border-px-border">
                        尚未配置任何 MCP server
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {mcpServers.map((row) => {
                          const style = MCP_STATUS_STYLE[row.status] ?? MCP_STATUS_STYLE.idle
                          return (
                            <div key={row.name} className="border border-px-border bg-px-surface p-3 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                  <span className="font-mono text-[13px] text-px-text truncate">{row.name}</span>
                                  <span className={`font-game text-[10px] tracking-wider px-1.5 py-0.5 border ${style.cls}`}>
                                    {style.label}
                                  </span>
                                  <span className="font-game text-[10px] text-px-text-dim tracking-wider px-1.5 py-0.5 border border-px-border">
                                    {row.transport.toUpperCase()}
                                  </span>
                                  {row.toolCount > 0 && (
                                    <span className="font-game text-[10px] text-px-primary tracking-wider">
                                      {row.toolCount} tool{row.toolCount > 1 ? 's' : ''}
                                    </span>
                                  )}
                                </div>
                                <label className="flex items-center gap-1 cursor-pointer flex-shrink-0">
                                  <span className="font-game text-[10px] text-px-text-dim">{row.enabled ? 'ON' : 'OFF'}</span>
                                  <span
                                    className="pixel-checkbox"
                                    role="checkbox"
                                    aria-checked={row.enabled}
                                    data-checked={row.enabled || undefined}
                                    onClick={() => !mcpBusy && toggleMcpServer(row, !row.enabled)}
                                    onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !mcpBusy) { e.preventDefault(); toggleMcpServer(row, !row.enabled) } }}
                                    tabIndex={0}
                                  />
                                </label>
                              </div>
                              {row.description && (
                                <div className="font-game text-[11px] text-px-text-dim">{row.description}</div>
                              )}
                              {row.error && (
                                <div className="font-game text-[11px] text-px-danger break-all">{row.error}</div>
                              )}
                              <div className="flex gap-1 flex-wrap">
                                {(row.status === 'error' || row.status === 'disconnected') && row.enabled && (
                                  <button
                                    onClick={() => reconnectMcpServer(row.name)}
                                    disabled={mcpBusy}
                                    className="pixel-btn-ghost text-[11px] px-2 py-0.5 disabled:opacity-50"
                                  >
                                    重连
                                  </button>
                                )}
                                <button
                                  onClick={() => { setMcpFormError(''); setEditingMcp(mcpRowToForm(row)) }}
                                  disabled={mcpBusy}
                                  className="pixel-btn-ghost text-[11px] px-2 py-0.5 disabled:opacity-50"
                                >
                                  编辑
                                </button>
                                <button
                                  onClick={() => removeMcpServer(row.name)}
                                  disabled={mcpBusy}
                                  className="pixel-btn-ghost text-[11px] px-2 py-0.5 text-px-danger disabled:opacity-50"
                                >
                                  删除
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {mcpStatusMsg && (
                      <div className={`font-game text-[11px] tracking-wider ${
                        mcpStatusMsg.includes('SAVED') ? 'text-px-success' :
                        mcpStatusMsg.includes('FAIL') ? 'text-px-danger' : 'text-px-text-dim'
                      }`}>
                        {mcpStatusMsg}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 底部保存栏 */}
              <div className="flex items-center justify-between px-6 py-3 border-t-2 border-px-border bg-px-elevated">
                <span className={`font-game text-[12px] tracking-wider ${
                  integrationsStatusMsg.includes('SAVED') ? 'text-px-success' :
                  integrationsStatusMsg.includes('FAIL') ? 'text-px-danger' : 'text-px-text-dim'
                }`}>
                  {integrationsStatusMsg}
                </span>
                <div className="flex gap-2">
                  <button onClick={onClose} className="pixel-btn-ghost">CANCEL</button>
                  <button onClick={handleSaveIntegrations} className="pixel-btn-primary">SAVE</button>
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
                    onClick={handleOpenWorkspacesFolder}
                    className="w-full flex items-center gap-3 px-5 py-3 border-2 border-px-border
                      bg-px-elevated text-px-text font-game text-[14px] tracking-wider
                      hover:border-px-primary hover:text-px-primary transition-none"
                  >
                    <span className="w-8 h-8 border-2 border-px-border flex items-center justify-center text-px-text-sec font-game text-[12px] flex-shrink-0">▣</span>
                    <div className="text-left">
                      <div>打开工作区目录</div>
                      <div className="text-[12px] text-px-text-dim mt-0.5">查看当前分身各会话 exports/ 下的 PDF / Excel / Word</div>
                    </div>
                  </button>

                  <button
                    onClick={handleOpenLogsFolder}
                    className="w-full flex items-center gap-3 px-5 py-3 border-2 border-px-border
                      bg-px-elevated text-px-text font-game text-[14px] tracking-wider
                      hover:border-px-primary hover:text-px-primary transition-none"
                  >
                    <span className="w-8 h-8 border-2 border-px-border flex items-center justify-center text-px-text-sec font-game text-[12px] flex-shrink-0">▤</span>
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
                    <span className="w-8 h-8 border-2 border-px-border flex items-center justify-center text-px-text-sec font-game text-[12px] flex-shrink-0">▲</span>
                    <div className="text-left">
                      <div>{isExporting ? '导出中...' : '导出错误日志到桌面'}</div>
                      <div className="text-[12px] text-px-text-dim mt-0.5">将最近 3 天的报错整合为 txt 文件，保存到桌面</div>
                    </div>
                  </button>

                  {/* Stage 三 P2 范围外 3：工具调用审计查看入口 */}
                  <button
                    onClick={() => handleViewToolCallAudit()}
                    className="w-full flex items-center gap-3 px-5 py-3 border-2 border-px-border
                      bg-px-elevated text-px-text font-game text-[14px] tracking-wider
                      hover:border-px-primary hover:text-px-primary transition-none"
                  >
                    <span className="w-8 h-8 border-2 border-px-border flex items-center justify-center text-px-text-sec font-game text-[12px] flex-shrink-0">⚙</span>
                    <div className="text-left">
                      <div>查看工具调用审计</div>
                      <div className="text-[12px] text-px-text-dim mt-0.5">展示当日 LLM 调用工具的入参/耗时/成败摘要（脱敏）</div>
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
          ) : activeTab === THEME_TAB ? (
            /* ── 主题设置面板 ── */
            <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
              <div className="max-w-lg space-y-6">
                <div className="border-l-3 border-px-primary pl-4 py-1">
                  <h3 className="font-game text-[16px] font-bold text-px-text mb-1">外观主题</h3>
                  <p className="font-game text-[14px] text-px-text-sec">选择你喜欢的电影风格主题</p>
                </div>
                <div className="space-y-3">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTheme(t.id)}
                      className={`w-full flex items-center gap-4 px-5 py-4 border-2 transition-none text-left
                        ${themeId === t.id
                          ? 'border-px-primary bg-px-primary/10'
                          : 'border-px-border bg-px-elevated hover:border-px-text-sec'
                        }`}
                    >
                      <div className="w-10 h-10 border-2 border-px-border flex items-center justify-center flex-shrink-0">
                        {themeId === t.id
                          ? <span className="text-px-primary font-game text-[14px]">&#x2713;</span>
                          : <span className="text-px-text-dim font-game text-[12px]">&#x25C6;</span>}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-game text-[15px] text-px-text font-bold">{t.name}</span>
                          <span className="font-game text-[12px] text-px-text-dim">{t.nameEn}</span>
                          {t.isDark
                            ? <span className="pixel-badge text-[9px]">DARK</span>
                            : <span className="pixel-badge pixel-badge-success text-[9px]">LIGHT</span>}
                        </div>
                        <p className="font-game text-[13px] text-px-text-sec mt-1">{t.description}</p>
                      </div>
                    </button>
                  ))}
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

      {/* MCP server 编辑模态框（与 SettingsPanel 的主 Modal 并列，靠 isOpen 切换显隐） */}
      {editingMcp && (
        <McpServerFormModal
          form={editingMcp}
          error={mcpFormError}
          busy={mcpBusy}
          onChange={setEditingMcp}
          onCancel={() => { setEditingMcp(null); setMcpFormError('') }}
          onSubmit={submitMcpForm}
        />
      )}

      {/* Stage 三 P2 范围外 3：工具调用审计 modal */}
      {auditModal && (
        <ToolCallAuditModal
          state={auditModal}
          onClose={() => setAuditModal(null)}
          onChangeDate={(d) => handleViewToolCallAudit(d)}
        />
      )}
    </Modal>
  )
}

/**
 * 工具调用审计 modal（Stage 三 P2 范围外 3）。
 *
 * 展示某日 logs/tool-calls/<date>.jsonl 的内容：
 *   - 顶部：日期切换（前一天 / 后一天 / 今天）+ 总数 + 失败数
 *   - 列表：每行 [HH:MM:SS] [✓/✗] toolName · 耗时 · resultLen · 截短的 args
 *
 * 任何上层 store 的状态都不依赖；纯展示组件。
 */
function ToolCallAuditModal(props: {
  state: { date: string; records: ToolCallAuditEntry[]; loading: boolean; error?: string }
  onClose: () => void
  onChangeDate: (date: string) => void
}) {
  const { state, onClose, onChangeDate } = props
  const failCount = state.records.filter((r) => r.ok === false).length

  /** 日期偏移工具：basicDate +/- N 天 */
  const shiftDate = (base: string, days: number): string => {
    const [y, m, d] = base.split('-').map(Number)
    const dt = new Date(y, (m ?? 1) - 1, d ?? 1)
    dt.setDate(dt.getDate() + days)
    const yy = dt.getFullYear()
    const mm = String(dt.getMonth() + 1).padStart(2, '0')
    const dd = String(dt.getDate()).padStart(2, '0')
    return `${yy}-${mm}-${dd}`
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <div className="flex items-center justify-between px-4 py-2 border-b-2 border-px-border bg-px-elevated">
        <h3 className="font-game text-[14px] text-px-primary tracking-wider">
          工具调用审计 · {state.date}
        </h3>
        <button
          onClick={onClose}
          className="font-game text-[12px] text-px-text-dim hover:text-px-danger px-2"
          aria-label="关闭"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 flex flex-col gap-3 p-4 overflow-hidden">
        {/* 顶部统计 + 日期切换 */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 font-game text-[12px]">
            <span className="text-px-text-sec">共 {state.records.length} 条</span>
            {failCount > 0 && (
              <span className="text-px-danger">失败 {failCount} 条</span>
            )}
            {state.loading && <span className="text-px-primary animate-pulse">加载中...</span>}
            {state.error && <span className="text-px-danger">错误: {state.error}</span>}
          </div>
          <div className="flex items-center gap-1 font-game text-[11px]">
            <button
              onClick={() => onChangeDate(shiftDate(state.date, -1))}
              className="px-2 py-1 border border-px-border-dim hover:border-px-primary"
            >
              ← 前一天
            </button>
            <button
              onClick={() => onChangeDate(localDateString())}
              className="px-2 py-1 border border-px-border-dim hover:border-px-primary"
            >
              今天
            </button>
            <button
              onClick={() => onChangeDate(shiftDate(state.date, 1))}
              className="px-2 py-1 border border-px-border-dim hover:border-px-primary"
            >
              后一天 →
            </button>
          </div>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-auto border border-px-border-dim">
          {state.records.length === 0 && !state.loading && (
            <div className="p-6 text-center font-game text-[12px] text-px-text-dim">
              {state.error ? '加载失败' : '该日无工具调用记录'}
            </div>
          )}
          <ul className="divide-y divide-px-border-dim">
            {state.records.map((r, i) => {
              const time = new Date(r.ts).toTimeString().slice(0, 8)
              const cn = TOOL_NAME_MAP[r.toolName] ?? r.toolName
              const ok = r.ok !== false
              return (
                <li key={i} className="p-2 hover:bg-px-surface/30 font-game text-[11px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-px-text-dim w-16 shrink-0">{time}</span>
                    <span className={ok ? 'text-px-success w-3' : 'text-px-danger w-3'}>
                      {ok ? '✓' : '✗'}
                    </span>
                    <span className="text-px-primary">{cn}</span>
                    <span className="text-px-text-dim text-[10px]">({r.toolName})</span>
                    {typeof r.durationMs === 'number' && (
                      <span className="text-px-text-sec">{r.durationMs}ms</span>
                    )}
                    {typeof r.resultLen === 'number' && r.resultLen > 0 && (
                      <span className="text-px-text-sec">→ {r.resultLen} 字符</span>
                    )}
                  </div>
                  {r.argsPreview && (
                    <div className="ml-[72px] mt-0.5 text-px-text-dim text-[10px] break-all opacity-80">
                      args: {r.argsPreview.slice(0, 200)}{r.argsPreview.length > 200 ? '...' : ''}
                    </div>
                  )}
                  {r.error && (
                    <div className="ml-[72px] mt-0.5 text-px-danger text-[10px] break-all">
                      error: {r.error}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>

        <div className="flex justify-end">
          <button onClick={onClose} className="pixel-btn-ghost">CLOSE</button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * MCP server 编辑表单模态框（提取为独立组件避免主 SettingsPanel render 函数过长）。
 *
 * 受控组件：所有表单字段绑定到外层 form state，onChange 回写。
 * 提交逻辑由外层 onSubmit 处理（含校验异常捕获）。
 */
function McpServerFormModal(props: {
  form: McpFormState
  error: string
  busy: boolean
  onChange: (form: McpFormState) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const { form, error, busy, onChange, onCancel, onSubmit } = props
  const update = (patch: Partial<McpFormState>) => onChange({ ...form, ...patch })

  return (
    <Modal isOpen={true} onClose={onCancel} size="md">
      <PanelHeader title={form.isNew ? 'ADD MCP SERVER' : `EDIT ${form.name.toUpperCase()}`} onClose={onCancel} />

      <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
        <div className="max-w-md space-y-4">
          {/* 名称 */}
          <div>
            <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">名称 *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              disabled={!form.isNew}
              placeholder="my-server"
              className="pixel-input w-full font-mono text-[13px] disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <div className="font-game text-[11px] text-px-text-dim mt-1">
              字母 / 数字 / 下划线 / 连字符，1~32 字符；创建后不可改名
            </div>
          </div>

          {/* 启用 */}
          <label className="flex items-center gap-3 cursor-pointer">
            <span
              className="pixel-checkbox"
              role="checkbox"
              aria-checked={form.enabled}
              data-checked={form.enabled || undefined}
              onClick={() => update({ enabled: !form.enabled })}
              onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); update({ enabled: !form.enabled }) } }}
              tabIndex={0}
            />
            <span className="font-game text-[13px] text-px-text">启用（保存后立即连接）</span>
          </label>

          {/* Transport */}
          <div>
            <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">协议</label>
            <select
              value={form.transport}
              onChange={(e) => update({ transport: e.target.value as McpFormState['transport'] })}
              className="pixel-input w-full text-[13px]"
            >
              <option value="stdio">stdio（本地子进程）</option>
              <option value="http">http（远程 streamable HTTP）</option>
              <option value="sse">sse（远程 SSE，旧版）</option>
            </select>
          </div>

          {/* stdio 字段 */}
          {form.transport === 'stdio' && (
            <>
              <div>
                <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">Command *</label>
                <input
                  type="text"
                  value={form.command}
                  onChange={(e) => update({ command: e.target.value })}
                  placeholder="npx / node / python / /usr/bin/myserver"
                  className="pixel-input w-full font-mono text-[13px]"
                />
              </div>

              <div>
                <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">Args（每行一项）</label>
                <textarea
                  value={form.argsText}
                  onChange={(e) => update({ argsText: e.target.value })}
                  placeholder={`-y\n@tavily-ai/tavily-mcp`}
                  rows={3}
                  className="pixel-input w-full font-mono text-[13px] resize-y"
                />
              </div>

              <div>
                <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">Env（每行 KEY=VALUE）</label>
                <textarea
                  value={form.envText}
                  onChange={(e) => update({ envText: e.target.value })}
                  placeholder="TAVILY_API_KEY=tvly-xxx"
                  rows={3}
                  className="pixel-input w-full font-mono text-[12px] resize-y"
                />
              </div>

              <div>
                <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">工作目录（可选）</label>
                <input
                  type="text"
                  value={form.cwd}
                  onChange={(e) => update({ cwd: e.target.value })}
                  placeholder="/Users/me/projects/foo"
                  className="pixel-input w-full font-mono text-[13px]"
                />
              </div>
            </>
          )}

          {/* http / sse 字段 */}
          {(form.transport === 'http' || form.transport === 'sse') && (
            <div>
              <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">URL *</label>
              <input
                type="text"
                value={form.url}
                onChange={(e) => update({ url: e.target.value })}
                placeholder="https://api.example.com/mcp"
                className="pixel-input w-full font-mono text-[13px]"
              />
            </div>
          )}

          {/* 通用字段 */}
          <div>
            <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">超时（毫秒，可选）</label>
            <input
              type="number"
              value={form.timeoutMsText}
              onChange={(e) => update({ timeoutMsText: e.target.value })}
              placeholder="60000"
              min={1}
              className="pixel-input w-full font-mono text-[13px]"
            />
          </div>

          <div>
            <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">说明（可选）</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => update({ description: e.target.value })}
              placeholder="用 1 行话描述这个 server 的用途"
              className="pixel-input w-full text-[13px]"
            />
          </div>

          {/* 错误显示 */}
          {error && (
            <div className="px-3 py-2 border-l-3 border-l-px-danger bg-px-danger/5 font-game text-[12px] text-px-danger">
              {error}
            </div>
          )}
        </div>
      </div>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-between px-6 py-3 border-t-2 border-px-border bg-px-elevated">
        <span className="font-game text-[11px] text-px-text-dim">
          {form.isNew ? '保存后立即尝试连接' : '保存会重建该 server 的连接'}
        </span>
        <div className="flex gap-2">
          <button onClick={onCancel} disabled={busy} className="pixel-btn-ghost">CANCEL</button>
          <button onClick={onSubmit} disabled={busy} className="pixel-btn-primary">
            {busy ? '...' : 'SAVE'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
