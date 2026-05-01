/**
 * Workspace 管理器：为每个 avatar/conversation 提供隔离工作区。
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import fs from 'fs'
import path from 'path'
import { assertSafeSegment, resolveUnderRoot, collectFilesRecursive, DEFAULT_MAX_DIR_DEPTH } from '@soul/core'

export interface WorkspaceListItem {
  path: string
  type: 'file' | 'directory'
  size: number
  mtimeMs: number
}

export interface WorkspaceGrepResult {
  file: string
  line: number
  text: string
}

/**
 * 管理 `avatars/<avatarId>/workspaces/<convId>/` 下的文件读写。
 * 跨项目路径语义：`/projects/<convId>/<path>`，仅允许同 avatar。
 */
export class WorkspaceManager {
  constructor(private readonly avatarsPath: string) {}

  getAvatarWorkspaceRoot(avatarId: string): string {
    assertSafeSegment(avatarId, 'avatarId')
    return path.join(this.avatarsPath, avatarId, 'workspaces')
  }

  getRoot(avatarId: string, conversationId: string): string {
    assertSafeSegment(avatarId, 'avatarId')
    assertSafeSegment(conversationId, 'conversationId')
    return path.join(this.getAvatarWorkspaceRoot(avatarId), conversationId)
  }

  ensure(avatarId: string, conversationId: string): string {
    const root = this.getRoot(avatarId, conversationId)
    fs.mkdirSync(root, { recursive: true })
    return root
  }

  resolveSafe(avatarId: string, conversationId: string, relPath: string): string {
    const root = this.ensure(avatarId, conversationId)
    const normalized = (relPath || '.').replace(/\\/g, '/')
    return resolveUnderRoot(root, normalized)
  }

  /**
   * 解析 /projects/<convId>/<file>。只允许同 avatar，天然不跨 avatar。
   */
  resolveCrossProjectPath(avatarId: string, currentConversationId: string, rawPath: string): string {
    if (!rawPath.startsWith('/projects/')) {
      return this.resolveSafe(avatarId, currentConversationId, rawPath)
    }
    const pieces = rawPath.split('/').filter(Boolean)
    if (pieces.length < 2) {
      throw new Error(`非法 projects 路径: ${rawPath}`)
    }
    const targetConversationId = pieces[1]
    assertSafeSegment(targetConversationId, 'conversationId')
    const targetRoot = this.ensure(avatarId, targetConversationId)
    const rest = pieces.slice(2).join('/')
    return resolveUnderRoot(targetRoot, rest || '.')
  }

  readFile(avatarId: string, conversationId: string, relPath: string): string {
    const abs = this.resolveCrossProjectPath(avatarId, conversationId, relPath)
    return fs.readFileSync(abs, 'utf-8')
  }

  writeFile(avatarId: string, conversationId: string, relPath: string, content: string): string {
    const abs = this.resolveSafe(avatarId, conversationId, relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
    return abs
  }

  stat(avatarId: string, conversationId: string, relPath: string): WorkspaceListItem {
    const abs = this.resolveCrossProjectPath(avatarId, conversationId, relPath)
    const st = fs.statSync(abs)
    return {
      path: relPath,
      type: st.isDirectory() ? 'directory' : 'file',
      size: st.size,
      mtimeMs: st.mtimeMs,
    }
  }

  list(avatarId: string, conversationId: string, relPath = '.', depth = 1): WorkspaceListItem[] {
    const abs = this.resolveCrossProjectPath(avatarId, conversationId, relPath)
    const out: WorkspaceListItem[] = []
    const walk = (current: string, remain: number): void => {
      const entries = fs.readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        const st = fs.statSync(full)
        const rel = path.relative(abs, full).replace(/\\/g, '/')
        out.push({
          path: rel,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: st.size,
          mtimeMs: st.mtimeMs,
        })
        if (entry.isDirectory() && remain > 1) {
          walk(full, remain - 1)
        }
      }
    }
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      walk(abs, Math.max(1, depth))
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  copy(avatarId: string, conversationId: string, src: string, dest: string, move = false): void {
    const srcAbs = this.resolveCrossProjectPath(avatarId, conversationId, src)
    const destAbs = this.resolveSafe(avatarId, conversationId, dest)
    fs.mkdirSync(path.dirname(destAbs), { recursive: true })
    fs.cpSync(srcAbs, destAbs, { recursive: true, force: true })
    if (move) {
      fs.rmSync(srcAbs, { recursive: true, force: true })
    }
  }

  delete(avatarId: string, conversationId: string, relPath: string): void {
    const abs = this.resolveSafe(avatarId, conversationId, relPath)
    fs.rmSync(abs, { recursive: true, force: true })
  }

  grep(avatarId: string, conversationId: string, relPath: string, pattern: string): WorkspaceGrepResult[] {
    const abs = this.resolveCrossProjectPath(avatarId, conversationId, relPath)
    const regex = new RegExp(pattern, 'i')
    const files = fs.statSync(abs).isDirectory()
      ? collectFilesRecursive(abs, '', DEFAULT_MAX_DIR_DEPTH)
      : [abs]
    const hits: WorkspaceGrepResult[] = []
    for (const file of files) {
      if (!fs.statSync(file).isFile()) continue
      const text = fs.readFileSync(file, 'utf-8')
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          hits.push({
            file: path.relative(this.getRoot(avatarId, conversationId), file).replace(/\\/g, '/'),
            line: i + 1,
            text: lines[i],
          })
        }
      }
    }
    return hits
  }
}

