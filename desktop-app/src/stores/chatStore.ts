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

/** GAP2: 从 AI 回复中提取 memory 更新标记的正则 */
const MEMORY_UPDATE_REGEX = /\[MEMORY_UPDATE\]([\s\S]*?)\[\/MEMORY_UPDATE\]/g

/** Feature 3: 从 AI 回复中提取用户画像更新标记的正则 */
const USER_UPDATE_REGEX = /\[USER_UPDATE\]([\s\S]*?)\[\/USER_UPDATE\]/g

/** Feature 6: 从 AI 回复中提取技能创建建议的正则 */
const SKILL_CREATE_REGEX = /\[SKILL_CREATE\]([\s\S]*?)\[\/SKILL_CREATE\]/g

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
 *   - ok            true=成功；false=失败（含被守卫拦截）
 *   - startedAt     开始时间戳（Date.now()），用于按时序排序/展示
 *   - kind          条目种类（默认 'tool'，向后兼容）：
 *                     tool  - LLM function-calling 工具调用（前缀 ▷）
 *                     rag   - 主进程 RAG 检索阶段事件（前缀 ⌕）
 *                     skill - Skill 路由命中事件（前缀 ★）
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
  /**
   * 会话级模型覆盖：null/缺失 = 使用分身 defaultModel 或 chatModel slot。
   * 子任务 7 UI 切换器写入；sendMessage 读取后注入 LLMService。
   */
  conversationModelOverrides: Record<string, string | null>
  /** 设置当前会话的模型覆盖；传 null 清除覆盖回到默认 */
  setConversationModel: (conversationId: string, model: string | null) => void
  setMessages: (messages: ChatMessage[]) => void
  sendMessage: (
    content: string,
    conversationId: string,
    avatarId: string,
    images?: string[],
    visionModel?: ModelConfig,
    attachments?: AttachmentRef[],
    inlineFiles?: Array<{ name: string; ext: string; mime: string; text: string }>,
    proxyOpts?: SendMessageProxyOptions,
    options?: { skipCache?: boolean },
  ) => Promise<void>
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
  appendToolCallTimeline: (entry: ToolCallTimelineEntry) => void
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
        '【路径选择】',
        '- mode="search"：按 query 检索知识片段（默认）',
        '- mode="list"：先列出有哪些知识文件再决定读哪个，query 可省略',
        '- Excel / CSV 行级数值 → 用 query_excel，禁止用本工具代替',
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
const MEMORY_NUDGE_TEXT = `[系统提示] 请回顾本次对话，如果有以下信息值得长期记住，请在回复末尾用 [MEMORY_UPDATE]...[/MEMORY_UPDATE] 标签记录：
1. 用户纠正过的错误理解
2. 用户明确表达的偏好
3. 项目相关的关键决策
如果没有需要记忆的内容，不需要添加标签，正常回答即可。`

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
 * 回归修复：1 次预算会让 schema / 小样本查询后过早收敛，行级数据无法再取。
 * 保留小预算但允许 schema → rows → fallback 三步查询，配合同参缓存和硬轮次防止拖慢。
 * 回滚方式：恢复为 1。
 */
const MAX_QUERY_EXCEL_CALLS_PER_REQUEST = 3
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
const MAX_LOAD_SKILL_CALLS_PER_REQUEST = 1
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
/** 收敛最终轮的输出长度上限，避免长篇推理拖慢响应 */
const CONVERGE_FINAL_ROUND_MAX_TOKENS = 1200
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

