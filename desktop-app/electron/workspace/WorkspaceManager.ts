/**
 * Workspace 管理器：为每个 avatar / project / conversation 提供隔离工作区。
 *
 * 目录：`avatars/<avatarId>/workspaces/<projectId>/<conversationId>/`
 * 兼容：历史数据为扁平 `workspaces/<conversationId>/` 时，在 `projectId === default` 下仍解析到旧路径。
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import fs from 'fs'
import path from 'path'
import {
  assertSafeSegment,
  resolveUnderRoot,
  collectFilesRecursive,
  DEFAULT_MAX_DIR_DEPTH,
  DEFAULT_AVATAR_PROJECT_ID,
  resolveAvatarWorkspaceSessionRoot,
} from '@soul/core'

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

/** 按会话 ID 解析其所属 `project_id`（用于 `/projects/<conv>/` 跨会话路径）。 */
export type ConversationProjectResolver = (conversationId: string) => string

/**
 * 管理 `avatars/<avatarId>/workspaces/` 下的文件读写。
 */
export class WorkspaceManager {
  constructor(
    private readonly avatarsPath: string,
    private readonly resolveConversationProjectId: ConversationProjectResolver = () => DEFAULT_AVATAR_PROJECT_ID,
  ) {}

  getAvatarWorkspaceRoot(avatarId: string): string {
    assertSafeSegment(avatarId, 'avatarId')
    return path.join(this.avatarsPath, avatarId, 'workspaces')
  }

  /** 会话根目录；default 分区下优先使用历史扁平目录。 */
  getRoot(avatarId: string, projectId: string, conversationId: string): string {
    return resolveAvatarWorkspaceSessionRoot(this.avatarsPath, avatarId, projectId, conversationId)
  }

  ensure(avatarId: string, projectId: string, conversationId: string): string {
    const root = this.getRoot(avatarId, projectId, conversationId)
    fs.mkdirSync(root, { recursive: true })
    return root
  }

  /** 旧二参数：`ensure(a, default, conv)`（不再单独暴露变体，兼容测试可显式传 default）。 */

  resolveSafe(avatarId: string, projectId: string, conversationId: string, relPath: string): string {
    const root = this.ensure(avatarId, projectId, conversationId)
    const normalized = (relPath || '.').replace(/\\/g, '/')
    return resolveUnderRoot(root, normalized)
  }

  resolveCrossProjectPath(
    avatarId: string,
    currentProjectId: string,
    currentConversationId: string,
    rawPath: string,
  ): string {
    if (!rawPath.startsWith('/projects/')) {
      return this.resolveSafe(avatarId, currentProjectId, currentConversationId, rawPath)
    }
    const pieces = rawPath.split('/').filter(Boolean)
    if (pieces.length < 2) {
      throw new Error(`非法 projects 路径: ${rawPath}`)
    }
    const targetConversationId = pieces[1]
    assertSafeSegment(targetConversationId, 'conversationId')
    const targetProjectId = this.resolveConversationProjectId(targetConversationId)
    assertSafeSegment(targetProjectId, 'projectId')
    const targetRoot = this.ensure(avatarId, targetProjectId, targetConversationId)
    const rest = pieces.slice(2).join('/')
    return resolveUnderRoot(targetRoot, rest || '.')
  }

  readFile(avatarId: string, projectId: string, conversationId: string, relPath: string): string {
    const abs = this.resolveCrossProjectPath(avatarId, projectId, conversationId, relPath)
    return fs.readFileSync(abs, 'utf-8')
  }

  writeFile(avatarId: string, projectId: string, conversationId: string, relPath: string, content: string): string {
    const abs = this.resolveSafe(avatarId, projectId, conversationId, relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
    return abs
  }

  stat(avatarId: string, projectId: string, conversationId: string, relPath: string): WorkspaceListItem {
    const abs = this.resolveCrossProjectPath(avatarId, projectId, conversationId, relPath)
    const st = fs.statSync(abs)
    return {
      path: relPath,
      type: st.isDirectory() ? 'directory' : 'file',
      size: st.size,
      mtimeMs: st.mtimeMs,
    }
  }

  list(avatarId: string, projectId: string, conversationId: string, relPath = '.', depth = 1): WorkspaceListItem[] {
    const abs = this.resolveCrossProjectPath(avatarId, projectId, conversationId, relPath)
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

  copy(avatarId: string, projectId: string, conversationId: string, src: string, dest: string, move = false): void {
    const srcAbs = this.resolveCrossProjectPath(avatarId, projectId, conversationId, src)
    const destAbs = this.resolveSafe(avatarId, projectId, conversationId, dest)
    fs.mkdirSync(path.dirname(destAbs), { recursive: true })
    fs.cpSync(srcAbs, destAbs, { recursive: true, force: true })
    if (move) {
      fs.rmSync(srcAbs, { recursive: true, force: true })
    }
  }

  delete(avatarId: string, projectId: string, conversationId: string, relPath: string): void {
    const abs = this.resolveSafe(avatarId, projectId, conversationId, relPath)
    fs.rmSync(abs, { recursive: true, force: true })
  }

  grep(avatarId: string, projectId: string, conversationId: string, relPath: string, pattern: string): WorkspaceGrepResult[] {
    const abs = this.resolveCrossProjectPath(avatarId, projectId, conversationId, relPath)
    const regex = new RegExp(pattern, 'i')
    const files = fs.statSync(abs).isDirectory()
      ? collectFilesRecursive(abs, '', DEFAULT_MAX_DIR_DEPTH)
      : [abs]
    const hits: WorkspaceGrepResult[] = []
    const grepRoot = this.getRoot(avatarId, projectId, conversationId)
    for (const file of files) {
      if (!fs.statSync(file).isFile()) continue
      const text = fs.readFileSync(file, 'utf-8')
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          hits.push({
            file: path.relative(grepRoot, file).replace(/\\/g, '/'),
            line: i + 1,
            text: lines[i],
          })
        }
      }
    }
    return hits
  }
}
