/**
 * WorkspaceManager 单测。
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceManager } from './WorkspaceManager'

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soul-workspace-test-'))
}

test('WorkspaceManager: 路径穿越应被拒绝', () => {
  const root = makeTempRoot()
  const mgr = new WorkspaceManager(root)
  assert.throws(() => {
    mgr.resolveSafe('avatar-a', 'conv-a', '../evil.txt')
  })
})

test('WorkspaceManager: 同 avatar 跨项目路径可读', () => {
  const root = makeTempRoot()
  const mgr = new WorkspaceManager(root)
  const abs = mgr.writeFile('avatar-a', 'conv-a', 'demo.txt', 'hello')
  assert.equal(fs.existsSync(abs), true)

  const fromOtherConv = mgr.readFile('avatar-a', 'conv-b', '/projects/conv-a/demo.txt')
  assert.equal(fromOtherConv, 'hello')
})

