import { createContext, createElement, useState, useRef, useEffect, useMemo, useCallback, useContext, memo, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from 'react'
import ToolCallTimeline from './ToolCallTimeline'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatMessage, useChatStore } from '../stores/chatStore'
import { computeBranchInfo, findBranchTip } from '../stores/branch-nav'
import AvatarImage from './AvatarImage'
import ChartRenderer from './ChartRenderer'
import MermaidRenderer from './MermaidRenderer'
import InfographicRenderer from './InfographicRenderer'
import RefusalCard from './RefusalCard'
import LightboxModal from './LightboxModal'
import { renderChildrenWithCitations } from './source-citation-utils'
import FileCard from './FileCard'
import { useArtifactStore, hashRaw, type ArtifactKind } from '../stores/artifactStore'

/**
 * Context：告诉子组件当前 message 是否还在流式（isLive）。
 * ArtifactSlot 用它决定 auto-open 时机——流式期间不打开任何中间状态版本，
 * 等 message 完成（isLive=false）才打开。MessageBubble 在 render 时 Provider 注入。
 */
const MessageStreamingContext = createContext<boolean>(false)

/**
 * 把任意 artifact 渲染包一层 wrapper：
 *   - hover 时显示"⤢ 副面板"按钮
 *   - 当 raw 大小超过 autoOpenThreshold 且 message 已完成时，自动 openArtifact 一次
 */
function ArtifactSlot({ kind, raw, children }: { kind: ArtifactKind; raw: string; children: ReactNode }): ReactElement {
  const openArtifact = useArtifactStore(s => s.openArtifact)
  const autoOpenThreshold = useArtifactStore(s => s.autoOpenThreshold)
  const isLive = useContext(MessageStreamingContext)

  useEffect(() => {
    // 流式中不 auto-open：ArtifactSlot 实例化时虽然单个 fence 已闭合（外层
    // isMermaidComplete / isInfographicComplete / chart isIncomplete 已守过），
    // 但 LLM 可能在同一 message 内 emit 多个 fence（"我再改一版"），各自 raw
    // 不同 → 各自 key 不同 → 都被 push 出 tab。等 message 完成（isLive=false）
    // 后 effect 重跑，那时 raw 已经稳定为 message 内最后一个值。
    if (isLive) return
    if (autoOpenThreshold <= 0) return
    if (raw.length < autoOpenThreshold) return
    // 用 store 的全局 autoOpenedKeys 去重：组件 remount 时同一 key 不重复打开
    const key = hashRaw(kind, raw)
    if (useArtifactStore.getState().autoOpenedKeys.has(key)) return
    useArtifactStore.getState().markAutoOpened(key)
    openArtifact({ kind, raw })
  }, [autoOpenThreshold, raw, kind, openArtifact, isLive])

  return (
    <div className="relative group">
      {/*
        副面板按钮放在左上角，避开 chart/infographic 内部的 RendererToolbar
        （它固定在 top-2 right-2，本按钮原来也在 top-1 right-1 时两者重叠，
        2026-05-21 用户反馈：「后面那个按钮被覆盖了」）。
      */}
      <button
        type="button"
        onClick={() => openArtifact({ kind, raw })}
        className="absolute top-1 left-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity
          font-game text-[10px] text-px-text-dim hover:text-px-primary
          px-1.5 py-0.5 bg-px-surface/90 border border-px-border hover:border-px-primary
          tracking-wider"
        title="在副面板打开（独立滚动 / 复制 / 放大）"
        aria-label="在副面板打开"
      >
        ⤢ 副面板
      </button>
      {children}
    </div>
  )
}

const REMARK_PLUGINS = [remarkGfm]

/**
 * mermaid 流式检测：生成中代码块的结尾特征。
 * mermaid 没有统一的结束标记，用启发式：以已知关键字开头 + 最后一行是否完整。
 */
const MERMAID_KEYWORDS = /^(gantt|flowchart|graph|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey|gitGraph|pie|mindmap|timeline|quadrantChart|kanban|sankey|requirementDiagram|C4Context|xychart|block|architecture)\b/i
function isMermaidComplete(code: string): boolean {
  const trimmed = code.trim()
  if (trimmed.length < 10) return false
  if (!MERMAID_KEYWORDS.test(trimmed)) return false
  // 至少有 2 行内容（声明 + 至少一行定义）
  const lines = trimmed.split('\n').filter(l => l.trim().length > 0)
  return lines.length >= 2
}

/**
 * @antv/infographic DSL 流式检测：识别 LLM 已输完代码块的启发式。
 *
 * 兼容多种 LLM 误用的首行形式 — 即使 body 错也让 renderer 接管，比卡 "生成中…" 友好：
 *   1. DSL 标准（唯一正确）：`infographic <template-name>`
 *   2. YAML 误用：           `template: <template-name>`
 *   3. JS 对象 / JSON 误用：  `@antv/infographic { ` 或 `{` 单独首行
 *   4. import / config 误用：`const xxx = {`、`export default {` 等
 */
