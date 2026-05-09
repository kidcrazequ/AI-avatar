/**
 * Encrypted credential store for Soul WebDAV sync (#16).
 *
 * Uses Electron `safeStorage`:
 *  - macOS: Keychain
 *  - Windows: DPAPI
 *  - Linux: gnome-libsecret / kwallet (or basic_text fallback when no keyring)
 *
 * Settings key: `webdav_password_encrypted` (base64 of safeStorage ciphertext)
 *
 * 设计要点：
 *  - 与 GitHubConnector 同一套加密策略（safeStorage.encryptString → base64 入库）
 *  - 不直接读写 settings 表，由调用方决定 key 名（webdav_password_encrypted）
 *  - 解密失败时由上层决定如何兜底（清空 / 提示重输），不在本模块吞错
 *  - 暴露 backend 信息让设置 UI 在 Linux basic_text 场景给出安全警告
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { safeStorage } from 'electron'

/**
 * 推荐使用的 settings key 名（调用方应使用此常量）。
 *
 * 与 v11 settings 表共存，存的是 base64(safeStorage.encryptString(plain))。
 */
export const WEBDAV_PASSWORD_SETTING_KEY = 'webdav_password_encrypted'

/**
 * 当前进程 safeStorage 是否可用。
 *
 * 不可用时调用 encryptPassword 会抛错；调用方应该在 UI 层做提示
 * （例如 Linux 缺少 keyring 时引导用户安装 libsecret 或继续使用 basic_text）。
 */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * 当前 safeStorage 使用的后端标识。
 *
 * 已知值：
 *  - 'unknown'（加密不可用）
 *  - 'basic_text'（Linux 无 keyring 时的明文回退，**不安全**）
 *  - 'gnome_libsecret' / 'kwallet5' 等（Linux 真正的 keyring）
 *  - macOS / Windows 由系统接管，会返回 'keychain' / 'dpapi' 之类
 */
export function getSelectedStorageBackend(): string {
  // safeStorage.getSelectedStorageBackend 仅在 Linux 上有意义；
  // macOS / Windows 上返回 'unknown' 但加密仍然可用。
  try {
    return safeStorage.getSelectedStorageBackend()
  } catch (err) {
    // 极少数场景（如未初始化的早期进程）会抛错，不影响主链路
    void err
    return 'unknown'
  }
}

/**
 * 加密密码并返回 base64 字符串，便于直接写入 settings 表。
 *
 * 加密不可用时抛 Error，调用方需要在 UI 层捕获并提示用户。
 * 空字符串会原样返回（兼容用户清空密码的场景）。
 */
export function encryptPassword(plain: string): string {
  if (plain === '') return ''
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage 加密不可用，无法安全存储 WebDAV 密码（请确认操作系统 keyring 是否就绪）')
  }
  const cipher = safeStorage.encryptString(plain)
  return cipher.toString('base64')
}

/**
 * 解密 base64 后的密文。
 *
 * 空串原样返回（兼容尚未填写密码的旧记录）。
 * 解密失败时抛 Error（消息含具体原因），调用方决定是否清空 setting 并提示重新输入。
 */
export function decryptPassword(encryptedBase64: string): string {
  if (!encryptedBase64) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage 解密不可用，无法读取 WebDAV 密码')
  }
  try {
    const buf = Buffer.from(encryptedBase64, 'base64')
    return safeStorage.decryptString(buf)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`WebDAV 密码解密失败（可能更换了设备或 keyring 失效）：${reason}`)
  }
}

/**
 * 提供给设置 UI 的「后端展示信息」。
 *
 * - secure=false 表示当前后端在该平台上属于不安全回退（例如 Linux basic_text），
 *   建议 UI 显示醒目提示并允许用户继续保存。
 * - hint 为空串表示没有特殊提示。
 */
export function getStorageBackendDisplay(): {
  backend: string
  secure: boolean
  hint: string
} {
  const backend = getSelectedStorageBackend()
  const available = isEncryptionAvailable()

  if (!available) {
    return {
      backend,
      secure: false,
      hint: 'safeStorage 加密当前不可用，密码无法落库；请确认 keyring 服务是否运行后重启应用。',
    }
  }

  // Linux basic_text 是 Electron 在没有 keyring 的环境下的明文回退，
  // 文档明确标注「会以明文写入 ~/.config」，必须告知用户。
  if (backend === 'basic_text') {
    return {
      backend,
      secure: false,
      hint: '当前 Linux 系统未启用安全 keyring（gnome-libsecret / kwallet），密码将以明文写入磁盘。建议安装 libsecret-tools 后重启应用。',
    }
  }

  return { backend, secure: true, hint: '' }
}
