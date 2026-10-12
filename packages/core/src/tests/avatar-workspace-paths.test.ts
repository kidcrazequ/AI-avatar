/**
 * `resolveAvatarWorkspaceSessionRoot` 单元测试：与 WorkspaceManager 目录约定一致。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { resolveAvatarWorkspaceSessionRoot } from '../avatar-workspace-paths'

describe('resolveAvatarWorkspaceSessionRoot', () => {
  it('非 default 项目使用 workspaces/<project>/<conv>', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-ws-'))
    try {
      const avatars = path.join(root, 'avatars')
      const aid = 'a1'
      const cid = 'c1'
      const r = resolveAvatarWorkspaceSessionRoot(avatars, aid, 'proj-x', cid)
      assert.equal(r, path.join(avatars, aid, 'workspaces', 'proj-x', cid))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('default 且无历史扁平时使用 workspaces/default/<conv>', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-ws-'))
    try {
      const avatars = path.join(root, 'avatars')
      const aid = 'a1'
      const cid = 'c2'
      const r = resolveAvatarWorkspaceSessionRoot(avatars, aid, 'default', cid)
      assert.equal(r, path.join(avatars, aid, 'workspaces', 'default', cid))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('default 且存在历史 workspaces/<conv> 时优先扁平目录', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-ws-'))
    try {
      const avatars = path.join(root, 'avatars')
      const aid = 'a1'
      const cid = 'legacy-c'
      const legacy = path.join(avatars, aid, 'workspaces', cid)
      fs.mkdirSync(legacy, { recursive: true })
      const r = resolveAvatarWorkspaceSessionRoot(avatars, aid, 'default', cid)
      assert.equal(r, legacy)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
