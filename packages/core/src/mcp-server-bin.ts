#!/usr/bin/env node
/**
 * @file Soul MCP server CLI 入口（stdio transport）
 *
 * 用法（在外部 Claude Code 的 mcp settings 配置）：
 *   {
 *     "mcpServers": {
 *       "soul": {
 *         "command": "node",
 *         "args": ["<soul>/packages/core/dist/mcp-server-bin.js"],
 *         "env": { "SOUL_AVATARS_PATH": "<soul>/avatars" }
 *       }
 *     }
 *   }
 *
 * 也可通过 --avatars=<path> 命令行参数指定（优先于 env）。
 *
 * @author zhi.qu
 * @date 2026-05-25
 */

import path from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildSoulMcpServer } from './mcp-server'

function parseAvatarsPath(): string {
  // 1) CLI flag 优先
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--avatars=')) {
      return path.resolve(arg.slice('--avatars='.length))
    }
  }
  // 2) 环境变量兜底
  const env = process.env.SOUL_AVATARS_PATH
  if (env && env.trim()) {
    return path.resolve(env.trim())
  }
  // 3) 都没有就报错（不猜路径 —— 猜错只会让 listAvatars 返回空，更难排查）
  throw new Error(
    'Soul MCP server 启动失败：未指定 avatars 路径。\n' +
    '请通过 --avatars=<path> 或 SOUL_AVATARS_PATH 环境变量提供分身根目录绝对路径。',
  )
}

async function main(): Promise<void> {
  const avatarsPath = parseAvatarsPath()
  const server = buildSoulMcpServer({ avatarsPath })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // 不打印到 stdout —— stdout 已经被 MCP JSON-RPC 占用，任何额外字节会破坏协议帧。
  // 错误 / 启动日志走 stderr 给运维 / Claude Code 的 server log 面板。
  process.stderr.write(`[soul-mcp] connected (avatars=${avatarsPath})\n`)
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`[soul-mcp] fatal: ${msg}\n`)
  process.exit(1)
})
