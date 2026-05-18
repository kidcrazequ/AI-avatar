import path from 'path'
import fs from 'fs'
import { KnowledgeRetriever } from './knowledge-retriever'
import { loadIndex } from './knowledge-indexer'
import { saveTokensCache, loadTokensCache } from './utils/chunk-cache'
import { SubAgentManager, type SubAgentTask } from './sub-agent-manager'
import { assertSafeSegment, resolveUnderRoot } from './utils/path-security'
import { DEFAULT_AVATAR_PROJECT_ID } from './avatar-project'
import { resolveAvatarWorkspaceSessionRoot } from './avatar-workspace-paths'
import { CompositeKnowledgeRetriever } from './composite-knowledge-retriever'
import { collectFilesRecursive, DEFAULT_MAX_DIR_DEPTH } from './utils/common'
import { readLifeEpisode as readLifeEpisodeFromStore } from './life/store'
import { listConversationEpisodes } from './memory/episode-store'
import { buildKnowledgeLinkGraph, expandLinkedFiles, selectRelevantSnippet, type LinkGraph } from './link-graph'
import { rerankChunksWithDiversity } from './rag-rerank'
import { buildExcelSourceAnchor, buildKnowledgeSourceAnchor, buildWholeFileKnowledgeAnchor, formatSourceAnchor, type KnowledgeSourceAnchor } from './source-anchor'
import { fetchWithTimeout, HttpError } from './utils/http'
import { WikiCompiler } from './wiki-compiler'
import { buildDefaultCompressConfig, compressToolResult, type CompressConfig } from './tool-result-compressor'
import {
  buildDefaultLazyStoreConfig,
  maybeStoreLazyRef,
  readToolRef,
  isValidCallId,
  type LazyStoreConfig,
} from './tool-result-lazy-store'
import TurndownService from 'turndown'
import * as XLSX from 'xlsx'
import type { McpClientManager } from './mcp-client-manager'

/**
 * 工具调用路由器（GAP4）
 * 处理 LLM 发起的工具调用，执行对应的本地函数并返回结果。
 */

export interface ToolCallRequest {
  name: string
  arguments: Record<string, unknown>
}

export interface ToolCallResult {
  content: string
  error?: string
}

/**
 * 文档生成跨进程渲染钩子（决策 A1）。
 *
 * - md：packages/core 内部纯字符串渲染，无需此钩子
 * - pdf：Electron 主进程 BrowserWindow + printToPDF
 * - docx：Electron 主进程 docx@9.x（NodeJS 环境，packages/core 不依赖）
 *
 * 调用方在创建 ToolRouter 时注入；未注入则 generate_document(pdf|docx) 返回 error。
 *
 * @author zhi.qu
 * @date 2026-05-08
 */
/**
 * 文档渲染器调用方可选透传的运行时上下文。
 *
 * - imageRoot：DOCX 渲染时图片相对路径的解析根（通常为分身根目录）。
 *   传入后 docx-renderer 会在该目录下安全解析 image.src 并嵌入真实图片；
 *   不传或图片解析失败时渲染器自动降级为占位段。
 *
 * @author zhi.qu
 * @date 2026-05-08
 */
export interface DocumentRenderContext {
  imageRoot?: string
}

export interface DocumentRendererHook {
  renderPdf: (html: string, outputPath: string) => Promise<{ size: number }>
  renderDocx: (
    ir: import('./document/ir-schema').DocumentIR,
    outputPath: string,
    context?: DocumentRenderContext,
  ) => Promise<{ size: number }>
}

export interface KnowledgeSearchResult {
  file: string
  heading: string
  content: string
  score: number
  anchor?: KnowledgeSourceAnchor
}

interface DesignSystemSearchHit {
  category: string
  slug: string
  path: string
  score: number
  snippet: string
}

interface AssetManifestItem {
  asset: string
  path: string
  status?: 'needs-review' | 'approved' | 'changes-requested'
  group?: string
  subtitle?: string
  viewport?: { width: number; height?: number }
}

/**
 * 后台 shell 任务记录。
 *
 * 用于 exec_shell(background:true) 启动的长跑命令；await_shell / kill_shell 通过 task_id 操作。
 *
 * @author zhi.qu
 * @date 2026-04-29
 */
interface BackgroundShellRecord {
  taskId: string
  command: string
  cwd: string
  pid: number | undefined
  startedAt: number
  /** child_process 句柄（已结束的记录保留为 null 节省内存） */
  child: import('child_process').ChildProcess | null
  stdout: string
  stderr: string
  /** stdout/stderr 是否被截断到上限 */
  truncated: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  status: 'running' | 'exited' | 'killed'
  endedAt?: number
  /** 等待中的 promise resolve 列表，进程结束 / pattern 匹配时统一唤醒 */
  pendingWaiters: Array<() => void>
}

// ─── git_status / git_diff 限流常量 ───────────────────────────────────────────
// git 单次执行硬超时（10 秒，足够本地仓库 status/diff；大仓库可调高）
const GIT_HARD_TIMEOUT_MS = 10 * 1000
// git 输出字符上限（32KB ≈ 8k token；超出按字符截断）
const GIT_OUTPUT_MAX_CHARS = 32 * 1024

// ─── read_lines / list_files 限流常量 ─────────────────────────────────────────
// read_lines 单次默认返回行数（200 行 ≈ 1.5k token，覆盖 90% 阅读栈跟踪/diff 场景）
const READ_LINES_DEFAULT_RANGE = 200
// read_lines 单次硬上限（4000 行 ≈ 30k token，再多必须分页读取）
const READ_LINES_HARD_LIMIT = 4000
// list_files 单次返回条目硬上限（防止 LLM 在大仓库下 dump 几万条目撑爆 context）
const LIST_FILES_HARD_LIMIT = 500

// ─── query_excel 限流常量 ─────────────────────────────────────────────────────
// 防止单次工具调用 dump 几百行 × 几十列 × 几十字符 = 几十 KB 数据进 chat history
// 累积起来撞破 LLM context 上限。

/** 单次 query_excel 默认返回行数 */
const QUERY_EXCEL_DEFAULT_LIMIT = 50
/** 单次 query_excel 硬上限行数（即使 LLM 显式传 1000 也会被截断） */
const QUERY_EXCEL_HARD_LIMIT = 200
/**
 * 单次 query_excel 返回 content 的字符数硬上限（约 2k token）。
 * 即使在 limit 范围内，如果列数太多导致 JSON 太大也会被按行二次截断。
 */
const QUERY_EXCEL_MAX_CONTENT_CHARS = 8000

// ─── export_excel 限流常量 ────────────────────────────────────────────────────
// query_excel 是只读工具，对比/分析输出无法落盘；exportExcel() 弥补此能力缺口。
// 但 LLM 可能传入巨大的 rows（几十万行），需多重防护避免：
//   1. 单文件过大撑爆磁盘 / 后续 Excel 打开崩溃
//   2. 单 sheet 行数过多，xlsx 库序列化耗时过长阻塞主线程
//   3. sheet 过多导致 Excel 客户端打不开
//
// 数值参考 desktop-app/electron/document-parser.ts 的 EXCEL_MAX_ROWS_PER_SHEET
// 与常见办公场景：50_000 行 × 50 sheet 已足以覆盖任何 BI 报表导出场景。

/** export_excel 单文件落盘后字节数硬上限（10 MB；超出立即删除并报错） */
const EXPORT_EXCEL_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024
/** export_excel 单 sheet 最大行数（50_000；与 document-parser.ts 解析端一致） */
const EXPORT_EXCEL_MAX_ROWS_PER_SHEET = 50_000
/** export_excel 单文件最大 sheet 数 */
const EXPORT_EXCEL_MAX_SHEETS = 50

// ─── generate_document 限流常量 ───────────────────────────────────────────────
//
// 设计动机：
//   - 单文件 20MB：PDF/DOCX 含图比 xlsx 重，但仍需防止 LLM/渲染异常撑爆磁盘
//   - IR 长度 200_000：一次约 50-80 页正文，足以覆盖任何报告/方案场景，
//     再多就该让 LLM 拆分多次调用而非塞进单个 IR
//
// @author zhi.qu
// @date 2026-05-08
/** generate_document 单文件落盘后字节数硬上限（20 MB） */
const MAX_DOCUMENT_FILE_SIZE_BYTES = 20 * 1024 * 1024
/** generate_document IR markdown 字符数硬上限（防 LLM 输出无限长） */
const MAX_IR_LENGTH = 200_000
/** 支持的文档输出格式（白名单） */
const SUPPORTED_DOCUMENT_FORMATS = ['md', 'pdf', 'docx'] as const
type DocumentFormat = typeof SUPPORTED_DOCUMENT_FORMATS[number]

// ─── exec_shell 安全沙箱常量 ───────────────────────────────────────────────────
// 设计参考 Cursor / Claude Code Bash 工具的桌面端安全模型：
//   - 进程 cwd 强制锁定到工作区目录（无法跳出）
//   - 命令白名单（首词必须命中）
//   - 危险参数黑名单（regex 拦截 sudo / rm / curl|sh 等）
//   - 硬超时 + 输出截断（防止 stdout 撑爆 LLM context）

/** 单次 exec_shell 硬超时（5 分钟，无法被 args.timeout_ms 覆盖到更大） */
const EXEC_SHELL_HARD_TIMEOUT_MS = 5 * 60 * 1000
/** 前台模式 stdout / stderr 各自字符上限（8KB ≈ 2k token），超出截断 */
const EXEC_SHELL_OUTPUT_MAX = 8 * 1024
/** 后台模式 stdout / stderr 各自字符上限（64KB，长跑场景需要更大缓冲） */
const BG_SHELL_OUTPUT_MAX = 64 * 1024
/** 后台 shell 注册表最大条目数；超出时按结束时间 evict 最旧 */
const BG_SHELL_MAX_ENTRIES = 50
/** 已结束的后台 shell 记录保留时长（超过则可被 evict） */
const BG_SHELL_RETAIN_MS = 60 * 60 * 1000
/** await_shell 默认阻塞时长（30 秒） */
const AWAIT_SHELL_DEFAULT_BLOCK_MS = 30 * 1000
/** await_shell 最大阻塞时长（5 分钟，单次调用上限） */
const AWAIT_SHELL_MAX_BLOCK_MS = 5 * 60 * 1000

// ─── exec_code 沙箱常量 ─────────────────────────────────────────────────────
// LLM 现场写脚本（Python/Node/TSX）的执行通道；与 shell 互补，覆盖结构化数据处理、
// 文件批量改写、报表分析等"造粗工具"难以穷举的场景。
//
// 安全模型：
//   - cwd 强制锁定 workspace（脚本默认在工作区目录跑）
//   - 解释器枚举白名单（仅 python/python3/node/tsx）
//   - 不用 shell:true（spawn(interpreter, [scriptPath])，避免命令注入）
//   - 临时脚本写入 workspace/.code-exec/{taskId}.{ext}，不跨工作区
//   - 输出截断 16KB / 前台超时 5 分钟 / 同样支持 background

/** exec_code 前台硬超时（5 分钟） */
const EXEC_CODE_HARD_TIMEOUT_MS = 5 * 60 * 1000
/** exec_code stdout/stderr 各自字符上限（16KB ≈ 4k token） */
const EXEC_CODE_OUTPUT_MAX = 16 * 1024
/** exec_code 单脚本字符数上限 */
const EXEC_CODE_SCRIPT_MAX_CHARS = 16_000

/** exec_code 支持的解释器配置 */
interface InterpreterConfig {
  /** 实际可执行命令名 */
  command: string
  /** 写入的脚本扩展名（含点） */
  ext: string
  /** 调用解释器的额外参数（在 [scriptPath] 之前） */
  preArgs: string[]
}

const EXEC_CODE_INTERPRETERS: Record<string, InterpreterConfig> = {
  python: { command: 'python', ext: '.py', preArgs: ['-u'] }, // -u: unbuffered stdio
  python3: { command: 'python3', ext: '.py', preArgs: ['-u'] },
  node: { command: 'node', ext: '.mjs', preArgs: [] },
  tsx: { command: 'tsx', ext: '.ts', preArgs: [] },
}

// ─── web_search 常量（Tavily API） ──────────────────────────────────────────
// Tavily 是为 LLM 设计的搜索 API（cursor/Perplexity/LangChain 默认推荐），
// 返回的 content 直接是可读的网页摘要，免去解析 HTML 的成本。
// API 文档：https://docs.tavily.com/docs/rest-api/api-reference

/** Tavily API 端点 */
const TAVILY_API_URL = 'https://api.tavily.com/search'
/** web_search 单次请求超时（30 秒） */
const WEB_SEARCH_TIMEOUT_MS = 30 * 1000
/** web_search 默认结果数 */
const WEB_SEARCH_DEFAULT_MAX = 5
/** web_search 结果数硬上限（防止 LLM 索取过多导致 context 爆） */
const WEB_SEARCH_HARD_MAX = 10
/** 单条结果 content 截断长度（避免单页摘要太长撑爆 context） */
const WEB_SEARCH_CONTENT_MAX_CHARS = 800

// ─── web_fetch 常量 ────────────────────────────────────────────────────────
// web_fetch 用于深入抓取单个 URL 的完整内容（与 web_search 互补：先搜后抓）。
// 关键安全控制：
//   - 只允许 http / https；禁止 file:// / chrome:// / data: 等本地协议
//   - 屏蔽内网 IP / localhost（防 SSRF 攻击）
//   - 强制 30 秒超时 + 30KB 输出截断（防 LLM context 爆）

/** web_fetch 单次请求超时（30 秒）*/
const WEB_FETCH_TIMEOUT_MS = 30 * 1000
/** web_fetch 默认输出上限（30 000 字符≈ 7.5K token） */
const WEB_FETCH_DEFAULT_MAX_CHARS = 30_000
/** web_fetch 输出硬上限（防 LLM 索取过多） */
const WEB_FETCH_HARD_MAX_CHARS = 100_000

// ─── generate_image 常量（DashScope wanx2.1-t2i-turbo） ────────────────────
// DashScope 异步 API：先 POST 创建任务（拿 task_id）→ 轮询 task 状态 → SUCCEEDED 后下载图片
// 文档：https://help.aliyun.com/zh/dashscope/developer-reference/api-details-9

/** DashScope 文生图任务创建端点 */
const IMAGE_GEN_CREATE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis'
/** DashScope 异步任务查询端点（拼 /:task_id） */
const IMAGE_GEN_TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks'
/** 任务创建请求超时（30 秒） */
const IMAGE_GEN_CREATE_TIMEOUT_MS = 30 * 1000
/** 单次轮询请求超时（10 秒） */
const IMAGE_GEN_POLL_TIMEOUT_PER_REQ_MS = 10 * 1000
/** 总轮询超时（90 秒；wanx-turbo 通常 5-15s 完成，留余量给排队） */
const IMAGE_GEN_POLL_TIMEOUT_MS = 90 * 1000
/** 轮询间隔（2 秒） */
const IMAGE_GEN_POLL_INTERVAL_MS = 2 * 1000
/** 图片下载超时（30 秒） */
const IMAGE_GEN_DOWNLOAD_TIMEOUT_MS = 30 * 1000
/** 内网/回环地址正则（防 SSRF）*/
const PRIVATE_IP_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,  // 172.16.0.0–172.31.255.255
  /^169\.254\./,                  // link-local
  /^0\.0\.0\.0$/,
  /^::1$/,                        // IPv6 loopback
  /^fe80:/i,                      // IPv6 link-local
  /^fc00:/i,                      // IPv6 ULA
  /^fd00:/i,                      // IPv6 ULA
]

/** HTML 实体解码表（覆盖 99% 常见场景，避免引入 he 这种额外库） */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&#39;': "'", '&nbsp;': ' ', '&copy;': '©', '&reg;': '®', '&trade;': '™',
  '&hellip;': '…', '&mdash;': '—', '&ndash;': '–', '&laquo;': '«', '&raquo;': '»',
  '&ldquo;': '"', '&rdquo;': '"', '&lsquo;': "'", '&rsquo;': "'",
  '&middot;': '·', '&bull;': '•', '&times;': '×', '&divide;': '÷',
}
/**
 * 命令白名单（首词必须命中）。首批保守：覆盖文件浏览、文本处理、版本控制、
 * 解释器、压缩归档。后续按真实需求再扩。
 *
 * 不放：网络请求工具的执行入口（curl/wget/ssh/scp/rsync）—— 联网必须走 web_fetch
 * 工具，避免 shell 直接拉远程脚本执行。
 */
const EXEC_SHELL_WHITELIST: ReadonlySet<string> = new Set([
  // 文件 / 目录
  'ls', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'find', 'tree',
  'echo', 'pwd', 'which', 'whoami', 'date', 'env', 'basename', 'dirname',
  'mkdir', 'cp', 'mv', 'touch',
  // 文本处理
  'grep', 'rg', 'sed', 'awk', 'cut', 'tr', 'tee', 'jq', 'diff',
  // 版本控制
  'git',
  // 解释器
  'python', 'python3', 'node', 'npm', 'npx', 'pnpm', 'yarn',
  'pip', 'pip3', 'tsx', 'deno', 'bun',
  // 归档 / 压缩
  'tar', 'gzip', 'gunzip', 'zip', 'unzip', '7z',
  // 帮助类
  'man', 'help',
])
/**
 * 命令黑名单（命中任意一条 regex 立即拒绝）。
 * 即使首词在白名单也会再次校验。
 */
