/**
 * raw-file-resolver.test.ts — 渲染层 anchor → 原始源文件解析器单测
 *
 * 关键场景（共 6 个）：
 *   1. anchor 解析正确 + 调用 IPC + 缓存命中（第二次不再调 IPC）
 *   2. excel 类型 anchor → 直接返回 null，不调 IPC
 *   3. 非法 anchor（不是 [来源: ...] 格式）→ 返回 null
 *   4. window.electronAPI.resolveRawFile 未注入 → 返回 null，不抛错
 *   5. 主进程返回 null 也写缓存（第二次相同 key 不再调 IPC）
 *   6. 主进程抛错返回 null 且不写缓存（第二次仍走 IPC，callCount === 2）
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test src/services/raw-file-resolver.test.ts
 *
 * @author zhi.qu
 * @date 2026-05-06
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRawFileForAnchor, clearRawFileCache } from './raw-file-resolver'
import type { ResolveRawFileResult } from '../types/raw-file-anchor'

// ─── Mock 工具：可记录调用次数 + 自定义返回 ────────────────────────────────

type ResolveRawFileFn = (avatarId: string, mdRelativePath: string) => Promise<ResolveRawFileResult | null>

interface MockResolver {
  fn: ResolveRawFileFn
  callCount: number
  calls: Array<{ avatarId: string; mdRelativePath: string }>
  reset: () => void
}

/**
 * 创建一个可观测的 mock resolver。
 * - `behavior` 可以是固定返回值，也可以是按调用顺序消费的数组（每次取下一个）
 */
function createMockResolver(
  behavior: ResolveRawFileResult | null | Array<ResolveRawFileResult | null | Error> | (() => ResolveRawFileResult | null),
): MockResolver {
  const mock: MockResolver = {
    callCount: 0,
    calls: [],
    fn: async (avatarId: string, mdRelativePath: string) => {
      mock.callCount += 1
      mock.calls.push({ avatarId, mdRelativePath })
      if (Array.isArray(behavior)) {
        const next = behavior.shift()
        if (next instanceof Error) throw next
        return next ?? null
      }
      if (typeof behavior === 'function') return behavior()
      return behavior
    },
    reset: () => {
      mock.callCount = 0
      mock.calls = []
    },
  }
  return mock
}

/**
 * 把 mock 注入到 globalThis.window.electronAPI 上（模拟 preload 注入）。
 * 传 undefined 表示移除整个 electronAPI（用于测试 4）。
 */
function installMockResolver(mock: MockResolver | undefined): void {
  const target = globalThis as unknown as {
    window?: { electronAPI?: { resolveRawFile?: ResolveRawFileFn } }
  }
  if (mock === undefined) {
    target.window = {}
    return
  }
  target.window = { electronAPI: { resolveRawFile: mock.fn } }
}

/**
 * 卸载 window，恢复 Node 环境的纯净状态。
 */
function uninstallWindow(): void {
  const target = globalThis as unknown as { window?: unknown }
  delete target.window
}

// ─── 测试夹具 ────────────────────────────────────────────────────────────

const AVATAR_ID = 'xiaodu-ci-storage'
const VALID_ANCHOR = '[来源: knowledge/02_01_01_0221_BMU吸塑盖板.md#L12-L20]'
const VALID_MD_PATH = '02_01_01_0221_BMU吸塑盖板.md'

const SAMPLE_RESULT: ResolveRawFileResult = {
  rawRelPath: '_raw/02.01.01.0221_BMU吸塑盖板.pdf',
  displayName: '02.01.01.0221_BMU吸塑盖板.pdf',
  ext: 'pdf',
  exists: true,
}

