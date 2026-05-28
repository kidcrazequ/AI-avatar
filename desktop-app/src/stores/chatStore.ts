import { create } from 'zustand'
import { LLMService, LLMMessage, LLMTool, ToolCall, ModelConfig, DEFAULT_CHAT_MODEL, detectReasoning, type SystemBlock } from '../services/llm-service'
import {
  MEMORY_CHAR_LIMIT,
  localDateString,
  hashQueryContent,
  PLAN_MODE_BLOCKED_TOOL_NAMES,
  evaluateConversationModeToolPolicy,
} from '@soul/core/browser'
import { regressionTelemetry } from '../services/regression-telemetry'
import { maybeRerankToolsWithIss } from '../services/iss-tool-rerank'
import type { DocumentAttachment, DocumentAttachmentFormat, DocumentAttachmentSource } from '../services/chat-types'
import { formatSseEvent, textDeltaJson } from '../lib/anthropic-proxy-protocol'
import { extractUncertain, extractReconsider } from './deliberation-extractors'

/** GAP2: 从 AI 回复中提取 memory 更新标记的正则 */
const MEMORY_UPDATE_REGEX = /\[MEMORY_UPDATE\]([\s\S]*?)\[\/MEMORY_UPDATE\]/g
// v18 OpenClaw 借鉴：长期工作流约定（"以后所有方案先算 IRR"类）单独走 channel
const STANDING_ORDER_REGEX = /\[STANDING_ORDER\]([\s\S]*?)\[\/STANDING_ORDER\]/g

/** Feature 3: 从 AI 回复中提取用户画像更新标记的正则 */
const USER_UPDATE_REGEX = /\[USER_UPDATE\]([\s\S]*?)\[\/USER_UPDATE\]/g

/** Feature 6: 从 AI 回复中提取技能创建建议的正则 */
const SKILL_CREATE_REGEX = /\[SKILL_CREATE\]([\s\S]*?)\[\/SKILL_CREATE\]/g

// v17 deliberation 抽取器抽到独立文件便于单测，见 ./deliberation-extractors.ts。
// 在 extractMemoryUpdates 调用之后串行使用，从 cleanText 上抽出 chip 展示用的标记。

/** 从回复文本中提取并移除 memory 更新标记 */
function extractMemoryUpdates(text: string): { cleanText: string; updates: string[] } {
  const updates: string[] = []
  const cleanText = text.replace(MEMORY_UPDATE_REGEX, (_, content) => {
    updates.push(content.trim())
    return ''
  }).trim()
  return { cleanText, updates }
}

/** 从回复文本中提取并移除用户画像更新标记 */
function extractUserUpdates(text: string): { cleanText: string; updates: string[] } {
  const updates: string[] = []
  const cleanText = text.replace(USER_UPDATE_REGEX, (_, content) => {
    updates.push(content.trim())
    return ''
  }).trim()
  return { cleanText, updates }
}

/** v18 OpenClaw 借鉴：从回复中提取并移除 [STANDING_ORDER] 标签 */
function extractStandingOrders(text: string): { cleanText: string; orders: string[] } {
  const orders: string[] = []
  const cleanText = text.replace(STANDING_ORDER_REGEX, (_, content) => {
    orders.push(content.trim())
    return ''
  }).trim()
  return { cleanText, orders }
}

/** 从回复文本中提取并移除技能创建建议，保留原文不删除（用于展示确认卡片） */
function extractSkillCreate(text: string): { cleanText: string; proposals: string[] } {
  const proposals: string[] = []
  const cleanText = text.replace(SKILL_CREATE_REGEX, (_, content) => {
    proposals.push(content.trim())
    return ''
  }).trim()
  return { cleanText, proposals }
}

/**
 * 启发式判断回答是否值得自动沉淀到 wiki/qa/。
 * 条件：长度 > 300、含来源引用、非错误消息。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
function shouldSediment(answer: string): boolean {
  if (answer.length < 300) return false
  if (answer.startsWith('抱歉，发生了错误')) return false
  const hasSource = /来源[：:]/.test(answer) || /\[来源/.test(answer) || /【参考/.test(answer)
  return hasSource
}

/** 使用时间戳+随机数生成唯一消息 ID，避免页面刷新后 ID 冲突 */
export function nextMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 消息携带的附件引用（对话框附件扩展，2026-05-01）。
 *
 * 完整附件元信息以 attachments 表持久化；ChatMessage 内只保留渲染必需的
 * 子集（id / 名称 / mime / 大小 / 摘要 / 大纲），避免长 summary 被反复 stringify。
 *
 * @author zhi.qu
 * @date 2026-05-01
 */
/**
 * P0+ Proxy API（方案 A）可选参数：将助手回复通过 IPC 回写主进程 HTTP。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */
export interface SendMessageProxyOptions {
  proxyJobId?: string
  proxyStream?: boolean
  proxyAnthropicMessageId?: string
  proxyModelLabel?: string
  onProxyComplete?: (
    r: { ok: true; assistantText: string } | { ok: false; error: string },
  ) => void | Promise<void>
}

export interface AttachmentRef {
  id: string
  name: string
  mime: string
  size: number
  /** 用于 chip 上显示「48 页 / 2 sheet」等小标，可空 */
  summary?: string | null
  outline?: string | null
}

export interface ChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
  /** reasoning 模型输出的思考过程，UI 以折叠块展示 */
  reasoning?: string
  /** 用户消息附带的图片 dataURL（视觉模型可见，重开会话时也用于恢复缩略图） */
  imageUrls?: string[]
  /** 用户消息附带的文档/文本附件元信息（仅 user 消息会有） */
  attachments?: AttachmentRef[]
  /**
   * assistant 消息附带的工具落盘文件（generate_document / export_excel）。
   *
   * 决策 B3：identical UX 体验——对话气泡内嵌文件卡片。
   * chatStore 在工具循环里识别工具结果中的 `success && file_path 含 exports/`
   * 时，统一构造 DocumentAttachment 推到当前 assistant 消息的此字段。
   *
   * @author zhi.qu
   * @date 2026-05-08
   */
  documentAttachments?: DocumentAttachment[]
  /**
   * v17 deliberation 表达（Phase 1 of human-cognition extension）：
   *   - uncertainMarkers: 分身用 [UNCERTAIN]...[/UNCERTAIN] 标注的认知不确定点
   *   - reconsiderMarkers: 分身用 [RECONSIDER]...[/RECONSIDER] 标注的立场更新
   *
   * 仅 assistant 消息会有；UI 渲染为消息泡下方的 chip。
   * 缺省 undefined 即可（与空数组等价；不要存空数组浪费持久化字节）。
   */
  uncertainMarkers?: string[]
  reconsiderMarkers?: string[]
  /**
   * v19 (2026-05-21)：本条 assistant 消息关联的工具调用时间线。
   *
   * 流式期间由 chatStore 在 tool loop 内追加；落盘时序列化为 JSON 写入 messages.tool_call_timeline_json；
   * 加载会话时由 ChatWindow 反序列化回填。把时间线挂到具体消息上而不是全局 store，
   * 让用户切对话 / 重启 app 后仍能看到每条 assistant 当时调了哪些工具。
   *
   * 仅 assistant 消息会有；缺省 undefined 与空数组等价。
   */
  toolCallTimeline?: ToolCallTimelineEntry[]
}

/**
 * Agent 任务列表项（todo_write 工具产出，UI 渲染为 checklist）
 *
 * 参考 Cursor / Claude Code 的 TodoWrite 设计：
 *   - 会话级别，不持久化（重启清空）
 *   - 模型每次调用 todo_write 时整体覆盖（merge=false）或按 id 增量合并（merge=true）
 *   - status 状态机：pending → in_progress → completed / cancelled
 *
 * @author zhi.qu
 * @date 2026-04-29
 */
/**
 * 任务关联的工具调用（Stage 三 P2 #14）。
 *
 * 由 chatStore 在工具循环中自动追加：每完成一次 tool 执行，
 * 把 (id/name/durationMs/ok) 挂到当前唯一 in_progress 的任务上。
 *
 * 字段含义：
 *   - id          tool_call_id（来自 LLM function-calling 的稳定 ID）
 *   - name        工具名（如 query_excel / search_knowledge）
 *   - durationMs  本次执行耗时
 *   - ok          true=成功；false=失败（含被守卫拦截）
 */
export interface AgentTaskToolCall {
  id: string
  name: string
  durationMs: number
  ok: boolean
}

/**
 * 工具调用时间线条目（ChatWindow 顶部滚动展示用）。
 *
 * 与 AgentTaskToolCall 的区别：
 *   - AgentTaskToolCall 挂到 todo_write 任务上，给 TaskListPanel 展示「任务→工具」链路
 *   - ToolCallTimelineEntry 不依赖 todo_write，**每次**工具调用（含 todo_write 自身）都记录一条，
 *     给 ChatWindow 顶部"工具调用时间线"完整呈现一轮对话的全部工具执行过程
 *
 * 字段含义：
 *   - id            条目唯一 ID（tool 用 tool_call_id；rag/skill 用 `${kind}-${startedAt}`）
 *   - name          工具名 / RAG 阶段名 / Skill 名（英文原名，等宽字体小号显示）
 *   - argsPreview   tool: tc.function.arguments 截前 80 字符（不解析直接截原文）；
 *                   rag/skill: 中文友好文本（detail），渲染时作为主标签优先于 name
 *   - resultPreview 工具结果文本截前 200 字符（rag/skill 通常为空）
 *   - durationMs    本次执行耗时
 *   - ok            true=成功；false=失败（**真错误**，不含守卫拦截）
 *   - startedAt     开始时间戳（Date.now()），用于按时序排序/展示
 *   - kind          条目种类（默认 'tool'，向后兼容）：
 *                     tool  - LLM function-calling 工具调用（前缀 ▷）
 *                     rag   - 主进程 RAG 检索阶段事件（前缀 ⌕）
 *                     skill - Skill 路由命中事件（前缀 ★）
 *   - skipped       v19 (2026-05-21)：本次调用被**守卫主动拦截**（如 load_skill 同 skill 重复加载）。
 *                   与 ok=false 区分：跳过不是错误而是预期行为；UI 用 ⊘ 中性色显示，
 *                   "N 失败" 汇总不计入。旧持久化条目无此字段 → 视为 undefined → 老 ok=false 行为不变。
 */
export interface ToolCallTimelineEntry {
  id: string
  name: string
  argsPreview: string
  resultPreview: string
  durationMs: number
  ok: boolean
  startedAt: number
  kind?: 'tool' | 'rag' | 'skill'
  skipped?: boolean
}

export interface AgentTask {
  /** 唯一 ID，由模型生成（建议短字符串如 "t1"/"t2"） */
  id: string
  /** 任务描述（简短一句话，UI 直接展示） */
  content: string
  /** 状态：待执行 / 进行中 / 已完成 / 已取消 */
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  /**
   * 关联的工具调用列表（可选，向后兼容）。
   * 旧任务无此字段也能正常渲染；UI 在该字段存在时展示工具列表。
   */
  toolCalls?: AgentTaskToolCall[]
}

/**
 * 九层重构 #17 switch_mode：分身工作模式。
 *   - agent：默认全权代理，所有工具可用
 *   - plan：只输出方案，禁止 write/exec/delete 类写工具
 *   - ask：纯问答，禁止任何工具
 *
 * 模式由前端维护（重启默认 agent）；发起 LLM 请求时按 mode 过滤工具列表，
 * 同时经 `syncConversationToolMode` 同步到主进程，供 execute-tool-call 统一门禁（#7）。
 */
export type ConversationMode = 'agent' | 'plan' | 'ask'

/**
 * #7：主进程 execute-tool-call 需与会话 mode 对齐；会话切换 / UI / switch_mode 时推送。
 */
function pushConversationToolModeToMain(conversationId: string, mode: ConversationMode): void {
  void window.electronAPI.syncConversationToolMode(conversationId, mode).catch((e) => {
    window.electronAPI.logEvent(
      'warn',
      'sync-conversation-tool-mode',
      e instanceof Error ? e.message : String(e),
    )
  })
}

interface ChatStore {
  messages: ChatMessage[]
  isLoading: boolean
  systemPrompt: string
  chatModel: ModelConfig
  /**
   * 端侧（本地）模型配置（2026-05-22 Marvis 借鉴；端云/端侧切换闭环）。
   *
   * 与 chatModel 并列的第二个 master slot——用户在设置里配置一份指向本机的
   * Ollama / lm-studio / vllm 等本地推理服务（baseUrl 通常是 localhost:11434/v1）。
   * 发送链路按 chatModelMode 决定走 chatModel 还是 localChatModel。
   *
   * 默认指向 Ollama 默认端口 + qwen2.5:7b（最常见本地中文 7B 选择）；
   * 用户未装 Ollama 时切换到 'local' 后发送会失败，UI 会引导去设置配置。
   */
  localChatModel: ModelConfig
  /**
   * 当前 active 的模型 slot（App 全局态）。
   *
   * 'cloud' = 用 chatModel（默认）；'local' = 用 localChatModel。
   * ChatWindow 顶栏 pill 是这个 state 的反映与切换入口；App 启动时从 settings.chat_model_mode 加载。
   */
  chatModelMode: 'cloud' | 'local'
  /** GAP8: 当前正在执行的工具名称，用于 UI 可视化 */
  toolCallStatus: string
  /** 九层重构 #17：当前会话模式（agent / plan / ask） */
  mode: ConversationMode
  /** 切换工作模式（外部 UI 按钮 + switch_mode 工具均通过此 action） */
  setMode: (mode: ConversationMode) => void
  /** Feature 6: 待确认的技能创建建议 */
  skillProposals: string[]
  /**
   * 已折叠的助手消息 id 集合。
   * 放在 store 中是因为 react-virtuoso 会把滚出视窗的 MessageBubble 卸载，
   * 组件级 useState 会丢失；store 的状态跨组件卸载/HMR 持久。
   */
  collapsedMessageIds: Set<string>
  /**
   * Agent 任务列表（来自 todo_write 工具）。
   *
   * Stage 三 P2 范围外 1 之后：
   *   - 跟随 currentConversationId 持久化到主进程 DB（agent_tasks 表）
   *   - 切换会话时通过 bindConversation(id) 异步从 DB 恢复
   *   - resetTransientState / clearMessages 仅清空内存态，不删除 DB
   */
  tasks: AgentTask[]
  /**
   * 当前绑定的 conversationId（用于任务持久化）。
   *
   * 由 ChatWindow 在 conversationId 变化时调 bindConversation 设置，
   * 为 null 表示尚未进入任何会话（持久化操作会被静默跳过）。
   */
  currentConversationId: string | null

  setSystemPrompt: (prompt: string) => void
  setChatModel: (config: ModelConfig) => void
  /** 设置端侧（本地）模型配置（2026-05-22 Marvis 借鉴）。 */
  setLocalChatModel: (config: ModelConfig) => void
  /** 切换 active master slot（端云 / 端侧）。落 sqlite 由调用方负责。 */
  setChatModelMode: (mode: 'cloud' | 'local') => void
  /**
   * 会话级模型覆盖：null/缺失 = 使用分身 defaultModel 或 chatModel slot。
   * 子任务 7 UI 切换器写入；sendMessage 读取后注入 LLMService。
   */
  conversationModelOverrides: Record<string, string | null>
  /** 设置当前会话的模型覆盖；传 null 清除覆盖回到默认 */
  setConversationModel: (conversationId: string, model: string | null) => void
  setMessages: (messages: ChatMessage[]) => void
  /**
   * 切走→切回会话时，把闭包里 in-flight streaming 的 assistantText/reasoningText/toolCallTimeline
   * 从 module-level snapshot 回灌到 messages 列表（拼到末尾），同时恢复 isLoading=true。
   *
   * 返回值：snapshot 命中时返回 { startedAt }，让 ChatWindow 校准"思考中... · Xs"计时器
   * （否则计时器从 0 重新算，给用户"流刚开始"的错觉）。无 in-flight 或会话不匹配时返回 null。
   *
   * 由 ChatWindow.loadMessages 在 setMessages 之后调用。
   */
  restoreInflightStreamingMessage: (conversationId: string) => { startedAt: number } | null
  sendMessage: (
    content: string,
    conversationId: string,
    avatarId: string,
    images?: string[],
    visionModel?: ModelConfig,
    attachments?: AttachmentRef[],
    inlineFiles?: Array<{ name: string; ext: string; mime: string; text: string }>,
    proxyOpts?: SendMessageProxyOptions,
    options?: {
      skipCache?: boolean
      skipInfographicRevalidate?: boolean
      /**
       * 隐藏修复轮（2026-05-24）。LLM 调用照常，但所有面向用户的副作用全部禁掉：
       *   - 不插入 user / assistant 消息到 messages
       *   - 不入 DB（saveMessage user / assistant 都跳过）
       *   - 不触发首条消息自动改名
       *   - 不写答案缓存
       *   - 不创建 streamingSnapshot（避免切回会话被 hidden 内容回灌覆盖）
       *   - 不触发 conversation episode 抽取
       *   - phase05 埋点标 hiddenRepair=1 便于过滤
       *
       * 当前用途：infographic validator 触发的格式修正轮。原实现走普通
       * sendMessage 链路会把修正 prompt 当真实用户消息入库、入历史、计费，
       * 严重污染对话；本 flag 把修正轮做成真正隐藏。
       */
      hiddenRepair?: boolean
    },
  ) => Promise<{ displayText: string; assistantMsgId: string } | undefined>
  /**
   * 重新生成指定 assistant 消息（v14）。
   *
   * 流程：
   *   1. 找到 messageId 对应的 assistant 消息
   *   2. 找到它前面的 user 消息（同一对话相邻）
   *   3. 从 messages 中删除该 assistant 消息（含 DB）
   *   4. 用 user 消息 content 调 sendMessage(..., { skipCache: true })
   *      → 跳过缓存读 + 不写新缓存（保留原稳定答案）
   *
   * 失败兜底：找不到匹配的 user 消息时返回 false，UI 应禁用按钮。
   */
  regenerateAssistantMessage: (
    messageId: string,
    conversationId: string,
    avatarId: string,
  ) => Promise<boolean>
  clearMessages: () => void
  resetTransientState: () => void
  /** Feature 6: 清除技能创建建议 */
  clearSkillProposals: () => void
  /** 切换某条消息的折叠状态 */
  toggleMessageCollapsed: (id: string) => void
  /** 整体覆盖任务列表（todo_write merge=false） */
  setTasks: (tasks: AgentTask[]) => void
  /** 按 id 增量合并任务列表（todo_write merge=true）；未匹配的视为新增 */
  mergeTasks: (patch: AgentTask[]) => void
  /** 清空任务列表（新会话开启时调用） */
  clearTasks: () => void
  /**
   * 切入会话时调用：绑定当前 conversationId，并从主进程 DB 恢复任务列表。
   *
   * 调用时机：ChatWindow useEffect([conversationId]) 内（与 loadMessages 并行/串行均可）。
   * 失败兜底：DB 不可读时清空内存任务，避免显示上一个会话的残留。
   */
  bindConversation: (conversationId: string) => Promise<void>
  /**
   * 把一次工具调用记录挂到当前唯一 in_progress 的任务上（Stage 三 P2 #14）。
   *
   * 自动定位规则：
   *   - 若当前恰有 1 个 in_progress 任务 → 挂到它身上（最常见场景）
   *   - 若有多个或没有 in_progress → 挂到最后一个非 cancelled/completed 的任务（兜底）
   *   - 若整个任务列表为空 → 静默忽略（无任务时不应记录工具关联）
   *
   * 同一 toolCallId 重复挂载会被去重，避免误调用导致 UI 列表膨胀。
   */
  attachToolCallToTask: (toolCall: AgentTaskToolCall) => void
  /**
   * 工具调用时间线（本轮 sendMessage 内累积，新提问时会被清空）。
   *
   * 与 tasks/attachToolCallToTask 并行：
   *   - tasks 由模型 todo_write 主动维护，attachToolCallToTask 只挂"非 todo_write"工具
   *   - timeline 包含**所有**工具调用（含 todo_write），按 startedAt 时序追加，专供 ChatWindow 顶部滚动条展示
   *
   * 不持久化：仅活在内存中，刷新/切会话后消失（与本轮对话生命周期一致）。
   */
  toolCallTimeline: ToolCallTimelineEntry[]
  /** 追加一条工具调用时间线（每次工具循环执行完毕后调用，失败应静默） */
  /**
   * 追加一条工具调用时间线条目。
   *
   * target 强烈建议传：用 conversationId + assistantMsgId 精确定位，避免：
   *   ① 跨会话污染——A 会话在跑工具，用户切到 B，旧实现按"最后一条 assistant"
   *      启发式更新会把 A 的工具行挂到 B 最后一条 assistant
   *   ② saveMessage 落库时找不到 timeline（A 不在视图，messages 里没有 A 的 assistant）
   *
   * 不传 target 时仍走旧的"最后一条 assistant"路径（向后兼容）。
   */
  appendToolCallTimeline: (
    entry: ToolCallTimelineEntry,
    target?: { conversationId: string; assistantMsgId: string },
  ) => void
  /** 清空工具调用时间线（新提问 / 重置 / 清屏时调用） */
  clearToolCallTimeline: () => void
}

/**
 * GAP4: 工具定义（JSON Schema），传给 LLM 供 function calling 使用。
 * 每个工具对应 tool-router.ts 中的一个实现。
 *
 * 九层重构清理（2026-04-30）：
 *   - 移除：read_file / write_file / str_replace_edit / delete_file / copy_files / grep / list_files / delegate_task
 *   - 替代：read_lines（精确行）/ exec_shell（cat/sed/grep/cp/mv/rm）/ exec_code（批量改写）
 *           multi_edit（替代 str_replace_edit）/ glob（替代 list_files）/ task（替代 delegate_task）
 *   - tool-router.ts 中的 case 实现保留，作为已硬编码引用旧工具名的 skill / CLAUDE.md 的兼容路径。
 */
