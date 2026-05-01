/**
 * @file MCP (Model Context Protocol) 客户端连接管理器
 *
 * 职责：
 *   - 管理多个 MCP server 的连接（stdio / streamable-http / sse 三种 transport）
 *   - 启动时连接、运行时增删启停、退出时优雅关闭
 *   - 把所有 server 的 tools 聚合后通过 listTools 暴露
 *   - 接收 LLM 的工具调用，路由到对应 server.callTool
 *
 * 工具命名空间：
 *   暴露给 LLM 的工具名 = `mcp__{serverName}__{toolName}`
 *   防止多个 server 同名工具冲突，同时让 LLM 一眼看出工具来源
 *
 * 安全 / 健壮性：
 *   - 单个 server 连接失败不阻塞其他 server，也不阻塞主进程启动
 *   - server 名称必须 [a-zA-Z0-9_-]，避免命名空间注入
 *   - callTool 默认 60 秒超时，可在 server 配置中覆盖
 *
 * 注：本类不处理「server 配置怎么持久化」的问题，那是上层（DB / settings）的事。
 *      构造时可一次性注入初始 servers，运行时也能 add/remove。
 *
 * @author zhi.qu
 * @date 2026-04-29
 */

// 走 SDK package.json 的 exports 字段（需要 tsconfig.moduleResolution = "bundler" 或 "node16"）。
// SDK 是双格式包（@modelcontextprotocol/sdk 1.29），编译产物 commonjs 走 require → cjs 入口。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

/** 工具调用的统一返回（与 ToolRouter.ToolCallResult 兼容）*/
export interface McpToolCallResult {
  content: string
  error?: string
  /** 透传 MCP server 返回的 isError 标志 */
  isError?: boolean
}

/** 单个 MCP server 的配置 */
export interface McpServerConfig {
  /** 唯一名称，仅允许 [a-zA-Z0-9_-]，长度 1~32 */
  name: string
  /** 是否启用；false 时即使配置存在也不连接 */
  enabled?: boolean
  /** 传输协议 */
  transport: 'stdio' | 'http' | 'sse'

  // ─── stdio 专用 ───────────────────────────────────────────
  /** 可执行命令（如 'node' / 'npx' / '/usr/bin/python'） */
  command?: string
  /** 命令行参数 */
  args?: string[]
  /** 环境变量（合并到主进程 env） */
  env?: Record<string, string>
  /** 工作目录 */
  cwd?: string

  // ─── http / sse 专用 ──────────────────────────────────────
  /** 服务端 URL */
  url?: string

  // ─── 通用 ────────────────────────────────────────────────
  /** callTool 默认超时（毫秒），默认 60_000 */
  timeoutMs?: number
  /** 给用户看的人类可读说明 */
  description?: string
}

/** server 当前状态 */
export type McpServerStatus =
  | 'idle'          // 已配置，未连接（enabled=false 或还未尝试连接）
  | 'connecting'    // 正在建立连接
  | 'connected'     // 已连接，工具可用
  | 'error'         // 连接或运行时出错
  | 'disconnected'  // 主动断开

/** server 的工具元信息 */
export interface McpToolMeta {
  /** LLM 看到的全名：mcp__{serverName}__{toolName} */
  qualifiedName: string
  /** 来源 server 名称 */
  serverName: string
  /** server 内的原始 tool 名 */
  toolName: string
  /** 工具描述（来自 server） */
  description: string
  /** 入参 JSON Schema */
  inputSchema: unknown
}

/** 暴露给 UI 的快照（不含 client 实例本身） */
export interface McpServerSnapshot {
  name: string
  status: McpServerStatus
  transport: McpServerConfig['transport']
  description?: string
  toolCount: number
  tools: McpToolMeta[]
  error?: string
  lastConnectedAt?: number
}