describe('raw-file-resolver', () => {
  beforeEach(() => {
    clearRawFileCache()
    uninstallWindow()
  })

  afterEach(() => {
    uninstallWindow()
  })

  // ─── 用例 1 ─────────────────────────────────────────────────────────────
  it('anchor 解析正确 + 调用 IPC + 缓存命中（二次调用不再调 IPC）', async () => {
    const mock = createMockResolver(SAMPLE_RESULT)
    installMockResolver(mock)

    const first = await resolveRawFileForAnchor(AVATAR_ID, VALID_ANCHOR)
    assert.deepEqual(first, SAMPLE_RESULT)
    assert.equal(mock.callCount, 1)
    assert.deepEqual(mock.calls[0], { avatarId: AVATAR_ID, mdRelativePath: VALID_MD_PATH })

    const second = await resolveRawFileForAnchor(AVATAR_ID, VALID_ANCHOR)
    assert.deepEqual(second, SAMPLE_RESULT)
    assert.equal(mock.callCount, 1, '相同入参第二次应命中缓存，不再调 IPC')
  })

  // ─── 用例 2 ─────────────────────────────────────────────────────────────
  it('excel 类型 anchor 返回 null，不调 IPC', async () => {
    const mock = createMockResolver(SAMPLE_RESULT)
    installMockResolver(mock)

    const excelAnchor = '[来源: knowledge/_excel/价格表.json#sheet=A&rows=2-5]'
    const result = await resolveRawFileForAnchor(AVATAR_ID, excelAnchor)

    assert.equal(result, null)
    assert.equal(mock.callCount, 0, 'excel 类型不应触发 IPC')
  })

  // ─── 用例 3 ─────────────────────────────────────────────────────────────
  it('非法 anchor（非 [来源: ...] 格式）返回 null', async () => {
    const mock = createMockResolver(SAMPLE_RESULT)
    installMockResolver(mock)

    const result = await resolveRawFileForAnchor(AVATAR_ID, '这不是一个 anchor')

    assert.equal(result, null)
    assert.equal(mock.callCount, 0, '非法 anchor 不应触发 IPC')
  })

  // ─── 用例 4 ─────────────────────────────────────────────────────────────
  it('window.electronAPI.resolveRawFile 未注入时返回 null，不抛错', async () => {
    installMockResolver(undefined)

    const result = await resolveRawFileForAnchor(AVATAR_ID, VALID_ANCHOR)

    assert.equal(result, null)
  })

  // ─── 用例 5 ─────────────────────────────────────────────────────────────
  it('主进程返回 null 也写缓存（二次调用不再调 IPC）', async () => {
    const mock = createMockResolver(null)
    installMockResolver(mock)

    const first = await resolveRawFileForAnchor(AVATAR_ID, VALID_ANCHOR)
    assert.equal(first, null)
    assert.equal(mock.callCount, 1)

    const second = await resolveRawFileForAnchor(AVATAR_ID, VALID_ANCHOR)
    assert.equal(second, null)
    assert.equal(mock.callCount, 1, 'null 结果也应进入缓存，避免重复 IPC')
  })

  // ─── 用例 7：#章节名 anchor（LLM 实际产出的常见格式）─────────────────────
  it('#章节名 anchor 也能正确提取 .md 路径', async () => {
    const mock = createMockResolver(SAMPLE_RESULT)
    installMockResolver(mock)

    const sectionAnchor = '[来源: knowledge/ENS-L262-01用户手册_-V1.md#2. 设备布局图]'
    const result = await resolveRawFileForAnchor(AVATAR_ID, sectionAnchor)

    assert.deepEqual(result, SAMPLE_RESULT)
    assert.equal(mock.callCount, 1)
    assert.equal(mock.calls[0].mdRelativePath, 'ENS-L262-01用户手册_-V1.md', '应提取出 .md 文件名，忽略 #章节名 后缀')
  })

  // ─── 用例 8：无 # 后缀的纯文件 anchor ─────────────────────────────────────
  it('无 # 后缀的 anchor 也能解析', async () => {
    const mock = createMockResolver(SAMPLE_RESULT)
    installMockResolver(mock)

    const bareAnchor = '[来源: knowledge/foo.md]'
    const result = await resolveRawFileForAnchor(AVATAR_ID, bareAnchor)

    assert.deepEqual(result, SAMPLE_RESULT)
    assert.equal(mock.calls[0].mdRelativePath, 'foo.md')
  })

  // ─── 用例 9：#section=xxx 格式 anchor ─────────────────────────────────────
  it('#section=xxx 格式 anchor 也能解析', async () => {
    const mock = createMockResolver(SAMPLE_RESULT)
    installMockResolver(mock)

    const anchor = '[来源: knowledge/sub/foo.md#section=技术参数]'
    const result = await resolveRawFileForAnchor(AVATAR_ID, anchor)

    assert.deepEqual(result, SAMPLE_RESULT)
    assert.equal(mock.calls[0].mdRelativePath, 'sub/foo.md', '子目录路径应完整保留')
  })

  // ─── 用例 6 ─────────────────────────────────────────────────────────────
  it('主进程抛错返回 null 且不写缓存（二次调用仍走 IPC）', async () => {
    const mock = createMockResolver([new Error('main process boom'), SAMPLE_RESULT])
    installMockResolver(mock)

    // 屏蔽预期内的 console.error，避免污染测试输出；同时确认它被调用
    const originalError = console.error
    let errorLogged = 0
    console.error = (): void => {
      errorLogged += 1
    }
    try {
      const first = await resolveRawFileForAnchor(AVATAR_ID, VALID_ANCHOR)
      assert.equal(first, null)
      assert.equal(mock.callCount, 1)
      assert.equal(errorLogged, 1, '抛错路径必须 console.error 一次')

      const second = await resolveRawFileForAnchor(AVATAR_ID, VALID_ANCHOR)
      assert.deepEqual(second, SAMPLE_RESULT, '第二次应再次调用 IPC 并拿到正常结果')
      assert.equal(mock.callCount, 2, '抛错不应写缓存，下次仍走 IPC')
    } finally {
      console.error = originalError
    }
  })
})
