/**
 * RefusalCard.tsx — 知识库无数据·已拒答 卡片。
 *
 * 设计动机：分身 soul.md / agent-template.md 训练规则要求"知识库没有数据要明确拒答"。
 * 原实现把拒答输出为普通 markdown 段落，混在长答案里，演示时观众根本注意不到 AI 在
 * 「诚实承认不知道」——而这恰恰是产品最反直觉的卖点。
 *
 * 本组件把拒答从一段灰色文字升级为**有视觉特征的卡片**：
 *   - 左侧 ⚠ 图标 + 黄色边框（用 warn 色而不是 danger 红——红色给"错误"，拒答是功能）
 *   - 标题 "知识库无数据 · 已拒答"（不是"对不起"——这是功能，不是道歉）
 *   - 缺失资料 chip 列表（一眼能数清楚缺几个）
 *   - 建议 bullet 列表
 *
 * DSL 协议（由 agent-template.md 规则约束 LLM 输出）：
 *
 *     ```refuse
 *     reason 一句话原因（用抽象描述代替原词，避免触发 G3.2 红线）
 *     missing
 *       - 缺失资料 1
 *       - 缺失资料 2
 *     suggestions
 *       - 建议 1
 *       - 建议 2
 *     ```
 *
 * 解析容错：LLM 偶发输出 `原因/缺失/建议` 中文字段名也接受；缺 missing 或 suggestions
 * 任一字段时仅渲染存在的部分，不报错。
 *
 * @author claude
 * @date 2026-05-22
 */

import { type ReactElement } from 'react'

interface RefusalCardProps {
  /** 完整 refuse fenced block 的内容（不含 ```refuse 围栏） */
  dsl: string
}

interface RefusalSpec {
  reason: string
  missing: string[]
  suggestions: string[]
}

/**
 * 把 ```refuse``` 代码块内容解析为结构化字段。
 *
 * 接受两种字段名（英文 / 中文）：
 *   - reason / 原因   → reason
 *   - missing / 缺失  → missing[]
 *   - suggestions / 建议 → suggestions[]
 *
 * 字段值可以是：
 *   - 同行紧跟一段文字（reason 适用）
 *   - 下方缩进 `- xxx` 列表（missing / suggestions 适用）
 *   - 同行分号 `;` / 中文分号 `；` / 顿号 `、` 分隔列表（fallback）
 */
function parseRefusalDsl(dsl: string): RefusalSpec {
  const lines = dsl.split('\n')
  const spec: RefusalSpec = { reason: '', missing: [], suggestions: [] }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '') { i++; continue }

    // 字段名 + 同行值 / 字段名独占一行
    const headMatch = trimmed.match(/^(reason|原因|missing|缺失|suggestions|建议)\b\s*(.*)$/i)
    if (!headMatch) { i++; continue }

    const rawKey = headMatch[1].toLowerCase()
    const inlineValue = headMatch[2].trim()

    const keyMap: Record<string, 'reason' | 'missing' | 'suggestions'> = {
      reason: 'reason', 原因: 'reason',
      missing: 'missing', 缺失: 'missing',
      suggestions: 'suggestions', 建议: 'suggestions',
    }
    const target = keyMap[rawKey]
    if (!target) { i++; continue }

    if (target === 'reason') {
      // reason 字段：取同行值；若同行为空，取下一非空非缩进行
      if (inlineValue) {
        spec.reason = inlineValue
        i++
        continue
      }
      // 下一行可能是 reason 的实际值（在某些 LLM 输出里 `reason` 独占一行 + 缩进文本）
      i++
      while (i < lines.length && lines[i].trim() === '') i++
      if (i < lines.length) {
        const next = lines[i].trim()
        // 下一行不是已知字段名就当 reason 内容
        if (!/^(reason|原因|missing|缺失|suggestions|建议)\b/i.test(next)) {
          spec.reason = next
          i++
        }
      }
      continue
    }

    // missing / suggestions：可能是同行分隔，也可能是下方缩进列表
    const collected: string[] = []
    if (inlineValue) {
      // 同行分隔（; / ； / 、）
      const parts = inlineValue.split(/[;；、]/).map(s => s.trim()).filter(Boolean)
      collected.push(...parts)
    }
    i++
    // 收集下方缩进 `- xxx` 项目（直到下一个顶级字段或文末）
    while (i < lines.length) {
      const child = lines[i]
      if (child.trim() === '') { i++; continue }
      const childIndent = (child.match(/^(\s*)/)?.[1] ?? '').length
      // 0 缩进且匹配字段名 → 终止
      if (childIndent === 0 && /^(reason|原因|missing|缺失|suggestions|建议)\b/i.test(child.trim())) break
      const m = child.match(/^\s*-\s+(.+?)\s*$/)
      if (m) collected.push(m[1].trim())
      else if (childIndent > 0) {
        // 缩进续行但不是 - 列表项：当成补充文字附到上一条
        if (collected.length > 0) collected[collected.length - 1] += ' ' + child.trim()
      } else {
        break
      }
      i++
    }
    spec[target] = collected
  }

  return spec
}

export default function RefusalCard({ dsl }: RefusalCardProps): ReactElement {
  const spec = parseRefusalDsl(dsl)

  return (
    <div
      role="note"
      aria-label="知识库无数据，已拒答"
      className="my-3 border-2 border-px-warning bg-px-warning/5 shadow-pixel"
    >
      {/* 顶栏：⚠ 图标 + 标题 + "功能型拒答" 副标签 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b-2 border-px-warning bg-px-warning/10">
        <span className="font-game text-[16px] text-px-warning" aria-hidden="true">⚠</span>
        <span className="font-game text-[12px] tracking-widest text-px-warning">
          知识库无数据 · 已拒答
        </span>
        <span className="font-game text-[10px] tracking-wider text-px-text-dim/70 ml-auto hidden sm:inline">
          不编造 · 不臆测
        </span>
      </div>

      {/* 主体 */}
      <div className="px-4 py-3 space-y-3">
        {/* 原因 */}
        {spec.reason && (
          <div className="font-body text-[13px] leading-relaxed text-px-text">
            {spec.reason}
          </div>
        )}

        {/* 缺失资料 chip 列表 */}
        {spec.missing.length > 0 && (
          <div>
            <div className="font-game text-[11px] tracking-wider text-px-text-dim mb-1.5">
              缺失资料（{spec.missing.length}）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {spec.missing.map((item, idx) => (
                <span
                  key={`missing-${idx}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 border border-px-warning/60 bg-px-bg
                    font-mono text-[11px] text-px-warning whitespace-nowrap"
                >
                  <span aria-hidden="true">·</span>
                  <span>{item}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 建议 bullet 列表 */}
        {spec.suggestions.length > 0 && (
          <div>
            <div className="font-game text-[11px] tracking-wider text-px-text-dim mb-1">
              下一步建议
            </div>
            <ul className="space-y-0.5 list-none">
              {spec.suggestions.map((item, idx) => (
                <li
                  key={`suggestion-${idx}`}
                  className="font-body text-[13px] text-px-text leading-relaxed flex gap-2"
                >
                  <span className="font-mono text-px-primary flex-shrink-0" aria-hidden="true">›</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 完全空的极端兜底：所有字段都没解析出来时回退到原始 DSL */}
        {!spec.reason && spec.missing.length === 0 && spec.suggestions.length === 0 && (
          <pre className="text-[11px] text-px-text-dim font-mono whitespace-pre-wrap break-all">
            {dsl}
          </pre>
        )}
      </div>
    </div>
  )
}