const EXEC_SHELL_BLACKLIST: readonly RegExp[] = [
  /\bsudo\b/i,
  /\bsu\s+-/i,
  /\brm\s+(-[a-zA-Z]*[rfRF][a-zA-Z]*\s+)+(\/|~|\$HOME)/, // rm -rf / 或 ~
  /\bmkfs\b/i,
  /\bdd\s+(if|of)=/i,
  /\b(curl|wget|fetch)\s+[^|]*\|\s*(sh|bash|zsh|python)\b/i, // 远程脚本管道执行
  /\bnc\s+-l\b/i,                                            // netcat 监听
  />\s*\/dev\/(sd[a-z]|nvme|disk|hd[a-z])/,                  // 写块设备
  /\bchmod\s+[0-7]?[7]\d{2}\b/,                               // chmod 7xx 全权
  /\bchown\s+root\b/i,
  /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,           // fork bomb
  /\beval\s+["'`]?\$/i,                                        // eval $ 动态执行
  /\bbase64\s+-d\b.*\|\s*(sh|bash)/i,                          // base64 解码后执行
]


interface CachedExcelSource {
  mtimeMs: number
  size: number
  parsed: {
    fileName?: string
    sheets?: Array<{
      name: string
      rowCount: number
      columns: Array<{ name: string; dtype: string; uniqueCount?: number; samples?: Array<string | number>; min?: string | number; max?: string | number }>
      rows: Array<Record<string, string | number | null>>
    }>
  }
}

/**
 * 子分身派发上下文（v15 引入，Managed-Agents 借鉴第 1 步）。
 *
 * SubAgentManager 内部不知道"派发发生在哪个会话、派发方是谁、目标是谁"，
 * 这些都是 ToolRouter.delegateTask 才有的上下文。通过 sink 闭包带下去，
 * 让 desktop-app 适配器组装 SubAgentTaskRow 时不必反向依赖 core。
 */
export interface SubAgentDispatchContext {
  /** 派发发生的会话 ID */
  conversationId: string
  /** 派发方分身 ID（即 task() 工具调用所在的分身） */
  parentAvatarId: string
  /** 跨分身派发的目标分身 ID；同分身派发为 null */
  targetAvatar: string | null
}

/**
 * 子分身派发 sink 类型。
 *
 * SubAgentManager 不知道 sqlite 行的字段名，ToolRouter 不依赖 desktop-app；
 * 用 ctx 闭包带上下文 + task 快照，desktop-app 装配点把两者拼成 row 落库。
 */
export type SubAgentTaskSink = (task: SubAgentTask, ctx: SubAgentDispatchContext) => void

export class ToolRouter {
  private avatarsPath: string
  private designSystemsPath: string
  private retrievers = new Map<string, KnowledgeRetriever>()
  /** projects/<pid>/knowledge 独立索引缓存 */
  private projectKnowledgeRetrievers = new Map<string, KnowledgeRetriever>()
  /** 当前 execute 调用栈内的项目分区（线程非安全：假定单会话串行工具执行） */
  private knowledgeProjectContext: string = DEFAULT_AVATAR_PROJECT_ID
  /**
   * 按会话 ID 解析 `project_id`（与主进程 DB 一致），用于 `/projects/<conv>/` 跨会话路径与 ToolRouter 内工作区根解析。
   * 未注入时跨会话路径按 `default` 分区解析（兼容旧测试）；桌面端由 main 注入真实解析器。
   */
  private resolveConversationProjectId?: (conversationId: string) => string
  /** Feature 7: 子代理管理器 */
  readonly subAgentManager = new SubAgentManager()
  /** 主代理 system prompt（用于子代理共享上下文） */
  private systemPromptCache = new Map<string, string>()
  /** Excel 导入 JSON 的内存缓存（按文件 mtime + size 失效） */
  private excelSourceCache = new Map<string, CachedExcelSource>()
  /** 显式引用图缓存（knowledge/*.md -> linked files） */
  private linkGraphCache = new Map<string, LinkGraph>()
  /**
   * 后台 shell 任务注册表。
   * key = task_id，value = BackgroundShellRecord。
   * 自动 evict：超过 BG_SHELL_MAX_ENTRIES 或已结束超过 BG_SHELL_RETAIN_MS 的旧记录会被清理。
   */
  private backgroundShells = new Map<string, BackgroundShellRecord>()

  /**
   * 可选回调：按 avatarId 加载目标分身的 systemPrompt。
   *
   * 用于 delegate_task 的 target_avatar 参数：当用户想把任务委派给"另一个分身"
   * （比如设计专科分身 design-master）时，子代理需要切到目标分身的人格与
   * 知识库再跑。ToolRouter 不直接依赖 SoulLoader（避免环依赖），由外部
   * （desktop-app/main.ts 或测试脚手架）注入。
   *
   * 返回 undefined 表示目标分身不存在或无法加载，delegateTask 会返回错误。
   */
  private loadAvatarSystemPrompt?: (avatarId: string) => string | undefined
  /**
   * 可选回调：读取应用设置（API Key 等）。
   *
   * 用于需要外部凭据的工具（web_search 读 tavily_api_key 等）。
   * ToolRouter 不直接依赖 DatabaseManager（避免环依赖），由外部 main.ts 注入。
   *
   * 返回 undefined 表示用户未配置该项。
   */
  private getSetting?: (key: string) => string | undefined

  /**
   * 可选注入：MCP 客户端管理器。
   *
   * 注入后，list_mcp_tools / call_mcp_tool 工具会路由到这里。
   * 不注入时，这两个工具返回提示「MCP 未启用」。
   */
  private mcpManager?: McpClientManager

  /**
   * 可选注入：文档渲染器钩子。
   *
   * generate_document 工具的 PDF / DOCX 分支需要 Electron 主进程能力（BrowserWindow + docx 库），
   * 但 packages/core 必须保持环境无关。决策 A1：构造时由调用方注入实际渲染函数。
   *
   * 不注入时：md 格式仍可工作（纯字符串渲染）；pdf/docx 调用会返回 error 提示注入缺失。
   *
   * @author zhi.qu
   * @date 2026-05-08
   */
  private documentRenderers?: DocumentRendererHook

  /**
   * 可选注入：子分身派发任务 sink（v15 引入，Managed-Agents 借鉴第 1 步）。
   *
   * 在 running/done/error 三个时刻被 SubAgentManager 触发。
   * desktop-app 注入的 sink 会把任务镜像到 sqlite + JSONL；
   * 不注入时不影响 LLM 主链路，只是没有持久化记录（如纯核心单测场景）。
   *
   * sink 内部失败由调用方兜底；SubAgentManager.fireChange 已 try/catch 兜底。
   */
  private subAgentTaskSink?: SubAgentTaskSink

  /**
   * Tool Result 压缩配置（TokenJuice 启发，2026-05-18 引入）。
   * 构造时从 `SOUL_TOOL_COMPRESSION` env 读取启停；默认开启。
   * 红线见 `tool-result-compressor.ts` 顶部注释——只做无损操作，绝不调 LLM 二次总结。
   */
  private compressConfig: CompressConfig = buildDefaultCompressConfig(process.env.SOUL_TOOL_COMPRESSION)

  /**
   * Tool Result Lazy Store 配置（TDAI symbolic memory 启发，2026-05-18 引入）。
   * 从 `SOUL_TOOL_LAZY_RETRIEVAL` env 读取，**默认 off**。
   * 仅对 white-list 工具（v1: web_fetch）触发；事实根基类工具绝不 lazy。
   * 红线见 `tool-result-lazy-store.ts` 顶部注释。
   */
  private lazyStoreConfig: LazyStoreConfig = (() => {
    const cfg = buildDefaultLazyStoreConfig(process.env.SOUL_TOOL_LAZY_RETRIEVAL)
    console.log(`[tool-router] lazy-store config: enabled=${cfg.enabled} (env SOUL_TOOL_LAZY_RETRIEVAL=${JSON.stringify(process.env.SOUL_TOOL_LAZY_RETRIEVAL)}) threshold=${cfg.thresholdChars} allowed=[${[...cfg.allowedTools].join(',')}]`)
    return cfg
  })()

  /**
   * @param avatarsPath 仓库 avatars/ 目录绝对路径
   * @param options 可选依赖注入：
   *   - loadAvatarSystemPrompt: 用于 delegate_task target_avatar 跨分身委派
   *   - listAvailableAvatars: 目标分身不存在时返回候选列表，提升错误可读性
   *   - getSetting: 读取应用设置（API Key 等），用于 web_search 等需要外部凭据的工具
   *   - mcpManager: MCP 客户端管理器，用于 list_mcp_tools / call_mcp_tool
   *   - documentRenderers: 文档生成 PDF/DOCX 渲染器（决策 A1 依赖注入）
   *   - resolveConversationProjectId: 会话 → project_id（与 WorkspaceManager 注入同源，保证工具层工作区与 IPC 一致）
   */
  constructor(
    avatarsPath: string,
    options?: {
      loadAvatarSystemPrompt?: (avatarId: string) => string | undefined
      listAvailableAvatars?: () => string[]
      getSetting?: (key: string) => string | undefined
      mcpManager?: McpClientManager
      documentRenderers?: DocumentRendererHook
      resolveConversationProjectId?: (conversationId: string) => string
      subAgentTaskSink?: SubAgentTaskSink
    },
  ) {
    this.avatarsPath = avatarsPath
    this.designSystemsPath = path.join(avatarsPath, '..', 'shared', 'design-systems')
    this.loadAvatarSystemPrompt = options?.loadAvatarSystemPrompt
    this.listAvailableAvatars = options?.listAvailableAvatars
    this.getSetting = options?.getSetting
    this.mcpManager = options?.mcpManager
    this.documentRenderers = options?.documentRenderers
    this.resolveConversationProjectId = options?.resolveConversationProjectId
    this.subAgentTaskSink = options?.subAgentTaskSink
  }

  /** 允许在 ToolRouter 创建后再注入（如渲染进程在 ToolRouter 之后才完成 IPC 桥接） */
  setDocumentRenderers(renderers: DocumentRendererHook): void {
    this.documentRenderers = renderers
  }

  /** 见 loadAvatarSystemPrompt 注释 */
  private listAvailableAvatars?: () => string[]

  private getWorkspaceRoot(avatarId: string, conversationId?: string): string {
    if (!conversationId) {
      throw new Error('缺少 conversationId，无法定位 workspace')
    }
    assertSafeSegment(avatarId, '分身ID')
    assertSafeSegment(conversationId, 'conversationId')
    const root = resolveAvatarWorkspaceSessionRoot(
      this.avatarsPath,
      avatarId,
      this.knowledgeProjectContext,
      conversationId,
    )
    fs.mkdirSync(root, { recursive: true })
    return root
  }

  private resolveWorkspacePath(avatarId: string, conversationId: string | undefined, rawPath: string): string {
    const workspaceRoot = this.getWorkspaceRoot(avatarId, conversationId)
    const normalized = (rawPath || '.').replace(/\\/g, '/')
    if (!normalized.startsWith('/projects/')) {
      return resolveUnderRoot(workspaceRoot, normalized)
    }
    const parts = normalized.split('/').filter(Boolean)
    if (parts.length < 2) {
      throw new Error(`非法跨项目路径: ${rawPath}`)
    }
    const targetConversationId = parts[1]
    assertSafeSegment(targetConversationId, 'conversationId')
    const resolver = this.resolveConversationProjectId ?? (() => DEFAULT_AVATAR_PROJECT_ID)
    const rawTargetPid = resolver(targetConversationId)
    const targetProjectId =
      typeof rawTargetPid === 'string' && rawTargetPid.trim().length > 0
        ? rawTargetPid.trim()
        : DEFAULT_AVATAR_PROJECT_ID
    if (targetProjectId !== DEFAULT_AVATAR_PROJECT_ID) {
      assertSafeSegment(targetProjectId, 'projectId')
    }
    const targetRoot = resolveAvatarWorkspaceSessionRoot(
      this.avatarsPath,
      avatarId,
      targetProjectId,
      targetConversationId,
    )
    fs.mkdirSync(targetRoot, { recursive: true })
    const rest = parts.slice(2).join('/')
    return resolveUnderRoot(targetRoot, rest || '.')
  }

  private getAssetManifestPath(avatarId: string, conversationId?: string): string {
    const workspaceRoot = this.getWorkspaceRoot(avatarId, conversationId)
    return path.join(workspaceRoot, '.assets.json')
  }

  private readAssetManifest(avatarId: string, conversationId?: string): AssetManifestItem[] {
    const manifestPath = this.getAssetManifestPath(avatarId, conversationId)
    if (!fs.existsSync(manifestPath)) return []
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8')
      const parsed = JSON.parse(raw) as AssetManifestItem[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private writeAssetManifest(avatarId: string, conversationId: string | undefined, items: AssetManifestItem[]): void {
    const manifestPath = this.getAssetManifestPath(avatarId, conversationId)
    fs.writeFileSync(manifestPath, JSON.stringify(items, null, 2), 'utf-8')
  }

  /**
   * 在指定 knowledge 根目录上构造并 hydrate KnowledgeRetriever。
   */
  private loadRetrieverForKnowledgeRoot(knowledgePath: string): KnowledgeRetriever {
    const retriever = new KnowledgeRetriever(knowledgePath)
    const index = loadIndex(knowledgePath)
    if (index) {
      retriever.setContexts(index.contexts)
      retriever.setEmbeddings(index.embeddings)
      if (index.tokens.size > 0) {
        retriever.setTokens(index.tokens)
      }
    }
    if (!index) {
      const indexDir = path.join(knowledgePath, '_index')
      const tokenCache = loadTokensCache(indexDir)
      if (tokenCache && tokenCache.size > 0) {
        retriever.setTokens(tokenCache)
        console.log(`[tool-router] 仅加载 tokens 缓存 (${tokenCache.size} entries)，contexts/embeddings 不存在`)
      }
    }
    return retriever
  }

  /** 分身全局 knowledge/ + 当前 execute 上下文中的 project 分区（合并检索）。 */
  private getKnowledgeSurfaceForContext(avatarId: string): CompositeKnowledgeRetriever {
    const base = this.getRetriever(avatarId)
    const pid = this.knowledgeProjectContext
    if (pid === DEFAULT_AVATAR_PROJECT_ID) {
      return new CompositeKnowledgeRetriever(base, null, '')
    }
    const overlayPath = path.join(this.avatarsPath, avatarId, 'projects', pid, 'knowledge')
    if (!fs.existsSync(overlayPath)) {
      return new CompositeKnowledgeRetriever(base, null, '')
    }
    const cacheKey = `${avatarId}\x1f${pid}`
    if (!this.projectKnowledgeRetrievers.has(cacheKey)) {
      this.projectKnowledgeRetrievers.set(cacheKey, this.loadRetrieverForKnowledgeRoot(overlayPath))
    }
    const overlay = this.projectKnowledgeRetrievers.get(cacheKey)!
    return new CompositeKnowledgeRetriever(base, overlay, `projects/${pid}/knowledge/`)
  }

  /**
   * 获取或创建分身的 KnowledgeRetriever，自动加载持久化索引（contexts + embeddings）。
   */
  getRetriever(avatarId: string): KnowledgeRetriever {
    assertSafeSegment(avatarId, '分身ID')
    if (!this.retrievers.has(avatarId)) {
      const knowledgePath = path.join(this.avatarsPath, avatarId, 'knowledge')
      this.retrievers.set(avatarId, this.loadRetrieverForKnowledgeRoot(knowledgePath))
    }
    return this.retrievers.get(avatarId)!
  }

  /**
   * 把 retriever 当前的 tokens 落盘到 _index/tokens.json。
   * 由调用方在 searchKnowledge 之后判断 isTokensDirty() 决定是否调用，
   * 避免每次查询都 I/O。
   */
  saveRetrieverTokens(avatarId: string): void {
    const retriever = this.retrievers.get(avatarId)
    if (retriever?.isTokensDirty()) {
      const knowledgePath = path.join(this.avatarsPath, avatarId, 'knowledge')
      const indexDir = path.join(knowledgePath, '_index')
      try {
        saveTokensCache(indexDir, retriever.getTokens())
        retriever.clearTokensDirty()
      } catch (err) {
        console.warn(`[tool-router] saveTokensCache 失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const pid = this.knowledgeProjectContext
    if (pid !== DEFAULT_AVATAR_PROJECT_ID) {
      const cacheKey = `${avatarId}\x1f${pid}`
      const projR = this.projectKnowledgeRetrievers.get(cacheKey)
      if (projR?.isTokensDirty()) {
        const pPath = path.join(this.avatarsPath, avatarId, 'projects', pid, 'knowledge')
        try {
          saveTokensCache(path.join(pPath, '_index'), projR.getTokens())
          projR.clearTokensDirty()
        } catch (err) {
          console.warn(`[tool-router] saveTokensCache(project) 失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  /**
   * 使新索引生效：清除缓存的 retriever，下次访问时自动重新加载。
   */
  invalidateRetriever(avatarId: string): void {
    this.retrievers.delete(avatarId)
    const pfx = `${avatarId}\x1f`
    for (const key of [...this.projectKnowledgeRetrievers.keys()]) {
      if (key.startsWith(pfx)) this.projectKnowledgeRetrievers.delete(key)
    }
    this.linkGraphCache.delete(avatarId)
    for (const key of this.excelSourceCache.keys()) {
      if (key.startsWith(`${avatarId}:`)) this.excelSourceCache.delete(key)
    }
  }

  /**
   * 设置主代理 system prompt 缓存，供子代理委派时共享。
   */
  setSystemPrompt(avatarId: string, systemPrompt: string): void {
    this.systemPromptCache.set(avatarId, systemPrompt)
  }


  private getKnowledgeFiles(avatarId: string): string[] {
    return this.getRetriever(avatarId).listFiles().filter((file) => file.toLowerCase().endsWith('.md'))
  }

  private getLinkGraph(avatarId: string): LinkGraph {
    const cached = this.linkGraphCache.get(avatarId)
    if (cached) return cached

    const retriever = this.getRetriever(avatarId)
    const files = this.getKnowledgeFiles(avatarId)
    const entries = files.map((file) => ({ file, content: retriever.readFile(file) }))
    const graph = buildKnowledgeLinkGraph(entries)
    this.linkGraphCache.set(avatarId, graph)
    return graph
  }

  anchorKnowledgeChunks(
    avatarId: string,
    chunks: Array<{ file: string; heading: string; content: string; score: number }>,
  ): KnowledgeSearchResult[] {
    const retriever = this.getKnowledgeSurfaceForContext(avatarId)
    const fileCache = new Map<string, string>()

    const readMarkdown = (file: string): string => {
      if (!fileCache.has(file)) fileCache.set(file, retriever.readFile(file))
      return fileCache.get(file)!
    }

    return chunks.map((chunk) => {
      const heading = chunk.heading?.trim() || ''
      try {
        const markdown = readMarkdown(chunk.file)
        return {
          ...chunk,
          anchor: buildKnowledgeSourceAnchor(chunk.file, markdown, chunk.content, heading || undefined),
        }
      } catch {
        return {
          ...chunk,
          anchor: { kind: 'knowledge', file: chunk.file, heading: heading || undefined },
        }
      }
    })
  }

  getRelatedKnowledgeChunks(
    avatarId: string,
    question: string,
    seedFiles: string[],
    options: { maxRelatedFiles?: number; maxChars?: number; baseScore?: number } = {},
  ): KnowledgeSearchResult[] {
    const {
      maxRelatedFiles = 4,
      maxChars = 650,
      baseScore = 0.52,
    } = options

    const uniqueSeedFiles = Array.from(new Set(seedFiles.filter((file) => typeof file === 'string' && file.trim().length > 0)))
    if (uniqueSeedFiles.length === 0) return []

    const graph = this.getLinkGraph(avatarId)
    const linkedFiles = expandLinkedFiles(graph, uniqueSeedFiles, { maxDepth: 2, maxFiles: maxRelatedFiles })
    if (linkedFiles.length === 0) return []

    const retriever = this.getKnowledgeSurfaceForContext(avatarId)
    const results: KnowledgeSearchResult[] = []

    for (const linked of linkedFiles) {
      let markdown: string
      try {
        markdown = retriever.readFile(linked.file)
      } catch {
        continue
      }
      const snippet = selectRelevantSnippet(markdown, question, { maxChars })
      if (!snippet.content) continue
      const score = Number((baseScore + linked.relationCount * 0.03 - (linked.depth - 1) * 0.08).toFixed(4))
      const heading = snippet.heading ? `${snippet.heading}（关联文件）` : '关联文件'
      results.push({
        file: linked.file,
        heading,
        content: snippet.content,
        score,
        anchor: buildKnowledgeSourceAnchor(linked.file, markdown, snippet.content, snippet.heading),
      })
    }

    return results
  }

  buildKnowledgeSearchResults(
    avatarId: string,
    query: string,
    options: { rawTopN?: number; maxChunks?: number; maxPerFile?: number; minDistinctFiles?: number; maxRelatedFiles?: number } = {},
  ): KnowledgeSearchResult[] {
    const {
      rawTopN = 14,
      maxChunks = 8,
      maxPerFile = 3,
      minDistinctFiles = 3,
      maxRelatedFiles = 4,
    } = options

    const rawChunks = this.anchorKnowledgeChunks(
      avatarId,
      this.getKnowledgeSurfaceForContext(avatarId).searchChunks(query, rawTopN),
    )
    const reranked = rerankChunksWithDiversity(rawChunks, {
      maxChunks,
      maxPerFile,
      minDistinctFiles,
      similarityThreshold: 0.82,
    })
    const seedFiles = reranked.slice(0, 4).map((chunk) => chunk.file)
    const relatedChunks = this.getRelatedKnowledgeChunks(avatarId, query, seedFiles, { maxRelatedFiles })
    return rerankChunksWithDiversity([...reranked, ...relatedChunks], {
      maxChunks,
      maxPerFile,
      minDistinctFiles,
      similarityThreshold: 0.82,
    })
  }

  private loadExcelSource(avatarId: string, file: string): CachedExcelSource['parsed'] {
    const jsonPath = path.join(this.avatarsPath, avatarId, 'knowledge', '_excel', `${file}.json`)
    const cacheKey = `${avatarId}:${file}`

    let stat
    try {
      stat = fs.statSync(jsonPath)
    } catch {
      throw new Error(`Excel 数据源不存在: _excel/${file}.json`)
    }

    const cached = this.excelSourceCache.get(cacheKey)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.parsed
    }

    let raw: string
    try {
      raw = fs.readFileSync(jsonPath, 'utf-8')
    } catch {
      throw new Error(`Excel 数据源不存在: _excel/${file}.json`)
    }

    let parsed: CachedExcelSource['parsed']
    try {
      parsed = JSON.parse(raw) as CachedExcelSource['parsed']
    } catch (e) {
      throw new Error(`Excel JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }

    this.excelSourceCache.set(cacheKey, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      parsed,
    })
    return parsed
  }

  /** 执行工具调用 */
  async execute(
    avatarId: string,
    request: ToolCallRequest,
    callLLM?: (sys: string, user: string, maxTokens?: number) => Promise<string>,
    conversationId?: string,
    /** 会话所属 Avatar 项目分区，影响合并知识检索范围 */
    knowledgeProjectId?: string,
  ): Promise<ToolCallResult> {
    assertSafeSegment(avatarId, '分身ID')
    const { name, arguments: args } = request

    const prevCtx = this.knowledgeProjectContext
    const pid =
      typeof knowledgeProjectId === 'string' && knowledgeProjectId.trim().length > 0
        ? knowledgeProjectId.trim()
        : DEFAULT_AVATAR_PROJECT_ID
    try {
      if (pid !== DEFAULT_AVATAR_PROJECT_ID) assertSafeSegment(pid, 'projectId')
    } catch (e) {
      return { content: '', error: e instanceof Error ? e.message : String(e) }
    }
    this.knowledgeProjectContext = pid

    try {
      let result: ToolCallResult
      switch (name) {
        case 'read_file':
          result = this.readFile(avatarId, conversationId, args); break
        case 'read_lines':
          result = this.readLines(avatarId, conversationId, args); break
        case 'write_file':
          result = this.writeFile(avatarId, conversationId, args); break
        case 'list_files':
          result = this.listFiles(avatarId, conversationId, args); break
        case 'grep':
          result = this.grepWorkspace(avatarId, conversationId, args); break
        case 'copy_files':
          result = this.copyFiles(avatarId, conversationId, args); break
        case 'str_replace_edit':
          result = this.strReplaceEdit(avatarId, conversationId, args); break
        case 'multi_edit':
          result = this.multiEdit(avatarId, conversationId, args); break
        case 'delete_file':
          result = this.deleteFile(avatarId, conversationId, args); break
        case 'git_status':
          result = await this.gitStatus(avatarId, conversationId, args); break
        case 'git_diff':
          result = await this.gitDiff(avatarId, conversationId, args); break
        case 'notebook_edit':
          result = this.notebookEdit(avatarId, conversationId, args); break
        case 'register_assets':
          result = this.registerAssets(avatarId, conversationId, args); break
        case 'unregister_assets':
          result = this.unregisterAssets(avatarId, conversationId, args); break
        case 'read_knowledge_file':
          result = this.readKnowledgeFile(avatarId, args); break
        case 'search_knowledge':
          result = this.searchKnowledge(avatarId, args); break
        case 'list_knowledge_files':
          result = this.listKnowledgeFiles(avatarId); break
        case 'knowledge_grep':
          result = this.knowledgeGrep(avatarId, args); break
        case 'knowledge_glob':
          result = this.knowledgeGlob(avatarId, args); break
        case 'list_wiki_concepts':
          result = await this.listWikiConcepts(avatarId, args); break
        case 'read_wiki_concept':
          result = await this.readWikiConcept(avatarId, args); break
        case 'read_life_episode':
          result = await this.readLifeEpisode(avatarId, args); break
        case 'recall_conversation':
          result = await this.recallConversation(avatarId, args); break
        case 'list_design_systems':
          result = this.listDesignSystems(args); break
        case 'read_design_system':
          result = this.readDesignSystem(args); break
        case 'search_design_systems':
          result = this.searchDesignSystems(args); break
        case 'query_excel':
          result = this.queryExcel(avatarId, args); break
        case 'export_excel':
          result = this.exportExcel(avatarId, conversationId, args); break
        case 'generate_document':
          result = await this.generateDocument(avatarId, conversationId, args); break
        case 'calculate_roi':
          result = this.calculateRoi(args); break
        case 'load_skill':
          result = this.loadSkill(avatarId, args); break
        case 'delegate_task':
        case 'task':
          // task 是 delegate_task 的升级别名（九层重构 2026-04-30），保留 delegate_task 兼容旧 skill
          result = await this.delegateTask(avatarId, args, callLLM, conversationId); break
        case 'glob':
          // glob 是 list_files 的语义别名：把 pattern 映射到 list_files 的 glob 参数
          result = this.listFiles(avatarId, conversationId, {
            ...args,
            glob: typeof args.pattern === 'string' ? args.pattern : (args.glob as string | undefined),
          }); break
        case 'ask_question':
          result = this.askQuestion(args); break
        case 'generate_image':
          result = await this.generateImage(avatarId, conversationId, args); break
        case 'switch_mode':
          result = this.switchMode(args); break
        case 'exec_shell':
          result = await this.execShell(avatarId, conversationId, args); break
        case 'exec_code':
          result = await this.execCode(avatarId, conversationId, args); break
        case 'await_shell':
          result = await this.awaitShell(args); break
        case 'kill_shell':
          result = this.killShell(args); break
        case 'web_search':
          result = await this.webSearch(args); break
        case 'web_fetch':
          result = await this.webFetch(args); break
        case 'read_tool_ref':
          result = this.readToolRefTool(avatarId, conversationId, args); break
        case 'list_mcp_tools':
          result = this.listMcpTools(args); break
        case 'call_mcp_tool':
          result = await this.callMcpTool(args); break
        default:
          return { content: '', error: `未知工具: ${name}` }
      }
      // v0.6.0: 如果本次工具调用触发了 lazy tokenize，把新的 tokens 落盘到
      // _index/tokens.json，下次重启不用再花 30-180 秒重新 segmentit 分词。
      // 覆盖所有可能调 retriever.searchChunks 的工具（search_knowledge、内部 wiki 注入等），
      // 不只是显式 search_knowledge。
      this.saveRetrieverTokens(avatarId)
      // 2026-05-18: Tool Result 压缩层（TokenJuice 启发）。
      // 仅压缩 content；error 字段不动。透传白名单 + env 短路在 compressToolResult 内部处理。
      // 任何异常自动降级为原文（compressor 内 try/catch 兜底），绝不破坏工具输出。
      if (result.content && !result.error) {
        const before = result.content.length
        const compressed = compressToolResult(name, result.content, this.compressConfig)
        if (compressed.finalChars < before) {
          console.log(`[tool-router] compress ${name}: ${before} → ${compressed.finalChars} chars (-${before - compressed.finalChars}, droppedSections=${compressed.droppedSections})`)
          result = { ...result, content: compressed.content }
        }
      }
      // 2026-05-18: Tool Result Lazy Store（TDAI symbolic memory 启发）。
      // 长 web_fetch 等输出落盘到 workspaces/<conv>/tool-refs/，prompt 只留 body_lazy_ref 标记。
      // 默认 off（SOUL_TOOL_LAZY_RETRIEVAL=on 启用）；仅对 lazyStoreConfig.allowedTools 触发。
      // 需要 conversationId 才能拿 workspace 路径；无 convId 时跳过 lazy（如 delegate_task 内部调用）。
      if (
        result.content && !result.error
        && this.lazyStoreConfig.enabled
        && this.lazyStoreConfig.allowedTools.has(name)
        && conversationId
      ) {
        try {
          const workspaceRoot = this.getWorkspaceRoot(avatarId, conversationId)
          const lazied = maybeStoreLazyRef(result.content, this.lazyStoreConfig, {
            workspaceRoot,
            toolName: name,
            toolArgs: args,
          })
          if (lazied.stored) {
            console.log(`[tool-router] lazy-store ${name}: stored as ${lazied.callId}, prompt content ${result.content.length} → ${lazied.content.length} chars`)
            result = { ...result, content: lazied.content }
          }
        } catch (err) {
          // 失败不影响原结果——lazy 是优化层，不是核心路径
          console.warn(`[tool-router] lazy-store ${name} 失败（降级为原文）:`, err instanceof Error ? err.message : String(err))
        }
      }
      return result
    } catch (error) {
      return { content: '', error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.knowledgeProjectContext = prevCtx
    }
  }

  // ─── 知识库工具 ──────────────────────────────────────────────────────────────

  private readFile(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): ToolCallResult {
    const filePath = (args.path as string) ?? ''
    if (!filePath) return { content: '', error: '缺少 path 参数' }
    const abs = this.resolveWorkspacePath(avatarId, conversationId, filePath)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { content: '', error: `文件不存在: ${filePath}` }
    }
    const offset = typeof args.offset === 'number' ? Math.max(0, Math.floor(args.offset)) : 0
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : 2000
    const lines = fs.readFileSync(abs, 'utf-8').split(/\r?\n/)
    const sliced = lines.slice(offset, offset + limit)
    return { content: sliced.map((line, idx) => `${offset + idx + 1}|${line}`).join('\n') }
  }

  /**
   * read_lines: 按 1-based 行号读取文件指定区间。
   *
   * 与 read_file 互补：read_file 用 0-based offset+limit 偏移读，read_lines 直接传
   * start_line/end_line（左闭右闭，更符合 LLM 阅读栈跟踪/diff/lint 报错的直觉）。
   *
   * 设计要点：
   *   - start_line 默认 1（文件首行）
   *   - end_line 默认 start_line + READ_LINES_DEFAULT_RANGE - 1（控制单次输出体积，省 token）
   *   - end_line 自动收口到文件末行；start_line > 文件总行数时报错而非返回空
   *   - 强制硬上限 READ_LINES_HARD_LIMIT（4000 行）防止 LLM 误传 1～100000 撑爆 context
   *   - 输出每行带 `${行号}|${内容}` 前缀，与 read_file 保持一致，方便下游再次按行号编辑
   *
   * 参数：
   *   path: string        — 工作区相对路径（必填）
   *   start_line?: number — 起始行号（1-based，默认 1）
   *   end_line?: number   — 结束行号（1-based，包含；默认 start_line + 199）
   *
   * @author zhi.qu
   * @date 2026-04-29
   */
  private readLines(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): ToolCallResult {
    const filePath = (args.path as string) ?? ''
    if (!filePath) return { content: '', error: '缺少 path 参数' }
    const abs = this.resolveWorkspacePath(avatarId, conversationId, filePath)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { content: '', error: `文件不存在: ${filePath}` }
    }

    const startLine = typeof args.start_line === 'number' && Number.isFinite(args.start_line)
      ? Math.max(1, Math.floor(args.start_line))
      : 1

    const lines = fs.readFileSync(abs, 'utf-8').split(/\r?\n/)
    const totalLines = lines.length
    if (startLine > totalLines) {
      return {
        content: '',
        error: `start_line=${startLine} 超过文件总行数 ${totalLines}（文件: ${filePath}）`,
      }
    }

    const requestedEnd = typeof args.end_line === 'number' && Number.isFinite(args.end_line)
      ? Math.floor(args.end_line)
      : startLine + READ_LINES_DEFAULT_RANGE - 1
    if (requestedEnd < startLine) {
      return { content: '', error: `end_line(${requestedEnd}) < start_line(${startLine})` }
    }
    // 受硬上限约束，再收口到文件末行
    const cappedEnd = Math.min(
      totalLines,
      Math.min(requestedEnd, startLine + READ_LINES_HARD_LIMIT - 1),
    )

    const sliced = lines.slice(startLine - 1, cappedEnd)
    const truncated = requestedEnd > cappedEnd
    const body = sliced.map((line, idx) => `${startLine + idx}|${line}`).join('\n')
    if (truncated) {
      return {
        content: `${body}\n[truncated: 实际返回 ${startLine}-${cappedEnd}/${totalLines}，原请求 end_line=${requestedEnd} 受 ${READ_LINES_HARD_LIMIT} 行硬上限或文件末尾限制]`,
      }
    }
    return { content: body }
  }

  private writeFile(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): ToolCallResult {
    const filePath = (args.path as string) ?? ''
    const content = (args.content as string) ?? ''
    if (!filePath) return { content: '', error: '缺少 path 参数' }
    const abs = this.resolveWorkspacePath(avatarId, conversationId, filePath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')

    if (typeof args.asset === 'string' && args.asset.trim().length > 0) {
      const items = this.readAssetManifest(avatarId, conversationId)
      const rel = path.relative(this.getWorkspaceRoot(avatarId, conversationId), abs).replace(/\\/g, '/')
      const next = [
        ...items.filter((it) => !(it.asset === args.asset && it.path === rel)),
        { asset: args.asset.trim(), path: rel, subtitle: typeof args.subtitle === 'string' ? args.subtitle : undefined },
      ]
      this.writeAssetManifest(avatarId, conversationId, next)
    }
    return { content: `已写入 ${filePath}` }
  }

  /**
   * list_files: 列出工作区目录文件。
   *
   * 支持三种过滤方式（互斥优先级 glob > filter；不传则不过滤）：
   *   - glob:   `**\/*.ts` / `*.tsx` / `src/**\/*.json` 等 glob 模式（LLM 最熟悉）
   *   - filter: 正则字符串（旧版兼容；走 RegExp(filter, 'i')）
   *
   * 当 glob 中出现 `**` 时会自动把 depth 提升到 DEFAULT_MAX_DIR_DEPTH，避免
   * LLM 传了 `**` 又忘记调大 depth 导致命中不到深层文件。
   *
   * 输出条目硬上限 LIST_FILES_HARD_LIMIT（500），超过会截断并附 truncated 标志。
   */
  private listFiles(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): ToolCallResult {
    const relPath = (args.path as string) ?? '.'
    const offset = typeof args.offset === 'number' ? Math.max(0, Math.floor(args.offset)) : 0
    const filter = typeof args.filter === 'string' ? args.filter : ''
    const glob = typeof args.glob === 'string' ? args.glob.trim() : ''

    // glob 含 ** 时强制递归到默认最大深度；否则尊重 LLM 传的 depth（默认 1 层）
    const requestedDepth = typeof args.depth === 'number' ? Math.max(1, Math.floor(args.depth)) : 1
    const depth = (glob.includes('**') && requestedDepth < DEFAULT_MAX_DIR_DEPTH)
      ? DEFAULT_MAX_DIR_DEPTH
      : requestedDepth

    const abs = this.resolveWorkspacePath(avatarId, conversationId, relPath)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return { content: '', error: `目录不存在: ${relPath}` }
    }

    const entries: Array<{ path: string; type: 'file' | 'directory' }> = []
    const walk = (dir: string, level: number): void => {
      const list = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of list) {
        const full = path.join(dir, entry.name)
        const rel = path.relative(abs, full).replace(/\\/g, '/')
        entries.push({ path: rel, type: entry.isDirectory() ? 'directory' : 'file' })
        if (entry.isDirectory() && level < depth) {
          walk(full, level + 1)
        }
      }
    }
    walk(abs, 1)

    let predicate: (e: { path: string; type: 'file' | 'directory' }) => boolean
    if (glob) {
      const globRegex = globToRegExp(glob)
      // glob 通常用于匹配文件；目录条目放行以便 LLM 还能顺着结构往下钻
      predicate = (e) => e.type === 'directory' || globRegex.test(e.path)
    } else if (filter) {
      const regex = new RegExp(filter, 'i')
      predicate = (e) => regex.test(e.path)
    } else {
      predicate = () => true
    }
    const filtered = entries.filter(predicate)
    const page = filtered.slice(offset, offset + LIST_FILES_HARD_LIMIT)
    const truncated = filtered.length > offset + page.length
    return {
      content: JSON.stringify({
        total: filtered.length,
        offset,
        count: page.length,
        truncated,
        ...(truncated ? { truncate_hint: `结果超过 ${LIST_FILES_HARD_LIMIT} 条已截断；请用 glob/filter 缩小范围或翻页（offset=${offset + page.length}）。` } : {}),
        items: page,
      }, null, 2),
    }
  }

  private grepWorkspace(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): ToolCallResult {
    const pattern = args.pattern as string
    if (!pattern) return { content: '', error: '缺少 pattern 参数' }
    const relPath = (args.path as string) ?? '.'
    const abs = this.resolveWorkspacePath(avatarId, conversationId, relPath)
    if (!fs.existsSync(abs)) return { content: '', error: `路径不存在: ${relPath}` }
    const regex = new RegExp(pattern, 'i')
    const files = fs.statSync(abs).isDirectory()
      ? collectFilesRecursive(abs, '', DEFAULT_MAX_DIR_DEPTH).filter((f) => fs.statSync(f).isFile())
      : [abs]
    const results: Array<{ file: string; line: number; text: string }> = []
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push({
            file: path.relative(this.getWorkspaceRoot(avatarId, conversationId), file).replace(/\\/g, '/'),
            line: i + 1,
            text: lines[i],
          })
        }
      }
    }
    return { content: JSON.stringify({ count: results.length, matches: results.slice(0, 100) }, null, 2) }
  }

  private copyFiles(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): ToolCallResult {
    const files = args.files as Array<{ src: string; dest: string; move?: boolean }> | undefined
    if (!Array.isArray(files) || files.length === 0) return { content: '', error: '缺少 files 参数' }
    for (const item of files) {
      const srcAbs = this.resolveWorkspacePath(avatarId, conversationId, item.src)
      const destAbs = this.resolveWorkspacePath(avatarId, conversationId, item.dest)
      fs.mkdirSync(path.dirname(destAbs), { recursive: true })
      fs.cpSync(srcAbs, destAbs, { recursive: true, force: true })
      if (item.move) fs.rmSync(srcAbs, { recursive: true, force: true })
    }
    return { content: `已复制 ${files.length} 项` }
  }

  private strReplaceEdit(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): ToolCallResult {
    const filePath = (args.path as string) ?? ''
    if (!filePath) return { content: '', error: '缺少 path 参数' }
    const abs = this.resolveWorkspacePath(avatarId, conversationId, filePath)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { content: '', error: `文件不存在: ${filePath}` }
    let content = fs.readFileSync(abs, 'utf-8')
    const edits = Array.isArray(args.edits) ? args.edits as Array<{ old_string: string; new_string: string }> : null
    if (edits && edits.length > 0) {
      for (const edit of edits) {
        if (!content.includes(edit.old_string)) {
          return { content: '', error: `old_string 未找到: ${edit.old_string.slice(0, 40)}` }
        }
        content = content.replace(edit.old_string, edit.new_string)
      }
    } else {
      const oldString = args.old_string as string
      const newString = args.new_string as string
      if (!oldString) return { content: '', error: '缺少 old_string 参数' }
      if (!content.includes(oldString)) return { content: '', error: 'old_string 未找到' }
      content = content.replace(oldString, newString ?? '')
    }
    fs.writeFileSync(abs, content, 'utf-8')
    return { content: `已更新 ${filePath}` }
  }

  /**
   * multi_edit: 在单个文件内顺序应用多条 string-replace 编辑，原子写入。
   *
   * 与 str_replace_edit（已支持 edits 数组）的区别：
   *   1. 单条编辑可声明 `replace_all`（默认 false 仅替换首次匹配；true 全部替换）
   *   2. 任意一条 old_string 未命中 → 不写入任何更改，直接报错（真正"全部成功 or 全部回滚"）
   *   3. 返回每条编辑的命中次数与总命中数，便于 LLM 校验是否符合预期
   *   4. 显式禁止 old_string === new_string 的"无操作"编辑（防止 LLM 浪费一轮）
   *
   * 参数：
   *   path: string                                 — 工作区相对路径（必填）
   *   edits: Array<{                              — 至少 1 条
   *     old_string: string,
   *     new_string: string,
   *     replace_all?: boolean (默认 false)
   *   }>
   *
   * @author zhi.qu
   * @date 2026-04-29
   */
  private multiEdit(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): ToolCallResult {
    const filePath = (args.path as string) ?? ''
    if (!filePath) return { content: '', error: '缺少 path 参数' }

    const rawEdits = args.edits
    if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
      return { content: '', error: '缺少 edits 参数（需为至少含 1 条 {old_string, new_string} 的数组）' }
    }

    interface NormEdit { old_string: string; new_string: string; replace_all: boolean }
    const edits: NormEdit[] = []
    for (const [idx, raw] of rawEdits.entries()) {
      if (!raw || typeof raw !== 'object') {
        return { content: '', error: `edits[${idx}] 不是对象` }
      }
      const e = raw as Record<string, unknown>
      const oldStr = typeof e.old_string === 'string' ? e.old_string : ''
      const newStr = typeof e.new_string === 'string' ? e.new_string : ''
      if (!oldStr) return { content: '', error: `edits[${idx}].old_string 缺失或为空` }
      if (oldStr === newStr) {
        return { content: '', error: `edits[${idx}] 的 old_string 与 new_string 相同（无操作编辑），请删除该条` }
      }
      edits.push({
        old_string: oldStr,
        new_string: newStr,
        replace_all: e.replace_all === true,
      })
    }

    const abs = this.resolveWorkspacePath(avatarId, conversationId, filePath)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { content: '', error: `文件不存在: ${filePath}` }
    }

    let working = fs.readFileSync(abs, 'utf-8')
    const perEditHits: Array<{ index: number; hits: number; replace_all: boolean; old_preview: string }> = []

    // 顺序应用，遇到任意一条 old_string 未命中 → 立即拒绝整个事务
    for (const [idx, edit] of edits.entries()) {
      if (!working.includes(edit.old_string)) {
        return {
          content: '',
          error: `edits[${idx}] 失败：old_string 未在文件中找到（截断预览: "${edit.old_string.slice(0, 60)}${edit.old_string.length > 60 ? '...' : ''}"）。事务回滚，文件未改动。`,
        }
      }
      let hits: number
      if (edit.replace_all) {
        // 用 split/join 实现安全的全量替换（避免正则元字符问题）
        const parts = working.split(edit.old_string)
        hits = parts.length - 1
        working = parts.join(edit.new_string)
      } else {
        hits = 1
        working = working.replace(edit.old_string, edit.new_string)
      }
      perEditHits.push({
        index: idx,
        hits,
        replace_all: edit.replace_all,
        old_preview: edit.old_string.slice(0, 40),
      })
    }

    // 全部成功才落盘
    fs.writeFileSync(abs, working, 'utf-8')

    const totalHits = perEditHits.reduce((sum, e) => sum + e.hits, 0)
    return {
      content: JSON.stringify({
        path: filePath,
        edits_applied: edits.length,
        total_replacements: totalHits,
        per_edit: perEditHits,
        hint: '事务已原子提交。如需校验改动效果，建议下一步 read_lines 该文件相关区间。',
      }, null, 2),
    }
  }

  private deleteFile(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): ToolCallResult {
    const paths = args.paths as string[] | undefined
    if (!Array.isArray(paths) || paths.length === 0) return { content: '', error: '缺少 paths 参数' }
    for (const p of paths) {
      const abs = this.resolveWorkspacePath(avatarId, conversationId, p)
      fs.rmSync(abs, { recursive: true, force: true })
    }
    return { content: `已删除 ${paths.length} 项` }
  }

  /**
   * notebook_edit: 编辑 Jupyter notebook (.ipynb) 的单个 cell（修改或新建）。
   *
   * .ipynb 是 JSON：顶层有 cells[] 数组，每个 cell 形如：
   *   { cell_type: 'code'|'markdown'|'raw', source: string|string[], metadata: {...},
   *     outputs?: [], execution_count?: number|null }
   *
   * 行为：
   *   - is_new_cell=true  → 在 cell_idx 位置插入新 cell（其它 cells 后移）
   *   - is_new_cell=false → 修改 cell_idx 处现有 cell：把 source 中 old_string 替换为 new_string
   *     （old_string 为空 → 整段 source 覆写为 new_string；语义与 Cursor notebook_edit 对齐）
   *   - cell_language 决定 cell_type：
   *       'python' / 'javascript' / 'typescript' / 'r' / 'sql' / 'shell' / 'other' → 'code'
   *       'markdown' → 'markdown'
   *       'raw'      → 'raw'
   *   - 修改 code cell 的 source 时，重置 execution_count=null 并清空 outputs
   *     （执行结果与新代码不再对应，避免误导 LLM 与下游消费方）
   *
   * 安全：
   *   - 非 .ipynb 后缀拒绝，避免误伤普通文件
   *   - JSON.parse / 字段类型校验失败时不写入，原文件不受影响
   *
   * 参数：
   *   target_notebook: string                    — 工作区相对路径（必须 .ipynb 结尾）
   *   cell_idx: number                          — 0-based cell 索引
   *   is_new_cell: boolean                      — true 新增；false 修改
   *   cell_language: string                     — 见上文映射规则
   *   old_string?: string                       — 修改场景下的待替换串（空串=覆盖整段）
   *   new_string: string                        — 替换后的新内容（is_new_cell 时为新 cell 内容）
   *
   * @author zhi.qu
   * @date 2026-04-29
   */
  private notebookEdit(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): ToolCallResult {
    const target = (args.target_notebook as string) ?? ''
    if (!target) return { content: '', error: '缺少 target_notebook 参数' }
    if (!target.toLowerCase().endsWith('.ipynb')) {
      return { content: '', error: `target_notebook 必须以 .ipynb 结尾，实际: ${target}` }
    }

    const cellIdxRaw = args.cell_idx
    if (typeof cellIdxRaw !== 'number' || !Number.isInteger(cellIdxRaw) || cellIdxRaw < 0) {
      return { content: '', error: 'cell_idx 必须是 ≥0 的整数' }
    }
    const cellIdx = cellIdxRaw

    const isNewCell = args.is_new_cell === true
    const language = (args.cell_language as string) ?? ''
    if (!language) return { content: '', error: '缺少 cell_language 参数' }

    const cellType = mapNotebookCellType(language)
    if (!cellType) {
      return { content: '', error: `不支持的 cell_language: "${language}"。可选: python, markdown, javascript, typescript, r, sql, shell, raw, other` }
    }

    const oldString = typeof args.old_string === 'string' ? args.old_string : ''
    const newString = typeof args.new_string === 'string' ? args.new_string : ''

    if (!isNewCell && oldString === '' && newString === '') {
      return { content: '', error: '编辑模式下 old_string 与 new_string 同时为空，无操作可执行' }
    }

    const abs = this.resolveWorkspacePath(avatarId, conversationId, target)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { content: '', error: `notebook 不存在: ${target}` }
    }

    let raw: string
    try {
      raw = fs.readFileSync(abs, 'utf-8')
    } catch (e) {
      return { content: '', error: `读取 notebook 失败: ${e instanceof Error ? e.message : String(e)}` }
    }

    let nb: { cells?: unknown[]; nbformat?: number; nbformat_minor?: number; metadata?: Record<string, unknown> }
    try {
      nb = JSON.parse(raw) as typeof nb
    } catch (e) {
      return { content: '', error: `notebook JSON 解析失败: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells)) {
      return { content: '', error: 'notebook 结构非法：缺少顶层 cells 数组' }
    }
    const cells = nb.cells as Array<Record<string, unknown>>

    if (isNewCell) {
      if (cellIdx > cells.length) {
        return { content: '', error: `cell_idx=${cellIdx} 超出范围（当前有 ${cells.length} 个 cell，新增最大下标 ${cells.length}）` }
      }
      const newCell: Record<string, unknown> = {
        cell_type: cellType,
        metadata: {},
        source: splitNotebookSource(newString),
      }
      if (cellType === 'code') {
        newCell.execution_count = null
        newCell.outputs = []
      }
      cells.splice(cellIdx, 0, newCell)
    } else {
      if (cellIdx >= cells.length) {
        return { content: '', error: `cell_idx=${cellIdx} 超出范围（当前有 ${cells.length} 个 cell，最大下标 ${cells.length - 1}）` }
      }
      const cell = cells[cellIdx]
      if (!cell || typeof cell !== 'object') {
        return { content: '', error: `cells[${cellIdx}] 结构非法（不是对象）` }
      }
      const currentSource = joinNotebookSource(cell.source)
      let nextSource: string
      if (oldString === '') {
        // 整段覆盖
        nextSource = newString
      } else {
        if (!currentSource.includes(oldString)) {
          return {
            content: '',
            error: `cells[${cellIdx}] 的 source 中未找到 old_string（截断预览: "${oldString.slice(0, 60)}${oldString.length > 60 ? '...' : ''}"）`,
          }
        }
        nextSource = currentSource.replace(oldString, newString)
      }
      cell.cell_type = cellType
      cell.source = splitNotebookSource(nextSource)
      // source 变化 → 旧的执行结果失效
      if (cellType === 'code') {
        cell.execution_count = null
        cell.outputs = []
      } else {
        // 切换到非 code 类型时移除 code 专属字段
        delete cell.execution_count
        delete cell.outputs
      }
    }

    // 写回；保持 nbformat 字段不变，确保 Jupyter 仍可打开
    let serialized: string
    try {
      serialized = JSON.stringify(nb, null, 1)
    } catch (e) {
      return { content: '', error: `notebook 序列化失败: ${e instanceof Error ? e.message : String(e)}` }
    }
    fs.writeFileSync(abs, serialized, 'utf-8')

    return {
      content: JSON.stringify({
        target_notebook: target,
        action: isNewCell ? 'insert' : 'edit',
        cell_idx: cellIdx,
        cell_type: cellType,
        cell_language: language,
        total_cells: cells.length,
        hint: '已写入。建议下一步用 read_file 校验 notebook 仍可被 Jupyter 解析。',
      }, null, 2),
    }
  }

  /**
   * git_status: 在工作区目录下执行 `git status --short`（紧凑格式，省 token）。
   *
   * 让 LLM 自我观测："我刚才改动了哪些文件？"，避免重复 read 已写入的文件。
   *
   * 安全模型：
   *   - 直接 spawn('git', [...args], { shell:false, cwd })，参数数组化避免命令注入
   *   - cwd 锁定到 workspace 目录（受 resolveWorkspacePath 校验，禁穿越）
   *   - 工作区不是 git 仓库时返回友好提示，不抛错
   *
   * 参数：
   *   path?: string       — 工作区相对路径（默认 "."；用于限定 status 关心的子目录）
   *
   * @author zhi.qu
   * @date 2026-04-29
   */
  private async gitStatus(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): Promise<ToolCallResult> {
    const subPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.'
    let cwd: string
    try {
      cwd = this.resolveWorkspacePath(avatarId, conversationId, subPath)
    } catch (e) {
      return { content: '', error: `path 校验失败: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (!fs.existsSync(cwd)) {
      return { content: '', error: `路径不存在: ${subPath}` }
    }

    const repoCheck = await runGitCommand(cwd, ['rev-parse', '--show-toplevel'])
    if (repoCheck.exitCode !== 0) {
      return {
        content: '',
        error: `当前工作区不在 git 仓库中（${cwd}）。请先在该目录执行 git init，或检查 path 是否正确。`,
      }
    }
    const repoRoot = repoCheck.stdout.trim()

    // --short 输出紧凑（每行一个文件，前缀 XY 标记 staged/working tree 状态）
    // -uall  把未跟踪文件展开到具体文件名（默认 normal 仅显示目录）
    // -- <path> 限定路径
    const args4 = ['status', '--short', '-uall']
    if (subPath !== '.') args4.push('--', subPath)

    const result = await runGitCommand(cwd, args4)
    if (result.exitCode !== 0) {
      return { content: '', error: `git status 执行失败 (exit ${result.exitCode}): ${result.stderr || result.stdout}` }
    }
    const lines = result.stdout.split(/\r?\n/).filter((l) => l.length > 0)
    const payload = {
      repo_root: repoRoot,
      cwd: subPath,
      changed_count: lines.length,
      truncated: result.truncated,
      hint: lines.length === 0 ? '工作区干净，无改动。' : '前两个字符为状态标记：M=modified, A=added, D=deleted, ?? =untracked, R=renamed。',
      changes: lines,
      ...(result.truncated ? { truncate_hint: `输出超过 ${GIT_OUTPUT_MAX_CHARS} 字符已截断；请加 path 参数缩小范围。` } : {}),
    }
    return { content: JSON.stringify(payload, null, 2) }
  }

  /**
   * git_diff: 在工作区目录下执行 `git diff`（默认 worktree 与 index 的差异）。
   *
   * 让 LLM 复核自己刚刚的改动，是 multi_edit / write_file 后做"我改对了吗"自检的标配。
   *
   * 参数：
   *   path?: string         — 限定 diff 的文件/目录（默认全仓库）
   *   staged?: boolean      — true → `git diff --cached`（已 staged 改动）
   *   max_chars?: number    — 输出字符上限（默认 GIT_OUTPUT_MAX_CHARS，硬上限亦相同；超出按字符截断）
   *   context_lines?: number — diff 上下文行数（默认 3，git 标准）
   *
   * @author zhi.qu
   * @date 2026-04-29
   */
  private async gitDiff(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): Promise<ToolCallResult> {
    const subPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.'
    let cwd: string
    try {
      cwd = this.resolveWorkspacePath(avatarId, conversationId, subPath)
    } catch (e) {
      return { content: '', error: `path 校验失败: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (!fs.existsSync(cwd)) {
      return { content: '', error: `路径不存在: ${subPath}` }
    }

    const repoCheck = await runGitCommand(cwd, ['rev-parse', '--show-toplevel'])
    if (repoCheck.exitCode !== 0) {
      return { content: '', error: `当前工作区不在 git 仓库中（${cwd}）。` }
    }

    const staged = args.staged === true
    const contextLines = typeof args.context_lines === 'number' && args.context_lines >= 0 && args.context_lines <= 50
      ? Math.floor(args.context_lines)
      : 3

    const cmdArgs = ['diff', `--unified=${contextLines}`, '--no-color']
    if (staged) cmdArgs.push('--cached')
    if (subPath !== '.') cmdArgs.push('--', subPath)

    const maxChars = typeof args.max_chars === 'number' && args.max_chars > 0
      ? Math.min(GIT_OUTPUT_MAX_CHARS, Math.floor(args.max_chars))
      : GIT_OUTPUT_MAX_CHARS
    const result = await runGitCommand(cwd, cmdArgs, maxChars)
    if (result.exitCode !== 0) {
      return { content: '', error: `git diff 执行失败 (exit ${result.exitCode}): ${result.stderr || result.stdout}` }
    }

    const diff = result.stdout
    if (!diff.trim()) {
      return {
        content: JSON.stringify({
          cwd: subPath,
          staged,
          empty: true,
          hint: staged ? '没有 staged 改动。' : '工作区与 index 之间没有差异。',
        }, null, 2),
      }
    }

    return {
      content: JSON.stringify({
        cwd: subPath,
        staged,
        context_lines: contextLines,
        char_count: diff.length,
        truncated: result.truncated,
        ...(result.truncated ? { truncate_hint: `diff 超过 ${maxChars} 字符已截断；请加 path 参数限定到具体文件，或调小 context_lines。` } : {}),
        diff,
      }, null, 2),
    }
  }

  private registerAssets(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): ToolCallResult {
    const items = args.items as AssetManifestItem[] | undefined
    if (!Array.isArray(items) || items.length === 0) return { content: '', error: '缺少 items 参数' }
    const existing = this.readAssetManifest(avatarId, conversationId)
    let merged = [...existing]
    for (const item of items) {
      if (!item.asset || !item.path) continue
      merged = merged.filter((it) => !(it.asset === item.asset && it.path === item.path))
      merged.push(item)
    }
    this.writeAssetManifest(avatarId, conversationId, merged)
    return { content: `已注册 ${items.length} 个资产` }
  }

  private unregisterAssets(avatarId: string, conversationId: string | undefined, args: Record<string, unknown>): ToolCallResult {
    const items = args.items as Array<{ asset?: string; path?: string }> | undefined
    if (!Array.isArray(items) || items.length === 0) return { content: '', error: '缺少 items 参数' }
    const existing = this.readAssetManifest(avatarId, conversationId)
    const filtered = existing.filter((it) => {
      return !items.some((target) => {
        const assetMatch = target.asset ? target.asset === it.asset : true
        const pathMatch = target.path ? target.path === it.path : true
        return assetMatch && pathMatch
      })
    })
    this.writeAssetManifest(avatarId, conversationId, filtered)
    return { content: `已移除 ${existing.length - filtered.length} 个资产` }
  }

  /**
   * 检查指定分身的知识库是否为空（即 knowledge/ 下无任何 .md 文件）。
   *
   * 用于 search_knowledge / read_knowledge_file / list_knowledge_files
   * 三个工具入口的前置短路：当知识库为空时直接返回明确"空库"信号，
   * 避免 LLM 反复换关键词检索导致工具调用循环 + 流式响应静默超时。
   *
   * 边界：仅 README.md 占位文件也会被 listFiles() 计入；只有当 listFiles 返回
   * 空数组时才视为"完全空库"。检测异常时降级为 false（保留原行为，不误伤）。
   *
   * @author zhi.qu
   * @date 2026-05-07
   */
  private isKnowledgeBaseEmpty(avatarId: string): boolean {
    try {
      return this.getKnowledgeSurfaceForContext(avatarId).listFiles().length === 0
    } catch (err) {
      console.warn(`[tool-router] isKnowledgeBaseEmpty 检测失败 avatarId=${avatarId}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /**
   * 构造"知识库为空"的统一工具结果。
   *
   * 文案以 [KNOWLEDGE_BASE_EMPTY] 信号词开头 + 明确的"停止再次调用"指令，
   * 引导 LLM 立即终止知识库工具调用、直接向用户解释知识库未导入文件，
   * 而不是凭通用知识硬答。
   *
   * @author zhi.qu
   * @date 2026-05-07
   */
  private buildEmptyKnowledgeBaseHint(): ToolCallResult {
    return {
      content: [
        '[KNOWLEDGE_BASE_EMPTY]',
        '当前分身知识库为空（0 个文件）。',
        '⛔ 请立即停止调用 search_knowledge / read_knowledge_file。',
        '请直接告诉用户：「当前知识库尚未导入任何文件，无法基于知识库回答；请先在知识库中导入相关资料。」',
      ].join('\n'),
    }
  }

  private readKnowledgeFile(avatarId: string, args: Record<string, unknown>): ToolCallResult {
    const rawFilePath = args.file_path as string
    if (!rawFilePath) return { content: '', error: '缺少 file_path 参数' }
    // LLM 经常把 search_knowledge 返回的 [来源: knowledge/...] 锚点里的路径整段复制过来，
    // 带 `knowledge/` 前缀。但 retriever.readFile 期望相对 knowledge/ 根的路径，多一层前缀
    // 就会拼成 `<avatar>/knowledge/knowledge/foo.md`，文件确实不存在。两种形式都接受。
    const filePath = rawFilePath.replace(/^(?:\.\/)?knowledge\//i, '')
    if (this.isKnowledgeBaseEmpty(avatarId)) {
      console.log(`[tool-router] read_knowledge_file 短路：知识库为空 avatarId=${avatarId} file=${filePath}`)
      return this.buildEmptyKnowledgeBaseHint()
    }
    const content = this.getKnowledgeSurfaceForContext(avatarId).readFile(filePath)
    const anchor = formatSourceAnchor(buildWholeFileKnowledgeAnchor(filePath, content))
    return { content: `${anchor}
${content}` }
  }

  /**
   * read_life_episode：读取当前分身人生时间轴中某个具体事件的完整正文。
   *
   * 让分身在用户问起具体往事时能"翻日记"取细节，而不是凭 system prompt 里的
   * consolidated.md 概览硬编往事。consolidated.md 已写入 system prompt，但
   * 单条 episode 全文（2-5K 字 × 60-100 个）不进 prompt——成本和上下文双重考虑。
   *
   * 路径安全：
   *   - avatarId：外层 execute 里已经过 assertSafeSegment（构造 ToolRouter 时上游守卫）
   *   - episodeId：通过 store.ts 的 getLifeEpisodePath → assertSafeEpisodeId
   *     校验（assertSafeSegment + 拒绝 `.` 开头 + 拒绝扩展名）
   *
   * @author zhi.qu
   * @date 2026-05-09
   */
  private async readLifeEpisode(avatarId: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const episodeId = typeof args.id === 'string' ? args.id.trim() : ''
    if (!episodeId) return { content: '', error: '缺少 id 参数（形如 ep-0007-first-snow）' }
    try {
      assertSafeSegment(avatarId, '分身ID')
      const text = await readLifeEpisodeFromStore(this.avatarsPath, avatarId, episodeId)
      if (text === null) {
        return { content: '', error: `事件不存在: ${episodeId}（请先用 system prompt 中「我的人生」章节出现的 id）` }
      }
      return { content: `[来源: life/episodes/${episodeId}.md]\n${text}` }
    } catch (err) {
      return { content: '', error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * recall_conversation：在过去对话情景记忆中按关键词检索 top-k（v17 Phase 2b）。
   *
   * 与 read_life_episode 的对偶——读"和用户的过去"而不是"想象人生"。
   * v1 评分简单：query 拆词后按 title/theme/keyQuotes/summary 命中次数排序。
   * 跳过 forgotten 状态的 episode（被遗忘机制筛掉的不该再被翻出来）。
   *
   * 入参：
   *   - query (string): 必填，关键词或自然语言查询
   *   - top_k (number): 可选，默认 3，最多 5
   *
   * 返回：每条 episode 的 title / theme / summary / keyQuotes / valence / importance。
   * 无命中时直说"无相关记忆"，让分身按 prompt 守则承认遗忘。
   *
   * @author zhi.qu
   * @date 2026-05-17
   */
  private async recallConversation(avatarId: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) return { content: '', error: '缺少 query 参数' }
    const rawTopK = typeof args.top_k === 'number' && Number.isFinite(args.top_k) ? args.top_k : 3
    const topK = Math.max(1, Math.min(5, Math.floor(rawTopK)))

    try {
      assertSafeSegment(avatarId, '分身ID')
      const episodes = await listConversationEpisodes(this.avatarsPath, avatarId)
      const candidates = episodes.filter((e) => e.consolidationStatus !== 'forgotten')

      if (candidates.length === 0) {
        return { content: '[recall_conversation] 当前分身还没有对话情景记忆——可能是第一次和你聊，或所有过去会话都没产生显著记忆。' }
      }

      // 简单评分：query 拆词后在 title/theme/keyQuotes/summary 里的命中次数。
      // 中文不分词：把 query 按空白切（覆盖英文/数字），同时取 2-3 字 n-gram 覆盖中文。
      // 1 字 token 噪声太大（"我"/"的"/"了"几乎所有 episode 都命中），跳过。
      const tokens: string[] = (() => {
        const out = new Set<string>()
        // 空白切分
        for (const w of query.split(/\s+/).filter(s => s.length > 0)) {
          if (w.length >= 2) out.add(w)
        }
        // 2-3 字 n-gram（处理无空白中文）
        const noSpace = query.replace(/\s+/g, '')
        for (let n = 2; n <= 3; n++) {
          for (let i = 0; i + n <= noSpace.length; i++) {
            out.add(noSpace.slice(i, i + n))
          }
        }
        return Array.from(out)
      })()
      const scored = candidates.map((ep) => {
        const haystack = [ep.title, ep.theme, ep.summary, ep.keyQuotes.join(' ')].join(' ').toLowerCase()
        let score = 0
        for (const t of tokens) {
          // 短 token 用全字符串匹配——简单但够用
          const occ = haystack.split(t.toLowerCase()).length - 1
          score += occ * (t.length >= 2 ? 2 : 1) // 2+ 字 token 权重略高
        }
        // 重要性 + 情感强度作为次级排序加成（命中 0 时不算回忆）
        const importanceBoost = ep.importance * 0.1
        return { ep, score: score + (score > 0 ? importanceBoost : 0) }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)

      if (scored.length === 0) {
        return { content: `[recall_conversation] 关键词 "${query}" 在我和你的过去对话里没找到相关记忆——这个我记不太清了。` }
      }

      const lines: string[] = [
        `[recall_conversation] 关键词 "${query}" 命中 ${scored.length} 条记忆：\n`,
      ]
      for (const { ep, score } of scored) {
        lines.push(`---\n## ${ep.title}（importance=${ep.importance}, valence=${ep.valence}, score=${score.toFixed(1)}）`)
        if (ep.theme.trim()) lines.push(`**主题**：${ep.theme}`)
        lines.push(`**summary**：${ep.summary}`)
        if (ep.keyQuotes.length > 0) {
          lines.push(`**关键引用**：\n${ep.keyQuotes.map((q) => `  - ${q}`).join('\n')}`)
        }
        lines.push('')
      }
      return { content: lines.join('\n') }
    } catch (err) {
      return { content: '', error: err instanceof Error ? err.message : String(err) }
    }
  }

  private searchKnowledge(avatarId: string, args: Record<string, unknown>): ToolCallResult {
    const mode = typeof args.mode === 'string' ? args.mode : 'search'
    if (mode === 'list') return this.listKnowledgeFiles(avatarId)
    if (mode !== 'search') return { content: '', error: `未知 search_knowledge mode: ${mode}` }
    if (this.isKnowledgeBaseEmpty(avatarId)) {
      console.log(`[tool-router] search_knowledge 短路：知识库为空 avatarId=${avatarId}`)
      return this.buildEmptyKnowledgeBaseHint()
    }
    const query = args.query as string
    if (!query) return { content: '', error: '缺少 query 参数' }
    const rawTopN = typeof args.top_n === 'number' && Number.isFinite(args.top_n) ? args.top_n : 5
    const topN = Math.min(12, Math.max(1, Math.floor(rawTopN)))
    const results = this.buildKnowledgeSearchResults(avatarId, query, {
      rawTopN: Math.max(topN + 6, 10),
      maxChunks: topN,
      maxPerFile: 3,
      minDistinctFiles: Math.min(3, Math.max(1, topN)),
      maxRelatedFiles: Math.min(4, Math.max(2, topN)),
    })
    // tokens 落盘由 execute() 末尾统一处理（覆盖所有内部 searchChunks 调用方）
    if (results.length === 0) {
      return { content: '未找到相关知识内容。' }
    }
    const content = results.map((r) => {
      const heading = r.heading?.trim() ? r.heading : '命中片段'
      const anchor = r.anchor ? formatSourceAnchor(r.anchor) : `[来源: knowledge/${r.file}]`
      return `### [${r.file}] ${heading}\n${anchor}\n${r.content}`
    }).join('\n\n---\n\n')
    return { content }
  }

  private listKnowledgeFiles(avatarId: string): ToolCallResult {
    const files = this.getKnowledgeSurfaceForContext(avatarId).listFiles()
    if (files.length === 0) {
      console.log(`[tool-router] list_knowledge_files 短路：知识库为空 avatarId=${avatarId}`)
      return this.buildEmptyKnowledgeBaseHint()
    }
    return { content: files.join('\n') }
  }

  /**
   * 收集当前分身 + 当前 project context 下的知识库 root 列表。
   * v1 不下钻 `shared/knowledge/`（共享知识量小，已直接注入 system prompt）。
   *
   * 返回数组每项 `{ relPrefix, absRoot }`：
   *   - relPrefix：返回结果里展示给 LLM 的相对路径前缀，如 `knowledge/` 或 `projects/<pid>/knowledge/`
   *   - absRoot：磁盘上的绝对路径根
   */
  private listKnowledgeRoots(avatarId: string): Array<{ relPrefix: string; absRoot: string }> {
    const roots: Array<{ relPrefix: string; absRoot: string }> = []
    const avatarKnowledge = path.join(this.avatarsPath, avatarId, 'knowledge')
    if (fs.existsSync(avatarKnowledge)) {
      roots.push({ relPrefix: 'knowledge/', absRoot: avatarKnowledge })
    }
    if (this.knowledgeProjectContext !== DEFAULT_AVATAR_PROJECT_ID) {
      const projKnowledge = path.join(
        this.avatarsPath, avatarId, 'projects', this.knowledgeProjectContext, 'knowledge',
      )
      if (fs.existsSync(projKnowledge)) {
        roots.push({
          relPrefix: `projects/${this.knowledgeProjectContext}/knowledge/`,
          absRoot: projKnowledge,
        })
      }
    }
    return roots
  }

  /**
   * knowledge_grep: 在知识库 .md/.txt/.markdown/.json/.yaml 文件里按正则精确搜索。
   *
   * 与 `search_knowledge`（BM25 + vector + RRF）互补：grep 适合精确关键词（型号编号、政策条款号、专有名词）。
   * search_knowledge 漏召回时用 grep 兜底。
   *
   * 红线：
   *   - 仅搜分身自己的 knowledge/（含当前 project knowledge），不下钻 shared/
   *   - scope 必须在 knowledge root 内（防路径穿越）
   *   - 硬上限：单文件 50 条 / 总计 200 条命中（防 LLM 误传过宽 pattern 撑爆 context）
   */
  private knowledgeGrep(avatarId: string, args: Record<string, unknown>): ToolCallResult {
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
    if (!pattern.trim()) return { content: '', error: '缺少 pattern 参数（正则表达式）' }

    let regex: RegExp
    try {
      regex = new RegExp(pattern, 'i')
    } catch (e) {
      return { content: '', error: `非法正则: ${e instanceof Error ? e.message : String(e)}` }
    }

    const scopeRaw = typeof args.scope === 'string' ? args.scope.trim() : ''
    const maxPerFile = typeof args.max_per_file === 'number' && args.max_per_file > 0
      ? Math.min(200, Math.floor(args.max_per_file))
      : 50
    const maxTotal = typeof args.max_total === 'number' && args.max_total > 0
      ? Math.min(500, Math.floor(args.max_total))
      : 200

    let roots = this.listKnowledgeRoots(avatarId)
    if (roots.length === 0) {
      return { content: JSON.stringify({ pattern, count: 0, matches: [], note: '知识库目录不存在' }, null, 2) }
    }

    // 应用 scope（如果有）—— 限定到子目录，scope 段会按 path-security 校验
    if (scopeRaw) {
      try {
        // scope 可能含多段（如 `imports/2025/`），逐段验
        for (const seg of scopeRaw.split('/').filter(Boolean)) {
          assertSafeSegment(seg, 'scope segment')
        }
      } catch (e) {
        return { content: '', error: e instanceof Error ? e.message : String(e) }
      }
      roots = roots
        .map((r) => {
          const sub = path.join(r.absRoot, scopeRaw)
          // resolveUnderRoot 确保 scope 解析后仍在 absRoot 内
          let resolved: string
          try {
            resolved = resolveUnderRoot(r.absRoot, scopeRaw)
          } catch {
            return null
          }
          if (!fs.existsSync(resolved)) return null
          return { relPrefix: r.relPrefix + scopeRaw.replace(/\/?$/, '/'), absRoot: resolved }
        })
        .filter((r): r is { relPrefix: string; absRoot: string } => r !== null)
      if (roots.length === 0) {
        return { content: '', error: `scope 路径不存在于任何知识库 root: ${scopeRaw}` }
      }
    }

    const matches: Array<{ file: string; line: number; text: string }> = []
    let totalCount = 0
    let truncated = false
    outer:
    for (const root of roots) {
      const files = collectFilesRecursive(root.absRoot, '', DEFAULT_MAX_DIR_DEPTH)
        .filter((f) => /\.(md|markdown|txt|json|yaml|yml)$/i.test(f))
      for (const file of files) {
        let perFile = 0
        try {
          const text = fs.readFileSync(file, 'utf-8')
          const lines = text.split(/\r?\n/)
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              // 先判 total 上限，避免跨文件时多 push 一条（per-file 重置导致的 off-by-one）
              if (totalCount >= maxTotal) { truncated = true; break outer }
              const rel = path.relative(root.absRoot, file).replace(/\\/g, '/')
              matches.push({
                file: root.relPrefix + rel,
                line: i + 1,
                text: lines[i].length > 300 ? lines[i].slice(0, 300) + '…' : lines[i],
              })
              perFile++
              totalCount++
              if (perFile >= maxPerFile) break
            }
          }
        } catch {/* 读文件失败跳过 */}
      }
    }

    return { content: JSON.stringify({
      pattern,
      scope: scopeRaw || undefined,
      count: matches.length,
      truncated,
      matches,
      hint: truncated ? '已达硬上限，请缩窄 pattern 或加 scope' : undefined,
    }, null, 2) }
  }

  /**
   * list_wiki_concepts: 列出分身 wiki/concepts/ 下所有 LLM 自动编译的实体概念页。
   *
   * 概念页是 WikiCompiler.compileConceptPages 调 LLM 把同一实体（如 "ENS-L262"）
   * 在不同知识文件的出现聚合成的独立 .md，含 LLM 摘要 + 属性表 + 来源依据 + 相关实体。
   *
   * 两种模式：
   *   - 无 query：返回所有概念页元数据列表（仅 name + entity + generated_at）。仅适合探索式浏览。
   *   - 有 query：读所有概念页正文做关键词匹配，返回 top_n 个最相关项 + 200 字符预览。**强烈推荐**：
   *     某些分身的 WikiCompiler 实体提取阶段会把"明确"/"数值"/"图片"等高频词识别成实体导致 name 字段
   *     无意义，无 query 时 LLM 无法从 name 列表识别目标实体；query 模式会扫正文匹配，绕开 name 命名问题。
   */
  private async listWikiConcepts(avatarId: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const topN = typeof args.top_n === 'number' && Number.isFinite(args.top_n) && args.top_n > 0
      ? Math.min(20, Math.floor(args.top_n)) : 10

    try {
      const wiki = new WikiCompiler(path.join(this.avatarsPath, avatarId))
      const meta = await wiki.getMeta()
      const pages = await wiki.getConceptPages()
      if (pages.length === 0) {
        return { content: JSON.stringify({
          count: 0,
          last_compiled: meta?.lastCompiled ?? null,
          note: '当前分身尚未编译实体概念页（wiki/concepts/ 为空）。请在「设置 → 知识库 → 编译 wiki」手动触发，或开启「导入后自动编译」。',
        }, null, 2) }
      }

      // 无 query 模式：返回元数据列表（向后兼容）
      if (!query) {
        return { content: JSON.stringify({
          count: pages.length,
          last_compiled: meta?.lastCompiled ?? null,
          pages: pages.map(p => ({ name: p.name, entity: p.entity, generated_at: p.generatedAt })),
          hint: '**建议加 query 参数**按关键词匹配概念页正文——某些分身 name 字段是通用高频词无法直接匹配实体（如想找 "ENS-L262" 但 name 列表里只有 "明确"/"数值" 等）。无 query 仅适合探索式浏览。',
        }, null, 2) }
      }

      // 有 query 模式：扫正文做关键词模糊匹配 + 评分
      const queryLower = query.toLowerCase()
      const scored: Array<{ name: string; entity: string; score: number; preview: string }> = []
      for (const p of pages) {
        try {
          const content = await wiki.readConceptPage(p.name)
          if (!content || !content.trim()) continue
          const contentLower = content.toLowerCase()
          // 简单评分：entity 名命中 +10，name 字段命中 +5，正文每次命中 +1（上限 20）
          let score = 0
          if (p.entity && p.entity.toLowerCase().includes(queryLower)) score += 10
          if (p.name.toLowerCase().includes(queryLower)) score += 5
          if (contentLower.includes(queryLower)) {
            const matches = contentLower.split(queryLower).length - 1
            score += Math.min(matches, 20)
          }
          if (score > 0) {
            // 预览：找第一段非标题非引用的实际内容（200 字符）
            const previewLine = content.split('\n').find(
              line => line.trim().length > 20 && !line.startsWith('#') && !line.startsWith('>') && !line.startsWith('---') && !line.startsWith('|'),
            )
            const preview = ((previewLine ?? '').trim()).slice(0, 200)
            scored.push({ name: p.name, entity: p.entity, score, preview })
          }
        } catch {/* 单页读取失败跳过 */}
      }
      scored.sort((a, b) => b.score - a.score)
      const top = scored.slice(0, topN)

      return { content: JSON.stringify({
        query,
        count: top.length,
        total_pages: pages.length,
        last_compiled: meta?.lastCompiled ?? null,
        matches: top,
        hint: top.length === 0
          ? `query="${query}" 在 ${pages.length} 个概念页里都没匹配。可能该实体未被编译进 wiki，建议改用 search_knowledge / knowledge_grep。`
          : `按相关度排序。拿 matches[i].name 后调 read_wiki_concept(name) 看完整聚合页。`,
      }, null, 2) }
    } catch (err) {
      return { content: '', error: `读取 wiki/concepts/ 失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /**
   * read_wiki_concept: 读取指定的实体概念页 markdown 全文。
   *
   * 入参 name 来自 list_wiki_concepts 返回的 matches[].name 或 pages[].name。
   *
   * 容错（2026-05-18 补丁）：WikiCompiler 编译质量问题导致概念页文件名（`__`）
   * 与 entity 字段（`**`）不一致，LLM 易混淆。本工具会先尝试 name 直读，失败时
   * 在概念页元数据里**按 entity 反查**，找到对应文件后透明取回，附 hint 告知 LLM 正确字段。
   */
  private async readWikiConcept(avatarId: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) return { content: '', error: '缺少 name 参数（从 list_wiki_concepts 返回的 matches[i].name 取）' }

    try {
      const wiki = new WikiCompiler(path.join(this.avatarsPath, avatarId))

      // 路径 1：name 通过 path-security + 文件直读
      let segmentSafe = false
      try {
        assertSafeSegment(name, '概念页名')
        segmentSafe = true
      } catch {/* fall through to fallback lookup */}

      if (segmentSafe) {
        try {
          const content = await wiki.readConceptPage(name)
          if (content && content.trim()) return { content }
        } catch {/* file not found, fall through */}
      }

      // 路径 2：name 直读失败 → 在 getConceptPages 元数据里反查 entity 字段
      // 适用于 LLM 把 entity 当 name 传的常见错误（WikiCompiler 实体提取污染导致）
      const pages = await wiki.getConceptPages()
      const fallback = pages.find(p => p.entity === name || p.name === name)
      if (fallback) {
        try {
          const content = await wiki.readConceptPage(fallback.name)
          if (content && content.trim()) {
            const hint = fallback.entity === name && fallback.name !== name
              ? `\n\n<!-- soul 提示：你传的 name="${name}" 是 entity 字段，正确 name 应是 "${fallback.name}"。下次请用 list_wiki_concepts 返回的 matches[i].name 字段。 -->`
              : ''
            return { content: content + hint }
          }
        } catch {/* still fail, fall through */}
      }

      return {
        content: '',
        error: `概念页不存在: ${name}。已尝试按 name 直读和按 entity 反查均失败。请先调 list_wiki_concepts(query="关键词")，从返回的 matches[i].name 字段取真正的 name 再传给本工具。`,
      }
    } catch (err) {
      return { content: '', error: `读取概念页失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /**
   * knowledge_glob: 按 glob 模式匹配知识库文件路径，返回相对路径列表。
   *
   * 用法：`knowledge_glob({pattern: "**\/*电价*.md"})` 列出所有名字含"电价"的 md 文件。
   * 比 list_knowledge_files 精准（不用扫所有再 LLM 过滤）。
   *
   * 复用模块级 globToRegExp（与 list_files 一致），支持 `*` `**` `?`。
   */
  private knowledgeGlob(avatarId: string, args: Record<string, unknown>): ToolCallResult {
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
    if (!pattern.trim()) return { content: '', error: '缺少 pattern 参数（glob 模式，如 "**/*电价*.md"）' }

    let regex: RegExp
    try {
      regex = globToRegExp(pattern)
    } catch (e) {
      return { content: '', error: `非法 glob 模式: ${e instanceof Error ? e.message : String(e)}` }
    }

    const roots = this.listKnowledgeRoots(avatarId)
    if (roots.length === 0) {
      return { content: JSON.stringify({ pattern, count: 0, files: [] }, null, 2) }
    }

    const files: string[] = []
    const MAX_FILES = 500
    let truncated = false
    outer:
    for (const root of roots) {
      const all = collectFilesRecursive(root.absRoot, '', DEFAULT_MAX_DIR_DEPTH)
      for (const f of all) {
        const rel = path.relative(root.absRoot, f).replace(/\\/g, '/')
        // 同时匹配 "完整相对路径" 和 "纯文件名"，让 `*.md` 这种 LLM 习惯写法也能命中
        if (regex.test(rel) || regex.test(path.basename(f))) {
          files.push(root.relPrefix + rel)
          if (files.length >= MAX_FILES) { truncated = true; break outer }
        }
      }
    }

    return { content: JSON.stringify({
      pattern,
      count: files.length,
      truncated,
      files,
      hint: truncated ? '已达硬上限 500，请缩窄 pattern' : undefined,
    }, null, 2) }
  }

  private listDesignSystems(args: Record<string, unknown>): ToolCallResult {
    const categoryRaw = args.category as string | undefined
    const category = categoryRaw?.trim()
    if (category) {
      try {
        assertSafeSegment(category, 'category')
      } catch (e) {
        return { content: '', error: e instanceof Error ? e.message : String(e) }
      }
    }
    const designRoot = path.join(this.designSystemsPath, 'design-md')
    const scanRoot = category
      ? resolveUnderRoot(designRoot, category)
      : designRoot
    const files = collectFilesRecursive(scanRoot, '.md', DEFAULT_MAX_DIR_DEPTH)
      .map((file) => {
        const relative = path.relative(designRoot, file).replace(/\\/g, '/')
        const firstSlash = relative.indexOf('/')
        const cat = firstSlash >= 0 ? relative.slice(0, firstSlash) : 'uncategorized'
        const base = path.basename(relative, '.md')
        return {
          category: cat,
          slug: base,
          path: relative,
        }
      })
      .sort((a, b) => a.path.localeCompare(b.path))

    return {
      content: JSON.stringify({
        root: 'shared/design-systems/design-md',
        count: files.length,
        items: files,
      }, null, 2),
    }
  }

  private readDesignSystem(args: Record<string, unknown>): ToolCallResult {
    const slug = args.slug as string
    if (!slug) return { content: '', error: '缺少 slug 参数' }
    try {
      assertSafeSegment(slug, 'slug')
    } catch (e) {
      return { content: '', error: e instanceof Error ? e.message : String(e) }
    }

    const categoryRaw = args.category as string | undefined
    const category = categoryRaw?.trim()
    if (category) {
      try {
        assertSafeSegment(category, 'category')
      } catch (e) {
        return { content: '', error: e instanceof Error ? e.message : String(e) }
      }
    }

    const designRoot = path.join(this.designSystemsPath, 'design-md')
    const targetPath = category
      ? resolveUnderRoot(designRoot, path.join(category, `${slug}.md`))
      : null
    if (targetPath) {
      if (!fs.existsSync(targetPath)) {
        return { content: '', error: `design system 不存在: ${category}/${slug}.md` }
      }
      const content = fs.readFileSync(targetPath, 'utf-8')
      const rel = path.relative(this.designSystemsPath, targetPath).replace(/\\/g, '/')
      return { content: `[来源: shared/design-systems/${rel}]\n${content}` }
    }

    const allMatches = collectFilesRecursive(designRoot, '.md', DEFAULT_MAX_DIR_DEPTH)
      .filter((f) => path.basename(f, '.md') === slug)
      .sort((a, b) => a.localeCompare(b))
    if (allMatches.length === 0) {
      return { content: '', error: `design system 不存在: ${slug}.md` }
    }
    if (allMatches.length > 1) {
      const candidates = allMatches
        .map((f) => path.relative(designRoot, f).replace(/\\/g, '/'))
        .join('\n')
      return {
        content: '',
        error: `slug "${slug}" 命中多个分类，请补充 category 参数。\n可选路径：\n${candidates}`,
      }
    }
    const only = allMatches[0]
    const content = fs.readFileSync(only, 'utf-8')
    const rel = path.relative(this.designSystemsPath, only).replace(/\\/g, '/')
    return { content: `[来源: shared/design-systems/${rel}]\n${content}` }
  }

  private searchDesignSystems(args: Record<string, unknown>): ToolCallResult {
    const query = args.query as string
    if (!query || !query.trim()) return { content: '', error: '缺少 query 参数' }
    const topNRaw = args.top_n
    const topN = typeof topNRaw === 'number' && Number.isFinite(topNRaw)
      ? Math.max(1, Math.min(20, Math.floor(topNRaw)))
      : 5
    const queryParts = query
      .toLowerCase()
      .split(/\s+/)
      .map(part => part.trim())
      .filter(part => part.length > 0)
    if (queryParts.length === 0) return { content: '', error: 'query 参数不能为空' }

    const designRoot = path.join(this.designSystemsPath, 'design-md')
    const allFiles = collectFilesRecursive(designRoot, '.md', DEFAULT_MAX_DIR_DEPTH)
    const hits: DesignSystemSearchHit[] = []

    for (const file of allFiles) {
      const relative = path.relative(designRoot, file).replace(/\\/g, '/')
      const firstSlash = relative.indexOf('/')
      const category = firstSlash >= 0 ? relative.slice(0, firstSlash) : 'uncategorized'
      const slug = path.basename(relative, '.md')
      const text = fs.readFileSync(file, 'utf-8')
      const lowerText = text.toLowerCase()
      const titleBoostText = `${slug} ${category}`.toLowerCase()
      let score = 0
      for (const token of queryParts) {
        const contentHit = lowerText.includes(token) ? 1 : 0
        const titleHit = titleBoostText.includes(token) ? 1 : 0
        score += contentHit + titleHit * 2
      }
      if (score <= 0) continue

      const firstMatchToken = queryParts.find(token => lowerText.includes(token)) ?? queryParts[0]
      const hitIndex = lowerText.indexOf(firstMatchToken)
      const snippetStart = Math.max(0, hitIndex - 80)
      const snippetEnd = Math.min(text.length, hitIndex + 220)
      const snippet = text.slice(snippetStart, snippetEnd).replace(/\s+/g, ' ').trim()

      hits.push({
        category,
        slug,
        path: relative,
        score,
        snippet,
      })
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.path.localeCompare(b.path)
    })

    const topHits = hits.slice(0, topN)
    if (topHits.length === 0) {
      return { content: '未找到匹配的 design system。' }
    }

    return {
      content: JSON.stringify({
        query,
        count: topHits.length,
        results: topHits.map(hit => ({
          category: hit.category,
          slug: hit.slug,
          path: hit.path,
          score: hit.score,
          snippet: hit.snippet,
        })),
      }, null, 2),
    }
  }

  // ─── Excel 结构化查询（v0.5.x 新增）─────────────────────────────────────────

  /**
   * query_excel: 按 MongoDB 风格 filter 精确过滤 Excel 行，返回 JSON。
   *
   * 严格保护：返回值不能太大，否则会污染 chat history 引发 context overflow。
   *   - 返回内容硬上限 QUERY_EXCEL_MAX_CONTENT_CHARS 字符
   *   - 默认 limit 50，硬上限 QUERY_EXCEL_HARD_LIMIT
   *   - 不传 filter 且不传 columns 时，要求加 limit 否则报错（防止 dump 全表）
   *   - 超出 content 上限时按行数截断，附 truncated_by_size 标志和提示
   *
   * 参数：
   *   file    — _excel/ 目录下的 basename（不含 .json）
   *   sheet   — sheet 名
   *   filter? — 列名 → 值（$eq 默认）或 {$gte/$lte/$gt/$lt/$ne/$in: ...}
   *   columns? — 只返回这些列
   *   limit?   — 最多返回行数，默认 50，硬上限 200
   */
  private queryExcel(avatarId: string, args: Record<string, unknown>): ToolCallResult {
    const file = args.file as string
    const sheetName = args.sheet as string
    if (!file) return { content: '', error: '缺少 file 参数（Excel basename）' }
    if (!sheetName) return { content: '', error: '缺少 sheet 参数' }

    try {
      assertSafeSegment(file, 'file')
    } catch (e) {
      return { content: '', error: e instanceof Error ? e.message : String(e) }
    }

    let parsed: CachedExcelSource['parsed']
    try {
      parsed = this.loadExcelSource(avatarId, file)
    } catch (e) {
      return { content: '', error: e instanceof Error ? e.message : String(e) }
    }

    const sheet = parsed.sheets?.find(s => s.name === sheetName)
    if (!sheet) {
      const available = (parsed.sheets ?? []).map(s => s.name).join(', ')
      return { content: '', error: `sheet 不存在: "${sheetName}"（可用: ${available}）` }
    }

    // F1 按需 schema 模式：返回完整列 schema（包含类型、唯一值数、范围、样例）
    //
    // 关键约束：每列的 samples 是「按列独立去重抽样」，跨列之间 NOT 按行对齐。
    // 历史 bug：LLM 看到 col1.samples[0]="256（华致）" 和 故障次数.samples[0]="9" 后
    // 误以为这是同一行的数据，把 9 当成 314（华致）的故障次数答案返回。schema 模式
    // 本意只是让 LLM 了解列结构，绝不能用 samples 直接作为行级查询答案。
    // soul-loader.ts 的 system prompt 已有"禁止从 schema sample 推数字"约束，
    // 但实战发现仅 system prompt 不足以阻止模型把 samples 当行对齐数据用。
    // 因此在工具响应自身再加双重保险：
    //   1. 顶层加显眼的 _usage 警示，要求必须再调一次带 filter 的 query_excel
    //   2. 每列 samples 同行附 _note，强化"非行对齐"语义
    // 注意：字段名保持 samples，与 system prompt 里的硬约束一致，不要改名。
    if (args.mode === 'schema') {
      const schemaPayload = {
        file,
        sheet: sheetName,
        source_anchor: formatSourceAnchor(buildExcelSourceAnchor(file, sheetName)),
        _usage: '本次返回仅为 schema（列结构）。每列的 samples 是该列独立去重抽样的代表值，跨列之间不构成行的对应关系，禁止作为行级查询答案。要获取某行某列的精确值，必须再发起一次 query_excel（不带 mode=schema），并传 filter（如 filter: {col1: "314（华致）"}）后从 rows[].该列名 取值。',
        sheet_row_count: sheet.rowCount,
        columns: sheet.columns.map(c => ({
          name: c.name,
          dtype: c.dtype,
          uniqueCount: c.uniqueCount,
          ...(c.min !== undefined && c.max !== undefined ? { min: c.min, max: c.max } : {}),
          samples: (c.samples ?? []).slice(0, 3),
          samples_note: '本列代表值（独立去重抽样），跨列不按行对齐，不可作为行级答案',
        })),
      }
      return { content: JSON.stringify(schemaPayload, null, 2) }
    }

    const filter = (args.filter as Record<string, unknown>) || {}
    const columns = args.columns as string[] | undefined
    const limitRaw = args.limit
    const limit = Math.min(
      QUERY_EXCEL_HARD_LIMIT,
      typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.floor(limitRaw)
        : QUERY_EXCEL_DEFAULT_LIMIT,
    )

    // 防 dump：没 filter 没 columns 时强制要求显式 limit，且 limit 必须很小。
    // 例外：表本身就只有 ≤ SMALL_TABLE_ROW_THRESHOLD 行时直接放行（污染量可忽略，
    // 让 LLM 不必为 9 行的小表再多绕一轮"加 limit" 重试）。
    const SMALL_TABLE_ROW_THRESHOLD = 50
    const hasFilter = Object.keys(filter).length > 0
    const hasColumns = Array.isArray(columns) && columns.length > 0
    const isSmallTable = sheet.rowCount <= SMALL_TABLE_ROW_THRESHOLD
    if (!hasFilter && !hasColumns && typeof limitRaw !== 'number' && !isSmallTable) {
      return {
        content: '',
        error: `查询过宽：没有 filter、没有 columns、也没有 limit，会一次性返回整张表 ${sheet.rowCount} 行污染 context。请至少指定 filter（推荐）、columns 或显式 limit≤50。`,
      }
    }

    // 执行过滤
    const matched: Array<{ rowNumber: number; row: Record<string, string | number | null> }> = []
    for (const [rowIndex, row] of sheet.rows.entries()) {
      if (matchFilter(row, filter)) {
        if (hasColumns) {
          const picked: Record<string, string | number | null> = {}
          for (const col of columns!) {
            if (col in row) picked[col] = row[col]
          }
          matched.push({ rowNumber: rowIndex + 2, row: picked })
        } else {
          matched.push({ rowNumber: rowIndex + 2, row })
        }
        if (matched.length >= limit) break
      }
    }

    const colNames = new Set(sheet.columns.map(c => c.name))
    const invalidFilterKeys = Object.keys(filter).filter(k => !colNames.has(k))
    let zeroMatchHint: string | undefined
    if (hasFilter && matched.length === 0) {
      const parts: string[] = []
      if (invalidFilterKeys.length > 0) {
        parts.push(
          `filter 中的列名在本 sheet「${sheetName}」不存在: ${invalidFilterKeys.join(', ')}。仅可使用本次返回的 schema 中的 name（注意空格，如「项目 类型」「装机 容量」）。`,
        )
        // 当大部分 filter key 都不在该 sheet 时，提示 LLM 很可能选错了 sheet
        const invalidRatio = invalidFilterKeys.length / Object.keys(filter).length
        if (invalidRatio >= 0.5) {
          const otherSheets = (parsed.sheets ?? [])
            .filter(s => s.name !== sheetName)
            .map(s => `「${s.name}」(${s.columns.map(c => c.name).join(', ')})`)
            .join('；\n')
          if (otherSheets) {
            parts.push(
              `⚠️ 你可能选错了 sheet。本文件其他可用 sheet 及其列名如下，请根据列名重新选择合适的 sheet 再查询：\n${otherSheets}`,
            )
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(filter, '统计周期') || invalidFilterKeys.length === 0) {
        parts.push(
          '若按「年/月」筛选：本表「统计周期」列多为 YYMM 整数（如 2601≈2026年1月）；勿用「2026-01」等与数字做 $gte/$lte 比较，否则常得到 0 行。可用 $in: [2601,2602,2603] 或先只筛「机型」再用 limit 试探。',
        )
      }
      parts.push('若放宽后仍无 2～3 月，可能是源 Excel 尚未录入对应月份行（非工具故障）。')
      zeroMatchHint = parts.join('\n')
    }

    const truncatedByLimit = matched.length >= limit

    // 二级保护：返回内容字符数上限。若 JSON serialize 后超过阈值，按行截断。
    let resultRows = matched
    let truncatedBySize = false
    let serialized = JSON.stringify(resultRows)
    while (serialized.length > QUERY_EXCEL_MAX_CONTENT_CHARS && resultRows.length > 1) {
      // 砍一半重试
      resultRows = resultRows.slice(0, Math.max(1, Math.floor(resultRows.length / 2)))
      truncatedBySize = true
      serialized = JSON.stringify(resultRows)
    }

    // 精简 schema 附在每次查询结果里：name + dtype，让 LLM 每次查询后都能看到列定义，
    // 避免早先的 tool 结果被 compressOldToolResults 压缩后"记忆模糊"又从头试探列名。
    // 不带 samples / uniqueCount / range（这些在 system prompt 的 Schema 摘要里有）。
    const schemaBrief = sheet.columns.map(c => ({ name: c.name, dtype: c.dtype }))
    const rowNumbers = resultRows.map((entry) => entry.rowNumber)
    const sourceAnchor = formatSourceAnchor(buildExcelSourceAnchor(
      file,
      sheetName,
      rowNumbers.length > 0 ? Math.min(...rowNumbers) : undefined,
      rowNumbers.length > 0 ? Math.max(...rowNumbers) : undefined,
    ))

    const payload = {
      file,
      sheet: sheetName,
      source_anchor: sourceAnchor,
      source_rows: rowNumbers,
      sheet_row_count: sheet.rowCount,
      schema: schemaBrief,
      count: resultRows.length,
      total_matched: matched.length,
      truncated: truncatedByLimit || truncatedBySize,
      truncated_by_limit: truncatedByLimit,
      truncated_by_size: truncatedBySize,
      hint: truncatedBySize
        ? `数据被按 content size (${QUERY_EXCEL_MAX_CONTENT_CHARS} chars) 截断，请加更精细的 filter 或减少 columns 重新查询`
        : truncatedByLimit
          ? `数据被按 limit=${limit} 截断，原匹配 ${matched.length} 行，请加 filter 缩小或翻页`
          : undefined,
      rows: resultRows.map((entry) => ({ _source_row: entry.rowNumber, ...entry.row })),
      ...(zeroMatchHint
        ? {
            zero_match_hint: zeroMatchHint,
            ...(invalidFilterKeys.length > 0 ? { invalid_filter_keys: invalidFilterKeys } : {}),
          }
        : {}),
    }

    return { content: JSON.stringify(payload, null, 2) }
  }

  /**
   * export_excel: 把 LLM 整理的结构化数据落盘为 .xlsx 文件，供用户下载。
   *
   * 设计动机：query_excel 是只读工具，对比 / 差异 / 报表类任务的输出无法直接落盘，
   * LLM 只能在主回答里贴 markdown 表格，用户没法二次复用。本工具与 query_excel
   * 配对：LLM 先用 query_excel 拉取所需行，再把整理后的 rows 通过本工具写成 xlsx。
   *
   * 安全模型（多层防御）：
   *   1. avatarId / conversationId 通过 assertSafeSegment 校验（getWorkspaceRoot 内部）
   *   2. filename 先 assertSafeSegment 拦截路径分隔符 / ..，再正则 sanitize 特殊字符
   *   3. 落盘路径强制限制在 <workspace>/exports/ 下（resolveUnderRoot）
   *   4. 行数上限 EXPORT_EXCEL_MAX_ROWS_PER_SHEET、sheet 数上限 EXPORT_EXCEL_MAX_SHEETS
   *   5. 写盘后立即 statSync 检查大小，超 EXPORT_EXCEL_MAX_FILE_SIZE_BYTES 删除并报错
   *   6. overwrite 默认 false，避免误覆盖之前导出的报告
   *
   * @param avatarId       分身 ID（已被 handleToolCall 上层校验）
   * @param conversationId 当前对话 ID（必填，决定落盘工作区）
   * @param args           入参：filename / sheets / overwrite
   *
   * @author zhi.qu
   * @date 2026-05-08
   */
  private exportExcel(
    avatarId: string,
    conversationId: string | undefined,
    args: Record<string, unknown>,
  ): ToolCallResult {
    const filenameRaw = args.filename
    const sheetsRaw = args.sheets
    const overwrite = args.overwrite === true

    if (typeof filenameRaw !== 'string' || !filenameRaw.trim()) {
      return { content: '', error: '缺少 filename 参数（不含 .xlsx 后缀）' }
    }
    if (!Array.isArray(sheetsRaw) || sheetsRaw.length === 0) {
      return { content: '', error: 'sheets 必须为非空数组' }
    }
    if (sheetsRaw.length > EXPORT_EXCEL_MAX_SHEETS) {
      return {
        content: '',
        error: `sheets 数量 ${sheetsRaw.length} 超过上限 ${EXPORT_EXCEL_MAX_SHEETS}，请拆分成多个文件`,
      }
    }

    const filename = filenameRaw.trim()
    try {
      assertSafeSegment(filename, 'filename')
    } catch (e) {
      return { content: '', error: e instanceof Error ? e.message : String(e) }
    }
    const safeFilename = filename.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
    if (!safeFilename) {
      return { content: '', error: 'filename sanitize 后为空，请使用中文/英文/数字/-/_ 组合' }
    }

    const seenSheetNames = new Set<string>()
    const validatedSheets: Array<{
      name: string
      rows: Array<Record<string, string | number | null>>
    }> = []
    let totalRows = 0
    for (let i = 0; i < sheetsRaw.length; i++) {
      const entry = sheetsRaw[i]
      if (!entry || typeof entry !== 'object') {
        return { content: '', error: `sheets[${i}] 不是对象` }
      }
      const sheetObj = entry as Record<string, unknown>
      const sheetName = sheetObj.name
      const sheetRows = sheetObj.rows
      if (typeof sheetName !== 'string' || !sheetName.trim()) {
        return { content: '', error: `sheets[${i}].name 必须为非空字符串` }
      }
      const trimmedName = sheetName.trim()
      if (trimmedName.length > 31) {
        return {
          content: '',
          error: `sheets[${i}].name "${trimmedName}" 超过 Excel 31 字符上限`,
        }
      }
      if (seenSheetNames.has(trimmedName)) {
        return { content: '', error: `sheets[${i}].name 重复: "${trimmedName}"` }
      }
      seenSheetNames.add(trimmedName)
      if (!Array.isArray(sheetRows)) {
        return { content: '', error: `sheets[${i}].rows 必须为数组` }
      }
      if (sheetRows.length > EXPORT_EXCEL_MAX_ROWS_PER_SHEET) {
        return {
          content: '',
          error: `sheets[${i}] "${trimmedName}" 行数 ${sheetRows.length} 超过上限 ${EXPORT_EXCEL_MAX_ROWS_PER_SHEET}`,
        }
      }
      const safeRows: Array<Record<string, string | number | null>> = []
      for (let r = 0; r < sheetRows.length; r++) {
        const row = sheetRows[r]
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          return { content: '', error: `sheets[${i}].rows[${r}] 必须为对象` }
        }
        safeRows.push(row as Record<string, string | number | null>)
      }
      validatedSheets.push({ name: trimmedName, rows: safeRows })
      totalRows += safeRows.length
    }

    let workspaceRoot: string
    try {
      workspaceRoot = this.getWorkspaceRoot(avatarId, conversationId)
    } catch (e) {
      return { content: '', error: e instanceof Error ? e.message : String(e) }
    }

    const exportsDir = resolveUnderRoot(workspaceRoot, 'exports')
    fs.mkdirSync(exportsDir, { recursive: true })

    const targetFilename = `${safeFilename}.xlsx`
    const absolutePath = resolveUnderRoot(exportsDir, targetFilename)
    const relativePath = path.posix.join('exports', targetFilename)

    if (fs.existsSync(absolutePath) && !overwrite) {
      return {
        content: '',
        error: `目标文件已存在: ${relativePath}（如需覆盖请传 overwrite: true）`,
      }
    }

    try {
      const workbook = XLSX.utils.book_new()
      for (const sheet of validatedSheets) {
        // json_to_sheet 在 rows 为空时会抛错，因此空 sheet 走 aoa_to_sheet 兜底
        const worksheet = sheet.rows.length > 0
          ? XLSX.utils.json_to_sheet(sheet.rows)
          : XLSX.utils.aoa_to_sheet([[]])
        XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name)
      }
      XLSX.writeFile(workbook, absolutePath)
    } catch (e) {
      // 写盘失败时清理半成品，避免下次 overwrite=false 误判
      try { if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath) } catch { /* ignore cleanup error */ }
      return {
        content: '',
        error: `写入 Excel 失败: ${e instanceof Error ? e.message : String(e)}`,
      }
    }

    let fileSizeBytes: number
    try {
      fileSizeBytes = fs.statSync(absolutePath).size
    } catch (e) {
      return {
        content: '',
        error: `落盘后无法读取文件大小: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
    if (fileSizeBytes > EXPORT_EXCEL_MAX_FILE_SIZE_BYTES) {
      try { fs.unlinkSync(absolutePath) } catch { /* ignore cleanup error */ }
      return {
        content: '',
        error: `导出文件 ${fileSizeBytes} 字节超过上限 ${EXPORT_EXCEL_MAX_FILE_SIZE_BYTES}（10 MB），已删除。请减少 rows / 拆分多文件`,
      }
    }

    const payload = {
      success: true,
      format: 'xlsx' as const,
      file_path: relativePath,
      absolute_path: absolutePath,
      sheet_count: validatedSheets.length,
      total_rows: totalRows,
      file_size_bytes: fileSizeBytes,
      _usage: '文件已落盘到当前对话工作区，桌面端会自动以文件卡片展示。在主回答末尾用一句话告知用户：「已生成 <filename>，可在下方文件卡片点击打开」。',
    }
    return { content: JSON.stringify(payload, null, 2) }
  }

  /**
   * generate_document: 生成 Markdown / PDF / Word 文档文件落盘到当前对话工作区。
   *
   * 设计动机：与 export_excel 并列的"内容落盘"工具，但目标是半结构化文档而非
   * 表格数据。LLM 通过 IR（markdown + frontmatter + 自定义扩展）一次性表达
   * 内容，由本函数分发到 3 种渲染器，避免"切换格式重新调 LLM"。
   *
   * 决策 A1（依赖注入）：md 用 packages/core 内部纯字符串渲染器；pdf/docx 走
   * Electron 主进程，通过构造函数注入的 documentRenderers 钩子调用，保持
   * packages/core 环境无关。
   *
   * @author zhi.qu
   * @date 2026-05-08
   */
  private async generateDocument(
    avatarId: string,
    conversationId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const formatRaw = args.format
    const irRaw = args.ir
    const filenameRaw = args.filename
    const templateNameRaw = args.templateName
    const overwrite = args.overwrite === true

    if (typeof formatRaw !== 'string' || !SUPPORTED_DOCUMENT_FORMATS.includes(formatRaw as DocumentFormat)) {
      return {
        content: '',
        error: `format 必须为 ${SUPPORTED_DOCUMENT_FORMATS.join('|')} 之一，收到 ${JSON.stringify(formatRaw)}`,
      }
    }
    const format = formatRaw as DocumentFormat

    if (typeof irRaw !== 'string' || irRaw.trim().length === 0) {
      return { content: '', error: 'ir 必须为非空字符串（markdown + frontmatter）' }
    }
    if (irRaw.length > MAX_IR_LENGTH) {
      return {
        content: '',
        error: `ir 长度 ${irRaw.length} 超过上限 ${MAX_IR_LENGTH}，请拆分多次调用或精简内容`,
      }
    }

    if (typeof filenameRaw !== 'string' || !filenameRaw.trim()) {
      return { content: '', error: '缺少 filename 参数（不含扩展名）' }
    }
    const filename = filenameRaw.trim()
    try {
      assertSafeSegment(filename, 'filename')
    } catch (e) {
      return { content: '', error: e instanceof Error ? e.message : String(e) }
    }
    const safeFilename = filename.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
    if (!safeFilename) {
      return { content: '', error: 'filename sanitize 后为空，请使用中文/英文/数字/-/_ 组合' }
    }

    let templateName = 'default'
    if (templateNameRaw !== undefined && templateNameRaw !== null) {
      if (typeof templateNameRaw !== 'string' || !templateNameRaw.trim()) {
        return { content: '', error: 'templateName 必须为字符串' }
      }
      try {
        assertSafeSegment(templateNameRaw.trim(), '文档模板名')
      } catch (e) {
        return { content: '', error: e instanceof Error ? e.message : String(e) }
      }
      templateName = templateNameRaw.trim()
    }

    let workspaceRoot: string
    try {
      workspaceRoot = this.getWorkspaceRoot(avatarId, conversationId)
    } catch (e) {
      return { content: '', error: e instanceof Error ? e.message : String(e) }
    }

    const exportsDir = resolveUnderRoot(workspaceRoot, 'exports')
    fs.mkdirSync(exportsDir, { recursive: true })

    const targetFilename = `${safeFilename}.${format}`
    const absolutePath = resolveUnderRoot(exportsDir, targetFilename)
    const relativePath = path.posix.join('exports', targetFilename)

    if (fs.existsSync(absolutePath) && !overwrite) {
      return {
        content: '',
        error: `目标文件已存在: ${relativePath}（如需覆盖请传 overwrite: true）`,
      }
    }

    if ((format === 'pdf' || format === 'docx') && !this.documentRenderers) {
      return {
        content: '',
        error: `format=${format} 需要主进程渲染器，但 documentRenderers 未注入；当前仅支持 md 格式。`,
      }
    }

    // 解析 IR：宽进严出。先尽可能拿到结构化 blocks，再按 validateIR 决定接受/拒绝。
    const { parseIR } = await import('./document/ir-parser')
    const { validateIR } = await import('./document/ir-schema')
    const parsed = parseIR(irRaw)
    const validation = validateIR(parsed.ir)
    if (!validation.valid || !validation.ir) {
      const detail = validation.errors
        .slice(0, 5)
        .map(e => `[block ${e.blockIndex}] ${e.message}`)
        .join('; ')
      return {
        content: '',
        error: `IR 校验失败：${detail}${validation.errors.length > 5 ? `（另有 ${validation.errors.length - 5} 条错误）` : ''}`,
      }
    }
    const ir = validation.ir

    // 渲染分发
    // avatarRoot 同时充当 PDF 模板加载根 + DOCX 图片相对路径解析根
    // （IR 中 image.src 形如 `knowledge/foo.png`，按分身根解析最自然）
    const avatarRoot = path.join(this.avatarsPath, avatarId)
    let writtenSize: number
    try {
      if (format === 'md') {
        const { renderMarkdown } = await import('./document/renderers/markdown-renderer')
        const md = renderMarkdown(ir)
        fs.writeFileSync(absolutePath, md, 'utf-8')
        writtenSize = fs.statSync(absolutePath).size
      } else if (format === 'pdf') {
        const { renderHtml } = await import('./document/renderers/html-renderer')
        const html = renderHtml(ir, { avatarRoot, templateName })
        const result = await this.documentRenderers!.renderPdf(html, absolutePath)
        writtenSize = result.size
      } else {
        // docx：注入 imageRoot 让渲染器在分身根目录下安全解析相对图片路径
        const result = await this.documentRenderers!.renderDocx(ir, absolutePath, { imageRoot: avatarRoot })
        writtenSize = result.size
      }
    } catch (e) {
      try { if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath) } catch { /* ignore */ }
      return {
        content: '',
        error: `${format} 渲染失败: ${e instanceof Error ? e.message : String(e)}`,
      }
    }

    if (writtenSize > MAX_DOCUMENT_FILE_SIZE_BYTES) {
      try { fs.unlinkSync(absolutePath) } catch { /* ignore */ }
      return {
        content: '',
        error: `输出文件 ${writtenSize} 字节超过上限 ${MAX_DOCUMENT_FILE_SIZE_BYTES}（20 MB），已删除。请精简内容或拆分多文件`,
      }
    }

    // 收集 cite 块的引用来源（FileCard 可以折叠展示）
    const sources = ir.blocks
      .filter(b => b.type === 'cite')
      .map(b => {
        const c = b as { source: string; page?: number }
        return c.page !== undefined ? { source: c.source, page: c.page } : { source: c.source }
      })

    const payload = {
      success: true,
      format,
      file_path: relativePath,
      absolute_path: absolutePath,
      file_size_bytes: writtenSize,
      block_count: ir.blocks.length,
      template_name: templateName,
      sources: sources.length > 0 ? sources : undefined,
      parser_warnings: parsed.warnings.length > 0 ? parsed.warnings.slice(0, 5) : undefined,
      _usage: '文件已落盘到当前对话工作区，桌面端会自动以文件卡片展示。在主回答末尾用一句话告知用户：「已生成 <filename>，可在下方文件卡片点击打开」。',
    }
    return { content: JSON.stringify(payload, null, 2) }
  }

  // ─── 通用执行类工具 ─────────────────────────────────────────────────────────

  /**
   * exec_shell: 在工作区目录内执行 shell 命令（支持前台同步 + 后台异步两种模式）。
   *
   * 安全模型（多层防御）：
   *   1. cwd 强制锁定到 workspace 根目录的子目录（resolveWorkspacePath 已校验目录穿越）
   *   2. 命令首词必须命中白名单 EXEC_SHELL_WHITELIST
   *   3. 完整命令字符串必须不命中黑名单 EXEC_SHELL_BLACKLIST（sudo/rm 根/curl|sh 等）
   *   4. 前台硬超时 EXEC_SHELL_HARD_TIMEOUT_MS（5 分钟）；后台无单次超时但靠 kill_shell 终止
   *   5. stdout/stderr 各自硬截断（前台 8KB / 后台 64KB）
   *
   * 模式：
   *   - background:false（默认）：前台同步，等待进程结束后返回完整结果
   *   - background:true：异步，立即返回 task_id，进程在后台跑，用 await_shell / kill_shell 操作
   *
   * @author zhi.qu
   * @date 2026-04-29
   */
  private async execShell(
    avatarId: string,
    conversationId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const command = (typeof args.command === 'string' ? args.command : '').trim()
    if (!command) return { content: '', error: '缺少 command 参数（完整命令行字符串）' }
    if (command.length > 4000) {
      return { content: '', error: 'command 过长（>4000 字符），请拆分或使用脚本文件' }
    }

    // 解析子目录 cwd（必须在 workspace 内）
    const subCwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '.'
    let cwd: string
    try {
      cwd = this.resolveWorkspacePath(avatarId, conversationId, subCwd)
    } catch (e) {
      return { content: '', error: `cwd 校验失败: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { content: '', error: `cwd 不存在或不是目录: ${subCwd}` }
    }

    // 第 2 层：白名单（取首词，按 shell 分隔符切）
    const firstToken = command.split(/[\s|;&<>]+/).filter(Boolean)[0] ?? ''
    if (!EXEC_SHELL_WHITELIST.has(firstToken)) {
      return {
        content: '',
        error: `命令未在白名单中: "${firstToken}"。允许的命令前缀: ${[...EXEC_SHELL_WHITELIST].sort().join(', ')}。如需联网请改用 web_fetch / web_search 工具。`,
      }
    }

    // 第 3 层：黑名单（完整命令字符串校验）
    for (const pattern of EXEC_SHELL_BLACKLIST) {
      if (pattern.test(command)) {
        return {
          content: '',
          error: `命令命中危险模式（${pattern.source}），已拒绝执行。常见原因：sudo / rm 根目录 / 远程脚本管道执行 / 写设备文件等。请改写后重试。`,
        }
      }
    }

    // ─── 后台模式：立即返回 task_id ─────────────────────────────────────────────
    if (args.background === true) {
      return this.startBackgroundShell(command, subCwd, cwd)
    }

    // ─── 前台模式：等进程结束 ───────────────────────────────────────────────────
    const timeoutMs = Math.min(
      EXEC_SHELL_HARD_TIMEOUT_MS,
      typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms) && args.timeout_ms > 0
        ? Math.floor(args.timeout_ms)
        : EXEC_SHELL_HARD_TIMEOUT_MS,
    )

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process') as typeof import('child_process')
    const startedAt = Date.now()

    return new Promise<ToolCallResult>((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: {
          ...process.env,
          // 防 LLM 误用启动新 Electron 子实例 / 触发交互式登录 shell
          ELECTRON_RUN_AS_NODE: '1',
          NO_COLOR: '1',
          PAGER: 'cat',
        },
      })

      let stdout = ''
      let stderr = ''
      let truncated = false
      let killedByTimeout = false

      const timer = setTimeout(() => {
        killedByTimeout = true
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 1000)
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length >= EXEC_SHELL_OUTPUT_MAX) { truncated = true; return }
        stdout += chunk.toString('utf-8')
        if (stdout.length > EXEC_SHELL_OUTPUT_MAX) {
          stdout = stdout.slice(0, EXEC_SHELL_OUTPUT_MAX)
          truncated = true
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length >= EXEC_SHELL_OUTPUT_MAX) { truncated = true; return }
        stderr += chunk.toString('utf-8')
        if (stderr.length > EXEC_SHELL_OUTPUT_MAX) {
          stderr = stderr.slice(0, EXEC_SHELL_OUTPUT_MAX)
          truncated = true
        }
      })

      child.on('error', (err: Error) => {
        clearTimeout(timer)
        resolve({
          content: '',
          error: `子进程启动失败: ${err.message}`,
        })
      })

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer)
        const duration = Date.now() - startedAt
        const payload = {
          command,
          cwd: subCwd,
          exit_code: code,
          signal,
          duration_ms: duration,
          killed_by_timeout: killedByTimeout,
          truncated,
          stdout: stdout || '(空)',
          stderr: stderr || '(空)',
          ...(truncated ? { truncate_hint: `输出超过 ${EXEC_SHELL_OUTPUT_MAX} 字节已截断；如需完整输出请把命令结果重定向到工作区文件，再用 read_file 分页读取。` } : {}),
          ...(killedByTimeout ? { timeout_hint: `执行超过 ${timeoutMs}ms，已强制终止；请优化命令或调小 timeout_ms 后重试。` } : {}),
        }
        resolve({ content: JSON.stringify(payload, null, 2) })
      })
    })
  }

  /**
   * 启动一个后台 shell 进程，立即返回 task_id；进程在后台持续运行，
   * stdout/stderr 累积到 BackgroundShellRecord 中，可由 await_shell / kill_shell 操作。
   *
   * 调用前已通过 execShell 的全部安全检查（白名单 / 黑名单 / cwd 校验），此处不再重复。
   */
  private startBackgroundShell(command: string, subCwd: string, cwd: string): ToolCallResult {
    this.evictBackgroundShells()
    if (this.backgroundShells.size >= BG_SHELL_MAX_ENTRIES) {
      return {
        content: '',
        error: `后台 shell 注册表已满（${BG_SHELL_MAX_ENTRIES} 条）。请先用 kill_shell 终止不需要的任务，或等待已结束的旧任务被自动清理。`,
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process') as typeof import('child_process')
    const taskId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

    let child: import('child_process').ChildProcess
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          NO_COLOR: '1',
          PAGER: 'cat',
        },
      })
    } catch (err) {
      return {
        content: '',
        error: `后台子进程启动失败: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    const record: BackgroundShellRecord = {
      taskId,
      command,
      cwd: subCwd,
      pid: child.pid,
      startedAt: Date.now(),
      child,
      stdout: '',
      stderr: '',
      truncated: false,
      exitCode: null,
      signal: null,
      status: 'running',
      pendingWaiters: [],
    }
    this.backgroundShells.set(taskId, record)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (record.stdout.length >= BG_SHELL_OUTPUT_MAX) { record.truncated = true; return }
      record.stdout += chunk.toString('utf-8')
      if (record.stdout.length > BG_SHELL_OUTPUT_MAX) {
        record.stdout = record.stdout.slice(0, BG_SHELL_OUTPUT_MAX)
        record.truncated = true
      }
      // 唤醒 await_shell 中等待 pattern 的 waiters
      this.flushBackgroundShellWaiters(record)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (record.stderr.length >= BG_SHELL_OUTPUT_MAX) { record.truncated = true; return }
      record.stderr += chunk.toString('utf-8')
      if (record.stderr.length > BG_SHELL_OUTPUT_MAX) {
        record.stderr = record.stderr.slice(0, BG_SHELL_OUTPUT_MAX)
        record.truncated = true
      }
      this.flushBackgroundShellWaiters(record)
    })

    child.on('error', (err: Error) => {
      record.status = 'killed'
      record.endedAt = Date.now()
      record.stderr += `\n[spawn error] ${err.message}\n`
      record.child = null
      this.flushBackgroundShellWaiters(record)
    })

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      record.exitCode = code
      record.signal = signal
      record.status = signal ? 'killed' : 'exited'
      record.endedAt = Date.now()
      record.child = null
      this.flushBackgroundShellWaiters(record)
    })

    return {
      content: JSON.stringify({
        task_id: taskId,
        pid: child.pid,
        command,
        cwd: subCwd,
        started_at: record.startedAt,
        hint: '进程已在后台启动。用 await_shell({task_id}) 等待结束或读取输出，用 kill_shell({task_id}) 终止。',
      }, null, 2),
    }
  }

  /** 清理已结束且超过保留时长的后台 shell 记录，控制注册表大小 */
  private evictBackgroundShells(): void {
    const now = Date.now()
    const expired: string[] = []
    for (const [id, rec] of this.backgroundShells.entries()) {
      if (rec.status !== 'running' && rec.endedAt && now - rec.endedAt > BG_SHELL_RETAIN_MS) {
        expired.push(id)
      }
    }
    for (const id of expired) this.backgroundShells.delete(id)

    // 仍然超出上限：按结束时间最早的优先 evict（只动已结束的，正在跑的不动）
    if (this.backgroundShells.size >= BG_SHELL_MAX_ENTRIES) {
      const ended = [...this.backgroundShells.values()]
        .filter(r => r.status !== 'running' && r.endedAt)
        .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      const toRemove = ended.slice(0, Math.max(0, this.backgroundShells.size - BG_SHELL_MAX_ENTRIES + 1))
      for (const r of toRemove) this.backgroundShells.delete(r.taskId)
    }
  }

  /** 唤醒指定记录的所有 pending waiters（进程结束 / 输出更新时触发） */
  private flushBackgroundShellWaiters(rec: BackgroundShellRecord): void {
    const waiters = rec.pendingWaiters
    rec.pendingWaiters = []
    for (const w of waiters) {
      try { w() } catch { /* ignore */ }
    }
  }

  /**
   * await_shell: 阻塞等待后台 shell 任务的进展，返回当前快照。
   *
   * 三种结束条件（任意命中即返回）：
   *   1. 进程已结束
   *   2. stdout / stderr 命中正则 pattern
   *   3. 阻塞时长达到 block_until_ms
   *
   * 参数：
   *   task_id: string         — startBackgroundShell 返回的 task_id（必填）
   *   pattern?: string        — 正则字符串，匹配 stdout/stderr 即唤醒
   *   block_until_ms?: number — 最长阻塞时长（默认 30s，上限 5min）
   */
  private async awaitShell(args: Record<string, unknown>): Promise<ToolCallResult> {
    const taskId = typeof args.task_id === 'string' ? args.task_id : ''
    if (!taskId) return { content: '', error: '缺少 task_id 参数' }
    const rec = this.backgroundShells.get(taskId)
    if (!rec) return { content: '', error: `task_id 不存在或已被清理: ${taskId}` }

    const blockMs = Math.min(
      AWAIT_SHELL_MAX_BLOCK_MS,
      typeof args.block_until_ms === 'number' && Number.isFinite(args.block_until_ms) && args.block_until_ms > 0
        ? Math.floor(args.block_until_ms)
        : AWAIT_SHELL_DEFAULT_BLOCK_MS,
    )

    let regex: RegExp | null = null
    if (typeof args.pattern === 'string' && args.pattern.length > 0) {
      try {
        regex = new RegExp(args.pattern, 'm')
      } catch (e) {
        return { content: '', error: `pattern 正则非法: ${e instanceof Error ? e.message : String(e)}` }
      }
    }

    const matchesPattern = (): boolean => {
      if (!regex) return false
      return regex.test(rec.stdout) || regex.test(rec.stderr)
    }

    // 已结束 / 已匹配 → 立即返回
    if (rec.status !== 'running' || matchesPattern()) {
      return { content: this.snapshotBackgroundShell(rec, regex !== null) }
    }

    // 注册一个 waiter，配套超时定时器
    await new Promise<void>((resolve) => {
      let resolved = false
      const wakeup = (): void => {
        if (resolved) return
        // 仅在进程结束 / pattern 命中时真正 resolve；否则继续等
        if (rec.status !== 'running' || matchesPattern()) {
          resolved = true
          clearTimeout(timer)
          resolve()
        } else {
          // 还没达到结束条件，重新挂回去等下一次输出
          rec.pendingWaiters.push(wakeup)
        }
      }
      const timer = setTimeout(() => {
        if (resolved) return
        resolved = true
        // 超时也 resolve，由调用端拿快照
        resolve()
      }, blockMs)
      rec.pendingWaiters.push(wakeup)
    })

    return { content: this.snapshotBackgroundShell(rec, regex !== null) }
  }

  /** 序列化后台 shell 当前状态为 LLM 可读 JSON */
  private snapshotBackgroundShell(rec: BackgroundShellRecord, hasPattern: boolean): string {
    const now = Date.now()
    return JSON.stringify({
      task_id: rec.taskId,
      command: rec.command,
      cwd: rec.cwd,
      pid: rec.pid,
      status: rec.status,
      exit_code: rec.exitCode,
      signal: rec.signal,
      started_at: rec.startedAt,
      ended_at: rec.endedAt ?? null,
      duration_ms: (rec.endedAt ?? now) - rec.startedAt,
      truncated: rec.truncated,
      stdout: rec.stdout || '(空)',
      stderr: rec.stderr || '(空)',
      ...(rec.status === 'running' && hasPattern ? { hint: '进程仍在运行；await_shell 因超时返回当前快照，可再次 await_shell 继续等待。' } : {}),
      ...(rec.status === 'running' && !hasPattern ? { hint: '进程仍在运行；可传 pattern 等待特定输出，或直接再次 await_shell 等待结束。' } : {}),
    }, null, 2)
  }

  /**
   * kill_shell: 终止指定的后台 shell 任务（SIGTERM，1 秒后 SIGKILL）。
   *
   * 参数：
   *   task_id: string  — 必填
   */
  private killShell(args: Record<string, unknown>): ToolCallResult {
    const taskId = typeof args.task_id === 'string' ? args.task_id : ''
    if (!taskId) return { content: '', error: '缺少 task_id 参数' }
    const rec = this.backgroundShells.get(taskId)
    if (!rec) return { content: '', error: `task_id 不存在或已被清理: ${taskId}` }

    if (rec.status !== 'running' || !rec.child) {
      return {
        content: JSON.stringify({
          task_id: taskId,
          status: rec.status,
          message: '任务已结束，无需终止。',
          exit_code: rec.exitCode,
        }, null, 2),
      }
    }

    const child = rec.child
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 1000)

    return {
      content: JSON.stringify({
        task_id: taskId,
        message: '已发送 SIGTERM；1 秒后若未退出会强制 SIGKILL。可再次调用 await_shell 拿最终输出。',
      }, null, 2),
    }
  }

  /**
   * web_search: 调用 Tavily 搜索 API 获取网页摘要。
   *
   * 为 LLM 提供联网能力。Tavily 已对结果做了语义重排和摘要提取，
   * 返回的 content 直接可读，不需要再解析 HTML。
   *
   * 凭据：tavily_api_key 由用户在「设置 → 工具集成」中配置。
   *       未配置时返回友好错误，提示用户去填。
   *
   * 参数：
   *   query: string                 — 搜索关键词（必填）
   *   max_results?: number          — 返回结果数（默认 5，上限 10）
   *   search_depth?: 'basic'|'advanced' — basic 快/便宜；advanced 深/慢/贵
   *   include_answer?: boolean      — 是否让 Tavily 用 LLM 综合一段答案（默认 true）
   *   topic?: 'general'|'news'      — 搜索领域（默认 general；news 仅取最近资讯）
   *
   * @author zhi.qu
   * @date 2026-04-29
   */
  /**
   * read_tool_ref: 取回 lazy-store 落盘的工具结果正文（分页）。
   *
   * 用于 lazy_store 化的长输出（v1：web_fetch ≥ 4000 字符触发）。
   * LLM 看到 `body_lazy_ref` 标记后调此工具取正文。
   *
   * 红线：
   *   - call_id 必须通过 isValidCallId 格式校验（防路径穿越）
   *   - 单次返回硬上限 READ_TOOL_REF_HARD_LIMIT (8000 字符)，分页用 offset
   *   - 文件不存在时返回明确错误 + 引导 LLM 重新调原工具
   */
  private readToolRefTool(
    avatarId: string,
    conversationId: string | undefined,
    args: Record<string, unknown>,
  ): ToolCallResult {
    if (!conversationId) {
      return { content: '', error: 'read_tool_ref 需要 conversationId（当前调用上下文缺失，无法定位会话工作区）' }
    }
    const callId = typeof args.call_id === 'string' ? args.call_id.trim() : ''
    if (!callId) {
      return { content: '', error: '缺少 call_id 参数（形如 "tool-a8f2c4e9b1c2"）' }
    }
    if (!isValidCallId(callId)) {
      return { content: '', error: `非法 call_id 格式: ${callId}（必须为 tool-{12hex}）` }
    }
    const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.floor(args.offset) : 0
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : undefined
    try {
      const workspaceRoot = this.getWorkspaceRoot(avatarId, conversationId)
      const out = readToolRef(workspaceRoot, callId, offset, limit)
      return {
        content: JSON.stringify({
          call_id: callId,
          total_chars: out.total_chars,
          offset: out.offset,
          limit: out.limit,
          truncated: out.truncated,
          content: out.content,
          ...(out.truncated ? {
            hint: `已截断；下一段调用 read_tool_ref(call_id="${callId}", offset=${out.offset + out.limit}, limit=${out.limit})`,
          } : {}),
        }, null, 2),
      }
    } catch (err) {
      return { content: '', error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async webSearch(args: Record<string, unknown>): Promise<ToolCallResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) return { content: '', error: '缺少 query 参数（搜索关键词）' }
    if (query.length > 400) {
      return { content: '', error: 'query 过长（>400 字符），请精简关键词' }
    }

    if (!this.getSetting) {
      return { content: '', error: 'web_search 未注入设置读取器（这是部署配置问题，请联系开发）' }
    }
    // 防御性闸门：联网总开关未开启则直接拒绝（即使 system prompt / tools 数组上层过滤被绕过也兜底）
    if (this.getSetting('web_search_enabled') !== 'true') {
      return {
        content: '',
        error: '联网功能未启用。请到「设置 → 工具集成」打开"启用联网功能"开关；未开启时分身只基于知识库回答。',
      }
    }
    const apiKey = (this.getSetting('tavily_api_key') ?? '').trim()
    if (!apiKey) {
      return {
        content: '',
        error: '未配置 Tavily API Key。请前往「设置 → 工具集成 → Tavily Search」粘贴 API Key（免费额度 1000 次/月，注册 https://tavily.com 即可获取）。',
      }
    }

    const maxResults = Math.min(
      WEB_SEARCH_HARD_MAX,
      typeof args.max_results === 'number' && Number.isFinite(args.max_results) && args.max_results > 0
        ? Math.floor(args.max_results)
        : WEB_SEARCH_DEFAULT_MAX,
    )
    const searchDepth = args.search_depth === 'advanced' ? 'advanced' : 'basic'
    const includeAnswer = args.include_answer !== false  // 默认 true
    const topic = args.topic === 'news' ? 'news' : 'general'

    try {
      const response = await fetchWithTimeout(TAVILY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: maxResults,
          search_depth: searchDepth,
          include_answer: includeAnswer,
          topic,
        }),
        timeoutMs: WEB_SEARCH_TIMEOUT_MS,
      })

      const data = await response.json() as {
        query?: string
        answer?: string
        results?: Array<{ title: string; url: string; content: string; score: number; published_date?: string }>
      }

      const results = (data.results ?? []).slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.url,
        // 截断单条 content 防止 context 爆
        content: r.content.length > WEB_SEARCH_CONTENT_MAX_CHARS
          ? r.content.slice(0, WEB_SEARCH_CONTENT_MAX_CHARS) + '...[已截断]'
          : r.content,
        score: Math.round(r.score * 1000) / 1000,
        ...(r.published_date ? { published_date: r.published_date } : {}),
      }))

      const payload = {
        query: data.query ?? query,
        ...(includeAnswer && data.answer ? { answer: data.answer } : {}),
        result_count: results.length,
        results,
        hint: results.length === 0
          ? '搜索无结果。建议改用更宽泛或更具体的关键词，或切换 topic 到 "news"。'
          : '已返回精选结果（按相关性排序）。如需深入某条，可用 web_fetch 抓完整页面。',
      }

      return { content: JSON.stringify(payload, null, 2) }
    } catch (err) {
      // HttpError 包含 status，区分 401（key 失效）/ 429（限流）/ 5xx（服务端）
      if (err instanceof HttpError) {
        if (err.status === 401 || err.status === 403) {
          return { content: '', error: 'Tavily API Key 无效或已过期，请到「设置 → 工具集成」重新填入有效 Key。' }
        }
        if (err.status === 429) {
          return { content: '', error: 'Tavily 调用超出免费额度（1000 次/月）；请等下个月或升级付费计划。' }
        }
        return { content: '', error: `Tavily API 错误 (${err.status}): ${err.message}` }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { content: '', error: `web_search 请求失败: ${msg}` }
    }
  }

  /**
   * web_fetch: 抓取单个 URL 的内容，自动转 Markdown / 文本 / JSON。
   *
   * 与 web_search 互补：先用 web_search 得到候选 URL，再用 web_fetch 抓全文。
   *
   * 安全控制：
   *   - 仅允许 http / https
   *   - 屏蔽 localhost / 内网 IP（防 SSRF 攻击）
   *   - 30 秒强制超时
   *   - 30KB 默认输出截断（可调高，硬上限 100KB）
   *
   * 参数：
   *   url: string                                — 必填，绝对 URL
   *   format?: 'markdown' | 'text' | 'json' | 'raw' — 默认 'markdown'
   *     - markdown: HTML 转 Markdown（保留链接/标题/列表/代码块），最适合 LLM
   *     - text: 纯文本（剥所有标签和实体）
   *     - json: 解析 JSON 响应（非 JSON 报错）
   *     - raw: 原始响应字符串（不处理）
   *   max_chars?: number                         — 输出上限（默认 30000，硬上限 100000）
   *
   * @author zhi.qu
   * @date 2026-04-29
   */
  private async webFetch(args: Record<string, unknown>): Promise<ToolCallResult> {
    // 防御性闸门：联网总开关未开启则直接拒绝（与 webSearch 同款兜底）
    if (this.getSetting && this.getSetting('web_search_enabled') !== 'true') {
      return {
        content: '',
        error: '联网功能未启用。请到「设置 → 工具集成」打开"启用联网功能"开关；未开启时分身只基于知识库回答。',
      }
    }
    const rawUrl = typeof args.url === 'string' ? args.url.trim() : ''
    if (!rawUrl) return { content: '', error: '缺少 url 参数' }

    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return { content: '', error: `无效的 URL: ${rawUrl}` }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { content: '', error: `仅支持 http/https 协议，拒绝 ${parsed.protocol}` }
    }
    if (PRIVATE_IP_PATTERNS.some((re) => re.test(parsed.hostname))) {
      return {
        content: '',
        error: `拒绝抓取内网/回环地址 ${parsed.hostname}（防 SSRF）。如确需抓取本地服务，请用 read_file。`,
      }
    }

    const format = (args.format === 'text' || args.format === 'json' || args.format === 'raw')
      ? args.format
      : 'markdown'
    const maxChars = Math.min(
      WEB_FETCH_HARD_MAX_CHARS,
      typeof args.max_chars === 'number' && Number.isFinite(args.max_chars) && args.max_chars > 0
        ? Math.floor(args.max_chars)
        : WEB_FETCH_DEFAULT_MAX_CHARS,
    )

    try {
      const response = await fetchWithTimeout(parsed.href, {
        method: 'GET',
        // 假装是浏览器，避免被部分站点的 UA 黑名单拦截
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SoulBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
        },
        timeoutMs: WEB_FETCH_TIMEOUT_MS,
      })

      const contentType = response.headers.get('content-type') ?? ''
      const rawText = await response.text()

      // 按 format 处理
      let body: string
      let truncated = false
      if (format === 'json') {
        try {
          const json = JSON.parse(rawText)
          body = JSON.stringify(json, null, 2)
        } catch (e) {
          return {
            content: '',
            error: `format=json 但响应不是合法 JSON：${e instanceof Error ? e.message : String(e)}（content-type: ${contentType}）`,
          }
        }
      } else if (format === 'raw') {
        body = rawText
      } else if (format === 'text') {
        body = htmlToPlainText(rawText)
      } else {
        body = htmlToMarkdown(rawText)
      }

      if (body.length > maxChars) {
        body = body.slice(0, maxChars)
        truncated = true
      }

      const payload = {
        url: parsed.href,
        status: response.status,
        content_type: contentType,
        format,
        char_count: body.length,
        truncated,
        ...(truncated ? { hint: `内容已截断到 ${maxChars} 字符。如需更多，调用时设 max_chars=较大值（≤${WEB_FETCH_HARD_MAX_CHARS}）。` } : {}),
        body,
      }
      return { content: JSON.stringify(payload, null, 2) }
    } catch (err) {
      if (err instanceof HttpError) {
        return { content: '', error: `web_fetch 失败 (${err.type}${err.status ? ` ${err.status}` : ''}): ${err.message}` }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { content: '', error: `web_fetch 异常: ${msg}` }
    }
  }

  /**
   * list_mcp_tools: 列出当前所有已连接 MCP server 的工具。
   *
   * 设计意图：不一次性把全部 MCP 工具塞进 system prompt（会浪费 token），
   *           而是让 LLM 主动按需查询，再根据描述决定调用哪个。
   *
   * @param args.server_name 可选，只列指定 server 的工具
   */
  private listMcpTools(args: Record<string, unknown>): ToolCallResult {
    if (!this.mcpManager) {
      return {
        content: '',
        error: 'MCP 未启用（主进程未注入 mcpManager）。请到「设置 → 工具集成 → MCP」配置后重启。',
      }
    }
    const filterServer = typeof args.server_name === 'string' ? args.server_name : undefined
    const allTools = this.mcpManager.listTools()
    const filtered = filterServer
      ? allTools.filter((t) => t.serverName === filterServer)
      : allTools

    if (filtered.length === 0) {
      const servers = this.mcpManager.listServers()
      const hint = servers.length === 0
        ? '没有任何已配置的 MCP server。'
        : `已配置 server: ${servers.map((s) => `${s.name}(${s.status})`).join(', ')}。${filterServer ? `'${filterServer}' 没有可用工具。` : ''}`
      return { content: JSON.stringify({ tool_count: 0, tools: [], hint }, null, 2) }
    }

    return {
      content: JSON.stringify({
        tool_count: filtered.length,
        tools: filtered.map((t) => ({
          name: t.qualifiedName,
          server: t.serverName,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        hint: '调用时使用 call_mcp_tool({ name: "<上面的 name>", arguments: { ... } })。',
      }, null, 2),
    }
  }

  /**
   * call_mcp_tool: 调用某个 MCP server 暴露的工具。
   *
   * @param args.name      工具全名（mcp__<server>__<tool>）
   * @param args.arguments 工具入参（按 input_schema 校验）
   * @param args.timeout_ms 可选，单次超时（默认 60s，硬上限 300s）
   */
  private async callMcpTool(args: Record<string, unknown>): Promise<ToolCallResult> {
    if (!this.mcpManager) {
      return {
        content: '',
        error: 'MCP 未启用（主进程未注入 mcpManager）。请到「设置 → 工具集成 → MCP」配置后重启。',
      }
    }
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) return { content: '', error: '缺少 name 参数（MCP 工具全名）' }

    const toolArgs = (args.arguments && typeof args.arguments === 'object')
      ? args.arguments as Record<string, unknown>
      : {}

    const timeoutRaw = typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms) && args.timeout_ms > 0
      ? Math.floor(args.timeout_ms)
      : undefined
    const timeoutMs = timeoutRaw ? Math.min(timeoutRaw, 300_000) : undefined

    const result = await this.mcpManager.callTool(name, toolArgs, timeoutMs ? { timeoutMs } : undefined)
    if (result.error) return { content: result.content, error: result.error }
    return { content: result.content }
  }

  /**
   * ask_question: 向用户弹出多选卡片（轻量级 questions_v2 包装）。
   *
   * 实现策略：
   *   - tool-router 仅做参数校验、生成结构化 payload
   *   - 真正的 IPC 推送（chat:ask-question）由主进程在 execute-tool-call 上层做
   *     （main.ts 已在 questions_v2 处实现类似逻辑）
   *   - LLM 看到的返回字符串是「请等待用户在卡片上点选」的提示，下一轮 user
   *     消息会带 [ask_question answer] 前缀
   *
   * @author zhi.qu
   * @date 2026-04-30
   */
  private askQuestion(args: Record<string, unknown>): ToolCallResult {
    const question = typeof args.question === 'string' ? args.question.trim() : ''
    if (!question) return { content: '', error: '缺少 question 参数（问题文本）' }
    if (question.length > 300) {
      return { content: '', error: 'question 过长（>300 字符），请精简' }
    }
    const rawOptions = Array.isArray(args.options) ? args.options : []
    const options: string[] = rawOptions
      .filter((o): o is string => typeof o === 'string')
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
      .slice(0, 5)
    if (options.length < 2) {
      return { content: '', error: 'options 至少 2 项有效字符串（建议 2-5 项）' }
    }
    const allowCustom = args.allow_custom === true
    const payload = {
      type: 'ask_question',
      question,
      options,
      allow_custom: allowCustom,
      hint: '已弹出多选卡片，正在等待用户点选。下一轮你会收到 user 消息形如 "[ask_question answer] <用户选择>"。',
    }
    return { content: JSON.stringify(payload, null, 2) }
  }

  /**
   * generate_image: 调用 DashScope 通义万相 wanx2.1-t2i-turbo 生成图片，落盘到 workspace。
   *
   * DashScope 异步 API 流程：
   *   1. POST /api/v1/services/aigc/text2image/image-synthesis（async）→ 拿 task_id
   *   2. GET /api/v1/tasks/{task_id} 轮询 task_status（PENDING/RUNNING/SUCCEEDED/FAILED）
   *   3. SUCCEEDED → 拿 results[0].url（公网 PNG）
   *   4. fetch 图片 → 保存到 workspace/generated/img-<ts>.png
   *
   * 凭据：image_api_key（getSetting 注入），缺失时返回友好错误。
   * 限制：单次 1 张；总超时 90 秒；图片下载 30 秒。
   *
   * @author zhi.qu
   * @date 2026-04-30
   */
  private async generateImage(
    avatarId: string,
    conversationId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!prompt) return { content: '', error: '缺少 prompt 参数（图片描述）' }
    if (prompt.length > 800) {
      return { content: '', error: `prompt 过长（${prompt.length} > 800 字符），请精简` }
    }
    const negativePrompt = typeof args.negative_prompt === 'string' ? args.negative_prompt.trim() : ''
    const sizeRaw = typeof args.size === 'string' ? args.size.trim() : ''
    const size = (sizeRaw === '720*1280' || sizeRaw === '1280*720') ? sizeRaw : '1024*1024'

    if (!this.getSetting) {
      return { content: '', error: 'generate_image 未注入设置读取器（部署配置问题）' }
    }
    const apiKey = (this.getSetting('image_api_key') ?? '').trim()
    if (!apiKey) {
      return {
        content: '',
        error: '未配置 DashScope API Key。请前往「设置 → 工具集成 → 图片生成」配置（注册 https://dashscope.console.aliyun.com 即可获取）。',
      }
    }

    let workspaceRoot: string
    try {
      workspaceRoot = this.getWorkspaceRoot(avatarId, conversationId)
    } catch (e) {
      return { content: '', error: `无法定位 workspace: ${e instanceof Error ? e.message : String(e)}` }
    }

    // 1. 创建异步任务
    let taskId: string
    try {
      const createResp = await fetchWithTimeout(IMAGE_GEN_CREATE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
        },
        body: JSON.stringify({
          model: 'wanx2.1-t2i-turbo',
          input: {
            prompt,
            ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
          },
          parameters: {
            size,
            n: 1,
          },
        }),
        timeoutMs: IMAGE_GEN_CREATE_TIMEOUT_MS,
      })
      const createJson = await createResp.json() as { output?: { task_id?: string }; message?: string }
      if (!createJson.output?.task_id) {
        return { content: '', error: `DashScope 任务创建失败: ${createJson.message ?? JSON.stringify(createJson).slice(0, 200)}` }
      }
      taskId = createJson.output.task_id
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 401 || err.status === 403) {
          return { content: '', error: 'DashScope API Key 无效或已过期，请重新配置' }
        }
        return { content: '', error: `generate_image 创建任务失败 (${err.status ?? err.type}): ${err.message}` }
      }
      return { content: '', error: `generate_image 异常: ${err instanceof Error ? err.message : String(err)}` }
    }

    // 2. 轮询直到完成
    const pollDeadline = Date.now() + IMAGE_GEN_POLL_TIMEOUT_MS
    let imageUrl: string | undefined
    let lastStatus = 'UNKNOWN'
    while (Date.now() < pollDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, IMAGE_GEN_POLL_INTERVAL_MS))
      try {
        const taskResp = await fetchWithTimeout(`${IMAGE_GEN_TASK_URL}/${encodeURIComponent(taskId)}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          timeoutMs: IMAGE_GEN_POLL_TIMEOUT_PER_REQ_MS,
        })
        const taskJson = await taskResp.json() as {
          output?: {
            task_status?: string
            results?: Array<{ url?: string }>
            message?: string
          }
        }
        lastStatus = taskJson.output?.task_status ?? 'UNKNOWN'
        if (lastStatus === 'SUCCEEDED') {
          imageUrl = taskJson.output?.results?.[0]?.url
          if (!imageUrl) {
            return { content: '', error: 'DashScope 任务成功但未返回图片 URL（可能内容审核被驳回）' }
          }
          break
        }
        if (lastStatus === 'FAILED' || lastStatus === 'UNKNOWN_ERROR') {
          return { content: '', error: `DashScope 任务失败 (${lastStatus}): ${taskJson.output?.message ?? '无详情'}` }
        }
        // PENDING / RUNNING → 继续轮询
      } catch (err) {
        // 单次轮询失败容忍，继续重试
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          return { content: '', error: 'DashScope API Key 在轮询时被拒（可能权限变更），请重新配置' }
        }
        // 其他错误继续轮询，等待 deadline
      }
    }
    if (!imageUrl) {
      return { content: '', error: `generate_image 轮询超时（${IMAGE_GEN_POLL_TIMEOUT_MS}ms），最后状态: ${lastStatus}。请稍后重试或简化 prompt。` }
    }

    // 3. 下载图片 + 落盘
    const savePathRaw = typeof args.save_path === 'string' && args.save_path.trim()
      ? args.save_path.trim()
      : `generated/img-${Date.now()}.png`
    let absSavePath: string
    try {
      absSavePath = this.resolveWorkspacePath(avatarId, conversationId, savePathRaw)
    } catch (e) {
      return { content: '', error: `save_path 校验失败: ${e instanceof Error ? e.message : String(e)}` }
    }
    try {
      const imgResp = await fetchWithTimeout(imageUrl, {
        method: 'GET',
        timeoutMs: IMAGE_GEN_DOWNLOAD_TIMEOUT_MS,
      })
      const buf = Buffer.from(await imgResp.arrayBuffer())
      fs.mkdirSync(path.dirname(absSavePath), { recursive: true })
      fs.writeFileSync(absSavePath, buf)
    } catch (err) {
      return { content: '', error: `图片下载/落盘失败: ${err instanceof Error ? err.message : String(err)}` }
    }
    const relPath = path.relative(workspaceRoot, absSavePath).replace(/\\/g, '/')

    return {
      content: JSON.stringify({
        path: relPath,
        size,
        prompt,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        hint: `图片已生成并保存到 ${relPath}。可用 show_to_user(${JSON.stringify(relPath)}) 在预览窗口展示，或直接在回答中引用。`,
      }, null, 2),
    }
  }

  /**
   * switch_mode: 切换分身工作模式（agent / plan / ask）。
   *
   * 模式状态由前端 chatStore.mode 维护；本工具只做参数校验 + 返回结构化通知，
   * 实际状态变更由前端在收到 tool_result 后做（main.ts 也会广播 chat:mode-changed
   * 让其他组件刷新）。
   *
   * @author zhi.qu
   * @date 2026-04-30
   */
  private switchMode(args: Record<string, unknown>): ToolCallResult {
    const mode = typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : ''
    if (mode !== 'agent' && mode !== 'plan' && mode !== 'ask') {
      return { content: '', error: 'mode 必须是 agent / plan / ask 之一' }
    }
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    const payload = {
      type: 'switch_mode',
      mode,
      ...(reason ? { reason } : {}),
      hint: `已切换到 ${mode} 模式。下一轮 LLM 调用的工具列表会按模式过滤（plan 禁写、ask 禁所有工具）。`,
    }
    return { content: JSON.stringify(payload, null, 2) }
  }

  /**
   * exec_code: 在工作区目录内执行 Python / Node / TSX 代码片段。
   *
   * 与 exec_shell 互补：覆盖 LLM 现场写脚本场景（数据处理、批量改写、报表分析、
   * 调用 pandas/openpyxl/pypdf 等三方库）。这是"造粗工具"难以穷举的能力补充。
   *
   * 工作流：
   *   1. 校验 language 在白名单 EXEC_CODE_INTERPRETERS
   *   2. code 字符数校验（≤ EXEC_CODE_SCRIPT_MAX_CHARS）
   *   3. 写入 workspace/.code-exec/{taskId}.{ext}（保留供 read_file 复盘）
   *   4. spawn(interpreter, [scriptPath]) without shell:true（避免命令注入）
   *   5. 收集 stdout/stderr 各 16KB / 前台超时 5 分钟
   *   6. 后台模式复用 backgroundShells 注册表，task_id 兼容 await_shell / kill_shell
   *
   * 安全说明：
   *   - cwd 锁定 workspace；脚本仍可调用 OS API（subprocess / open /etc 等），
   *     这点与 shell 一致 —— 桌面端单用户场景信任 LLM；如需强隔离，未来可切 Docker / Firecracker
   *   - 网络请求请走 web_fetch 工具，不要在脚本内 requests/fetch 远程资源
   *
   * 参数：
   *   language: 'python' | 'python3' | 'node' | 'tsx'
   *   code: string                       — 完整脚本内容（≤ 16000 字符）
   *   cwd?: string                       — 相对工作区根的子目录（默认 "."）
   *   timeout_ms?: number                — 前台超时（不超过 300000）
   *   background?: boolean               — 后台运行；返回 task_id
   *
   * @author zhi.qu
   * @date 2026-04-29
   */
  private async execCode(
    avatarId: string,
    conversationId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const language = typeof args.language === 'string' ? args.language : ''
    const code = typeof args.code === 'string' ? args.code : ''

    if (!language) {
      return { content: '', error: `缺少 language 参数。可选: ${Object.keys(EXEC_CODE_INTERPRETERS).join(', ')}` }
    }
    const interp = EXEC_CODE_INTERPRETERS[language]
    if (!interp) {
      return {
        content: '',
        error: `不支持的 language: "${language}"。可选: ${Object.keys(EXEC_CODE_INTERPRETERS).join(', ')}`,
      }
    }
    if (!code.trim()) return { content: '', error: '缺少 code 参数（脚本内容不能为空）' }
    if (code.length > EXEC_CODE_SCRIPT_MAX_CHARS) {
      return { content: '', error: `code 过长（${code.length} > ${EXEC_CODE_SCRIPT_MAX_CHARS} 字符）。请拆分成多个脚本，或写到 .py/.js 文件后用 exec_shell 运行。` }
    }

    // 解析 cwd（必须在 workspace 内）
    const subCwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '.'
    let cwd: string
    try {
      cwd = this.resolveWorkspacePath(avatarId, conversationId, subCwd)
    } catch (e) {
      return { content: '', error: `cwd 校验失败: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { content: '', error: `cwd 不存在或不是目录: ${subCwd}` }
    }

    // 写脚本文件到 workspace/.code-exec/{taskId}.{ext}
    const taskId = `code-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const codeDir = path.join(this.getWorkspaceRoot(avatarId, conversationId), '.code-exec')
    fs.mkdirSync(codeDir, { recursive: true })
    const scriptPath = path.join(codeDir, `${taskId}${interp.ext}`)
    try {
      fs.writeFileSync(scriptPath, code, 'utf-8')
    } catch (e) {
      return { content: '', error: `写入临时脚本失败: ${e instanceof Error ? e.message : String(e)}` }
    }
    const scriptRelPath = path.join('.code-exec', path.basename(scriptPath)).replace(/\\/g, '/')

    // ─── 后台模式 ───────────────────────────────────────────────────────────
    if (args.background === true) {
      return this.startBackgroundCode(taskId, interp, scriptPath, scriptRelPath, cwd, subCwd, language)
    }

    // ─── 前台模式 ───────────────────────────────────────────────────────────
    const timeoutMs = Math.min(
      EXEC_CODE_HARD_TIMEOUT_MS,
      typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms) && args.timeout_ms > 0
        ? Math.floor(args.timeout_ms)
        : EXEC_CODE_HARD_TIMEOUT_MS,
    )

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process') as typeof import('child_process')
    const startedAt = Date.now()

    return new Promise<ToolCallResult>((resolve) => {
      // 关键：不用 shell:true，参数数组化，避免命令注入
      const child = spawn(interp.command, [...interp.preArgs, scriptPath], {
        cwd,
        shell: false,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          NO_COLOR: '1',
          PYTHONUNBUFFERED: '1', // 确保 Python print 实时输出
          PAGER: 'cat',
        },
      })

      let stdout = ''
      let stderr = ''
      let truncated = false
      let killedByTimeout = false

      const timer = setTimeout(() => {
        killedByTimeout = true
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 1000)
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length >= EXEC_CODE_OUTPUT_MAX) { truncated = true; return }
        stdout += chunk.toString('utf-8')
        if (stdout.length > EXEC_CODE_OUTPUT_MAX) {
          stdout = stdout.slice(0, EXEC_CODE_OUTPUT_MAX)
          truncated = true
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length >= EXEC_CODE_OUTPUT_MAX) { truncated = true; return }
        stderr += chunk.toString('utf-8')
        if (stderr.length > EXEC_CODE_OUTPUT_MAX) {
          stderr = stderr.slice(0, EXEC_CODE_OUTPUT_MAX)
          truncated = true
        }
      })

      child.on('error', (err: Error) => {
        clearTimeout(timer)
        // 常见：命令找不到（PATH 里无 python/node/tsx）
        const hint = err.message.includes('ENOENT')
          ? `\n[提示] 未找到解释器 "${interp.command}"。请检查系统是否已安装并加入 PATH；macOS 可用 brew install python3/node/tsx。`
          : ''
        resolve({
          content: '',
          error: `子进程启动失败: ${err.message}${hint}`,
        })
      })

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer)
        const duration = Date.now() - startedAt
        const payload = {
          task_id: taskId,
          language,
          script_path: scriptRelPath,
          cwd: subCwd,
          exit_code: code,
          signal,
          duration_ms: duration,
          killed_by_timeout: killedByTimeout,
          truncated,
          stdout: stdout || '(空)',
          stderr: stderr || '(空)',
          ...(truncated ? { truncate_hint: `输出超过 ${EXEC_CODE_OUTPUT_MAX} 字节已截断；请在脚本中减少 print，或把结果写到文件再用 read_file 分页读取。` } : {}),
          ...(killedByTimeout ? { timeout_hint: `执行超过 ${timeoutMs}ms，已强制终止。可优化算法、改 background:true 后台跑、或拆分子任务。` } : {}),
          ...(code !== 0 ? { reuse_hint: `脚本已保留在 ${scriptRelPath}，可用 read_file 查看后用 str_replace_edit 修复，再 exec_shell({command:"${interp.command} ${scriptRelPath}"}) 重跑。` } : {}),
        }
        resolve({ content: JSON.stringify(payload, null, 2) })
      })
    })
  }

  /**
   * 后台模式启动代码进程。复用 backgroundShells 注册表，task_id 可直接被 await_shell / kill_shell 操作。
   */
  private startBackgroundCode(
    taskId: string,
    interp: InterpreterConfig,
    scriptPath: string,
    scriptRelPath: string,
    cwd: string,
    subCwd: string,
    language: string,
  ): ToolCallResult {
    this.evictBackgroundShells()
    if (this.backgroundShells.size >= BG_SHELL_MAX_ENTRIES) {
      return {
        content: '',
        error: `后台任务注册表已满（${BG_SHELL_MAX_ENTRIES} 条）。请先用 kill_shell 终止不需要的任务。`,
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process') as typeof import('child_process')
    let child: import('child_process').ChildProcess
    try {
      child = spawn(interp.command, [...interp.preArgs, scriptPath], {
        cwd,
        shell: false,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          NO_COLOR: '1',
          PYTHONUNBUFFERED: '1',
          PAGER: 'cat',
        },
      })
    } catch (err) {
      return {
        content: '',
        error: `后台子进程启动失败: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    const record: BackgroundShellRecord = {
      taskId,
      command: `${interp.command} ${scriptRelPath}`,
      cwd: subCwd,
      pid: child.pid,
      startedAt: Date.now(),
      child,
      stdout: '',
      stderr: '',
      truncated: false,
      exitCode: null,
      signal: null,
      status: 'running',
      pendingWaiters: [],
    }
    this.backgroundShells.set(taskId, record)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (record.stdout.length >= BG_SHELL_OUTPUT_MAX) { record.truncated = true; return }
      record.stdout += chunk.toString('utf-8')
      if (record.stdout.length > BG_SHELL_OUTPUT_MAX) {
        record.stdout = record.stdout.slice(0, BG_SHELL_OUTPUT_MAX)
        record.truncated = true
      }
      this.flushBackgroundShellWaiters(record)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (record.stderr.length >= BG_SHELL_OUTPUT_MAX) { record.truncated = true; return }
      record.stderr += chunk.toString('utf-8')
      if (record.stderr.length > BG_SHELL_OUTPUT_MAX) {
        record.stderr = record.stderr.slice(0, BG_SHELL_OUTPUT_MAX)
        record.truncated = true
      }
      this.flushBackgroundShellWaiters(record)
    })

    child.on('error', (err: Error) => {
      record.status = 'killed'
      record.endedAt = Date.now()
      record.stderr += `\n[spawn error] ${err.message}\n`
      record.child = null
      this.flushBackgroundShellWaiters(record)
    })

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      record.exitCode = code
      record.signal = signal
      record.status = signal ? 'killed' : 'exited'
      record.endedAt = Date.now()
      record.child = null
      this.flushBackgroundShellWaiters(record)
    })

    return {
      content: JSON.stringify({
        task_id: taskId,
        pid: child.pid,
        language,
        script_path: scriptRelPath,
        cwd: subCwd,
        started_at: record.startedAt,
        hint: '代码已在后台启动。用 await_shell({task_id}) 等待结束，用 kill_shell({task_id}) 终止。',
      }, null, 2),
    }
  }

  // ─── 计算工具（GAP4 计算引擎）────────────────────────────────────────────────

  /**
   * 工商储收益测算（GAP4 计算引擎核心）
   * 计算峰谷套利、需量管理收益
   */
  private calculateRoi(args: Record<string, unknown>): ToolCallResult {
    const toNum = (v: unknown, fallback: number): number => {
      const n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }

    const capacity_kwh = toNum(args.capacity_kwh, 0)
    const power_kw = toNum(args.power_kw, 0)
    const peak_price = toNum(args.peak_price, 1.2)
    const valley_price = toNum(args.valley_price, 0.4)
    const daily_cycles = toNum(args.daily_cycles, 1)
    const dod = toNum(args.dod, 0.9)
    const efficiency = toNum(args.efficiency, 0.9)
    const annual_degradation = toNum(args.annual_degradation, 0.03)
    const project_life_years = Math.min(toNum(args.project_life_years, 10), 50)
    const investment_per_kwh = toNum(args.investment_per_kwh, 1800)
    const demand_charge_saving = toNum(args.demand_charge_saving, 0)
    const annual_opex = toNum(args.annual_opex, 0)

    if (capacity_kwh <= 0) {
      return { content: '', error: '储能容量 capacity_kwh 必须大于 0' }
    }
    if (power_kw <= 0) {
      return { content: '', error: '充放电功率 power_kw 必须大于 0' }
    }
    const investmentTotal = capacity_kwh * investment_per_kwh
    const results: string[] = []
    results.push(`## 储能收益测算报告`)
    results.push(`\n### 基础参数`)
    results.push(`- 储能容量: ${capacity_kwh} kWh`)
    results.push(`- 充放功率: ${power_kw} kW`)
    results.push(`- 峰谷电价差: ${peak_price - valley_price} 元/kWh`)
    results.push(`- 放电深度: ${dod * 100}%，系统效率: ${efficiency * 100}%`)
    results.push(`- 总投资: ${investmentTotal.toFixed(0)} 元`)

    results.push(`\n### 逐年收益预测`)
    let totalRevenue = 0
    let paybackYear: number | null = null
    let cumulativeCashflow = -investmentTotal

    for (let year = 1; year <= project_life_years; year++) {
      const degradedCapacity = capacity_kwh * Math.pow(1 - annual_degradation, year - 1)
      const dailyEnergy = degradedCapacity * dod * efficiency
      const dailyArbitrage = dailyEnergy * (peak_price - valley_price) * daily_cycles
      const annualArbitrage = dailyArbitrage * 330
      const annualRevenue = annualArbitrage + demand_charge_saving
      const netRevenue = annualRevenue - annual_opex
      totalRevenue += netRevenue
      cumulativeCashflow += netRevenue

      if (paybackYear === null && cumulativeCashflow >= 0) paybackYear = year

      results.push(`- 第 ${year} 年: 年收益 ${annualRevenue.toFixed(0)} 元，净收益 ${netRevenue.toFixed(0)} 元，累计现金流 ${cumulativeCashflow.toFixed(0)} 元`)
    }

    const roi = (totalRevenue / investmentTotal) * 100
    const irr = estimateIRR(investmentTotal, project_life_years,
      capacity_kwh, peak_price, valley_price,
      dod, efficiency, daily_cycles, demand_charge_saving, annual_opex, annual_degradation)

    results.push(`\n### 汇总`)
    results.push(`- 总投资: **${investmentTotal.toFixed(0)} 元**`)
    results.push(`- ${project_life_years} 年累计净收益: **${totalRevenue.toFixed(0)} 元**`)
    results.push(`- 静态回收期: **${paybackYear !== null ? paybackYear + ' 年' : '超过项目寿命'}**`)
    results.push(`- 整体投资回报率: **${roi.toFixed(1)}%**`)
    results.push(`- 估算 IRR: **${(irr * 100).toFixed(1)}%**`)

    return { content: results.join('\n') }
  }

  /**
   * Feature 5: 按需加载技能完整内容（渐进式披露）。
   * system prompt 中只注入技能摘要，AI 在需要执行技能时调用此工具获取完整定义。
   */
  private loadSkill(avatarId: string, args: Record<string, unknown>): ToolCallResult {
    const skillId = args.skill_id as string
    if (!skillId) return { content: '', error: '缺少 skill_id 参数' }
    try {
      assertSafeSegment(skillId, 'skill_id')
    } catch (e) {
      return { content: '', error: e instanceof Error ? e.message : String(e) }
    }
    const skillPath = path.join(this.avatarsPath, avatarId, 'skills', `${skillId}.md`)
    try {
      const content = fs.readFileSync(skillPath, 'utf-8')
      return { content: `## 技能：${skillId}\n\n${content}` }
    } catch {
      return { content: '', error: `技能不存在: ${skillId}` }
    }
  }

  /**
   * Feature 7: 委派子任务给独立子代理。
   * 若提供 callLLM，子代理会立即执行；否则返回任务 ID 供后续轮询。
   */
  private async delegateTask(
    avatarId: string,
    args: Record<string, unknown>,
    callLLM?: (sys: string, user: string, maxTokens?: number) => Promise<string>,
    conversationId?: string,
  ): Promise<ToolCallResult> {
    const task = args.task as string
    if (!task) return { content: '', error: '缺少 task 参数' }

    if (!callLLM) {
      return { content: `[子任务已记录] 任务描述：${task}\n\n由于当前无 LLM 调用权限，请在主对话中直接完成此任务。` }
    }

    /**
     * 解析委派目标。
     *
     * - 未传 target_avatar  → 完全沿用旧行为：用当前分身的 systemPromptCache
     * - 传了但等于 avatarId → 等同未传（避免误把"自己"当跨分身处理）
     * - 传了且与当前不同   → 按 SoulLoader 回调加载目标分身的 systemPrompt
     *   - 加载失败 / 回调未注入 → 返回错误并列出可用分身
     */
    const rawTarget = typeof args.target_avatar === 'string' ? args.target_avatar.trim() : ''
    const targetAvatar = rawTarget && rawTarget !== avatarId ? rawTarget : ''

    let systemPrompt: string
    if (targetAvatar) {
      try {
        assertSafeSegment(targetAvatar, 'target_avatar')
      } catch (e) {
        return { content: '', error: e instanceof Error ? e.message : String(e) }
      }
      // 优先用 systemPromptCache（用户曾经切到过该分身，已被注入）
      const cached = this.systemPromptCache.get(targetAvatar)
      if (cached) {
        systemPrompt = cached
      } else if (this.loadAvatarSystemPrompt) {
        // 现场加载：通常调外部注入的 SoulLoader.loadAvatar(...).systemPrompt
        let loaded: string | undefined
        try {
          loaded = this.loadAvatarSystemPrompt(targetAvatar)
        } catch (e) {
          loaded = undefined
          console.warn(`[tool-router] loadAvatarSystemPrompt 抛错: ${e instanceof Error ? e.message : String(e)}`)
        }
        if (!loaded) {
          const available = this.listAvailableAvatars?.() ?? []
          const hint = available.length > 0 ? `\n可用分身：${available.join(', ')}` : ''
          return {
            content: '',
            error: `target_avatar "${targetAvatar}" 不存在或无法加载 systemPrompt。${hint}`,
          }
        }
        systemPrompt = loaded
        // 加载成功后写回缓存，避免下次重复加载
        this.systemPromptCache.set(targetAvatar, loaded)
      } else {
        return {
          content: '',
          error: `委派到 "${targetAvatar}" 失败：未注入 loadAvatarSystemPrompt 回调，无法跨分身委派。`,
        }
      }
    } else {
      systemPrompt = this.systemPromptCache.get(avatarId) || `你是一个专业 AI 助手，请独立完成分配的任务。`
    }

    /**
     * 构造派发上下文 + sink 闭包。
     *
     * 仅在同时具备 sink + conversationId 时才落库——纯核心单测/无 conversation 上下文
     * 场景下 sink 直接 no-op，不报错也不写垃圾数据。
     */
    const onChange = this.subAgentTaskSink && conversationId
      ? (t: SubAgentTask) => {
          this.subAgentTaskSink!(t, {
            conversationId,
            parentAvatarId: avatarId,
            targetAvatar: targetAvatar || null,
          })
        }
      : undefined

    const agentTask = await this.subAgentManager.delegate(task, systemPrompt, callLLM, onChange)

    // 基于事件通知等待完成，无轮询
    const TIMEOUT_MS = 30000
    const t = await this.subAgentManager.waitForTask(agentTask.id, TIMEOUT_MS)
    if (!t) {
      return { content: '', error: '子任务丢失（可能已被清理），请重试。' }
    }
    if (t.status === 'done') {
      return { content: t.result ?? '子任务完成，无结果输出。' }
    }
    if (t.status === 'error') {
      return { content: '', error: `子任务失败: ${t.error}` }
    }
    return { content: `子任务执行超时（ID: ${agentTask.id}），请稍后查询结果。` }
  }
}

/**
 * MongoDB 风格 filter 匹配器。支持：
 *   - 标量值：{col: "215"} 等价于 $eq
 *   - 运算符对象：{col: {$gte: "2026-01", $lte: "2026-03"}}
 *   - 支持 $eq / $ne / $gt / $gte / $lt / $lte / $in
 *
 * 字符串/数字统一用 JS 宽松比较（支持 "2026-01" 字典序、数字大小比较）。
 */
function matchFilter(
  row: Record<string, string | number | null>,
  filter: Record<string, unknown>,
): boolean {
  for (const [col, cond] of Object.entries(filter)) {
    const cell = row[col]
    if (cond === null || cond === undefined) {
      if (cell !== null && cell !== undefined) return false
      continue
    }
    if (typeof cond === 'object' && !Array.isArray(cond)) {
      const ops = cond as Record<string, unknown>
      for (const [op, val] of Object.entries(ops)) {
        if (!matchOp(cell, op, val)) return false
      }
    } else {
      // 标量默认 $eq
      if (!looseEquals(cell, cond)) return false
    }
  }
  return true
}

function matchOp(cell: string | number | null, op: string, val: unknown): boolean {
  switch (op) {
    case '$eq':
      return looseEquals(cell, val)
    case '$ne':
      return !looseEquals(cell, val)
    case '$gt':
      return cell !== null && val !== null && val !== undefined && cell > (val as string | number)
    case '$gte':
      return cell !== null && val !== null && val !== undefined && cell >= (val as string | number)
    case '$lt':
      return cell !== null && val !== null && val !== undefined && cell < (val as string | number)
    case '$lte':
      return cell !== null && val !== null && val !== undefined && cell <= (val as string | number)
    case '$in':
      if (!Array.isArray(val)) return false
      return val.some(v => looseEquals(cell, v))
    default:
      // 未知运算符 → 不匹配
      return false
  }
}

/**
 * 把 cell_language 映射到 .ipynb 的 cell_type。
 *
 * 仅返回三种合法值（'code' | 'markdown' | 'raw'），其余视作 code。
 * 不识别的语言返回 null（由调用方报错）。
 */
function mapNotebookCellType(language: string): 'code' | 'markdown' | 'raw' | null {
  switch (language.toLowerCase()) {
    case 'markdown':
      return 'markdown'
    case 'raw':
      return 'raw'
    case 'python':
    case 'javascript':
    case 'typescript':
    case 'r':
    case 'sql':
    case 'shell':
    case 'bash':
    case 'other':
      return 'code'
    default:
      return null
  }
}

/**
 * .ipynb 的 cell.source 既可能是 string 也可能是 string[]（每元素含末尾换行）。
 * 统一拼成单一字符串以便做替换。
 */
function joinNotebookSource(source: unknown): string {
  if (typeof source === 'string') return source
  if (Array.isArray(source)) return source.map((s) => (typeof s === 'string' ? s : '')).join('')
  return ''
}

/**
 * 写回 cell.source 时拆成 string[]，每个元素以 \n 结尾（最后一行除外，与 Jupyter 默认序列化对齐）。
 * 这种格式的 diff 友好度比单一字符串好得多（git diff 看 source[i] 比看一坨 string 直观）。
 */
function splitNotebookSource(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  const result: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1
    result.push(isLast ? lines[i] : lines[i] + '\n')
  }
  // 末尾若是空行（原文本以 \n 结尾），split 会留一个空字符串元素，不需要保留
  if (result.length > 0 && result[result.length - 1] === '') result.pop()
  return result
}

/**
 * 在指定 cwd 下安全地执行 git 子命令，统一收集 stdout/stderr 并做超时/截断保护。
 *
 * 设计要点：
 *   - shell:false + 参数数组化，杜绝命令注入（即使 args 含分号 / `$()` 也只是字面量）
 *   - 硬超时 GIT_HARD_TIMEOUT_MS，到点 SIGTERM 再 1s SIGKILL
 *   - stdout/stderr 各自字符上限保护（默认 GIT_OUTPUT_MAX_CHARS）
 *   - exitCode === 0 视为成功；非 0 由调用方决定如何呈现
 *
 * 返回形如 { exitCode, stdout, stderr, truncated }，调用方按需 JSON 序列化。
 *
 * @author zhi.qu
 * @date 2026-04-29
 */
async function runGitCommand(
  cwd: string,
  args: readonly string[],
  maxOutputChars: number = GIT_OUTPUT_MAX_CHARS,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; truncated: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = require('child_process') as typeof import('child_process')
  return await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let killedByTimeout = false

    const child = spawn('git', [...args], {
      cwd,
      shell: false,
      env: {
        ...process.env,
        // 让输出稳定可解析
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        NO_COLOR: '1',
        LC_ALL: 'C',
      },
    })

    const timer = setTimeout(() => {
      killedByTimeout = true
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 1000)
    }, GIT_HARD_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= maxOutputChars) { truncated = true; return }
      stdout += chunk.toString('utf-8')
      if (stdout.length > maxOutputChars) {
        stdout = stdout.slice(0, maxOutputChars)
        truncated = true
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= maxOutputChars) { truncated = true; return }
      stderr += chunk.toString('utf-8')
      if (stderr.length > maxOutputChars) {
        stderr = stderr.slice(0, maxOutputChars)
        truncated = true
      }
    })

    child.on('error', (err: Error) => {
      clearTimeout(timer)
      // git 二进制不在 PATH 时常见
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: err.message.includes('ENOENT')
          ? `未找到 git 命令；请确认系统已安装 git 并加入 PATH。`
          : `子进程错误: ${err.message}`,
        truncated: false,
      })
    })

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (killedByTimeout) {
        resolve({
          exitCode: code ?? -1,
          stdout,
          stderr: stderr + `\n[killed by timeout after ${GIT_HARD_TIMEOUT_MS}ms]`,
          truncated,
        })
      } else {
        resolve({ exitCode: code, stdout, stderr, truncated })
      }
    })
  })
}

