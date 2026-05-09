import { useState, useEffect, useRef } from 'react'
import { useThemeStore, THEMES } from '../stores/themeStore'
import { DEFAULT_CHAT_MODEL, DEFAULT_VISION_MODEL, DEFAULT_OCR_MODEL, DEFAULT_CREATION_MODEL } from '../services/llm-service'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'
import { ISS_DEFAULT_TOP_N, localDateString } from '@soul/core/browser'
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

/**
 * Web Embed 编辑表单的内部状态（#15 Web Embed widget，2026-05-09）。
 *
 * Origin 白名单在表单中用 textarea 编辑（每行一条），提交时再 split + trim
 * 转成 string[]。这样表单状态扁平、易渲染。
 *
 * isNew 标识用于：
 *   - 新建模式调 embedCreate；编辑模式调 embedUpdate(id, ...)
 *   - 标题显示「新建 / 编辑」差异
 *
 * @author zhi.qu
 * @date 2026-05-09
 */
interface EmbedFormState {
  isNew: boolean
  /** 编辑模式下用于回写 embedUpdate */
  id: string
  avatarId: string
  name: string
  /** 一行一条 origin（textarea） */
  originsText: string
  /** Rate Limit 数值文本（提交时 parseInt 校验范围） */
  rateLimitText: string
  greeting: string
  enabled: boolean
}

/** 创建一个空 embed 表单（点「+ 新建 Embed」时用） */
function createEmptyEmbedForm(defaultAvatarId: string): EmbedFormState {
  return {
    isNew: true,
    id: '',
    avatarId: defaultAvatarId,
    name: '',
    originsText: '',
    rateLimitText: '30',
    greeting: '',
    enabled: true,
  }
}

/** 从 DB 行回灌表单（点「编辑」时用），origin_whitelist JSON 解析失败回退为空 */
function embedRowToForm(row: EmbedRow): EmbedFormState {
  let origins: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.origin_whitelist)
    if (Array.isArray(parsed)) {
      origins = parsed.filter((s): s is string => typeof s === 'string')
    }
  } catch (err) {
    // 损坏的 JSON 不阻塞编辑；用户可在 textarea 中手动重填
    console.warn('[Embed] origin_whitelist JSON 解析失败:', err instanceof Error ? err.message : String(err))
  }
  return {
    isNew: false,
    id: row.id,
    avatarId: row.avatar_id,
    name: row.name,
    originsText: origins.join('\n'),
    rateLimitText: String(row.rate_limit_per_min),
    greeting: row.greeting ?? '',
    enabled: row.enabled === 1,
  }
}

/**
 * 从表单状态生成 embedCreate / embedUpdate 共享的核心字段，并执行客户端校验。
 * 校验失败时抛 Error，由提交流程捕获后显示在表单错误区。
 *
 * 校验规则（与 db-embeds.ts 的 DAO 约束对齐）：
 *   - 必填：avatarId / name / 至少 1 条 origin
 *   - origin 不允许包含 `*`，且必须以 http:// 或 https:// 开头
 *   - rateLimitPerMin 取值 [5, 300]
 *   - greeting 长度 ≤ 500
 */
