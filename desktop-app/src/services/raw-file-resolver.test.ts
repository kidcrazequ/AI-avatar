/**
 * raw-file-resolver.test.ts — 两个核心 API 的单测：
 *   组 1: extractMdPathsFromAnchor（提取阶段，9 个用例覆盖单/多文件/全半角/子目录/排除 _excel/ 去重/空/混合）
 *   组 2: resolveRawFile（解析阶段，4 个用例覆盖缓存/IPC 注入/null/抛错）
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test src/services/raw-file-resolver.test.ts
 *
 * @author zhi.qu
 * @date 2026-05-06
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { extractMdPathsFromAnchor, resolveRawFile, clearRawFileCache } from './raw-file-resolver'
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
 * - `behavior` 可以是固定返回值，也可以是按调用顺序消费的数组（每次取下一个），或一个函数
 */
function createMockResolver(
  behavior:
    | ResolveRawFileResult
    | null
    | Array<ResolveRawFileResult | null | Error>
    | (() => ResolveRawFileResult | null),
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
 * 传 undefined 表示移除整个 electronAPI（用于"未注入"用例）。
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

  // ════════════════════════════════════════════════════════════════════════
  // 组 1：extractMdPathsFromAnchor（纯函数，不 mock IPC）
  // ════════════════════════════════════════════════════════════════════════
  describe('extractMdPathsFromAnchor', () => {
    // ─── 用例 1.1：单文件 anchor ───────────────────────────────────────────
    it('单文件 anchor → 返回单一 .md 路径', () => {
      const anchor = '[来源: knowledge/foo.md#L1-L5]'
      assert.deepEqual(extractMdPathsFromAnchor(anchor), ['foo.md'])
    })

    // ─── 用例 1.2：多文件 anchor（半角逗号分隔）─────────────────────────
    it('多文件 anchor（半角逗号分隔）→ 按出现顺序返回', () => {
      const anchor = '[来源: knowledge/a.md, knowledge/b.md#第7页]'
      assert.deepEqual(extractMdPathsFromAnchor(anchor), ['a.md', 'b.md'])
    })

    // ─── 用例 1.3：多文件 anchor（全角逗号分隔）─────────────────────────
    it('多文件 anchor（全角逗号分隔）→ 按出现顺序返回', () => {
      const anchor = '[来源: knowledge/a.md，knowledge/b.md]'
      assert.deepEqual(extractMdPathsFromAnchor(anchor), ['a.md', 'b.md'])
    })

    // ─── 用例 1.4：章节名后缀 ───────────────────────────────────────────
    it('章节名后缀（#2. 设备布局图）→ 提取 .md 文件名忽略后缀', () => {
      const anchor = '[来源: knowledge/ENS-L262-01用户手册_-V1.md#2. 设备布局图]'
      assert.deepEqual(extractMdPathsFromAnchor(anchor), ['ENS-L262-01用户手册_-V1.md'])
    })

    // ─── 用例 1.5：子目录路径 ───────────────────────────────────────────
    it('子目录路径（#section=技术参数）→ 完整保留子目录前缀', () => {
      const anchor = '[来源: knowledge/sub/foo.md#section=技术参数]'
      assert.deepEqual(extractMdPathsFromAnchor(anchor), ['sub/foo.md'])
    })

    // ─── 用例 1.6：排除 _excel/ 路径 ────────────────────────────────────
    it('排除 _excel/ 路径 → Excel JSON 不被提取，只留下普通 .md', () => {
      const anchor = '[来源: knowledge/_excel/x.json#sheet=A&rows=2-5, knowledge/foo.md]'
      assert.deepEqual(extractMdPathsFromAnchor(anchor), ['foo.md'])
    })

    // ─── 用例 1.7：去重 ────────────────────────────────────────────────
    it('同一路径多次出现 → 去重，只返回一次', () => {
      const anchor = '[来源: knowledge/a.md#L1, knowledge/a.md#L20]'
      assert.deepEqual(extractMdPathsFromAnchor(anchor), ['a.md'])
    })

    // ─── 用例 1.8：完全没有 .md 命中 ────────────────────────────────────
    it('没有任何 .md 命中 → 返回空数组', () => {
      const anchor = '[来源: 见 Excel]'
      assert.deepEqual(extractMdPathsFromAnchor(anchor), [])
    })

    // ─── 用例 1.9：混合无关文本 ─────────────────────────────────────────
    it('正文中混入 anchor 块 → 仍能全局扫描提取出 .md 路径', () => {
      const text = '这是正文 [来源: knowledge/foo.md] 后续'
      assert.deepEqual(extractMdPathsFromAnchor(text), ['foo.md'])
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  // 组 2：resolveRawFile（IPC 解析 + LRU 缓存）
  // ════════════════════════════════════════════════════════════════════════
  describe('resolveRawFile', () => {
    // ─── 用例 2.1：正常路径 + 缓存命中 ─────────────────────────────────
    it('正常路径 → 走 IPC 拿到结果，第二次同 key 命中缓存不再调 IPC', async () => {
      const mock = createMockResolver(SAMPLE_RESULT)
      installMockResolver(mock)

      const first = await resolveRawFile(AVATAR_ID, VALID_MD_PATH)
      assert.deepEqual(first, SAMPLE_RESULT)
      assert.equal(mock.callCount, 1)
      assert.deepEqual(mock.calls[0], { avatarId: AVATAR_ID, mdRelativePath: VALID_MD_PATH })

      const second = await resolveRawFile(AVATAR_ID, VALID_MD_PATH)
      assert.deepEqual(second, SAMPLE_RESULT)
      assert.equal(mock.callCount, 1, '相同入参第二次应命中缓存，不再调 IPC')
    })

    // ─── 用例 2.2：window.electronAPI 未注入 ──────────────────────────
    it('window.electronAPI.resolveRawFile 未注入时返回 null，不抛错', async () => {
      installMockResolver(undefined)

      const result = await resolveRawFile(AVATAR_ID, VALID_MD_PATH)

      assert.equal(result, null)
    })

    // ─── 用例 2.3：主进程返回 null 也写缓存 ──────────────────────────
    it('主进程返回 null 也写缓存（二次调用不再调 IPC）', async () => {
      const mock = createMockResolver(null)
      installMockResolver(mock)

      const first = await resolveRawFile(AVATAR_ID, VALID_MD_PATH)
      assert.equal(first, null)
      assert.equal(mock.callCount, 1)

      const second = await resolveRawFile(AVATAR_ID, VALID_MD_PATH)
      assert.equal(second, null)
      assert.equal(mock.callCount, 1, 'null 结果也应进入缓存，避免重复 IPC')
    })

    // ─── 用例 2.4：主进程抛错返回 null 且不写缓存 ──────────────────────
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
        const first = await resolveRawFile(AVATAR_ID, VALID_MD_PATH)
        assert.equal(first, null)
        assert.equal(mock.callCount, 1)
        assert.equal(errorLogged, 1, '抛错路径必须 console.error 一次')

        const second = await resolveRawFile(AVATAR_ID, VALID_MD_PATH)
        assert.deepEqual(second, SAMPLE_RESULT, '第二次应再次调用 IPC 并拿到正常结果')
        assert.equal(mock.callCount, 2, '抛错不应写缓存，下次仍走 IPC')
      } finally {
        console.error = originalError
      }
    })
  })
})