function isInfographicComplete(code: string): boolean {
  const trimmed = code.trim()
  if (trimmed.length < 15) return false
  const firstLine = trimmed.split('\n')[0].trim()
  const isDslStyle = /^infographic\s+[a-z][a-z0-9-]+/i.test(firstLine)
  const isYamlMisuse = /^template\s*:\s*[a-z][a-z0-9-]+/i.test(firstLine)
  // JS 对象 / JSON 风格：首行通常是 `@antv/infographic {`、单独的 `{`、或 `const/export ... = {`
  const isJsObjectMisuse =
    /^@?[a-z@][\w/-]*\s*\{?\s*$/i.test(firstLine) ||
    /^\{\s*$/.test(firstLine) ||
    /^(const|let|var|export)\s/i.test(firstLine)
  // 新增：LLM 漏首行直接 body 开头（title / compares / lists / sequences / data / root / theme 等）
  // `theme` 是 LLM 误以为 DSL 顶级有 theme 字段（实际是 Infographic 构造参数，DSL 不读）——
  // 但要识别它，否则前端卡 "生成中..." 永远不接管（2026-05-22 真实事故）。
  const hasTypicalBodyHead =
    /^(title|subtitle|theme|data|compares|lists|sequences|root|nodes|relations|values|items)\b/i.test(firstLine)
  if (!isDslStyle && !isYamlMisuse && !isJsObjectMisuse && !hasTypicalBodyHead) return false
  // body 完成度启发：要么有 data/list 段，要么花括号已收尾
  return (
    /\n\s*data\b/i.test(trimmed) ||
    /\n\s*-\s/.test(trimmed) ||
    /\}\s*$/.test(trimmed) ||
    /\n\s*(strengths|weaknesses|opportunities|threats|items|lists|sequences|compares)\b/i.test(trimmed)
  )
}

/**
 * 把 LLM 误输出的常见非 DSL 风格"治愈"为合法首行 + 修正 body。
 *
 * 当前覆盖：
 *   首行级：
 *     - YAML 首行   `template: xxx`          → `infographic xxx`
 *     - JS / JSON   `@antv/infographic { ...` → 从 body 里搜 `type/template/name: "xxx"` 提模板名
 *   body 级：
 *     - compare-swot 字段误结构：把 `compares\n  strengths\n    - xxx\n  weaknesses\n    - yyy` 这种
 *       "顶级 strengths/weaknesses 当字段"的错误，自动转成合法的 `compares: 数组 of {label, items}` 形式
 *       （LLM 最高频踩坑点；治标 80% 的 compare-swot 渲染失败）
 *
 * body 真彻底错时 renderer 仍会失败，但 ErrorBoundary 红框会暴露源码。
 */
function coerceInfographicDsl(raw: string): string {
  // 字段名标准化（在所有路径之前）：LLM 经常用 `cards / items` 代替 antv 期望的
  // `compares / children`（2026-05-22 真实事故：商业模式对比图用 cards 段渲染失败）。
  // 这里把顶级 cards / 卡片内 items 字段名换成 antv 兼容形式，让后续 inferTemplate
  // 和 coerceCompareSwotToChildren 能继续接力。
  let coerced = normalizeAntvFieldNames(raw)
  const lines = coerced.split('\n')
  const first = lines[0]?.trim() ?? ''

  // Case 1: YAML 首行
  const yamlMatch = first.match(/^template\s*:\s*([a-z][a-z0-9-]+)\s*$/i)
  if (yamlMatch) {
    coerced = `infographic ${yamlMatch[1]}\n${lines.slice(1).join('\n')}`
  } else {
    // Case 2: JS 对象 / JSON 风格
    const isJsLike = /^@?[a-z@][\w/-]*\s*\{?\s*$/i.test(first) ||
                     /^\{\s*$/.test(first) ||
                     /^(const|let|var|export)\s/i.test(first)
    if (isJsLike) {
      const m = coerced.match(/(?:^|\s|\{)["'`]?(?:type|template|name)["'`]?\s*[:=]\s*["'`]([a-z][a-z0-9-]+)["'`]/i)
      if (m) coerced = `infographic ${m[1]}\n${coerced}`
    } else if (!/^infographic\s+[a-z][a-z0-9-]+/i.test(first)) {
      // Case 3: 缺 `infographic xxx` 首行（LLM 漏首行）— 按 body 关键字推断模板
      const inferred = inferTemplateFromBody(coerced)
      if (inferred) coerced = `infographic ${inferred}\n${coerced}`
    }
  }

  // 缺 `data` 包裹注入：必须在首行解析（infographic <name>）之后，body 级修复（compare-swot 等）之前。
  coerced = injectMissingDataWrapper(coerced)

  // body 级修复：compare-swot 高频字段误结构
  coerced = coerceCompareSwotBody(coerced)
  // body 级修复 2：compare-swot 每块用 text/items 字段时转成正确的 children 数组（每 child 一个 - label）
  coerced = coerceCompareSwotToChildren(coerced)

  return coerced
}

/**
 * 检测 LLM 漏写 `data` 包裹（把 title / lists / compares / sequences / root / nodes / values 等
 * 顶级数据字段直接写在 `infographic <name>` 同级而不是 `data` 段内）的常见错误，自动补 `data` 行 +
 * 把后续所有非空行整体缩进 2 空格。
 *
 * 真实事故（2026-05-22）：分类卡片信息图，LLM 输出
 *   ```
 *   theme light
 *   title 工商储商业模式速查
 *   items
 *     - label EMC 合同能源管理
 *       desc ...
 *   ```
 * coerceInfographicDsl 把 theme 删了、把 items 改名 lists、inferTemplate 在首行补了
 * `infographic list-grid-badge-card`，但**没人补 `data` 包裹**。
 *
 * @antv/infographic 的 options.parser.js 只从 `options.data` 里取 `lists/sequences/compares/...`
 * 字段，data === undefined 时 parseData 直接 return → 渲染容器空白，**不抛 Invalid SVG 异常**
 * （所以也不会进 ErrorBoundary 红框），用户看到的就是"副面板空缺"。
 *
 * 检测条件：首行 `infographic <name>` 之后第一个非空行如果是顶级（无缩进）的已知数据字段
 * （title/description/subtitle/lists/compares/sequences/root/nodes/relations/values/items）
 * 且**不是** `data` → 判定缺 data 包裹 → 注入。
 *
 * 幂等：若结构已是 `infographic <name>\ndata\n  ...` 则原样返回。
 */
function injectMissingDataWrapper(raw: string): string {
  const lines = raw.split('\n')
  if (lines.length < 2) return raw
  if (!/^infographic\s+[a-z][a-z0-9-]+/i.test(lines[0])) return raw

  let firstNonEmptyIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() !== '') { firstNonEmptyIdx = i; break }
  }
  if (firstNonEmptyIdx === -1) return raw

  const firstNonEmpty = lines[firstNonEmptyIdx]
  // 已有 data 包裹 → 跳过
  if (/^\s*data\s*$/.test(firstNonEmpty)) return raw
  // 必须是 0 缩进的已知顶级数据字段才修（缩进 > 0 说明可能已经在某个上下文里，不动）
  if (!/^(title|description|subtitle|lists|compares|sequences|root|nodes|relations|values|items)\b/.test(firstNonEmpty)) {
    return raw
  }

  const before = lines.slice(0, firstNonEmptyIdx)
  const rest = lines.slice(firstNonEmptyIdx)
  const indented = rest.map(l => l.trim() === '' ? l : '  ' + l)
  return [...before, 'data', ...indented].join('\n')
}

/**
 * LLM 写 infographic DSL 时常见的字段名错误标准化为 antv 期望的字段名。
 * 只匹配独占一行的字段名，避免误伤正文里的同名词。
 *
 * 2026-05-22 真实事故迭代：
 * - LLM 写 `cards` 顶级（应是 compares） → 整图空框
 * - LLM 写 `items` 卡片内（应是 children） → schema 不匹配
 * - LLM 写 `items:` 带冒号（半 YAML 风格） → 字面字段名"items:"不识别
 * - LLM 写 `subtitle`（应是 description） → 顶级字段错
 * - LLM 写 `desc` 在卡片内（应是 children + label） → 渲染丢内容
 */
function normalizeAntvFieldNames(raw: string): string {
  // 顶级 `cards` / `items` 应该映射成 `compares` 还是 `lists`，由 body 内容决定：
  //
  // - 含 SWOT 关键词 → SWOT 对比 → `compares`（让 inferTemplate 推 compare-swot）
  // - 含**任意嵌套二级数组**（children / cards / items 4+ 空格缩进）→ 多层级对比 → `compares`
  //   （让 inferTemplate 推 compare-hierarchy-row-letter-card-compact-card）
  // - 否则 → 普通卡片列表 → `lists`（让 inferTemplate 推 list-grid-badge-card）
  //
  // 关键：含嵌套二级数组时必须走 compares 而不是 lists——list-grid 模板不读 children，
  // 嵌套内容会丢；compare-hierarchy-row 模板专门为"root + children"层级设计（2026-05-22 修正）。
  //
  // 嵌套检测：look-forward 检测 4+ 空格缩进的 cards / items / children 任一字段名独占一行。
  const isSwotFlavor = /(strengths|weaknesses|opportunities|threats|优势|劣势|机会|威胁)/i.test(raw)
  const hasNestedSubArray = /^\s{4,}(children|cards|items)\s*$/m.test(raw)
  const cardsTarget = (isSwotFlavor || hasNestedSubArray) ? 'compares' : 'lists'

  return mergeNonStandardNestedArraysIntoDesc(mergeBadgesIntoDesc(mergeShortValueIntoLabel(coerceItemValueToDescWhenNoDesc(
    raw
      // 顶级 theme 行删除：LLM 误以为 DSL 有 theme 字段，实际 theme 是 Infographic 构造参数
      // （我们在 InfographicRenderer 里通过 themeConfig 注入，DSL 里写了 antv parser 会报错）。
      // 必须放在最前删除，避免后续 normalize / coerce 看到它。
      .replace(/^\s*theme\s+\S+\s*$/m, '')
      // 顶级 cards（0-2 空格缩进）→ compares/lists（智能路由）
      .replace(/^(\s{0,2})cards(\s*)$/m, `$1${cardsTarget}$2`)
      // 嵌套 cards（4+ 空格缩进）→ children：antv hierarchy 模板的子项数组字段
      // 这条必须在顶级 cards 之后，否则 4+ 空格的 cards 会被误匹配成顶级（2026-05-22 修复）
      .replace(/^(\s{4,})cards(\s*)$/gm, '$1children$2')
      // 顶级 items: 带冒号（半 YAML 风格）→ cardsTarget
      .replace(/^(\s*)items\s*:\s*$/m, `$1${cardsTarget}`)
      // 顶级 items（0-2 空格缩进，无冒号）→ cardsTarget
      .replace(/^(\s{0,2})items(\s*)$/m, `$1${cardsTarget}$2`)
      // 嵌套 items（缩进 ≥ 4 空格，无冒号）→ children
      .replace(/^(\s{4,})items(\s*)$/gm, '$1children$2')
      // 顶级 subtitle → description（antv 顶级标题副标题字段叫 description）
      .replace(/^(\s*)subtitle(\s+)/m, '$1description$2')
      // 顶级 introduction → description（LLM 又一种"副标题"误写法）
      .replace(/^(\s*)introduction(\s+)/m, '$1description$2')
      // 嵌套 subtitle（≥ 4 空格缩进）→ badge：合并到同 item 的 desc 末尾
      .replace(/^(\s{4,})subtitle\s+(.+)$/gm, '$1badge $2')
      // 嵌套 tag（≥ 4 空格缩进）→ badge：antv item 不读 tag 字段，转 badge 合并入 desc
      .replace(/^(\s{4,})tag\s+(.+)$/gm, '$1badge $2')
      // 嵌套 `- title X` → `- label X`：antv item 主标题字段是 label
      .replace(/^(\s*-\s+)title(\s+)/gm, '$1label$2'),
  ))))
}

/**
 * 把 LLM 在每个 `- label` item 里凭空发明的"嵌套数组字段"（pros / cons / advantages /
 * disadvantages / features / risks / benefits / highlights / notes / bullets / tags）的子项
 * 合并进同 item 的 desc 末尾，避免 antv list-grid-badge-card 把这些字段静默丢弃。
 *
 * 真实事故（2026-05-22）：分类卡片信息图问商业模式速查，LLM 输出
 *   ```
 *   - label EMC 合同能源管理
 *     desc 资方出资...
 *     pros
 *       - label 零初始投入
 *       - label 风险转移
 *     cons
 *       - label 电价波动直接侵蚀
 *   ```
 * antv BadgeCard 只读 label/desc/value/icon，pros/cons 数组整组被丢弃 → 卡片只剩 label + desc，
 * 关键差异点完全不可见。
 *
 * 合并策略：
 *   - 检测每个 `- label` item 内、缩进恰好 = item 缩进 + 2 的非标准字段名
 *   - 收集该字段下所有 `- label X` / `- X` 子项的文本
 *   - 整组用 ` · ` 拼接，按字段做轻量中文化（pros→优势 / cons→风险），多组用 `；` 分隔
 *   - 追加到 item 的 desc 末尾（用 ` · ` 分隔）；item 无 desc 时新建 desc 行
 *   - 标准嵌套字段 children 不动（compare-hierarchy 等模板真正读它）
 */
function mergeNonStandardNestedArraysIntoDesc(raw: string): string {
  const NON_STANDARD_FIELDS: Record<string, string> = {
    pros: '优势',
    cons: '风险',
    advantages: '优势',
    disadvantages: '劣势',
    features: '特点',
    risks: '风险',
    benefits: '收益',
    highlights: '亮点',
    notes: '备注',
    bullets: '要点',
    tags: '标签',
  }
  const NON_STANDARD_RE = new RegExp(`^(${Object.keys(NON_STANDARD_FIELDS).join('|')})$`, 'i')

  const lines = raw.split('\n')
  const out: string[] = []

  let currentItemLabelIdx = -1
  let currentItemDescIdx = -1
  let currentItemIndent = -1
  let pendingSegments: string[] = []

  const flushPendingToCurrentItem = (): void => {
    if (pendingSegments.length === 0) return
    const merged = pendingSegments.join('；')
    if (currentItemDescIdx >= 0) {
      out[currentItemDescIdx] = out[currentItemDescIdx] + ' · ' + merged
    } else if (currentItemLabelIdx >= 0) {
      const indentStr = ' '.repeat(currentItemIndent + 2)
      const descLine = `${indentStr}desc ${merged}`
      out.splice(currentItemLabelIdx + 1, 0, descLine)
      currentItemDescIdx = currentItemLabelIdx + 1
    }
    pendingSegments = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const labelMatch = line.match(/^(\s*)-\s+label\s+/)
    if (labelMatch) {
      flushPendingToCurrentItem()
      out.push(line)
      currentItemLabelIdx = out.length - 1
      currentItemDescIdx = -1
      currentItemIndent = labelMatch[1].length
      i++
      continue
    }

    if (currentItemLabelIdx >= 0) {
      const fieldMatch = line.match(/^(\s+)([a-z]+)\s*$/i)
      if (fieldMatch) {
        const fieldIndent = fieldMatch[1].length
        const fieldName = fieldMatch[2]
        // 必须**正好**是 item 的下一级（item 缩进 + 2），且字段名在非标准白名单里
        if (fieldIndent === currentItemIndent + 2 && NON_STANDARD_RE.test(fieldName)) {
          const labelKey = NON_STANDARD_FIELDS[fieldName.toLowerCase()] || fieldName
          const children: string[] = []
          i++
          // 收集嵌套数组里的所有子项（缩进 > fieldIndent，可带 label 关键字也可不带）
          while (i < lines.length) {
            const child = lines[i]
            if (child.trim() === '') { i++; continue }
            const childIndent = (child.match(/^(\s*)/)?.[1] ?? '').length
            if (childIndent <= fieldIndent) break
            const mc = child.match(/^\s*-\s+(?:label\s+)?(.+?)\s*$/)
            if (mc) children.push(mc[1].trim())
            // 嵌套数组里的非 `-` 起头的子行（比如 `desc xxx`）：忽略，宁可丢辅助说明也不污染主合并
            i++
          }
          if (children.length > 0) {
            pendingSegments.push(`${labelKey}：${children.join(' · ')}`)
          }
          continue
        }
      }

      const descMatch = line.match(/^(\s+)desc\s+/)
      if (descMatch && descMatch[1].length === currentItemIndent + 2) {
        out.push(line)
        currentItemDescIdx = out.length - 1
        i++
        continue
      }
    }

    out.push(line)
    i++
  }

  flushPendingToCurrentItem()
  return out.join('\n')
}

/**
 * 嵌套 value 字段的安全降级：LLM 经常把短字符串塞进 antv 不读纯文本的 `value` 字段。
 * 历史上无脑全部改名为 desc，但当同一个 item 已经有 desc 时，会出现两个 desc 行 →
 * antv 只取一个，长描述被短 value 字符串覆盖。
 *
 * 真实事故（2026-05-22）：商业模式速览图每条 item 同时给了长描述（desc）和计量
 * "14 项目"（value），结果渲染只剩"14 项目"，长描述完全丢失。
 *
 * 修复：按 `- label` 边界切 item，逐 item 决策——
 *   - item 没有 desc → value 改名 desc（保留文字内容）
 *   - item 已有 desc → 保留 value 不动（让 antv 当 badge / 计量数字渲染）
 */
function coerceItemValueToDescWhenNoDesc(raw: string): string {
  const lines = raw.split('\n')
  const itemStarts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*-\s+label\s+/.test(lines[i])) itemStarts.push(i)
  }
  for (let k = 0; k < itemStarts.length; k++) {
    const start = itemStarts[k]
    const end = k + 1 < itemStarts.length ? itemStarts[k + 1] : lines.length
    const hasDesc = lines.slice(start, end).some(l => /^\s+desc\s+/.test(l))
    if (!hasDesc) {
      for (let i = start; i < end; i++) {
        lines[i] = lines[i].replace(/^(\s{4,})value(\s+)/, '$1desc$2')
      }
    }
  }
  return lines.join('\n')
}

