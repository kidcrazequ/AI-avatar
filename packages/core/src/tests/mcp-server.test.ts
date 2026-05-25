/**
 * @file mcp-server.ts 烟测
 *
 * 验证：
 *   - buildSoulMcpServer 构造成功（路径校验 + 5 个 tool 注册）
 *   - listTools 返回 5 个工具（avatars/get/search_chunks/search_files/list_skills）
 *   - soul_list_avatars 能跑通并返回合法 JSON
 *
 * 不验证：stdio transport 端到端（那是 SDK 的职责，本测试只盖 Soul 自己的胶水代码）。
 *
 * @author zhi.qu
 * @date 2026-05-25
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildSoulMcpServer } from '../mcp-server'

describe('mcp-server', () => {
  let tmpRoot: string
  let avatarsPath: string
  let templatesPath: string

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-mcp-test-'))
    avatarsPath = path.join(tmpRoot, 'avatars')
    templatesPath = path.join(tmpRoot, 'templates')
    fs.mkdirSync(avatarsPath, { recursive: true })
    fs.mkdirSync(templatesPath, { recursive: true })

    // 造一个最小可用分身：CLAUDE.md（avatar 识别凭据）+ soul.md + 1 个 knowledge 文件
    const a1 = path.join(avatarsPath, 'test-avatar')
    fs.mkdirSync(path.join(a1, 'knowledge'), { recursive: true })
    fs.mkdirSync(path.join(a1, 'skills'), { recursive: true })
    fs.writeFileSync(path.join(a1, 'CLAUDE.md'), '# 测试分身\n\n描述：一个用于单测的最小分身。\n')
    fs.writeFileSync(path.join(a1, 'soul.md'), '# 测试灵魂\n\n## Identity\n我是测试用分身。\n\n## Principles\n红线：不编。\n')
    fs.writeFileSync(
      path.join(a1, 'knowledge', 'hello.md'),
      '# 储能基础\n\n磷酸铁锂电池循环寿命 6000 次，能量密度 160Wh/kg。\n',
    )
  })

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('buildSoulMcpServer 路径不存在时应抛错', () => {
    assert.throws(
      () => buildSoulMcpServer({ avatarsPath: '/nonexistent/xxxxxxx' }),
      /不存在/,
    )
  })

  it('buildSoulMcpServer 应注册 5 个 soul_* tool', async () => {
    const server = buildSoulMcpServer({ avatarsPath, templatesPath })
    // McpServer 内部 _registeredTools 是 private，但 server.server.listTools 是公开请求处理器。
    // 用 SDK 的内部 Server 实例直接列出来。
    // 直接探 _registeredTools 字段（McpServer 私有，但单测里用 unknown cast 是可以接受的取巧）
    const reg = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
    assert.ok(reg, '_registeredTools 应已初始化')
    const names = Object.keys(reg).sort()
    assert.deepEqual(names, [
      'soul_get_avatar',
      'soul_list_avatars',
      'soul_list_skills',
      'soul_search_chunks',
      'soul_search_files',
    ])
  })

  it('soul_list_avatars callback 应返回测试分身', async () => {
    const server = buildSoulMcpServer({ avatarsPath, templatesPath })
    const reg = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }> | { content: Array<{ text: string }> } }>
    })._registeredTools
    const result = await reg.soul_list_avatars.handler({}, {})
    const text = result.content[0]?.text ?? ''
    const parsed = JSON.parse(text)
    assert.ok(Array.isArray(parsed), '应返回数组')
    assert.equal(parsed.length, 1, '应有 1 个分身')
    assert.equal(parsed[0].id, 'test-avatar')
  })

  it('soul_search_chunks 应带 coverage 头部', async () => {
    const server = buildSoulMcpServer({ avatarsPath, templatesPath })
    const reg = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }> | { content: Array<{ text: string }> } }>
    })._registeredTools
    const hit = await reg.soul_search_chunks.handler(
      { avatarId: 'test-avatar', query: '磷酸铁锂 循环寿命', k: 3 },
      {},
    )
    const hitText = hit.content[0]?.text ?? ''
    assert.match(hitText, /\[coverage: hint=(empty|low|partial|high)/, '应有 coverage 头部')

    const miss = await reg.soul_search_chunks.handler(
      { avatarId: 'test-avatar', query: 'xxxxxxxxxxxxxxxxxxxx', k: 3 },
      {},
    )
    const missText = miss.content[0]?.text ?? ''
    assert.match(missText, /hint=empty/, '完全无命中应是 empty')
  })
})
