/**
 * Palace 文件协议路径解析。
 *
 * 公开函数只返回安全绝对路径，不做 IO。
 */

import path from 'path'

import { assertSafeSegment, resolveUnderRoot } from '../utils/path-security'
import {
  PALACE_COMMITMENTS_FILE,
  PALACE_COMMITMENTS_MD_FILE,
  PALACE_COMPANY_FILE,
  PALACE_DIRECTORIES,
  PALACE_INBOX_FILE,
  PALACE_INBOX_MD_FILE,
  PALACE_INDEX_FILE,
  PALACE_MANIFEST_FILE,
  PALACE_PROFILE_FILE,
  PALACE_ROOT_DIR,
  type PalaceDirectory,
} from './types'

const PALACE_DIRECTORY_SET = new Set<string>(PALACE_DIRECTORIES)

export function isPalaceDirectory(value: string): value is PalaceDirectory {
  return PALACE_DIRECTORY_SET.has(value)
}

export function assertSafePalaceId(value: string, label: string): void {
  assertSafeSegment(value, label)
  if (value.startsWith('.')) {
    throw new Error(`非法${label}，不能以 . 开头: ${value}`)
  }
  if (value.includes('.')) {
    throw new Error(`非法${label}，不能包含点号或扩展名: ${value}`)
  }
}

export function getPalaceDir(avatarsRoot: string, avatarId: string): string {
  assertSafeSegment(avatarId, '分身ID')
  return resolveUnderRoot(avatarsRoot, path.join(avatarId, PALACE_ROOT_DIR))
}

export function getPalaceManifestPath(avatarsRoot: string, avatarId: string): string {
  return path.join(getPalaceDir(avatarsRoot, avatarId), PALACE_MANIFEST_FILE)
}

export function getPalaceProfilePath(avatarsRoot: string, avatarId: string): string {
  return path.join(getPalaceDir(avatarsRoot, avatarId), PALACE_PROFILE_FILE)
}

export function getPalaceCompanyPath(avatarsRoot: string, avatarId: string): string {
  return path.join(getPalaceDir(avatarsRoot, avatarId), PALACE_COMPANY_FILE)
}

export function getPalaceCommitmentsPath(avatarsRoot: string, avatarId: string): string {
  return path.join(getPalaceDir(avatarsRoot, avatarId), PALACE_COMMITMENTS_FILE)
}

export function getPalaceCommitmentsMarkdownPath(avatarsRoot: string, avatarId: string): string {
  return path.join(getPalaceDir(avatarsRoot, avatarId), PALACE_COMMITMENTS_MD_FILE)
}

export function getPalaceIndexPath(avatarsRoot: string, avatarId: string): string {
  return path.join(getPalaceDir(avatarsRoot, avatarId), PALACE_INDEX_FILE)
}

export function getPalaceDirectoryPath(
  avatarsRoot: string,
  avatarId: string,
  directory: PalaceDirectory,
): string {
  if (!isPalaceDirectory(directory)) {
    throw new Error(`未知 Palace 目录: ${directory}`)
  }
  return path.join(getPalaceDir(avatarsRoot, avatarId), directory)
}

export function getPalaceRoomsDir(avatarsRoot: string, avatarId: string): string {
  return getPalaceDirectoryPath(avatarsRoot, avatarId, 'rooms')
}

/**
 * 解析 palace/<dir>/<fileName> 的安全路径。只允许 .md，禁止路径穿越和隐藏文件。
 */
export function getPalaceDirectoryFilePath(
  avatarsRoot: string,
  avatarId: string,
  directory: PalaceDirectory,
  fileName: string,
): string {
  const dirPath = getPalaceDirectoryPath(avatarsRoot, avatarId, directory)
  assertSafeSegment(fileName, '文件名')
  if (fileName.startsWith('.')) {
    throw new Error(`非法文件名，不能以 . 开头: ${fileName}`)
  }
  if (!/\.md$/i.test(fileName)) {
    throw new Error(`Palace 资料只支持 .md 文件: ${fileName}`)
  }
  return path.join(dirPath, fileName)
}

export function getPalaceRoomPath(
  avatarsRoot: string,
  avatarId: string,
  roomId: string,
): string {
  assertSafePalaceId(roomId, '路线卡ID')
  return path.join(getPalaceRoomsDir(avatarsRoot, avatarId), `${roomId}.md`)
}

export function getPalaceInboxDir(avatarsRoot: string, avatarId: string): string {
  return getPalaceDirectoryPath(avatarsRoot, avatarId, 'inbox')
}

export function getPalaceInboxPath(avatarsRoot: string, avatarId: string): string {
  return path.join(getPalaceInboxDir(avatarsRoot, avatarId), PALACE_INBOX_FILE)
}

export function getPalaceInboxMarkdownPath(avatarsRoot: string, avatarId: string): string {
  return path.join(getPalaceInboxDir(avatarsRoot, avatarId), PALACE_INBOX_MD_FILE)
}