/**
 * 把 glob 模式（`*` / `**` / `?`）转成 RegExp，用于 list_files 的 glob 匹配。
 *
 * 规则（与 minimatch 子集对齐，覆盖 LLM 95% 用法）：
 *   - `**`  匹配任意路径段（含 `/`），包括零段
 *   - `*`   匹配单段内任意字符（不含 `/`）
 *   - `?`   匹配单段内单个字符（不含 `/`）
 *   - 其他字符按字面量匹配（特殊字符自动转义）
 *
 * 不支持：`{a,b}` 大括号扩展 / `[abc]` 字符类 / `!(...)` 否定。
 * 这些罕见用法 LLM 极少传；如未来需要，可改用 minimatch 库（>50KB，目前不值得）。
 *
 * @example globToRegExp('**\/*.ts').test('src/foo/bar.ts') === true
 * @example globToRegExp('*.tsx').test('App.tsx') === true
 * @example globToRegExp('*.tsx').test('src/App.tsx') === false  // * 不跨目录
 *
 * @author zhi.qu
 * @date 2026-04-29
 */
function globToRegExp(glob: string): RegExp {
  // 先把 ** / * / ? 替换为占位符，避免与正则元字符转义冲突
  const PLACEHOLDER_DOUBLE_STAR = '\u0001'
  const PLACEHOLDER_SINGLE_STAR = '\u0002'
  const PLACEHOLDER_QUESTION = '\u0003'
  const tokenized = glob
    .replace(/\*\*/g, PLACEHOLDER_DOUBLE_STAR)
    .replace(/\*/g, PLACEHOLDER_SINGLE_STAR)
    .replace(/\?/g, PLACEHOLDER_QUESTION)

  // 转义所有正则特殊字符（- 在外的字符类不需转，但保险起见放进 set）
  const escaped = tokenized.replace(/[.+^${}()|[\]\\/]/g, '\\$&')

  // 还原占位符为对应正则片段
  // - **/  匹配 `任意层目录/` 或 空（让 `**/x.ts` 也能命中根下的 `x.ts`）
  // - 单独 ** 匹配 .* 任意字符
  const restored = escaped
    .replace(new RegExp(`${PLACEHOLDER_DOUBLE_STAR}\\\\/`, 'g'), '(?:.*/)?')
    .replace(new RegExp(PLACEHOLDER_DOUBLE_STAR, 'g'), '.*')
    .replace(new RegExp(PLACEHOLDER_SINGLE_STAR, 'g'), '[^/]*')
    .replace(new RegExp(PLACEHOLDER_QUESTION, 'g'), '[^/]')

  return new RegExp(`^${restored}$`)
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  return String(a) === String(b)
}

