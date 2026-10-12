/**
 * Standing Orders — 永久工作流规则（v18 OpenClaw + ReMeV2 借鉴）
 *
 * 痛点：Soul 当前有 MEMORY.md（用户偏好）/ USER.md（画像）/ episodes / wiki / soul.md 多通道，
 * 但唯独**长期工作流约定**没固定 channel：
 *   - "以后所有工商储方案必须先算 IRR" 进 MEMORY.md 容易被 LLM 当一次性背景
 *   - 进 soul.md 又得用户手动编辑
 *
 * Standing Order 是介于 soul.md 红线和 MEMORY.md 偏好之间的"运行时永久规则"：
 * 由 LLM 在对话中识别用户的"以后都要..."类指令后主动写入，
 * SoulLoader 装配 system prompt 时把整个 standing-orders.md 注入紧挨 soul.md 之后。
 *
 * 设计原则（参考 pin_episode）：
 *   - **不提供 remove API**：防 LLM 自我审查删规则；需人工编辑文件
 *   - **数量上限**：达 MAX_STANDING_ORDERS 后拒绝 append，强制 LLM 让用户合并 / 取消旧条目
 *   - **每条带时间戳 + 来源**（conversationId 或 "manual"），便于人工审计
 *
 * 文件格式：人类可读 markdown，每条以 `- ` 开头，前一行带 `<!-- TIMESTAMP source=... -->` 注释
 *
 * @author zhi.qu
 * @date 2026-05-18
 */

import fs from 'fs'
import path from 'path'
import { localDateString } from '../utils/local-date'

const STANDING_ORDERS_FILE = 'standing-orders.md'
/** 全分身每文件最多条数；超过拒绝追加 */
export const MAX_STANDING_ORDERS = 50
/** 单条字符上限 */
export const MAX_ORDER_LENGTH = 500

export interface AppendStandingOrderResult {
  ok: boolean
  /** ok=false 时给出原因 */
  error?: string
  /** ok=true 时返回当前总条数 */
  total?: number
}

function getStandingOrdersPath(avatarsPath: string, avatarId: string): string {
  return path.join(avatarsPath, avatarId, 'memory', STANDING_ORDERS_FILE)
}

/**
 * 读取整个 standing-orders.md 内容（用于 soul-loader 注入）。
 * 文件不存在或为空返回空字符串。
 */
export function readStandingOrders(avatarsPath: string, avatarId: string): string {
  const filePath = getStandingOrdersPath(avatarsPath, avatarId)
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return ''
    console.warn(`[standing-orders] 读 ${filePath} 失败: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

/**
 * 统计 standing-orders.md 当前有效条目数（以 `- ` 开头的行）。
 * 用于上限检查 + UI 显示。
 */
export function countStandingOrders(avatarsPath: string, avatarId: string): number {
  const content = readStandingOrders(avatarsPath, avatarId)
  if (!content) return 0
  let count = 0
  for (const line of content.split('\n')) {
    if (/^- \S/.test(line)) count++
  }
  return count
}

/**
 * 追加一条 standing order。
 *
 * 行为：
 *   - 空白 order 拒绝
 *   - 超长（> MAX_ORDER_LENGTH）拒绝
 *   - 达上限拒绝
 *   - 否则追加到文件末尾（带时间戳 + 来源注释）；首次写入会自动建立 markdown header
 */
export function appendStandingOrder(
  avatarsPath: string,
  avatarId: string,
  order: string,
  source: string = 'manual',
): AppendStandingOrderResult {
  const trimmed = String(order ?? '').trim()
  if (!trimmed) return { ok: false, error: 'order 不能为空' }
  if (trimmed.length > MAX_ORDER_LENGTH) {
    return { ok: false, error: `order 过长，上限 ${MAX_ORDER_LENGTH} 字符（当前 ${trimmed.length}）` }
  }

  const filePath = getStandingOrdersPath(avatarsPath, avatarId)
  const currentCount = countStandingOrders(avatarsPath, avatarId)
  if (currentCount >= MAX_STANDING_ORDERS) {
    return {
      ok: false,
      error: `已达 standing orders 上限（${MAX_STANDING_ORDERS} 条）；本工具不提供 remove，需人工编辑 ${STANDING_ORDERS_FILE} 删除/合并旧条目`,
    }
  }

  // 单条 order 内部禁止换行（破坏列表结构）— 改成空格
  const sanitized = trimmed.replace(/\r?\n/g, ' ')
  const sanitizedSource = String(source ?? '').replace(/[\r\n]/g, ' ').slice(0, 100) || 'unknown'
  const timestamp = localDateString()
  const entry = `\n<!-- ${timestamp} source=${sanitizedSource} -->\n- ${sanitized}\n`

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (!fs.existsSync(filePath)) {
    const header = '# Standing Orders\n\n> 本分身的长期工作流规则。每条由 LLM 抽取或人工添加。本框架不提供工具层 remove；需人工编辑此文件解除规则。\n'
    fs.writeFileSync(filePath, header + entry, 'utf-8')
  } else {
    fs.appendFileSync(filePath, entry, 'utf-8')
  }

  return { ok: true, total: currentCount + 1 }
}
