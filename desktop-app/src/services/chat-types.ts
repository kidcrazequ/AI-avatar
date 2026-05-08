/**
 * Chat message shared types used by service-level tests.
 *
 * @author zhi.qu
 * @date 2026-04-24
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
}

/**
 * 工具落盘文件附件（generate_document / export_excel 共用）。
 *
 * 决策 B3：把 PDF/DOCX/MD 与 Excel 统一到同一附件类型，
 * UI 端用同一个 FileCard 组件渲染，避免出现"Excel 一种样式、文档另一种样式"。
 *
 * 与 AttachmentRef 的区别：
 *   - AttachmentRef = 用户上传到对话的文件（user 消息附带）
 *   - DocumentAttachment = LLM 通过工具调用产出的落盘文件（assistant 消息附带）
 *
 * @author zhi.qu
 * @date 2026-05-08
 */
export type DocumentAttachmentFormat = 'md' | 'pdf' | 'docx' | 'xlsx'

export interface DocumentAttachmentSource {
  /** 引用源（cite 块的 source 属性，通常是 knowledge/xxx.md） */
  source: string
  /** 页码（仅 PDF 来源标注页时有） */
  page?: number
}

export interface DocumentAttachment {
  /** 区分附件来源种类 */
  kind: 'document'
  /** 文件格式，决定 FileCard 显示什么图标 */
  format: DocumentAttachmentFormat
  /** 工作区内相对路径，如 exports/收益测算.pdf（用于持久化与日志） */
  filePath: string
  /** 绝对路径（FileCard 点击 [打开] 时直接传给 shell.openPath） */
  absolutePath: string
  /** 文件大小（字节，用于 UI 显示 KB/MB） */
  sizeBytes: number
  /** 含扩展名的展示文件名 */
  filename: string
  /** 引用来源列表（cite 块抽出，FileCard 折叠展示）；undefined 表示无引用 */
  sources?: DocumentAttachmentSource[]
}