/** 更新或追加最后一条 assistant 消息（消除 4 处重复代码） */
function upsertLastAssistant(
  messages: ChatMessage[],
  id: string,
  content: string,
  reasoning?: string,
  documentAttachments?: DocumentAttachment[],
): ChatMessage[] {
  const withoutLast = messages.at(-1)?.role === 'assistant'
    ? messages.slice(0, -1)
    : messages
  const trimmedReasoning = reasoning?.trim()
  const attachments = documentAttachments && documentAttachments.length > 0 ? documentAttachments : undefined
  return [...withoutLast, {
    id,
    role: 'assistant',
    content,
    reasoning: trimmedReasoning ? trimmedReasoning : undefined,
    documentAttachments: attachments,
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
export function tryExtractDocumentAttachment(toolName: string, resultText: string): DocumentAttachment | null {
  try {
    const parsed: unknown = JSON.parse(resultText)
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Record<string, unknown>
    if (obj.success !== true) return null
    const filePath = typeof obj.file_path === 'string' ? obj.file_path : null
    const absolutePath = typeof obj.absolute_path === 'string' ? obj.absolute_path : null
    const sizeBytes = typeof obj.file_size_bytes === 'number' ? obj.file_size_bytes : 0
    if (!filePath || !absolutePath) return null
    if (!filePath.startsWith('exports/')) return null

    // 推断 format：优先取返回字段，其次按工具名/扩展名兜底
    let format: DocumentAttachmentFormat | null = null
    const formatRaw = obj.format
    if (typeof formatRaw === 'string' && ['md', 'pdf', 'docx', 'xlsx'].includes(formatRaw)) {
      format = formatRaw as DocumentAttachmentFormat
    } else if (toolName === 'export_excel') {
      format = 'xlsx'
    } else {
      const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
      if (['md', 'pdf', 'docx', 'xlsx'].includes(ext)) format = ext as DocumentAttachmentFormat
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

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  isLoading: false,
  systemPrompt: '',
  chatModel: DEFAULT_CHAT_MODEL,
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
    console.log(`[chatStore] setTasks: 整体覆盖任务列表，count=${tasks.length}`)
    set({ tasks })
    persistTasks(get().currentConversationId, tasks)
  },

  mergeTasks: (patch) => {
    // 计算合并结果（不放进 set 回调内是为了拿到 next 的引用做持久化）
    const state = get()
    const indexById = new Map(state.tasks.map((t, idx) => [t.id, idx]))
    const next = state.tasks.slice()
    let updated = 0
    let added = 0
    for (const p of patch) {
      const existingIdx = indexById.get(p.id)
      if (existingIdx !== undefined) {
        next[existingIdx] = { ...next[existingIdx], ...p }
        updated++
      } else {
        next.push(p)
        added++
      }
    }
    console.log(`[chatStore] mergeTasks: updated=${updated} added=${added} total=${next.length}`)
    set({ tasks: next })
    persistTasks(state.currentConversationId, next)
  },

  clearTasks: () => {
    console.log('[chatStore] clearTasks: 清空任务列表')
    set({ tasks: [] })
    persistTasks(get().currentConversationId, [])
  },

  appendToolCallTimeline: (entry) =>
    set((s) => ({ toolCallTimeline: [...s.toolCallTimeline, entry] })),

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
    options?: { skipCache?: boolean },
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

    if (get().isLoading) {
      await invokeProxyComplete({ ok: false, error: 'Soul 正有一条对话进行中（isLoading）' })
      return
    }
    // 每次新提问都清空上一轮的工具调用时间线，保证 UI 顶部只展示本轮
    set({ isLoading: true, toolCallTimeline: [] })
    const requestId = ++chatRequestSeq
    const requestStartedAt = Date.now()
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
    regressionTelemetry.emit({
      type: 'conversation-started',
      conversationId,
      timestamp: requestStartedAt,
      prompt: content,
    })
    activeChatRequest = { id: requestId, conversationId }
    if (activeAbortController) activeAbortController.abort()
    const abortController = new AbortController()
    activeAbortController = abortController
    const isStale = () =>
      !activeChatRequest
      || activeChatRequest.id !== requestId
      || activeChatRequest.conversationId !== conversationId

    // 用户当前是否还在看本次 sendMessage 所属的会话。切走时流式继续在闭包里累积
    // assistantText / reasoningText，但不实时 setState（否则会污染当前正在看的别的会话的消息列表）。
    // 切回来时下一帧 upsertLastAssistant 用累积后的全文一次性回灌；流式完成时 saveMessage 落 DB
    // 与是否在视图无关，保证答复永不丢失。
    const isViewedConv = (): boolean => get().currentConversationId === conversationId

    const { messages, systemPrompt, chatModel } = get()

    // GAP9b: 有图片时使用视觉模型
    const activeModel = (images && images.length > 0 && visionModel?.apiKey) ? visionModel : chatModel

    if (!activeModel.apiKey) {
      const errorMsg = '请先在设置中配置 API Key'
      set({
        messages: [...messages, { id: nextMessageId(), role: 'user', content }, { id: nextMessageId(), role: 'assistant', content: errorMsg }],
        isLoading: false,
      })
      await window.electronAPI.saveMessage(conversationId, 'user', content)
      await window.electronAPI.saveMessage(conversationId, 'assistant', errorMsg)
      await invokeProxyComplete({ ok: false, error: errorMsg })
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
    const taggedContent = messageAnchor ? `[id:${messageAnchor}] ${content}` : content

    const userMessage: ChatMessage = {
      id: nextMessageId(),
      role: 'user',
      content: taggedContent,
      imageUrls: images && images.length > 0 ? images : undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    }
    set({ messages: [...messages, userMessage] })
    let savedUserMessageId: string | null = null
    try {
      savedUserMessageId = await window.electronAPI.saveMessage(conversationId, 'user', taggedContent, undefined, images)
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      window.electronAPI.logEvent('error', 'save-user-message-error', errMsg)
      set((state) => ({
        messages: [...state.messages, { id: nextMessageId(), role: 'assistant', content: `抱歉，保存消息失败：${errMsg}` }],
        isLoading: false,
        toolCallStatus: '',
      }))
      await invokeProxyComplete({ ok: false, error: `保存用户消息失败：${errMsg}` })
      return
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
          const assistantMsg: ChatMessage = {
            id: nextMessageId(),
            role: 'assistant',
            content: cached.assistantContent,
            reasoning: cached.reasoningContent ?? undefined,
          }
          set((state) => ({
            messages: [...state.messages, assistantMsg],
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
          const cachedMsg: ChatMessage = {
            id: nextMessageId(),
            role: 'assistant',
            content: cacheResult.assistantContent,
          }
          set((state) => ({
            messages: [...state.messages, cachedMsg],
            isLoading: false,
            toolCallStatus: '',
          }))
          await window.electronAPI.saveMessage(conversationId, 'assistant', cacheResult.assistantContent)
          activeChatRequest = null
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
    const stableSystemText = HARD_RULES + '\n\n' + systemPrompt
    const dynamicSystemText = dynamicAppended + snipNoticeBlock

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
    const apiMessages: LLMMessage[] = [
      ...compressedRecentMessages.map(m => {
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
      const errorMsg = constructErr instanceof Error ? constructErr.message : String(constructErr)
      set({
        messages: [
          ...get().messages,
          { id: nextMessageId(), role: 'user', content },
          { id: nextMessageId(), role: 'assistant', content: errorMsg },
        ],
        isLoading: false,
      })
      await window.electronAPI.saveMessage(conversationId, 'user', content)
      await window.electronAPI.saveMessage(conversationId, 'assistant', errorMsg)
      await invokeProxyComplete({ ok: false, error: errorMsg })
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
    let pendingToolCalls: ToolCall[] | undefined
    const assistantMsgId = nextMessageId()
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
      regressionTelemetry.emit({
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

      regressionTelemetry.emit({
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
          systemMsg.content = `${systemMsg.content}\n\n[已自动加载技能：${FORCED_CHART_SKILL_ID}]\n${resultText}`
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
        try {
          await window.electronAPI.saveMessage(conversationId, 'tool', resultText, toolCallId)
        } catch (saveErr) {
          const msg = saveErr instanceof Error ? saveErr.message : String(saveErr)
          window.electronAPI.logEvent('warn', 'save-forced-chart-skill-message-failed', msg)
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
              if (round === 0 && pendingChunkUpdate === null) {
                pendingChunkUpdate = requestAnimationFrame(() => {
                  pendingChunkUpdate = null
                  if (isStale()) return
                  if (!isViewedConv()) return  // 切走时不实时刷 UI，避免污染目标会话；累积量已在闭包里
                  set((state) => ({
                    messages: upsertLastAssistant(state.messages, assistantMsgId, assistantText, reasoningText),
                  }))
                })
              }
              return
            }
            assistantText += chunk
            writeProxyStreamDelta(chunk)
            // 工具调用中间轮次（round > 0）不实时显示文字给用户，
            // 避免 LLM 在中间轮输出半成品分析后最终轮又重复一遍。
            // 只在第一轮（用户刚发消息）和最终轮（下面 resolve 后判断无 tool_calls 再刷新）时显示。
            if (round === 0 && pendingChunkUpdate === null) {
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
          (_fullText, toolCalls, reasoning) => {
            cancelPendingChunk()
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
            if ((!toolCalls || toolCalls.length === 0) && !hasDsmlToolCallLeak(assistantText)) {
              const text = assistantText
              if (isViewedConv()) {
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
            maxTokens: shouldConvergeFast ? CONVERGE_FINAL_ROUND_MAX_TOKENS : undefined,
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

          regressionTelemetry.emit({
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
              regressionTelemetry.emit({
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
              if (loadSkillCallCount >= MAX_LOAD_SKILL_CALLS_PER_REQUEST) {
                resultText = `工具执行已跳过：load_skill 在当前对话已执行 ${MAX_LOAD_SKILL_CALLS_PER_REQUEST} 次。相关技能内容已在 systemPrompt 中提供，请基于已有上下文直接完成回答，不要继续调用 load_skill。`
                logPerf('tool-call:blocked', `round=${round} name=load_skill reason=max-calls(${MAX_LOAD_SKILL_CALLS_PER_REQUEST})`)
                if (ENABLE_TOOL_CONVERGE_MODE) {
                  forceConvergeNoTools = true
                  logPerf('tool-loop:converge-mode-on', `round=${round} reason=load_skill-max-calls`)
                }
              } else {
                const result = await window.electronAPI.executeToolCall(avatarId, conversationId, tc.function.name, toolArgs, toolInvocationMeta)
                if (isStale()) return
                loadSkillCallCount++
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
          // "工具执行已跳过" 是守卫主动拦截，不算 ok 但用户应能看到（在 UI 中以 ⚠ 区分）
          if (toolOk && resultText.startsWith('工具执行已跳过')) toolOk = false
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
          regressionTelemetry.emit({
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
          if (tc.function.name !== 'todo_write') {
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
          try {
            get().appendToolCallTimeline({
              id: tc.id,
              name: tc.function.name,
              argsPreview: (tc.function.arguments || '').slice(0, 80),
              resultPreview: resultText.slice(0, 200),
              durationMs: toolDurationMs,
              ok: toolOk,
              startedAt: toolStartedAt,
            })
          } catch (timelineErr) {
            // 时间线 push 失败绝不影响主链路
            const msg = timelineErr instanceof Error ? timelineErr.message : String(timelineErr)
            window.electronAPI.logEvent('warn', 'append-tool-timeline-failed', `${tc.function.name}: ${msg}`)
          }

          // 决策 B3：检测落盘文件，统一以 FileCard 展示在对话气泡内
          if (toolOk && (tc.function.name === 'generate_document' || tc.function.name === 'export_excel')) {
            const attachment = tryExtractDocumentAttachment(tc.function.name, resultText)
            if (attachment) {
              collectedDocumentAttachments.push(attachment)
              if (isViewedConv()) {
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
          try {
            await window.electronAPI.saveMessage(conversationId, 'tool', resultText, tc.id)
          } catch (saveErr) {
            const msg = saveErr instanceof Error ? saveErr.message : String(saveErr)
            window.electronAPI.logEvent('warn', 'save-tool-message-failed', msg)
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
          regressionTelemetry.emit({
            type: 'tool-loop:soft-warn',
            conversationId,
            timestamp: Date.now(),
            round,
          })
        }

        // 收敛模式下仅注入一次简短指令，强制下一轮直接给最终答案，避免冗长分析。
        if (ENABLE_CONVERGE_FINAL_ROUND_SPEEDUP && forceConvergeNoTools && !convergeHintInjected) {
          apiMessages.push({
            role: 'user',
            content: '[系统提示] 立即基于当前已获得的数据直接输出最终答案。不要继续分析过程，不要再请求任何工具，不要重复列出中间推理。',
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
        regressionTelemetry.emit({
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
      if (toolLoopStartedAt !== null) {
        logPerf('tool-loop:done', `rounds=${round} calls=${toolCallCount} duration=${Date.now() - toolLoopStartedAt}ms`)
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
      const { cleanText, proposals: skillProposals } = extractSkillCreate(userCleanText)
      const hasUpdates = memUpdates.length > 0 || userUpdates.length > 0 || skillProposals.length > 0
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
      if (isViewedConv()) {
        set((state) => ({
          messages: upsertLastAssistant(
            state.messages,
            assistantMsgId,
            displayText,
            reasoningText,
            collectedDocumentAttachments,
          ),
          isLoading: false,
          toolCallStatus: '',
          skillProposals,
        }))
      }

      if (isStale()) return
      try {
        // 把流式累积的 reasoningText 一并落盘，让切换会话回来仍能恢复 thinking 折叠区。
        // 非 thinking 模型 reasoningText 是空串，saveMessage 内部按 trim 长度判定存 NULL。
        await window.electronAPI.saveMessage(conversationId, 'assistant', displayText, undefined, undefined, reasoningText || undefined)
      } catch (saveErr) {
        const msg = saveErr instanceof Error ? saveErr.message : String(saveErr)
        console.error('[chatStore] 保存助手消息失败:', msg)
        window.electronAPI.logEvent('error', 'save-assistant-message-error', msg)
      }
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
      logPerf('sendMessage:success', `total=${Date.now() - requestStartedAt}ms displayLen=${displayText.length}`)
      // Phase 0.5 结构化埋点：写持久日志，2 周后聚合分析（按分身的 search_knowledge 触发率/命中率/TTFT）
      window.electronAPI.logEvent(
        'info',
        'phase05-query-summary',
        `avatar=${avatarId} status=ok queryLen=${content.length} hasImages=${Boolean(images && images.length > 0)} hasAttachments=${Boolean(attachments && attachments.length > 0)} searchCalls=${phase05SearchKnowledgeCalls} searchResultLen=${phase05SearchKnowledgeResultLen} ttftMs=${phase05FirstTokenAt > 0 ? phase05FirstTokenAt - requestStartedAt : -1} totalMs=${Date.now() - requestStartedAt}`,
      )
      regressionTelemetry.emit({
        type: 'message-done',
        conversationId,
        timestamp: Date.now(),
        content: displayText,
      })
      await invokeProxyComplete({ ok: true, assistantText: displayText })
      if (!isStale()) activeChatRequest = null
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
        `avatar=${avatarId} status=error queryLen=${content.length} hasImages=${Boolean(images && images.length > 0)} hasAttachments=${Boolean(attachments && attachments.length > 0)} searchCalls=${phase05SearchKnowledgeCalls} searchResultLen=${phase05SearchKnowledgeResultLen} ttftMs=${phase05FirstTokenAt > 0 ? phase05FirstTokenAt - requestStartedAt : -1} totalMs=${Date.now() - requestStartedAt} err=${errMsg.slice(0, 80)}`,
      )
      regressionTelemetry.emit({
        type: 'conversation-error',
        conversationId,
        timestamp: Date.now(),
        error: errMsg,
      })
      await invokeProxyComplete({ ok: false, error: errMsg })
      const errorMessage = `抱歉，发生了错误：${errMsg}`
      if (isViewedConv()) {
        set((state) => ({
          messages: upsertLastAssistant(state.messages, nextMessageId(), errorMessage),
          isLoading: false,
          toolCallStatus: '',
        }))
      }
      try {
        await window.electronAPI.saveMessage(conversationId, 'assistant', errorMessage)
      } catch (saveErr) {
        console.error('[chatStore] 保存错误消息失败:', saveErr instanceof Error ? saveErr.message : String(saveErr))
      }
      if (!isStale()) activeChatRequest = null
    } finally {
      // 仅在本请求仍是当前活跃请求时重置 isLoading，避免误清另一个请求的状态
      if (activeChatRequest?.id === requestId && get().isLoading) {
        set({ isLoading: false, toolCallStatus: '' })
      }
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