/**
 * 当 item 同时有 label + desc + 短 value 时把 value 合并进 label，避免 antv
 * list-grid-badge-card 把 value 渲染成巨字号、吃掉卡片大半高度、desc 被裁切。
 *
 * 真实事故（2026-05-22，紧接 coerceItemValueToDescWhenNoDesc 的修复后）：
 * 商业模式速览图每条 item 长 desc + 短 value（"14 项目" / "—"），上一个修复让
 * desc 留住了但 value 巨字号挤占卡片高度，desc 仍被裁。
 *
 * 处理策略：
 *   - value 长度 ≤ 20 字符 → 拼到 label 末尾（" · " 分隔）并删除 value 行
 *   - value 长度 > 20 字符 → 保留不动（极少见，主调用方应单独处理）
 *   - "—" / "-" / "" 等占位 value → 直接删除 value 行（不污染 label）
 *
 * 注：必须在 coerceItemValueToDescWhenNoDesc 之后调用——后者会把"只有 value 没有 desc"
 * 的 item 先把 value 改名 desc；本函数仅处理剩下的"同时有 desc 和 value"情形。
 */
function mergeShortValueIntoLabel(raw: string): string {
  const lines = raw.split('\n')
  const itemStarts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*-\s+label\s+/.test(lines[i])) itemStarts.push(i)
  }
  // 倒序遍历：删除行会改变下标，从后往前删避免影响前一个 item 的 end
  for (let k = itemStarts.length - 1; k >= 0; k--) {
    const start = itemStarts[k]
    const end = k + 1 < itemStarts.length ? itemStarts[k + 1] : lines.length
    let valueIdx = -1
    let valueText = ''
    for (let i = start; i < end; i++) {
      const m = lines[i].match(/^\s{4,}value\s+(.+)$/)
      if (m) { valueIdx = i; valueText = m[1].trim(); break }
    }
    if (valueIdx < 0) continue
    const isPlaceholder = /^[—\-–~]\s*$/.test(valueText) || valueText.length === 0
    if (isPlaceholder) {
      lines.splice(valueIdx, 1)
      continue
    }
    if (valueText.length > 20) continue
    const labelMatch = lines[start].match(/^(\s*-\s+label\s+)(.+?)\s*$/)
    if (!labelMatch) continue
    lines[start] = `${labelMatch[1]}${labelMatch[2].trim()} · ${valueText}`
    lines.splice(valueIdx, 1)
  }
  return lines.join('\n')
}