/**
 * 简单 IRR 估算（牛顿迭代法，取 [-50, 300%] 区间）
 */
function estimateIRR(
  investment: number, years: number, capacity: number,
  peakPrice: number, valleyPrice: number, dod: number, efficiency: number,
  cycles: number, demandSaving: number, opex: number, degradation: number
): number {
  const cashflows = [-investment]
  for (let y = 1; y <= years; y++) {
    const degraded = capacity * Math.pow(1 - degradation, y - 1)
    const daily = degraded * dod * efficiency * (peakPrice - valleyPrice) * cycles
    const annual = daily * 330 + demandSaving - opex
    cashflows.push(annual)
  }

  let rate = 0.1
  let converged = false
  for (let i = 0; i < 50; i++) {
    let npv = 0
    let dnpv = 0
    for (let t = 0; t < cashflows.length; t++) {
      npv += cashflows[t] / Math.pow(1 + rate, t)
      if (t > 0) dnpv -= t * cashflows[t] / Math.pow(1 + rate, t + 1)
    }
    if (Math.abs(dnpv) < 1e-10) {
      converged = Math.abs(npv) < 1e-6
      break
    }
    const newRate = rate - npv / dnpv
    if (Math.abs(newRate - rate) < 1e-6) { rate = newRate; converged = true; break }
    rate = newRate
    if (rate < -0.99) { rate = -0.99; break }
    if (rate > 5) { rate = 5; break }
  }
  if (!converged) {
    console.warn(`[IRR] 牛顿迭代未收敛，返回估算值 ${(rate * 100).toFixed(2)}%`)
  }
  return rate
}