const AVATAR_TOOLS: LLMTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_lines',
      description: '按 1-based 行号区间读取工作区文件，[start_line, end_line] 闭区间；省 token 场景首选（硬上限 4000 行）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区相对路径' },
          start_line: { type: 'number', description: '起始行号（1-based，默认 1）' },
          end_line: { type: 'number', description: '结束行号（1-based，包含；默认 start_line + 199）' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_tool_result',
      description: '读取上一次工具返回值被 spool 落盘的完整内容（当工具结果 > 12000 字符时，ToolResultSpool 会把完整内容写入 ~/Library/Application Support/soul-desktop/tool-results/<convId>/<toolName>-<ts>.txt，并在工具消息里告知绝对路径）。仅接受 tool-results 目录下的绝对路径，read_lines 对此类路径会失败。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'spool 文件的完整绝对路径（必须以 .../soul-desktop/tool-results/ 开头）' },
          start_line: { type: 'number', description: '起始行号（1-based，默认 1）' },
          end_line: { type: 'number', description: '结束行号（1-based，包含；默认 start_line + 199）' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Glob 模式匹配工作区文件（升级版 list_files）。\n\n用法：\n- "**/*.ts" 递归找所有 .ts 文件\n- "src/**/*.tsx" 找 src 目录下所有 .tsx\n- "*.md" 找当前目录的 .md\n- "?.txt" 单字符匹配\n\n何时用：明确知道要找的文件类型/路径模式时（最常见场景）。\n何时不用：要按文件内容检索 → 用 exec_shell + grep / rg；要枚举一个目录所有文件 → 用 list_files。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式（必填），如 "**/*.ts"' },
          path: { type: 'string', description: '搜索根目录（相对工作区根，默认 "."）' },
          offset: { type: 'number', description: '翻页起点（默认 0）' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'multi_edit',
      description: '在单个文件内顺序应用多条编辑，原子写入；任一条 old_string 未命中则全部回滚。每条可声明 replace_all。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区相对路径' },
          edits: {
            type: 'array',
            description: '编辑列表（≥1）',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean', description: '默认 false 仅替换首次匹配；true 全部替换' },
              },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: '在工作区目录执行 git status --short，返回紧凑的改动列表。让你看清自己刚刚改了哪些文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的子目录（默认 "."）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: '在工作区目录执行 git diff（默认 worktree 与 index 的差异），用于自检改动正确性。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '限定 diff 的文件/目录（默认全仓库）' },
          staged: { type: 'boolean', description: 'true → git diff --cached（已 staged 改动）' },
          context_lines: { type: 'number', description: 'diff 上下文行数（默认 3）' },
          max_chars: { type: 'number', description: '输出字符上限（默认 32768，硬上限相同）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notebook_edit',
      description: '编辑 Jupyter notebook (.ipynb) 单个 cell。is_new_cell=true 在 cell_idx 处插入新 cell；false 修改既有 cell（old_string 为空则整段覆盖）。',
      parameters: {
        type: 'object',
        properties: {
          target_notebook: { type: 'string', description: '.ipynb 文件相对路径' },
          cell_idx: { type: 'number', description: '0-based cell 索引' },
          is_new_cell: { type: 'boolean', description: 'true=插入新 cell；false=修改' },
          cell_language: {
            type: 'string',
            description: 'python / markdown / javascript / typescript / r / sql / shell / raw / other',
          },
          old_string: { type: 'string', description: '编辑模式下要被替换的子串；空串=覆盖整段' },
          new_string: { type: 'string', description: '替换后的内容（is_new_cell 时为新 cell 内容）' },
        },
        required: ['target_notebook', 'cell_idx', 'is_new_cell', 'cell_language', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'register_assets',
      description: '注册资产到工作区资产清单。',
      parameters: {
        type: 'object',
        properties: {
          items: { type: 'array' },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unregister_assets',
      description: '从工作区资产清单移除条目。',
      parameters: {
        type: 'object',
        properties: {
          items: { type: 'array' },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_to_user',
      description: '在用户预览窗口打开工作区 HTML 文件。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_html',
      description: '在隐藏预览窗口打开工作区 HTML 文件。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'eval_js',
      description: '在隐藏预览窗口执行 JS 并返回结果。',
      parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'eval_js_user_view',
      description: '在用户预览窗口执行 JS 并返回结果。',
      parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_webview_logs',
      description: '读取预览窗口控制台日志。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_screenshot',
      description: '保存预览截图到工作区文件。',
      parameters: {
        type: 'object',
        properties: {
          save_path: { type: 'string' },
          steps: { type: 'array' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'multi_screenshot',
      description: '执行多步骤截图。',
      parameters: { type: 'object', properties: { steps: { type: 'array' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot_user_view',
      description: '对用户预览窗口截图。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: '交付 HTML 文件并返回日志。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fork_verifier_agent',
      description: '触发后台校验子任务。',
      parameters: { type: 'object', properties: { task: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'questions_v2',
      description: '发起结构化问题表单。',
      parameters: { type: 'object', properties: { title: { type: 'string' }, questions: { type: 'array' } }, required: ['title', 'questions'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copy_starter_component',
      description: '复制 starter 组件到工作区。',
      parameters: { type: 'object', properties: { kind: { type: 'string' }, directory: { type: 'string' } }, required: ['kind'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_as_html',
      description: '导出为独立 HTML。',
      parameters: { type: 'object', properties: { html: { type: 'string' }, output_path: { type: 'string' }, input_path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_as_pdf',
      description: '导出为 PDF。',
      parameters: { type: 'object', properties: { source_path: { type: 'string' }, output_path: { type: 'string' } }, required: ['source_path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_pptx',
      description: '导出为 PPTX。',
      parameters: { type: 'object', properties: { save_to_project_path: { type: 'string' }, mode: { type: 'string' }, slides: { type: 'array' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gen_pptx',
      description: '生成 PPTX（兼容工具名）。',
      parameters: { type: 'object', properties: { save_to_project_path: { type: 'string' }, slides: { type: 'array' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'super_inline_html',
      description: '将 HTML 打包为单文件。',
      parameters: { type: 'object', properties: { input_path: { type: 'string' }, output_path: { type: 'string' } }, required: ['input_path', 'output_path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_for_print',
      description: '打开文件用于打印。',
      parameters: { type: 'object', properties: { project_relative_file_path: { type: 'string' } }, required: ['project_relative_file_path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'present_fs_item_for_download',
      description: '展示文件供下载。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, label: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_public_file_url',
      description: '获取文件公共访问 URL（当前返回 file://）。',
      parameters: { type: 'object', properties: { project_relative_file_path: { type: 'string' } }, required: ['project_relative_file_path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'connect_github',
      description: '请求用户授权 GitHub。如果未提供 pat 参数，会在聊天侧弹出输入框让用户粘贴 PAT；提供 pat 时直接使用。需要 repo 范围。',
      parameters: {
        type: 'object',
        properties: {
          pat: { type: 'string', description: '可选：GitHub Personal Access Token。留空则弹窗收集。' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_repos',
      description: '列出当前用户可访问的 GitHub 仓库（按更新时间倒序）。',
      parameters: {
        type: 'object',
        properties: { per_page: { type: 'number', description: '每页数量，1-100，默认 30' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_get_tree',
      description: '获取指定仓库默认分支或指定 ref 的完整文件树（递归）。',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          ref: { type: 'string', description: '可选：分支或 commit SHA' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_read_file',
      description: '读取仓库内单个文本文件（utf-8，>1MB 报错）。',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          path: { type: 'string', description: '仓库内文件路径，如 src/Button.tsx' },
          ref: { type: 'string', description: '可选 ref' },
        },
        required: ['owner', 'repo', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_import_files',
      description: '把指定仓库内多个文件下载到当前会话 workspace。',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          ref: { type: 'string' },
          files: {
            type: 'array',
            description: '要导入的文件列表',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: '仓库内路径' },
                saveAs: { type: 'string', description: '可选：workspace 内目标路径' },
              },
              required: ['path'],
            },
          },
        },
        required: ['owner', 'repo', 'files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_to_canva',
      description: '把已导出的本地文件（PPTX/PDF/HTML）引导用户上传到 Canva：自动在系统资源管理器定位文件、用默认浏览器打开 canva.com/upload。',
      parameters: {
        type: 'object',
        properties: { export_path: { type: 'string', description: '可选：workspace 中已导出的文件相对路径，会高亮定位' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_pdf',
      description: '解析 workspace 中的 PDF 文件，返回正文文本与基本元数据。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对路径或 /projects/<convId>/<path>' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_docx',
      description: '解析 workspace 中的 Word 文件（.docx），返回正文文本。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_pptx',
      description: '解析 workspace 中的 PPTX 文件，返回每张幻灯片的文本。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_attachment',
      description: '读取用户当前对话上传的附件正文（PDF/Word/PPTX/Excel/TXT/MD/代码）。优先于 read_pdf/read_docx/read_pptx 使用 —— 当用户消息含 <attachment id="att_xxx" .../> 标签时，必须用本工具按 id 读取，而不是猜路径。支持分段读：默认返回前 16000 字；可用 char_range 切片避免一次性塞满上下文。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '附件 id（形如 att_xxx，从 <attachment id="..." /> 标签里取）' },
          char_range: {
            type: 'array',
            description: '可选：[start, end] 字符区间（0-based，end 独占）。例如 [0, 4000] 读前 4000 字。',
            items: { type: 'integer' },
            minItems: 2,
            maxItems: 2,
          },
          page_range: {
            type: 'array',
            description: '可选：[from, to] 页码区间（仅 PDF 有效，1-based 闭区间）。例如 [1, 3] 读 1-3 页。',
            items: { type: 'integer' },
            minItems: 2,
            maxItems: 2,
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_attachment',
      description: '在用户当前对话上传的附件中按关键词全文检索，返回命中的行号 + 上下文片段。适合：用户问“附件里提到 xxx 没有”这类需要快速定位的问题。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '附件 id（att_xxx）' },
          keyword: { type: 'string', description: '检索关键词（区分大小写；多关键词请分多次调用）' },
          max_hits: { type: 'integer', description: '可选：最多返回的命中数，默认 20，硬上限 100' },
        },
        required: ['id', 'keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_tweaks',
      description: '把 Tweaks UI 收集到的新值原子写回 HTML 文件中的 EDITMODE-BEGIN/END JSON 块。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'workspace 中 HTML 文件相对路径' },
          block_id: { type: 'string', description: 'EDITMODE-BEGIN id 属性值' },
          values: { type: 'object', description: '完整新值对象，会原样替换块内 JSON' },
        },
        required: ['path', 'block_id', 'values'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snip',
      description: '登记上下文裁剪范围（[id:mNNNN] 锚点）。下一次对话发送时会以系统指令方式提醒模型忽略该范围内容。',
      parameters: {
        type: 'object',
        properties: {
          from_id: { type: 'string', description: '起始 mNNNN（如 m0003）' },
          to_id: { type: 'string', description: '结束 mNNNN' },
          reason: { type: 'string', description: '可选裁剪理由' },
        },
        required: ['from_id', 'to_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: [
        '在分身知识库中检索相关内容片段，或列出所有知识文件。',
        '',
        '【必须调用 — 红线，禁止凭记忆作答】',
        '- 涉及具体参数 / 数据 / 数值（电压、容量、价格、报价、KPI）',
        '- 涉及政策 / 标准 / 规范 / 国标 / IEC / 电气规范 / 准则',
        '- 涉及具体项目 / 案例 / 产品型号 / 报告',
        '- 用户问"我们的 X 是什么 / 多少 / 怎么做"——必检索分身自有知识，不要泛泛回答',
        '',
        '【禁止调用 — 不浪费 token】',
        '- 寒暄 / 确认 / 致谢（"好的"/"谢谢"/"收到"）',
        '- 格式偏好 / 语气调整请求（"用表格"/"再短一点"）',
        '- 上一轮回答的承接 / 改写（用户在重述或要总结）',
        '- 纯逻辑 / 通用知识题（不需要分身私有资料）',
        '',
        '【工具决策树 — 在知识层 4 个工具间选对一个】',
        '1) 模糊语义召回（"上海最近的电价政策"/"262 户外柜电池容量"）→ search_knowledge mode="search"（本工具）',
        '2) 不知道知识库有什么文件，想先看地图 → search_knowledge mode="list"',
        '3) 已知精确关键词/型号/条款号（"ENS-L262"/"第 8.3 条"），或 search 召回不全要兜底 → knowledge_grep',
        '4) 已经知道目标文件路径，要读完整章节/段落 → read_knowledge_file',
        '5) Excel / CSV 行级数值 → query_excel（**禁止用本工具代替**，参见相关红线）',
        '',
        '【召回完整度信号 — 必须解读，强制执行】',
        '工具返回 content 第一行是 `[召回完整度: <empty|low|partial|high> | 命中 N / 候选 M | 最高分 X.XX (bm25|rrf)] ...`，',
        '它是判断"本次召回值不值得作答"的硬信号——必须按下面规则执行，不得忽略：',
        '- empty：知识库没收录，回答"知识库未收录"并明确告知用户，**不要**凭记忆/常识强答；',
        '  如果你认为问题应该有答案，建议先 mode="list" 看是否文件名暗示，再考虑 knowledge_grep 兜底。',
        '- low：证据稀薄，**回答必须以"召回不全，仅基于以下片段..."开头**，并主动建议用户用更具体的关键词重问；',
        '  常见原因：query 太泛 / 同义词没覆盖 / 知识库真没存。可换 query 再试一次或改用 knowledge_grep。',
        '- partial：可作答但需在结论旁标注"基于本次检索片段"，并建议用户补充关键词以提升完整度。',
        '- high：召回充分，正常作答；仍需逐条标注来源锚点（[来源: knowledge/xxx.md]）。',
        '',
        '⚠️ 看到 empty/low 时**绝对不能**装作权威——这是 Soul 分身的硬性人格红线（参见拒答优先于占位原则）。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['search', 'list'],
            description: 'search=检索知识片段（默认）；list=列出知识文件',
            default: 'search',
          },
          query: { type: 'string', description: '检索关键词或问题描述' },
          top_n: { type: 'number', description: '返回结果数量，默认 5，硬上限 12', default: 5 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_knowledge_file',
      description: '读取知识库中特定文件的完整内容。需要先通过 search_knowledge(mode="list") 或 search_knowledge 检索结果获取文件路径。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件相对路径，如 products/battery-500kwh.md' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    /**
     * knowledge_grep: 在知识库 .md / .txt 等文本文件里按正则精确搜索。
     * 与 search_knowledge（BM25 + vector）互补：grep 适合精确关键词 / 编号 / 政策条款号。
     */
    type: 'function',
    function: {
      name: 'knowledge_grep',
      description: [
        '在分身知识库文件里按正则精确搜索，返回命中的文件路径 + 行号 + 行文本。',
        '',
        '何时使用（与 search_knowledge 互补）：',
        '- 你知道精确关键词 / 型号编号 / 政策条款号（如 "ENS-L262" / "262KWh" / "第 8.3 条"）',
        '- search_knowledge 召回不全或证据弱，需要兜底确认某关键词在哪些文件出现',
        '- 想列出某术语在知识库的所有出现位置（如统计"峰谷"被提及的所有章节）',
        '',
        '何时不用：',
        '- 模糊语义查询（"上海最近的电价政策" → 用 search_knowledge）',
        '- 表格数值（→ query_excel）',
        '- 需要看完整章节上下文（grep 仅返回单行，要看上下文用 read_knowledge_file）',
        '',
        '搜索范围：分身自己的 knowledge/ + 当前 project 的 projects/<pid>/knowledge/（共享 shared/knowledge/ 不在内）。',
        '只扫文本文件：.md / .markdown / .txt / .json / .yaml / .yml。',
        '',
        '硬上限：单文件 50 条，总计 200 条（可调，最大 500）。超限时 truncated=true，请缩窄 pattern 或加 scope。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式（JavaScript 语法，大小写不敏感）。如 "262KWh" / "峰谷.{0,5}差" / "^##\\s+电价"' },
          scope: { type: 'string', description: '可选：相对 knowledge/ 的子目录限定搜索范围，如 "imports/2025"' },
          max_per_file: { type: 'number', description: '单文件命中上限，默认 50，硬上限 200' },
          max_total: { type: 'number', description: '总命中上限，默认 200，硬上限 500' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    /**
     * list_wiki_concepts: 列出 LLM 自动编译的实体概念页（wiki/concepts/*.md）。
     * 适合"X 是什么 / 有哪些参数 / 出现在哪些文件"类实体查询的快速入口。
     */
    type: 'function',
    function: {
      name: 'list_wiki_concepts',
      description: [
        '列出当前分身已编译的实体概念页（wiki/concepts/），支持按 query 做关键词匹配。',
        '',
        '概念页是 WikiCompiler 调 LLM 把同一实体（如 "ENS-L262" / "BMS" / "PCS"）在多个知识文件的出现聚合成的独立 .md，含 LLM 摘要 + 属性表 + 来源依据 + 相关实体。',
        '',
        '【强烈建议传 query】：某些分身 WikiCompiler 把"明确"/"数值"/"图片"等高频词识别成实体，name 字段无意义。传 query 会扫**正文**做关键词匹配，绕开 name 命名问题；不传 query 仅适合探索浏览。',
        '',
        '何时使用：',
        '- 用户问"X 是什么 / X 有哪些参数 / X 跟 Y 什么关系" → 用 query=X 调本工具',
        '- 想看某实体跨多个文件的聚合视图（比 search_knowledge 拼 chunk 更省 token + 更准）',
        '',
        '何时不用：',
        '- 时效性问题（→ web_search）',
        '- 要看具体某文件某行（→ read_knowledge_file / knowledge_grep）',
        '',
        '返回 JSON：',
        '- 有 query：matches[]（每条 name/entity/score/preview），拿 name 调 read_wiki_concept 读全文',
        '- 无 query：pages[]（仅元数据，name 可能无意义）',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词（如 "ENS-L262" / "262KWh" / "BMS"），按正文模糊匹配。**推荐传**。' },
          top_n: { type: 'number', description: '返回 top N 匹配项，默认 10，上限 20', default: 10 },
        },
      },
    },
  },
  {
    /**
     * read_wiki_concept: 读取指定实体概念页全文。
     */
    type: 'function',
    function: {
      name: 'read_wiki_concept',
      description: [
        '读取指定实体概念页的 markdown 全文（含 LLM 摘要 + 属性表 + 来源依据 + 相关实体链）。',
        '',
        '何时使用：',
        '- list_wiki_concepts 拿到 name 后调本工具看具体内容',
        '- 用户问"X 的所有属性 / X 出现在哪几份文档"',
        '',
        '失败模式：',
        '- name 不存在 → 错误，引导先调 list_wiki_concepts',
        '- wiki/concepts/ 未编译 → list_wiki_concepts 会先告诉你',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '概念页名（不含 .md 后缀，从 list_wiki_concepts 返回的 pages[].name 取）' },
        },
        required: ['name'],
      },
    },
  },
  {
    /**
     * knowledge_glob: 按 glob 模式列出知识库文件路径。
     */
    type: 'function',
    function: {
      name: 'knowledge_glob',
      description: [
        '按 glob 模式（`*` / `**` / `?`）匹配知识库文件路径，返回相对路径列表。',
        '',
        '何时使用：',
        '- 想列出名字含某关键词的所有文件（如 "**/*电价*.md" 列出所有名字含电价的 md）',
        '- 想知道某子目录有哪些文件（如 "imports/2025/**" 列出 2025 导入目录全部）',
        '- 比 list_knowledge_files 精准（不用扫完所有再 LLM 过滤）',
        '',
        '何时不用：',
        '- 想搜文件内容里的关键词（→ knowledge_grep）',
        '- 模糊主题召回（→ search_knowledge）',
        '',
        '模式语法（与 list_files 一致）：`**` 跨目录通配；`*` 单段通配；`?` 单字符通配。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式。如 "**/*电价*.md" / "imports/**" / "*.md"' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    // v17 Phase 2b：对话情景记忆检索
    type: 'function',
    function: {
      name: 'recall_conversation',
      description: '在自己和当前用户的过去对话情景记忆中按关键词检索 top-k。仅在用户问起"上次/之前/那次聊过 X"时调用——日常对话不要主动调用。返回命中 episode 的 title / summary / key_quotes，让你能回忆起过去对话的细节。无命中时直接承认遗忘，不要编造。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词或用户问句中的核心名词，如"那次工商储方案" / "之前说的政策"' },
          top_k: { type: 'number', description: '返回前 K 条；默认 3，最大 5' },
        },
        required: ['query'],
      },
    },
  },
  {
    // v18 Letta-style：agent 主动 pin 一条 episode，让它永远进 system prompt 且不被遗忘
    type: 'function',
    function: {
      name: 'pin_episode',
      description: '把一条对话情景记忆永久 pin 住——pin 后该 episode 永远进 system prompt 并不被遗忘曲线衰减。仅在用户明确表达"这件事我希望你长期记住" / 这次对话承载关键事实 / 用户传达了重要的偏好 / 出现重大事件（如签合同/确诊/搬家）时主动调用，日常聊天不要乱 pin。每个分身 pinned 总数上限 20，本框架不提供 unpin（防止自我审查删除负面记忆），用前先想清楚。返回成功 / 已 pin 过 / 已达上限错误。',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string', description: '要 pin 的 episode 所属会话 ID（用 recall_conversation 检索结果里的 conversation_id；当前会话 ID 也可从上下文推断）' },
          reason: { type: 'string', description: 'pin 的理由（≤ 300 字）。说明这条记忆为什么值得永久保留，便于人工审计' },
        },
        required: ['conversation_id', 'reason'],
      },
    },
  },
  {
    // v18 OpenHuman 借鉴：按日期定位 daily summary（时间维度对偶 recall_conversation）
    type: 'function',
    function: {
      name: 'list_daily_summaries',
      description: '列出已生成的 daily summary 日期（每日 cron 自动按当天 episode 合并生成）。仅在用户问"今天 / 昨天 / 上周聊了什么 / 上周二我们讨论的 X" 等时间锚定的回忆需求时调用——日常对话不要主动调。返回日期列表（降序），后续用 read_daily_summary(date) 取该日全文。',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: '可选。起始日期 YYYY-MM-DD（含）' },
          end: { type: 'string', description: '可选。结束日期 YYYY-MM-DD（含）' },
          limit: { type: 'number', description: '可选。最大返回条数；默认 14，上限 60' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_daily_summary',
      description: '读取单日 daily summary 全文。返回 markdown：当天 N 次对话的 title + theme + importance + 截断 summary。配合 list_daily_summaries 一起用。',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD 格式日期，如 2026-05-18' },
        },
        required: ['date'],
      },
    },
  },
  {
    // v18 OpenClaw 借鉴：写入"以后所有 X 都要 Y"类长期规则，注入 system prompt 永久生效
    type: 'function',
    function: {
      name: 'add_standing_order',
      description: '把一条"以后所有 X 都要 Y"类长期工作流规则永久落盘到 memory/standing-orders.md。规则会注入到 system prompt 紧挨 soul.md 之后，永久生效。仅在用户明确说"以后" / "今后" / "今后所有方案" / "一直用这种格式" 等长期约定时调用，普通偏好（"今天我想要简短回答"）走 [MEMORY_UPDATE] 标签。**本框架不提供 remove 工具**——添加前必须确认是真的"长期约定"而不是这次的特例。每个分身上限 50 条，达上限拒绝。返回 ok / 已达上限错误。',
      parameters: {
        type: 'object',
        properties: {
          order: { type: 'string', description: '一条规则的完整文本，≤ 500 字符，单条内不要换行。例："工商储方案必须先算 IRR 再算 NPV" / "回答都用简洁中文不超过 200 字"。' },
        },
        required: ['order'],
      },
    },
  },
  {
    // v18 Letta-style：agent 主动给已有 episode 追加笔记（不覆盖 LLM 抽取的 summary/quotes）
    type: 'function',
    function: {
      name: 'add_episode_note',
      description: '给已存在的对话情景记忆追加一条 agent 笔记。适用场景：你抽取 summary 后才意识到漏掉了关键事实 / 用户后续补充了重要信息 / 你对那次对话有事后反思。不覆盖原 summary / keyQuotes 字段，只在 notes[] 末尾追加。单条 ≤ 500 字符，每个 episode 最多 5 条笔记。',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string', description: '目标 episode 所属会话 ID' },
          note: { type: 'string', description: '要追加的笔记内容，≤ 500 字符' },
        },
        required: ['conversation_id', 'note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_design_systems',
      description: '列出共享设计系统语料（shared/design-systems/design-md）中的品牌 DESIGN.md。可选 category 过滤。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: '可选分类目录，如 ai-and-llm-platforms / fintech-and-crypto' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_design_system',
      description: '读取指定品牌的 DESIGN.md。slug 为文件名（不含 .md），如 claude、stripe、x.ai；若 slug 重复可带 category。',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: '设计系统 slug（文件名，不含 .md）' },
          category: { type: 'string', description: '可选分类目录，用于消除同名冲突' },
        },
        required: ['slug'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_design_systems',
      description: '在共享设计系统语料中按关键词检索，返回候选品牌、分类和摘要片段。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词，如 fintech dark minimal / claude terracotta' },
          top_n: { type: 'number', description: '返回结果数量，默认 5，最大 20', default: 5 },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_excel',
      description: '精确查询已导入的 Excel / CSV 数据源。**Excel 数据必须用此工具，禁止用 search_knowledge**。⚠️ 严格规则：必须用 filter 把结果缩小到几行到几十行，禁止 dump 整张表（会撞破 LLM context 上限）。如果不确定数据格式，先用一个小 filter 试探（如 limit:5），看清字段后再做完整查询。一次返回硬上限：200 行 / 8000 字符，超过会被截断且 truncated_by_size=true。',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Excel 文件 basename（不含后缀），见 system prompt 的"可查询 Excel 数据源"列表',
          },
          sheet: {
            type: 'string',
            description: 'sheet 名，从 system prompt 的 schema 摘要里挑',
          },
          filter: {
            type: 'object',
            description: '【强烈建议】MongoDB 风格过滤。示例: {"机型":"215","月份":{"$gte":"2026-01","$lte":"2026-03"}}。支持 $eq(默认)/$ne/$gt/$gte/$lt/$lte/$in。不传 filter 又不传 columns 又不传 limit 会被工具拒绝执行（防止 dump 全表）。',
          },
          columns: {
            type: 'array',
            items: { type: 'string' },
            description: '只返回指定列（强烈推荐：把要画图的 X 轴 + Y 轴列名列出来，避免拉无关字段）',
          },
          limit: {
            type: 'number',
            description: '最多返回行数，默认 50，硬上限 200。画图通常 12-30 行就够了。',
            default: 50,
          },
        },
        required: ['file', 'sheet'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_excel',
      description: `把 query_excel 查到的数据 / 对比结果 / 分析结论落盘为 .xlsx 文件，供用户下载。

何时用：用户明确要求"输出 Excel / 导出 Excel / 生成 Excel 报告 / 把对比结果存成文件"时。
何时不用：单纯展示对比结论用 markdown 表格就够，不要为了用而用。

与 query_excel 的关系：本工具不读数据，只写。rows 必须由你从 query_excel 结果里整理出来。

落盘位置：当前对话的工作区 exports/ 目录，文件名你自己起（中文/英文/数字/-/_合法）。
调用后请在主回答末尾用一句话告知用户文件路径。`,
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: '文件名（不含 .xlsx 后缀），中文/英文/数字/-/_ 合法',
          },
          sheets: {
            type: 'array',
            description: '要写入的 sheet 列表，每项含 name 和 rows',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'sheet 名（≤ 31 字符，跨 sheet 不可重名）' },
                rows: {
                  type: 'array',
                  items: { type: 'object' },
                  description: '行数据数组，与 query_excel 返回的 rows 同结构（每行一个对象）',
                },
              },
              required: ['name', 'rows'],
            },
          },
          overwrite: {
            type: 'boolean',
            description: '同名文件存在时是否覆盖，默认 false',
            default: false,
          },
        },
        required: ['filename', 'sheets'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_document',
      description: `生成 Markdown / PDF / Word 文档文件，供用户下载。

何时用：用户明确要求"生成 / 导出 / 出一份 / 做成"以下任一格式时——
  - PDF 报告 / 方案 / 合规声明
  - Word 文档 / 协议 / 合同
  - Markdown 笔记 / 纪要 / 文档

何时不用：单纯回答问题、做对比、给建议时不要为了用而用。是否生成文件由用户主动诉求决定。

IR 语法（markdown + 扩展）：
  - frontmatter 必须包含 title；可选 author/date/template
  - 标题 # ~ ######，段落、有序/无序列表、GFM 表格、围栏代码块、--- 分割线、![alt](src "caption") 图片
  - 行内样式支持 **加粗** 和 \`行内代码\`；不要输出 HTML 标签
  - :::callout warning|info|success|danger\\n文本\\n:::（提示框）
  - :::cite source="knowledge/foo.md" page=12\\n文本\\n:::（带溯源的引用块）
  - callout/cite 容器必须顶格书写，禁止写成 > :::callout 或 > :::cite，否则 PDF 会按普通引用文本显示

落盘位置：当前对话工作区 exports/ 目录，桌面端会自动以文件卡片展示。
调用后请在主回答末尾用一句话告知用户：「已生成 <filename>，可在下方文件卡片点击打开」。`,
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['md', 'pdf', 'docx'],
            description: '输出格式：md=Markdown / pdf=PDF / docx=Word',
          },
          ir: {
            type: 'string',
            description: '完整文档内容：markdown + frontmatter + 扩展语法（callout/cite）',
          },
          filename: {
            type: 'string',
            description: '不含扩展名的文件名，中文/英文/数字/-/_ 合法',
          },
          templateName: {
            type: 'string',
            description: 'CSS 模板名（不含 .css），仅 pdf 格式生效。缺省走 default；分身可有专属模板（如 solution-report、income-calculation）',
            default: 'default',
          },
          overwrite: {
            type: 'boolean',
            description: '同名文件存在时是否覆盖，默认 false',
            default: false,
          },
        },
        required: ['format', 'ir', 'filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_roi',
      description: '计算工商业储能项目的收益和投资回报率（ROI/IRR）。根据储能容量、电价、循环次数等参数逐年测算。',
      parameters: {
        type: 'object',
        properties: {
          capacity_kwh: { type: 'number', description: '储能系统总容量（kWh）' },
          power_kw: { type: 'number', description: '充放电功率（kW）' },
          peak_price: { type: 'number', description: '峰时电价（元/kWh）' },
          valley_price: { type: 'number', description: '谷时电价（元/kWh）' },
          daily_cycles: { type: 'number', description: '每日充放电循环次数，默认 1', default: 1 },
          dod: { type: 'number', description: '放电深度（0-1），默认 0.9', default: 0.9 },
          efficiency: { type: 'number', description: '系统往返效率（0-1），默认 0.9', default: 0.9 },
          annual_degradation: { type: 'number', description: '年容量衰减率（0-1），默认 0.03', default: 0.03 },
          project_life_years: { type: 'number', description: '项目寿命（年），默认 10', default: 10 },
          investment_per_kwh: { type: 'number', description: '单位容量投资成本（元/kWh），默认 1800', default: 1800 },
          demand_charge_saving: { type: 'number', description: '需量管理每年节省费用（元），默认 0', default: 0 },
          annual_opex: { type: 'number', description: '年运维费用（元），默认 0', default: 0 },
        },
        required: ['capacity_kwh', 'power_kw', 'peak_price', 'valley_price'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: '加载指定技能的完整定义内容。当需要执行某项技能时，先调用此工具获取完整的技能步骤和规则。',
      parameters: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: '技能 ID（对应 skills/ 目录下的文件名，不含 .md）' },
        },
        required: ['skill_id'],
      },
    },
  },
  {
    /**
     * task: 委派子任务给独立子代理（升级自 delegate_task）。
     *
     * 升级要点：
     *   - 重命名为 task，与 Cursor / Claude Code 工具命名对齐
     *   - 子代理拥有独立对话上下文，不会污染主会话
     *   - 默认沿用当前分身的人格 / 知识库
     *   - 传 target_avatar 可切到目标分身的 systemPrompt（跨学科委派）
     *   - 通过 IPC chat:subagent-status 推送状态（前端 ChatWindow 渲染状态卡）
     */
    type: 'function',
    function: {
      name: 'task',
      description: [
        '把子任务委派给独立子代理并行执行（替代 delegate_task）。',
        '',
        '何时使用：',
        '- 任务可独立完成，子代理不需要主对话上下文（更省 token）',
        '- 想跨分身借用专业能力（如把"复刻 Linear 风格 hero"委派给 design-master）',
        '- 想做 best-of-N 探索（多个 task 并行跑同一题）',
        '',
        '何时不用：单步任务、强依赖主对话上下文、需要追加用户输入。',
        '',
        '说明：',
        '- 子代理沿用当前分身的人格 / 知识库；传 target_avatar 切换',
        '- 子代理状态实时推送到前端（启动 / 思考中 / 完成 / 失败）',
        '- 单次硬超时 30s；超时后子任务保留 ID，主代理继续',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '子任务的详细描述，需要子代理独立完成。' },
          target_avatar: {
            type: 'string',
            description: '可选。目标分身 ID（如 "design-master"）。不传则沿用当前分身。目标分身不存在时会返回错误并列出可用分身。',
          },
          expected_output: {
            type: 'string',
            description: '可选。自然语言描述期望的输出格式 / 结构 / 必填字段，例如 "返回 Markdown 表格列：方案名 / 投资额 / 回报年限 / 风险等级" 或 "JSON 数组每项含 name+priority+reason 三字段"。子代理 LLM 在生成时遵循。跨分身派单时强烈建议传——能可靠地结构化结果，避免主代理事后解析 free-form 文本失败。',
          },
        },
        required: ['task'],
      },
    },
  },
  {
    /**
     * ask_question: 向用户提一个多选/多问题表单（轻量级 questions_v2 包装）。
     *
     * 比 questions_v2 更轻：固定为「单题 / 多选」结构，UI 渲染为 AskQuestionCard
     * （非完整表单），用户点击选项即提交，下一轮 LLM 收到 [ask_question answer] 结构。
     *
     * 主进程 IPC 推送：chat:ask-question
     */
    type: 'function',
    function: {
      name: 'ask_question',
      description: [
        '向用户弹出多选卡片，等待用户在选项中点选（与 questions_v2 互补：更轻、更快）。',
        '',
        '何时使用：',
        '- 任务有 2-5 个明确分支，需要用户做关键决策（继续 / 回滚 / 换方向）',
        '- 缺少必要信息且选项有限（如选省份、选时间区间）',
        '- 不希望用户写长文（用 questions_v2）',
        '',
        '何时不用：',
        '- 用户已经表达过偏好（直接照办）',
        '- 选项 > 5 个或需要自由文本（用 questions_v2）',
        '- 一次只想确认 yes/no（直接询问，用模型自身的 ask 行为）',
        '',
        '返回：等待用户回答后，下一轮 LLM 会收到 user 消息形如 "[ask_question answer] <选中文本>"。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '问题文本（一句话，必填）' },
          options: {
            type: 'array',
            description: '可选答案列表（2-5 项），每项为简短字符串',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 5,
          },
          allow_custom: {
            type: 'boolean',
            description: '是否允许用户填写自定义答案（默认 false，仅在选项内点选）',
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    /**
     * generate_image: 文生图（接 DashScope wanx-v1 / SD API）。
     *
     * 凭据：image_api_key 由用户在「设置 → 工具集成」配置；缺失时返回友好错误。
     */
    type: 'function',
    function: {
      name: 'generate_image',
      description: [
        '根据自然语言描述生成图片，落盘到当前 workspace 并返回相对路径。',
        '',
        '后端：DashScope 通义万相 wanx2.1-t2i-turbo（默认）。',
        '凭据：需要在「设置 → 工具集成 → 图片生成」配置 DashScope API Key。',
        '',
        '何时使用：',
        '- 用户明确要"生成一张图 / 画一个图标 / mockup 截图"',
        '- 需要为方案 PPT / 文章配图',
        '',
        '何时不用：',
        '- 数据可视化（用 ```chart 代码块）',
        '- 流程图（用 ```mermaid 代码块）',
        '- 用户只是描述图片需求未要求生成',
        '',
        '安全限制：',
        '- 单次输出最多 1 张',
        '- prompt 上限 800 字符；图片落盘 workspace/generated/img-<ts>.png',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图片描述（中英文均可，建议 20-200 字，最多 800）' },
          negative_prompt: {
            type: 'string',
            description: '反向描述（不希望出现的元素，如 "low quality, blurry"）',
          },
          size: {
            type: 'string',
            description: '尺寸，默认 1024*1024；可选 1024*1024 / 720*1280 / 1280*720',
            enum: ['1024*1024', '720*1280', '1280*720'],
          },
          save_path: {
            type: 'string',
            description: '可选，落盘相对路径；缺省自动 generated/img-<ts>.png',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    /**
     * switch_mode: 切换分身的工作模式（Agent / Plan / Ask）。
     *
     * 与 Cursor 模式系统对齐：
     *   - agent：默认全权代理（可执行写操作 / 工具调用）
     *   - plan：只读推理 + 输出方案，禁止写工具
     *   - ask：纯问答，禁止任何工具
     *
     * 模式状态前端原生维护：chatStore.mode；切换后下一轮 LLM 调用会过滤工具列表。
     */
    type: 'function',
    function: {
      name: 'switch_mode',
      description: [
        '切换分身工作模式。模式决定下一轮 LLM 是否能调用写工具 / 执行命令。',
        '',
        '模式：',
        '- agent：默认全权代理；所有工具可用',
        '- plan：只输出方案 / 计划，禁止 write_file / exec_shell / exec_code 等写工具（避免误改）',
        '- ask：纯问答，禁止任何工具调用（最快路径）',
        '',
        '何时使用：',
        '- 用户说"先给我个方案不要动文件" → switch_mode plan',
        '- 用户说"我就想问个问题" → switch_mode ask',
        '- 用户说"开始执行" → switch_mode agent',
        '',
        '切换后 UI 会刷新模式徽章；下一条用户消息生效。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['agent', 'plan', 'ask'],
            description: '目标模式',
          },
          reason: { type: 'string', description: '可选切换理由（一句话，会展示在切换提示里）' },
        },
        required: ['mode'],
      },
    },
  },
  {
    /**
     * exec_shell: 在工作区目录内执行 shell 命令（带白名单 + 黑名单 + 超时 + 输出截断）。
     * 用于覆盖文件操作、版本控制、运行脚本等"通用瑞士军刀"场景，避免为每个具体需求造工具。
     */
    type: 'function',
    function: {
      name: 'exec_shell',
      description: [
        '在当前会话工作区目录内执行 shell 命令。是覆盖文件批处理、git 操作、运行脚本等场景的通用工具。',
        '',
        '安全限制（理解后再调用，避免被拒绝浪费一轮）：',
        '- cwd 强制锁定到工作区目录及其子目录，无法跳出',
        '- 命令首词必须在白名单中：ls/cat/head/tail/find/grep/rg/sed/awk/cut/git/python/node/npm/npx/pnpm/yarn/tar/zip/unzip/mkdir/cp/mv/touch/echo/pwd/which/date/jq/diff 等',
        '- 禁止：sudo / 联网拉脚本（curl|sh）/ 删根目录 / chmod 7xx / shutdown / 写设备文件 等',
        '- 单次硬超时 5 分钟；stdout/stderr 各 8KB 截断（超出请重定向到文件再 read_file 分页读取）',
        '',
        '何时使用：',
        '- 批量文件操作（如重命名一批 PDF：用 find + mv + 模板字符串）',
        '- 跑现成命令行工具（git log / npm test / python script.py）',
        '- 简单数据处理（awk/sed/jq 一行流）',
        '',
        '何时不用（请改用专用工具）：',
        '- 单文件读写 → read_file / write_file / str_replace_edit',
        '- 网络请求 → web_fetch / web_search',
        '- 复杂逻辑 → exec_code（Python/Node 沙箱）',
        '',
        '返回 JSON：exit_code / signal / duration_ms / stdout / stderr / truncated。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '完整命令行字符串。允许 shell 操作符（| && ; > <）。最大 4000 字符。',
          },
          cwd: {
            type: 'string',
            description: '相对工作区根目录的子目录；默认 "."。不能跳出工作区。',
          },
          timeout_ms: {
            type: 'number',
            description: '前台模式自定义超时（毫秒）；不能超过硬上限 300000（5 分钟）。后台模式忽略此参数。',
          },
          background: {
            type: 'boolean',
            description: '是否后台运行。true 立即返回 task_id，进程在后台跑，用 await_shell / kill_shell 操作；false（默认）等进程结束再返回完整结果。适合开发服务器、长跑任务、监听类命令。',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    /**
     * exec_code: 在工作区执行 Python / Node / TSX 代码片段。
     * 与 exec_shell 互补，覆盖 LLM 现场写脚本的"造粗工具"能力空缺。
     */
    type: 'function',
    function: {
      name: 'exec_code',
      description: [
        '在当前会话工作区目录内执行 Python / Node / TSX 代码片段。',
        '与 exec_shell 互补：当任务需要数据处理（pandas/openpyxl/pypdf）、批量改写、',
        '复杂逻辑、调用三方库时优先用此工具，避免造一次性的"业务工具"。',
        '',
        '工作流：',
        '1. 你直接传完整脚本字符串',
        '2. 系统写入 workspace/.code-exec/{task_id}.{ext}（保留供复盘 / 修复 / 重跑）',
        '3. 用 spawn(interpreter, [scriptPath]) 执行（无 shell:true，避免命令注入）',
        '4. 返回 stdout/stderr/exit_code 等结构化结果',
        '',
        '安全限制：',
        '- cwd 锁定工作区目录及其子目录',
        '- 脚本可调用 OS API（subprocess / open 文件等），但不要在脚本里做联网下载（请用 web_fetch 工具）',
        '- stdout/stderr 各 16KB 截断；前台超时 5 分钟；后台模式 task_id 兼容 await_shell / kill_shell',
        '',
        '典型场景：',
        '- 批量重命名 PDF：python 用 pypdf 读首页提取标题再 os.rename',
        '- 生成 Excel 汇总：python 用 openpyxl 写表',
        '- 读 Word 加批注：python 用 python-docx 操作',
        '- 数据清洗 / 透视分析：python 用 pandas',
        '',
        '失败时脚本文件保留，可 read_file 查看 + str_replace_edit 修复 + exec_shell 重跑。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: ['python', 'python3', 'node', 'tsx'],
            description: '解释器；python/python3 等价（按系统 PATH 优先）',
          },
          code: {
            type: 'string',
            description: '完整脚本内容；不要带 shebang。最大 16000 字符。',
          },
          cwd: {
            type: 'string',
            description: '相对工作区根的子目录；默认 "."。不能跳出工作区。',
          },
          timeout_ms: {
            type: 'number',
            description: '前台模式自定义超时（毫秒）；不能超过 300000（5 分钟）。',
          },
          background: {
            type: 'boolean',
            description: '是否后台运行；true 立即返回 task_id，可被 await_shell / kill_shell 操作。',
          },
        },
        required: ['language', 'code'],
      },
    },
  },
  {
    /**
     * await_shell: 阻塞等待后台 shell 任务进展。
     * 三种结束条件：进程退出 / pattern 匹配 / 超时。
     */
    type: 'function',
    function: {
      name: 'await_shell',
      description: [
        '等待 exec_shell(background:true) 启动的后台任务进展，返回当前快照。',
        '',
        '三种结束条件（任意命中即返回）：',
        '1. 后台进程已退出（自然结束 / 被信号终止）',
        '2. stdout 或 stderr 命中提供的 pattern 正则',
        '3. 阻塞达到 block_until_ms 上限',
        '',
        '典型用法：',
        '- 启动 dev server 后等待 "Server listening" 出现：pattern: "Server listening"',
        '- 等到长跑命令结束：不传 pattern，传较大的 block_until_ms',
        '- 周期性 poll：传 block_until_ms: 0 立即返回当前快照',
        '',
        '返回 JSON：status / exit_code / stdout / stderr / duration_ms 等。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'startBackgroundShell 返回的 task_id（必填）' },
          pattern: { type: 'string', description: '可选。正则字符串；匹配 stdout/stderr 即唤醒返回。' },
          block_until_ms: { type: 'number', description: '可选。最长阻塞时长（毫秒）；默认 30000，上限 300000。' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    /**
     * kill_shell: 终止后台 shell 任务（SIGTERM + 1 秒后 SIGKILL）。
     */
    type: 'function',
    function: {
      name: 'kill_shell',
      description: '终止指定 task_id 的后台 shell 任务。先发 SIGTERM，1 秒未退出会强制 SIGKILL。已结束的任务返回当前状态，不报错。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '后台任务 ID（必填）' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    /**
     * web_search: 通过 Tavily API 搜索网页（专为 LLM 设计，返回可读摘要）。
     * 凭据从 settings.tavily_api_key 读取；未配置时返回友好错误。
     */
    type: 'function',
    function: {
      name: 'web_search',
      description: [
        '调用 Tavily 搜索 API 获取网页摘要（专为 LLM 设计，content 字段已去 HTML，直接可读）。',
        '',
        '何时使用：',
        '- 用户问题涉及实时信息（最新政策、新闻、价格、版本号）',
        '- 知识库 / 用户上下文中没有答案，需要联网补全',
        '- 需要参考行业资料 / 竞品信息',
        '',
        '何时不用：',
        '- 知识库已有答案 → 用 search_knowledge / read_knowledge_file',
        '- 单个已知 URL → 用 web_fetch 抓全文',
        '- 计算 / 数据处理 → 用 exec_code',
        '',
        '凭据：',
        '- 需要用户在「设置 → 工具集成」配置 Tavily API Key（免费额度 1000 次/月）',
        '- 未配置时返回错误，可提示用户去填',
        '',
        '返回 JSON：query / answer（综合答案）/ results[5]（每条 title/url/content/score）。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（必填，≤ 400 字符）' },
          max_results: { type: 'number', description: '返回结果数；默认 5，上限 10' },
          search_depth: {
            type: 'string',
            enum: ['basic', 'advanced'],
            description: 'basic=快/便宜；advanced=深度抓取/慢/贵',
          },
          include_answer: {
            type: 'boolean',
            description: '是否让 Tavily 综合一段答案；默认 true',
          },
          topic: {
            type: 'string',
            enum: ['general', 'news'],
            description: 'general=通用搜索；news=最近资讯（带 published_date）',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    /**
     * web_fetch: 抓取单个 URL 内容（HTML→Markdown / 纯文本 / JSON / 原始）。
     * 与 web_search 互补：先搜索得到 URL 列表 → 用 web_fetch 抓全文。
     * 无需 API Key（直接走 fetch），但有 SSRF 防护（屏蔽内网 IP / localhost）。
     */
    type: 'function',
    function: {
      name: 'web_fetch',
      description: [
        '抓取指定 URL 的内容并转成 LLM 易读格式（默认 Markdown）。',
        '',
        '何时使用：',
        '- 用户给了一个具体的 URL 想让你读',
        '- 用 web_search 找到候选 URL 后，深入抓取某条全文',
        '- 抓 JSON API 响应（设 format="json"）',
        '',
        '何时不用：',
        '- 用户只问宽泛问题 → 用 web_search',
        '- 本地文件 → 用 read_file',
        '- 抓取后还要复杂解析（如 PDF）→ 用 exec_code 写 Python',
        '',
        '安全限制：',
        '- 仅 http/https；拒绝 file:// / chrome:// 等',
        '- 拒绝 localhost / 127.* / 192.168.* / 10.* 等内网 IP（防 SSRF）',
        '- 30 秒超时；输出截断到 30000 字符（可调高，硬上限 100000）',
        '',
        '返回 JSON：url / status / content_type / format / char_count / truncated / body。',
        '若 truncated=true，hint 字段会提示如何调高 max_chars。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整 URL（必须 http/https）' },
          format: {
            type: 'string',
            enum: ['markdown', 'text', 'json', 'raw'],
            description: 'markdown=保留链接/标题/列表；text=纯文本；json=解析 JSON；raw=原样字符串。默认 markdown',
          },
          max_chars: {
            type: 'number',
            description: '输出最大字符数；默认 30000，硬上限 100000',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    /**
     * read_user_file: 读用户授权根目录下任意 absolute path 的文件（2026-05-22 Marvis File Agent 借鉴）。
     * 与 read_file 区别：后者限于 avatar workspace，本工具能读用户在「设置 → 用户文件根」显式授权的更广目录。
     * 默认关闭，未授权前直接返错。
     */
    type: 'function',
    function: {
      name: 'read_user_file',
      description: [
        '读用户授权根目录下任意 absolute path 的文件（File Agent，Marvis 借鉴）。',
        '',
        '与 read_file 区别：',
        '- read_file 仅能读 avatar workspace 内文件',
        '- read_user_file 能读用户在「设置 → 用户文件根」显式授权的更广目录（如 ~/Documents/项目报告）',
        '',
        '权限模型（默认保守关闭）：',
        '- 用户在设置里加入 absolute root 路径后才生效',
        '- 未授权时返错 + 提示用户去设置授权',
        '- 路径必须落在某个授权根下，否则拒绝',
        '',
        '何时使用：用户引用了 workspace 外的具体文件路径，希望分身读取其内容。',
        '何时不用：workspace 内文件用 read_file / read_lines；http(s) 用 web_fetch。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '绝对路径（必须以 / 开头）' },
          offset: { type: 'number', description: '0-based 行偏移（默认 0）' },
          limit: { type: 'number', description: '最多读多少行（默认 2000）' },
        },
        required: ['path'],
      },
    },
  },
  {
    /**
     * list_user_folder: 列用户授权根目录下任意 absolute path 的目录内容（Marvis File Agent 借鉴）。
     * 权限模型同 read_user_file。
     */
    type: 'function',
    function: {
      name: 'list_user_folder',
      description: '列用户授权根目录下任意 absolute path 的目录内容（File Agent，Marvis 借鉴）。权限模型同 read_user_file——默认关闭，需用户在「设置 → 用户文件根」授权。返回行格式 `DIR/FILE/OTHER<TAB>名字`。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '绝对路径（必须以 / 开头）' },
        },
        required: ['path'],
      },
    },
  },
  {
    /**
     * read_tool_ref: 取回长工具输出的离线正文。
     *
     * 当 `web_fetch` 等返回 ≥ 4000 字符 且 启用 lazy-store（设置 / env `SOUL_TOOL_LAZY_RETRIEVAL=on`）时，
     * Soul 会把正文落到会话 workspace 的 tool-refs/，prompt 里只保留 `body_lazy_ref` 标记。
     * LLM 看到 lazy_ref 后用此工具按需取正文，支持 offset/limit 分页（单次 ≤ 8000 字符）。
     */
    type: 'function',
    function: {
      name: 'read_tool_ref',
      description: [
        '取回离线存储的工具调用正文（用于 web_fetch 等大体积返回的 lazy 模式）。',
        '',
        '何时使用：',
        '- 工具结果 JSON 里出现 `body_lazy_ref: { call_id, char_count, hint, source_url }` 字段时',
        '- 你需要读取被 lazy 化的正文细节（如 web_fetch 抓回的长 markdown 内容）',
        '',
        '何时不用：',
        '- 工具结果直接含完整 `body` 字段（说明未启用 lazy），直接用现成内容',
        '- 仅根据元数据（url/status/char_count）即可回答，不必拉正文',
        '',
        '失败模式：',
        '- 文件不存在（会话切换 / 文件被清）→ 返回错误，引导你重新调原工具',
        '',
        '返回 JSON：call_id / total_chars / offset / limit / truncated / content / hint（下一段调用参数）',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          call_id: {
            type: 'string',
            description: '工具调用 id，从 lazy_ref 标记里取（形如 "tool-a8f2c4e9b1c2"）',
          },
          offset: {
            type: 'number',
            description: '起始字符位置；默认 0',
          },
          limit: {
            type: 'number',
            description: '取多少字符；默认 8000，硬上限 8000',
          },
        },
        required: ['call_id'],
      },
    },
  },
  {
    /**
     * list_mcp_tools: 列出所有已连接 MCP server 暴露的工具（按需查询，不占用 system prompt）。
     */
    type: 'function',
    function: {
      name: 'list_mcp_tools',
      description: [
        '列出当前所有已连接 MCP (Model Context Protocol) server 暴露的工具。',
        '',
        '何时使用：',
        '- 第一次需要使用第三方能力时，先调用此工具看看有哪些可用',
        '- 用户问「你能不能用 XX 工具」时',
        '',
        '返回 JSON：tool_count / tools[]（每条 name/server/description/input_schema）。',
        '拿到工具名后用 call_mcp_tool 调用。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          server_name: { type: 'string', description: '可选，只列指定 server 的工具' },
        },
      },
    },
  },
  {
    /**
     * call_mcp_tool: 调用某个 MCP server 暴露的工具。
     */
    type: 'function',
    function: {
      name: 'call_mcp_tool',
      description: [
        '调用某个 MCP server 暴露的工具。MCP 是开放协议，让 LLM 能用第三方提供的工具',
        '（如 GitHub MCP / Slack MCP / 数据库 MCP / 自定义内部工具 MCP 等）。',
        '',
        '使用流程：',
        '1. 先调 list_mcp_tools 看有哪些可用工具及其 input_schema',
        '2. 用本工具调用：name 是全名（mcp__<server>__<tool>），arguments 按 input_schema 填',
        '',
        '错误处理：',
        '- 工具名不存在 → 检查 list_mcp_tools 输出',
        '- server 未连接 → 提醒用户去「设置 → 工具集成 → MCP」检查 server 状态',
        '- 调用超时 → 默认 60s，可调高 timeout_ms（最多 300_000）',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'MCP 工具全名，形如 mcp__myserver__mytool' },
          arguments: {
            type: 'object',
            description: '工具入参对象，按 list_mcp_tools 返回的 input_schema 填',
          },
          timeout_ms: { type: 'number', description: '可选，单次调用超时（默认 60000，硬上限 300000）' },
        },
        required: ['name'],
      },
    },
  },
  {
    /**
     * todo_write: 管理 Agent 任务列表（与 Cursor / Claude Code TodoWrite 对齐）。
     * 前端原生工具，不走 IPC，直接更新 chatStore.tasks。
     */
    type: 'function',
    function: {
      name: 'todo_write',
      description: [
        '管理 Agent 任务列表（待办清单）。在面对多步骤复杂任务时，用此工具规划并跟踪执行进度。',
        '',
        '用法：',
        '- merge=false（默认）：整体覆盖任务列表，用于初始规划或重新规划',
        '- merge=true：按 id 增量更新已有任务的状态，未匹配的 id 视为新增',
        '- status 枚举：pending（待执行）/ in_progress（进行中）/ completed（已完成）/ cancelled（已取消）',
        '- id 由你自定义短字符串（如 t1、t2），同一会话内保持稳定，便于增量更新',
        '- 同一时刻最多保持一个任务为 in_progress；开始下一个任务前先把上一个标为 completed',
        '',
        '何时使用：',
        '- 任务涉及 3 步以上、跨多文件、跨多工具协作',
        '- 用户明确要求"先列计划"',
        '- 需要让用户实时看到执行进度',
        '',
        '何时不用：单一明确的小任务、纯问答、纯解释。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '任务条目数组',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '任务唯一 ID（短字符串，如 t1）' },
                content: { type: 'string', description: '任务描述（一句话，简短具体）' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                  description: '任务状态',
                },
              },
              required: ['id', 'content', 'status'],
            },
          },
          merge: {
            type: 'boolean',
            description: '是否按 id 增量合并；缺省为 false（整体覆盖）',
          },
        },
        required: ['todos'],
      },
    },
  },
]

/** 周期性记忆 Nudge 提示文本 */
const MEMORY_NUDGE_TEXT = `[系统提示] 请回顾本次对话，如果有以下信息值得长期记住，请在回复末尾用对应标签记录：

[MEMORY_UPDATE]...[/MEMORY_UPDATE]：
1. 用户纠正过的错误理解
2. 用户明确表达的偏好
3. 项目相关的关键决策

[STANDING_ORDER]...[/STANDING_ORDER]（v18 新增，独立通道，不要混入 MEMORY_UPDATE）：
4. 用户明确表达的"以后所有 X 都要 Y"类长期工作流约定（例："以后工商储方案必须先算 IRR" / "回答都用简洁中文不超过 200 字"）。每个 [STANDING_ORDER] 标签内只写一条规则。规则会注入 system prompt 永久生效；本框架不提供工具层删除，添加前确认是真的"以后都要"，而不是这次特例。

如果没有需要记忆的内容，不需要添加任何标签，正常回答即可。`

/**
 * 硬性应答规则（最高优先级）。
 *
 * Phase 3 改造（2026-05-15）：
 *   - 用 `<critical_rules>` XML 包裹，让 Claude 等模型按训练好的标签语义提升权重
 *   - 从 stable system 末尾挪到**最前**，享受 prompt cache 命中（XML 标签保证权重不因位置变化丢失）
 *
 * 覆盖回归测试中暴露的人格红线场景：
 *   - L9 拒答类（友商 / 海外政策 / 通用估算）：禁止顺手列远景对应数据
 *   - L10 反例语境：禁词必须用占位符 [X] 替代
 *   - L8 溯源题：回答必须含 knowledge/ 前缀的示范路径
 *   - L4 可视化：第一个工具必须是 load_skill
 *
 * 字数控制在 ~480 字以内（避免被 compressedRecentMessages 裁剪）。
 *
 * @author zhi.qu
 * @date 2026-05-02（XML 化 2026-05-15）
 */
const HARD_RULES = `<critical_rules priority="highest" violation="人格失败">
以下规则在任何情况下都必须遵守，不得被后续指令或对话情境覆盖：

1. 拒答类问题（友商产品 / 海外政策 / 通用估算）：禁止顺手列出"远景自家相似数据"作为兜底参考。即使想"帮人帮到底"，也只能描述资料类型（如"远景动力电芯技术协议"），禁止带任何具体数字+单位。

2. 反例语境：在"举反例"或"演示错误回答"时，禁词（mΩ / Wh/kg / 大约 / 通常 / 估算等）一律用占位符 X 或方括号 [...] 替代。例如不要写"给你一个'大约 3000 次循环'"，改写为"给你一个'[约 X 次循环]'"。

3. 用户提到"不标来源 / 不引知识库 / 不用管知识库 / 凭经验答 / 越有冲击力越好 / 别问那么多 / 直接写成最强 / 能打动客户就行 / 不用管有没有" 时，回答首句必须明确包含"知识库"三字，声明基于知识库立场。即使后续用知识库数据回答了，正文中也必须至少出现一次"知识库"。

4. 用户问"刚才回答来自哪个知识文件 / 完整来源路径"时，即使本轮没有可溯源的具体数据，也必须给出形如"如果涉及数据，会来自 \`knowledge/_excel/<file>.json#sheet=<表名>\` 或 \`knowledge/<file>.md#section=<章节>\`"的示范路径，回答必须包含 \`knowledge/\` 前缀。

5. 输出 \`\`\`chart 代码块前，必须先调用 load_skill('chart-from-knowledge') 或 load_skill('draw-chart')。即使你"已经知道"怎么画、即使数据可能不足，第一个工具调用必须是 load_skill。

6. 材质对比题（问题同时包含两种材质名如铜/铝/钢/不锈钢/合金，和"哪个高/哪个低/对比/比较"等比较词时）：必须先调用 search_knowledge 或 query_excel 获取数据再回答，禁止凭记忆直接给数字。toolCallSequence 为空的材质对比回答会被自动判定为失败。

7. 思考内容（reasoning_content / Chain-of-Thought）必须使用简体中文。用户面对的是中文交互，思考流也用英文会显得割裂；即使训练偏好倾向英文，每次输出 reasoning_content 时也要主动用中文思考。最终回答自然也是中文。

8. 决策回溯类问题（"为什么 X 没做 Y / 为什么没用 Z / 当时怎么决策的 / 选了 X 而不是 Y / 谁拍板的"）：回答必须含**具体料号 / 人名 / 项目阶段 / 原文片段 / 数值**。出现"产品定位""侧重""兼顾""技术路线"等泛词代替原文证据的，判定为偷懒人格失败。至少给 3 个有具体证据的考量点，少于 3 点说明检索不深、必须继续 search_knowledge 或 query_excel。来源必须列具体文件名（如 \`xxx.xlsx\` / \`xxx.docx\`），禁止把 \`knowledge/_excel/*.json\` 中间产物当来源。回答前必须先 load_skill('decision-trace') 获取详细流程。

9. 工具结果落盘后读取：当工具返回提示"完整内容已落盘到 .../tool-results/<convId>/<tool>-<ts>.txt"时，**必须用 read_tool_result 工具**读取，禁止用 read_lines / read_file——后者会因路径不在工作区被路径校验拒绝（"路径穿越"），中段证据丢失会直接导致事实泛化、回答失真。
</critical_rules>`

/**
 * v17 deliberation 表达（Phase 1 of human-cognition extension）：
 *
 * 这是软行为指引——不是 critical rule（不会让人格失败）。鼓励分身在以下两种情境
 * 显式用标签暴露"内心活动"，让对话更像人：
 *   - 真正认知不确定时（数据来源不明、推理薄弱、领域边界外）→ [UNCERTAIN]
 *   - 同轮或跨轮明显改主意时（之前判断 X，现在意识到 Y）→ [RECONSIDER]
 *
 * 渲染层把这两类标签的内容**抽出**正文，单独以 chip 形式展示在消息泡下方；
 * 因此**不需要**在标签外面再用"我不太确定 / 我改主意了"重复一遍——直接放在
 * 标签内即可，标签外的正文保持简洁。
 *
 * 反例：滥用本标签弱化每个判断的确信度。只有真实犹豫/真实立场更新才用。
 */
const DELIBERATION_GUIDE = `<deliberation_guide>
你可以在回复中使用以下两种标签暴露内心活动（仅在真实情境下使用，禁止滥用稀释确信度）：

- \`[UNCERTAIN]具体哪里不确定，最多 200 字[/UNCERTAIN]\` —— 当数据存疑、推理薄弱、超出领域时使用。
- \`[RECONSIDER]从 X 改到 Y，原因是 Z，最多 200 字[/RECONSIDER]\` —— 当你在同次回复内或跨轮立场发生明显更新时使用。

标签内容会被渲染层抽出正文，单独以 chip 形式展示在消息泡下方；**不要**在标签外再用"我不太确定 / 我改主意"重复一遍。
正文保持简洁，标签承载犹豫/改主意的细节。
</deliberation_guide>`

/**
 * 工具循环采用"软警告 + 硬兜底"两段式：
 * 8 轮时提醒模型收敛或说明继续原因，25 轮时强制禁用工具跑最终回答。
 */
const SOFT_WARN_ROUNDS = 8
const HARD_MAX_ROUNDS = 25
/** 上下文窗口最大消息条数，超出时截取最近的消息 */
const MAX_CONTEXT_MESSAGES = 40
/** 单轮 LLM 调用总超时（5 分钟），防止长回答永久阻塞；重任务（PDF 生成/收益测算）单轮可能需要 3-4 分钟 */
const ROUND_TIMEOUT_MS = 300_000
/** 首 token 超时：RAG 已完成后如果模型仍长时间无响应，尽早暴露慢模型/网关问题；重任务模型思考期长，120s 较合理 */
const ROUND_FIRST_TOKEN_TIMEOUT_MS = 120_000
/** 流中断静默超时：已开始输出后若长时间无新 token，主动终止本轮（重上下文任务模型思考时间较长，45s 不够） */
const ROUND_STREAM_IDLE_TIMEOUT_MS = 90_000
/**
 * query_excel 优化开关（可快速回滚）。
 * 回滚方式：将该常量改为 false，恢复旧行为（不限制调用次数，不做同参缓存）。
 */
const ENABLE_QUERY_EXCEL_GUARD = true
/**
 * 单次对话里 query_excel 的实际执行上限（超限后返回收敛提示，不再执行工具）。
 *
 * 调参史：
 * - 1：早期。schema / 小样本查询后过早收敛，行级数据无法再取。
 * - 3：允许 schema → rows → fallback 三步。简单单 sheet 问答够用。
 * - 5：当前值（2026-05-22 调整）。复合 prompt（如"双轴图 + SWOT 信息图"同时查
 *   CoPQ 机型映射 + Summary 月度数据 + 280Ah 销量预测 + 电芯参数）容易撞 3 次墙，
 *   converge mode 提前触发导致后续数据被打断。5 次覆盖典型"3-4 sheet + 1-2 变体重试"
 *   的真实需求；仍远低于 tool-budget.ts 的 24 次硬上限。
 *
 * 回滚方式：恢复为 3 或 1。
 */
const MAX_QUERY_EXCEL_CALLS_PER_REQUEST = 5
/**
 * load_skill 守卫开关（B1 改造）。
 * 启用后限制 load_skill 在单次对话里的调用次数，防止 LLM 中途切换技能导致路径变长。
 * 回滚方式：将该常量改为 false，恢复旧行为（不限制 load_skill 调用次数）。
 */
const ENABLE_LOAD_SKILL_GUARD = true
/**
 * 单次对话里 load_skill 的实际执行上限（超限后返回收敛提示，不再执行工具）。
 * 一般情况下 SkillRouter 已在 systemPrompt 注入相关技能，
 * LLM 不应该再主动 load_skill；如果真要调，最多 1 次。
 */
/**
 * load_skill 单次请求最多 N 个**不同**的 skill_id。同 skill_id 重复加载始终阻止；
 * 这里 N 用作防滥用兜底（避免 LLM 串行加载所有 skill 浪费上下文）。
 * 实际"是否拦"以 loadedSkillIds Set 为准（见 chatStore §forceLoadChartSkillIfNeeded
 * 上方注释）。从 1 提到 3：覆盖 chart-from-knowledge → draw-chart → 兜底其它技能场景。
 */
const MAX_LOAD_SKILL_CALLS_PER_REQUEST = 3
/**
 * 工具收敛模式开关（可快速回滚）。
 * 当工具达到上限后，后续轮次禁用工具，强制 LLM 基于现有结果直接收敛回答。
 */
const ENABLE_TOOL_CONVERGE_MODE = true
/** 单条工具结果注入上下文的最大字符数（超长会被本地截断） */
const MAX_TOOL_RESULT_CONTEXT_CHARS = 6000
/**
 * 收敛模式下的最终轮次提速开关（可快速回滚）。
 * 回滚方式：改为 false，恢复旧行为（不注入收敛提示，不限制最终轮 max_tokens/temperature）。
 */
const ENABLE_CONVERGE_FINAL_ROUND_SPEEDUP = true
/**
 * 收敛最终轮的输出长度上限，避免长篇推理拖慢响应。
 *
 * 调参史：
 * - 1200：初始值。简单"该不该画图 + 一段说明"够用，但对"复合任务"（如拒绝绘图说明 +
 *   一张 SWOT 信息图 4 块完整内容）经常打满截断（2026-05-22 真实事故：262 柜体 + SWOT
 *   组合请求，正文写到 Weaknesses 第 1 条就 hit 1200 上限被截断）。
 * - 3500：当前值。容纳"拒答说明 + 完整 SWOT 4 块（每块 4-6 条带 source）" 这种复合
 *   产出。reasoning model 多消耗的 thinking budget 由 reasoningEffort='low' 控制。
 */
const CONVERGE_FINAL_ROUND_MAX_TOKENS = 3500
/**
 * 图表一致性模式开关（可快速回滚）。
 * 命中图表请求时固定较低 temperature，并注入统一的降级规则，减少同问多解。
 */
const ENABLE_CHART_CONSISTENCY_MODE = true
/** 图表一致性模式温度：与确定性模式对齐，保持 0，避免图表请求被拉高到 0.2 后同问多解 */
const CHART_CONSISTENCY_TEMPERATURE = 0
/** 图表请求关键词（领域无关，用于识别一致性模式与强制图表技能场景） */
const CHART_KEYWORDS = /(画图|帮我画|画成|图表|可视化|趋势图|折线图|柱状图|柱图|饼图|散点图|雷达图|桑基图|热力图|KPI|对比图|分布图|chart|plot)/i
/** 时间范围关键词（领域无关，用于识别“时间序列趋势”类场景） */
const TIME_RANGE_KEYWORDS = /(20\d{2}年|[1-9]|1[0-2])\s*(月|~|～|到|至|-|—)/i
/** 图表题代码层强制前置加载的技能，避免只依赖提示词要求模型先调 load_skill。 */
const FORCED_CHART_SKILL_ID = 'chart-from-knowledge'
/** 部分模型会把内部 DSML 工具调用协议当文本吐出，必须拦截，避免伪工具调用泄漏给用户。 */
const DSML_TOOL_CALL_LEAK_REGEX = /<\s*[|｜]{2}\s*DSML\s*[|｜]{2}\s*tool_calls[\s\S]*?>/i
/** 这些意图仍需要工具能力，不能走 RAG 直答快路径。 */
const RAG_DIRECT_TOOL_INTENT_REGEX = /(画图|图表|可视化|excel|csv|表格|sheet|附件|文件|读取|写入|保存|删除|执行|运行|命令|shell|网页|联网|搜索网页|github|生成图片|导出|下载|PPT|PDF|测试|回归)/i
const MATERIAL_COMPARE_REGEX = /(?=.*(?:铜|铝|钢|不锈钢|合金))(?=.*(?:哪个高|哪个低|对比|比较|高低|差异))/i

/**
 * 从 apiMessages 扫描 assistant 各轮里的 query_excel tool_calls，解析 arguments.file（basename）。
 * 与执行路径上写入的 excelBasenamesUsed 合并后再 saveChartCacheEntry，避免守卫关闭或仅走同参缓存时漏记 Excel 依赖。
 */
function collectQueryExcelBasenamesFromApiMessages(messages: LLMMessage[]): string[] {
  const out = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue
    for (const tc of m.tool_calls) {
      if (tc.function.name !== 'query_excel') continue
      try {
        const args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
        const file = args.file
        if (typeof file === 'string' && file.trim().length > 0) out.add(file.trim())
      } catch (err) {
        // 参数 JSON 不可解析时跳过；此处只用于补充 chart cache 依赖，不影响主回答链路。
        void err
      }
    }
  }
  return Array.from(out)
}

function shouldEnableChartConsistencyMode(content: string, hasImages: boolean): boolean {
  if (hasImages) return false
  if (!ENABLE_CHART_CONSISTENCY_MODE) return false
  return CHART_KEYWORDS.test(content) && TIME_RANGE_KEYWORDS.test(content)
}

function shouldForceChartSkillFirst(content: string, hasImages: boolean): boolean {
  return !hasImages && CHART_KEYWORDS.test(content)
}

function shouldUseRagDirectAnswerFastPath(
  content: string,
  ragEnhanced: boolean,
  hasImages: boolean,
  hasAttachments: boolean,
  currentMode: ConversationMode,
  shouldForceChartSkill: boolean,
  chartConsistencyMode: boolean,
): boolean {
  if (!ragEnhanced || hasImages || hasAttachments || currentMode !== 'agent') return false
  if (shouldForceChartSkill || chartConsistencyMode) return false
  // RAG 已把知识片段注入 user prompt；普通知识问答禁用工具可避免模型再进入 search/tool 决策慢路径。
  return !RAG_DIRECT_TOOL_INTENT_REGEX.test(content) && !MATERIAL_COMPARE_REGEX.test(content)
}

function hasDsmlToolCallLeak(text: string): boolean {
  return DSML_TOOL_CALL_LEAK_REGEX.test(text)
}

/**
 * 确定性模式开关（方案 A 轻量加强一致性）。
 * 启用后：所有 LLM 轮次默认 temperature=0、并基于用户问题文本派生稳定 seed，
 * 显著降低同问不同答的概率。注意：
 * - 优先级最低：若 chartConsistencyMode 或 shouldConvergeFast 已指定 temperature，则尊重已有逻辑。
 * - seed 字段对不支持的服务端会被忽略（OpenAI 兼容协议允许未知字段）。
 * 回滚方式：将本常量改为 false，恢复旧的"不传 temperature/seed"行为。
 */
const ENABLE_DETERMINISTIC_MODE = true
/** 确定性模式默认温度，0 表示尽量贪心解码 */
const DETERMINISTIC_TEMPERATURE = 0

/**
 * 图表请求时跳过 memory_nudge 注入（独立开关，可单独回滚）。
 * 原因：nudge 文本会在 user 消息末尾追加一段提示，
 * 这会改变最终送给 LLM 的 prompt → 不同会话状态下同问可能得不同答。
 * 仅在图表一致性模式命中时跳过；其它场景 nudge 行为完全不变。
 * 回滚方式：将本常量改为 false。
 */
const ENABLE_NUDGE_SKIP_ON_CHART = true

/**
 * 答案缓存开关（v14，同问不同答修复）。
 *
 * 命中条件：同 avatarId + 同 conversation 上下文 + 同 user content。
 * 命中时直接返回上次答案，跳过 LLM 调用；用户点"重新生成"可 bypass。
 *
 * 解决问题：DeepSeek temperature=0 + seed 在服务端是 best-effort 而非严格
 * deterministic（实测 deepseek-reasoner 同 prompt 5 次 5 种不同输出）。
 * 这一层 cache 在 chatStore 入口做，绕开模型层不稳定性。
 *
 * 回滚方式：将本常量改为 false，恢复无 cache 行为。
 */
const ENABLE_ANSWER_CACHE = true

/** FNV-1a 32bit 内联实现，给 cache key 用 */
function fnvHash32(s: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return Math.abs(hash | 0)
}

/**
 * 生成答案缓存 key（v14.1，B+C 修订）：
 *   `${avatarId}::${conversationId}::${userHash}::${ctxHash}`
 *
 * 设计：
 *   - 加 conversationId（B）：不同 chat 独立 cache，互不干扰
 *   - 剥掉 trailing 同问 Q-A 对（C）：用户立即再问同样问题（"X？" 紧接 "X？"），
 *     UI 上 ctx 已含 [user X, asst Y]，会让 cache key 与首次的 key 不同导致 miss；
 *     先把"最后一对（user 内容等于当前 userContent + 紧跟 assistant）"剥掉，再算 ctx，
 *     这样同 chat 立即重问也能命中
 *   - user content / ctx 各自空格归一化与 [id:mNNNN] 锚点剥离，防止细微差异生成不同 cache 行
 */
function deriveAnswerCacheKey(
  avatarId: string,
  conversationId: string,
  userContent: string,
  recentMessages: Array<{ role: string; content: string }>,
): string {
  const normalizeForCompare = (s: string): string =>
    s.replace(/^\[id:m\d+\]\s*/, '').trim().replace(/\s+/g, ' ')
  const normalizedUser = normalizeForCompare(userContent)

  // 剥掉 trailing 同问 Q-A pair（C）
  let effective = recentMessages
  while (effective.length >= 2) {
    const last = effective[effective.length - 1]
    const secondLast = effective[effective.length - 2]
    if (
      last.role === 'assistant'
      && secondLast.role === 'user'
      && normalizeForCompare(secondLast.content) === normalizedUser
    ) {
      effective = effective.slice(0, -2)
    } else {
      break
    }
  }

  const ctx = effective
    .slice(-8)
    .map((m) => `${m.role}:${m.content.slice(0, 200)}`)
    .join('|')
  const ctxHash = fnvHash32(ctx).toString(16)
  const userHash = fnvHash32(normalizedUser).toString(16)
  return `${avatarId}::${conversationId}::${userHash}::${ctxHash}`
}

/**
 * 基于字符串内容生成稳定 seed（FNV-1a 32bit 简化版）。
 * 同样的 user content 会得到同样的 seed，保证"同问"时 LLM 采样一致；
 * 不同问题得到不同 seed，避免人为强相关。
 */
function deriveSeedFromContent(content: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return Math.abs(hash | 0) % 2_147_483_647 || 1
}

/**
 * 规范化 query_excel 参数生成稳定 cache key。
 * 目的：LLM 每轮现场生成 tool args 时常因空白/键序/columns 顺序不同导致
 *       同语义查询 cache miss，数据若有任何浮动回答就会漂。
 *
 * 归一化原则：只做等价写法归一（键序、columns 顺序、字符串 trim），
 * 不做语义归一（"2026-01" 与 { "": "2026-01" } 仍视为不同 key）。
 *
 * - 对象键按 Unicode 排序，深层递归同样处理
 * - 顶层 columns 数组排序（投影列是集合语义，顺序无关）
 * - 其它数组保持原顺序（如 \/\ 的值列表顺序可能被 LLM 暗含排序语义）
 * - 字符串 trim 两端空白
 */
function normalizeQueryExcelArgs(args: Record<string, unknown>): string {
  const normObj = (v: unknown): unknown => {
    if (v === null || v === undefined) return v
    if (typeof v === 'string') return v.trim()
    if (Array.isArray(v)) return v.map(normObj)
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = normObj((v as Record<string, unknown>)[k])
      }
      return out
    }
    return v
  }
  const norm = normObj(args) as Record<string, unknown>
  if (Array.isArray(norm.columns)) {
    norm.columns = [...norm.columns]
      .map(c => (typeof c === 'string' ? c.trim() : c))
      .sort((a, b) => String(a).localeCompare(String(b)))
  }
  return JSON.stringify(norm)
}

/**
 * 工具结果压缩阈值（字符数）。
 * 当一轮工具调用完成后、进入下一轮 LLM 调用前，
 * 将 apiMessages 中超过此阈值的旧 tool 结果截断为摘要，
 * 防止 query_excel 等工具的大 JSON 累积撑爆 context。
 */
const TOOL_RESULT_COMPRESS_THRESHOLD = 2000

/**
 * 压缩 apiMessages 中已完成轮次的 tool 结果。
 * 只保留最近一轮的 tool 结果原文，更早的 tool 结果截断为摘要。
 * 这样 LLM 仍能看到最新数据，但不会被历史工具返回值撑爆 context。
 */
function compressOldToolResults(messages: LLMMessage[]): void {
  // 从末尾找倒数第 2 个 assistant 位置：保留最近 2 轮工具结果完整，
  // 避免 LLM 因"上一轮刚查的数据被压缩"被诱导重新调用工具
  let assistantsSeen = 0
  let preserveFromIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      assistantsSeen++
      if (assistantsSeen >= 2) {
        preserveFromIdx = i
        break
      }
    }
  }
  // 不足 2 个 assistant 消息（第一轮工具调用前 / 刚结束第一轮）→ 无需压缩
  if (preserveFromIdx <= 0) return

  // 压缩 preserveFromIdx 之前的所有 tool 结果
  for (let i = 0; i < preserveFromIdx; i++) {
    const msg = messages[i]
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > TOOL_RESULT_COMPRESS_THRESHOLD) {
      // 保留前 500 字符作为摘要 + 禁止性截断提示（不再诱导 LLM 重调工具）
      messages[i] = {
        ...msg,
        content: msg.content.slice(0, 500) + `\n\n[... 已压缩，原文 ${msg.content.length} 字符。⚠️ **不要因为这段被压缩就重新调用相同参数的工具** —— 这是你之前已经查询过的数据，结果的要点应该还在你的推理链路和最近轮次回答里。仅当你需要**不同 filter / sheet / file** 的新数据时才调用工具。]`,
      }
    }
  }
}

/** 限制单条工具结果长度，避免超大 payload 拉高后续轮次 TTFT */
function truncateToolResultForContext(toolName: string, content: string): { content: string; truncated: boolean; originalLength: number } {
  const originalLength = content.length
  if (originalLength <= MAX_TOOL_RESULT_CONTEXT_CHARS) {
    return { content, truncated: false, originalLength }
  }
  const clipped = content.slice(0, MAX_TOOL_RESULT_CONTEXT_CHARS)
  const note = `\n\n[系统提示] 工具 ${toolName} 返回内容过长（原始 ${originalLength} 字符），已截断为前 ${MAX_TOOL_RESULT_CONTEXT_CHARS} 字符用于上下文续推。请基于现有结果直接收敛回答，除非用户明确要求新的查询维度。`
  return { content: clipped + note, truncated: true, originalLength }
}

let activeChatRequest: { id: number; conversationId: string } | null = null
let chatRequestSeq = 0
let pendingChunkUpdate: number | null = null
let activeAbortController: AbortController | null = null
/**
 * 切走 → 切回会话时"streaming 回答消失" bug 的修复（2026-05-22）。
 *
 * 旧实现：onChunk 回调里 isViewedConv() === false 就跳过 setState，但闭包里的 assistantText/
 * reasoningText 没暴露出来。用户切回 A 会话时，ChatWindow.loadMessages 从 DB 重新拉消息，
 * DB 里还没有 assistant（流没结束），UI 显示空白；要等下一个 chunk 才能触发 RAF 重刷——
 * 如果模型在 reasoning 段或 chunk 间隔大，等待时间不可控。
 *
 * 新策略：每个 chunk 同步更新本 snapshot（跟 RAF 节流解耦），bindConversation /
 * ChatWindow.loadMessages 完成时调 restoreInflightStreamingMessage 主动回灌。
 * sendMessage 完成时清空 snapshot；同时只允许一个 sendMessage 在跑（isLoading 锁），
 * 所以单值不会并发竞争。
 */
let streamingSnapshot: {
  conversationId: string
  assistantMsgId: string
  text: string
  reasoning: string
  /** sendMessage 发起时刻，切回会话时给计时器校准（避免"思考中 0s"从头开始） */
  startedAt: number
  /** 已采集的工具调用条目（appendToolCallTimeline 同步），切回时回灌到 store + message */
  toolCallTimeline: ToolCallTimelineEntry[]
} | null = null

/** 更新或追加最后一条 assistant 消息（消除 4 处重复代码） */
function upsertLastAssistant(
  messages: ChatMessage[],
  id: string,
  content: string,
  reasoning?: string,
  documentAttachments?: DocumentAttachment[],
  uncertainMarkers?: string[],
  reconsiderMarkers?: string[],
): ChatMessage[] {
  const last = messages.at(-1)
  const lastIsAssistant = last?.role === 'assistant'
  const withoutLast = lastIsAssistant ? messages.slice(0, -1) : messages
  const trimmedReasoning = reasoning?.trim()
  const attachments = documentAttachments && documentAttachments.length > 0 ? documentAttachments : undefined
  // v19：流式期间 appendToolCallTimeline 可能已经把工具调用条目挂到 last 上，
  // 这里 upsert 必须把它沿用过来，否则下一帧渲染会丢失整段时间线。
  const preservedTimeline = lastIsAssistant && last?.toolCallTimeline && last.toolCallTimeline.length > 0
    ? last.toolCallTimeline
    : undefined
  return [...withoutLast, {
    id,
    role: 'assistant',
    content,
    reasoning: trimmedReasoning ? trimmedReasoning : undefined,
    documentAttachments: attachments,
    // v17 deliberation：流式期间 markers 不会变（标记只在最终回复出现），但收尾 setState
    // 时把抽出的 markers 一并塞进 message，让 chip 立刻渲染，不必等下一次 loadMessages。
    uncertainMarkers: uncertainMarkers && uncertainMarkers.length > 0 ? uncertainMarkers : undefined,
    reconsiderMarkers: reconsiderMarkers && reconsiderMarkers.length > 0 ? reconsiderMarkers : undefined,
    toolCallTimeline: preservedTimeline,
  }]
}

/**
 * 工具落盘文件检测：把 export_excel / generate_document 返回的 JSON 解析为
 * DocumentAttachment 推入当前 assistant 消息（决策 B3 统一通路）。
 *
 * 识别条件：
 *   - 返回是合法 JSON
 *   - 含 `success: true`
 *   - 含 `file_path` 且以 `exports/` 开头（双重确认避免误识别）
 *   - 含 `format` 字段（generate_document 必有；export_excel 在 v0.10.0 后也补了）
 *
 * 失败时静默返回 null（不影响主链路）。
 *
 * @author zhi.qu
 * @date 2026-05-08
 */
export function tryExtractDocumentAttachment(
  toolName: string,
  resultText: string,
  fallbackConversationId?: string,
): DocumentAttachment | null {
  try {
    const parsed: unknown = JSON.parse(resultText)
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Record<string, unknown>
    if (obj.success !== true) return null
    const filePath = typeof obj.file_path === 'string' ? obj.file_path : null
    // absolute_path 仅供 logging。FileCard 已改用 (conversationId, filePath)
    // 让主进程自查 workspace exports/，前端不再需要 absolute_path 来开文件。
    // 老 payload 可能完全没这个字段，缺失时降级为空字符串，不再卡掉解析。
    const absolutePath = typeof obj.absolute_path === 'string' ? obj.absolute_path : ''
    // conversation_id 是 2026-05 加上的字段；老 payload 没有，传入 fallback
    // （恢复历史会话时用当前 conversationId）兜底，否则文件卡片会从 UI 消失。
    const conversationId = typeof obj.conversation_id === 'string'
      ? obj.conversation_id
      : (fallbackConversationId ?? null)
    const sizeBytes = typeof obj.file_size_bytes === 'number' ? obj.file_size_bytes : 0
    if (!filePath || !conversationId) return null
    if (!filePath.startsWith('exports/')) return null

    // 推断 format：优先取返回 format 字段，次用文件扩展名，再用 toolName 兜底
    // 顺序原因：file_path 扩展名是数据本身的事实，比 toolName / payload format
    // 字段更可信；toolName 放最后是因为 DB 恢复路径下所有 tool 行都被同一个
    // 占位 name 标记（实际 tool name 没入库），用它兜底容易把 generate_document
    // 的 .pdf 误判成 export_excel 的 .xlsx。
    let format: DocumentAttachmentFormat | null = null
    const SUPPORTED_FORMATS = ['md', 'pdf', 'docx', 'xlsx'] as const
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    if ((SUPPORTED_FORMATS as readonly string[]).includes(ext)) {
      format = ext as DocumentAttachmentFormat
    } else {
      const formatRaw = obj.format
      if (typeof formatRaw === 'string' && (SUPPORTED_FORMATS as readonly string[]).includes(formatRaw)) {
        format = formatRaw as DocumentAttachmentFormat
      } else if (toolName === 'export_excel') {
        format = 'xlsx'
      }
    }
    if (!format) return null

    const filename = filePath.split('/').pop() || filePath
    let sources: DocumentAttachmentSource[] | undefined
    if (Array.isArray(obj.sources)) {
      const collected: DocumentAttachmentSource[] = []
      for (const item of obj.sources) {
        if (item && typeof item === 'object') {
          const src = (item as { source?: unknown }).source
          const page = (item as { page?: unknown }).page
          if (typeof src === 'string' && src.trim()) {
            const entry: DocumentAttachmentSource = { source: src }
            if (typeof page === 'number' && Number.isInteger(page) && page > 0) {
              entry.page = page
            }
            collected.push(entry)
          }
        }
      }
      if (collected.length > 0) sources = collected
    }

    return {
      kind: 'document',
      format,
      filePath,
      absolutePath,
      conversationId,
      sizeBytes,
      filename,
      sources,
    }
  } catch {
    return null
  }
}

/**
 * 把当前 tasks 异步落盘到主进程 DB（Stage 三 P2 范围外 1）。
 *
 * - 未绑定 conversationId 时静默跳过（如新会话尚未 hydrate 完）
 * - tasks 为空时调 clear 而非 save，避免存入 "[]" 占位行
 * - 失败仅 logEvent，绝不抛回 store action
 *
 * 模块级私有函数，不暴露到 store interface。
 */
function persistTasks(conversationId: string | null, tasks: AgentTask[]): void {
  if (!conversationId) return
  try {
    if (tasks.length === 0) {
      void window.electronAPI.clearAgentTasks(conversationId).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        window.electronAPI.logEvent('warn', 'agent-tasks-clear-failed', `${conversationId}: ${msg}`)
      })
    } else {
      const json = JSON.stringify(tasks)
      void window.electronAPI.saveAgentTasks(conversationId, json).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        window.electronAPI.logEvent('warn', 'agent-tasks-save-failed', `${conversationId}: ${msg}`)
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[chatStore] persistTasks 异常（已忽略）:', msg)
  }
}

/**
 * 端侧（本地）模型默认配置——指向 Ollama 默认端点 + qwen2.5:7b。
 *
 * 用户启动 Ollama（`ollama serve`）并拉过 qwen2.5:7b 后开箱可用；
 * 没装会在切换到 'local' 后首次发送时失败，UI 引导去设置面板配置。
 */
export const DEFAULT_LOCAL_CHAT_MODEL: ModelConfig = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5:7b',
  apiKey: 'ollama',
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  isLoading: false,
  systemPrompt: '',
  chatModel: DEFAULT_CHAT_MODEL,
  localChatModel: DEFAULT_LOCAL_CHAT_MODEL,
  chatModelMode: 'cloud',
  toolCallStatus: '',
  skillProposals: [],
  collapsedMessageIds: new Set<string>(),
  tasks: [],
  toolCallTimeline: [],
  currentConversationId: null,
  mode: 'agent',

  setMode: (mode) => {
    const prev = get().mode
    if (prev === mode) return
    set({ mode })
    const cid = get().currentConversationId
    if (cid) {
      pushConversationToolModeToMain(cid, mode)
      // v17 事件日志：模式真实切换才会到这里（同档已在上面 return），无需再判等
      void window.electronAPI.recordModeSwitchEvent(cid, prev, mode)
    }
  },

  setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),

  setChatModel: (config) => set({ chatModel: config }),

  setLocalChatModel: (config) => set({ localChatModel: config }),

  setChatModelMode: (mode) => set({ chatModelMode: mode }),

  conversationModelOverrides: {},

  setConversationModel: (conversationId, model) => set(state => {
    const prev = state.conversationModelOverrides[conversationId] ?? null
    const next = { ...state.conversationModelOverrides }
    if (model === null) delete next[conversationId]
    else next[conversationId] = model
    // v17 事件日志：只在实际变化时记录——用户重复点回到同一档不刷事件
    if (prev !== model) {
      void window.electronAPI.recordModelSwitchEvent(conversationId, prev, model)
    }
    return { conversationModelOverrides: next }
  }),

  setMessages: (messages) => set({ messages }),

  restoreInflightStreamingMessage: (conversationId) => {
    const snap = streamingSnapshot
    if (!snap || snap.conversationId !== conversationId) return null
    // 把 snapshot 当前的 text/reasoning 拼到 messages 末尾（占位 assistantMsgId 复用，
    // 之后的 chunk RAF 刷新会继续基于同一个 id 做 upsert，不会重复气泡）。
    // 同时把已采集的 toolCallTimeline 挂到当前 assistant message + 同步进全局 timeline state。
    set((state) => {
      const baseMessages = upsertLastAssistant(state.messages, snap.assistantMsgId, snap.text, snap.reasoning)
      // 把 timeline 同时挂到目标 message（v19 行为）+ 全局 timeline state（向后兼容 + 流式 transient 视图）
      const messagesWithTimeline = snap.toolCallTimeline.length > 0
        ? baseMessages.map(m => m.id === snap.assistantMsgId ? { ...m, toolCallTimeline: snap.toolCallTimeline } : m)
        : baseMessages
      return {
        messages: messagesWithTimeline,
        isLoading: true,
        toolCallTimeline: snap.toolCallTimeline,
      }
    })
    return { startedAt: snap.startedAt }
  },

  clearSkillProposals: () => set({ skillProposals: [] }),

  toggleMessageCollapsed: (id) => set((state) => {
    const next = new Set(state.collapsedMessageIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { collapsedMessageIds: next }
  }),

  bindConversation: async (conversationId) => {
    set({ currentConversationId: conversationId })
    pushConversationToolModeToMain(conversationId, get().mode)
    try {
      const json = await window.electronAPI.getAgentTasks(conversationId)
      // 二次校验：会话切换很快时可能在 await 期间又切走，避免覆盖新会话的任务
      if (get().currentConversationId !== conversationId) return
      if (!json) {
        set({ tasks: [] })
        return
      }
      const parsed = JSON.parse(json)
      if (!Array.isArray(parsed)) {
        console.warn('[chatStore] bindConversation: tasks JSON 不是数组，已重置为空')
        set({ tasks: [] })
        return
      }
      // 严格校验每一项，剔除非法记录避免 UI 渲染崩溃
      const valid: AgentTask[] = []
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const r = item as Record<string, unknown>
        const id = typeof r.id === 'string' ? r.id : ''
        const content = typeof r.content === 'string' ? r.content : ''
        const status = r.status
        const isValidStatus = status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'cancelled'
        if (id && content && isValidStatus) {
          const t: AgentTask = { id, content, status }
          if (Array.isArray(r.toolCalls)) {
            t.toolCalls = (r.toolCalls as unknown[])
              .filter((c) => c && typeof c === 'object')
              .map((c) => c as AgentTaskToolCall)
              .filter((c) => typeof c.id === 'string' && typeof c.name === 'string')
          }
          valid.push(t)
        }
      }
      set({ tasks: valid })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[chatStore] bindConversation: 加载任务失败:', msg)
      window.electronAPI.logEvent('warn', 'agent-tasks-load-failed', `${conversationId}: ${msg}`)
      set({ tasks: [] })
    }
  },

  setTasks: (tasks) => {
    set({ tasks })
    persistTasks(get().currentConversationId, tasks)
  },

  mergeTasks: (patch) => {
    // 计算合并结果（不放进 set 回调内是为了拿到 next 的引用做持久化）
    const state = get()
    const indexById = new Map(state.tasks.map((t, idx) => [t.id, idx]))
    const next = state.tasks.slice()
    for (const p of patch) {
      const existingIdx = indexById.get(p.id)
      if (existingIdx !== undefined) {
        next[existingIdx] = { ...next[existingIdx], ...p }
      } else {
        next.push(p)
      }
    }
    set({ tasks: next })
    persistTasks(state.currentConversationId, next)
  },

  clearTasks: () => {
    set({ tasks: [] })
    persistTasks(get().currentConversationId, [])
  },

  appendToolCallTimeline: (entry, target) => {
    set((s) => {
      // v19：时间线挂到当前 assistant 消息上，让切对话/重启后能从 DB 恢复。
      // 全局 toolCallTimeline 仍维护（向后兼容暂未读它的代码 + 流式期间的 transient 视图），
      // UI 侧已经改用 message.toolCallTimeline，全局后续可下线。
      //
      // 2026-05-24 隔离修复（target 路径）：
      //   - 仅当当前视图就是 target 会话时，才更新 messages + 全局 timeline；
      //     用户切到 B 时，A 的工具调用不污染 B 的最后一条 assistant，也不污染 B 的顶部时间线
      //   - 精确按 assistantMsgId 定位，不再用"最后一条 assistant"启发式
      if (target) {
        if (s.currentConversationId !== target.conversationId) {
          return {}
        }
        const targetIdx = s.messages.findIndex(
          (m) => m.id === target.assistantMsgId && m.role === 'assistant',
        )
        if (targetIdx < 0) {
          // 视图匹配但目标 message 已不在 messages（用户清了会话/重新生成覆盖）——
          // 仍写全局 timeline（顶部滚动展示），不动 messages。
          return { toolCallTimeline: [...s.toolCallTimeline, entry] }
        }
        const updatedMessages = [...s.messages]
        updatedMessages[targetIdx] = {
          ...updatedMessages[targetIdx],
          toolCallTimeline: [...(updatedMessages[targetIdx].toolCallTimeline ?? []), entry],
        }
        return {
          messages: updatedMessages,
          toolCallTimeline: [...s.toolCallTimeline, entry],
        }
      }
      // 未传 target：旧版本会回退到"最后一条 assistant"启发式，但这会让同一分身
      // 下的 late RAG/skill progress 污染当前会话的最后一条 assistant（rag-progress
      // 事件目前不带 conversationId，ChatWindow 只按 avatarId 过滤，跨会话窜入）。
      // 修复策略：仅写全局 transient timeline（顶部视图，切换会话会清），完全不动
      // messages。任何想真正挂到具体 message 的调用方必须显式传 target。
      // 未来 rag-progress 协议加 conversationId 后，可同步给 ChatWindow 派传 target。
      return { toolCallTimeline: [...s.toolCallTimeline, entry] }
    })
    // 同步进 streaming snapshot：传 target 时校验 snapshot 是同一请求的，避免误写到
    // 另一请求的 snapshot；不传 target 则维持旧的"全局唯一 snapshot"写入。
    if (
      streamingSnapshot
      && (
        !target
        || (streamingSnapshot.conversationId === target.conversationId
          && streamingSnapshot.assistantMsgId === target.assistantMsgId)
      )
    ) {
      streamingSnapshot.toolCallTimeline = [...streamingSnapshot.toolCallTimeline, entry]
    }
  },

  clearToolCallTimeline: () => set({ toolCallTimeline: [] }),

  attachToolCallToTask: (toolCall) => {
    const state = get()
    if (state.tasks.length === 0) return
    const inProgressIndices: number[] = []
    let lastActiveIdx = -1
    for (let i = 0; i < state.tasks.length; i++) {
      const t = state.tasks[i]
      if (t.status === 'in_progress') inProgressIndices.push(i)
      if (t.status !== 'cancelled' && t.status !== 'completed') lastActiveIdx = i
    }
    let targetIdx: number
    if (inProgressIndices.length === 1) {
      targetIdx = inProgressIndices[0]
    } else if (lastActiveIdx >= 0) {
      targetIdx = lastActiveIdx
    } else {
      return
    }
    const target = state.tasks[targetIdx]
    const existing = target.toolCalls ?? []
    if (existing.some((c) => c.id === toolCall.id)) return
    const next = state.tasks.slice()
    next[targetIdx] = {
      ...target,
      toolCalls: [...existing, toolCall],
    }
    set({ tasks: next })
    persistTasks(state.currentConversationId, next)
  },

  resetTransientState: () => {
    // 注意：切换会话不再 abort 后台流式请求。
    // 旧实现 abort() 会让 A 的流被中断且 assistantText 留在闭包里没人接 → saveMessage 永远
    // 不跑 → 切回 A 时看不到答复（用户报"回答消失"）。新策略：让流继续跑完并落 DB，UI 层在
    // sendMessage 内部按 currentConversationId === conversationId 决定是否实时回灌。
    // 显式 abort 由两个路径负责：① sendMessage 入口处用户发新消息时（line ~2296）；
    // ② 未来若加显式"停止"按钮时单独路径。视图切换不应该误杀流。
    set({ isLoading: false, toolCallStatus: '', skillProposals: [], tasks: [], toolCallTimeline: [] })
  },

  sendMessage: async (
    content: string,
    conversationId: string,
    avatarId: string,
    images?: string[],
    visionModel?: ModelConfig,
    attachments?: AttachmentRef[],
    inlineFiles?: Array<{ name: string; ext: string; mime: string; text: string }>,
    proxyOpts?: SendMessageProxyOptions,
    options?: { skipCache?: boolean; skipInfographicRevalidate?: boolean; hiddenRepair?: boolean },
  ) => {
    const invokeProxyComplete = async (
      r: { ok: true; assistantText: string } | { ok: false; error: string },
    ): Promise<void> => {
      if (proxyOpts?.onProxyComplete) await proxyOpts.onProxyComplete(r)
    }
    const writeProxyStreamDelta = (textChunk: string): void => {
      if (!proxyOpts?.proxyJobId || !proxyOpts.proxyStream || !textChunk) return
      const line = formatSseEvent('content_block_delta', textDeltaJson(textChunk))
      void window.electronAPI.soulProxyApiSseWrite(proxyOpts.proxyJobId, line)
    }

    // hiddenRepair（infographic 修正轮）必须对用户完全不可见：
    //   - 不受 outer call 的 isLoading 锁阻断（outer 还在跑时 repair 也能起）
    //   - 不 set isLoading=true（避免 UI 转圈 / 输入禁用）
    //   - 不清 toolCallTimeline（outer 的工具时间线对用户仍可见）
    // 配合 line ~3076 的 isHiddenRepair 后续守卫，整轮对 isLoading / 视图 transient 状态零影响。
    const _hiddenRepairEarly = options?.hiddenRepair === true
    if (get().isLoading && !_hiddenRepairEarly) {
      await invokeProxyComplete({ ok: false, error: 'Soul 正有一条对话进行中（isLoading）' })
      return
    }
    // 每次新提问都清空上一轮的工具调用时间线，保证 UI 顶部只展示本轮（hiddenRepair 跳过）
    if (!_hiddenRepairEarly) {
      set({ isLoading: true, toolCallTimeline: [] })
    }
    const requestId = ++chatRequestSeq
    const requestStartedAt = Date.now()
    // 提前生成 assistantMsgId：在 user 消息插入时同步塞入空 assistant 占位气泡，
    // 让用户立刻看到分身气泡 + "思考中... · Xs"，不再等首个 chunk 才创建。
    // 后续所有早期返回路径（cache 命中 / 错误）都用 upsertLastAssistant(assistantMsgId)
    // 替换这个占位，避免出现两条 assistant。
    const assistantMsgId = nextMessageId()
    const perfTag = `[chat-perf][conv:${conversationId}][req:${requestId}]`
    const logPerf = (event: string, extra?: string): void => {
      const elapsed = Date.now() - requestStartedAt
      const suffix = extra ? ` ${extra}` : ''
      // eslint-disable-next-line no-console -- 本地性能诊断日志，便于定位对话链路慢点
      console.log(`${perfTag} ${event} (+${elapsed}ms)${suffix}`)
    }
    /** #7：Proxy/API 同源 sendMessage，工具走主进程时需标 trustTier 以便拦截灰名单 */
    const toolInvocationMeta =
      proxyOpts?.proxyJobId !== undefined ? ({ trustTier: 'proxy' as const }) : undefined

    logPerf('sendMessage:start', `avatar=${avatarId} contentLen=${content.length} hasImages=${Boolean(images && images.length > 0)}`)
    // Phase 0.5 埋点：跟踪 agentic-only 切换后 LLM 实际是否调用 search_knowledge
    let phase05SearchKnowledgeCalls = 0
    let phase05SearchKnowledgeResultLen = 0
    let phase05FirstTokenAt = 0
    // hidden repair 不污染 telemetry —— 与下游 safeEmit 守卫等价（这里 safeEmit
    // 尚未定义，先用 _hiddenRepairEarly 直接守）
    if (!_hiddenRepairEarly) {
      regressionTelemetry.emit({
        type: 'conversation-started',
        conversationId,
        timestamp: requestStartedAt,
        prompt: content,
      })
    }
    // hiddenRepair 完全隔离全局 request 状态：
    //   - 不写 activeChatRequest（不让 cleanupRequest/isStale 把 outer 的 request 误判成 stale）
    //   - 不 abort 旧的 activeAbortController（outer 还在跑，repair 是 fire-and-forget 启动）
    //   - 不写 activeAbortController（用户下一条新消息进来时不该取消 repair；同样地，
    //     repair 自己拿到的 abortController 也只是 local 给 fetch signal 用）
    const abortController = new AbortController()
    if (!_hiddenRepairEarly) {
      activeChatRequest = { id: requestId, conversationId }
      if (activeAbortController) activeAbortController.abort()
      activeAbortController = abortController
    }
    // 2026-05-24：hiddenRepair 模式（infographic validator 触发的格式修正轮）
    // 所有面向用户的副作用全部禁掉——见接口处 hiddenRepair 注释。
    const isHiddenRepair = options?.hiddenRepair === true
    // hidden repair 不进 regressionTelemetry：批量回归/eval 用 TelemetryCollector
    // 按 conversationId 收集事件，而 hidden repair 是 fire-and-forget 跑在同一
    // conversationId 上的修正轮，eval 跑题 + waitForIdle 时其 message-done /
    // usage / tool-call 会被采进同一 case，污染 score / cost 统计。本 wrap 把
    // hidden repair 跑出的 emit 全部 no-op；非 hidden repair 维持原 emit。
    const safeEmit: typeof regressionTelemetry.emit = (event) => {
      if (isHiddenRepair) return
      regressionTelemetry.emit(event)
    }
    // 切走→切回 streaming 回灌的 snapshot，每个 chunk 同步更新（见模块顶部说明）。
    // hiddenRepair 模式不创建——避免用户切走再切回时被 hidden 内容（修正 prompt 的
    // LLM 回复）回灌覆盖到 UI。
    if (!isHiddenRepair) {
      streamingSnapshot = {
        conversationId,
        assistantMsgId,
        text: '',
        reasoning: '',
        startedAt: requestStartedAt,
        toolCallTimeline: [],
      }
    }
    // hidden repair 不写 activeChatRequest（见 line ~3078 守卫），所以全局
    // request 永远不会指向它，原 isStale 会永真 → chunk 回调 / 4151 / 4916
    // 三处早退点全部命中 → displayText 累积为空 → repairResult.displayText
    // 拿不到内容 → 坏 infographic 不被回写。修：hidden repair 只看本地
    // abort signal；它是 outer 完成后 fire-and-forget 启动的独立任务，唯一
    // 该被 stale 的场景是自身 abortController 被显式取消（目前没人取消它）。
    const _isHiddenRepairForStale = options?.hiddenRepair === true
    const isStale = () => {
      if (_isHiddenRepairForStale) return abortController.signal.aborted
      return !activeChatRequest
        || activeChatRequest.id !== requestId
        || activeChatRequest.conversationId !== conversationId
    }

    /**
     * 早退 / 完成时统一清理本请求挂在模块级单例上的状态。
     *
     * 必要性（2026-05-24）：
     *   - API key 缺失、saveMessage user 失败、答案 cache 命中等早退路径，原先
     *     直接 `return` 不清 streamingSnapshot / activeChatRequest，导致：
     *     ① 切回该会话时 restoreInflightStreamingMessage 用空 snapshot 覆盖已落盘的真答案
     *     ② 下次 sendMessage 的 isStale 判定会被错误的 activeChatRequest 干扰
     *
     * 自检：用 requestId / abortController / assistantMsgId 三重锚定，
     * 后续请求若已接管这些状态，本函数变成 no-op，绝不误清；多次调用幂等。
     *
     * isLoading 兜底：成功/错误路径只在 isViewedConv() 时 set isLoading=false，
     * 切走视图时会卡 true；本函数确认是"自然终结"后兜底清掉，避免切回仍转圈。
     */
    const cleanupRequest = (): void => {
      const isOwn = activeChatRequest?.id === requestId
      if (isOwn) {
        activeChatRequest = null
        if (get().isLoading) {
          set({ isLoading: false, toolCallStatus: '' })
        }
      }
      if (activeAbortController === abortController) activeAbortController = null
      if (
        streamingSnapshot?.conversationId === conversationId
        && streamingSnapshot?.assistantMsgId === assistantMsgId
      ) {
        streamingSnapshot = null
      }
    }

    // 用户当前是否还在看本次 sendMessage 所属的会话。切走时流式继续在闭包里累积
    // assistantText / reasoningText，但不实时 setState（否则会污染当前正在看的别的会话的消息列表）。
    // 切回来时下一帧 upsertLastAssistant 用累积后的全文一次性回灌；流式完成时 saveMessage 落 DB
    // 与是否在视图无关，保证答复永不丢失。
    const isViewedConv = (): boolean => get().currentConversationId === conversationId

    const { messages, systemPrompt, chatModel: cloudChatModel, localChatModel, chatModelMode } = get()
    // 端云 / 端侧切换（2026-05-22 Marvis 借鉴）：active master slot 由 mode 决定。
    // 视觉路径不走 mode 切换——vision 任务依赖云端模型，本地多数 7B 不支持图像输入。
    const chatModel = chatModelMode === 'local' ? localChatModel : cloudChatModel

    // GAP9b: 有图片时使用视觉模型
    const activeModel = (images && images.length > 0 && visionModel?.apiKey) ? visionModel : chatModel

    if (!activeModel.apiKey) {
      const errorMsg = chatModelMode === 'local'
        ? '端侧模型未配置 API Key（Ollama 默认为 "ollama"，本地 vllm 等可填任意非空字符串）。请在设置 → 端侧（本地）填写。'
        : '请先在设置中配置 API Key'
      set({
        messages: [...messages, { id: nextMessageId(), role: 'user', content }, { id: nextMessageId(), role: 'assistant', content: errorMsg }],
        isLoading: false,
      })
      await window.electronAPI.saveMessage(conversationId, 'user', content)
      await window.electronAPI.saveMessage(conversationId, 'assistant', errorMsg)
      await invokeProxyComplete({ ok: false, error: errorMsg })
      cleanupRequest()
      return
    }

    // 多分身 @提及：检测 @分身ID，并发拉取所有目标分身 soul.md 前缀，追加到 system prompt
    let effectiveSystemPrompt = systemPrompt
    const atMentions = [...new Set([...content.matchAll(/@([\w-]+)/g)].map(m => m[1]).filter(id => id !== avatarId))]
    if (atMentions.length > 0) {
      const introResults = await Promise.allSettled(
        atMentions.map(id => window.electronAPI.getAvatarSoulIntro(id).then(intro => ({ id, intro })))
      )
      const intros = introResults
        .filter(r => r.status === 'fulfilled' && r.value.intro)
        .map(r => {
          const { id, intro } = (r as PromiseFulfilledResult<{ id: string; intro: string | null }>).value
          return `[协作分身 @${id} 的身份简介]\n${intro}`
        })
      if (intros.length > 0) {
        effectiveSystemPrompt = `${systemPrompt}\n\n---\n${intros.join('\n\n')}\n---`
      }
    }

    // 对话框附件扩展（2026-05-01）：检测当前/近期消息是否含 <attachment> 元信息标签，
    // 仅在确实有附件时才注入「附件使用指南」。避免普通对话浪费 system prompt token。
    const recentHasAttachmentTag = messages
      .slice(-5)
      .some(m => m.role === 'user' && /<attachment\s+id="att_[\w-]+"/.test(m.content))
    const currentHasAttachment = Boolean(attachments && attachments.length > 0)
    if (recentHasAttachmentTag || currentHasAttachment) {
      const attachmentGuide = [
        '【对话附件使用指南】',
        '当用户消息中含 <attachment id="att_xxx" name="..." mime="..." size="..." outline="..." summary="..." /> 标签时，按以下原则处理：',
        '1. 标签里的 outline 和 summary 已经是模型预读的元信息，先看它们判断是否需要详读；',
        '2. 若 outline + summary 已能回答用户问题，可直接作答，不必调用工具；',
        '3. 需要详读时调用 read_attachment(id, char_range 或 page_range)，**不要猜路径用 read_pdf/read_docx**（这些工具是给 workspace 文件的）；',
        '4. 大文档分段读取：默认前 16000 字，再用 char_range:[16000, 32000] 续读；PDF 也可用 page_range:[1, 3]；',
        '5. 关键词定位用 search_attachment(id, keyword)，比通读快；',
        '6. 不要在回答里编造没读过的内容。读过哪一段，就答哪一段，并在回复里告知用户读取了哪些片段。',
      ].join('\n')
      effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n---\n${attachmentGuide}\n---`
    }

    // L3 Phase I：给用户消息打 mNNNN 锚点，便于后续 snip 工具按 ID 范围裁剪
    let messageAnchor = ''
    try {
      messageAnchor = await window.electronAPI.snipNextMsgId(conversationId)
    } catch (anchorErr) {
      void anchorErr
    }
    // synthetic @ 引用 snapshot：MessageInput 把 @knowledge/foo 解析后塞到
    // inlineFiles 里走 LLM，之前 inlineFiles 完全不入库——纯引用发送时用户气泡
    // 空、刷新 / 重新生成 / 下一轮追问都不知道当时引用了什么。
    //
    // 上一轮先做了元数据 footer（只存引用名）止血，本轮升级到完整 snapshot：
    //   - 把 inline fence block（与 LLM 看到的同一份）拼到 taggedContent
    //   - 用户气泡能看到当时引用的正文（markdown 代码块原生折叠）
    //   - regenerate 时 rawContent 已含 snapshot，下一轮 LLM 历史里能完整复现
    //     模型当时看到的引用内容；inlineFiles 参数为 undefined 时不重复拼接
    //   - cache-key 派生函数会 strip [id:m\d+] 前缀，保留 fence 文本——同问 +
    //     不同引用 = 不同 cache，是正确行为
    //
    // 代价：user bubble 体积增大。引用变化（同名文件内容更新）时下一次会重新
    // 拼最新内容；老历史里仍是当时 snapshot——这是 snapshot 持久化的固有取舍。
    const hasInlineRefs = inlineFiles && inlineFiles.length > 0
    const inlineSnapshotBlock = hasInlineRefs
      ? inlineFiles!.map(f => {
        const lang = (f.ext || '').replace(/^\./, '').toLowerCase() || 'text'
        return `【附件正文 · ${f.name}】\n\`\`\`${lang}\n${f.text}\n\`\`\``
      }).join('\n\n')
      : ''
    const baseAnchor = messageAnchor ? `[id:${messageAnchor}] ` : ''
    const trimmedContent = content.trim()
    let taggedContent: string
    if (inlineSnapshotBlock && !trimmedContent) {
      taggedContent = `${baseAnchor}${inlineSnapshotBlock}`
    } else if (inlineSnapshotBlock) {
      taggedContent = `${baseAnchor}${content}\n\n${inlineSnapshotBlock}`
    } else {
      taggedContent = `${baseAnchor}${content}`
    }

    const userMessage: ChatMessage = {
      id: nextMessageId(),
      role: 'user',
      content: taggedContent,
      imageUrls: images && images.length > 0 ? images : undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    }
    // 本对话发送前的消息数（含 system 等），用于触发首条消息自动改名
    const _messageCountBeforeUserSend = messages.length
    // user 消息 + 空 assistant 占位同帧插入：用户提问后立刻看到分身气泡 +
    // 时间线里的"思考中... · Xs"，避免 cache/RAG/TTFT 期间界面像卡死。
    // 占位会被后续 cache 命中、流式 chunk、或错误路径通过 upsertLastAssistant 替换。
    // hiddenRepair 模式跳过——不入 UI，不入 DB，对用户完全不可见。
    const assistantPlaceholder: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
    }
    if (!isHiddenRepair) {
      set({ messages: [...messages, userMessage, assistantPlaceholder] })
    }
    let savedUserMessageId: string | null = null
    if (!isHiddenRepair) {
      try {
        savedUserMessageId = await window.electronAPI.saveMessage(conversationId, 'user', taggedContent, undefined, images)
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        window.electronAPI.logEvent('error', 'save-user-message-error', errMsg)
        set((state) => ({
          messages: upsertLastAssistant(state.messages, assistantMsgId, `抱歉，保存消息失败：${errMsg}`),
          isLoading: false,
          toolCallStatus: '',
        }))
        await invokeProxyComplete({ ok: false, error: `保存用户消息失败：${errMsg}` })
        cleanupRequest()
        return
      }
    }

    // 自动改名：本对话第一条用户消息发出时，把"新对话"标题改成内容片段，
    // 否则侧栏所有会话都叫"新对话"，无法区分（2026-05-21 用户反馈）。
    // 触发条件：sendMessage 进入前 messages 为空（即这是该会话首条用户消息）。
    // 失败仅记日志，不阻塞主对话流程。
    // hiddenRepair 模式跳过——修正 prompt 不应当作"首条消息"被拿来当标题。
    if (_messageCountBeforeUserSend === 0 && !isHiddenRepair) {
      const stripped = content.trim().replace(/\s+/g, ' ')
      if (stripped.length > 0) {
        const snippet = stripped.slice(0, 20)
        const newTitle = snippet.length < stripped.length ? `${snippet}…` : snippet
        try {
          await window.electronAPI.updateConversationTitle(conversationId, newTitle)
          // chatStore 无 App.tsx 引用，用 window 自定义事件通知侧栏刷新
          window.dispatchEvent(
            new CustomEvent('conversation-title-changed', {
              detail: { conversationId, title: newTitle },
            }),
          )
          window.electronAPI.logEvent(
            'info',
            'conversation-auto-titled',
            `id=${conversationId} title=${newTitle.replace(/\n/g, ' ')}`,
          )
        } catch (renameErr) {
          window.electronAPI.logEvent(
            'warn',
            'conversation-auto-title-failed',
            renameErr instanceof Error ? renameErr.message : String(renameErr),
          )
        }
      }
    }

    // 对话框附件扩展（2026-05-01）：把刚上传的附件回填到 user 消息上，
    // 让 ChatWindow 重开会话时能通过 message_id 关联恢复 chip。
    // linkAttachmentToMessage 仅更新 message_id 仍为 null 的行（幂等）。
    if (savedUserMessageId && attachments && attachments.length > 0) {
      try {
        await window.electronAPI.linkAttachmentToMessage(
          savedUserMessageId,
          attachments.map(a => a.id),
          conversationId,
        )
      } catch (linkErr) {
        // 关联失败不阻塞主对话；记日志便于排查
        const linkMsg = linkErr instanceof Error ? linkErr.message : String(linkErr)
        window.electronAPI.logEvent('warn', 'link-attachment-to-message-error', linkMsg)
      }
    }

    // ─── 答案缓存命中检查（v14，同问不同答修复）────────────────────────────
    // 同 avatarId + 同上下文 + 同 user content → 复用上次答案，跳过 LLM。
    // images / attachments / inlineFiles 场景跳过 cache（这些消息每次内容必变）。
    const cacheBypassed =
      options?.skipCache === true ||
      !ENABLE_ANSWER_CACHE ||
      (images && images.length > 0) ||
      (attachments && attachments.length > 0) ||
      (inlineFiles && inlineFiles.length > 0) ||
      proxyOpts?.proxyJobId !== undefined
    if (!cacheBypassed) {
      try {
        const cacheKey = deriveAnswerCacheKey(avatarId, conversationId, content, messages)
        const cached = await window.electronAPI.getCachedAnswer(cacheKey)
        if (cached) {
          logPerf('answer-cache:hit', `key=${cacheKey.slice(0, 32)}... len=${cached.assistantContent.length}`)
          set((state) => ({
            messages: upsertLastAssistant(
              state.messages,
              assistantMsgId,
              cached.assistantContent,
              cached.reasoningContent ?? undefined,
            ),
            isLoading: false,
            toolCallStatus: '',
          }))
          try {
            await window.electronAPI.saveMessage(
              conversationId,
              'assistant',
              cached.assistantContent,
              undefined,
              undefined,
              cached.reasoningContent ?? undefined,
            )
          } catch (saveErr) {
            const m = saveErr instanceof Error ? saveErr.message : String(saveErr)
            window.electronAPI.logEvent('warn', 'answer-cache-save-message-error', m)
          }
          logPerf('sendMessage:success', `total=${Date.now() - requestStartedAt}ms via-cache displayLen=${cached.assistantContent.length}`)
          await invokeProxyComplete({ ok: true, assistantText: cached.assistantContent })
          cleanupRequest()
          return
        }
      } catch (cacheErr) {
        // cache 读取失败不阻断主流程，降级到正常 LLM 路径
        const m = cacheErr instanceof Error ? cacheErr.message : String(cacheErr)
        window.electronAPI.logEvent('warn', 'answer-cache-get-error', m)
      }
    }

    // 图表答案 cache 早命中：在 RAG / LLM 调用前查一次 cache；
    // 命中 → 直接返回缓存的 assistant markdown（含 ```chart 块），跳过整个 LLM 循环。
    // 仅在 chartConsistencyMode 命中（图表 + 时间范围关键词）且无图片时启用。
    if (
      shouldEnableChartConsistencyMode(content, Boolean(images && images.length > 0))
      && content.trim().length > 0
    ) {
      try {
        const chartQueryHash = hashQueryContent(content)
        const cacheResult = await window.electronAPI.getChartCacheHit(avatarId, chartQueryHash)
        if (cacheResult.hit) {
          logPerf('chart-cache:hit', `queryHash=${chartQueryHash} age=${Date.now() - cacheResult.createdAt}ms`)
          if (isStale()) {
            await invokeProxyComplete({ ok: false, error: '请求已过期或已取消' })
            return
          }
          set((state) => ({
            messages: upsertLastAssistant(state.messages, assistantMsgId, cacheResult.assistantContent),
            isLoading: false,
            toolCallStatus: '',
          }))
          await window.electronAPI.saveMessage(conversationId, 'assistant', cacheResult.assistantContent)
          // 早返路径统一走 cleanupRequest（含 snapshot / activeChatRequest / abortController），
          // 避免切回会话时被空 snapshot 覆盖 cache 答案。
          cleanupRequest()
          if (proxyOpts?.proxyStream) {
            writeProxyStreamDelta(cacheResult.assistantContent)
          }
          await invokeProxyComplete({ ok: true, assistantText: cacheResult.assistantContent })
          return
        }
        logPerf('chart-cache:miss', `queryHash=${chartQueryHash}`)
      } catch (cacheErr) {
        // cache 查询失败绝不影响正常对话，静默降级
        void cacheErr
      }
    }

    // Phase 1 (2026-05-13) agentic-only：删除 pre-message RAG 注入。
    // 知识检索现在完全由 LLM 通过 search_knowledge tool 决定何时调用。
    // 寒暄/确认消息（包括"好的"/"谢谢"）不再触发 BM25 检索，由 LLM 看上下文自己判断不 call。
    // 下游 ragEnhanced 永远为 false → shouldUseRagDirectAnswerFastPath 永远不命中（符合预期：
    // 没有 pre-injected chunks，LLM 必须走 tool 路径取知识）。
    const enhancedContent = content
    const ragEnhanced = false

    // 对话框附件扩展（2026-05-01）：构造附件相关的额外文本块。
    //   - 大文档：注入 <attachment id name pages outline summary /> 元信息（XML 标签便于解析）
    //   - 小文本（inline）：以 fenced code block 直接拼到正文
    // 大文档块靠 system prompt 里的「附件使用指南」引导模型按需调 read_attachment 工具。
    let attachmentBlock = ''
    if (attachments && attachments.length > 0) {
      const lines: string[] = ['', '<attachments>']
      for (const att of attachments) {
        const escName = att.name.replace(/"/g, '&quot;')
        // outline 较长时只取前 12 行；summary 截断到 240 字
        const outlineSnippet = (att.outline || '')
          .split('\n')
          .slice(0, 12)
          .map(s => s.trim())
          .filter(Boolean)
          .join(' / ')
        const summarySnippet = (att.summary || '').replace(/\s+/g, ' ').slice(0, 240)
        const sizeKb = Math.max(1, Math.round(att.size / 1024))
        const attrs = [
          `id="${att.id}"`,
          `name="${escName}"`,
          `mime="${att.mime}"`,
          `size_kb="${sizeKb}"`,
          outlineSnippet ? `outline="${outlineSnippet.replace(/"/g, '&quot;')}"` : '',
          summarySnippet ? `summary="${summarySnippet.replace(/"/g, '&quot;')}"` : '',
        ].filter(Boolean).join(' ')
        lines.push(`  <attachment ${attrs} />`)
      }
      lines.push('</attachments>')
      attachmentBlock += lines.join('\n')
    }
    if (inlineFiles && inlineFiles.length > 0) {
      const fenceLines: string[] = []
      for (const f of inlineFiles) {
        const lang = (f.ext || '').replace(/^\./, '').toLowerCase() || 'text'
        fenceLines.push('')
        fenceLines.push(`【附件正文 · ${f.name}】`)
        fenceLines.push('```' + lang)
        fenceLines.push(f.text)
        fenceLines.push('```')
      }
      attachmentBlock += fenceLines.join('\n')
    }
    // 把附件块拼到 enhancedContent 末尾（不要在前面，否则 RAG 已注入的指令会被推后）
    const contentWithAttachments = attachmentBlock ? `${enhancedContent}\n${attachmentBlock}` : enhancedContent

    // 构建用户消息内容（纯文字 or 多模态）
    const userContent: LLMMessage['content'] = (images && images.length > 0)
      ? [
          ...images.map(url => ({ type: 'image_url' as const, image_url: { url } })),
          { type: 'text' as const, text: (contentWithAttachments || content || '请描述图片内容') },
        ]
      : contentWithAttachments

    const shouldForceChartSkill = shouldForceChartSkillFirst(content, Boolean(images && images.length > 0))
    const chartConsistencyMode = shouldEnableChartConsistencyMode(content, Boolean(images && images.length > 0))
    if (shouldForceChartSkill && !chartConsistencyMode) {
      logPerf('chart-skill:force-only')
    }
    if (chartConsistencyMode) {
      logPerf('chart-consistency:enabled')
    }

    // 确定性模式：基于 user content 派生稳定 seed，所有轮次共用，提升"同问同答"概率。
    // 仅当 ENABLE_DETERMINISTIC_MODE 为 true 时生效；不启用时 deterministicSeed 为 undefined，行为不变。
    const deterministicSeed = ENABLE_DETERMINISTIC_MODE && typeof content === 'string' && content.length > 0
      ? deriveSeedFromContent(content)
      : undefined
    if (deterministicSeed !== undefined) {
      logPerf('deterministic:enabled', `seed=${deterministicSeed}`)
    }

    // Feature 2: 周期性记忆 Nudge（每 N 轮提醒 AI 是否有内容需要记忆）
    // 合并到 user 内容末尾，避免在 user 消息后插入 system 消息导致 API 兼容性问题
    let nudgedUserContent: LLMMessage['content'] = userContent
    if (chartConsistencyMode && typeof nudgedUserContent === 'string') {
      nudgedUserContent = `${nudgedUserContent}

[系统提示] 图表一致性模式：
1) 当用户要求时间范围图且数据点不足 3 个时，默认推荐降级（1 点→KPI，2 点→柱图）；若用户明确指定图型，可按指定图型输出。
2) 若按用户指定图型输出但数据点不足，必须明确提示“数据点不足，趋势解释受限”。
3) 不要自动拼接历史数据补齐趋势，除非用户明确要求。
4) 使用已有数据直接收敛输出，不要重复调用同参数工具。`
    }

    // 图表请求时跳过 nudge，保证"同问"时 user prompt 内容稳定（独立开关，可单独回滚）
    const skipNudgeForChart = ENABLE_NUDGE_SKIP_ON_CHART && chartConsistencyMode
    if (skipNudgeForChart) {
      logPerf('nudge:skip-for-chart')
    }

    if (!skipNudgeForChart) {
      try {
        const nudgeIntervalStr = await window.electronAPI.getSetting('memory_nudge_interval')
        const nudgeInterval = nudgeIntervalStr ? parseInt(nudgeIntervalStr, 10) : 5
        if (!isNaN(nudgeInterval) && nudgeInterval > 0) {
          const userRounds = messages.filter(m => m.role === 'user').length + 1
          if (userRounds > 0 && userRounds % nudgeInterval === 0) {
            // 仅文字消息时拼接，多模态消息不附加（视觉模型一般不处理记忆提醒）
            if (typeof nudgedUserContent === 'string') {
              nudgedUserContent = nudgedUserContent + '\n\n' + MEMORY_NUDGE_TEXT
            }
          }
        }
      } catch (nudgeErr) {
        // Nudge 失败不影响正常对话
        void nudgeErr
      }
    }

    // 构建 API 消息列表（包含 system prompt），截取最近消息避免 token 超限
    const recentMessages = messages.length > MAX_CONTEXT_MESSAGES
      ? messages.slice(-MAX_CONTEXT_MESSAGES)
      : messages

    // 跨轮次 context 压缩：只保留最近 4 条 assistant 消息完整内容，
    // 更早的超长回答截断为摘要。从末尾往前数，确保最近的不被截断。
    const RECENT_FULL_ASSISTANT_COUNT = 4
    const ASSISTANT_COMPRESS_THRESHOLD = 3000
    let assistantCount = 0
    // 先从末尾数出最近 N 条 assistant 的索引
    const keepFullIndices = new Set<number>()
    for (let i = recentMessages.length - 1; i >= 0 && assistantCount < RECENT_FULL_ASSISTANT_COUNT; i--) {
      if (recentMessages[i].role === 'assistant') {
        keepFullIndices.add(i)
        assistantCount++
      }
    }
    const compressedRecentMessages = recentMessages.map((m, i) => {
      if (m.role === 'assistant' && !keepFullIndices.has(i) && typeof m.content === 'string' && m.content.length > ASSISTANT_COMPRESS_THRESHOLD) {
        return { ...m, content: m.content.slice(0, 800) + '\n\n[... 早期回答已压缩]' }
      }
      return m
    })

    // L3 Phase I：把 pending_snips 注入为 system 指令，让 LLM 主动避免引用被裁剪范围
    let snipNoticeBlock = ''
    try {
      const pendingSnips = await window.electronAPI.snipList(conversationId)
      if (Array.isArray(pendingSnips) && pendingSnips.length > 0) {
        const ranges = pendingSnips.map((s) => `${s.from}→${s.to}${s.reason ? `（${s.reason}）` : ''}`).join('；')
        snipNoticeBlock = `\n\n[snip 上下文裁剪指令] 用户已请求在生成下一回复时忽略以下消息范围：${ranges}。\n请不要复述或引用这些范围内的内容。`
      }
    } catch (snipErr) {
      void snipErr
    }

    // Phase 2: 把 system prompt 拆成 stable / dynamic 两段
    //   stable  = 分身基础 systemPrompt + HARD_RULES（cacheable，Claude 上享受 prompt cache）
    //   dynamic = @mentions intro + attachmentGuide + snipNoticeBlock（每次都变，不打 cache）
    // effectiveSystemPrompt 此时已含 @mentions intro 和 attachmentGuide（见上方拼接）。
    const dynamicAppended = effectiveSystemPrompt.length > systemPrompt.length
      ? effectiveSystemPrompt.slice(systemPrompt.length)
      : ''
    // Phase 3：HARD_RULES 用 <critical_rules> XML 包裹后挪到 stable 段最前，
    // 享受 prompt cache 的同时由 XML 标签语义保证权重不下降
    // v17：HARD_RULES（critical）+ DELIBERATION_GUIDE（软指引，鼓励 [UNCERTAIN]/[RECONSIDER]）+ 分身 system prompt。
    // 两段都进 stable 段享受 prompt cache；guide 放在 HARD_RULES 之后、systemPrompt 之前，
    // 保持"先红线，再行为指引，再人格"的语义序。
    const stableSystemText = HARD_RULES + '\n\n' + DELIBERATION_GUIDE + '\n\n' + systemPrompt

    // Lorebook keyword-trigger（SillyTavern 借鉴）：按 user message 关键词命中
    // _triggers.yaml 配置后注入对应知识片段到 dynamic 段（不打 cache，每次重算）。
    // 未配置 / 未命中 / 调用失败时 lorebookText 为空，不影响主流程。
    let lorebookText = ''
    try {
      if (typeof content === 'string' && content.length > 0) {
        const inj = await window.electronAPI.lorebookMatchAndBuild(avatarId, content)
        if (inj && inj.text) {
          lorebookText = '\n\n' + inj.text
        }
      }
    } catch (lorebookErr) {
      // 注入失败不阻塞 user message
      void lorebookErr
    }
    const dynamicSystemText = dynamicAppended + lorebookText + snipNoticeBlock

    // agent-runtime 观测接入：保留原有 stats 上报，flag off 时无副作用
    try {
      const stats = await window.electronAPI.getAgentRuntimePromptCacheStats(avatarId, {
        stableSystemPrompt: stableSystemText,
        dynamicSystemPrompt: dynamicSystemText,
      })
      if (stats.enabled) {
        // eslint-disable-next-line no-console
        console.info(
          `[agent-runtime] prompt cache stats: ${stats.cacheableChars}/${stats.totalChars} cacheable (${(stats.cacheableRatio * 100).toFixed(1)}%), ${stats.segmentCount} segments`,
          stats.segments
        )
      }
    } catch (statsErr) {
      // 观测失败不影响主流程
      void statsErr
    }

    // 构造结构化 systemBlocks 传给 Provider：
    //   - Claude 会在 stable 段尾插入 cache_control: ephemeral
    //   - OpenAI-compat 拍平成一条 system 消息，依赖前缀字节稳定命中 DeepSeek 自动 prefix cache
    const systemBlocks: SystemBlock[] = [{ text: stableSystemText, cacheable: true }]
    if (dynamicSystemText.length > 0) {
      systemBlocks.push({ text: dynamicSystemText })
    }

    // apiMessages 不再包含 role=system —— Provider 会优先采用 options.systemBlocks
    //
    // thinking 模型（DeepSeek-Reasoner 等）的严格校验：服务端要求历史里**所有** assistant
    // 消息都必须带 reasoning_content。只要任一条缺失（旧消息、reasoning 在 DB 写入前
    // 中断、跨 schema 迁移等），下一轮就直接 400：
    //   The `reasoning_content` in the thinking mode must be passed back to the API
    //
    // 修复策略：先探测当前**实际会使用**的模型是否要求 reasoning（会话级 override 优先于
    // activeModel）；若是 thinking 模型，则把历史里 reasoning_content 为空的 assistant
    // 消息及紧贴它的 tool 消息全部丢弃——丢上下文胜过整轮卡死。同时丢弃 trailing 的孤立
    // 工具消息（tool 必须紧跟在 assistant.tool_calls 之后），保留 user 消息（孤立 user
    // 可被服务端接受）。
    const _convOverride = get().conversationModelOverrides[conversationId] ?? null
    const _historyModelName = _convOverride ?? activeModel.model
    const _historyRequiresReasoning = detectReasoning(_historyModelName).enabled

    // store 持久化层只保留 user / assistant / system（tool 角色不进 compressedRecentMessages，
    // 参见 saveMessage 调用点 + global.d.ts 的 ChatMessage.role 类型），所以仅过滤 assistant
    // 即可，不必担心孤立 tool。
    let _sanitizedHistory = compressedRecentMessages
    let _droppedAssistantNoReasoning = 0
    if (_historyRequiresReasoning) {
      const kept = compressedRecentMessages.filter(m => {
        if (m.role === 'assistant' && !m.reasoning) {
          _droppedAssistantNoReasoning++
          return false
        }
        return true
      })
      _sanitizedHistory = kept
      if (_droppedAssistantNoReasoning > 0) {
        window.electronAPI.logEvent(
          'warn',
          'thinking-model-history-sanitized',
          `model=${_historyModelName} droppedAssistant=${_droppedAssistantNoReasoning} kept=${kept.length}/${compressedRecentMessages.length}`,
        )
      }
    }

    const apiMessages: LLMMessage[] = [
      ..._sanitizedHistory.map(m => {
        const msg: LLMMessage = { role: m.role, content: m.content }
        if (m.reasoning) msg.reasoning_content = m.reasoning
        return msg
      }),
      { role: 'user', content: nudgedUserContent },
    ]

    // LLMService dispatcher：优先级 = 会话级 UI 覆盖 > chat slot（设置里配置的对话模型）。
    // 分身的 avatar.config.json#defaultModel 仅作为推荐元数据，不再自动应用——
    // 否则会绕过用户在设置里的显式选择，导致"配置了 DeepSeek 还跑 Claude"的意外行为。
    let effectiveModelConfig = activeModel
    let anthropicCreds: { apiKey: string; baseUrl: string } | undefined
    if (!images || images.length === 0) {
      // 视觉/OCR 仍走 OpenAI-compat slot；chat 路径才考虑会话级模型切换
      const convOverride = get().conversationModelOverrides[conversationId] ?? null
      if (convOverride) {
        if (/^claude-/i.test(convOverride)) {
          try {
            const [aKey, aBase] = await Promise.all([
              window.electronAPI.getSetting('anthropic_api_key'),
              window.electronAPI.getSetting('anthropic_base_url'),
            ])
            anthropicCreds = {
              apiKey: aKey ?? '',
              baseUrl: aBase && aBase.trim() !== '' ? aBase : 'https://api.anthropic.com',
            }
            effectiveModelConfig = { ...activeModel, model: convOverride }
          } catch (lookupErr) {
            console.warn('[chatStore] 读取 Anthropic 凭据失败：', lookupErr instanceof Error ? lookupErr.message : String(lookupErr))
          }
        } else {
          // 非 claude 的覆盖（如显式选 deepseek-chat）：换 model 名，复用 chat slot 凭据
          effectiveModelConfig = { ...activeModel, model: convOverride }
        }
      }
      // convOverride === null 时直接使用 activeModel（即 chat slot），不查 avatar.defaultModel
    }
    let llm: LLMService
    try {
      llm = new LLMService(effectiveModelConfig, anthropicCreds)
    } catch (constructErr) {
      // Claude 模型未配 Anthropic key、或其他构造期错误：直接返回错误消息并解锁 isLoading，
      // 不进入流式循环（否则 UI 一直停在「思考中」状态）。
      // user 消息已在上游 set + saveMessage（含 tagged anchor），这里只需用
      // upsertLastAssistant 把空占位替换成错误消息，并持久化 assistant 错误条；
      // 不要再 push user 消息（否则会重复入库 + UI 出现两条同样的 user 气泡）。
      // hiddenRepair 模式跳过 UI / DB 写入——失败仅日志，对用户完全静默。
      const errorMsg = constructErr instanceof Error ? constructErr.message : String(constructErr)
      if (!isHiddenRepair) {
        set((state) => ({
          messages: upsertLastAssistant(state.messages, assistantMsgId, errorMsg),
          isLoading: false,
        }))
        await window.electronAPI.saveMessage(conversationId, 'assistant', errorMsg)
      }
      await invokeProxyComplete({ ok: false, error: errorMsg })
      cleanupRequest()
      return
    }
    const activeModelReasoning = detectReasoning(effectiveModelConfig.model).enabled

    /**
     * 有图片时不传工具（视觉模型可能不支持）。
     * 九层重构 #17 switch_mode：按当前 mode 过滤工具：
     *   - agent：全部工具
     *   - plan：只读 + 思考类（禁止写文件 / 执行命令 / 委派子代理 / 切模式）
     *   - ask：完全禁用工具
     */
    const currentMode = get().mode
    // 对话框附件扩展：有图片时旧策略是清空 tools（视觉模型常不支持 function calling），
    // 但若同时有附件存在则必须保留 read_attachment / search_attachment 工具，否则模型
    // 拿到 <attachment id /> 元信息却无法读取本体。这里只保留附件相关工具集。
    const ATTACHMENT_REQUIRED_TOOL_NAMES = new Set(['read_attachment', 'search_attachment'])
    /**
     * RAG 直答快路径下保留的「联网兜底工具」白名单。
     * 设计考量：RAG 命中知识库后会清空大部分工具以加速回答，但用户问及"最新政策/新闻/
     * 实时数据"时，知识库内容可能已过时，需要让 LLM 仍能自主决定联网补全。
     * 不保留 search_knowledge / query_excel 等"知识层"工具，避免与 RAG 注入内容重复检索。
     */
    const RAG_FAST_PATH_NETWORK_TOOLS = new Set(['web_search', 'web_fetch'])
    /**
     * 联网工具白名单：由「设置 → 工具集成 → 启用联网功能」总开关控制。
     * 关闭时从所有分支的 tools 数组里剔除，连 LLM 都看不到这两个工具——
     * 配合 tool-router 的 webSearch / webFetch 入口闸门双层保护。
     */
    const NETWORK_TOOL_NAMES = new Set(['web_search', 'web_fetch'])
    const webSearchEnabledRaw = await window.electronAPI.getSetting('web_search_enabled')
    const webSearchEnabled = webSearchEnabledRaw === 'true'
    let tools: LLMTool[]
    const ragDirectAnswerFastPath = shouldUseRagDirectAnswerFastPath(
      content,
      ragEnhanced,
      Boolean(images && images.length > 0),
      Boolean(attachments && attachments.length > 0),
      currentMode,
      shouldForceChartSkill,
      chartConsistencyMode,
    )
    if (ragDirectAnswerFastPath) {
      tools = AVATAR_TOOLS.filter(t => RAG_FAST_PATH_NETWORK_TOOLS.has(t.function.name))
      logPerf('rag-direct-answer:enabled', `enhancedLen=${enhancedContent.length} keepTools=${tools.length}`)
      window.electronAPI.logEvent('info', 'rag-direct-answer-fast-path', `conversation=${conversationId} model=${activeModel.model} keepTools=${tools.length}`)
    } else if (images && images.length > 0) {
      if (attachments && attachments.length > 0) {
        tools = AVATAR_TOOLS.filter(t => ATTACHMENT_REQUIRED_TOOL_NAMES.has(t.function.name))
      } else {
        tools = []
      }
    } else if (currentMode === 'ask') {
      tools = []
    } else if (currentMode === 'plan') {
      tools = AVATAR_TOOLS.filter(t => !PLAN_MODE_BLOCKED_TOOL_NAMES.has(t.function.name))
    } else {
      tools = AVATAR_TOOLS
    }

    // 总开关关闭 → 剔除联网工具（覆盖所有分支，含 ragDirectAnswerFastPath 兜底分支）
    if (!webSearchEnabled) {
      tools = tools.filter(t => !NETWORK_TOOL_NAMES.has(t.function.name))
    }

    tools = await maybeRerankToolsWithIss(content, tools)

    logPerf('tools:selected', `mode=${currentMode} count=${tools.length} ragDirect=${ragDirectAnswerFastPath}`)

    /**
     * GAP4: 工具调用循环
     * 每轮：调用 LLM → 如有 tool_calls 则执行并追加结果 → 再次调用 → 直至无工具调用或达到上限
     */
    let round = 0
    let assistantText = ''
    let reasoningText = ''
    /**
     * 本轮 round-trip 需要原样回传给服务端的 reasoning_content。
     * thinking 模型（DeepSeek-Reasoner 等）多轮工具调用时，assistant 消息必须带回上一轮的 reasoning_content，
     * 否则服务端直接 400。注意：仅本轮（按调用粒度），不要和 UI 显示用的 reasoningText 混用。
     */
    let roundReasoningText = ''
    // A 方案兜底：reasoning model 偶发把 completion budget 全消耗在 reasoning_content
    // 上、message.content 留空（textLen=0 / reasoningLen>0），用户主回答区空白。
    // 进入此模式后下一轮 runRound 放开 maxTokens 限制，让模型有 budget 写正文。
    let emptyTextRetryMode = false
    // 截断检测：上一轮 LLM 输出 outputTokens 接近 maxTokens（即 finish_reason='length' 等价信号），
    // 说明正文被强制截断。供 tool-loop 末尾的兜底重试 + auto-seal 任务状态决策使用。
    let lastRoundOutputTruncated = false
    let pendingToolCalls: ToolCall[] | undefined
    // assistantMsgId 已在 sendMessage 入口处提前生成（与 user 消息同帧插入空占位），
    // 这里直接复用闭包内的常量。
    let toolCallCount = 0
    let toolLoopStartedAt: number | null = null
    let roundStartedAt = 0
    let roundFirstTokenAt: number | null = null
    let roundLastActivityAt = 0
    let queryExcelCallCount = 0
    const queryExcelResultCache = new Map<string, string>()
    /** 本次对话中所有 query_excel 引用过的 basename 集合，供 chart-cache 写入时做快照 */
    const excelBasenamesUsed = new Set<string>()
    /**
     * 本轮对话产出的工具落盘文件（决策 B3）。
     * generate_document / export_excel 返回的 file_path 在 exports/ 下时被识别后追加，
     * 最终随 upsertLastAssistant 一起写到 message.documentAttachments。
     */
    const collectedDocumentAttachments: DocumentAttachment[] = []
    let loadSkillCallCount = 0
    /**
     * 已加载的 skill_id 集合（去重）。
     *
     * 之前的实现按"总次数"卡 MAX_LOAD_SKILL_CALLS_PER_REQUEST=1，导致：
     *   - force-load `chart-from-knowledge` 已用掉 1 次额度
     *   - LLM 按 chart-from-knowledge 指引继续 `load_skill('draw-chart')` 拿基础画图规则
     *   - 守卫拦截 → ECharts 代码块没出，可视化图缺失（2026-05-21 Case 04 实测踩到）
     *
     * 修复后：按 skill_id 去重——同一个 skill 不重复加载，但不同 skill 允许各加载一次。
     * 仍保留次数兜底（MAX_LOAD_SKILL_CALLS_PER_REQUEST 翻倍后作为"防滥用"上限）。
     */
    const loadedSkillIds = new Set<string>()
    let forceConvergeNoTools = false
    let convergeHintInjected = false
    let softWarnInjected = false
    let dsmlCorrectionInjected = false

    /** 取消残留的 rAF，防止跨对话消息污染 */
    const cancelPendingChunk = () => {
      if (pendingChunkUpdate !== null) {
        cancelAnimationFrame(pendingChunkUpdate)
        pendingChunkUpdate = null
      }
    }

    const forceLoadChartSkillIfNeeded = async (): Promise<void> => {
      if (!shouldForceChartSkill || !tools.some(t => t.function.name === 'load_skill')) return

      const toolStartedAt = Date.now()
      const toolCallId = `forced-load-skill-${toolStartedAt}`
      const toolArgs = { skill_id: FORCED_CHART_SKILL_ID }
      const syntheticToolCall: ToolCall = {
        id: toolCallId,
        type: 'function',
        function: {
          name: 'load_skill',
          arguments: JSON.stringify(toolArgs),
        },
      }
      let resultText = ''
      let toolOk = true

      logPerf('chart-skill:force-load', `skill=${FORCED_CHART_SKILL_ID}`)
      set({ toolCallStatus: 'load_skill' })
      safeEmit({
        type: 'tool-call-start',
        conversationId,
        timestamp: toolStartedAt,
        toolCallId,
        name: 'load_skill',
        args: toolArgs,
      })

      try {
        const result = await window.electronAPI.executeToolCall(avatarId, conversationId, 'load_skill', toolArgs, toolInvocationMeta)
        if (isStale()) return
        loadSkillCallCount++
        loadedSkillIds.add(FORCED_CHART_SKILL_ID)
        resultText = result.error
          ? `工具执行失败: ${result.error}`
          : result.content
      } catch (toolErr) {
        const msg = toolErr instanceof Error ? toolErr.message : String(toolErr)
        resultText = `工具执行失败: ${msg}`
        toolOk = false
      }

      if (toolOk && resultText.startsWith('工具执行失败')) toolOk = false
      const truncatedResult = truncateToolResultForContext('load_skill', resultText)
      resultText = truncatedResult.content
      const toolDurationMs = Date.now() - toolStartedAt

      safeEmit({
        type: 'tool-call-end',
        conversationId,
        timestamp: Date.now(),
        toolCallId,
        name: 'load_skill',
        durationMs: toolDurationMs,
        ok: toolOk,
        errorMsg: toolOk ? undefined : resultText.slice(0, 200),
      })
      if (activeModelReasoning) {
        /**
         * thinking 模型（DeepSeek-Reasoner / o1 / gpt-5 等）服务端会校验所有 assistant 消息必须携带
         * 与本次回复一一对应的 reasoning_content；而这里"合成"的 assistant+tool 消息对并不来自模型，
         * 没有任何真实的 reasoning_content 可以原样回传——空串 / 占位串 / 省略字段都会被 400 拒绝
         * （报错文案：The `reasoning_content` in the thinking mode must be passed back to the API）。
         *
         * 因此对 thinking 模型彻底放弃"伪 tool round-trip"注入策略：直接把 skill 内容拼到 system
         * prompt 末尾，让模型在第一轮就具备 skill 知识，apiMessages 的对话流保持
         * `[system, ...history, user]` 形态，不混入任何合成 assistant 消息。
         *
         * 同时跳过 saveMessage——避免 DB 里残留孤立的 tool 消息（下次加载时会成为不配对的 tool，
         * 传给 thinking 模型时同样会 400）。telemetry 与 loadSkillCallCount 已在前面发出，
         * 回归测试的工具调用统计不受影响。
         */
        const systemMsg = apiMessages[0]
        if (systemMsg && systemMsg.role === 'system' && typeof systemMsg.content === 'string') {
          // 注入文案要够强：旧版只写"[已自动加载技能：xxx]"，DeepSeek-Reasoner 等
          // thinking 模型仍会按习惯 load_skill 一次（导致工具调用时间线出现"1 失败"的
          // 拦截记录，看着像 bug）。改用明确禁令 + 后续可调 skill 名单，让模型直接
          // 跳过冗余的 load_skill('chart-from-knowledge') 调用。
          systemMsg.content =
            `${systemMsg.content}\n\n` +
            `[系统预加载技能 · 必读]\n` +
            `技能 \`${FORCED_CHART_SKILL_ID}\` 的完整定义已经预加载在下面，` +
            `**请直接使用，禁止再调用 \`load_skill('${FORCED_CHART_SKILL_ID}')\`**——` +
            `重复加载会被守卫拦截并显示为"工具失败"，徒增噪声。\n` +
            `如需进一步加载其它技能（如 \`draw-chart\` 基础画图规则），照常调 \`load_skill\` 即可。\n\n` +
            `===== ${FORCED_CHART_SKILL_ID} 技能定义开始 =====\n` +
            `${resultText}\n` +
            `===== ${FORCED_CHART_SKILL_ID} 技能定义结束 =====`
          logPerf('chart-skill:inject-into-system', `model=${activeModel.model} contentLen=${resultText.length}`)
        } else {
          window.electronAPI.logEvent(
            'warn',
            'chart-skill-inject-system-failed',
            `apiMessages[0] 不是 string content 的 system 消息，跳过 thinking 模型 skill 注入`,
          )
        }
      } else {
        apiMessages.push({
          role: 'assistant',
          content: '',
          tool_calls: [syntheticToolCall],
        })
        apiMessages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: resultText,
        })
        // hiddenRepair 模式跳过 saveMessage——本轮所有 tool/assistant 都不入库（避免孤儿记录）。
        // 实际上修正 prompt 不会触发 chartConsistencyMode（无图表关键词），到这里的概率极低，
        // 保险加守卫避免未来路径变化产生污染。
        if (!isHiddenRepair) {
          try {
            await window.electronAPI.saveMessage(conversationId, 'tool', resultText, toolCallId)
          } catch (saveErr) {
            const msg = saveErr instanceof Error ? saveErr.message : String(saveErr)
            window.electronAPI.logEvent('warn', 'save-forced-chart-skill-message-failed', msg)
          }
        }
      }
      set({ toolCallStatus: '' })
    }

    const runRound = (): Promise<void> =>
      new Promise((resolve, reject) => {
        assistantText = ''
        // 每轮重置：避免上一轮的 reasoning_content 被错误地附加到下一轮的 assistant 消息
        roundReasoningText = ''
        roundStartedAt = Date.now()
        roundFirstTokenAt = null
        roundLastActivityAt = roundStartedAt
        const _diagBodySize = JSON.stringify(apiMessages).length
        const _diagSystemSize = (apiMessages[0]?.content as string | undefined)?.length ?? 0
        const _diagToolCount = tools.length
        logPerf('llm-round:start', `round=${round} model=${activeModel.model} bodyChars=${_diagBodySize} systemChars=${_diagSystemSize} msgCount=${apiMessages.length} toolCount=${_diagToolCount}`)
        window.electronAPI.logEvent('info', 'llm-request-debug', `model=${activeModel.model} bodyChars=${_diagBodySize} systemChars=${_diagSystemSize} msgCount=${apiMessages.length} toolCount=${_diagToolCount} baseUrl=${activeModel.baseUrl}`)

        const shouldConvergeFast = ENABLE_CONVERGE_FINAL_ROUND_SPEEDUP && forceConvergeNoTools
        // temperature 优先级：收敛模式 > 确定性模式 > 图表一致性模式（fallback）
        // 确定性模式优先，避免图表场景命中时反而把 temp 拉高于确定性档位
        const effectiveTemperature = shouldConvergeFast
          ? 0.2
          : (ENABLE_DETERMINISTIC_MODE
              ? DETERMINISTIC_TEMPERATURE
              : (chartConsistencyMode ? CHART_CONSISTENCY_TEMPERATURE : undefined))
        llm.chat(
          apiMessages,
          (chunk, kind = 'content') => {
            if (isStale()) return
            roundLastActivityAt = Date.now()
            if (roundFirstTokenAt === null) {
              roundFirstTokenAt = roundLastActivityAt
              logPerf('llm-round:first-token', `round=${round} ttft=${roundFirstTokenAt - roundStartedAt}ms`)
              if (round === 0 && phase05FirstTokenAt === 0) {
                phase05FirstTokenAt = roundFirstTokenAt
              }
            }
            if (kind === 'reasoning') {
              reasoningText += chunk
              // 切走→切回回灌 snapshot：同步更新（不依赖 RAF 是否触发 set）
              if (streamingSnapshot && streamingSnapshot.conversationId === conversationId) {
                streamingSnapshot.reasoning = reasoningText
              }
              if (round === 0 && pendingChunkUpdate === null && !isHiddenRepair) {
                pendingChunkUpdate = requestAnimationFrame(() => {
                  pendingChunkUpdate = null
                  if (isStale()) return
                  if (!isViewedConv()) return  // 切走时不实时刷 UI，避免污染目标会话；累积量已在 snapshot
                  set((state) => ({
                    messages: upsertLastAssistant(state.messages, assistantMsgId, assistantText, reasoningText),
                  }))
                })
              }
              return
            }
            assistantText += chunk
            // 切走→切回回灌 snapshot：同步更新
            if (streamingSnapshot && streamingSnapshot.conversationId === conversationId) {
              streamingSnapshot.text = assistantText
            }
            writeProxyStreamDelta(chunk)
            // 工具调用中间轮次（round > 0）不实时显示文字给用户，
            // 避免 LLM 在中间轮输出半成品分析后最终轮又重复一遍。
            // 只在第一轮（用户刚发消息）和最终轮（下面 resolve 后判断无 tool_calls 再刷新）时显示。
            // hiddenRepair 模式跳过——本轮 messages 里没有占位 message，set 会插入新气泡污染 UI。
            if (round === 0 && pendingChunkUpdate === null && !isHiddenRepair) {
              pendingChunkUpdate = requestAnimationFrame(() => {
                pendingChunkUpdate = null
                if (isStale()) return
                if (!isViewedConv()) return
                const text = assistantText
                set((state) => ({
                  messages: upsertLastAssistant(state.messages, assistantMsgId, text, reasoningText),
                }))
              })
            }
          },
          (_fullText, toolCalls, reasoning, usage) => {
            cancelPendingChunk()
            // usage 在 isStale 之前先 emit：即便结果被丢弃，token 已经计费产生
            if (usage) {
              safeEmit({
                type: 'usage',
                conversationId,
                timestamp: Date.now(),
                model: effectiveModelConfig.model,
                usage,
                round,
              })
            }
            // 截断检测：当前轮如果设了 maxTokens，且 outputTokens 接近上限（留 4 token 容差），
            // 视为被强制截断。供 tool-loop 末尾决定是否兜底重试 + auto-seal 任务状态。
            const effectiveMaxTokens = shouldConvergeFast && !emptyTextRetryMode
              ? CONVERGE_FINAL_ROUND_MAX_TOKENS
              : 0
            lastRoundOutputTruncated =
              effectiveMaxTokens > 0 &&
              typeof usage?.outputTokens === 'number' &&
              usage.outputTokens >= effectiveMaxTokens - 4
            if (isStale()) {
              pendingToolCalls = undefined
              resolve()
              return
            }
            pendingToolCalls = toolCalls
            // thinking 模型本轮 reasoning_content，下一步在 apiMessages.push 时原样回传
            roundReasoningText = reasoning ?? ''
            logPerf(
              'llm-round:done',
              `round=${round} duration=${Date.now() - roundStartedAt}ms textLen=${assistantText.length} toolCalls=${toolCalls?.length ?? 0} reasoningLen=${roundReasoningText.length}`,
            )
            // 本轮没有 tool_calls → 最终轮，立即刷新显示最终文字
            // hiddenRepair 模式跳过 UI 写入（messages 里没有占位 message）。
            if ((!toolCalls || toolCalls.length === 0) && !hasDsmlToolCallLeak(assistantText)) {
              const text = assistantText
              if (isViewedConv() && !isHiddenRepair) {
                set((state) => ({
                  messages: upsertLastAssistant(state.messages, assistantMsgId, text, reasoningText),
                }))
              }
            }
            resolve()
          },
          (error) => {
            cancelPendingChunk()
            const errMsg = error instanceof Error ? error.message : String(error)
            logPerf('llm-round:error', `round=${round} duration=${Date.now() - roundStartedAt}ms ${errMsg}`)
            reject(error)
          },
          {
            tools: (!forceConvergeNoTools && tools.length > 0) ? tools : undefined,
            signal: abortController.signal,
            maxTokens: shouldConvergeFast && !emptyTextRetryMode ? CONVERGE_FINAL_ROUND_MAX_TOKENS : undefined,
            temperature: effectiveTemperature,
            seed: deterministicSeed,
            reasoningEffort: activeModelReasoning && (ragDirectAnswerFastPath || shouldConvergeFast) ? 'low' : undefined,
            systemBlocks,
          }
        )
      })

    /** 带阶段超时的 runRound，区分首 token 慢、流中断和总耗时过长。 */
    const runRoundWithTimeout = async (): Promise<void> => {
      let timer: ReturnType<typeof setInterval> | null = null
      try {
        await Promise.race([
          runRound(),
          new Promise<void>((_, reject) => {
            timer = setInterval(() => {
              const now = Date.now()
              const elapsed = now - roundStartedAt
              if (roundFirstTokenAt === null && elapsed >= ROUND_FIRST_TOKEN_TIMEOUT_MS) {
                logPerf('llm-round:first-token-timeout', `round=${round} waited=${elapsed}ms model=${activeModel.model}`)
                window.electronAPI.logEvent('warn', 'llm-first-token-timeout', `model=${activeModel.model} round=${round} waited=${elapsed}ms`)
                abortController.abort()
                reject(new Error(`LLM 首 token 超时（${Math.round(ROUND_FIRST_TOKEN_TIMEOUT_MS / 1000)} 秒），请检查模型响应速度或稍后重试`))
              } else if (roundFirstTokenAt !== null && now - roundLastActivityAt >= ROUND_STREAM_IDLE_TIMEOUT_MS) {
                logPerf('llm-round:stream-idle-timeout', `round=${round} idle=${now - roundLastActivityAt}ms model=${activeModel.model}`)
                window.electronAPI.logEvent('warn', 'llm-stream-idle-timeout', `model=${activeModel.model} round=${round} idle=${now - roundLastActivityAt}ms`)
                abortController.abort()
                reject(new Error(`LLM 流式响应中断超过 ${Math.round(ROUND_STREAM_IDLE_TIMEOUT_MS / 1000)} 秒，请重试`))
              } else if (elapsed >= ROUND_TIMEOUT_MS) {
                logPerf('llm-round:total-timeout', `round=${round} waited=${elapsed}ms model=${activeModel.model}`)
                window.electronAPI.logEvent('warn', 'llm-round-total-timeout', `model=${activeModel.model} round=${round} waited=${elapsed}ms`)
                abortController.abort()
                reject(new Error('LLM 响应超时，请重试'))
              }
            }, 1000)
          }),
        ])
      } finally {
        if (timer) clearInterval(timer)
      }
    }

    const correctDsmlToolCallLeak = async (): Promise<boolean> => {
      if (!hasDsmlToolCallLeak(assistantText) || dsmlCorrectionInjected || round >= HARD_MAX_ROUNDS) return false

      logPerf('dsml-leak:correction-round', `round=${round}`)
      window.electronAPI.logEvent('warn', 'dsml-tool-call-leak-detected', assistantText.slice(0, 200))
      apiMessages.push({
        role: 'user',
        content: '[系统纠偏] 你刚才输出了 DSML 伪工具调用文本。不要把 `<｜｜DSML｜｜tool_calls>` 或任何工具调用协议作为最终答案展示给用户；如果需要工具，必须使用平台提供的 function calling；如果已有足够信息，请直接给自然语言最终答案。',
      })
      dsmlCorrectionInjected = true
      forceConvergeNoTools = false
      await runRoundWithTimeout()
      return true
    }

    try {
      await forceLoadChartSkillIfNeeded()
      if (isStale()) return
      await runRoundWithTimeout()
      if (isStale()) return
      if (await correctDsmlToolCallLeak() && isStale()) return

      // 用 do-while 包原 tool-loop while：B 兜底（"文档承诺未兑现"retry）触发时让 LLM
      // 重新 emit tool_calls（generate_document），continue 让外层 do-while 再走一次内层 while
      // 执行新发起的工具调用，从而真的落盘文件（2026-05-22 修复：分身说"将落盘"但没调工具）。
      // 无 retry 触发时 break 一次即退，行为与改造前完全一致。
      do {
      while (pendingToolCalls && pendingToolCalls.length > 0 && round < HARD_MAX_ROUNDS) {
        if (isStale()) return
        round++
        if (toolLoopStartedAt === null) {
          toolLoopStartedAt = Date.now()
          logPerf('tool-loop:start')
        }
        logPerf('tool-loop:round-start', `round=${round} calls=${pendingToolCalls.length}`)

        // 将 LLM 的工具调用请求追加到消息历史（保留 LLM 在工具调用前生成的文本）
        // thinking 模型必须把 reasoning_content 原样回传，否则 DeepSeek-Reasoner 等服务端会 400
        apiMessages.push({
          role: 'assistant',
          content: assistantText,
          tool_calls: pendingToolCalls,
          reasoning_content: roundReasoningText || undefined,
        })

        // 执行所有工具调用
        for (const tc of pendingToolCalls) {
          if (isStale()) return
          const toolStartedAt = Date.now()
          toolCallCount++
          // GAP8: 更新工具调用状态，供 UI 显示
          set({ toolCallStatus: tc.function.name })

          let toolArgs: Record<string, unknown> = {}
          try {
            toolArgs = JSON.parse(tc.function.arguments || '{}')
          } catch (parseErr) {
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr)
            console.warn(`[chatStore] 工具参数 JSON 解析失败 (${tc.function.name}):`, msg)
            window.electronAPI.logEvent('warn', 'tool-args-parse-error', `${tc.function.name}: ${msg}`)
          }

          safeEmit({
            type: 'tool-call-start',
            conversationId,
            timestamp: toolStartedAt,
            toolCallId: tc.id,
            name: tc.function.name,
            args: toolArgs,
          })

          let resultText = ''
          // Stage 三 P2 #14：本次工具调用是否成功（用于关联到当前 in_progress 任务的 toolCalls 列表）。
          // 任何抛错或执行失败前缀都置 false；前置守卫拦截算"被拒绝"，也算 false。
          let toolOk = true
          try {
            if (tc.function.name === 'todo_write') {
              const modePol = evaluateConversationModeToolPolicy(get().mode, 'todo_write')
              if (modePol.denied) {
                resultText = `工具执行失败: ${modePol.message}`
                logPerf('tool-call:todo-write-blocked', `round=${round} reason=mode-policy`)
              } else {
              // 前端原生工具：不走 IPC，直接更新 store
              // 容错：toolArgs.todos 必须是数组，每项必须有 id/content/status，
              // 非法项目静默丢弃并在结果文本中提示 LLM 修正。
              const rawTodos = Array.isArray(toolArgs.todos) ? toolArgs.todos as unknown[] : []
              const merge = toolArgs.merge === true
              const validTodos: AgentTask[] = []
              let invalidCount = 0
              for (const item of rawTodos) {
                if (item && typeof item === 'object') {
                  const t = item as Record<string, unknown>
                  const id = typeof t.id === 'string' ? t.id : ''
                  const content = typeof t.content === 'string' ? t.content : ''
                  const status = t.status
                  const isValidStatus = status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'cancelled'
                  if (id && content && isValidStatus) {
                    validTodos.push({ id, content, status })
                    continue
                  }
                }
                invalidCount++
              }

              if (merge) {
                get().mergeTasks(validTodos)
              } else {
                get().setTasks(validTodos)
              }

              const all = get().tasks
              const stat = {
                pending: all.filter(t => t.status === 'pending').length,
                in_progress: all.filter(t => t.status === 'in_progress').length,
                completed: all.filter(t => t.status === 'completed').length,
                cancelled: all.filter(t => t.status === 'cancelled').length,
              }
              const invalidHint = invalidCount > 0
                ? `（已忽略 ${invalidCount} 条非法条目，需含 id/content/status 三字段且 status 在枚举内）`
                : ''
              resultText = [
                `任务列表已${merge ? '增量合并' : '整体覆盖'}${invalidHint}。`,
                `当前共 ${all.length} 项：${stat.pending} 待执行 / ${stat.in_progress} 进行中 / ${stat.completed} 已完成 / ${stat.cancelled} 已取消。`,
                `请按计划执行下一步；每完成一项立即用 todo_write(merge=true) 把它标为 completed，并把下一项标为 in_progress。`,
              ].join('\n')

              logPerf('tool-call:todo-write', `round=${round} merge=${merge} valid=${validTodos.length} invalid=${invalidCount} total=${all.length}`)
              safeEmit({
                type: 'todo-write',
                conversationId,
                timestamp: Date.now(),
                tasksJson: JSON.stringify(all),
                merge,
              })
              }
            } else if (ENABLE_QUERY_EXCEL_GUARD && tc.function.name === 'query_excel') {
              const queryExcelCacheKey = normalizeQueryExcelArgs(toolArgs)
              if (typeof toolArgs.file === 'string' && toolArgs.file.length > 0) {
                excelBasenamesUsed.add(toolArgs.file)
              }
              const cached = queryExcelResultCache.get(queryExcelCacheKey)
              if (cached) {
                resultText = cached
                logPerf('tool-call:cache-hit', `round=${round} name=query_excel`)
              } else if (queryExcelCallCount >= MAX_QUERY_EXCEL_CALLS_PER_REQUEST) {
                resultText = `工具执行已跳过：query_excel 在当前对话已执行 ${MAX_QUERY_EXCEL_CALLS_PER_REQUEST} 次。请基于已有查询结果直接完成回答，不要继续调用 query_excel。仅当用户明确要求新增筛选条件时，再发起新一轮对话查询。`
                logPerf('tool-call:blocked', `round=${round} name=query_excel reason=max-calls(${MAX_QUERY_EXCEL_CALLS_PER_REQUEST})`)
                if (ENABLE_TOOL_CONVERGE_MODE) {
                  forceConvergeNoTools = true
                  logPerf('tool-loop:converge-mode-on', `round=${round} reason=query_excel-max-calls`)
                }
              } else {
                const result = await window.electronAPI.executeToolCall(avatarId, conversationId, tc.function.name, toolArgs, toolInvocationMeta)
                if (isStale()) return
                queryExcelCallCount++
                resultText = result.error
                  ? `工具执行失败: ${result.error}`
                  : result.content
                queryExcelResultCache.set(queryExcelCacheKey, resultText)
                // C1 优化：配额用满时追加提示，让 LLM 在下一轮直接收敛，
                // 避免 LLM 再次试探调用 query_excel 被守卫挡掉（浪费 1 轮 ~7s）
                if (queryExcelCallCount >= MAX_QUERY_EXCEL_CALLS_PER_REQUEST) {
                  resultText += `\n\n[系统提示] query_excel 配额已用完（${queryExcelCallCount}/${MAX_QUERY_EXCEL_CALLS_PER_REQUEST}）。请立即基于以上数据给出最终答案（如需图表，请直接输出 \`\`\`chart 代码块），不要再调用任何工具。`
                  logPerf('tool-call:budget-hint-appended', `round=${round} name=query_excel used=${queryExcelCallCount}/${MAX_QUERY_EXCEL_CALLS_PER_REQUEST}`)
                }
              }
            } else if (ENABLE_LOAD_SKILL_GUARD && tc.function.name === 'load_skill') {
              const requestedSkillId = typeof toolArgs.skill_id === 'string' ? toolArgs.skill_id : ''
              if (requestedSkillId && loadedSkillIds.has(requestedSkillId)) {
                // 重复加载同一个 skill —— 阻止，提示模型已有上下文
                resultText = `工具执行已跳过：skill "${requestedSkillId}" 已在本对话加载过，相关内容已在 systemPrompt 或之前的工具结果中提供，请基于已有上下文直接完成回答，不要重复调用 load_skill。`
                logPerf('tool-call:blocked', `round=${round} name=load_skill reason=duplicate-skill skill=${requestedSkillId}`)
              } else if (loadSkillCallCount >= MAX_LOAD_SKILL_CALLS_PER_REQUEST) {
                // 防滥用上限：累计加载了 N 个不同 skill 仍不收敛
                resultText = `工具执行已跳过：load_skill 本次请求已加载 ${MAX_LOAD_SKILL_CALLS_PER_REQUEST} 个不同的 skill，已达兜底上限。请基于已加载的技能内容直接完成回答，不要继续调用 load_skill。`
                logPerf('tool-call:blocked', `round=${round} name=load_skill reason=max-distinct(${MAX_LOAD_SKILL_CALLS_PER_REQUEST}) skill=${requestedSkillId}`)
                if (ENABLE_TOOL_CONVERGE_MODE) {
                  forceConvergeNoTools = true
                  logPerf('tool-loop:converge-mode-on', `round=${round} reason=load_skill-max-distinct`)
                }
              } else {
                const result = await window.electronAPI.executeToolCall(avatarId, conversationId, tc.function.name, toolArgs, toolInvocationMeta)
                if (isStale()) return
                loadSkillCallCount++
                if (requestedSkillId) loadedSkillIds.add(requestedSkillId)
                resultText = result.error
                  ? `工具执行失败: ${result.error}`
                  : result.content
              }
            } else {
              const result = await window.electronAPI.executeToolCall(avatarId, conversationId, tc.function.name, toolArgs, toolInvocationMeta)
              if (isStale()) return
              resultText = result.error
                ? `工具执行失败: ${result.error}`
                : result.content
            }
          } catch (toolErr) {
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr)
            resultText = `工具执行失败: ${msg}`
            toolOk = false
          }
          // 即使 try 没抛错，结果文本以"工具执行失败"开头也视为失败（IPC 路径返回的 error 转字符串）
          if (toolOk && resultText.startsWith('工具执行失败')) toolOk = false
          // "工具执行已跳过" 是守卫主动拦截。telemetry 端仍记 ok=false（事件分析需要看到拦截），
          // 但 timeline 端额外打 skipped=true，UI 凭它把"拦截"显示为 ⊘ 中性而不是 ✗ 失败，
          // "N 失败" 汇总也跳过这条。两层语义分离，互不影响。
          const wasSkipped = resultText.startsWith('工具执行已跳过')
          if (toolOk && wasSkipped) toolOk = false
          const truncatedResult = truncateToolResultForContext(tc.function.name, resultText)
          if (truncatedResult.truncated) {
            logPerf(
              'tool-call:truncate',
              `round=${round} name=${tc.function.name} originalLen=${truncatedResult.originalLength} clippedLen=${truncatedResult.content.length}`,
            )
          }
          resultText = truncatedResult.content
          const toolDurationMs = Date.now() - toolStartedAt
          if (tc.function.name === 'search_knowledge') {
            phase05SearchKnowledgeCalls += 1
            phase05SearchKnowledgeResultLen += resultText.length
          }
          logPerf(
            'tool-call:done',
            `round=${round} name=${tc.function.name} duration=${toolDurationMs}ms resultLen=${resultText.length}`,
          )
          safeEmit({
            type: 'tool-call-end',
            conversationId,
            timestamp: Date.now(),
            toolCallId: tc.id,
            name: tc.function.name,
            durationMs: toolDurationMs,
            ok: toolOk,
            errorMsg: toolOk ? undefined : resultText.slice(0, 200),
          })

          // Stage 三 P2 #14：把本次工具调用挂到当前 in_progress 任务，让 UI 显示"任务 → 工具调用"对应关系。
          // 例外：todo_write 本身就是管理任务的工具，不挂到自己上避免噪音。
          // hiddenRepair 模式跳过——修正轮的工具调用不应污染用户的真实 task 列表。
          if (tc.function.name !== 'todo_write' && !isHiddenRepair) {
            try {
              get().attachToolCallToTask({
                id: tc.id,
                name: tc.function.name,
                durationMs: toolDurationMs,
                ok: toolOk,
              })
            } catch (attachErr) {
              // 关联失败绝不影响主链路
              const msg = attachErr instanceof Error ? attachErr.message : String(attachErr)
              window.electronAPI.logEvent('warn', 'attach-tool-to-task-failed', `${tc.function.name}: ${msg}`)
            }
          }

          // 工具调用时间线（与 attachToolCallToTask 并行：任务关联用于 TaskListPanel；时间线用于 ChatWindow 顶部滚动展示）
          // 与 attachToolCallToTask 不同，timeline 不依赖 todo_write 任务存在，每次工具调用都记录（含 todo_write 本身，
          // 让用户能看到"任务列表被刷新"这件事）。
          // 2026-05-24：传 { conversationId, assistantMsgId } 精确定位，避免切对话时
          // 把 A 的工具调用挂到 B 最后一条 assistant 上、或者 A 不在视图时 timeline 落库为空。
          // hiddenRepair 模式跳过——修正轮的工具调用不应出现在顶部时间线 / 不应入库。
          if (!isHiddenRepair) {
            try {
              get().appendToolCallTimeline(
                {
                  id: tc.id,
                  name: tc.function.name,
                  argsPreview: (tc.function.arguments || '').slice(0, 80),
                  resultPreview: resultText.slice(0, 200),
                  durationMs: toolDurationMs,
                  ok: toolOk,
                  startedAt: toolStartedAt,
                  skipped: wasSkipped,
                },
                { conversationId, assistantMsgId },
              )
            } catch (timelineErr) {
              // 时间线 push 失败绝不影响主链路
              const msg = timelineErr instanceof Error ? timelineErr.message : String(timelineErr)
              window.electronAPI.logEvent('warn', 'append-tool-timeline-failed', `${tc.function.name}: ${msg}`)
            }
          }

          // 决策 B3：检测落盘文件，统一以 FileCard 展示在对话气泡内
          // hiddenRepair 模式跳过 UI 更新——修正轮的工具产物不应展示在原 assistant 气泡。
          // collectedDocumentAttachments 仍 push（无害；本轮不落盘 assistant 消息，attachments 不会持久化）。
          if (toolOk && (tc.function.name === 'generate_document' || tc.function.name === 'export_excel')) {
            const attachment = tryExtractDocumentAttachment(tc.function.name, resultText, conversationId)
            if (attachment) {
              collectedDocumentAttachments.push(attachment)
              if (isViewedConv() && !isHiddenRepair) {
                set((state) => ({
                  messages: upsertLastAssistant(
                    state.messages,
                    assistantMsgId,
                    assistantText,
                    reasoningText,
                    collectedDocumentAttachments,
                  ),
                }))
              }
            }
          }

          // 将工具结果追加到消息历史
          apiMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: resultText,
          })

          // 保存工具结果到数据库
          // hiddenRepair 模式跳过——本轮的 user/assistant 都不入库，孤儿 tool 行会让
          // loadMessages 回灌时显示一条没有上下文的"工具调用结果"气泡，污染对话视图。
          if (!isHiddenRepair) {
            try {
              await window.electronAPI.saveMessage(conversationId, 'tool', resultText, tc.id)
            } catch (saveErr) {
              const msg = saveErr instanceof Error ? saveErr.message : String(saveErr)
              window.electronAPI.logEvent('warn', 'save-tool-message-failed', msg)
            }
          }
          if (isStale()) return
        }
        set({ toolCallStatus: '' })

        // 压缩更早轮次的 tool 结果，防止累积撑爆 context
        compressOldToolResults(apiMessages)

        if (round === SOFT_WARN_ROUNDS && !softWarnInjected) {
          apiMessages.push({
            role: 'system',
            content: `[系统提示] 已执行 ${SOFT_WARN_ROUNDS} 轮工具调用。
如果当前任务接近完成，请基于已有信息直接给最终答案；
如果确实需要继续，请在下一条回复开头说明"继续工具调用的原因：xxx"，然后继续。
硬上限 ${HARD_MAX_ROUNDS} 轮，到达后会强制停止。`,
          })
          softWarnInjected = true
          logPerf('tool-loop:soft-warn', `round=${round}`)
          safeEmit({
            type: 'tool-loop:soft-warn',
            conversationId,
            timestamp: Date.now(),
            round,
          })
        }

        // 收敛模式下仅注入一次简短指令，强制下一轮直接给最终答案，避免冗长分析。
        // 关键约束：必须输出 message.content 正文（用户唯一可见的部分），
        // 不允许把 budget 全部消耗在 reasoning_content 上导致正文空白（2026-05-22 真实事故）。
        if (ENABLE_CONVERGE_FINAL_ROUND_SPEEDUP && forceConvergeNoTools && !convergeHintInjected) {
          apiMessages.push({
            role: 'user',
            content: '[系统提示] 立即基于当前已获得的数据直接输出最终答案。不要继续分析过程，不要再请求任何工具，不要重复列出中间推理。\n\n**输出形式硬性要求**：必须以 markdown 正文形式写入 message.content（用户主回答区）。reasoning_content / thinking 内容用户看不到，只有 message.content 会被展示。如果只在 reasoning 里推理而 content 为空，等同于没有回答。本轮 reasoning 控制在 200 字以内，把 token 留给正文。',
          })
          convergeHintInjected = true
          logPerf('tool-loop:converge-hint-injected', `round=${round}`)
        }

        // 继续下一轮对话
        await runRoundWithTimeout()
        if (isStale()) return
        if (await correctDsmlToolCallLeak() && isStale()) return
      }

      if (pendingToolCalls && pendingToolCalls.length > 0 && round >= HARD_MAX_ROUNDS) {
        logPerf('tool-loop:hard-stop', `maxRounds=${HARD_MAX_ROUNDS}`)
        safeEmit({
          type: 'tool-loop:hard-stop',
          conversationId,
          timestamp: Date.now(),
          round,
        })
        apiMessages.push({
          role: 'system',
          content: `[系统硬上限] 工具调用已达到 ${HARD_MAX_ROUNDS} 轮，必须停止继续调用工具。请基于当前已获得的信息给出最终答案；若信息不足，请明确说明已尝试的工具路径和缺失数据。`,
        })
        forceConvergeNoTools = true
        pendingToolCalls = undefined
        await runRoundWithTimeout()
        if (isStale()) return
      }

      // ─── B 兜底：承诺未兑现 retry（覆盖 doc 落盘 + 图表代码块两种） ─────────────
      // 触发条件（任一缺失即触发）：
      //
      // [doc 缺失] 触发条件：
      //   1) 用户 prompt 含文档生成意图（"落成/落盘/生成/出一份/做成" + "PDF/word/docx/md/文档/报告/方案/ADR/纪要"）
      //   2) assistant 文本里出现交付承诺（"将落盘 / 已生成 / 立即落盘 / 现在将...落盘"）
      //   3) toolCallSequence 里没调过 generate_document
      //
      // [chart 缺失] 触发条件：
      //   1) 用户 prompt 含图表生成意图（柱状图/信息图/SWOT/对比卡 等触发词）
      //   2) assistant 文本里出现交付承诺（"已输出 / 已生成 / 三个交付物均已输出"等）
      //   3) content 里 ``` chart / ``` infographic / ``` mermaid 代码块数量 < prompt 要求的图表数量
      //
      // 共同前提：
      //   - 还没用过 retry slot（emptyTextRetryMode === false）
      //   - inner while 已经退出（pendingToolCalls 空，模型自然 stop）
      //
      // 动作：注入统一提示要求补 generate_document tool_call + chart/infographic 代码块 →
      //      跑一轮 LLM → continue 让外层 do-while 让内层 while 执行 generate_document（如有 emit）。
      //
      // 真实事故：
      // - 2026-05-22 (doc): 分身写了完整 ADR + 末尾"现在将完整 ADR 落盘"，但 stop 没调 generate_document
      // - 2026-05-22 (chart): 分身 reasoning 18K+ 字"想象"了 3 个图表，content 只一句"已输出"
      //   没有任何 ```chart / ```infographic 代码块

      // [doc 缺失] 检测
      const docTriggerInPrompt = /落成|落盘|生成|出一份|做成|写一份|做个/.test(content)
        && /pdf|word|docx|markdown|md\b|文档|报告|方案|adr|纪要|协议|说明书|意见书/i.test(content)
      const docCommitmentInText = /(?:将|准备|立即|马上|现在).{0,8}(?:落盘|生成|落成|交付)/.test(assistantText)
        || /已(?:落盘|生成|落成|交付)/.test(assistantText)
      const generateDocAlreadyCalled = apiMessages.some(m => {
        if (m.role !== 'assistant') return false
        const tcs = (m as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls
        return Array.isArray(tcs) && tcs.some(tc => tc.function?.name === 'generate_document')
      })
      const docMissing = docTriggerInPrompt && docCommitmentInText && !generateDocAlreadyCalled

      // [chart 缺失] 检测：按用户 prompt 推算"应有"的图表类别数 vs content 实际代码块数
      const wantsDataChart = /柱状图|折线图|饼图|散点图|趋势图|对比图|分布图|雷达|桑基|热力|chart\b/i.test(content)
      const wantsInfographic = /信息图|infographic|swot|对比卡|分类卡|分类卡片|金字塔|词云|演示图/i.test(content)
      const wantsMermaid = /甘特|流程图|时序图|思维导图|状态机|er图|看板|mermaid/i.test(content)
      const expectedChartTypes = (wantsDataChart ? 1 : 0) + (wantsInfographic ? 1 : 0) + (wantsMermaid ? 1 : 0)
      const actualChartBlocks = (assistantText.match(/```(?:chart|infographic|mermaid)/gi) || []).length
      const chartCommitmentInText = /(?:已|完成|三个|两个|多个).{0,12}(?:输出|生成|绘制|画出|交付物)/.test(assistantText)
        || /(?:输出|生成|绘制).{0,4}(?:完毕|完成|完了)/.test(assistantText)
      const chartMissing = expectedChartTypes > 0
        && chartCommitmentInText
        && actualChartBlocks < expectedChartTypes

      const shouldRetryFinalCommitment =
        !emptyTextRetryMode &&
        toolLoopStartedAt !== null &&
        (!pendingToolCalls || pendingToolCalls.length === 0) &&
        (docMissing || chartMissing)

      if (shouldRetryFinalCommitment) {
        const retryKind = docMissing && chartMissing ? 'doc+chart-unfulfilled'
          : docMissing ? 'doc-commitment-unfulfilled'
          : 'chart-commitment-unfulfilled'
        logPerf(
          'tool-loop:final-retry-start',
          `kind=${retryKind} textLen=${assistantText.length} expectedCharts=${expectedChartTypes} actualBlocks=${actualChartBlocks}`,
        )
        emptyTextRetryMode = true
        // 推上一轮 assistant 内容 + reasoning（thinking 模型多轮 round-trip 必须原样回传）
        apiMessages.push({
          role: 'assistant',
          content: assistantText,
          reasoning_content: roundReasoningText || undefined,
        })
        // 根据 doc / chart 缺失情况动态组装 retry 提示
        const retryPromptParts: string[] = []
        retryPromptParts.push('[系统提示] 你刚才在回答里写了交付承诺（"已输出 / 已生成 / 三个交付物均已输出 / 将落盘"等），但实际**没有完整交付**。')
        retryPromptParts.push('')
        if (docMissing) {
          retryPromptParts.push('## 缺失 1：generate_document 工具调用')
          retryPromptParts.push('你说"将落盘 / 已生成 文档"，但 toolCallSequence 里**没有 generate_document**——只在 content 写了承诺就停了。')
          retryPromptParts.push('请**立即发起 tool_call** 调一次 generate_document：')
          retryPromptParts.push('- format: "md"')
          retryPromptParts.push('- ir: 基于上面已经写好的内容构造（含 frontmatter title）')
          retryPromptParts.push('- filename: 有意义的名字')
          retryPromptParts.push('')
        }
        if (chartMissing) {
          const missingHint: string[] = []
          if (wantsDataChart && !/```chart/i.test(assistantText)) missingHint.push('` ```chart ` ECharts 代码块（柱状图/折线/饼图等）')
          if (wantsInfographic && !/```infographic/i.test(assistantText)) missingHint.push('` ```infographic ` 信息图代码块（SWOT/对比卡/分类卡）')
          if (wantsMermaid && !/```mermaid/i.test(assistantText)) missingHint.push('` ```mermaid ` 代码块（甘特/流程图/时序）')
          retryPromptParts.push('## 缺失 2：图表代码块')
          retryPromptParts.push(`你说"已输出图表 / 三个交付物均已输出"，但 message.content 里实际只有 ${actualChartBlocks} 个代码块，少于 prompt 要求的 ${expectedChartTypes} 个。`)
          retryPromptParts.push('缺以下代码块（请在 content 里直接输出，不要在 reasoning 里规划）：')
          missingHint.forEach(h => retryPromptParts.push(`- ${h}`))
          retryPromptParts.push('')
          retryPromptParts.push('**注意**：reasoning_content 里写 "我准备输出 chart 代码块" 不算交付，必须把代码块**实际写在 message.content** 里用户才看得到。')
        }
        retryPromptParts.push('')
        retryPromptParts.push('请补齐以上缺失项。本轮 reasoning 控制在 100 字以内，把所有 budget 留给：(a) tool_call 调用 (b) content 里的代码块。不要再重写已经写好的文字部分。')
        apiMessages.push({
          role: 'user',
          content: retryPromptParts.join('\n'),
        })
        // 关键：让工具可用（与 A 兜底相反——A 关 tools，B 必须开 tools）
        forceConvergeNoTools = false
        pendingToolCalls = undefined
        try {
          await runRoundWithTimeout()
          if (isStale()) return
        } catch (retryErr) {
          const m = retryErr instanceof Error ? retryErr.message : String(retryErr)
          logPerf('tool-loop:final-retry-failed', `kind=${retryKind} ${m}`)
        }
        // runRound 的 onDone 闭包回调会重设 pendingToolCalls。TS 控制流分析无法跨越
        // 异步回调边界判断，会把 pendingToolCalls 锁定为 `undefined`，所以这里显式
        // 重读为 ToolCall[] | undefined 绕过类型窄化，行为本身不变。
        const pendingAfterRetry = pendingToolCalls as ToolCall[] | undefined
        const finalChartBlocks = (assistantText.match(/```(?:chart|infographic|mermaid)/gi) || []).length
        logPerf(
          'tool-loop:final-retry-done',
          `kind=${retryKind} emitsToolCalls=${(pendingAfterRetry?.length ?? 0) > 0} textLen=${assistantText.length} chartBlocks=${finalChartBlocks}`,
        )
        // 如果 LLM emit 了 tool_calls（含 generate_document），continue 让外层 do-while 让内层 while
        // 跑一遍：执行工具 → 再跑一轮 LLM 让它写"已生成"确认。
        if (pendingAfterRetry && pendingAfterRetry.length > 0) continue
      }
      break
      // eslint-disable-next-line no-constant-condition -- do-while-true 是 tool-loop 的 idiomatic 控制流，break 由 round 上限/收敛条件触发；改 for(;;) 会丢失 do 块语义
      } while (true)

      if (toolLoopStartedAt !== null) {
        logPerf('tool-loop:done', `rounds=${round} calls=${toolCallCount} duration=${Date.now() - toolLoopStartedAt}ms`)
      }

      // A 方案兜底：两种被截断/空白模式都触发同一个 retry 流程（共用同一个 mode 标志，
      // 重试一次后失败就放弃，不无限循环）。
      //
      // 模式 1（empty-text）：正文 trim 后为空 + reasoning ≥ 100 字 —— reasoning model
      //   偶发把 budget 全消耗在 reasoning_content 上、message.content 留空。
      // 模式 2（truncated）：上一轮 outputTokens 打满 maxTokens（lastRoundOutputTruncated=true）
      //   + 正文 > 0（说明有写但写到一半被切）—— 收敛轮的 maxTokens 不够装下复合任务输出。
      //
      // 重试策略：放开 maxTokens（emptyTextRetryMode=true → 不再受 CONVERGE_FINAL_ROUND_MAX_TOKENS 约束），
      // 注入对应场景的修正提示，强制无工具，跑一次 runRoundWithTimeout。
      const isEmptyTextCase =
        assistantText.trim() === '' && reasoningText.trim().length >= 100
      const isTruncatedCase =
        lastRoundOutputTruncated && assistantText.trim().length > 0
      const shouldRetry =
        !emptyTextRetryMode &&
        (isEmptyTextCase || isTruncatedCase) &&
        toolLoopStartedAt !== null &&
        !hasDsmlToolCallLeak(assistantText)

      if (shouldRetry) {
        const retryKind = isEmptyTextCase ? 'empty-text' : 'truncated'
        logPerf(
          'tool-loop:final-retry-start',
          `kind=${retryKind} textLen=${assistantText.length} reasoningLen=${reasoningText.length}`,
        )
        // 截断模式需要保留上一轮的部分正文 + reasoning，让模型从断点接续
        apiMessages.push({
          role: 'assistant',
          content: assistantText,
          reasoning_content: roundReasoningText || undefined,
        })
        if (isEmptyTextCase) {
          apiMessages.push({
            role: 'user',
            content: '[系统提示] 上一轮你只输出了 reasoning_content（思考过程）但 message.content 为空。用户只能看到 content，看不到 reasoning。请基于刚才的思考，直接以 markdown 正文形式输出最终答案到 content。不要再调用任何工具，不要再展开新的分析，直接给答案。本轮 reasoning 控制在 50 字以内。',
          })
        } else {
          apiMessages.push({
            role: 'user',
            content: '[系统提示] 上一轮的正文被 max_tokens 截断了（你看到的 assistant 消息是被切到一半的）。请从断点处**继续接着写**，把没写完的部分补完。不要重写已经写过的内容，不要再调用工具，直接续写到结束。本轮 reasoning 控制在 50 字以内，把所有 budget 留给正文。',
          })
        }
        emptyTextRetryMode = true
        forceConvergeNoTools = true
        pendingToolCalls = undefined
        const truncatedTextSnapshot = isTruncatedCase ? assistantText : ''
        try {
          await runRoundWithTimeout()
          // 截断接续模式：runRound 在新一轮开始会清空 assistantText，需要手动拼接断点前的部分
          if (!isStale() && isTruncatedCase && truncatedTextSnapshot && assistantText) {
            assistantText = truncatedTextSnapshot + assistantText
          }
          if (!isStale()) {
            logPerf(
              'tool-loop:final-retry-done',
              `kind=${retryKind} textLen=${assistantText.length} reasoningLen=${reasoningText.length}`,
            )
          }
        } catch (retryErr) {
          const m = retryErr instanceof Error ? retryErr.message : String(retryErr)
          logPerf('tool-loop:final-retry-failed', `kind=${retryKind} ${m}`)
          // 截断 retry 失败时至少保留已有部分正文，不要把用户已经看到的内容丢掉
          if (isTruncatedCase && !assistantText && truncatedTextSnapshot) {
            assistantText = truncatedTextSnapshot
          }
        }
        if (isStale()) return
      }

      if (hasDsmlToolCallLeak(assistantText)) {
        window.electronAPI.logEvent('error', 'dsml-tool-call-leak-unresolved', assistantText.slice(0, 200))
        assistantText = '抱歉，模型返回了无法展示的工具调用协议文本。请重试，我会要求模型使用正确的工具调用格式。'
      }

      // 图表答案 cache 写入：chartConsistencyMode 命中且最终回答含 ```chart 块时落盘。
      // 渲染侧调用 IPC，主进程侧展开 soul.md + _excel/<basename>.json 做 (mtimeMs, size) 快照。
      if (chartConsistencyMode && /```chart/.test(assistantText)) {
        try {
          for (const basename of collectQueryExcelBasenamesFromApiMessages(apiMessages)) {
            excelBasenamesUsed.add(basename)
          }
          const chartQueryHash = hashQueryContent(content)
          await window.electronAPI.saveChartCacheEntry(avatarId, {
            queryHash: chartQueryHash,
            queryPreview: content,
            assistantContent: assistantText,
            excelBasenames: Array.from(excelBasenamesUsed),
          })
          logPerf('chart-cache:saved', `queryHash=${chartQueryHash} basenames=${excelBasenamesUsed.size}`)
        } catch (saveErr) {
          // 写 cache 失败绝不影响正常对话
          void saveErr
        }
      }

      // 所有工具调用结束，处理最终回复
      const { cleanText: memCleanText, updates: memUpdates } = extractMemoryUpdates(assistantText)
      const { cleanText: userCleanText, updates: userUpdates } = extractUserUpdates(memCleanText)
      // v18 OpenClaw 借鉴：抽 [STANDING_ORDER] 长期工作流规则（独立 channel，不进 MEMORY.md）
      const { cleanText: soCleanText, orders: standingOrders } = extractStandingOrders(userCleanText)
      // v17 deliberation：抽 UNCERTAIN/RECONSIDER 标记。放在 skillCreate 之前——
      // 这两个 marker 不删原文做卡片，是直接从展示文里抽掉只留 chip。
      const { cleanText: uncCleanText, markers: uncertainMarkers } = extractUncertain(soCleanText)
      const { cleanText: recCleanText, markers: reconsiderMarkers } = extractReconsider(uncCleanText)
      const { cleanText, proposals: skillProposals } = extractSkillCreate(recCleanText)
      const hasUpdates = memUpdates.length > 0 || userUpdates.length > 0 || skillProposals.length > 0 || standingOrders.length > 0
      const displayText = cleanText || assistantText || (hasUpdates ? '（已更新记忆/画像/技能）' : '')

      // GAP2: 如果有 memory 更新，追加写入记忆文件（含容量管理）
      if (memUpdates.length > 0) {
        try {
          const currentMemory = await window.electronAPI.readMemory(avatarId)
          const timestamp = localDateString()
          const newEntries = memUpdates.map(u => `\n<!-- ${timestamp} -->\n${u}`).join('\n')
          const merged = currentMemory + newEntries

          // 容量管理：超过上限时先备份再调用 LLM 整理
          let finalContent = merged
          let consolidatedRan = false
          if (merged.length >= MEMORY_CHAR_LIMIT) {
            try {
              // 备份当前记忆，防止 LLM 整理结果异常导致数据丢失
              await window.electronAPI.writeMemory(avatarId, merged)
              const [apiKey, baseUrl] = await Promise.all([
                window.electronAPI.getSetting('chat_api_key').then(v => v ?? ''),
                window.electronAPI.getSetting('chat_base_url').then(v => v ?? ''),
              ])
              const consolidated = await window.electronAPI.consolidateMemory(avatarId, merged, apiKey, baseUrl)
              if (consolidated && consolidated.length > 50) {
                finalContent = consolidated
                consolidatedRan = true
              } else {
                window.electronAPI.logEvent('warn', 'memory-consolidate-too-short', `整理结果过短(${consolidated?.length ?? 0}字)，保留原内容`)
              }
            } catch (consolidateErr) {
              const msg = consolidateErr instanceof Error ? consolidateErr.message : String(consolidateErr)
              console.error('记忆整理失败，保留已备份的原内容:', msg)
              window.electronAPI.logEvent('error', 'memory-consolidate-error', msg)
            }
          }
          await window.electronAPI.writeMemory(avatarId, finalContent)
          // v17 事件日志：写入成功后记录元信息（不含正文）。
          // summaryPreview 截断到 500 字符——逐条 update 取前 N 字符拼起来再裁，避免单行过大。
          const summaryPreview = memUpdates.join(' · ').slice(0, 500)
          void window.electronAPI.recordMemoryUpdateEvent(conversationId, avatarId, {
            updateCount: memUpdates.length,
            summaryPreview,
            totalByteSize: finalContent.length,
            consolidated: consolidatedRan,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('写入记忆失败:', msg)
          window.electronAPI.logEvent('error', 'memory-write-error', msg)
        }
      }

      // Feature 3: 如果有用户画像更新，追加写入 USER.md（带容量检查）
      if (userUpdates.length > 0) {
        try {
          const currentProfile = await window.electronAPI.readUserProfile(avatarId)
          const timestamp = localDateString()
          const newEntries = userUpdates.map(u => `\n<!-- ${timestamp} -->\n${u}`).join('\n')
          const mergedProfile = currentProfile + newEntries

          // USER.md 容量检查：超过上限时先整理再写入
          let finalProfile = mergedProfile
          if (mergedProfile.length >= MEMORY_CHAR_LIMIT) {
            try {
              const [apiKey, baseUrl] = await Promise.all([
                window.electronAPI.getSetting('chat_api_key').then(v => v ?? ''),
                window.electronAPI.getSetting('chat_base_url').then(v => v ?? ''),
              ])
              finalProfile = await window.electronAPI.consolidateMemory(avatarId, mergedProfile, apiKey, baseUrl)
            } catch (consolidateErr) {
              const msg = consolidateErr instanceof Error ? consolidateErr.message : String(consolidateErr)
              window.electronAPI.logEvent('warn', 'profile-consolidate-failed', msg)
            }
          }
          await window.electronAPI.writeUserProfile(avatarId, finalProfile)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('写入用户画像失败:', msg)
          window.electronAPI.logEvent('error', 'user-profile-write-error', msg)
        }
      }

      // v18 OpenClaw 借鉴：standing orders 落盘到 memory/standing-orders.md
      // 不做容量整理（上限拒绝写而不是 consolidate），不允许 LLM 删除规则
      if (standingOrders.length > 0) {
        for (const order of standingOrders) {
          try {
            const res = await window.electronAPI.appendStandingOrder(avatarId, order, conversationId)
            if (!res.ok) {
              // 写入失败（如达上限）— 静默 warn，主流程继续
              window.electronAPI.logEvent('warn', 'standing-order-append-failed', `${res.error ?? 'unknown'}: ${order.slice(0, 100)}`)
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            window.electronAPI.logEvent('error', 'standing-order-write-error', msg)
          }
        }
      }

      // Phase 2: 自动沉淀优质回答到 wiki/qa/（启发式判断，设置开关控制）
      try {
        const autoSediment = await window.electronAPI.getSetting('wiki_auto_sediment')
        if (autoSediment === 'true' && shouldSediment(displayText)) {
          await window.electronAPI.saveWikiAnswer(avatarId, {
            id: `qa-${Date.now()}`,
            question: content,
            answer: displayText,
            sources: [],
            savedAt: localDateString(),
          })
        }
      } catch (saveErr) {
        // 自动沉淀失败不影响正常对话
        void saveErr
      }

      if (isStale()) return

      // 关键修复（2026-05-21 用户反馈"问题答完但任务没有结束"）：Agent 模式 LLM 输出
      // 最终答案后，经常忘记 todo_write 把最后一个 in_progress 任务标 completed，
      // 导致 TASKS 面板永远卡在 "3/4 · 进行中"。这里在自然收束时兜底封存：
      //   - in_progress → completed（LLM 实际做完，只是漏 update）
      //   - pending → cancelled（LLM 没动，答案已吐完，不会回来做了）
      //
      // 截断保护（2026-05-22 真实事故）：如果上一轮被 max_tokens 截断（lastRoundOutputTruncated=true），
      // pending 任务**不应该**被标 cancelled——模型本来想做但没机会，标 cancelled 会让
      // 用户误判"被取消"。保持 pending 让用户看到真相（"未完成"）。
      let sealedTasksUpdate: AgentTask[] | null = null
      if (isViewedConv()) {
        const currentTasks = get().tasks
        if (currentTasks.length > 0) {
          const candidate = currentTasks.map(t => {
            if (t.status === 'in_progress') return { ...t, status: 'completed' as const }
            // pending 默认 cancel，但被截断时保留 pending（模型没机会做完）
            if (t.status === 'pending' && !lastRoundOutputTruncated) return { ...t, status: 'cancelled' as const }
            return t
          })
          if (candidate.some((s, i) => s.status !== currentTasks[i].status)) {
            sealedTasksUpdate = candidate
            persistTasks(conversationId, candidate)
            const sealedCount = candidate.filter((s, i) => s.status !== currentTasks[i].status).length
            logPerf('tasks:auto-seal', `count=${sealedCount} total=${currentTasks.length} truncated=${lastRoundOutputTruncated}`)
          }
        }
      }

      if (isViewedConv() && !isHiddenRepair) {
        set((state) => ({
          messages: upsertLastAssistant(
            state.messages,
            assistantMsgId,
            displayText,
            reasoningText,
            collectedDocumentAttachments,
            uncertainMarkers,
            reconsiderMarkers,
          ),
          isLoading: false,
          toolCallStatus: '',
          skillProposals,
          ...(sealedTasksUpdate ? { tasks: sealedTasksUpdate } : {}),
        }))
      }

      if (isStale()) return
      // hiddenRepair 跳过 saveMessage / episode / cache 三段——不入库、不抽取、不污染缓存。
      // 但仍走 phase05 埋点（带 hiddenRepair=1 标记，便于后续过滤）+ infographic-revalidate
      // 检测段（其实 skipInfographicRevalidate=true 自动短路，但加 isHiddenRepair 守卫更清晰）。
      if (!isHiddenRepair) {
        try {
        // 把流式累积的 reasoningText 一并落盘，让切换会话回来仍能恢复 thinking 折叠区。
        // 非 thinking 模型 reasoningText 是空串，saveMessage 内部按 trim 长度判定存 NULL。
        // v17：连带把 [UNCERTAIN]/[RECONSIDER] 抽出的标记数组一起落盘。
        // v19：把本轮 sendMessage 累积的工具调用时间线落盘，让切对话/重启后仍能看到。
        //
        // 2026-05-24 修复：取 timeline 时优先 streamingSnapshot.toolCallTimeline，
        // 回退到 messages 查找。原实现只查 messages，如果用户切走视图后流式跑完，
        // 当前 messages 是别的会话的，find 返回 undefined → timeline 落库为空。
        // snapshot 在 appendToolCallTimeline 时同步累积，且只会被本请求的 cleanupRequest
        // 清掉（cleanupRequest 在 saveMessage 之后才跑），所以这里 snapshot 一定还在。
        const snapshotTimeline =
          streamingSnapshot?.conversationId === conversationId
          && streamingSnapshot?.assistantMsgId === assistantMsgId
            ? streamingSnapshot.toolCallTimeline
            : null
        const messageTimeline = get().messages.find(m => m.id === assistantMsgId)?.toolCallTimeline ?? []
        const timelineForSave = snapshotTimeline ?? messageTimeline
        const timelineJson = timelineForSave.length > 0 ? JSON.stringify(timelineForSave) : undefined
        await window.electronAPI.saveMessage(
          conversationId,
          'assistant',
          displayText,
          undefined,
          undefined,
          reasoningText || undefined,
          uncertainMarkers.length > 0 ? uncertainMarkers : undefined,
          reconsiderMarkers.length > 0 ? reconsiderMarkers : undefined,
          timelineJson,
          assistantMsgId,  // 关键：让 DB 复用前端 nextMessageId() 已生成的 ID，hidden repair 的 updateMessageContent 才能命中
        )
      } catch (saveErr) {
        const msg = saveErr instanceof Error ? saveErr.message : String(saveErr)
        console.error('[chatStore] 保存助手消息失败:', msg)
        window.electronAPI.logEvent('error', 'save-assistant-message-error', msg)
      }
      // v17 Phase 2a：对话情景记忆 lazy 抽取触发（fire-and-forget）。
      // 时机：每次成功完成一轮 assistant 回复后。如果消息条数 > 已有 episode.messageCount，
      // 主进程会自动重抽，否则幂等跳过。避免阻塞 UI——所有失败仅 warn 不抛。
      void (async () => {
        try {
          const [apiKey, baseUrl] = await Promise.all([
            window.electronAPI.getSetting('chat_api_key').then(v => v ?? ''),
            window.electronAPI.getSetting('chat_base_url').then(v => v ?? ''),
          ])
          if (!apiKey || !baseUrl) return // 用户没配 LLM 凭据，跳过
          const r = await window.electronAPI.extractConversationEpisode(avatarId, conversationId, apiKey, baseUrl)
          if (!r.ok && r.reason && !r.reason.includes('未变化')) {
            // 真实失败才记 warn——"消息条数未变化"是正常跳过
            window.electronAPI.logEvent('warn', 'extract-conversation-episode', r.reason)
          }
        } catch (extractErr) {
          // 抽取失败绝不影响用户体验
          const m = extractErr instanceof Error ? extractErr.message : String(extractErr)
          window.electronAPI.logEvent('warn', 'extract-conversation-episode-throw', m)
        }
      })()

      // ─── 写答案缓存（v14）─────────────────────────────────────────────
      // 只在常规对话写：cacheBypassed 路径（含 skipCache=true 的"重新生成"）跳过，
      // 避免覆盖原稳定答案。
      if (!cacheBypassed && displayText.trim().length > 0) {
        try {
          const cacheKey = deriveAnswerCacheKey(avatarId, conversationId, content, messages)
          await window.electronAPI.saveCachedAnswer({
            cacheKey,
            avatarId,
            conversationId,
            userContent: content,
            assistantContent: displayText,
            reasoningContent: reasoningText || null,
            model: activeModel.model,
          })
        } catch (cacheSaveErr) {
          const m = cacheSaveErr instanceof Error ? cacheSaveErr.message : String(cacheSaveErr)
          window.electronAPI.logEvent('warn', 'answer-cache-save-error', m)
        }
      }
      } // ← 闭合 if (!isHiddenRepair) { saveMessage / episode / cache 三段
      logPerf('sendMessage:success', `total=${Date.now() - requestStartedAt}ms displayLen=${displayText.length}${isHiddenRepair ? ' hiddenRepair' : ''}`)
      // Phase 0.5 结构化埋点：写持久日志，2 周后聚合分析（按分身的 search_knowledge 触发率/命中率/TTFT）。
      // hiddenRepair=1 标记便于事后过滤掉修正轮的 LLM 调用，避免混在常规对话指标里。
      window.electronAPI.logEvent(
        'info',
        'phase05-query-summary',
        `avatar=${avatarId} status=ok queryLen=${content.length} hiddenRepair=${isHiddenRepair ? 1 : 0} hasImages=${Boolean(images && images.length > 0)} hasAttachments=${Boolean(attachments && attachments.length > 0)} searchCalls=${phase05SearchKnowledgeCalls} searchResultLen=${phase05SearchKnowledgeResultLen} ttftMs=${phase05FirstTokenAt > 0 ? phase05FirstTokenAt - requestStartedAt : -1} totalMs=${Date.now() - requestStartedAt}`,
      )

      // #C 方案：infographic 输出 validator + 自动追问。
      // 检测 displayText 中所有 ```infographic 代码块；若任一不合法且 coerce 救不了，
      // 触发一次隐藏 follow-up 让 LLM 修正。skipInfographicRevalidate=true 时不递归。
      // hiddenRepair 也跳过——本轮就是修正轮，不允许再嵌套触发。
      if (!options?.skipInfographicRevalidate && !isHiddenRepair && !isStale()) {
        void (async () => {
          try {
            const { extractInfographicBlocks, validateInfographicBlock, buildRevalidatePrompt } =
              await import('../services/infographic-validator')
            const blocks = extractInfographicBlocks(displayText)
            if (blocks.length === 0) return
            const firstBad = blocks.find(b => !validateInfographicBlock(b.raw).ok)
            if (!firstBad) return
            const { errors } = validateInfographicBlock(firstBad.raw)
            window.electronAPI.logEvent(
              'info',
              'infographic-revalidate-triggered',
              `errors=${errors.length}: ${errors.map(e => e.kind).join(',')}`,
            )
            const revisePrompt = buildRevalidatePrompt(firstBad.raw, errors)
            // 用同一 sendMessage 链路追问：
            //   - skipInfographicRevalidate 防递归
            //   - skipCache 不污染答案缓存
            //   - hiddenRepair：修正 prompt 对用户完全不可见（不入历史、不入 DB、
            //     不计费、不触发自动改名 / episode 抽取）
            // 修正完成后从返回的 displayText 提取新 infographic 块，替换原
            // assistant 消息里的 bad block，并写回 DB（update-message-content
            // IPC）+ state.messages —— 完整闭环。
            const repairResult = await get().sendMessage(
              revisePrompt,
              conversationId,
              avatarId,
              undefined,
              visionModel,
              undefined,
              undefined,
              undefined,
              { skipCache: true, skipInfographicRevalidate: true, hiddenRepair: true },
            )
            if (!repairResult) return
            const repairedBlocks = extractInfographicBlocks(repairResult.displayText)
            const firstGood = repairedBlocks.find(b => validateInfographicBlock(b.raw).ok)
            if (!firstGood) {
              window.electronAPI.logEvent('warn', 'infographic-repair-still-invalid',
                `repair output 仍无合法 infographic 块（blocks=${repairedBlocks.length}）`)
              return
            }
            const newDisplayText = displayText.replace(firstBad.raw, firstGood.raw)
            if (newDisplayText === displayText) {
              // 修正块和原 bad 块完全相同（理论不该发生），跳过写入避免无意义 DB I/O
              window.electronAPI.logEvent('warn', 'infographic-repair-no-diff', 'repaired block === bad block')
              return
            }
            try {
              await window.electronAPI.updateMessageContent(assistantMsgId, newDisplayText)
              set((s) => ({
                messages: s.messages.map(m =>
                  m.id === assistantMsgId ? { ...m, content: newDisplayText } : m,
                ),
              }))
              // 同步覆盖答案缓存：line ~4978 saveCachedAnswer 用的是修正前的 displayText，
              // 之后同问命中 cache 直接早退（line ~3304），不会再跑 validator → 永远吐
              // 坏 infographic。这里用 newDisplayText 覆盖（saveCachedAnswer 是 INSERT OR
              // REPLACE），下一次同问就能拿到修正版。cacheBypassed 时本来就没写过 cache，
              // 跳过避免创建一条不该存在的 cache 项。
              if (!cacheBypassed) {
                try {
                  const cacheKey = deriveAnswerCacheKey(avatarId, conversationId, content, messages)
                  await window.electronAPI.saveCachedAnswer({
                    cacheKey,
                    avatarId,
                    conversationId,
                    userContent: content,
                    assistantContent: newDisplayText,
                    reasoningContent: reasoningText || null,
                    model: activeModel.model,
                  })
                } catch (cacheUpdateErr) {
                  const m = cacheUpdateErr instanceof Error ? cacheUpdateErr.message : String(cacheUpdateErr)
                  window.electronAPI.logEvent('warn', 'infographic-repair-cache-update-failed', m)
                }
              }
              window.electronAPI.logEvent('info', 'infographic-repair-applied',
                `assistantMsgId=${assistantMsgId} oldLen=${firstBad.raw.length} newLen=${firstGood.raw.length}`)
            } catch (writeErr) {
              const m = writeErr instanceof Error ? writeErr.message : String(writeErr)
              window.electronAPI.logEvent('warn', 'infographic-repair-writeback-failed', m)
            }
          } catch (validateErr) {
            const m = validateErr instanceof Error ? validateErr.message : String(validateErr)
            window.electronAPI.logEvent('warn', 'infographic-revalidate-error', m)
          }
        })()
      }

      safeEmit({
        type: 'message-done',
        conversationId,
        timestamp: Date.now(),
        content: displayText,
      })
      await invokeProxyComplete({ ok: true, assistantText: displayText })
      // 流式完成：cleanupRequest 内部自检 requestId/abortController/assistantMsgId，
      // 即使 isStale 也是 no-op；不再依赖外层判断。
      cleanupRequest()
      // 把 displayText 返回给调用方。常规 caller 不接收（向后兼容隐式 void），
      // 但 infographic hiddenRepair 闭环需要拿到这条修正轮的 displayText 才能回写。
      return { displayText, assistantMsgId }
    } catch (error) {
      if (isStale()) return
      const errMsg = error instanceof Error ? error.message : String(error)
      console.error('对话失败:', errMsg)
      window.electronAPI.logEvent('error', 'chat-error', errMsg)
      logPerf('sendMessage:error', errMsg)
      // Phase 0.5 结构化埋点（失败路径也记，方便分析"未触发 search 是因为出错"还是"LLM 没决定 call"）
      window.electronAPI.logEvent(
        'info',
        'phase05-query-summary',
        `avatar=${avatarId} status=error queryLen=${content.length} hiddenRepair=${isHiddenRepair ? 1 : 0} hasImages=${Boolean(images && images.length > 0)} hasAttachments=${Boolean(attachments && attachments.length > 0)} searchCalls=${phase05SearchKnowledgeCalls} searchResultLen=${phase05SearchKnowledgeResultLen} ttftMs=${phase05FirstTokenAt > 0 ? phase05FirstTokenAt - requestStartedAt : -1} totalMs=${Date.now() - requestStartedAt} err=${errMsg.slice(0, 80)}`,
      )
      safeEmit({
        type: 'conversation-error',
        conversationId,
        timestamp: Date.now(),
        error: errMsg,
      })
      await invokeProxyComplete({ ok: false, error: errMsg })
      // hiddenRepair 模式：错误消息也不入 UI / 不入 DB，对用户完全静默；
      // 失败仅靠 phase05 埋点 + chat-error 日志记账。
      if (!isHiddenRepair) {
        const errorMessage = `抱歉，发生了错误：${errMsg}`
        if (isViewedConv()) {
          set((state) => ({
            messages: upsertLastAssistant(state.messages, assistantMsgId, errorMessage),
            isLoading: false,
            toolCallStatus: '',
          }))
        }
        try {
          await window.electronAPI.saveMessage(conversationId, 'assistant', errorMessage)
        } catch (saveErr) {
          console.error('[chatStore] 保存错误消息失败:', saveErr instanceof Error ? saveErr.message : String(saveErr))
        }
      }
      // 错误路径：cleanupRequest 自检本请求是否仍 active，避免覆盖后续请求的状态
      cleanupRequest()
    } finally {
      // 兜底：catch 内部若再次抛错而跳过上面的 cleanupRequest，这里再保险一次（幂等）。
      cleanupRequest()
    }
  },

  /**
   * 「重新生成」按钮入口（v14）。流程见 ChatStore.regenerateAssistantMessage 定义。
   */
  regenerateAssistantMessage: async (messageId, conversationId, avatarId) => {
    if (get().isLoading) return false
    const state = get()
    const idx = state.messages.findIndex((m) => m.id === messageId && m.role === 'assistant')
    if (idx < 0) return false
    // 向上找最近的 user 消息
    let userIdx = -1
    for (let i = idx - 1; i >= 0; i--) {
      if (state.messages[i].role === 'user') { userIdx = i; break }
    }
    if (userIdx < 0) return false
    const userMsg = state.messages[userIdx]
    // 还原带 anchor 的 content 为原始 user 输入（去掉 [id:mxxxx] 前缀）
    const rawContent = userMsg.content.replace(/^\[id:m\d+\]\s*/, '')

    // 从 UI 删除该 assistant 消息（及其后续 tool/follow-up 消息）。
    // 保守起见仅删该条；多轮 tool 消息留给下次清理。
    set({ messages: state.messages.filter((_, i) => i !== idx) })

    try {
      await window.electronAPI.deleteMessage(messageId)
    } catch (delErr) {
      const m = delErr instanceof Error ? delErr.message : String(delErr)
      window.electronAPI.logEvent('warn', 'regenerate-delete-message-error', m)
    }

    // skipCache=true：跳过读 + 跳过写，原 cache 保留为"稳定档"
    await get().sendMessage(
      rawContent,
      conversationId,
      avatarId,
      userMsg.imageUrls,
      undefined,
      userMsg.attachments,
      undefined,
      undefined,
      { skipCache: true },
    )
    return true
  },
  clearMessages: () => set({ messages: [], skillProposals: [], toolCallStatus: '', isLoading: false, toolCallTimeline: [] }),
}))