/**
 * 把 LLM 凭空发明的 `badge X` 字段（antv item schema 里根本不读）合并进同 item 的
 * `desc` 末尾，用 ` · ` / ` / ` 拼接，避免 badge 内容完全丢失。
 *
 * 真实事故（2026-05-22）：LLM 写 `- label X / desc 一段话 / badge A / badge B / badge C`，
 * antv BadgeCard 只读 label+desc+value+icon，3 个 badge 直接被忽略 →
 * 即使模板路由正确，关键 tag 信息也丢失。
 *
 * 合并策略：每碰到新的 `- label` 开始一个新 item 边界，badge 只能合到本 item 的 desc 末尾，
 * 不跨 item 串。如果 item 没 desc，把 badge 集合作为新 desc 行。
 */
function mergeBadgesIntoDesc(raw: string): string {
  const lines = raw.split('\n')
  const out: string[] = []
  let currentItemLabelIdx = -1
  let currentItemDescIdx = -1
  let pendingBadges: string[] = []

  /**
   * 把 pendingBadges 合并进**当前 item 的 desc**。
   * - 当前 item 已有 desc → 拼到 desc 末尾
   * - 当前 item 没 desc → 在 label 行后插入新 desc 行
   * 不跨 item 串：每碰到新 - label 都会先调一次 flush 清空 pending。
   */
  const flushBadgesToCurrentItem = () => {
    if (pendingBadges.length === 0) return
    const merged = pendingBadges.join(' / ')
    if (currentItemDescIdx >= 0) {
      out[currentItemDescIdx] = out[currentItemDescIdx] + ' · ' + merged
    } else if (currentItemLabelIdx >= 0) {
      const labelLine = out[currentItemLabelIdx]
      const labelIndent = labelLine.match(/^(\s*)/)?.[1] ?? ''
      const descLine = `${labelIndent}  desc ${merged}`
      out.splice(currentItemLabelIdx + 1, 0, descLine)
      currentItemDescIdx = currentItemLabelIdx + 1
    }
    pendingBadges = []
  }

  for (const line of lines) {
    const labelMatch = line.match(/^\s*-\s+label\s+/)
    const descMatch = line.match(/^\s+desc\s+/)
    const badgeMatch = line.match(/^\s+badge\s+(.+)$/)

    if (labelMatch) {
      flushBadgesToCurrentItem() // flush 到上一个 item
      out.push(line)
      currentItemLabelIdx = out.length - 1
      currentItemDescIdx = -1 // 新 item 重置
    } else if (descMatch) {
      // 先 push 这个 desc 行（成为当前 item 的 desc），再把 pending badges 拼到它末尾。
      // 不能先 flush——flush 会**新插入**一行 desc，导致与即将 push 的 desc 重复（2026-05-22 bug）。
      out.push(line)
      currentItemDescIdx = out.length - 1
      if (pendingBadges.length > 0) {
        out[currentItemDescIdx] = out[currentItemDescIdx] + ' · ' + pendingBadges.join(' / ')
        pendingBadges = []
      }
    } else if (badgeMatch) {
      pendingBadges.push(badgeMatch[1].trim())
      // 跳过 badge 行不 push
    } else {
      flushBadgesToCurrentItem()
      out.push(line)
    }
  }
  flushBadgesToCurrentItem() // 末尾收口
  return out.join('\n')
}

/**
 * @antv/infographic 的 compare-swot 模板每个 label 块只支持 1 条 plain-text（letter-card + 单段文本）。
 * LLM 经常按 SWOT 习惯输出每块 3-5 条 items 数组 — 模板拿不到 plain-text 字段就只渲染 4 个字母色块。
 *
 * 修复策略：检测到每个 - label 项的 items 段有多个 `- 条` 时，把所有条用「、」拼成单段 text，
 * 让 plain-text 字段拿到内容显示出来。失去 bullet 格式但至少图里有可见内容。
 */
function coerceCompareSwotToChildren(raw: string): string {
  if (!/^infographic\s+compare-swot\b/im.test(raw)) return raw
  const lines = raw.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 锁定 - label 行；清理 label 中手动加的 S/W/O/T 字母前后缀（letter-card 会自动生成）
    const labelMatch = line.match(/^(\s*)-\s+label\s+(.+?)\s*$/)
    if (labelMatch) {
      const labelIndent = labelMatch[1]
      let labelText = labelMatch[2].trim()
      // 清理 letter-card 模板下用户多余写的 S/W/O/T 单字母前缀/后缀（"优势 S" / "S - 优势" / "(S)"）。
      // 老正则匹配过宽，会把 "(Strengths)" 末尾的 "s)" 误删（变成 "(Strength"），
      // 导致 @antv/infographic 渲染失败（2026-05-22 真实事故）。
      // 修复：要求 SWOT 字母前后**必须有明确分隔符**（空白 / . - : : ( ）），
      // 不能是单词内部的字母——`Strengths` 中的 `S` 后面跟着 `t` 不算 letter-prefix。
      labelText = labelText
        .replace(/^[SWOT](?:\s*[.\-:：]|\s+)\s*/i, '')
        .replace(/(?:^|\s|[-:：(（])\s*[SWOT]\s*[)）]?\s*$/i, '')
        .trim()
      out.push(`${labelIndent}- label ${labelText}`)
      i++
      // 跳过空行
      while (i < lines.length && lines[i].trim() === '') { out.push(lines[i]); i++ }
      if (i >= lines.length) continue
      // 检查下一行是不是 items / text / desc / children 字段
      const nextLine = lines[i]
      const nextIndent = (nextLine.match(/^(\s*)/)?.[1] ?? '').length
      const labelInnerIndent = labelIndent.length + 2 // 每 - label 项内字段的标准缩进
      let collected: string[] = []
      let consumed = false

      // 情况 A：items 数组（LLM 旧习惯）→ 收集所有 - 列表项作为内容
      if (/^\s*items\s*$/.test(nextLine)) {
        i++
        const itemsBlockIndent = nextIndent
        while (i < lines.length) {
          const it = lines[i]
          const itIndent = (it.match(/^(\s*)/)?.[1] ?? '').length
          if (it.trim() === '') { i++; continue }
          if (itIndent <= itemsBlockIndent) break
          const m = it.match(/^\s+-\s+(.+)$/)
          if (m) collected.push(m[1].trim())
          i++
        }
        consumed = true
      }
      // 情况 B：text 字段 → 拆分成多个 child（按、；; 等分隔符）
      else {
        const textMatch = nextLine.match(/^\s+(?:text|desc|description|content)\s+(.+)$/i)
        if (textMatch) {
          // 按常见中文分隔符（、；;）拆分；若没分隔符就单条
          collected = textMatch[1].split(/[、；;]/).map(s => s.trim()).filter(Boolean)
          i++
          consumed = true
        }
        // 情况 C：已经是 children 数组（标准格式）→ 不动，passthrough
        else if (/^\s*children\s*$/.test(nextLine)) {
          // 不消耗，继续走主循环让 children 段原样输出
          continue
        }
      }

      if (!consumed) continue
      if (collected.length === 0) continue
      // 输出 children 数组（compare-swot 真正的字段）
      out.push(`${' '.repeat(labelInnerIndent)}children`)
      const childIndent = labelInnerIndent + 2
      for (const c of collected) {
        out.push(`${' '.repeat(childIndent)}- label ${c}`)
      }
    } else {
      out.push(line)
      i++
    }
  }
  return out.join('\n')
}

/**
 * 根据 body 内容启发式推断模板名（缺 `infographic xxx` 首行时用）。
 * 只覆盖最常用的几个模板：覆盖不到的让 renderer 自己 fail。
 */
