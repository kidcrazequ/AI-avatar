/**
 * grey-zone-session-memory.test.ts — BR-3
 *
 * 为什么存在（Rule 9）：灰名单「始终允许」是会话级、内存态的——这条不变量是安全边界：
 * 不能跨会话泄漏（A 会话批准 exec_shell 不该让 B 会话免弹窗），也不能持久化成「永久放行」。
 * 本测试把这两条钉死，防后续改成全局/持久后无声地扩大高风险工具的免确认面。
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test ../packages/core/src/tests/grey-zone-session-memory.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isGreyZoneSessionAllowed,
  rememberGreyZoneSessionAllow,
  clearGreyZoneSessionMemory,
  type GreyZoneSessionMemory,
} from '../tool-permission-policy'

test('默认未记住 → 需要确认；记住后 → 免确认', () => {
  const mem: GreyZoneSessionMemory = new Map()
  assert.strictEqual(isGreyZoneSessionAllowed(mem, 'conv1', 'exec_shell'), false)
  rememberGreyZoneSessionAllow(mem, 'conv1', 'exec_shell')
  assert.strictEqual(isGreyZoneSessionAllowed(mem, 'conv1', 'exec_shell'), true)
})

test('会话隔离：A 会话记住不影响 B 会话（安全边界）', () => {
  const mem: GreyZoneSessionMemory = new Map()
  rememberGreyZoneSessionAllow(mem, 'convA', 'exec_shell')
  assert.strictEqual(isGreyZoneSessionAllowed(mem, 'convA', 'exec_shell'), true)
  assert.strictEqual(isGreyZoneSessionAllowed(mem, 'convB', 'exec_shell'), false) // B 仍需确认
})

test('工具隔离：记住 exec_shell 不等于记住 write_file', () => {
  const mem: GreyZoneSessionMemory = new Map()
  rememberGreyZoneSessionAllow(mem, 'conv1', 'exec_shell')
  assert.strictEqual(isGreyZoneSessionAllowed(mem, 'conv1', 'write_file'), false)
})

test('清理：删除会话后记忆清空，同名会话重新需要确认', () => {
  const mem: GreyZoneSessionMemory = new Map()
  rememberGreyZoneSessionAllow(mem, 'conv1', 'exec_shell')
  clearGreyZoneSessionMemory(mem, 'conv1')
  assert.strictEqual(isGreyZoneSessionAllowed(mem, 'conv1', 'exec_shell'), false)
  assert.strictEqual(mem.has('conv1'), false)
})
