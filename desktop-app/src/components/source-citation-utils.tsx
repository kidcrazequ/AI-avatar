/**
 * SourceCitation 配套工具：把 ReactMarkdown 渲染出的文本子节点中的
 * `[来源: knowledge/<file>.md#L..]` 切成 [文本片段, <SourceCitation/>, ...]。
 *
 * 拆分原因：SourceCitation.tsx 只允许 default export 一个组件（react-refresh
 * 规则要求"组件文件不混导出 helper"），这两个 helper 单独放在本文件中。
 *
 * @author zhi.qu
 * @date 2026-05-06
 */
import { Children, type ReactNode } from 'react'
import SourceCitation from './SourceCitation'

/**
 * 完整闭合的 `[来源: ...]` 文本块匹配（任何内容都接，不挑剔 knowledge/ 前缀）。
 *
 * `[^\]\n]+` 限定不跨行、不吞 `]`，因此流式中未闭合的 `[来源: ...` 不会被错误捕获。
 * 冒号同时接受 ASCII `:` 与中文全角 `：`（LLM 偶发产出全角符号）。
 *
 * 块内是否包含 .md 文件路径由 SourceCitation 组件用 `extractMdPathsFromAnchor`
 * 自行判定 —— 提不到任何 .md 时该组件保留原文本降级，不会"消失"。
 */
const SOURCE_CITATION_REGEX = /\[来源[：:][^\]\n]+\]/g

/**
 * 把字符串里所有完整闭合的 `[来源: knowledge/...]` 切成 [文本片段, <SourceCitation/>,
 * 文本片段, ...]。无匹配时原样返回单元素数组（保留语义不变）。
 *
 * keyPrefix 用于配合外层 children 的索引保证 React key 全局唯一。
 */
export function splitTextWithCitations(
  text: string,
  avatarId: string,
  keyPrefix: string,
): ReactNode[] {
  const parts: ReactNode[] = []
  let lastIdx = 0
  let occurrence = 0
  for (const match of text.matchAll(SOURCE_CITATION_REGEX)) {
    const start = match.index ?? 0
    if (start > lastIdx) parts.push(text.slice(lastIdx, start))
    parts.push(
      <SourceCitation
        key={`${keyPrefix}-cite-${occurrence}-${start}`}
        anchor={match[0]}
        avatarId={avatarId}
      />,
    )
    lastIdx = start + match[0].length
    occurrence += 1
  }
  if (parts.length === 0) return [text]
  if (lastIdx < text.length) parts.push(text.slice(lastIdx))
  return parts
}

/**
 * 把 ReactMarkdown 渲染出的 children（可能是 string / ReactElement / 数组 / 嵌套）
 * 中的字符串子节点用 splitTextWithCitations 拆开，非字符串原样保留。
 *
 * 仅做一层扁平化 —— 嵌套 inline 元素（<strong>、<em> 等）内部的 anchor 不在
 * 此处拦截（react-markdown 会把每个 inline 元素的纯文本作为它自己的 children
 * 传入；本函数处理的是 <p> 这一层的 string 子节点，已覆盖 LLM 输出里
 * `[来源: ...]` 出现的绝大多数语境）。
 */
export function renderChildrenWithCitations(
  children: ReactNode,
  avatarId: string,
  keyPrefix: string,
): ReactNode {
  const arr = Children.toArray(children)
  const out: ReactNode[] = []
  arr.forEach((child, idx) => {
    if (typeof child === 'string') {
      out.push(...splitTextWithCitations(child, avatarId, `${keyPrefix}-s${idx}`))
      return
    }
    out.push(child)
  })
  return out
}