function inferTemplateFromBody(raw: string): string | null {
  // SWOT：compares 段 + 含 Strengths/Weaknesses/Opportunities/Threats 或对应中文标签
  if (/\bcompares\b/i.test(raw) && /(strengths|weaknesses|opportunities|threats|优势|劣势|机会|威胁)/i.test(raw)) {
    return 'compare-swot'
  }
  // 层级对比：compares + 含 children 嵌套（每个对比项下面有 children 数组，比如 LLM 写
  // "3 列商业模式 × 每列多个属性" 这种 schema）。antv 的 `compare-hierarchy-row-letter-card-compact-card`
  // 模板正好对应"第一级：横向根节点 + 第二级：子节点列表"结构。
  // 真实事故（2026-05-22）：LLM 写 cards/items（→ normalize 成 compares/children）然后被
  // 推成 compare-bar-card（不接受 children 嵌套，单值对比模板）→ antv 渲染失败 → 空框。
  if (/\bcompares\b/i.test(raw) && /\bchildren\b/i.test(raw)) {
    return 'compare-hierarchy-row-letter-card-compact-card'
  }
  // 普通对比：compares 段（单层无 children，每项一个 value/score）
  if (/\bcompares\b/i.test(raw)) return 'compare-bar-card'
  // list 含 badge：lists 段 + 每项有 badge → list-grid-badge-card（带徽章的卡片网格）
  // 真实事故（2026-05-22）：LLM 把"分类卡片信息图"写成 items: + label/desc/badge 风格，
  // normalize 后变成 lists + badge，这条规则匹配 → list-grid-badge-card
  if (/\blists\b/i.test(raw) && /^\s*badge\s+/im.test(raw)) return 'list-grid-badge-card'
  // list：lists 段 → 选最通用的 list-grid-badge-card 模板
  if (/\blists\b/i.test(raw)) return 'list-grid-badge-card'
  // sequence：sequences 段
  if (/\bsequences\b/i.test(raw)) return 'sequence-stairs-arrow'
  // hierarchy：root + children
  if (/\broot\b/i.test(raw) && /\bchildren\b/i.test(raw)) return 'hierarchy-tree'
  // 词云：items + weight
  if (/\bitems\b/i.test(raw) && /\bweight\b/i.test(raw)) return 'word-cloud'
  return null
}

/**
 * compare-swot 字段修复：把"顶级 strengths/weaknesses/..."误结构转为标准的 compares 数组。
 *
 * 输入误结构（LLM 最常输出的版本）：
 *   ```
 *   compares
 *     strengths
 *       - 优势1
 *       - 优势2
 *     weaknesses
 *       - 劣势1
 *     opportunities
 *       - 机会1
 *     threats
 *       - 威胁1
 *   ```
 *
 * 输出标准 DSL：
 *   ```
 *   compares
 *     - label 优势
 *       items
 *         - 优势1
 *         - 优势2
 *     - label 劣势
 *       items
 *         - 劣势1
 *     ...
 *   ```
 *
 * 仅在检测到 4 个固定 SWOT 字段名时触发，其它情况不动 body（避免误伤合法 DSL）。
 */
function coerceCompareSwotBody(raw: string): string {
  // 必须是 compare-swot 模板才动 body
  if (!/^infographic\s+compare-swot\b/im.test(raw)) return raw
  // 至少要看到一个 SWOT 字段名作为子级
  const swotFieldRe = /^\s+(strengths|weaknesses|opportunities|threats)\s*$/im
  if (!swotFieldRe.test(raw)) return raw

  const labelMap: Record<string, string> = {
    strengths: '优势',
    weaknesses: '劣势',
    opportunities: '机会',
    threats: '威胁',
  }
  const lines = raw.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 锁定 "compares" 段头
    if (/^\s*compares\s*$/.test(line)) {
      out.push(line)
      const compIndent = (line.match(/^(\s*)/)?.[1] ?? '').length
      i++
      // 进入 compares 子项：寻找 strengths/weaknesses/opportunities/threats
      while (i < lines.length) {
        const sub = lines[i]
        const subIndent = (sub.match(/^(\s*)/)?.[1] ?? '').length
        // 退出 compares 段（缩进回到 compIndent 或更外）
        if (sub.trim() !== '' && subIndent <= compIndent) break
        const m = sub.match(/^(\s+)(strengths|weaknesses|opportunities|threats)\s*$/i)
        if (m) {
          const fieldIndent = m[1]
          const fieldKey = m[2].toLowerCase()
          const label = labelMap[fieldKey] || fieldKey
          out.push(`${fieldIndent}- label ${label}`)
          out.push(`${fieldIndent}  items`)
          i++
          // 收集该字段下的 - 列表项，移到 items 下并加 2 空格缩进
          while (i < lines.length) {
            const item = lines[i]
            const itemIndent = (item.match(/^(\s*)/)?.[1] ?? '').length
            if (item.trim() === '') { out.push(item); i++; continue }
            // 退出该字段：缩进回到 fieldIndent 或更外
            if (itemIndent <= fieldIndent.length) break
            // - 列表项加额外 2 空格缩进塞进 items 下
            if (/^\s*-\s/.test(item)) {
              out.push(`    ${item}`)
            } else {
              out.push(item)
            }
            i++
          }
        } else {
          out.push(sub)
          i++
        }
      }
    } else {
      out.push(line)
      i++
    }
  }
  return out.join('\n')
}

/**
 * 自定义 code 组件：拦截 `language-chart` / `language-mermaid` / `language-infographic`
 * 三类代码块，分别用 ECharts / Mermaid / @antv/infographic 渲染。
 * 其它 language 走默认 <code>/<pre> 样式。
 */
function ChartCodeBlock(props: ComponentPropsWithoutRef<'code'> & { inline?: boolean }): ReactElement {
  const { inline, className, children, ...rest } = props
  const raw = String(children ?? '').replace(/\n$/, '')

  // inline code 直接走默认渲染
  if (inline || !className) {
    return <code className={className} {...rest}>{children}</code>
  }

  // refuse 分支：知识库无数据·已拒答 结构化卡片（draw-infographic 风格 DSL）
  // 流式中也直接渲染——RefusalCard 自带 parser 容错，半截内容不会崩
  if (className.includes('language-refuse')) {
    return <RefusalCard dsl={raw} />
  }

  // mermaid 分支（甘特/流程/时序/思维导图/看板/饼图/状态机/ER/类/git 等）
  if (className.includes('language-mermaid')) {
    if (!isMermaidComplete(raw)) {
      return (
        <pre className="my-3 border-2 border-px-primary/30 bg-px-bg p-3 overflow-x-auto animate-pulse">
          <div className="font-game text-[11px] tracking-wider text-px-text-dim mb-2">
            ⏳ MERMAID 图表生成中...
          </div>
          <code className="text-[12px] text-px-text-dim font-mono">{raw}</code>
        </pre>
      )
    }
    return <ArtifactSlot kind="mermaid" raw={raw}><MermaidRenderer code={raw} /></ArtifactSlot>
  }

  // infographic 分支（信息图/列表/对比/序列/SWOT/思维导图等 84+ 模板）
  if (className.includes('language-infographic')) {
    if (!isInfographicComplete(raw)) {
      return (
        <pre className="my-3 border-2 border-px-primary/30 bg-px-bg p-3 overflow-x-auto animate-pulse">
          <div className="font-game text-[11px] tracking-wider text-px-text-dim mb-2">
            ⏳ INFOGRAPHIC 信息图生成中...
          </div>
          <code className="text-[12px] text-px-text-dim font-mono">{raw}</code>
        </pre>
      )
    }
    const coerced = coerceInfographicDsl(raw)
    // 历史版本在这里 console.group + logEvent 写 raw/coerced DSL，但 ChartCodeBlock
    // 在 render 路径——历史消息每次父层重渲染都会重复打日志，正文也会被写进 app log。
    // 需要诊断时改用 effect + message/block key 去重；当前生产路径不需要这条噪声。
    return <ArtifactSlot kind="infographic" raw={coerced}><InfographicRenderer dsl={coerced} /></ArtifactSlot>
  }

  // 非 chart / 非 mermaid / 非 infographic 代码块走默认渲染
  if (!className.includes('language-chart')) {
    return <code className={className} {...rest}>{children}</code>
  }

  // 流式输出检测：尝试 JSON.parse，失败且花括号未闭合时视为"正在生成"
  const trimmed = raw.trim()
  const openBraces = (trimmed.match(/{/g) || []).length
  const closeBraces = (trimmed.match(/}/g) || []).length
  const isIncomplete = openBraces > closeBraces || !trimmed.endsWith('}')
  if (isIncomplete) {
    return (
      <pre className="my-3 border-2 border-px-primary/30 bg-px-bg p-3 overflow-x-auto animate-pulse">
        <div className="font-game text-[11px] tracking-wider text-px-text-dim mb-2">
          ⏳ 图表生成中...
        </div>
        <code className="text-[12px] text-px-text-dim font-mono">{raw}</code>
      </pre>
    )
  }

  // 尝试解析 chart JSON（JSON.parse 独立于 JSX，规避 react-hooks/error-boundaries 规则）
  let parsedOption: Record<string, unknown> | null = null
  let parseError: string | null = null
  try {
    parsedOption = JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    parseError = (err as Error).message
    console.warn('[MessageBubble] chart JSON 解析失败:', parseError)
  }

  if (parsedOption) {
    return <ArtifactSlot kind="chart" raw={raw}><ChartRenderer option={parsedOption} rawJson={raw} /></ArtifactSlot>
  }

  // JSON 解析失败：降级为带红框的原始代码块，提示用户图表数据格式错误
  return (
    <pre className="my-3 border-2 border-px-danger bg-px-bg p-3 overflow-x-auto">
      <div className="font-game text-[11px] tracking-wider text-px-danger mb-2">
        ⚠ CHART JSON 解析失败{parseError ? `: ${parseError}` : ''}
      </div>
      <code className="text-[12px] text-px-text-dim font-mono">{raw}</code>
    </pre>
  )
}

