/**
 * tool-router grep-first 网关单测。
 *
 * 意图（WHY）：grep-first 分身（avatar.config.json#grepFirst，如小凯 ~30MB 大库）
 * 的知识库走 grep 工具按需检索，BM25 `search_knowledge` 让位——直接返回引导改用
 * knowledge_grep 的提示，**不构建 chunk**（大库同步 buildChunks 读全库会锁死主进程）。
 *
 * 钉死：开启 grepFirst → search_knowledge 返回让位提示；关闭 → 恢复正常 BM25 路径。
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test \
 *     ../packages/core/src/tests/tool-router-grep-first.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { ToolRouter } from '../tool-router'

const AVATAR_ID = 'grepfirst-test'

function setupSandbox(): { avatarsPath: string; knowledgePath: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-grepfirst-'))
  const avatarsPath = path.join(root, 'avatars')
  const knowledgePath = path.join(avatarsPath, AVATAR_ID, 'knowledge')
  fs.mkdirSync(knowledgePath, { recursive: true })
  return {
    avatarsPath,
    knowledgePath,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ } },
  }
}

test('grep-first 分身：search_knowledge 让位 grep，返回引导而非 BM25 结果', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(
      path.join(knowledgePath, 'doc.md'),
      '# 储能手册\n上海电价峰谷价差 0.83 元/kWh，这段内容足够长用于 search_knowledge 检索测试。\n',
      'utf-8',
    )

    // 默认（未开 grepFirst）：不应出现让位提示
    const before = await router.execute(AVATAR_ID, { name: 'search_knowledge', arguments: { query: '峰谷价差' } })
    assert.equal(before.error, undefined, `默认检索不应报错: ${before.error ?? ''}`)
    assert.ok(!before.content.includes('grep-first'), '默认分身不应让位 grep')

    // 开启 grepFirst → search_knowledge 让位，引导改用 knowledge_grep
    router.setGrepFirst(AVATAR_ID, true)
    const after = await router.execute(AVATAR_ID, { name: 'search_knowledge', arguments: { query: '峰谷价差' } })
    assert.equal(after.error, undefined, `让位提示不应是 error: ${after.error ?? ''}`)
    assert.match(after.content, /grep-first/, '应说明已切换 grep-first 模式')
    assert.match(after.content, /knowledge_grep/, '应引导改用 knowledge_grep')
    assert.ok(!after.content.includes('峰谷价差 0.83'), '让位时不应返回 BM25 命中的正文')

    // 关闭后恢复正常 BM25 路径（不再出现让位提示）
    router.setGrepFirst(AVATAR_ID, false)
    const restored = await router.execute(AVATAR_ID, { name: 'search_knowledge', arguments: { query: '峰谷价差' } })
    assert.ok(!restored.content.includes('grep-first'), '关闭 grepFirst 后应恢复 BM25')
  } finally {
    cleanup()
  }
})
