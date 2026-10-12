/**
 * MCP settings 片段生成单测（借鉴 Pi 的可脚本化 seam）。
 *
 * 为什么这些测试存在（Rule 9）：用户拿这段 JSON 直接粘进 MCP 客户端，路径/键名错一处就连不上。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildMcpServerSettingsSnippet } from '../mcp-settings-snippet'

describe('buildMcpServerSettingsSnippet', () => {
  const BIN = '/soul/packages/core/dist/mcp-server-bin.js'
  const AVATARS = '/soul/avatars'

  test('默认 serverName=soul / command=node，env 带 SOUL_AVATARS_PATH', () => {
    const s = buildMcpServerSettingsSnippet({ binPath: BIN, avatarsPath: AVATARS })
    assert.equal(s.serverName, 'soul')
    assert.equal(s.config.command, 'node')
    assert.deepEqual(s.config.args, [BIN])
    assert.equal(s.config.env.SOUL_AVATARS_PATH, AVATARS)
  })

  test('json 可解析且结构正确（mcpServers.<name>.{command,args,env}）', () => {
    const s = buildMcpServerSettingsSnippet({ binPath: BIN, avatarsPath: AVATARS })
    const parsed = JSON.parse(s.json)
    assert.deepEqual(parsed.mcpServers.soul.args, [BIN])
    assert.equal(parsed.mcpServers.soul.env.SOUL_AVATARS_PATH, AVATARS)
  })

  test('自定义 serverName / nodeCommand 生效', () => {
    const s = buildMcpServerSettingsSnippet({
      binPath: BIN,
      avatarsPath: AVATARS,
      serverName: '我的分身',
      nodeCommand: '/usr/local/bin/node',
    })
    assert.equal(s.serverName, '我的分身')
    assert.equal(s.config.command, '/usr/local/bin/node')
    assert.ok(JSON.parse(s.json).mcpServers['我的分身'])
  })

  test('空白 serverName / nodeCommand 回落默认', () => {
    const s = buildMcpServerSettingsSnippet({
      binPath: BIN,
      avatarsPath: AVATARS,
      serverName: '   ',
      nodeCommand: '',
    })
    assert.equal(s.serverName, 'soul')
    assert.equal(s.config.command, 'node')
  })
})
