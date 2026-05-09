/**
 * Tests for credential-store (#16 WebDAV cross-device sync · 子任务 6) — safeStorage mock 往返。
 *
 * 验证点（共 6 条用例）：
 *   1. encryptPassword + decryptPassword 完整往返：明文 → 密文 → 还原一致
 *   2. encryptPassword('') 返回 ''（空串短路，不调用 safeStorage）
 *   3. decryptPassword('') 返回 ''（空串短路）
 *   4. encryptPassword 在 isEncryptionAvailable=false 时抛错
 *   5. getStorageBackendDisplay：mock backend='mock-keychain' → secure=true / hint=''
 *   6. getStorageBackendDisplay：mock backend='basic_text' → secure=false + hint 含中文「明文」/「不安全」
 *
 * 设计：
 *   - 测试运行在普通 node 进程下（无 Electron app），safeStorage 真实模块不可用 → 必须 mock
 *   - 用 require.cache 注入 fake `electron` module（与 database-embeds-migration.test.ts 同款方案）
 *   - mock 策略「方案 A」：仅在测试 setup 注入，不修改主代码
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── Electron safeStorage mock 注入 ──────────────────────────────────────────

/** 可变 mock 状态，便于不同用例切换 backend / available */
interface MockState {
  available: boolean
  backend: string
}
const mockState: MockState = {
  available: true,
  backend: 'mock-keychain',
}

const fakeSafeStorage = {
  isEncryptionAvailable: (): boolean => mockState.available,
  encryptString: (plain: string): Buffer => Buffer.from(`ENC:${plain}`, 'utf-8'),
  decryptString: (cipher: Buffer): string => {
    const s = cipher.toString('utf-8')
    if (!s.startsWith('ENC:')) {
      throw new Error('mock decrypt: bad cipher prefix')
    }
    return s.slice(4)
  },
  getSelectedStorageBackend: (): string => mockState.backend,
}

const electronStubExports = {
  safeStorage: fakeSafeStorage,
}

const electronResolvedId = (() => {
  try {
    return require.resolve('electron')
  } catch {
    return 'electron'
  }
})()
require.cache[electronResolvedId] = {
  id: electronResolvedId,
  filename: electronResolvedId,
  loaded: true,
  exports: electronStubExports,
  parent: null,
  children: [],
  paths: [],
} as unknown as NodeJS.Module

// 在 mock 之后再 require credential-store，确保模块内部 import 'electron' 命中 fake
// eslint-disable-next-line @typescript-eslint/no-require-imports
const credentialStore = require('./credential-store') as typeof import('./credential-store')

// ─── 用例 ────────────────────────────────────────────────────────────────────

test('credential-store: encryptPassword + decryptPassword 完整往返', () => {
  mockState.available = true
  mockState.backend = 'mock-keychain'

  const plain = 'hunter2!@#$%^&*()'
  const cipher = credentialStore.encryptPassword(plain)
  assert.ok(cipher.length > 0, '密文不应为空')
  // base64 字符集
  assert.match(cipher, /^[A-Za-z0-9+/=]+$/)

  const decrypted = credentialStore.decryptPassword(cipher)
  assert.equal(decrypted, plain)
})

test('credential-store: encryptPassword(\'\') 返回 \'\'（空串短路）', () => {
  mockState.available = true
  // 即使 backend 不可用，空串也应直接返回，不报错
  mockState.backend = 'basic_text'
  assert.equal(credentialStore.encryptPassword(''), '')
})

test('credential-store: decryptPassword(\'\') 返回 \'\'', () => {
  mockState.available = true
  mockState.backend = 'mock-keychain'
  assert.equal(credentialStore.decryptPassword(''), '')
})

test('credential-store: encryptPassword 不可用时抛错', () => {
  mockState.available = false
  assert.throws(() => credentialStore.encryptPassword('any-plain'), /safeStorage/i)
  // 恢复
  mockState.available = true
})

test('credential-store: getStorageBackendDisplay mock-keychain → secure=true', () => {
  mockState.available = true
  mockState.backend = 'mock-keychain'
  const d = credentialStore.getStorageBackendDisplay()
  assert.equal(d.backend, 'mock-keychain')
  assert.equal(d.secure, true)
  assert.equal(d.hint, '')
})

test('credential-store: getStorageBackendDisplay basic_text → secure=false + 含「明文」', () => {
  mockState.available = true
  mockState.backend = 'basic_text'
  const d = credentialStore.getStorageBackendDisplay()
  assert.equal(d.backend, 'basic_text')
  assert.equal(d.secure, false)
  assert.match(d.hint, /明文|不安全|libsecret|keyring/i, `hint 应给出安全提示，实际：${d.hint}`)
})

test('credential-store: WEBDAV_PASSWORD_SETTING_KEY 常量稳定', () => {
  // 防止常量被无意改名导致 settings 表 key 漂移（与 sync-manager 内部 SETTING_KEYS.password 对齐）
  assert.equal(credentialStore.WEBDAV_PASSWORD_SETTING_KEY, 'webdav_password_encrypted')
})
