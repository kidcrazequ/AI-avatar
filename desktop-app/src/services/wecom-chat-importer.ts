/**
 * wecom-chat-importer.ts — 企业微信聊天截图 → 结构化聊天记录 markdown
 *
 * 背景：企业微信普通成员没有明文导出能力（客户端「聊天记录迁移」产物是
 * 加密 .bak，会话存档是管理员付费功能），截图是普通用户唯一可行的记录
 * 载体。本模块把多张按顺序的聊天截图经 Vision 模型逐条转写后，合并为
 * 一份可检索的 markdown（发言人 / 时间 / 内容逐条保留）。
 *
 * 职责边界：本文件只放**纯函数**（prompt 常量 / 单图转写结果解析 /
 * 多图合并去重），不依赖 Electron / @soul/core，node test runner 可直接
 * 测试。Vision 调用、frontmatter 组装、写盘由 KnowledgePanel 编排（与
 * excel/pptx 导入路径同构）。
 */

/**
 * 聊天截图专用 Vision prompt。
 *
 * 与 DEFAULT_VISION_PROMPT（技术文档图表）的区别：要求逐条转写消息并
 * 保留发言人/时间结构，首行输出会话标题供合并阶段提取。
 * 「只转写可见内容，不编造」与默认 prompt 的反编造要求保持一致。
 */
export const WECOM_CHAT_VISION_PROMPT =
  '这是一张企业微信（或微信）聊天记录截图。请把图中所有可见的聊天消息' +
  '按从上到下的顺序逐条转写为 Markdown：' +
  '1. 第一行输出会话标题（截图顶部标题栏的联系人或群名），格式：`[标题] 名称`；' +
  '看不到标题栏就输出 `[标题] 未知`；' +
  '2. 截图中出现日期分隔线（如「2026年5月20日」「昨天」）时，单独输出一行 ' +
  '`### 原文日期`（能确定完整年月日就写成 `### YYYY-MM-DD`，否则保留原文）；' +
  '3. 每条消息单独一行，格式：`- **发言人** HH:MM：消息内容`；' +
  '发言人不可见（如连续消息只显示首条头像）就沿用上一条的发言人；时间不可见就省略 HH:MM；' +
  '消息内有换行用「 / 」连接成一行；' +
  '4. 图片、文件、语音、链接卡片等非文本消息用占位符转写：[图片]、[文件:文件名]、[语音]、[链接:标题]；' +
  '5. 只转写图中实际可见的内容，不要编造、补全或总结；消息被截图边缘截断就照可见部分转写；' +
  '6. 直接输出内容，不要用代码围栏包裹，禁止使用 emoji，不要在末尾附加总结或自评。'

/** 单张截图的转写结果：会话标题（可缺失）+ 逐行消息/日期分隔线 */
export interface ChatSegment {
  title: string | null
  lines: string[]
}

/** 相邻截图重叠去重时，最多回看多少行（聊天截图重叠区一般不超过一屏） */
const MAX_OVERLAP_LINES = 40

/** 重叠比较用的行归一化：去掉所有空白差异（OCR 对空格的输出不稳定） */
function normalizeLine(line: string): string {
  return line.replace(/\s+/g, '')
}

/**
 * 解析单张截图的 Vision 转写文本：
 * - 提取首个 `[标题] xxx` 行为会话标题（「未知」/空视为 null）
 * - 其余非空行按原顺序保留（消息行 + `### 日期` 分隔行）
 */
export function parseChatSegment(raw: string): ChatSegment {
  let title: string | null = null
  const lines: string[] = []
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const titleMatch = line.match(/^\[标题\]\s*(.*)$/)
    if (titleMatch) {
      if (title === null) {
        const t = titleMatch[1].trim()
        title = t && t !== '未知' ? t : null
      }
      continue
    }
    lines.push(line)
  }
  return { title, lines }
}

/**
 * 合并多张截图的转写结果（按截图顺序）。
 *
 * 重叠去重：连续截图通常有重叠区（滚动截屏），对每个新 segment，找
 * 「已合并行的尾部 == 新 segment 行的头部」的最长匹配（行内容归一化后
 * 精确比较，最多回看 MAX_OVERLAP_LINES 行），去掉新 segment 的重叠头部。
 * OCR 噪声可能让同一行两次转写不一致——此时去重失败、内容重复，但绝不丢失。
 *
 * 标题取第一个非 null 的 segment 标题。
 */
export function mergeChatSegments(segments: ChatSegment[]): ChatSegment {
  const merged: string[] = []
  let title: string | null = null
  let lastDateHeading: string | null = null
  for (const seg of segments) {
    if (title === null && seg.title !== null) title = seg.title
    const overlap = findOverlap(merged, seg.lines)
    for (let i = overlap; i < seg.lines.length; i++) {
      const line = seg.lines[i]
      // 日期分隔行在同一天的每张截图里都会重复出现，只保留首次；
      // 跨到新日期（内容不同）才重新输出
      if (line.startsWith('### ')) {
        if (line === lastDateHeading) continue
        lastDateHeading = line
      }
      merged.push(line)
    }
  }
  return { title, lines: merged }
}

/** 返回 next 头部与 merged 尾部重叠的行数（无重叠返回 0） */
function findOverlap(merged: string[], next: string[]): number {
  const max = Math.min(merged.length, next.length, MAX_OVERLAP_LINES)
  for (let k = max; k >= 1; k--) {
    let match = true
    for (let i = 0; i < k; i++) {
      if (normalizeLine(merged[merged.length - k + i]) !== normalizeLine(next[i])) {
        match = false
        break
      }
    }
    if (match) return k
  }
  return 0
}

/**
 * 由会话标题生成知识库文件名片段（与 KnowledgePanel 既有 baseName 清洗
 * 规则一致：仅保留中英文/数字/下划线/连字符）。标题缺失时返回空串，由
 * 调用方拼默认名。
 */
export function sanitizeChatTitle(title: string | null): string {
  if (!title) return ''
  return title.replace(/[^a-zA-Z0-9一-龥_-]/g, '_').replace(/^_+|_+$/g, '')
}

/**
 * 组装聊天记录 markdown 正文（不含 frontmatter——由调用方按 excel/pptx
 * 同样的 buildFrontmatterBlock 流程拼装）。
 *
 * 识别失败的截图**显式列出**，不沉默吞掉：缺图意味着聊天内容有断档，
 * 检索命中此文件的回答需要知道这一点。
 */
export function buildChatMarkdownBody(opts: {
  title: string
  lines: string[]
  screenshotCount: number
  /** 识别失败的截图序号（1-based，按导入顺序） */
  failedOrdinals: number[]
}): string {
  const { title, lines, screenshotCount, failedOrdinals } = opts
  const parts: string[] = [`# ${title}`, '']
  parts.push(`> 来源：企业微信聊天截图 ${screenshotCount} 张，经视觉模型逐条转写合并。`)
  if (failedOrdinals.length > 0) {
    parts.push(
      `> ⚠️ 第 ${failedOrdinals.join('、')} 张截图识别失败，对应时段的聊天内容**缺失**，引用本文件时不可当作完整记录。`,
    )
  }
  parts.push('', ...lines, '')
  return parts.join('\n')
}