// ─── HTML → Markdown / Plain Text 工具函数（web_fetch 专用） ─────────────────
//
// 自研零依赖转换，覆盖 80% 常见 HTML 场景（标题/链接/列表/段落/代码块/表格）。
// 不依赖 jsdom / cheerio / turndown 等大型库，让 packages/core 保持轻量。
//
// 已知局限：
// - 不解析 CSS（display:none 的内容也会保留）
// - 嵌套深的 ul/ol 缩进按 2 层处理，超深结构会扁平化
// - 不处理 <script type="application/ld+json"> 这种结构化数据
//
// 这些局限对 LLM 阅读体验影响很小（LLM 能从主体内容读懂语义即可）。

/**
 * 解码 HTML 实体（&amp; / &lt; / &#39; / &#x4e2d; 等）。
 * 顺序：
 *   1. 数字实体 &#123; / &#x7B;（覆盖任意 Unicode）
 *   2. 命名实体（高频常用集合，避免引入 he 这种 50KB+ 的库）
 */
function decodeHtmlEntities(html: string): string {
  return html
    // 十进制数字实体
    .replace(/&#(\d+);/g, (_, code) => {
      const n = parseInt(code, 10)
      return Number.isFinite(n) && n >= 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : ''
    })
    // 十六进制数字实体
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, code) => {
      const n = parseInt(code, 16)
      return Number.isFinite(n) && n >= 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : ''
    })
    // 命名实体
    .replace(/&[a-zA-Z]+;/g, (m) => HTML_ENTITIES[m] ?? m)
}