/**
 * inline-text 容器渲染拦截：把 children 中的纯文本子节点里
 * `[来源: knowledge/...]` 切出来替换成可点击的 SourceCitation chip。
 * 其余 inline 元素（<strong>、<em> 等）原样保留。
 *
 * 必须覆盖 markdown 里所有可能"承载段落级文本"的容器：
 *   - p          段落
 *   - li         列表项（react-markdown 默认不把列表项内文本包进 p）
 *   - td / th    表格单元格
 *   - blockquote 引用块
 *
 * 用闭包注入 avatarId + messageId（构造唯一 React key），所以不能写成模块级常量，
 * 由 MessageBubble 内 useMemo 构造。
 */
function buildMarkdownComponents(avatarId: string, messageId: string) {
  // react-markdown 对每个 tag 的 component 入参类型严格区分（HTMLLIElement /
  // HTMLQuoteElement 等不兼容）。用最宽的"任意属性 + children + node"形状
  // 接住，内部用 createElement 透传给真实 tag，避免泛型类型推导踩坑。
  type ContainerProps = { children?: ReactNode; node?: unknown } & Record<string, unknown>

  function makeContainerRenderer(
    tag: 'p' | 'li' | 'td' | 'th' | 'blockquote',
    keySuffix: string,
  ): (props: ContainerProps) => ReactElement {
    return function MarkdownContainer(props: ContainerProps): ReactElement {
      const { children, node: _node, ...rest } = props
      void _node
      const processed: ReactNode = renderChildrenWithCitations(children, avatarId, `${messageId}-${keySuffix}`)
      return createElement(tag, rest, processed)
    }
  }

  // react-markdown 的 components 表对 value 类型用了 union of per-tag
  // FunctionComponent，这里我们的统一 renderer 形状对 TS 来说不严格匹配每个
  // tag 的 props 类型，但运行时完全等价（只透传属性 + children）。统一用
  // `as unknown as` 桥接，避免 5 个 tag 各写一份重复实现。
  type MarkdownComponentLike = (props: ContainerProps) => ReactElement
  const p = makeContainerRenderer('p', 'p') as unknown as MarkdownComponentLike
  const li = makeContainerRenderer('li', 'li') as unknown as MarkdownComponentLike
  const td = makeContainerRenderer('td', 'td') as unknown as MarkdownComponentLike
  const th = makeContainerRenderer('th', 'th') as unknown as MarkdownComponentLike
  const blockquote = makeContainerRenderer('blockquote', 'bq') as unknown as MarkdownComponentLike

  return {
    code: ChartCodeBlock,
    p,
    li,
    td,
    th,
    blockquote,
  } as Record<string, unknown>
}

/** 超过此字符数的助手消息显示折叠按钮 */
const COLLAPSE_THRESHOLD = 600
/** 折叠状态下显示的首段字符数 */
const COLLAPSED_PREVIEW_CHARS = 300
const THINK_BLOCK_REGEX = /<think>([\s\S]*?)<\/think>/gi

interface Props {
  message: ChatMessage
  previousUserMessage?: string
  onSaveAnswer?: (question: string, answer: string) => void
  /** 分身头像（用于 AI 消息气泡展示） */
  avatarImage?: string
  /** 分身名称（用于 AI 消息气泡展示） */
  avatarName?: string
  /**
   * 分身角色标签（专家身份描述，如"财务分析专家"/"工商储方案专家"）。
   * 显示在 avatarName 旁边的小 chip 上，让每条助手消息一眼能看出"这是哪个工种专家的回答"。
   * 来源：App.tsx 从 avatar.description 截取首句、限定长度后传入。
   */
  avatarRole?: string
  /** 当前对话所属分身 ID，用于 [来源:] chip 解析原始 PDF/Excel/PPT 文件 */
  avatarId: string
  /**
   * v19：本条消息是否正在"直播"（最后一条 + isLoading）。
   * true 时在工具调用时间线末尾追加"思考中..."占位行；false 时只渲染已有条目。
   */
  isLive?: boolean
  /** 本轮 sendMessage 累计耗时（秒），仅 isLive=true 时有意义。 */
  elapsedSec?: number
  /**
   * 是否允许「重新生成」：仅对最后一轮（其后无 user 消息的 assistant）开放。
   * 历史轮重生成会把新答案追加到末尾、破坏时间线，故按钮隐藏（见 MessageList / chatStore）。
   */
  canRegenerate?: boolean
}

/**
 * 在不破坏 markdown 结构的前提下把长文本截到 N 字符附近。
 * 优先在段落（\n\n）或行尾切断，次选在标点处，最后兜底硬切。
 * 截断后追加省略号，让折叠预览更自然。
 */
function truncateAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  // 优先段落边界
  const paraBreak = head.lastIndexOf('\n\n')
  if (paraBreak > maxChars * 0.5) return head.slice(0, paraBreak) + '\n\n...'
  // 其次行尾
  const lineBreak = head.lastIndexOf('\n')
  if (lineBreak > maxChars * 0.6) return head.slice(0, lineBreak) + '\n\n...'
  // 再其次中文标点
  const punctMatch = head.match(/[。！？；，]\s*(?=[^。！？；，]*$)/)
  if (punctMatch && punctMatch.index !== undefined && punctMatch.index > maxChars * 0.7) {
    return head.slice(0, punctMatch.index + 1) + '...'
  }
  // 兜底硬切
  return head + '...'
}

/**
 * 剥离用户消息开头的 [id:mNNNN] 锚点，仅用于 UI 显示。
 * 锚点由 chatStore 在发送时注入（用于 snip 工具按 ID 范围裁剪上下文），
 * 数据库与发送给 LLM 的内容仍保留锚点，只在气泡渲染时隐藏。
 */
const ID_ANCHOR_PREFIX = /^\[id:m\d+\]\s*/
function stripIdAnchor(content: string): string {
  return content.replace(ID_ANCHOR_PREFIX, '')
}

/** 兜底抽取内联 <think> 块，兼容未走 reasoning_content delta 的服务端 */
function extractThinking(content: string): { thinking: string; clean: string } {
  const thinking: string[] = []
  const clean = content.replace(THINK_BLOCK_REGEX, (_, block: string) => {
    const trimmed = block.trim()
    if (trimmed) thinking.push(trimmed)
    return ''
  }).trim()
  return { thinking: thinking.join('\n\n'), clean }
}

/** 仅允许安全协议的链接 */
function safeUrlTransform(url: string): string {
  try {
    const parsed = new URL(url)
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return url
  } catch (parseErr) {
    // 非法 URL 是常见的 markdown 输入，静默降级为空字符串
    void parseErr
  }
  return ''
}

