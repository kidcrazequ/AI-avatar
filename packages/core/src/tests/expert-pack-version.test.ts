/**
 * 专家包版本比较 / 更新检测单测（借鉴 Pi 的整包版本钉）。
 *
 * 为什么这些测试存在（Rule 9）：版本比较错一处就会"该提示更新时不提示"或"反复误报更新"。
 * 重点覆盖数值段比较（1.10.0 > 1.9.9，必须 NOT 字典序）、缺位补 0、降级不报更新。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, evaluatePackUpdate } from '../expert-pack-version'

describe('compareVersions', () => {
  test('相等', () => {
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  })
  test('补位相等：1.2 == 1.2.0', () => {
    assert.equal(compareVersions('1.2', '1.2.0'), 0)
  })
  test('数值段比较而非字典序：1.10.0 > 1.9.9', () => {
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
    assert.equal(compareVersions('1.9.9', '1.10.0'), -1)
  })
  test('主版本优先：2.0.0 > 1.9.9', () => {
    assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
  })
  test('容错前缀 v 与非数字段', () => {
    assert.equal(compareVersions('v1.2.0', '1.2.0'), 0)
    assert.equal(compareVersions('1.2.x', '1.2.0'), 0)
  })
})

describe('evaluatePackUpdate', () => {
  test('更新可用：available 严格更新', () => {
    const r = evaluatePackUpdate('1.0.0', '1.1.0')
    assert.equal(r.hasUpdate, true)
    assert.equal(r.installedVersion, '1.0.0')
    assert.equal(r.availableVersion, '1.1.0')
  })
  test('版本相同：无更新', () => {
    assert.equal(evaluatePackUpdate('1.2.3', '1.2.3').hasUpdate, false)
  })
  test('已装的更新（用户手动降级了源）：不提示更新', () => {
    assert.equal(evaluatePackUpdate('2.0.0', '1.9.0').hasUpdate, false)
  })
})