/** 内部使用的连接记录（含运行时实例） */
interface ConnectedServer {
  config: McpServerConfig
  status: McpServerStatus
  client: Client | null
  /** 用于清理 transport 持有的资源（stdio 子进程、http 连接） */
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport | null
  tools: McpToolMeta[]
  error?: string
  lastConnectedAt?: number
}

/** server 名称合法性校验：避免命名空间注入与 LLM 解析歧义 */
const SERVER_NAME_REGEX = /^[a-zA-Z0-9_-]{1,32}$/
/** 工具命名空间分隔符 */
const TOOL_NAME_SEPARATOR = '__'
/** 工具命名空间前缀 */
const TOOL_NAME_PREFIX = 'mcp'
/** callTool 默认超时（60 秒） */
const DEFAULT_CALL_TIMEOUT_MS = 60_000
/** 连接超时（10 秒）—— 防止 stdio 卡死 */
const CONNECT_TIMEOUT_MS = 10_000

export class McpClientManager {
  private servers = new Map<string, ConnectedServer>()

  /**
   * 构造时可注入初始 server 配置（异步连接，不阻塞构造）。
   * 调用 ready() 等待全部首批连接完成。
   */
  constructor(initialServers: McpServerConfig[] = []) {
    for (const cfg of initialServers) {
      // 同步注册占位符，异步连接
      this.registerPlaceholder(cfg)
    }
  }

  /**
   * 等待所有处于 connecting 状态的 server 完成首批连接（成功或失败）。
   * 用于主进程启动时确保 LLM 第一次调用前 server 列表稳定。
   */
  async ready(): Promise<void> {
    const pending = Array.from(this.servers.values())
      .filter((r) => r.status === 'connecting')
      .map((r) => this.connectServer(r.config.name).catch(() => undefined))
    await Promise.all(pending)
  }

  /**
   * 添加一个新 server 并立即异步连接。
   * 若 enabled=false，仅注册，不连接。
   * 若 name 已存在，先删除旧的再添加。
   */
  async addServer(config: McpServerConfig): Promise<McpServerSnapshot> {
    if (this.servers.has(config.name)) {
      await this.removeServer(config.name)
    }
    this.registerPlaceholder(config)
    if (config.enabled !== false) {
      await this.connectServer(config.name).catch(() => undefined)
    }
    return this.getSnapshot(config.name)!
  }

  /** 移除 server，关闭其连接 */
  async removeServer(name: string): Promise<void> {
    const record = this.servers.get(name)
    if (!record) return
    await this.disconnectInternal(record)
    this.servers.delete(name)
  }

  /** 主动断开（保留配置，可后续重连） */
  async disconnectServer(name: string): Promise<void> {
    const record = this.servers.get(name)
    if (!record) return
    await this.disconnectInternal(record)
    record.status = 'disconnected'
  }

  /** 重新连接 */
  async reconnectServer(name: string): Promise<void> {
    const record = this.servers.get(name)
    if (!record) throw new Error(`MCP server '${name}' 不存在`)
    await this.disconnectInternal(record)
    await this.connectServer(name)
  }

  /** 列出所有 server 的状态快照（按名称排序） */
  listServers(): McpServerSnapshot[] {
    return Array.from(this.servers.keys())
      .sort()
      .map((n) => this.getSnapshot(n)!)
  }

  /** 获取单个 server 快照 */
  getSnapshot(name: string): McpServerSnapshot | null {
    const r = this.servers.get(name)
    if (!r) return null
    return {
      name: r.config.name,
      status: r.status,
      transport: r.config.transport,
      description: r.config.description,
      toolCount: r.tools.length,
      tools: r.tools,
      error: r.error,
      lastConnectedAt: r.lastConnectedAt,
    }
  }

  /**
   * 列出所有可用工具（已连接 server 的全部 tools）。
   * 供 ToolRouter.list_mcp_tools 调用。
   */
  listTools(): McpToolMeta[] {
    const all: McpToolMeta[] = []
    for (const r of this.servers.values()) {
      if (r.status === 'connected') all.push(...r.tools)
    }
    return all
  }

