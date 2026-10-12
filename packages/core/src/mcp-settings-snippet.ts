/**
 * 生成 Soul MCP server 的"一键配置"片段（借鉴 Pi Coding Agent 把 agent 暴露成可脚本化 seam）。
 *
 * Soul 已内置一个 stdio MCP server（mcp-server-bin.ts，注册 list_avatars / get_avatar /
 * search_chunks / search_files / list_skills 等只读工具），外部工具/定时任务即可查询某分身的
 * 知识。缺的只是"用户不知道怎么接线"——本函数据用户真实路径产出可直接粘贴到 Claude Code /
 * 其它 MCP 客户端 settings 的 JSON 片段。纯函数、无 I/O，便于单测。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

export interface McpServerSnippetInput {
  /** dist/mcp-server-bin.js 的绝对路径。 */
  binPath: string
  /** 分身根目录绝对路径（注入 SOUL_AVATARS_PATH）。 */
  avatarsPath: string
  /** mcpServers 下的键名，缺省 'soul'。 */
  serverName?: string
  /** 启动命令，缺省 'node'。 */
  nodeCommand?: string
}

export interface McpServerSnippet {
  serverName: string
  config: {
    command: string
    args: string[]
    env: Record<string, string>
  }
  /** 完整 mcpServers JSON 片段（含两空格缩进，可直接粘贴）。 */
  json: string
}

/** 据真实路径拼装 MCP server 配置片段。 */
export function buildMcpServerSettingsSnippet(input: McpServerSnippetInput): McpServerSnippet {
  const serverName = input.serverName?.trim() || 'soul'
  const config = {
    command: input.nodeCommand?.trim() || 'node',
    args: [input.binPath],
    env: { SOUL_AVATARS_PATH: input.avatarsPath },
  }
  const json = JSON.stringify({ mcpServers: { [serverName]: config } }, null, 2)
  return { serverName, config, json }
}
