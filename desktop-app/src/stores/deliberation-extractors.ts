/**
 * Deliberation 表达抽取器（v17，Phase 1 of human-cognition extension）。
 *
 * 从 assistant 回复中抽出两类内心活动标签：
 *   - [UNCERTAIN]...[/UNCERTAIN] — 认知不确定（数据来源不明、推理薄弱、领域边界外）
 *   - [RECONSIDER]...[/RECONSIDER] — 立场更新（之前认为 X，现在认为 Y）
 *
 * 标签内容被抽出后从 cleanText 中移除——渲染层会以 chip 形式独立展示在消息泡下方，
 * 因此不应在标签外重复"我不太确定 / 我改主意"。
 *
 * 抽离到独立文件的原因：纯字符串函数，无 zustand/React 依赖，便于 node:test 单测。
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

const UNCERTAIN_REGEX = /\[UNCERTAIN\]([\s\S]*?)\[\/UNCERTAIN\]/g
const RECONSIDER_REGEX = /\[RECONSIDER\]([\s\S]*?)\[\/RECONSIDER\]/g

/** 单条标记的字符上限——防止过长 chip 撑爆消息泡 UI */
export const MARKER_CHAR_LIMIT = 200

/**
 * 抽取并移除 [UNCERTAIN] 标记。
 *
 * @param text 原始 assistant 回复
 * @returns cleanText（已移除标记）+ markers 数组（已 trim + 截断到 MARKER_CHAR_LIMIT）
 */
export function extractUncertain(text: string): { cleanText: string; markers: string[] } {
  return extractMarker(text, UNCERTAIN_REGEX)
}

/**
 * 抽取并移除 [RECONSIDER] 标记。
 */
export function extractReconsider(text: string): { cleanText: string; markers: string[] } {
  return extractMarker(text, RECONSIDER_REGEX)
}

/**
 * 通用 marker 抽取实现——空内容跳过，过长截断，trim 边距空白。
 * 私有：UNCERTAIN/RECONSIDER 走相同形态，只差正则。
 */
function extractMarker(text: string, regex: RegExp): { cleanText: string; markers: string[] } {
  const markers: string[] = []
  const cleanText = text.replace(regex, (_match, content: string) => {
    const trimmed = content.trim()
    if (trimmed.length === 0) return ''
    markers.push(
      trimmed.length > MARKER_CHAR_LIMIT ? trimmed.slice(0, MARKER_CHAR_LIMIT) + '…' : trimmed,
    )
    return ''
  }).trim()
  return { cleanText, markers }
}