  /**
   * 调用一个 MCP 工具。
   * @param qualifiedName 形如 `mcp__myserver__mytool` 的全名，
   *                       或形如 `myserver.mytool` / `myserver/mytool` 的紧凑写法（容错）。
   * @param args 工具入参，按 server 的 inputSchema 校验
   * @param opts.timeoutMs 单次调用超时（不传则用 server 配置或 DEFAULT_CALL_TIMEOUT_MS）
   */
  async callTool(
    qualifiedName: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<McpToolCallResult> {
    const parsed = this.parseQualifiedName(qualifiedName)
    if (!parsed) {
      return {
        content: '',
        error: `无效的 MCP 工具名 '${qualifiedName}'，期望格式 'mcp__<server>__<tool>'。可用工具：${this.listTools().map((t) => t.qualifiedName).join(', ') || '（暂无已连接 server）'}`,
      }
    }
    const record = this.servers.get(parsed.serverName)
    if (!record) {
      return { content: '', error: `MCP server '${parsed.serverName}' 不存在` }
    }
    if (record.status !== 'connected' || !record.client) {
      return {
        content: '',
        error: `MCP server '${parsed.serverName}' 未连接（status=${record.status}${record.error ? `, error=${record.error}` : ''}）`,
      }
    }
    const toolMeta = record.tools.find((t) => t.toolName === parsed.toolName)
    if (!toolMeta) {
      return {
        content: '',
        error: `MCP server '${parsed.serverName}' 没有工具 '${parsed.toolName}'。可用：${record.tools.map((t) => t.toolName).join(', ')}`,
      }
    }

    const timeout = opts?.timeoutMs ?? record.config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS

    try {
      const result = await record.client.callTool(
        { name: parsed.toolName, arguments: args },
        undefined,
        { timeout },
      )
      // MCP 返回的 content 是 array，每项有 type='text'|'image'|'resource'
      // 这里取所有 type='text' 的拼起来；非文本类型给个标记
      const contentParts = (result.content ?? []) as Array<Record<string, unknown>>
      const textParts: string[] = []
      for (const part of contentParts) {
        if (part.type === 'text' && typeof part.text === 'string') {
          textParts.push(part.text)
        } else if (part.type === 'image') {
          textParts.push(`[图片 mimeType=${String(part.mimeType ?? 'unknown')}，大小约 ${typeof part.data === 'string' ? part.data.length : 0} 字节，已省略 base64 内容]`)
        } else if (part.type === 'resource') {
          textParts.push(`[资源 ${JSON.stringify(part.resource ?? {})}]`)
        } else {
          textParts.push(`[未知 content 类型: ${JSON.stringify(part)}]`)
        }
      }
      const content = textParts.join('\n')
      return {
        content,
        isError: result.isError === true,
        ...(result.isError === true ? { error: '工具内部报告失败（isError=true）' } : {}),
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: '', error: `MCP 调用失败 (${parsed.serverName}.${parsed.toolName}): ${msg}` }
    }
  }

  /** 关闭所有连接（主进程退出前调用） */
  async closeAll(): Promise<void> {
    const all = Array.from(this.servers.values())
    await Promise.all(all.map((r) => this.disconnectInternal(r).catch(() => undefined)))
    this.servers.clear()
  }

  // ───── 内部辅助方法 ────────────────────────────────────────

  /** 校验配置合法性，注册占位符 */
  private registerPlaceholder(config: McpServerConfig): void {
    if (!SERVER_NAME_REGEX.test(config.name)) {
      throw new Error(`MCP server 名称非法：'${config.name}'，仅允许 [a-zA-Z0-9_-]，长度 1~32`)
    }
    if (config.transport === 'stdio' && !config.command?.trim()) {
      throw new Error(`MCP server '${config.name}' 是 stdio 类型，必须指定 command`)
    }
    if ((config.transport === 'http' || config.transport === 'sse') && !config.url?.trim()) {
      throw new Error(`MCP server '${config.name}' 是 ${config.transport} 类型，必须指定 url`)
    }
    this.servers.set(config.name, {
      config,
      status: config.enabled === false ? 'idle' : 'connecting',
      client: null,
      transport: null,
      tools: [],
    })
  }

  /** 真正建立连接 */
  private async connectServer(name: string): Promise<void> {
    const record = this.servers.get(name)
    if (!record) throw new Error(`MCP server '${name}' 未注册`)
    record.status = 'connecting'
    record.error = undefined

    try {
      const transport = this.buildTransport(record.config)
      const client = new Client({ name: 'soul-avatar', version: '1.0.0' })

      // 用 Promise.race 保证连接不会卡死
      const connectPromise = client.connect(transport)
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`连接超时 ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
      )
      await Promise.race([connectPromise, timeoutPromise])

      // 拉取工具列表（分页支持）
      const allTools: McpToolMeta[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : {})
        for (const t of page.tools) {
          allTools.push({
            qualifiedName: `${TOOL_NAME_PREFIX}${TOOL_NAME_SEPARATOR}${name}${TOOL_NAME_SEPARATOR}${t.name}`,
            serverName: name,
            toolName: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema,
          })
        }
        cursor = page.nextCursor
      } while (cursor)

      record.client = client
      record.transport = transport
      record.tools = allTools
      record.status = 'connected'
      record.lastConnectedAt = Date.now()
    } catch (err) {
      record.status = 'error'
      record.error = err instanceof Error ? err.message : String(err)
      // 清理可能已部分创建的资源
      await this.disconnectInternal(record).catch(() => undefined)
      throw err
    }
  }

  /** 创建 transport 实例 */
  private buildTransport(
    config: McpServerConfig,
  ): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
    if (config.transport === 'stdio') {
      return new StdioClientTransport({
        command: config.command!,
        args: config.args ?? [],
        env: config.env,
        cwd: config.cwd,
      })
    }
    if (config.transport === 'http') {
      return new StreamableHTTPClientTransport(new URL(config.url!))
    }
    return new SSEClientTransport(new URL(config.url!))
  }

  /** 关闭连接 + 清理资源（不抛错，幂等） */
  private async disconnectInternal(record: ConnectedServer): Promise<void> {
    try {
      if (record.client) {
        await record.client.close()
      }
    } catch {
      // 关闭过程出错不影响清理
    }
    record.client = null
    record.transport = null
    record.tools = []
  }

  /**
   * 解析 LLM 传入的工具名。
   * 支持：
   *   - 标准：mcp__myserver__mytool
   *   - 容错：myserver.mytool / myserver/mytool
   */
  private parseQualifiedName(name: string): { serverName: string; toolName: string } | null {
    // 标准格式：mcp__server__tool
    if (name.startsWith(`${TOOL_NAME_PREFIX}${TOOL_NAME_SEPARATOR}`)) {
      const rest = name.slice(TOOL_NAME_PREFIX.length + TOOL_NAME_SEPARATOR.length)
      const sepIdx = rest.indexOf(TOOL_NAME_SEPARATOR)
      if (sepIdx > 0) {
        return { serverName: rest.slice(0, sepIdx), toolName: rest.slice(sepIdx + TOOL_NAME_SEPARATOR.length) }
      }
    }
    // 容错：a.b 或 a/b
    const dotIdx = name.indexOf('.')
    if (dotIdx > 0) {
      return { serverName: name.slice(0, dotIdx), toolName: name.slice(dotIdx + 1) }
    }
    const slashIdx = name.indexOf('/')
    if (slashIdx > 0) {
      return { serverName: name.slice(0, slashIdx), toolName: name.slice(slashIdx + 1) }
    }
    return null
  }
}
