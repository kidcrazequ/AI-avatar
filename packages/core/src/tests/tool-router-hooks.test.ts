/**
 * ToolRouter 实时 Hook 接线单测（借鉴 Pi；F2 follow-up）。
 *
 * 为什么这些测试存在（Rule 9）：把 Hook 总线挂到实时 execute 路径是新行为，必须保证：
 *   ① 注入 hooks 后每次 execute 都 fire POST_TOOL_USE（否则来源锚点 hook 形同虚设）；
 *   ② 未注入 hooks 时 execute 行为与旧路径完全一致（零回归——默认 flag 关时就是这条）；
 *   ③ 源锚点软警告 hook 经真实 execute 能抓到"取数结果无 [来源:] 锚点"，且不阻断结果回流。
 *
 * @author zhi.qu
 * @date 2026-06-02
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { ToolRouter } from '../tool-router'
import { HookRegistry, HookPoint, makeSourceAnchorEnforcementHook, type PostToolUsePayload } from '../agent-runtime'

const AVATAR_ID = 'hook-test'

function setupSandbox(): { avatarsPath: string; knowledgePath: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-tr-hooks-'))
  const avatarsPath = path.join(root, 'avatars')
  const knowledgePath = path.join(avatarsPath, AVATAR_ID, 'knowledge')
  fs.mkdirSync(knowledgePath, { recursive: true })
  return {
    avatarsPath,
    knowledgePath,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ } },
  }
}

test('① 注入 hooks 后 execute fire POST_TOOL_USE（带 toolName + result）', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  try {
    fs.writeFileSync(path.join(knowledgePath, 'a.md'), '铜导率高于铝', 'utf-8')
    const router = new ToolRouter(avatarsPath)
    const reg = new HookRegistry()
    const fired: Array<{ toolName: string; hasResult: boolean }> = []
    reg.register(HookPoint.POST_TOOL_USE, async (p) => {
      const post = p as PostToolUsePayload
      fired.push({ toolName: post.toolName, hasResult: post.result !== undefined && post.result !== null })
    })
    router.setHooks(reg)

    const r = await router.execute(AVATAR_ID, { name: 'knowledge_grep', arguments: { pattern: '铜' } })
    assert.equal(r.error, undefined)
    assert.equal(fired.length, 1)
    assert.equal(fired[0].toolName, 'knowledge_grep')
    assert.equal(fired[0].hasResult, true)
  } finally {
    cleanup()
  }
})

test('② 未注入 hooks：execute 正常返回、不 fire（零回归）', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  try {
    fs.writeFileSync(path.join(knowledgePath, 'a.md'), '铜导率高于铝', 'utf-8')
    const router = new ToolRouter(avatarsPath)
    // 不调 setHooks → this.hooks 为空
    const r = await router.execute(AVATAR_ID, { name: 'knowledge_grep', arguments: { pattern: '铜' } })
    assert.equal(r.error, undefined)
    assert.ok(r.content.length > 0)
  } finally {
    cleanup()
  }
})

test('③ 源锚点软警告 hook 经 execute 抓到无 [来源:] 的取数结果，且不阻断回流', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  try {
    fs.writeFileSync(path.join(knowledgePath, 'a.md'), '铜导率高于铝', 'utf-8')
    const router = new ToolRouter(avatarsPath)
    const reg = new HookRegistry()
    const anchorHook = makeSourceAnchorEnforcementHook() // 默认含 knowledge_grep
    reg.register(HookPoint.POST_TOOL_USE, anchorHook.handler)
    router.setHooks(reg)

    const r = await router.execute(AVATAR_ID, { name: 'knowledge_grep', arguments: { pattern: '铜' } })
    // 结果照常回流（软警告不阻断）
    assert.equal(r.error, undefined)
    assert.ok(r.content.length > 0)
    // knowledge_grep 的 JSON 结果不含 [来源:] → 记一条软警告
    assert.equal(anchorHook.warnings().length, 1)
    assert.equal(anchorHook.warnings()[0].toolName, 'knowledge_grep')
  } finally {
    cleanup()
  }
})
