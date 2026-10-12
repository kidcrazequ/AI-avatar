/**
 * Avatar 会话工作区磁盘路径解析（与 {@link WorkspaceManager} 目录规则一致）。
 * 供 `@soul/core` 内 ToolRouter 与 Electron 侧共用，避免主进程与工具层路径分叉。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'fs'
import path from 'path'
import { DEFAULT_AVATAR_PROJECT_ID } from './avatar-project'
import { assertSafeSegment } from './utils/path-security'

/**
 * 解析会话工作区根目录：`avatars/<avatarId>/workspaces/<projectId>/<conversationId>/`。
 * 当 `projectId === default` 且历史上已存在扁平目录 `workspaces/<conversationId>/` 时，优先使用该路径以保持兼容。
 */
export function resolveAvatarWorkspaceSessionRoot(
  avatarsRoot: string,
  avatarId: string,
  projectId: string,
  conversationId: string,
): string {
  assertSafeSegment(avatarId, 'avatarId')
  assertSafeSegment(projectId, 'projectId')
  assertSafeSegment(conversationId, 'conversationId')
  const wsRoot = path.join(avatarsRoot, avatarId, 'workspaces')
  if (projectId === DEFAULT_AVATAR_PROJECT_ID) {
    const legacyFlat = path.join(wsRoot, conversationId)
    if (fs.existsSync(legacyFlat)) {
      return legacyFlat
    }
  }
  return path.join(wsRoot, projectId, conversationId)
}