/**
 * 剥离脚本/样式/隐藏/媒体等非内容标签（连同内容一起删）。
 * 这是所有 HTML 处理的预处理步骤。
 */
function stripNonContentTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
}

/**
 * HTML → Markdown（用 turndown 库，业界主流方案）。
 *
 * 优势：
 *   - 处理嵌套 / 边界 case 比手写 regex 健壮很多
 *   - 自带 Node 端 DOM 实现（@mixmark-io/domino），无需 jsdom 大依赖
 *   - 通过 .remove(['script', ...]) 配置去除噪声
 *
 * 已配置：
 *   - headingStyle: 'atx'        → # H1（不用 setext 风格的 === 下划线）
 *   - codeBlockStyle: 'fenced'   → ``` 代码块（不用缩进 4 空格）
 *   - bulletListMarker: '-'      → - item（不用 *）
 *   - linkStyle: 'inlined'       → [text](url)（不用 [text][1] 引用式）
 *
 * 注：turndown 默认不处理 GFM table；如需结构化表格，
 *      可后续装 turndown-plugin-gfm 并 .use(gfm)。当前表格会扁平化为文本流。
 */
let turndownInstance: TurndownService | null = null
function getTurndown(): TurndownService {
  if (!turndownInstance) {
    turndownInstance = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      linkStyle: 'inlined',
      emDelimiter: '*',
    })
    // 这些标签整段移除（连同内容）
    turndownInstance.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'form', 'nav'])
  }
  return turndownInstance
}

function htmlToMarkdown(html: string): string {
  // turndown 自带 DOM parser 会处理 doctype/comments，但显式预清理一次更稳
  const cleaned = stripNonContentTags(html)
  return getTurndown()
    .turndown(cleaned)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * HTML → 纯文本（剥所有标签和实体，保留段落分隔）。
 * 用于 format=text 场景。
 */
function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    stripNonContentTags(html)
      .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
