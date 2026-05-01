/**
 * 九层重构新工具单测：glob / search_knowledge / task / ask_question / switch_mode / generate_image。
 *
 * 覆盖：
 *   - glob: pattern 参数正确路由到 listFiles 的 glob
 *   - search_knowledge: 透传到 searchKnowledge
 *   - task: 与 delegate_task 同实现（向后兼容）
 *   - ask_question: 参数校验 + payload 结构
 *   - switch_mode: 参数枚举校验 + payload 结构
 *   - generate_image: 缺 image_api_key 时返回友好错误
 *
 * 不依赖网络（generate_image 仅测鉴权失败路径）；不依赖前端 IPC。
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ToolRouter } from '../tool-router'

interface SandboxResult {
  avatarsPath: string
  cleanup: () => void
}

/**
 * 创建临时 avatars/ 目录，放一个 'current' 分身骨架，并在 workspace 下塞几个文件
 * 让 glob 有东西可以匹配。
 */
function setupSandbox(): SandboxResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-stage9-'))
  const avatarsPath = path.join(root, 'avatars')
  const wsRoot = path.join(avatarsPath, 'current', 'workspaces', 'conv1')
  fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true })
  fs.writeFileSync(path.join(wsRoot, 'src', 'a.ts'), 'export const a = 1')
  fs.writeFileSync(path.join(wsRoot, 'src', 'b.tsx'), 'export const b = 2')
  fs.writeFileSync(path.join(wsRoot, 'README.md'), '# readme')
  return {
    avatarsPath,
    cleanup: () => {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ }
    },
  }
}

test('glob 工具：pattern "**/*.ts" 命中 .ts 文件，不误中 .tsx / .md', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const router = new ToolRouter(avatarsPath)
    const r = await router.execute(
      'current',
      { name: 'glob', arguments: { pattern: '**/*.ts' } },
      undefined,
      'conv1',
    )
    assert.equal(r.error, undefined, `不应有错误: ${r.error ?? ''}`)
    // listFiles 返回 { items: Array<{ path; type }> }
    const parsed = JSON.parse(r.content) as { items?: Array<{ path: string; type: string }> }
    const list = parsed.items ?? []
    // 仅看文件条目（glob 实现允许目录穿透，目录条目也会出现在 items 中）
    const filePaths = list.filter((e) => e.type === 'file').map((e) => e.path).join('|')
    assert.match(filePaths, /src\/a\.ts/, `应命中 src/a.ts; 实际: ${filePaths}`)
    assert.doesNotMatch(filePaths, /b\.tsx/, 'glob **/*.ts 不应命中 .tsx')
    assert.doesNotMatch(filePaths, /README\.md/, 'glob **/*.ts 不应命中 .md')
  } finally {
    cleanup()
  }
})

test('search_knowledge 工具：透传到 searchKnowledge（即使知识库为空也不报错）', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const router = new ToolRouter(avatarsPath)
    const r = await router.execute(
      'current',
      { name: 'search_knowledge', arguments: { query: '储能项目', top_n: 3 } },
      undefined,
      'conv1',
    )
    // 没有索引时 searchKnowledge 通常返回空命中或 hint，但不应抛错
    assert.equal(r.error, undefined, `不应有错误: ${r.error ?? ''}`)
    assert.ok(typeof r.content === 'string')
  } finally {
    cleanup()
  }
})

test('task 工具：与 delegate_task 共用实现（无 callLLM 时返回兼容提示）', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const router = new ToolRouter(avatarsPath)
    const r = await router.execute(
      'current',
      { name: 'task', arguments: { task: '帮我跑一个测试' } },
      undefined,  // 故意不传 callLLM
      'conv1',
    )
    assert.equal(r.error, undefined)
    assert.match(r.content, /子任务已记录|无 LLM 调用权限/, '无 callLLM 时应返回兼容提示')
  } finally {
    cleanup()
  }
})

test('ask_question 工具：选项 < 2 报错', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const router = new ToolRouter(avatarsPath)
    const r = await router.execute(
      'current',
      { name: 'ask_question', arguments: { question: '继续吗？', options: ['只有一个'] } },
      undefined,
      'conv1',
    )
    assert.notEqual(r.error, undefined, '少于 2 项应报错')
    assert.match(r.error!, /至少 2 项/)
  } finally {
    cleanup()
  }
})

test('ask_question 工具：合法 payload 返回结构化 JSON', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const router = new ToolRouter(avatarsPath)
    const r = await router.execute(
      'current',
      { name: 'ask_question', arguments: { question: '继续吗？', options: ['继续', '回滚', '放弃'], allow_custom: true } },
      undefined,
      'conv1',
    )
    assert.equal(r.error, undefined)
    const parsed = JSON.parse(r.content) as { type: string; question: string; options: string[]; allow_custom: boolean }
    assert.equal(parsed.type, 'ask_question')
    assert.equal(parsed.question, '继续吗？')
    assert.deepEqual(parsed.options, ['继续', '回滚', '放弃'])
    assert.equal(parsed.allow_custom, true)
  } finally {
    cleanup()
  }
})

test('switch_mode 工具：枚举外的 mode 报错', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const router = new ToolRouter(avatarsPath)
    const r = await router.execute(
      'current',
      { name: 'switch_mode', arguments: { mode: 'invalid' } },
      undefined,
      'conv1',
    )
    assert.notEqual(r.error, undefined)
    assert.match(r.error!, /agent.*plan.*ask/)
  } finally {
    cleanup()
  }
})

test('switch_mode 工具：mode=plan 返回结构化 payload', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const router = new ToolRouter(avatarsPath)
    const r = await router.execute(
      'current',
      { name: 'switch_mode', arguments: { mode: 'plan', reason: '用户要求先看方案' } },
      undefined,
      'conv1',
    )
    assert.equal(r.error, undefined)
    const parsed = JSON.parse(r.content) as { type: string; mode: string; reason?: string }
    assert.equal(parsed.type, 'switch_mode')
    assert.equal(parsed.mode, 'plan')
    assert.equal(parsed.reason, '用户要求先看方案')
  } finally {
    cleanup()
  }
})

test('generate_image 工具：缺 image_api_key 时返回友好错误（不走真实网络）', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    // getSetting 返回空模拟未配置
    const router = new ToolRouter(avatarsPath, {
      getSetting: () => undefined,
    })
    const r = await router.execute(
      'current',
      { name: 'generate_image', arguments: { prompt: '一只赛博朋克风格的猫' } },
      undefined,
      'conv1',
    )
    assert.notEqual(r.error, undefined, '未配置 API Key 应返回错误')
    assert.match(r.error!, /未配置 DashScope|image_api_key|工具集成/)
  } finally {
    cleanup()
  }
})

test('generate_image 工具：prompt 为空报错', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const router = new ToolRouter(avatarsPath, {
      getSetting: () => 'sk-fake-key',
    })
    const r = await router.execute(
      'current',
      { name: 'generate_image', arguments: { prompt: '   ' } },
      undefined,
      'conv1',
    )
    assert.notEqual(r.error, undefined)
    assert.match(r.error!, /缺少 prompt|图片描述/)
  } finally {
    cleanup()
  }
})

test('未知工具名 → 返回明确错误，不影响其他工具', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const router = new ToolRouter(avatarsPath)
    const r = await router.execute(
      'current',
      { name: 'no_such_tool', arguments: {} },
      undefined,
      'conv1',
    )
    assert.notEqual(r.error, undefined)
    assert.match(r.error!, /未知工具/)
  } finally {
    cleanup()
  }
})