const MessageBubble = memo(function MessageBubble({ message, previousUserMessage, onSaveAnswer, avatarImage, avatarName, avatarRole, avatarId, isLive = false, elapsedSec, canRegenerate = false }: Props) {
  const isUser = message.role === 'user'
  const [saved, setSaved] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** 用户上传图片放大查看：null = 关闭，否则展示对应索引的图片 */
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  useEffect(() => () => { clearTimeout(savedTimerRef.current) }, [])

  // 折叠状态从 chatStore 读取，跨 Virtuoso 卸载/HMR 持久
  // 用 selector 只订阅自己这条消息的折叠态，避免其他消息 toggle 时被无谓重渲染
  const collapsed = useChatStore((s) => s.collapsedMessageIds.has(message.id))
  const toggleMessageCollapsed = useChatStore((s) => s.toggleMessageCollapsed)
  const regenerateAssistantMessage = useChatStore((s) => s.regenerateAssistantMessage)
  const forkAndRegenerate = useChatStore((s) => s.forkAndRegenerate)
  const conversationTree = useChatStore((s) => s.conversationTree)
  const currentConversationId = useChatStore((s) => s.currentConversationId)
  const isLoadingChat = useChatStore((s) => s.isLoading)
  // 会话树版本切换器（v21·phase2）：本条消息若有同轮多版本（同父同角色兄弟），算 ‹k/n›
  const branchInfo = useMemo(() => computeBranchInfo(conversationTree, message.id), [conversationTree, message.id])
  const switchBranch = useCallback(
    (targetIndex: number) => {
      if (!currentConversationId || !branchInfo) return
      const sibling = branchInfo.siblings[targetIndex]
      if (!sibling || targetIndex === branchInfo.index) return
      const tip = findBranchTip(conversationTree, sibling)
      void window.electronAPI
        .forkConversation(currentConversationId, tip)
        .then(() => window.dispatchEvent(new CustomEvent('soul-reload-active-path', { detail: { conversationId: currentConversationId } })))
        .catch((err) => window.electronAPI.logEvent('warn', 'branch-switch-error', err instanceof Error ? err.message : String(err)))
    },
    [branchInfo, conversationTree, currentConversationId],
  )
  const extractedThinking = isUser
    ? { thinking: '', clean: stripIdAnchor(message.content) }
    : extractThinking(message.content)
  const contentForDisplay = extractedThinking.clean
  const reasoning = message.reasoning?.trim() || extractedThinking.thinking
  // 助手消息超过阈值时允许折叠（用户消息通常很短，不折叠）
  const canCollapse = !isUser && contentForDisplay.length > COLLAPSE_THRESHOLD
  // 折叠态展示前 N 字符（尽量在段落边界切断，避免切到 markdown 语法中间）
  const displayContent = canCollapse && collapsed
    ? truncateAtBoundary(contentForDisplay, COLLAPSED_PREVIEW_CHARS)
    : contentForDisplay

  const handleSave = () => {
    if (!onSaveAnswer || !previousUserMessage || saved) return
    onSaveAnswer(previousUserMessage, contentForDisplay)
    setSaved(true)
    clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSaved(false), 3000)
  }

  // v19 (2026-05-21)：复制答案到剪贴板，操作 footer 第三个按钮触发。
  // 失败时静默 console.warn——剪贴板权限失败不阻断主流程。
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const handleCopyAnswer = useCallback(() => {
    if (copied) return
    void (async () => {
      try {
        await navigator.clipboard.writeText(contentForDisplay)
        setCopied(true)
        clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = setTimeout(() => setCopied(false), 2000)
      } catch (err) {
        console.warn('[MessageBubble] 复制答案失败:', err)
      }
    })()
  }, [contentForDisplay, copied])
  useEffect(() => () => { clearTimeout(copiedTimerRef.current) }, [])

  /**
   * markdown 组件渲染器：闭包注入 avatarId + messageId 以拦截 [来源:] chip。
   * avatarId/messageId 都是稳定值，仅在切换分身/消息时重建。
   */
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(avatarId, message.id),
    [avatarId, message.id],
  )

  return (
    <MessageStreamingContext.Provider value={isLive}>
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start gap-3'} animate-fade-in`}>
      {/* AI 消息左侧小头像 */}
      {!isUser && (
        <div className="flex-shrink-0 mt-6">
          <AvatarImage avatarImage={avatarImage} name={avatarName ?? '专家'} size="sm" />
        </div>
      )}

      <div className={`max-w-[75%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        {/* 角色标签：助手消息加 role chip，让"和不同工种专家说话"在视觉上立得住 */}
        {isUser ? (
          <div className="font-game text-[12px] tracking-widest mb-1.5 text-right text-px-primary">
            你
          </div>
        ) : (
          <div className="flex items-center gap-2 mb-1.5">
            <span className="font-game text-[12px] tracking-widest text-px-accent">
              {avatarName ?? '专家'}
            </span>
            {avatarRole && avatarRole !== avatarName && (
              <span
                className="font-game text-[10px] tracking-wider px-1.5 py-0.5
                  border border-px-border bg-px-elevated text-px-text-dim
                  whitespace-nowrap"
                title={avatarRole}
              >
                {avatarRole}
              </span>
            )}
          </div>
        )}

        {/* 消息体 */}
        <div
          className={`relative group px-5 py-4 border-2 font-body text-[14px] leading-relaxed
            ${isUser
              ? 'bg-px-primary/10 text-px-text border-px-primary/30 shadow-pixel-brand'
              : 'bg-px-surface text-px-text border-px-border shadow-pixel-white'
            }`}
        >
          {/*
            v19（2026-05-21）：原来「重新生成 / SAVE」两个按钮 absolute 在右上角，
            遮挡内容、显得乱，且 SAVE 成功后只闪 3s 没明确反馈，用户反馈"功能失效"。
            现挪到气泡底部的 action footer：常驻可见但视觉克制；SAVE 触发后用全局 toast 反馈。
            两个按钮在 JSX 末尾的 footer 块统一渲染，这里只保留消息内容的渲染逻辑。
          */}
          {isUser ? (
            <div className="flex flex-col gap-2">
              {/* 用户上传的图片缩略图（点击在应用内 Lightbox 查看大图） */}
              {message.imageUrls && message.imageUrls.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {message.imageUrls.map((url, i) => (
                    <button
                      key={`img-${i}`}
                      type="button"
                      onClick={() => setLightboxIndex(i)}
                      className="block p-0 bg-transparent border-2 border-px-border hover:border-px-primary
                        focus:outline-none focus:border-px-primary cursor-pointer transition-none"
                      aria-label={`查看图片 ${i + 1} 大图`}
                    >
                      <img
                        src={url}
                        alt={`附图 ${i + 1}`}
                        className="w-20 h-20 object-cover block"
                      />
                    </button>
                  ))}
                </div>
              )}
              {contentForDisplay && (
                <p className="whitespace-pre-wrap">{contentForDisplay}</p>
              )}
              {/* Lightbox：用户上传图片的应用内放大查看，不再跳浏览器 */}
              {lightboxIndex !== null && message.imageUrls && message.imageUrls[lightboxIndex] && (
                <LightboxModal
                  isOpen={true}
                  onClose={() => setLightboxIndex(null)}
                  title="USER IMAGE"
                  subtitle={
                    message.imageUrls.length > 1
                      ? `第 ${lightboxIndex + 1} 张 / 共 ${message.imageUrls.length} 张`
                      : undefined
                  }
                >
                  <img
                    src={message.imageUrls[lightboxIndex]}
                    alt={`附图 ${lightboxIndex + 1}`}
                    className="max-w-full max-h-[80vh] object-contain block"
                  />
                </LightboxModal>
              )}
            </div>
          ) : (
            <div className="prose prose-sm prose-invert max-w-none prose-pixel
              prose-headings:font-game prose-headings:font-bold prose-headings:tracking-wider prose-headings:text-px-text
              prose-p:text-px-text prose-p:leading-[1.75] prose-p:text-[14px] prose-p:font-body
              prose-code:text-px-accent prose-code:bg-px-bg prose-code:px-1.5 prose-code:py-0.5 prose-code:border prose-code:border-px-border prose-code:text-[13px] prose-code:font-mono
              prose-pre:bg-px-bg prose-pre:text-px-text prose-pre:border-2 prose-pre:border-px-border prose-pre:font-mono
              prose-table:border-2 prose-table:border-px-border
              prose-th:border-2 prose-th:border-px-border prose-th:bg-px-elevated prose-th:text-px-text prose-th:px-3 prose-th:py-2 prose-th:font-game
              prose-td:border-2 prose-td:border-px-border prose-td:px-3 prose-td:py-2 prose-td:text-px-text-sec prose-td:font-body
              prose-strong:font-bold prose-strong:text-px-text
              prose-a:text-px-primary prose-a:no-underline hover:prose-a:underline
              prose-li:text-px-text-sec prose-li:marker:text-px-primary prose-li:font-body">
              {reasoning && (
                <details
                  open={isLive || undefined}
                  className="not-prose mb-2 border border-px-border/40 bg-px-bg/50 px-3 py-2"
                >
                  <summary className="font-game text-[10px] tracking-wider text-px-text-dim cursor-pointer">
                    [▷] THINKING ({reasoning.length} 字){isLive ? ' · 思考中…' : ''}
                  </summary>
                  <pre className="mt-2 text-[12px] text-px-text-dim font-mono whitespace-pre-wrap leading-relaxed">
                    {reasoning}
                  </pre>
                </details>
              )}
              {/*
                isLive 占位期（user 提问后到首个 chunk 到达之前）content 为空，
                跳过 ReactMarkdown 渲染。否则 prose 容器会留出 leading-[1.75]
                高度的空行，让"思考中..."占位行被推到一个孤立的空白下方，
                视觉上像空气泡。chart/mermaid/infographic 的"生成中"占位由
                ChartCodeBlock 内部判定，不受此分支影响。
              */}
              {!(isLive && displayContent.length === 0) && (
                <ReactMarkdown
                  remarkPlugins={REMARK_PLUGINS}
                  urlTransform={safeUrlTransform}
                  components={markdownComponents}
                >
                  {displayContent}
                </ReactMarkdown>
              )}
              {canCollapse && (
                <div className="mt-3 -mb-1 pt-2 border-t border-px-border/40 flex items-center justify-between">
                  <span className="font-game text-[10px] text-px-text-dim tracking-wider">
                    {collapsed
                      ? `${contentForDisplay.length} 字 · 已折叠`
                      : `${contentForDisplay.length} 字`}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleMessageCollapsed(message.id)}
                    className="font-game text-[10px] tracking-wider px-2 py-0.5
                      border border-px-border bg-px-elevated text-px-text-dim
                      hover:text-px-primary hover:border-px-primary
                      transition-none"
                    aria-label={collapsed ? '展开完整消息' : '折叠消息'}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? '[▶] 展开' : '[▼] 收起'}
                  </button>
                </div>
              )}
              {/* 决策 B3：generate_document / export_excel 落盘文件卡片 */}
              {message.documentAttachments && message.documentAttachments.length > 0 && (
                <div className="not-prose flex flex-col">
                  {message.documentAttachments.map((att, i) => (
                    <FileCard key={`doc-${message.id}-${i}`} attachment={att} />
                  ))}
                </div>
              )}
              {/*
                v17 deliberation 表达（Phase 1 of human-cognition extension）：
                  - 🤔 [UNCERTAIN] → 认知不确定（数据存疑、推理薄弱）
                  - ↻  [RECONSIDER] → 立场更新（之前认为 X，现在认为 Y）
                文本超过 60 字截断显示，title 给完整原文，鼠标悬停可见。
              */}
              {(message.uncertainMarkers && message.uncertainMarkers.length > 0) ||
              (message.reconsiderMarkers && message.reconsiderMarkers.length > 0) ? (
                <div className="not-prose flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-px-border/40">
                  {message.uncertainMarkers?.map((m, i) => (
                    <span
                      key={`unc-${message.id}-${i}`}
                      title={m}
                      className="font-game text-[10px] tracking-wider px-1.5 py-0.5
                        border border-px-warning/60 text-px-warning bg-px-warning/5"
                    >
                      🤔 {m.length > 60 ? m.slice(0, 60) + '…' : m}
                    </span>
                  ))}
                  {message.reconsiderMarkers?.map((m, i) => (
                    <span
                      key={`rec-${message.id}-${i}`}
                      title={m}
                      className="font-game text-[10px] tracking-wider px-1.5 py-0.5
                        border border-px-accent/60 text-px-accent bg-px-accent/5"
                    >
                      ↻ {m.length > 60 ? m.slice(0, 60) + '…' : m}
                    </span>
                  ))}
                </div>
              ) : null}
              {/*
                v19：工具调用时间线挂到 assistant 消息底下（之前是 ChatWindow 全局唯一一份，
                切对话或重启就丢）。 timeline 持久化在 messages.tool_call_timeline_json 里，
                所以历史会话切回来也能看见当时的工具调用步骤。
                显示条件：有保存的 timeline，或当前消息还在直播（直播期间 entries 会动态追加）。
              */}
              {((message.toolCallTimeline && message.toolCallTimeline.length > 0) || isLive) && (
                <div className="not-prose mt-3 pt-3 border-t border-px-border/40">
                  <ToolCallTimeline
                    entries={message.toolCallTimeline ?? []}
                    isLoading={isLive}
                    elapsedSec={elapsedSec}
                  />
                </div>
              )}
              {/*
                v19：操作 footer —— 把「重新生成」「沉淀知识」两个按钮放到气泡底部。
                设计：
                  - 常驻可见（默认 dim 半透明），hover 时变亮，避免之前 absolute 在右上角
                    且 group-hover 才显示的"功能藏起来 + 遮挡内容"双重问题
                  - 不带边框、文字风格，视觉上不与正文冲突
                  - 仅 assistant 消息显示，且需要至少 previousUserMessage 才能重生成/沉淀
              */}
              {!isUser && previousUserMessage && (
                <div className="not-prose mt-3 pt-2 border-t border-px-border/40 flex items-center gap-3 text-px-text-dim/70">
                  {/* 重新生成仅对最后一轮开放：历史轮重生成会破坏时间线（见 chatStore） */}
                  {currentConversationId && avatarId && canRegenerate && (
                    <button
                      type="button"
                      onClick={() => {
                        void regenerateAssistantMessage(message.id, currentConversationId, avatarId)
                      }}
                      disabled={isLoadingChat}
                      className="font-game text-[11px] tracking-wider
                        hover:text-px-primary
                        disabled:opacity-40 disabled:cursor-not-allowed
                        transition-colors"
                      aria-label="重新生成"
                      title="重新生成（跳过答案缓存，重新调用 LLM）"
                    >
                      ↻ 重新生成
                    </button>
                  )}
                  {/* 换个思路重答（v21·phase2）：非破坏性——保留旧回答为旁支，另起新分支重答 */}
                  {currentConversationId && avatarId && canRegenerate && (
                    <button
                      type="button"
                      onClick={() => {
                        void forkAndRegenerate(message.id, currentConversationId, avatarId)
                      }}
                      disabled={isLoadingChat}
                      className="font-game text-[11px] tracking-wider
                        hover:text-px-primary
                        disabled:opacity-40 disabled:cursor-not-allowed
                        transition-colors"
                      aria-label="换个思路重答"
                      title="换个思路重答（保留当前回答，另起一个版本分支）"
                    >
                      ⑂ 换个思路
                    </button>
                  )}
                  {/* 版本切换器：本轮有多个版本时显示 ‹ k/n ›，可切回旧分支（v21·phase2） */}
                  {branchInfo && (
                    <span className="font-game text-[11px] tracking-wider inline-flex items-center gap-1" aria-label="回答版本切换">
                      <button
                        type="button"
                        onClick={() => switchBranch(branchInfo.index - 1)}
                        disabled={isLoadingChat || branchInfo.index === 0}
                        className="hover:text-px-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        aria-label="上一个版本"
                        title="上一个版本"
                      >
                        ‹
                      </button>
                      <span title="本轮回答版本">{branchInfo.index + 1}/{branchInfo.total}</span>
                      <button
                        type="button"
                        onClick={() => switchBranch(branchInfo.index + 1)}
                        disabled={isLoadingChat || branchInfo.index === branchInfo.total - 1}
                        className="hover:text-px-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        aria-label="下一个版本"
                        title="下一个版本"
                      >
                        ›
                      </button>
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={handleCopyAnswer}
                    disabled={copied}
                    className="font-game text-[11px] tracking-wider
                      hover:text-px-primary
                      disabled:text-px-success disabled:cursor-default
                      transition-colors"
                    aria-label={copied ? '已复制' : '复制答案'}
                    title={copied ? '已复制到剪贴板' : '复制答案到剪贴板（含 markdown）'}
                  >
                    {copied ? '✓ 已复制' : '⎘ 复制答案'}
                  </button>
                  {onSaveAnswer && (
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={saved}
                      className="font-game text-[11px] tracking-wider
                        hover:text-px-primary
                        disabled:text-px-success disabled:cursor-default
                        transition-colors"
                      aria-label={saved ? '已沉淀' : '沉淀到知识百科'}
                      title={saved ? '已沉淀（3 秒后可再次沉淀）' : '沉淀到知识百科'}
                    >
                      {saved ? '✓ 已沉淀' : '⤓ 沉淀知识'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    </MessageStreamingContext.Provider>
  )
})

export default MessageBubble
