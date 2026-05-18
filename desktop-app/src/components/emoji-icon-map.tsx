/**
 * 把 LLM 回答里常见的 emoji（🔴🟡🟢 / ✅❌ / ⚠️ 等）替换成项目风格的 inline icon。
 *
 * 设计：
 * - 状态点（🔴🟠🟡🟢🔵🟣⚪⚫）→ Tailwind 着色的 rounded-full span
 * - 语义图标（✅❌⚠️💡ℹ️📌🤔）→ inline SVG，沿用 fill=none stroke=currentColor 项目风格
 * - 未命中的 emoji 原样保留（用户字符串里偶发 emoji 不强制干预）
 *
 * splitTextWithEmojiIcons 行为与 splitTextWithCitations 一致：把字符串切成
 * [文本, ReactNode, 文本, ...]，每个被替换的 emoji 占一个 ReactNode 位。
 *
 * 实现注意：icon 工厂用小写命名（renderXxx）避免被 react-refresh 当成组件触发
 * "only-export-components" 警告。它们只是返回 JSX 的普通函数。
 *
 * @author zhi.qu
 * @date 2026-05-12
 */
import type { ReactNode } from 'react'

/** 项目内 inline icon 通用尺寸：w-3.5 h-3.5 与文本基线视觉一致 */
const ICON_CLASS = 'inline-block align-middle w-3.5 h-3.5 mx-0.5'
/** 状态点尺寸：略小于 SVG，避免视觉过重 */
const DOT_CLASS = 'inline-block align-middle w-2.5 h-2.5 rounded-full mx-0.5'

const renderDot = (color: string, label: string): ReactNode => (
  <span className={DOT_CLASS} style={{ backgroundColor: color }} aria-label={label} />
)

const renderCheck = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-green-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="完成">
    <path strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
)

const renderCross = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-red-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="错误">
    <path strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
  </svg>
)

const renderWarning = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-amber-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="警告">
    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.5M12 16h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
  </svg>
)

const renderBulb = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-yellow-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="提示">
    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.74V17a1 1 0 001 1h6a1 1 0 001-1v-2.26A7 7 0 0012 2z" />
  </svg>
)

const renderInfo = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-blue-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="信息">
    <circle cx="12" cy="12" r="9" strokeWidth="2" />
    <path strokeWidth="2" strokeLinecap="round" d="M12 8h.01M11 12h1v5h1" />
  </svg>
)

const renderPin = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-gray-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="标记">
    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 2v8M12 22v-6M5 10h14M7 14h10" />
  </svg>
)

const renderThinking = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-gray-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="思考">
    <circle cx="12" cy="12" r="9" strokeWidth="2" />
    <path strokeWidth="2" strokeLinecap="round" d="M9 9c0-1.5 1.5-2.5 3-2.5s3 1 3 2.5c0 2-3 2.5-3 4" />
    <circle cx="12" cy="17" r="0.5" strokeWidth="1.5" />
  </svg>
)

const renderChartBar = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-blue-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="图表">
    <path strokeWidth="2" strokeLinecap="round" d="M3 21h18M7 16v-5M12 16V8M17 16v-3" />
  </svg>
)

const renderTrendUp = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-green-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="增长">
    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M3 17l6-6 4 4 8-8M14 7h7v7" />
  </svg>
)

const renderTrendDown = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-red-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="下降">
    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M3 7l6 6 4-4 8 8M14 17h7v-7" />
  </svg>
)

const renderTarget = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-red-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="目标">
    <circle cx="12" cy="12" r="9" strokeWidth="2" />
    <circle cx="12" cy="12" r="5" strokeWidth="2" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </svg>
)

const renderFire = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-orange-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="热点">
    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 2s4 5 4 9a4 4 0 11-8 0c0-2 1.5-3 1.5-3S8 11 8 13a4 4 0 008 0c0-3.5-4-7-4-11z" />
  </svg>
)

const renderStar = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-yellow-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="重点">
    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" />
  </svg>
)

const renderNote = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-gray-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="备注">
    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M4 4h12l4 4v12H4zM16 4v4h4M8 12h8M8 16h6" />
  </svg>
)

const renderRocket = (): ReactNode => (
  <svg className={`${ICON_CLASS} text-purple-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-label="启动">
    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M5 13l-2 4 4-2M19 5l-7 7-4-4 7-7zM12 12l4 4M14 10l-3-3" />
  </svg>
)

/**
 * Emoji → inline icon 映射表。命中即替换；其余 emoji 不动。
 * 颜色与 Tailwind palette 对齐（red-500 / amber-500 等），随主题暗色背景视觉不变。
 */
const EMOJI_ICON_MAP: Record<string, () => ReactNode> = {
  // 状态点（最高频）
  '🔴': () => renderDot('#ef4444', '红'),
  '🟠': () => renderDot('#f97316', '橙'),
  '🟡': () => renderDot('#eab308', '黄'),
  '🟢': () => renderDot('#22c55e', '绿'),
  '🔵': () => renderDot('#3b82f6', '蓝'),
  '🟣': () => renderDot('#a855f7', '紫'),
  '⚪': () => renderDot('#e5e7eb', '白'),
  '⚫': () => renderDot('#111827', '黑'),
  // 语义图标
  '✅': renderCheck,
  '☑️': renderCheck,
  '✔️': renderCheck,
  '❌': renderCross,
  '✖️': renderCross,
  '⚠️': renderWarning,
  '🚨': renderWarning,
  '💡': renderBulb,
  'ℹ️': renderInfo,
  '📌': renderPin,
  '📍': renderPin,
  '🤔': renderThinking,
  // 段落标题前缀类（LLM 高频使用，2026-05-18 补全）
  '📊': renderChartBar,
  '📈': renderTrendUp,
  '📉': renderTrendDown,
  '🎯': renderTarget,
  '🔥': renderFire,
  '⭐': renderStar,
  '🌟': renderStar,
  '📝': renderNote,
  '🚀': renderRocket,
}

/**
 * 用上表里有映射的 emoji 作为切点，把字符串拆成 [文本, IconNode, 文本, ...]。
 * 无命中 emoji 时返回 `[text]`（保持调用方对单元素数组的处理）。
 *
 * Unicode 注意：emoji 通常 2 个 code unit（surrogate pair）+ 偶有 VS16（U+FE0F）后缀。
 * Object.keys(EMOJI_ICON_MAP) 直接作为 alternation 即可正确匹配。
 */
const EMOJI_REGEX = new RegExp(
  Object.keys(EMOJI_ICON_MAP)
    .sort((a, b) => b.length - a.length) // 长的优先（VS16 后缀的 ✅️ 先于 ✅）
    .map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
)

export function splitTextWithEmojiIcons(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = []
  let lastIdx = 0
  let occurrence = 0
  for (const match of text.matchAll(EMOJI_REGEX)) {
    const start = match.index ?? 0
    if (start > lastIdx) parts.push(text.slice(lastIdx, start))
    const factory = EMOJI_ICON_MAP[match[0]]
    if (factory) {
      // ReactNode 没有 key prop；包一层 span 套 key，避免 React 警告
      parts.push(
        <span key={`${keyPrefix}-emoji-${occurrence}-${start}`}>
          {factory()}
        </span>,
      )
    }
    lastIdx = start + match[0].length
    occurrence += 1
  }
  if (parts.length === 0) return [text]
  if (lastIdx < text.length) parts.push(text.slice(lastIdx))
  return parts
}
