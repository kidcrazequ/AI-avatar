/**
 * GitHub Connector：list_repos / get_tree / read_file / import_files。
 *
 * - PAT 用 Electron safeStorage 加密后写入 settings 表（key=github_pat_encrypted）。
 *   safeStorage 在 macOS 走 keychain、Windows 走 DPAPI、Linux 走 libsecret，
 *   解密失败时（如换机器或 keychain 无效）静默清空让用户重新输入。
 * - 所有 API 调用走 Octokit @octokit/rest。
 * - 速率限制：依赖 Octokit 自带 rate-limit 处理，超 30 次/分钟会报错让 LLM 自然降级。
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import { Octokit } from '@octokit/rest'
import { safeStorage } from 'electron'
import type { DatabaseManager } from '../database'
import type { WorkspaceManager } from '../workspace/WorkspaceManager'
import path from 'path'
import fs from 'fs'

const PAT_SETTING_KEY = 'github_pat_encrypted'
const PAT_LOGIN_KEY = 'github_login'

export interface GitHubRepoInfo {
  owner: string
  name: string
  fullName: string
  private: boolean
  description: string | null
  defaultBranch: string
  updatedAt: string
}

export interface GitHubTreeEntry {
  path: string
  type: 'blob' | 'tree' | 'commit'
  size?: number
  sha: string
}

export interface ImportFileSpec {
  /** 仓库内路径，如 'src/Button.tsx' */
  path: string
  /** workspace 内的目标路径，缺省时使用源 path */
  saveAs?: string
}

export class GitHubConnector {
  private cachedClient: Octokit | null = null
  private cachedToken: string | null = null

  constructor(
    private readonly db: DatabaseManager,
    private readonly workspaceManager: WorkspaceManager,
  ) {}

  /**
   * 保存 PAT。会做一次 user 验证，确认 token 有效后才落库。
   * 返回 GitHub 用户名。
   */
  async connect(token: string): Promise<{ login: string }> {
    if (!token || typeof token !== 'string' || token.length < 10) {
      throw new Error('PAT 不能为空且长度需 ≥ 10')
    }
    const oct = new Octokit({ auth: token, userAgent: 'soul-desktop' })
    const { data } = await oct.rest.users.getAuthenticated()
    if (!data.login) throw new Error('PAT 校验失败：未能获取 GitHub 用户名')

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage 加密不可用，无法安全存储 PAT')
    }
    const encrypted = safeStorage.encryptString(token).toString('base64')
    this.db.setSetting(PAT_SETTING_KEY, encrypted)
    this.db.setSetting(PAT_LOGIN_KEY, data.login)
    this.cachedClient = oct
    this.cachedToken = token
    return { login: data.login }
  }

  /** 删除 PAT（用户在设置里"断开 GitHub"时调用） */
  disconnect(): void {
    this.db.setSetting(PAT_SETTING_KEY, '')
    this.db.setSetting(PAT_LOGIN_KEY, '')
    this.cachedClient = null
    this.cachedToken = null
  }

  /** 当前是否已配置 PAT（即设置里有非空加密串） */
  isConnected(): boolean {
    return !!(this.db.getSetting(PAT_SETTING_KEY) || '').trim()
  }

  getCurrentLogin(): string | null {
    const v = this.db.getSetting(PAT_LOGIN_KEY)
    return v && v.trim() ? v : null
  }

  /** 内部：拿一个可用的 Octokit 实例（含解密） */
  private getClient(): Octokit {
    if (this.cachedClient && this.cachedToken) return this.cachedClient
    const encrypted = this.db.getSetting(PAT_SETTING_KEY)
    if (!encrypted || !encrypted.trim()) {
      throw new Error('GitHub 未连接：请先调用 connect_github 配置 PAT')
    }
    let token = ''
    try {
      token = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch (decErr) {
      this.disconnect()
      throw new Error(`PAT 解密失败（可能是更换了设备或 keychain 失效），已清空，请重新连接: ${decErr instanceof Error ? decErr.message : String(decErr)}`)
    }
    this.cachedToken = token
    this.cachedClient = new Octokit({ auth: token, userAgent: 'soul-desktop' })
    return this.cachedClient
  }

  /** 列出当前用户可访问的仓库（按更新时间倒序，最多 100 个） */
  async listRepos(perPage = 30): Promise<GitHubRepoInfo[]> {
    const oct = this.getClient()
    const { data } = await oct.rest.repos.listForAuthenticatedUser({
      per_page: Math.min(100, Math.max(1, perPage)),
      sort: 'updated',
      direction: 'desc',
    })
    return data.map((r) => ({
      owner: r.owner.login,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      description: r.description,
      defaultBranch: r.default_branch || 'main',
      updatedAt: r.updated_at || '',
    }))
  }

  /** 获取仓库 tree（递归一层；超大仓库 GitHub 会标 truncated=true，前端需提示用户） */
  async getTree(owner: string, repo: string, ref?: string): Promise<{ entries: GitHubTreeEntry[]; truncated: boolean }> {
    const oct = this.getClient()
    let sha = ref
    if (!sha) {
      const repoInfo = await oct.rest.repos.get({ owner, repo })
      sha = repoInfo.data.default_branch || 'main'
    }
    // 先拿到 commit SHA，再请求 tree（recursive）
    const branch = await oct.rest.repos.getBranch({ owner, repo, branch: sha })
    const treeSha = branch.data.commit.commit.tree.sha
    const tree = await oct.rest.git.getTree({ owner, repo, tree_sha: treeSha, recursive: 'true' })
    return {
      entries: tree.data.tree.map((e) => ({
        path: e.path || '',
        type: (e.type as 'blob' | 'tree' | 'commit') || 'blob',
        size: e.size,
        sha: e.sha || '',
      })),
      truncated: !!tree.data.truncated,
    }
  }

  /** 读单文件内容（utf-8），> 1MB 抛出（避免吃光内存） */
  async readFile(owner: string, repo: string, filePath: string, ref?: string): Promise<string> {
    const oct = this.getClient()
    const { data } = await oct.rest.repos.getContent({ owner, repo, path: filePath, ref })
    if (Array.isArray(data)) throw new Error(`期望文件，但 ${filePath} 是目录`)
    if (!('content' in data) || data.type !== 'file') throw new Error(`${filePath} 不是普通文件`)
    if ((data.size ?? 0) > 1_048_576) throw new Error(`文件过大（>1MB），不便预览：${filePath}`)
    const buf = Buffer.from(data.content, 'base64')
    return buf.toString('utf-8')
  }

  /**
   * 把仓库内若干文件下载到当前会话 workspace。
   * 自动创建目标目录，存在同名文件时直接覆盖。
   */
  async importFiles(
    avatarId: string,
    projectId: string,
    conversationId: string,
    owner: string,
    repo: string,
    files: ImportFileSpec[],
    ref?: string,
  ): Promise<Array<{ path: string; bytes: number }>> {
    if (!Array.isArray(files) || files.length === 0) return []
    const result: Array<{ path: string; bytes: number }> = []
    for (const f of files) {
      const content = await this.readFile(owner, repo, f.path, ref)
      const dest = f.saveAs || f.path
      const abs = this.workspaceManager.resolveSafe(avatarId, projectId, conversationId, dest)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content, 'utf-8')
      result.push({ path: dest, bytes: Buffer.byteLength(content, 'utf-8') })
    }
    return result
  }
}