function embedFormToCommon(form: EmbedFormState): {
  avatarId: string
  name: string
  originWhitelist: string[]
  rateLimitPerMin: number
  greeting: string
  enabled: boolean
} {
  const avatarId = form.avatarId.trim()
  if (!avatarId) throw new Error('请选择或输入 avatar id')
  const name = form.name.trim()
  if (!name) throw new Error('请填写名称')

  const origins = form.originsText
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (origins.length === 0) {
    throw new Error('请至少配置 1 条 Origin 白名单')
  }
  for (const o of origins) {
    if (o.includes('*')) {
      throw new Error(`Origin 不允许包含 \`*\` 通配：${o}`)
    }
    if (!/^https?:\/\//i.test(o)) {
      throw new Error(`Origin 必须以 http:// 或 https:// 开头：${o}`)
    }
  }

  const rate = parseInt(form.rateLimitText, 10)
  if (!Number.isFinite(rate) || rate < 5 || rate > 300) {
    throw new Error('Rate Limit 取值范围 5~300（每分钟请求数）')
  }

  const greeting = form.greeting.trim()
  if (greeting.length > 500) {
    throw new Error('Greeting 最长 500 字符')
  }

  return {
    avatarId,
    name,
    originWhitelist: origins,
    rateLimitPerMin: rate,
    greeting,
    enabled: form.enabled,
  }
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
  /** P0 ISS：工具 embedding 重排（依赖 OCR 槽位的 DashScope Key 作 embedding） */
  const [issRerankEnabled, setIssRerankEnabled] = useState(true)
  const [issTopNInput, setIssTopNInput] = useState(String(ISS_DEFAULT_TOP_N))
  const [issStatusMsg, setIssStatusMsg] = useState('')
  /** P0+ Proxy：Anthropic /v1/messages 兼容 HTTP（仅 127.0.0.1） */
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyPort, setProxyPort] = useState('18888')
  const [proxyToken, setProxyToken] = useState('')
  const [showProxyToken, setShowProxyToken] = useState(false)
  const [proxyStatusMsg, setProxyStatusMsg] = useState('')
  // MCP servers 状态
  const [mcpServers, setMcpServers] = useState<McpServerListItem[]>([])
  const [mcpStatusMsg, setMcpStatusMsg] = useState('')
  const [mcpBusy, setMcpBusy] = useState(false)
  /** 当前在编辑的 MCP server 表单（null = 未打开模态框）。新增时是空模板。 */
  const [editingMcp, setEditingMcp] = useState<McpFormState | null>(null)
  const [mcpFormError, setMcpFormError] = useState('')
  // Web Embed widget 状态（#15 Web Embed widget，2026-05-09）
  const [embeds, setEmbeds] = useState<EmbedRow[]>([])
  const [embedPort, setEmbedPort] = useState<number | null>(null)
  const [embedStatusMsg, setEmbedStatusMsg] = useState('')
  const [embedBusy, setEmbedBusy] = useState(false)
  /** 当前在编辑的 embed 表单（null = 未展开） */
  const [editingEmbed, setEditingEmbed] = useState<EmbedFormState | null>(null)
  const [embedFormError, setEmbedFormError] = useState('')
  /** 分身列表，用于表单中的 avatar 下拉选择（拉不到时退化为文本输入） */
  const [embedAvatarList, setEmbedAvatarList] = useState<Avatar[]>([])
  // ─── 跨设备同步 / WebDAV Sync 状态（#16 WebDAV cross-device sync，2026-05-09） ───
  /** 当前持久化的 WebDAV 同步配置（不含密码明文，仅 hasPassword 标志） */
  const [syncConfig, setSyncConfig] = useState<WebDavSyncConfig | null>(null)
  /** 当前同步运行时状态（lastSyncAt / inProgress / safeStorage backend 等） */
  const [syncStatus, setSyncStatus] = useState<WebDavSyncStatus | null>(null)
  /** 表单 draft：用户编辑中的字段（password 仅在用户主动输入时传给主进程） */
  const [syncDraft, setSyncDraft] = useState({
    endpoint: '',
    username: '',
    password: '',
    basePath: '/soul-backup/',
    ignoreTlsErrors: false,
    retentionCount: '7',
    autoInterval: 'off' as WebDavSyncInterval,
    enabled: false,
  })
  /** 「测试连接」最近一次结果，用于在状态消息上方留痕 */
  const [syncTestResult, setSyncTestResult] = useState<{ ok: boolean; reason?: string } | null>(null)
  /** 子区底部统一状态消息（4s 自动清空，由 syncTimerRef 管理） */
  const [syncMessage, setSyncMessage] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(null)
  /** 远端可用备份列表（折叠面板展开后从 IPC 拉取） */
  const [remoteBackups, setRemoteBackups] = useState<RemoteBackupItem[]>([])
  /** 同步历史最近 30 条 */
  const [syncHistory, setSyncHistory] = useState<SyncHistoryRow[]>([])
  /** 是否展开「从备份恢复」面板 */
  const [showRestorePanel, setShowRestorePanel] = useState(false)
  /** 是否展开「同步历史」面板 */
  const [showHistoryPanel, setShowHistoryPanel] = useState(false)
  /** 同步操作进行中（保存 / 测试 / 备份 / 恢复 / 历史等共用，避免并发误触） */
  const [isSyncOperating, setIsSyncOperating] = useState(false)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const cronStatusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const logMsgTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const wikiTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const memoryTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const integrationsTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const issTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const proxyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const embedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** #16 WebDAV 跨设备同步状态消息倒计时 ref */
  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => {
    clearTimeout(statusTimerRef.current)
    clearTimeout(cronStatusTimerRef.current)
    clearTimeout(logMsgTimerRef.current)
    clearTimeout(wikiTimerRef.current)
    clearTimeout(memoryTimerRef.current)
    clearTimeout(integrationsTimerRef.current)
    clearTimeout(issTimerRef.current)
    clearTimeout(proxyTimerRef.current)
    clearTimeout(embedTimerRef.current)
    clearTimeout(syncTimerRef.current)
  }, [])

  const loadSeqRef = useRef(0)

  useEffect(() => {
    loadSettings()
  }, [])

  /**
   * Web Embed widget 初次加载（#15 Web Embed widget）：
   * 并行拉 embeds 列表 + 当前监听端口 + 分身列表。
   * 任一失败仅 console.warn，不阻塞其他设置加载。
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [list, port, avatars] = await Promise.all([
          window.electronAPI.embedList(),
          window.electronAPI.embedGetPort(),
          window.electronAPI.listAvatars(),
        ])
        if (cancelled) return
        setEmbeds(list)
        setEmbedPort(port)
        setEmbedAvatarList(avatars)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn('[Settings] 加载 Web Embed 状态失败:', msg)
        window.electronAPI.logEvent('error', 'embed-initial-load', msg)
      }
    })()
    return () => { cancelled = true }
  }, [])

  /**
   * #16 WebDAV 跨设备同步初次加载：
   *   - 并行拉 syncGetConfig + syncGetStatus
   *   - 用 cfg 初始化 syncDraft（密码 placeholder 由 hasPassword 控制；不回填明文）
   *   - 任一失败仅 logEvent + setSyncMessage，不阻塞其他设置加载
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [cfg, status] = await Promise.all([
          window.electronAPI.syncGetConfig(),
          window.electronAPI.syncGetStatus(),
        ])
        if (cancelled) return
        setSyncConfig(cfg)
        setSyncStatus(status)
        setSyncDraft({
          endpoint: cfg.endpoint,
          username: cfg.username,
          password: '',
          basePath: cfg.basePath || '/soul-backup/',
          ignoreTlsErrors: cfg.ignoreTlsErrors,
          retentionCount: String(cfg.retentionCount),
          autoInterval: cfg.autoInterval,
          enabled: cfg.enabled,
        })
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        window.electronAPI.logEvent('error', 'sync-initial-load', msg)
      }
    })()
    return () => { cancelled = true }
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
      const [wikiInject, wikiSediment, nudge, cronConfigs, tavilyKey, imageKey, issEn, issTop, proxEn, proxPort, proxTok] = await Promise.all([
        window.electronAPI.getSetting('wiki_inject_rag'),
        window.electronAPI.getSetting('wiki_auto_sediment'),
        window.electronAPI.getSetting('memory_nudge_interval'),
        window.electronAPI.getCronConfig(),
        window.electronAPI.getSetting('tavily_api_key'),
        window.electronAPI.getSetting('image_api_key'),
        window.electronAPI.getSetting('iss_skill_rerank_enabled'),
        window.electronAPI.getSetting('iss_skill_rerank_top_n'),
        window.electronAPI.getSetting('proxy_server_enabled'),
        window.electronAPI.getSetting('proxy_server_port'),
        window.electronAPI.getSetting('proxy_api_token'),
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
      setIssRerankEnabled(issEn !== 'false')
      setIssTopNInput(issTop && issTop.trim() !== '' ? issTop : String(ISS_DEFAULT_TOP_N))
      setProxyEnabled(proxEn === 'true')
      setProxyPort(proxPort && proxPort.trim() !== '' ? proxPort.trim() : '18888')
      setProxyToken(proxTok ?? '')

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
  /** ISS 配置写入 settings 表；关闭时不影响其他集成项 */
  const handleSaveIssSettings = async () => {
    const n = parseInt(issTopNInput.trim(), 10)
    if (!Number.isFinite(n) || n < 5 || n > 64) {
      setIssStatusMsg('INVALID — top N 取值 5~64')
      return
    }
    try {
      await Promise.all([
        window.electronAPI.setSetting('iss_skill_rerank_enabled', issRerankEnabled ? 'true' : 'false'),
        window.electronAPI.setSetting('iss_skill_rerank_top_n', String(n)),
      ])
      setIssStatusMsg('SAVED')
      window.dispatchEvent(new CustomEvent('settings-updated'))
      clearTimeout(issTimerRef.current)
      issTimerRef.current = setTimeout(() => setIssStatusMsg(''), 2000)
    } catch (error) {
      setIssStatusMsg(`FAILED - ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handleSaveProxySettings = async () => {
    const portNum = Math.floor(Number(proxyPort))
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65534) {
      setProxyStatusMsg('INVALID — 端口 1~65534')
      return
    }
    if (proxyEnabled && !proxyToken.trim()) {
      setProxyStatusMsg('启用时必须填写 Token 或点「生成 Token」')
      return
    }
    try {
      await Promise.all([
        window.electronAPI.setSetting('proxy_server_enabled', proxyEnabled ? 'true' : 'false'),
        window.electronAPI.setSetting('proxy_server_port', String(portNum)),
        window.electronAPI.setSetting('proxy_api_token', proxyToken.trim()),
      ])
      setProxyStatusMsg('SAVED — 重启应用后端口与监听生效')
      window.dispatchEvent(new CustomEvent('settings-updated'))
      clearTimeout(proxyTimerRef.current)
      proxyTimerRef.current = setTimeout(() => setProxyStatusMsg(''), 4000)
    } catch (error) {
      setProxyStatusMsg(`FAILED - ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handleGenerateProxyToken = async () => {
    try {
      if (!window.electronAPI.proxyApiGenerateToken) {
        setProxyStatusMsg('当前环境不支持生成 Token')
        return
      }
      const t = await window.electronAPI.proxyApiGenerateToken()
      setProxyToken(t)
      setProxyStatusMsg('已生成 — 请保存设置')
      clearTimeout(proxyTimerRef.current)
      proxyTimerRef.current = setTimeout(() => setProxyStatusMsg(''), 3000)
    } catch (error) {
      setProxyStatusMsg(`FAILED - ${error instanceof Error ? error.message : String(error)}`)
    }
  }

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

  // ─── Web Embed widget 管理（#15 Web Embed widget，2026-05-09） ─────────

  /**
   * 重新拉取 embeds 列表 + 当前监听端口。
   * 任一失败仅写 statusMsg 不抛错，避免阻塞编辑流程。
   */
  const reloadEmbeds = async () => {
    try {
      const [list, port] = await Promise.all([
        window.electronAPI.embedList(),
        window.electronAPI.embedGetPort(),
      ])
      setEmbeds(list)
      setEmbedPort(port)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[Embed] 加载列表失败:', msg)
      setEmbedStatusMsg(`FAILED - ${msg}`)
      window.electronAPI.logEvent('error', 'embed-reload', msg)
    }
  }

  /**
   * 在新建 / 编辑表单点「保存」时触发：
   *   - 客户端校验（embedFormToCommon）失败 → 错误显示在表单内
   *   - DAO 层（origin 含 *）失败 → 错误显示在表单内
   *   - 成功 → 收起表单 + 重新拉列表 + 状态消息
   */
  const submitEmbedForm = async () => {
    if (!editingEmbed) return
    setEmbedFormError('')
    setEmbedBusy(true)
    try {
      const data = embedFormToCommon(editingEmbed)
      if (editingEmbed.isNew) {
        await window.electronAPI.embedCreate({
          avatarId: data.avatarId,
          name: data.name,
          originWhitelist: data.originWhitelist,
          rateLimitPerMin: data.rateLimitPerMin,
          greeting: data.greeting || undefined,
          enabled: data.enabled,
        })
        setEmbedStatusMsg(`SAVED - 已添加 ${data.name}`)
      } else {
        await window.electronAPI.embedUpdate(editingEmbed.id, {
          avatarId: data.avatarId,
          name: data.name,
          originWhitelist: data.originWhitelist,
          rateLimitPerMin: data.rateLimitPerMin,
          // 空字符串 → null（DAO 接受 null 表示清空 greeting）
          greeting: data.greeting ? data.greeting : null,
          enabled: data.enabled,
        })
        setEmbedStatusMsg(`SAVED - 已更新 ${data.name}`)
      }
      setEditingEmbed(null)
      await reloadEmbeds()
      window.electronAPI.logEvent('info', editingEmbed.isNew ? 'embed-create' : 'embed-update', data.name)
      clearTimeout(embedTimerRef.current)
      embedTimerRef.current = setTimeout(() => setEmbedStatusMsg(''), 3000)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setEmbedFormError(msg)
      window.electronAPI.logEvent('error', 'embed-upsert', msg)
    } finally {
      setEmbedBusy(false)
    }
  }

  /** 删除 embed（带 confirm 防误操作） */
  const removeEmbed = async (row: EmbedRow) => {
    if (!window.confirm(`确认删除 Web Embed '${row.name}'？该接入面将立即失效。`)) return
    setEmbedBusy(true)
    try {
      await window.electronAPI.embedDelete(row.id)
      await reloadEmbeds()
      setEmbedStatusMsg(`SAVED - 已删除 ${row.name}`)
      window.electronAPI.logEvent('info', 'embed-delete', row.name)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setEmbedStatusMsg(`FAILED - ${msg}`)
      window.electronAPI.logEvent('error', 'embed-delete', msg)
    } finally {
      setEmbedBusy(false)
      clearTimeout(embedTimerRef.current)
      embedTimerRef.current = setTimeout(() => setEmbedStatusMsg(''), 3000)
    }
  }

  /** 启用/禁用 toggle */
  const toggleEmbedEnabled = async (row: EmbedRow, nextEnabled: boolean) => {
    setEmbedBusy(true)
    try {
      await window.electronAPI.embedSetEnabled(row.id, nextEnabled)
      await reloadEmbeds()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setEmbedStatusMsg(`FAILED - ${msg}`)
      window.electronAPI.logEvent('error', 'embed-set-enabled', msg)
    } finally {
      setEmbedBusy(false)
    }
  }

  /** 启动 widget-server（点列表上方「启动」按钮） */
  const handleEmbedServerStart = async () => {
    setEmbedBusy(true)
    try {
      const r = await window.electronAPI.embedServerStart()
      setEmbedPort(r.port)
      setEmbedStatusMsg(`SAVED - 服务已启动 :${r.port}`)
      window.electronAPI.logEvent('info', 'embed-server-start', String(r.port))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setEmbedStatusMsg(`FAILED - ${msg}`)
      window.electronAPI.logEvent('error', 'embed-server-start', msg)
    } finally {
      setEmbedBusy(false)
      clearTimeout(embedTimerRef.current)
      embedTimerRef.current = setTimeout(() => setEmbedStatusMsg(''), 3000)
    }
  }

  /** 停止 widget-server（带 confirm，防误关导致接入面集体失效） */
  const handleEmbedServerStop = async () => {
    if (!window.confirm('确认关闭 Web Embed widget 服务？所有外站接入面将无法对话。')) return
    setEmbedBusy(true)
    try {
      await window.electronAPI.embedServerStop()
      setEmbedPort(null)
      setEmbedStatusMsg('SAVED - 服务已停止')
      window.electronAPI.logEvent('info', 'embed-server-stop', 'manual')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setEmbedStatusMsg(`FAILED - ${msg}`)
      window.electronAPI.logEvent('error', 'embed-server-stop', msg)
    } finally {
      setEmbedBusy(false)
      clearTimeout(embedTimerRef.current)
      embedTimerRef.current = setTimeout(() => setEmbedStatusMsg(''), 3000)
    }
  }

  /**
   * 复制嵌入代码到剪贴板。模板与第 4.13 节技术方案一致：
   *   <script src="http://localhost:<port>/embed.js"
   *           data-embed-id="emb_..."
   *           data-server="http://localhost:<port>" defer></script>
   *   <soul-embed></soul-embed>
   * 服务未启动时拒绝复制（避免用户拿到无法工作的片段）。
   */
  const handleCopyEmbedSnippet = async (row: EmbedRow) => {
    if (embedPort === null) {
      setEmbedStatusMsg('FAILED - 请先启动 Web Embed 服务')
      clearTimeout(embedTimerRef.current)
      embedTimerRef.current = setTimeout(() => setEmbedStatusMsg(''), 3000)
      return
    }
    const snippet =
      `<script src="http://localhost:${embedPort}/embed.js"\n` +
      `        data-embed-id="${row.id}"\n` +
      `        data-server="http://localhost:${embedPort}"\n` +
      `        defer></script>\n` +
      `<soul-embed></soul-embed>`
    try {
      await navigator.clipboard.writeText(snippet)
      setEmbedStatusMsg(`SAVED - 嵌入码已复制（${row.name}）`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setEmbedStatusMsg(`FAILED - 剪贴板写入失败：${msg}`)
      window.electronAPI.logEvent('error', 'embed-copy-snippet', msg)
    } finally {
      clearTimeout(embedTimerRef.current)
      embedTimerRef.current = setTimeout(() => setEmbedStatusMsg(''), 3000)
    }
  }

  // ─── 跨设备同步 / WebDAV Sync 管理（#16 WebDAV cross-device sync，2026-05-09） ───

  /**
   * 自动间隔的中文标签映射，用于状态卡片展示。放在 render 闭包内，
   * 避免在文件顶层增加额外导出（与 #15 同款 inline 风格）。
   */
  const SYNC_INTERVAL_LABEL: Record<WebDavSyncInterval, string> = {
    'off': '关闭',
    'hourly': '每小时',
    'every-6-hours': '每 6 小时',
    'daily': '每天 09:00',
  }

  /** 将字节数格式化为友好字符串：B / KB / MB */
  const formatSyncBytes = (n: number): string => {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }

  /** 将 unix 毫秒时间戳格式化为「YYYY-MM-DD HH:mm」 */
  const formatSyncTs = (ts: number | null): string => {
    if (!ts) return '从未'
    const d = new Date(ts)
    const date = localDateString(d)
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    return `${date} ${time}`
  }

  /**
   * 子区底部状态消息助手：4s 后自动清空。
   * type=success/info/error 决定颜色（与 #15 SAVED/FAILED 文案不同款，本子区直接用 type）。
   */
  const setSyncMsg = (type: 'info' | 'success' | 'error', text: string) => {
    setSyncMessage({ type, text })
    clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => setSyncMessage(null), 4000)
  }

  /**
   * 重新拉 syncStatus（备份后 / 恢复后 / 配置保存后调用）。
   * 失败时仅 logEvent，不阻塞其他流程。
   */
  const reloadSyncStatus = async () => {
    try {
      const status = await window.electronAPI.syncGetStatus()
      setSyncStatus(status)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      window.electronAPI.logEvent('error', 'sync-reload-status', msg)
    }
  }

  /**
   * 「测试连接」：用当前表单字段调 IPC 验证 WebDAV 可达性，不写盘。
   * 密码为空时主进程会回退到持久化密码。
   */
  const handleSyncTestConnection = async () => {
    if (!syncDraft.endpoint || !syncDraft.username) {
      setSyncMsg('error', '请先填写服务器地址和用户名')
      return
    }
    setIsSyncOperating(true)
    setSyncTestResult(null)
    try {
      const r = await window.electronAPI.syncTestConnection({
        endpoint: syncDraft.endpoint,
        username: syncDraft.username,
        password: syncDraft.password || undefined,
        basePath: syncDraft.basePath,
        ignoreTlsErrors: syncDraft.ignoreTlsErrors,
      })
      setSyncTestResult(r)
      if (r.ok) {
        setSyncMsg('success', '连接测试成功')
      } else {
        setSyncMsg('error', `连接测试失败：${r.reason || '未知错误'}`)
      }
      window.electronAPI.logEvent('info', 'sync-test-connection', r.ok ? 'ok' : (r.reason || 'failed'))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSyncTestResult({ ok: false, reason: msg })
      setSyncMsg('error', `连接测试失败：${msg}`)
      window.electronAPI.logEvent('error', 'sync-test-connection', msg)
    } finally {
      setIsSyncOperating(false)
    }
  }

  /**
   * 「保存配置」：写入 IPC；password 仅在用户输入时传，空字符串不传以保持原值。
   * retentionCount 在前端先做 1-30 范围校验，主进程会再 clamp 一次。
   */
  const handleSyncSaveConfig = async () => {
    const retentionNum = parseInt(syncDraft.retentionCount, 10)
    if (!Number.isFinite(retentionNum) || retentionNum < 1 || retentionNum > 30) {
      setSyncMsg('error', '保留份数应为 1-30 的整数')
      return
    }
    setIsSyncOperating(true)
    try {
      const input: WebDavSetConfigInput = {
        enabled: syncDraft.enabled,
        endpoint: syncDraft.endpoint,
        username: syncDraft.username,
        basePath: syncDraft.basePath,
        ignoreTlsErrors: syncDraft.ignoreTlsErrors,
        retentionCount: retentionNum,
        autoInterval: syncDraft.autoInterval,
      }
      if (syncDraft.password) input.password = syncDraft.password
      const updated = await window.electronAPI.syncSetConfig(input)
      setSyncConfig(updated)
      setSyncDraft((prev) => ({ ...prev, password: '' }))
      setSyncMsg('success', '配置已保存')
      window.electronAPI.logEvent('info', 'sync-set-config', updated.endpoint)
      await reloadSyncStatus()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSyncMsg('error', `保存失败：${msg}`)
      window.electronAPI.logEvent('error', 'sync-set-config', msg)
    } finally {
      setIsSyncOperating(false)
    }
  }

  /** 「清除凭据」：弹 confirm，确认后清空密码；其他配置保留。 */
  const handleSyncClearCredentials = async () => {
    if (!window.confirm('确认清除已保存的 WebDAV 密码？后续同步前需重新填写。')) return
    setIsSyncOperating(true)
    try {
      await window.electronAPI.syncClearCredentials()
      const cfg = await window.electronAPI.syncGetConfig()
      setSyncConfig(cfg)
      setSyncDraft((prev) => ({ ...prev, password: '' }))
      setSyncMsg('success', '密码已清除')
      window.electronAPI.logEvent('info', 'sync-clear-credentials', 'manual')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSyncMsg('error', `清除失败：${msg}`)
      window.electronAPI.logEvent('error', 'sync-clear-credentials', msg)
    } finally {
      setIsSyncOperating(false)
    }
  }

  /** 「立即备份」：触发一次同步；并发由主进程拒绝并返回错误。 */
  const handleSyncBackupNow = async () => {
    setIsSyncOperating(true)
    setSyncMsg('info', '正在备份…')
    try {
      const r = await window.electronAPI.syncBackupNow()
      if (r.ok) {
        const sizeText = r.totalBytes !== undefined ? formatSyncBytes(r.totalBytes) : '?'
        setSyncMsg('success', `备份成功：${r.filename ?? '(unknown)'} (${sizeText})`)
        window.electronAPI.logEvent('info', 'sync-backup-now', r.filename ?? '')
      } else {
        setSyncMsg('error', `备份失败：${r.error || '未知错误'}`)
        window.electronAPI.logEvent('error', 'sync-backup-now', r.error || 'unknown')
      }
      await reloadSyncStatus()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSyncMsg('error', `备份失败：${msg}`)
      window.electronAPI.logEvent('error', 'sync-backup-now', msg)
    } finally {
      setIsSyncOperating(false)
    }
  }

  /** 「刷新备份列表」：从 WebDAV 拉远端备份索引（按 lastModified 倒序） */
  const handleSyncListRemoteBackups = async () => {
    setIsSyncOperating(true)
    try {
      const list = await window.electronAPI.syncListRemoteBackups()
      setRemoteBackups(list)
      if (list.length === 0) {
        setSyncMsg('info', '远端暂无可用备份')
      } else {
        setSyncMsg('success', `已加载 ${list.length} 份远端备份`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSyncMsg('error', `拉取列表失败：${msg}`)
      window.electronAPI.logEvent('error', 'sync-list-remote', msg)
    } finally {
      setIsSyncOperating(false)
    }
  }

  /**
   * 「恢复」：弹 confirm（含覆盖 + 重启警告），确认后调 IPC。
   * 主进程在 ok=true 后会自动 relaunch + exit，前端 UI 不一定能看到下文。
   */
  const handleSyncRestoreFrom = async (filename: string) => {
    if (!window.confirm(
      `确认从 ${filename} 恢复？\n\n` +
      '本地数据库与设置将被覆盖，应用会自动重启。\n' +
      '当前数据将被备份至 .soul/backup/pre-restore/。',
    )) return
    setIsSyncOperating(true)
    setSyncMsg('info', '正在恢复…应用即将重启')
    try {
      const r = await window.electronAPI.syncRestoreFrom(filename)
      if (!r.ok) {
        setSyncMsg('error', `恢复失败：${r.error || '未知错误'}`)
        window.electronAPI.logEvent('error', 'sync-restore', r.error || 'unknown')
      } else {
        window.electronAPI.logEvent('info', 'sync-restore', filename)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSyncMsg('error', `恢复失败：${msg}`)
      window.electronAPI.logEvent('error', 'sync-restore', msg)
    } finally {
      setIsSyncOperating(false)
    }
  }

  /** 「查看同步历史」展开时拉历史，最多 30 条 */
  const handleSyncLoadHistory = async () => {
    setIsSyncOperating(true)
    try {
      const rows = await window.electronAPI.syncListHistory({ limit: 30 })
      setSyncHistory(rows)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSyncMsg('error', `加载历史失败：${msg}`)
      window.electronAPI.logEvent('error', 'sync-list-history', msg)
    } finally {
      setIsSyncOperating(false)
    }
  }

  /** 「清空历史」：弹 confirm，确认后调 IPC */
  const handleSyncClearHistory = async () => {
    if (!window.confirm('确认清空全部同步历史？此操作不可撤销。')) return
    setIsSyncOperating(true)
    try {
      const n = await window.electronAPI.syncClearHistory()
      setSyncHistory([])
      setSyncMsg('success', `已清空 ${n} 条历史记录`)
      window.electronAPI.logEvent('info', 'sync-clear-history', String(n))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSyncMsg('error', `清空失败：${msg}`)
      window.electronAPI.logEvent('error', 'sync-clear-history', msg)
    } finally {
      setIsSyncOperating(false)
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

                  {/* P0+ Proxy API（Anthropic /v1/messages） */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-game text-[14px] text-px-text">Proxy API（Cursor / Claude Code）</span>
                      <span className="font-game text-[10px] text-px-text-dim tracking-wider">ANTHROPIC_COMPAT</span>
                    </div>
                    <p className="font-game text-[12px] text-px-text-dim">
                      仅监听 <span className="font-mono text-px-primary">127.0.0.1</span>。外部客户端使用 Soul 内同一条会话链（tools/MCP 与界面一致）。
                      请求必须带 <span className="font-mono">Authorization: Bearer &lt;下方 Token&gt;</span> 与{' '}
                      <span className="font-mono">x-soul-conversation-id: &lt;侧边栏会话 ID&gt;</span>。
                      POST <span className="font-mono">http://127.0.0.1:{proxyPort || '18888'}/v1/messages</span>，body 为 Anthropic Messages 格式；取最后一条 user 文本发起 Soul 对话。
                    </p>
                    <label className="flex items-center gap-2 font-game text-[13px] text-px-text cursor-pointer">
                      <input
                        type="checkbox"
                        checked={proxyEnabled}
                        onChange={(e) => setProxyEnabled(e.target.checked)}
                        className="h-4 w-4 accent-px-primary"
                      />
                      启用 Proxy 服务
                    </label>
                    <div>
                      <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">端口（默认 18888）</label>
                      <input
                        type="number"
                        min={1}
                        max={65534}
                        value={proxyPort}
                        onChange={(e) => setProxyPort(e.target.value)}
                        className="pixel-input w-28 font-mono text-[13px]"
                      />
                    </div>
                    <div>
                      <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">Bearer Token</label>
                      <div className="flex gap-2 flex-wrap">
                        <input
                          type={showProxyToken ? 'text' : 'password'}
                          value={proxyToken}
                          onChange={(e) => setProxyToken(e.target.value)}
                          placeholder="保存前点击生成或自行粘贴"
                          className="pixel-input flex-1 min-w-[200px] font-mono text-[13px]"
                        />
                        <button
                          type="button"
                          onClick={() => setShowProxyToken(!showProxyToken)}
                          className="pixel-btn-ghost px-3"
                          title={showProxyToken ? '隐藏' : '显示'}
                        >
                          {showProxyToken ? '◉' : '○'}
                        </button>
                        <button type="button" onClick={handleGenerateProxyToken} className="pixel-btn-ghost text-[12px] px-3 py-1">
                          生成 Token
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" onClick={handleSaveProxySettings} className="pixel-btn-primary text-[12px] px-3 py-1">
                        保存 Proxy 设置
                      </button>
                      <span className={`font-game text-[12px] ${
                        proxyStatusMsg.includes('SAVED') ? 'text-px-success' :
                        proxyStatusMsg.includes('FAIL') || proxyStatusMsg.includes('INVALID') ? 'text-px-danger' : 'text-px-text-dim'
                      }`}>{proxyStatusMsg}</span>
                    </div>
                  </div>

                  {/* P0 ISS：智能工具筛选（embedding rerank） */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-game text-[14px] text-px-text">智能工具筛选 (ISS)</span>
                      <span className="font-game text-[10px] text-px-text-dim tracking-wider">EMBED_RERANK</span>
                    </div>
                    <p className="font-game text-[12px] text-px-text-dim">
                      当可用工具多于 top N 时，用用户消息与工具描述的向量相似度截断列表，降低每次请求的 tools token。
                      需要配置下方「OCR」槽位的 DashScope Key（与 text-embedding-v3 同源 endpoint）。
                      网关工具 <span className="font-mono text-px-primary">list_mcp_tools</span> /{' '}
                      <span className="font-mono text-px-primary">call_mcp_tool</span> 等始终保留。
                    </p>
                    <label className="flex items-center gap-2 font-game text-[13px] text-px-text cursor-pointer">
                      <input
                        type="checkbox"
                        checked={issRerankEnabled}
                        onChange={(e) => setIssRerankEnabled(e.target.checked)}
                        className="h-4 w-4 accent-px-primary"
                      />
                      启用 ISS
                    </label>
                    <div>
                      <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">TOP N（默认 {ISS_DEFAULT_TOP_N}）</label>
                      <input
                        type="number"
                        min={5}
                        max={64}
                        value={issTopNInput}
                        onChange={(e) => setIssTopNInput(e.target.value)}
                        className="pixel-input w-28 font-mono text-[13px]"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" onClick={handleSaveIssSettings} className="pixel-btn-primary text-[12px] px-3 py-1">
                        保存 ISS 设置
                      </button>
                      <span className={`font-game text-[12px] ${
                        issStatusMsg.includes('SAVED') ? 'text-px-success' :
                        issStatusMsg.includes('FAIL') || issStatusMsg.includes('INVALID') ? 'text-px-danger' : 'text-px-text-dim'
                      }`}>{issStatusMsg}</span>
                    </div>
                  </div>

                  {/*
                   * Web Embed widget 区块（#15 Web Embed widget，2026-05-09，author: zhi.qu）
                   *
                   * 与 desktop-app/electron/widget-server.ts + db-embeds.ts 配套：
                   *   - 顶部：服务监听状态（embedGetPort 异步加载）+ 启动 / 停止
                   *   - 列表：每条 embed 显示 id / avatar / origin 数 / rate limit / 更新日期
                   *           + 复制嵌入码 / 编辑 / 启停 / 删除
                   *   - 底部：editingEmbed != null 时浮现 inline 表单（与 MCP 模态框风格一致，
                   *           但简化为 inline 不弹独立 Modal）
                   * 状态消息（embedStatusMsg）3s 自动清空，由 embedTimerRef 管理。
                   */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-game text-[14px] text-px-text">Web Embed widget</span>
                        <span className="font-game text-[10px] text-px-text-dim tracking-wider ml-2">EMBED_BOT</span>
                      </div>
                      <button
                        onClick={() => {
                          setEmbedFormError('')
                          const fallbackAvatar = activeAvatarId ?? embedAvatarList[0]?.id ?? ''
                          setEditingEmbed(createEmptyEmbedForm(fallbackAvatar))
                        }}
                        disabled={embedBusy}
                        className="pixel-btn-primary text-[12px] px-3 py-1 disabled:opacity-50"
                      >
                        + 新建 Embed
                      </button>
                    </div>
                    <p className="font-game text-[12px] text-px-text-dim">
                      把分身嵌入到自己的网站作为聊天 widget。仅监听
                      <span className="font-mono text-px-primary mx-1">127.0.0.1</span>
                      ，origin 白名单严格匹配（禁止 <span className="font-mono">*</span>），每个 embed 独立 rate limit。
                    </p>

                    {/* 服务监听状态 + 启停按钮 */}
                    <div className="flex items-center flex-wrap gap-2">
                      <span className="font-game text-[12px] text-px-text-sec tracking-wider">SERVER:</span>
                      {embedPort !== null ? (
                        <>
                          <span className="font-game text-[11px] text-px-success border border-px-success px-1.5 py-0.5 tracking-wider">
                            RUNNING :{embedPort}
                          </span>
                          <button
                            type="button"
                            onClick={handleEmbedServerStop}
                            disabled={embedBusy}
                            className="pixel-btn-ghost text-[11px] px-2 py-0.5 disabled:opacity-50"
                          >
                            停止服务
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="font-game text-[11px] text-px-text-dim border border-px-border px-1.5 py-0.5 tracking-wider">
                            STOPPED
                          </span>
                          <button
                            type="button"
                            onClick={handleEmbedServerStart}
                            disabled={embedBusy}
                            className="pixel-btn-ghost text-[11px] px-2 py-0.5 disabled:opacity-50"
                          >
                            启动服务
                          </button>
                        </>
                      )}
                    </div>

                    {/* embed 列表 / 空态 */}
                    {embeds.length === 0 ? (
                      <div className="font-game text-[12px] text-px-text-dim text-center py-4 border border-dashed border-px-border">
                        还没有 Web Embed，点击「+ 新建 Embed」开始
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {embeds.map((row) => {
                          let originCount = 0
                          try {
                            const parsed: unknown = JSON.parse(row.origin_whitelist)
                            if (Array.isArray(parsed)) originCount = parsed.length
                          } catch (e) {
                            // 损坏的 JSON 不阻塞渲染（已在 embedRowToForm 容错），仅 warn 一次
                            void e
                          }
                          const updatedDate = localDateString(new Date(row.updated_at))
                          const isEnabled = row.enabled === 1
                          return (
                            <div key={row.id} className="border border-px-border bg-px-surface p-3 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
                                  <span className="font-mono text-[13px] text-px-text truncate">{row.name}</span>
                                  <span className="font-game text-[10px] text-px-text-dim tracking-wider">{row.id}</span>
                                  <span className={`font-game text-[10px] tracking-wider px-1.5 py-0.5 border ${
                                    isEnabled
                                      ? 'text-px-success border-px-success'
                                      : 'text-px-text-dim border-px-border'
                                  }`}>
                                    {isEnabled ? 'ENABLED' : 'DISABLED'}
                                  </span>
                                </div>
                                <label className="flex items-center gap-1 cursor-pointer flex-shrink-0">
                                  <span className="font-game text-[10px] text-px-text-dim">{isEnabled ? 'ON' : 'OFF'}</span>
                                  <span
                                    className="pixel-checkbox"
                                    role="checkbox"
                                    aria-checked={isEnabled}
                                    data-checked={isEnabled || undefined}
                                    onClick={() => !embedBusy && toggleEmbedEnabled(row, !isEnabled)}
                                    onKeyDown={(e) => {
                                      if ((e.key === ' ' || e.key === 'Enter') && !embedBusy) {
                                        e.preventDefault()
                                        toggleEmbedEnabled(row, !isEnabled)
                                      }
                                    }}
                                    tabIndex={0}
                                  />
                                </label>
                              </div>
                              <div className="font-game text-[11px] text-px-text-dim space-y-0.5">
                                <div>
                                  avatar: <span className="font-mono text-px-text-sec">{row.avatar_id}</span>
                                </div>
                                <div>
                                  origins: {originCount} 条 / {row.rate_limit_per_min} req/min · 更新于 {updatedDate}
                                </div>
                                {row.greeting && (
                                  <div className="text-px-text-sec break-all">greeting: {row.greeting}</div>
                                )}
                              </div>
                              <div className="flex gap-1 flex-wrap">
                                <button
                                  onClick={() => handleCopyEmbedSnippet(row)}
                                  disabled={embedBusy}
                                  className="pixel-btn-ghost text-[11px] px-2 py-0.5 disabled:opacity-50"
                                >
                                  复制嵌入码
                                </button>
                                <button
                                  onClick={() => { setEmbedFormError(''); setEditingEmbed(embedRowToForm(row)) }}
                                  disabled={embedBusy}
                                  className="pixel-btn-ghost text-[11px] px-2 py-0.5 disabled:opacity-50"
                                >
                                  编辑
                                </button>
                                <button
                                  onClick={() => removeEmbed(row)}
                                  disabled={embedBusy}
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

                    {/* 编辑表单（inline 浮现，editingEmbed != null 时显示） */}
                    {editingEmbed && (
                      <div className="border-2 border-px-primary bg-px-surface p-3 space-y-3">
                        <div className="font-game text-[13px] text-px-primary tracking-wider">
                          {editingEmbed.isNew ? '新建 Web Embed' : `编辑 ${editingEmbed.id}`}
                        </div>

                        {/* 分身（avatar）选择：有 listAvatars 数据则下拉，否则退化为文本输入 */}
                        <div>
                          <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">
                            分身 (Avatar)
                          </label>
                          {embedAvatarList.length > 0 ? (
                            <select
                              value={editingEmbed.avatarId}
                              onChange={(e) => setEditingEmbed({ ...editingEmbed, avatarId: e.target.value })}
                              className="pixel-input w-full font-mono text-[13px]"
                            >
                              <option value="">— 请选择 —</option>
                              {embedAvatarList.map((a) => (
                                <option key={a.id} value={a.id}>{a.name}（{a.id}）</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={editingEmbed.avatarId}
                              onChange={(e) => setEditingEmbed({ ...editingEmbed, avatarId: e.target.value })}
                              placeholder="请输入 avatar id（在分身切换面板中可见）"
                              className="pixel-input w-full font-mono text-[13px]"
                            />
                          )}
                        </div>

                        <div>
                          <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">名称</label>
                          <input
                            type="text"
                            value={editingEmbed.name}
                            onChange={(e) => setEditingEmbed({ ...editingEmbed, name: e.target.value })}
                            placeholder="例如：博客客服 / 官网售前"
                            className="pixel-input w-full font-mono text-[13px]"
                          />
                        </div>

                        <div>
                          <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">
                            ORIGIN 白名单（一行一条，以 http:// 或 https:// 开头，禁止 *）
                          </label>
                          <textarea
                            value={editingEmbed.originsText}
                            onChange={(e) => setEditingEmbed({ ...editingEmbed, originsText: e.target.value })}
                            placeholder={'https://blog.example.com\nhttp://localhost:3000'}
                            rows={4}
                            className="pixel-input w-full font-mono text-[12px]"
                          />
                        </div>

                        <div>
                          <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">
                            RATE LIMIT（每分钟请求数，5~300，默认 30）
                          </label>
                          <input
                            type="number"
                            min={5}
                            max={300}
                            value={editingEmbed.rateLimitText}
                            onChange={(e) => setEditingEmbed({ ...editingEmbed, rateLimitText: e.target.value })}
                            className="pixel-input w-28 font-mono text-[13px]"
                          />
                        </div>

                        <div>
                          <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">
                            GREETING（开场白，≤ 500 字符，可选）
                          </label>
                          <textarea
                            value={editingEmbed.greeting}
                            onChange={(e) => setEditingEmbed({ ...editingEmbed, greeting: e.target.value })}
                            placeholder="访客打开聊天 widget 时的首条提示"
                            rows={2}
                            maxLength={500}
                            className="pixel-input w-full font-mono text-[12px]"
                          />
                        </div>

                        <label className="flex items-center gap-2 font-game text-[13px] text-px-text cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editingEmbed.enabled}
                            onChange={(e) => setEditingEmbed({ ...editingEmbed, enabled: e.target.checked })}
                            className="h-4 w-4 accent-px-primary"
                          />
                          启用此 Embed
                        </label>

                        {embedFormError && (
                          <div className="font-game text-[11px] text-px-danger break-all">{embedFormError}</div>
                        )}

                        <div className="flex gap-2 flex-wrap">
                          <button
                            type="button"
                            onClick={submitEmbedForm}
                            disabled={embedBusy}
                            className="pixel-btn-primary text-[12px] px-3 py-1 disabled:opacity-50"
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            onClick={() => { setEditingEmbed(null); setEmbedFormError('') }}
                            disabled={embedBusy}
                            className="pixel-btn-ghost text-[12px] px-3 py-1 disabled:opacity-50"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}

                    {embedStatusMsg && (
                      <div className={`font-game text-[11px] tracking-wider ${
                        embedStatusMsg.includes('SAVED') ? 'text-px-success' :
                        embedStatusMsg.includes('FAIL') ? 'text-px-danger' : 'text-px-text-dim'
                      }`}>
                        {embedStatusMsg}
                      </div>
                    )}
                  </div>

                  {/* === 跨设备同步 / WebDAV Sync (#16) === */}
                  {/*
                   * #16 WebDAV 跨设备同步子区（2026-05-09，author: zhi.qu）
                   *
                   * 与 desktop-app/electron/sync/sync-manager.ts + db-sync-history.ts 配套：
                   *   - 顶部：状态卡片（lastSyncAt / direction / inProgress / deviceId / safeStorage backend）
                   *   - 表单：endpoint / username / password / basePath / ignoreTlsErrors /
                   *           retentionCount / autoInterval / enabled
                   *   - 操作：测试连接 / 保存配置 / 清除凭据 / 立即备份 / 从备份恢复
                   *   - 折叠：远端备份列表 + 同步历史
                   *
                   * 风格与 #15 Web Embed widget 子区 1:1 对齐（border-2 border-px-border bg-px-elevated p-4）。
                   * 子区内所有副作用错误均通过 setSyncMsg + logEvent 上报，不使用 console.*。
                   */}
                  <div className="border-2 border-px-border bg-px-elevated p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-game text-[14px] text-px-text">跨设备同步</span>
                        <span className="font-game text-[10px] text-px-text-dim tracking-wider ml-2">WEBDAV_SYNC</span>
                      </div>
                      <span className={`font-game text-[10px] tracking-wider px-1.5 py-0.5 border ${
                        syncStatus?.inProgress
                          ? 'text-px-warning border-px-warning'
                          : syncConfig?.enabled
                          ? 'text-px-success border-px-success'
                          : 'text-px-text-dim border-px-border'
                      }`}>
                        {syncStatus?.inProgress
                          ? 'SYNCING'
                          : syncConfig?.enabled
                          ? 'ENABLED'
                          : 'DISABLED'}
                      </span>
                    </div>
                    <p className="font-game text-[12px] text-px-text-dim">
                      通过 WebDAV（坚果云 / Nextcloud / 自建）在多台设备间备份与恢复全部数据。
                      密码经 OS 密钥环加密（macOS Keychain / Windows DPAPI / Linux libsecret）。
                    </p>

                    {/* A. 状态卡片 */}
                    <div className="border border-px-border bg-px-surface p-3 space-y-1">
                      <div className="font-game text-[11px] text-px-text-dim tracking-wider">SYNC STATUS</div>
                      {syncStatus ? (
                        <>
                          <div className="font-game text-[12px] text-px-text-sec">
                            上次同步：{formatSyncTs(syncStatus.lastSyncAt)}
                            {syncStatus.lastSyncDirection && (
                              <span className="ml-2">
                                {syncStatus.lastSyncDirection === 'backup' ? '备份' : '恢复'}
                              </span>
                            )}
                            {syncStatus.lastSyncStatus && (
                              <span className={`ml-2 ${
                                syncStatus.lastSyncStatus === 'success' ? 'text-px-success' : 'text-px-danger'
                              }`}>
                                {syncStatus.lastSyncStatus === 'success' ? '成功' : '失败'}
                              </span>
                            )}
                          </div>
                          <div className="font-game text-[11px] text-px-text-dim">
                            DEVICE_ID: <span className="font-mono">{syncStatus.deviceId.slice(0, 8)}…</span>
                            <span className="ml-3">AUTO: {SYNC_INTERVAL_LABEL[syncConfig?.autoInterval ?? 'off']}</span>
                          </div>
                          {syncStatus.lastSyncError && (
                            <div className="font-game text-[11px] text-px-danger break-all">
                              ERROR: {syncStatus.lastSyncError}
                            </div>
                          )}
                          {!syncStatus.storageBackendSecure && (
                            <div className="font-game text-[11px] text-px-warning break-all">
                              ⚠ 当前 OS 密钥环不可用（{syncStatus.storageBackend}），密码以明文保存
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="font-game text-[12px] text-px-text-dim">加载中…</div>
                      )}
                    </div>

                    {/* B. 服务器配置表单 */}
                    <div>
                      <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">
                        服务器地址 (ENDPOINT)
                      </label>
                      <input
                        type="url"
                        value={syncDraft.endpoint}
                        onChange={(e) => setSyncDraft({ ...syncDraft, endpoint: e.target.value })}
                        placeholder="https://dav.jianguoyun.com/dav/"
                        className="pixel-input w-full font-mono text-[13px]"
                      />
                    </div>

                    <div>
                      <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">
                        用户名
                      </label>
                      <input
                        type="text"
                        value={syncDraft.username}
                        onChange={(e) => setSyncDraft({ ...syncDraft, username: e.target.value })}
                        placeholder="坚果云邮箱 / Nextcloud 用户名"
                        className="pixel-input w-full font-mono text-[13px]"
                      />
                    </div>

                    <div>
                      <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">
                        密码 / 应用密码
                      </label>
                      <input
                        type="password"
                        value={syncDraft.password}
                        onChange={(e) => setSyncDraft({ ...syncDraft, password: e.target.value })}
                        placeholder={syncConfig?.hasPassword ? '已保存（留空保持不变）' : '请输入密码'}
                        className="pixel-input w-full font-mono text-[13px]"
                      />
                      <div className="font-game text-[11px] text-px-text-dim mt-1.5">
                        密码将经 OS 密钥环加密（macOS Keychain / Windows DPAPI / Linux libsecret）。
                        Linux 无 keyring 时将以明文存储（不安全），请谨慎使用。
                        坚果云请使用「应用密码」，而非登录密码。
                      </div>
                    </div>

                    <div>
                      <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">
                        远端目录 (BASE_PATH)
                      </label>
                      <input
                        type="text"
                        value={syncDraft.basePath}
                        onChange={(e) => setSyncDraft({ ...syncDraft, basePath: e.target.value })}
                        placeholder="/soul-backup/"
                        className="pixel-input w-full font-mono text-[13px]"
                      />
                      <div className="font-game text-[11px] text-px-text-dim mt-1.5">
                        不存在时将自动创建；建议以 / 结尾。
                      </div>
                    </div>

                    <div>
                      <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">
                        保留份数 (RETENTION，1-30，默认 7)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={syncDraft.retentionCount}
                        onChange={(e) => setSyncDraft({ ...syncDraft, retentionCount: e.target.value })}
                        className="pixel-input w-28 font-mono text-[13px]"
                      />
                      <span className="ml-2 font-game text-[11px] text-px-text-dim">
                        超出后自动清理最旧备份
                      </span>
                    </div>

                    <div>
                      <label className="block font-game text-[12px] text-px-text-sec mb-1.5 tracking-wider">
                        自动间隔 (AUTO_INTERVAL)
                      </label>
                      <select
                        value={syncDraft.autoInterval}
                        onChange={(e) => setSyncDraft({ ...syncDraft, autoInterval: e.target.value as WebDavSyncInterval })}
                        className="pixel-input font-mono text-[13px]"
                      >
                        <option value="off">关闭</option>
                        <option value="hourly">每小时</option>
                        <option value="every-6-hours">每 6 小时</option>
                        <option value="daily">每天 09:00</option>
                      </select>
                    </div>

                    <label className="flex items-center gap-2 font-game text-[12px] text-px-text cursor-pointer">
                      <input
                        type="checkbox"
                        checked={syncDraft.ignoreTlsErrors}
                        onChange={(e) => setSyncDraft({ ...syncDraft, ignoreTlsErrors: e.target.checked })}
                        className="h-4 w-4 accent-px-primary"
                      />
                      忽略 HTTPS 证书校验（仅用于自签证书；坚果云勿勾选）
                    </label>

                    <label className="flex items-center gap-2 font-game text-[12px] text-px-text cursor-pointer">
                      <input
                        type="checkbox"
                        checked={syncDraft.enabled}
                        onChange={(e) => setSyncDraft({ ...syncDraft, enabled: e.target.checked })}
                        className="h-4 w-4 accent-px-primary"
                      />
                      启用自动同步
                    </label>

                    <div className="flex gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={handleSyncTestConnection}
                        disabled={isSyncOperating}
                        className="pixel-btn-ghost text-[12px] px-3 py-1 disabled:opacity-50"
                      >
                        测试连接
                      </button>
                      <button
                        type="button"
                        onClick={handleSyncSaveConfig}
                        disabled={isSyncOperating}
                        className="pixel-btn-primary text-[12px] px-3 py-1 disabled:opacity-50"
                      >
                        保存配置
                      </button>
                      <button
                        type="button"
                        onClick={handleSyncClearCredentials}
                        disabled={isSyncOperating || !syncConfig?.hasPassword}
                        className="pixel-btn-ghost text-[12px] px-3 py-1 text-px-danger disabled:opacity-50"
                      >
                        清除凭据
                      </button>
                    </div>

                    {/* C. 操作面板 */}
                    <div className="border-t border-px-border pt-3 space-y-2">
                      <div className="font-game text-[12px] text-px-text-sec tracking-wider">操作</div>
                      <div className="flex gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={handleSyncBackupNow}
                          disabled={isSyncOperating || !syncConfig?.hasPassword}
                          className="pixel-btn-primary text-[12px] px-3 py-1 disabled:opacity-50"
                        >
                          {syncStatus?.inProgress ? '同步中…' : '立即备份'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const next = !showRestorePanel
                            setShowRestorePanel(next)
                            if (next && remoteBackups.length === 0) {
                              void handleSyncListRemoteBackups()
                            }
                          }}
                          disabled={isSyncOperating}
                          className="pixel-btn-ghost text-[12px] px-3 py-1 disabled:opacity-50"
                        >
                          {showRestorePanel ? '收起恢复' : '从备份恢复'}
                        </button>
                      </div>

                      {showRestorePanel && (
                        <div className="border border-px-border bg-px-surface p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="font-game text-[11px] text-px-text-dim tracking-wider">REMOTE BACKUPS</span>
                            <button
                              type="button"
                              onClick={handleSyncListRemoteBackups}
                              disabled={isSyncOperating}
                              className="pixel-btn-ghost text-[11px] px-2 py-0.5 disabled:opacity-50"
                            >
                              刷新列表
                            </button>
                          </div>
                          {remoteBackups.length === 0 ? (
                            <div className="font-game text-[12px] text-px-text-dim text-center py-3 border border-dashed border-px-border">
                              远端暂无备份，先在另一台设备点「立即备份」
                            </div>
                          ) : (
                            <div className="space-y-1">
                              {remoteBackups.map((b) => (
                                <div
                                  key={b.filename}
                                  className="flex items-center justify-between gap-2 border border-px-border bg-px-bg px-2 py-1.5"
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="font-mono text-[12px] text-px-text truncate">{b.filename}</div>
                                    <div className="font-game text-[10px] text-px-text-dim">
                                      {formatSyncBytes(b.size)} · {b.lastModified}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleSyncRestoreFrom(b.filename)}
                                    disabled={isSyncOperating}
                                    className="pixel-btn-ghost text-[11px] px-2 py-0.5 text-px-danger disabled:opacity-50"
                                  >
                                    恢复
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* D. 同步历史（默认折叠） */}
                    <div className="border-t border-px-border pt-3 space-y-2">
                      <button
                        type="button"
                        onClick={() => {
                          const next = !showHistoryPanel
                          setShowHistoryPanel(next)
                          if (next && syncHistory.length === 0) {
                            void handleSyncLoadHistory()
                          }
                        }}
                        disabled={isSyncOperating}
                        className="font-game text-[12px] text-px-text-sec tracking-wider hover:text-px-text"
                      >
                        {showHistoryPanel ? '▼ 隐藏同步历史' : '▶ 查看同步历史'}
                      </button>
                      {showHistoryPanel && (
                        <div className="border border-px-border bg-px-surface p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="font-game text-[11px] text-px-text-dim tracking-wider">
                              SYNC HISTORY (最近 {syncHistory.length} 条)
                            </span>
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={handleSyncLoadHistory}
                                disabled={isSyncOperating}
                                className="pixel-btn-ghost text-[11px] px-2 py-0.5 disabled:opacity-50"
                              >
                                刷新
                              </button>
                              <button
                                type="button"
                                onClick={handleSyncClearHistory}
                                disabled={isSyncOperating || syncHistory.length === 0}
                                className="pixel-btn-ghost text-[11px] px-2 py-0.5 text-px-danger disabled:opacity-50"
                              >
                                清空
                              </button>
                            </div>
                          </div>
                          {syncHistory.length === 0 ? (
                            <div className="font-game text-[12px] text-px-text-dim text-center py-3 border border-dashed border-px-border">
                              暂无历史记录
                            </div>
                          ) : (
                            <div className="space-y-1 max-h-64 overflow-y-auto">
                              {syncHistory.map((h) => (
                                <div
                                  key={h.id}
                                  className="border border-px-border bg-px-bg px-2 py-1.5 font-game text-[11px]"
                                >
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className={`tracking-wider ${
                                      h.status === 'success' ? 'text-px-success' :
                                      h.status === 'failed' ? 'text-px-danger' :
                                      'text-px-warning'
                                    }`}>
                                      {h.status === 'success' ? '✓' : h.status === 'failed' ? '✗' : '⋯'}
                                      {' '}
                                      {h.direction === 'backup' ? '备份' : '恢复'}
                                    </span>
                                    <span className="text-px-text-sec font-mono">
                                      {formatSyncTs(h.created_at)}
                                    </span>
                                    {h.file_count > 0 && (
                                      <span className="text-px-text-dim">
                                        {h.file_count} 文件 · {formatSyncBytes(h.total_bytes)}
                                      </span>
                                    )}
                                    {h.duration_ms > 0 && (
                                      <span className="text-px-text-dim">
                                        {(h.duration_ms / 1000).toFixed(1)}s
                                      </span>
                                    )}
                                  </div>
                                  {h.error_message && (
                                    <div className="text-px-danger break-all mt-0.5">
                                      {h.error_message}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* E. 帮助文档（静态字串，详见子任务 6 文档） */}
                    <div className="font-game text-[11px] text-px-text-dim">
                      详细文档：desktop-app/docs/webdav-sync.md
                    </div>

                    {/* 状态消息 */}
                    {syncMessage && (
                      <div className={`font-game text-[11px] tracking-wider break-all ${
                        syncMessage.type === 'success' ? 'text-px-success' :
                        syncMessage.type === 'error' ? 'text-px-danger' :
                        'text-px-text-dim'
                      }`}>
                        {syncMessage.text}
                      </div>
                    )}
                    {syncTestResult && !syncMessage && (
                      <div className={`font-game text-[11px] tracking-wider break-all ${
                        syncTestResult.ok ? 'text-px-success' : 'text-px-danger'
                      }`}>
                        {syncTestResult.ok ? '✓ 连接 OK' : `✗ ${syncTestResult.reason || '失败'}`}
                      </div>
                    )}
                  </div>
                  {/* === END 跨设备同步 / WebDAV Sync (#16) === */}

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
