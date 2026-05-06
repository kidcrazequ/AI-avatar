/**
 * 对话附件存储（本地落盘）。
 *
 * 设计要点：
 *   - 文件本体落到 userData/attachments/<convId>/<hash>.<ext>，sha256 去重
 *   - 元信息（id / 名称 / mime / 大小 / 摘要 / 大纲）由 DatabaseManager 持久化
 *   - 路径段全部用 assertSafeSegment / resolveUnderRoot 防穿越
 *   - 只暴露同步/异步 fs 操作接口给 main.ts，不直接被渲染进程访问
 *
 * 与 document-parser 的关系：
 *   - 本模块只管落盘 + 读取；解析工作（提取大纲/摘要/全文）由 main.ts 调用 DocumentParser 完成
 *   - 这样保证 attachment-store 自身不依赖 pdfjs / mammoth 等大体积运行时
 *
 * @author zhi.qu
 * @date 2026-05-01
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { assertSafeSegment, resolveUnderRoot } from '@soul/core'

/** 落盘后的附件信息（供调用方写入数据库） */
export interface SavedAttachment {
  /** 业务 ID（由调用方决定持久化字段，但本层负责生成） */
  id: string
  /** sha256 全文哈希（便于跨次去重） */
  hash: string
  /** 后缀名（含点，小写） */
  ext: string
  /** 原始文件名 */
  name: string
  /** 字节数 */
  size: number
  /** 落盘后的绝对路径 */
  storedPath: string
  /** 落盘时间戳（毫秒） */
  createdAt: number
}

/**
 * 单文件最大字节数（50MB）。
 * 超出抛错由调用方决定如何反馈用户；不在本层做静默截断。
 */
export const MAX_ATTACHMENT_FILE_BYTES = 50 * 1024 * 1024

/**
 * 附件存储管理器。
 *
 * 实例化时传入 userData 根目录（通常来自 app.getPath('userData')），
 * 内部维护 `<userData>/attachments/<conversationId>/` 目录结构。
 */
export class AttachmentStore {
  /** 所有附件的根目录（绝对路径） */
  private readonly rootDir: string

  constructor(userDataPath: string) {
    if (!userDataPath || !userDataPath.trim()) {
      throw new Error('AttachmentStore: userDataPath 不能为空')
    }
    this.rootDir = path.join(userDataPath, 'attachments')
    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true })
    }
  }

  /** 暴露 root 给上层（仅用于日志/调试，不要在业务代码里 path.join） */
  getRootDir(): string {
    return this.rootDir
  }

  /**
   * 落盘一个新附件。
   *
   * - 自动按 sha256 命名，确保相同内容不会被重复落盘（同 hash 不会重写）
   * - 强制走 assertSafeSegment(conversationId)，拒绝穿越企图
   * - 文件超过 MAX_ATTACHMENT_FILE_BYTES 时抛错
   *
   * @returns 落盘后的元信息（含 id / hash / 路径）
   */
  saveAttachment(conversationId: string, name: string, buffer: Buffer): SavedAttachment {
    assertSafeSegment(conversationId, '会话ID')
    if (!name || !name.trim()) {
      throw new Error('附件文件名不能为空')
    }
    if (buffer.length === 0) {
      throw new Error('附件内容为空，无法保存')
    }
    if (buffer.length > MAX_ATTACHMENT_FILE_BYTES) {
      const mb = Math.floor(MAX_ATTACHMENT_FILE_BYTES / (1024 * 1024))
      throw new Error(`附件过大（>${mb}MB），请压缩或拆分后再上传: ${name}`)
    }

    const ext = (path.extname(name) || '').toLowerCase()
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')

    const convDir = this.ensureConversationDir(conversationId)
    const fileName = ext ? `${hash}${ext}` : hash
    const storedPath = path.join(convDir, fileName)

    // 同 hash 已存在视为去重命中：直接复用现有文件，不再写入
    if (!fs.existsSync(storedPath)) {
      fs.writeFileSync(storedPath, buffer)
    }

    return {
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      hash,
      ext,
      name,
      size: buffer.length,
      storedPath,
      createdAt: Date.now(),
    }
  }

  /**
   * 根据 conversationId + hash + ext 重建附件绝对路径，并校验是否仍在根目录下。
   * 用于 read_attachment / search_attachment 工具按 ID 取本体时的安全解析。
   *
   * 如果文件不存在会抛错；调用方需自行 catch。
   */
  getAttachmentAbsPath(conversationId: string, hash: string, ext: string): string {
    assertSafeSegment(conversationId, '会话ID')
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
      throw new Error(`非法附件 hash: ${hash}`)
    }
    const safeExt = (ext || '').toLowerCase()
    if (safeExt && !/^\.[a-z0-9]{1,8}$/.test(safeExt)) {
      throw new Error(`非法附件后缀: ${ext}`)
    }
    const fileName = safeExt ? `${hash}${safeExt}` : hash
    const convDir = path.join(this.rootDir, conversationId)
    // resolveUnderRoot 兜底防止 hash/ext 触发任何形式的穿越
    const abs = resolveUnderRoot(convDir, fileName)
    if (!fs.existsSync(abs)) {
      throw new Error(`附件文件不存在: ${conversationId}/${fileName}`)
    }
    return abs
  }

  /**
   * 删除某会话的全部附件目录（在 deleteConversation 时联动调用）。
   * 目录不存在视为成功（幂等）。
   */
  deleteAttachmentsByConversation(conversationId: string): void {
    assertSafeSegment(conversationId, '会话ID')
    const convDir = path.join(this.rootDir, conversationId)
    if (!fs.existsSync(convDir)) return
    // recursive + force 避免链接 / 只读位导致整个删除失败
    fs.rmSync(convDir, { recursive: true, force: true })
  }

  /**
   * 确保会话目录存在并返回绝对路径。
   * 会校验 conversationId 安全性，避免 ../../ 之类的穿越值。
   */
  private ensureConversationDir(conversationId: string): string {
    const convDir = path.join(this.rootDir, conversationId)
    // resolveUnderRoot 在异常路径段时抛错，提前阻断目录创建
    resolveUnderRoot(this.rootDir, conversationId)
    if (!fs.existsSync(convDir)) {
      fs.mkdirSync(convDir, { recursive: true })
    }
    return convDir
  }
}
