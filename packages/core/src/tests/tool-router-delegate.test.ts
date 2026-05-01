/**
 * delegate_task 跨分身委派单测。
 *
 * 覆盖三条主路径：
 *   1. 未传 target_avatar → 沿用旧行为（用当前分身的 systemPromptCache）
 *   2. 传 target_avatar 且回调能加载到 → 子代理用目标分身的 systemPrompt
 *   3. 传 target_avatar 但回调返回 undefined → 返回带候选列表的错误
 *
 * 同时验证：
 *   - target_avatar === avatarId 时等同未传（自委派不触发跨分身路径）
 *   - target_avatar 含路径穿越字符（"../foo"）被 assertSafeSegment 拦截
 *   - 未注入 loadAvatarSystemPrompt 但传了 target_avatar 时给友好错误
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ToolRouter } from '../tool-router'

/**
 * 准备一个临时 avatars/ 目录，里面放三个空骨架分身：current / design-master / small-storage-expert。
 * delegate 流程不需要真去读 avatars 目录里的具体文件
 * （那些走 SoulLoader 的逻辑被 mock 成回调），骨架够空也行。
 */
function setupSandbox(): { avatarsPath: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-delegate-'))
  const avatarsPath = path.join(root, 'avatars')
  fs.mkdirSync(path.join(avatarsPath, 'current'), { recursive: true })
  fs.mkdirSync(path.join(avatarsPath, 'design-master'), { recursive: true })
  fs.mkdirSync(path.join(avatarsPath, 'small-storage-expert'), { recursive: true })
  return {
    avatarsPath,
    cleanup: () => {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ }
    },
  }
}

/** 可控 LLM mock：把收到的 systemPrompt 直接回传，便于断言 */
function makeProbeLLM(): (sys: string, _user: string, _max?: number) => Promise<string> {
  return async (sys: string) => `[probe-result]<<${sys}>>`
}

test('delegate_task 未传 target_avatar 时沿用当前分身的 systemPrompt（向后兼容）', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    router.setSystemPrompt('current', '我是当前分身：A 风格')
    const probe = makeProbeLLM()

    const r = await router.execute(
      'current',
      { name: 'delegate_task', arguments: { task: '帮我写一句口号' } },
      probe,
      undefined,
    )
    assert.equal(r.error, undefined, `不应有错误: ${r.error ?? ''}`)
    assert.match(r.content, /A 风格/, '子代理应当使用当前分身的 systemPrompt')
  } finally {
    router.subAgentManager.destroy()
    cleanup()
  }
})

test('delegate_task target_avatar 命中：用目标分身 systemPrompt（按需 load 并写回缓存）', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  let loadCalls = 0
  const router = new ToolRouter(avatarsPath, {
    loadAvatarSystemPrompt: (id: string) => {
      loadCalls++
      if (id === 'design-master') return '我是 design-master：B 风格'
      return undefined
    },
    listAvailableAvatars: () => ['current', 'design-master', 'small-storage-expert'],
  })
  try {
    router.setSystemPrompt('current', '我是当前分身：A 风格')

    const probe = makeProbeLLM()
    const r1 = await router.execute(
      'current',
      { name: 'delegate_task', arguments: { task: '复刻 Linear 风格 hero 区', target_avatar: 'design-master' } },
      probe,
      undefined,
    )
    assert.equal(r1.error, undefined)
    assert.match(r1.content, /B 风格/, '应当使用目标分身的 systemPrompt')
    assert.equal(loadCalls, 1, '第一次应当触发回调加载')

    // 第二次同样的 target_avatar：命中 cache，回调不再触发
    const r2 = await router.execute(
      'current',
      { name: 'delegate_task', arguments: { task: '再做一版 dark mode', target_avatar: 'design-master' } },
      probe,
      undefined,
    )
    assert.equal(r2.error, undefined)
    assert.match(r2.content, /B 风格/)
    assert.equal(loadCalls, 1, '第二次应当从 cache 拿，不再调回调')
  } finally {
    router.subAgentManager.destroy()
    cleanup()
  }
})

test('delegate_task target_avatar 不存在：返回错误并列出可用分身', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath, {
    loadAvatarSystemPrompt: (id: string) => (id === 'design-master' ? '我是 dm' : undefined),
    listAvailableAvatars: () => ['current', 'design-master', 'small-storage-expert'],
  })
  try {
    router.setSystemPrompt('current', '我是当前分身')

    const r = await router.execute(
      'current',
      { name: 'delegate_task', arguments: { task: '随便跑一个', target_avatar: 'no-such-avatar' } },
      makeProbeLLM(),
      undefined,
    )
    assert.notEqual(r.error, undefined, '应当返回错误')
    assert.match(r.error!, /no-such-avatar/, '错误信息应包含目标分身名')
    assert.match(r.error!, /design-master/, '错误信息应列出可用分身')
  } finally {
    router.subAgentManager.destroy()
    cleanup()
  }
})

test('delegate_task target_avatar === 当前分身 时等同未传（不触发跨分身回调）', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  let loadCalls = 0
  const router = new ToolRouter(avatarsPath, {
    loadAvatarSystemPrompt: () => { loadCalls++; return '不应被调到' },
  })
  try {
    router.setSystemPrompt('current', '当前分身：A 风格')

    const r = await router.execute(
      'current',
      { name: 'delegate_task', arguments: { task: '自委派任务', target_avatar: 'current' } },
      makeProbeLLM(),
      undefined,
    )
    assert.equal(r.error, undefined)
    assert.match(r.content, /A 风格/, '自委派应沿用当前 systemPrompt')
    assert.equal(loadCalls, 0, 'target_avatar 等于当前 avatar 时不触发回调')
  } finally {
    router.subAgentManager.destroy()
    cleanup()
  }
})

test('delegate_task target_avatar 含路径穿越字符被拦截', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath, {
    loadAvatarSystemPrompt: () => '不应到达',
  })
  try {
    router.setSystemPrompt('current', '当前')

    const r = await router.execute(
      'current',
      { name: 'delegate_task', arguments: { task: 'x', target_avatar: '../etc/passwd' } },
      makeProbeLLM(),
      undefined,
    )
    assert.notEqual(r.error, undefined, '路径穿越应被拒绝')
    assert.match(r.error!, /target_avatar|路径|包含|不安全|invalid/i)
  } finally {
    router.subAgentManager.destroy()
    cleanup()
  }
})

test('delegate_task 未注入 loadAvatarSystemPrompt 但传了 target_avatar：返回友好错误', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  // 故意不传 options，模拟单元测试或老调用方
  const router = new ToolRouter(avatarsPath)
  try {
    router.setSystemPrompt('current', '当前')

    const r = await router.execute(
      'current',
      { name: 'delegate_task', arguments: { task: 'x', target_avatar: 'design-master' } },
      makeProbeLLM(),
      undefined,
    )
    assert.notEqual(r.error, undefined)
    assert.match(r.error!, /未注入|loadAvatarSystemPrompt|跨分身/, `错误信息应解释原因，实际: ${r.error ?? ''}`)
  } finally {
    router.subAgentManager.destroy()
    cleanup()
  }
})
