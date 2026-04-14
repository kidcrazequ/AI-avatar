/**
 * chunk-cache.ts 单元测试
 *
 * 覆盖：
 *   - 保存 + 加载 round-trip
 *   - 文件不存在返回 null
 *   - 损坏 JSON 静默 fallback 返回 null（不抛）
 *   - 类型不合法的项被跳过，合法项保留
 *   - 原子写入：tmp 文件不残留
 *   - 自动创建 _index 目录
 *
 * 运行方式：
 *   cd packages/core && npm run build
 *   node --test dist/tests/chunk-cache.test.js
 *
 * @author zhi.qu
 * @date 2026-04-14
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadTokensCache, saveTokensCache, TOKENS_FILE } from '../utils/chunk-cache'

/** 创建一个临时测试目录，用完 try/finally 删除 */
function withTempDir(body: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-cache-test-'))
  try {
    body(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('chunk-cache', () => {
  it('saveTokensCache → loadTokensCache 完整 round-trip', () => {
    withTempDir((dir) => {
      const tokens = new Map<string, string[]>([
        ['file1.md::heading1', ['token1', 'token2', 'token3']],
        ['file2.md::heading2', ['你好', '世界']],
        ['file3.md::heading3', []],
      ])
      saveTokensCache(dir, tokens)
      const loaded = loadTokensCache(dir)
      assert.ok(loaded)
      assert.equal(loaded.size, 3)
      assert.deepEqual(loaded.get('file1.md::heading1'), ['token1', 'token2', 'token3'])
      assert.deepEqual(loaded.get('file2.md::heading2'), ['你好', '世界'])
      assert.deepEqual(loaded.get('file3.md::heading3'), [])
    })
  })

  it('文件不存在返回 null', () => {
    withTempDir((dir) => {
      const loaded = loadTokensCache(dir)
      assert.equal(loaded, null)
    })
  })

  it('损坏 JSON 返回 null 而不抛错', () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, TOKENS_FILE), '{not valid json')
      const loaded = loadTokensCache(dir)
      assert.equal(loaded, null)
    })
  })

  it('类型不合法的项被跳过，合法项保留', () => {
    withTempDir((dir) => {
      // 手工构造一个混合 valid/invalid 的 JSON
      const obj = {
        valid1: ['a', 'b'],
        invalid1: 'not an array',
        invalid2: [1, 2, 3],         // numbers not strings
        invalid3: ['ok', 99, 'bad'], // mixed
        valid2: ['c'],
        invalid4: null,
      }
      fs.writeFileSync(path.join(dir, TOKENS_FILE), JSON.stringify(obj))
      const loaded = loadTokensCache(dir)
      assert.ok(loaded)
      assert.equal(loaded.size, 2)
      assert.deepEqual(loaded.get('valid1'), ['a', 'b'])
      assert.deepEqual(loaded.get('valid2'), ['c'])
      assert.equal(loaded.has('invalid1'), false)
      assert.equal(loaded.has('invalid2'), false)
      assert.equal(loaded.has('invalid3'), false)
      assert.equal(loaded.has('invalid4'), false)
    })
  })

  it('saveTokensCache 不残留 .tmp 文件', () => {
    withTempDir((dir) => {
      saveTokensCache(dir, new Map([['k', ['v']]]))
      const files = fs.readdirSync(dir)
      const tmpFiles = files.filter(f => f.includes('.tmp'))
      assert.equal(tmpFiles.length, 0, `不应该有 .tmp 文件，实际: ${tmpFiles.join(', ')}`)
      assert.ok(files.includes(TOKENS_FILE))
    })
  })

  it('saveTokensCache 自动创建不存在的 _index 目录', () => {
    withTempDir((parent) => {
      const indexDir = path.join(parent, '_index')
      assert.equal(fs.existsSync(indexDir), false)
      saveTokensCache(indexDir, new Map([['k', ['v']]]))
      assert.equal(fs.existsSync(indexDir), true)
      assert.equal(fs.existsSync(path.join(indexDir, TOKENS_FILE)), true)
    })
  })

  it('saveTokensCache 覆盖已存在的 tokens.json', () => {
    withTempDir((dir) => {
      saveTokensCache(dir, new Map([['old', ['x']]]))
      saveTokensCache(dir, new Map([['new', ['y', 'z']]]))
      const loaded = loadTokensCache(dir)
      assert.ok(loaded)
      assert.equal(loaded.size, 1)
      assert.deepEqual(loaded.get('new'), ['y', 'z'])
      assert.equal(loaded.has('old'), false)
    })
  })

  it('空 Map 也能保存和加载', () => {
    withTempDir((dir) => {
      saveTokensCache(dir, new Map())
      const loaded = loadTokensCache(dir)
      assert.ok(loaded)
      assert.equal(loaded.size, 0)
    })
  })
})
