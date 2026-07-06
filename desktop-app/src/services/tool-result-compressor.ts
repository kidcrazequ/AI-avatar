/**
 * tool-result-compressor.ts — A3：工具结果确定性统计压缩（借鉴 headroom，零模型调用）。
 *
 * 定位：插在「盲字节截断」与「LLM 摘要」之间的第三条路。对 JSON / 表格 / 多行文本类
 * 工具输出做**行级统计保留**——比盲截断多保住承重信息，又没有 LLM 摘要改写数字的
 * 溯源风险。所有数字与 `[来源: ...]` 锚点字符串**原样保留**（A1 溯源闭集校验依赖
 * 锚点逐字存在），全程零模型调用、纯函数可单测。
 *
 * 行保留规则（命中任一即保留；错误 / 锚点 / query 命中为硬保留，预算再紧也不丢）：
 *   1. 错误行永不丢（error / fail / exception / 错误 / 失败 等关键词表）
 *   2. `[来源: ...]` 锚点所在行永不丢
 *   3. query 关键词命中行（命中面 > 40% 时视为区分度不足，整条规则失效）
 *   4. Pareto 罕见值：字段取值分布 top-K 覆盖 80% 之外的罕见取值所在行
 *   5. 罕见字段（出现率 < 20%）所在行
 *   6. 首 30% / 尾 15% 位置锚点（预算不足时靠中间的先丢，首行 / 末行永不丢）
 * 丢弃行聚合为统计行（"共略 N 行：字段 X 取值分布 值×次数…"），计数与取值全部原样。
 *
 * 规则 0 · 无损重排：均匀 JSON 对象数组（同键集 + 纯标量值）先试转 CSV，
 * 节省 ≥15% 才采用；转完在预算内则全量无损返回，仍超预算则在 CSV 行上继续统计保留。
 *
 * A3-1 · CCR 可逆取回 marker：压缩输出首行形如
 *   `[已压缩 N→M 字符，…，取回原文: read_tool_result(path="<spool绝对路径>")]`
 * read_tool_result 是**已有工具**（electron/main.ts 直接处理，读 ToolResultSpool
 * 落盘文件，path = <userData>/tool-results/<convId>/<toolName>-<ts>.txt）。只有原文
 * 超过 spool 阈值（12000 字符）时才有落盘文件，路径从原文自带的 spool 提示中提取；
 * 未落盘时 marker 如实写"原文未落盘不可取回"——宁缺毋假，不编造取回方式。
 *
 * A3-4 · SUPERSEDED：同工具同参数被再次调用时，旧结果整体替换为一行 marker
 * （headroom 实测约 75% 的历史读字节属此类，零信息损失）；见 markSupersededToolResults。
 */

import type { LLMMessage } from './llm-service'

/** 压缩产物的头部 marker 前缀（幂等判定：以此开头的内容不再二次压缩） */
export const COMPRESSED_MARKER_PREFIX = '[已压缩 '
/** SUPERSEDED 替换 marker 前缀 */
export const SUPERSEDED_MARKER_PREFIX = '[SUPERSEDED]'

/** 错误关键词表：命中行永不丢弃（中英双语，大小写不敏感） */
const ERROR_KEYWORD_REGEX = /error|fail(?:ed|ure|s)?|exception|traceback|fatal|panic|timeout|denied|错误|失败|异常|超时|报错|拒绝|告警/i

/**
 * 来源锚点（raw 口径）。刻意不用 @soul/core 的 extractSourceAnchorsFromContent：
 * 那个函数只返回**可解析且归一化后**的锚点，而本模块的义务是"锚点字符串原样保留"，
 * 必须按原文逐字匹配 / 回填，raw 正则才是正确口径（正则本体与 core 的
 * SOURCE_ANCHOR_REGEX 一致）。
 */
const RAW_ANCHOR_REGEX = /\[来源:\s*[^\]]+\]/g
/** 行级快速判断用前缀（避免 /g 正则 .test 的 lastIndex 状态坑） */
const ANCHOR_HINT = '[来源:'

/** spool 提示中的取回调用形态（tool-result-spool.ts 落盘时原样写入；path 可含空格） */
const SPOOL_RETRIEVE_REGEX = /read_tool_result\(path="([^"]+)"\)/
/** spool 提示的路径行兜底（提示格式变化时的防御） */
const SPOOL_PATH_LINE_REGEX = /已落盘到：\s*\n\s*(\S[^\n]*\.txt)/

// ─── 统计参数（全部为确定性常量） ─────────────────────────────────────────
const HEAD_RATIO = 0.3
const TAIL_RATIO = 0.15
const PARETO_COVERAGE = 0.8
const RARE_FIELD_RATIO = 0.2
/** 行数低于此值不做行级统计（无统计意义），直接走首尾盲截断兜底 */
const MIN_ROWS_FOR_STATS = 5
/** 字段基数超过 min(行数×0.5, 50) 视为高基数（id / 时间戳类），不参与罕见值分析 */
const HIGH_CARDINALITY_RATIO = 0.5
const HIGH_CARDINALITY_ABS = 50
/** query 命中行占比超过此值 → 关键词区分度不足，整条 query 规则失效 */
const QUERY_BROAD_HIT_RATIO = 0.4
/** CSV 无损重排需节省的最小比例（≥15% 才采用） */
const CSV_MIN_SAVING = 0.15
/** marker + 间隙行 + 统计行的预估开销（软预算扣除项） */
const OVERHEAD_ESTIMATE_CHARS = 300

type JsonRow = Record<string, unknown>

export type CompressMethod = 'csv' | 'stats' | 'blind'

export interface CompressToolResultOptions {
  /** 输出目标预算（字符，软约束：硬保留行可超）。内容 ≤ 此值时不压缩 */
  maxChars: number
  /** 用户问题原文，用于关键词命中保留 */
  query?: string
  /**
   * force：上下文溢出自救——统计规则压不动（全是硬保留行）时退化为首尾盲截断，
   * 保生存优先于保完整；standard（默认）：压不动则如实返回 compressed=false。
   */
  mode?: 'standard' | 'force'
}

export interface CompressToolResultOutcome {
  /** 压缩后内容；compressed=false 时为原输入引用 */
  content: string
  compressed: boolean
  originalLength: number
  /** 采用的压缩方法（compressed=false 时为 undefined） */
  method?: CompressMethod
  /** 被丢弃（聚合进统计行）的行数（csv 无损 / blind 模式为 undefined 或 0） */
  droppedRows?: number
}

/**
 * 确定性压缩一条工具结果。零模型调用；数字与 `[来源: ...]` 锚点原样保留。
 *
 * marker 中的 M 指压缩后正文（不含 marker 行本身）的字符数。
 * 保守失败：无行可丢 / 压缩无净收益 → compressed=false 原样返回（除 force 模式）。
 */
export function compressToolResult(content: string, opts: CompressToolResultOptions): CompressToolResultOutcome {
  const originalLength = content.length
  const notCompressed: CompressToolResultOutcome = { content, compressed: false, originalLength }
  if (opts.maxChars <= 0 || originalLength <= opts.maxChars) return notCompressed
  // 幂等：已是本模块压缩产物 → 不二次压缩（二次压缩会丢 marker 里的取回路径）
  if (content.startsWith(COMPRESSED_MARKER_PREFIX) || content.startsWith(SUPERSEDED_MARKER_PREFIX)) {
    return notCompressed
  }

  const retrievalPath = extractSpoolPath(content)

  // 规则 0：均匀 JSON 对象数组先试无损重排为 CSV（键名只出现一次，天然省字节）
  const items = tryParseJsonObjectArray(content)
  let rows: string[]
  let rowObjs: JsonRow[] | null = null
  let csvHeader: string | null = null
  if (items) {
    rowObjs = items
    const csv = tryEncodeCsv(items)
    const csvFullLength = csv ? csv.header.length + 1 + csv.rows.join('\n').length : Number.POSITIVE_INFINITY
    if (csv && csvFullLength <= originalLength * (1 - CSV_MIN_SAVING)) {
      csvHeader = csv.header
      rows = csv.rows
      const csvBody = `${csv.header}\n${csv.rows.join('\n')}`
      const marker = buildCompressionMarker(originalLength, csvBody.length, retrievalPath, 'csv')
      const out = `${marker}\n${csvBody}`
      // CSV 全量已在预算内 → 无损返回，不丢任何行
      if (out.length <= opts.maxChars) {
        return { content: out, compressed: true, originalLength, method: 'csv', droppedRows: 0 }
      }
      // CSV 仍超预算 → 在 CSV 行上继续统计保留（rows/rowObjs 索引一一对应）
    } else {
      rows = items.map((it) => JSON.stringify(it))
    }
  } else {
    rows = content.split('\n')
  }

  if (rows.length >= MIN_ROWS_FOR_STATS) {
    const selection = selectRows(rows, rowObjs, {
      bodyBudget: Math.max(200, opts.maxChars - OVERHEAD_ESTIMATE_CHARS - (csvHeader?.length ?? 0)),
      query: opts.query,
    })
    if (selection.droppedCount === 0) {
      // 全是硬保留行，统计压缩无从下手：standard 宁可不压（错误项永不丢）；force 保生存
      return opts.mode === 'force'
        ? blindTruncate(content, opts.maxChars, retrievalPath, originalLength)
        : notCompressed
    }
    let body = assembleBody(rows, rowObjs, selection, csvHeader)
    body = appendMissingAnchors(content, body)
    const marker = buildCompressionMarker(originalLength, body.length, retrievalPath, 'stats')
    const out = `${marker}\n${body}`
    // 通胀守卫：压完反而更长 → 无净收益，原样返回
    if (out.length >= originalLength) return notCompressed
    return { content: out, compressed: true, originalLength, method: 'stats', droppedRows: selection.droppedCount }
  }

  // 行数太少（单巨行 minified JSON / 大对象）：无统计意义，首尾盲截断兜底
  return blindTruncate(content, opts.maxChars, retrievalPath, originalLength)
}

// ─── A3-4 SUPERSEDED ─────────────────────────────────────────────────────

export interface MarkSupersededOptions {
  /** 只替换 index < endIndex 的旧 tool 结果（保护最近轮次窗口）。默认全部 */
  endIndex?: number
}

export interface MarkSupersededOutcome {
  replacedCount: number
  savedChars: number
}

/**
 * A3-4：同工具同参数被再次调用 → 旧结果就地替换为一行 SUPERSEDED marker。
 *
 * - 参数比较用归一化 key（深层键排序 + 字符串 trim），LLM 现场生成 args 的键序 /
 *   空白差异不会导致漏判；语义不同（值不同）绝不误判
 * - 每组只保留**最新一次**调用的结果原文；最新结果可以在 endIndex 之后（保留区）
 * - 被替换内容里的 `[来源: ...]` 锚点原样并入 marker（A1 闭集不缩水）；spool 取回
 *   路径存在时一并写入（CCR 可逆）
 * - 只改 content、不增删消息 → tool_call 配对结构不可能被破坏
 * - 幂等：已是 SUPERSEDED marker 的内容跳过；marker 比原文长时跳过（反通胀）
 */
export function markSupersededToolResults(
  messages: LLMMessage[],
  opts: MarkSupersededOptions = {},
): MarkSupersededOutcome {
  const endIndex = opts.endIndex ?? messages.length
  const toolMsgIdx = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'tool' && m.tool_call_id) toolMsgIdx.set(m.tool_call_id, i)
  }

  // 同名同参分组（callId 按出现顺序，最后一个为最新）
  const groups = new Map<string, { toolName: string; callIds: string[] }>()
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue
    for (const tc of m.tool_calls) {
      const key = `${tc.function.name} ${normalizeToolArgsForKey(tc.function.arguments)}`
      const group = groups.get(key) ?? { toolName: tc.function.name, callIds: [] }
      group.callIds.push(tc.id)
      groups.set(key, group)
    }
  }

  let replacedCount = 0
  let savedChars = 0
  for (const { toolName, callIds } of groups.values()) {
    if (callIds.length < 2) continue
    for (const callId of callIds.slice(0, -1)) {
      const idx = toolMsgIdx.get(callId)
      if (idx === undefined || idx >= endIndex) continue
      const msg = messages[idx]
      if (typeof msg.content !== 'string') continue
      if (msg.content.startsWith(SUPERSEDED_MARKER_PREFIX)) continue
      const marker = buildSupersededMarker(toolName, msg.content)
      if (marker.length >= msg.content.length) continue
      messages[idx] = { ...msg, content: marker }
      replacedCount++
      savedChars += msg.content.length - marker.length
    }
  }
  return { replacedCount, savedChars }
}

// ─── 内部实现 ─────────────────────────────────────────────────────────────

/** 从内容中提取 spool 落盘文件绝对路径（tool-result-spool.ts 写入的提示格式） */
function extractSpoolPath(content: string): string | undefined {
  const retrieve = SPOOL_RETRIEVE_REGEX.exec(content)
  if (retrieve) return retrieve[1]
  return SPOOL_PATH_LINE_REGEX.exec(content)?.[1]?.trim()
}

/** A3-1 CCR marker。M 为正文（不含 marker 行）字符数。 */
function buildCompressionMarker(
  originalLength: number,
  bodyLength: number,
  retrievalPath: string | undefined,
  method: CompressMethod,
): string {
  const modeText = method === 'csv'
    ? '无损重排 JSON→CSV，全部行列与数值保留'
    : method === 'blind'
      ? '首尾盲截断（统计规则不适用）'
      : '统计保留（错误行 / 来源锚点 / 罕见值 / 首尾行保留，数字原样）'
  const retrieveText = retrievalPath
    ? `取回原文: read_tool_result(path="${retrievalPath}")`
    : '原文未落盘不可取回，不要因压缩重调同参数工具'
  return `${COMPRESSED_MARKER_PREFIX}${originalLength}→${bodyLength} 字符，${modeText}，${retrieveText}]`
}

function buildSupersededMarker(toolName: string, oldContent: string): string {
  const path = extractSpoolPath(oldContent)
  const anchors = Array.from(new Set(oldContent.match(RAW_ANCHOR_REGEX) ?? []))
  const parts = [
    `${SUPERSEDED_MARKER_PREFIX} 工具 ${toolName} 已在后续轮次以相同参数重新调用，本条旧结果（原 ${oldContent.length} 字符）已被最新一次结果取代，请以最新结果为准。`,
    path ? `取回本条原文: read_tool_result(path="${path}")` : '',
    anchors.length > 0 ? `涉及来源锚点：${anchors.join(' ')}` : '',
  ]
  return parts.filter(Boolean).join('\n')
}

/** 归一化 tool args：深层键排序 + 字符串 trim；解析失败按原文 trim（等价写法归一，不做语义归一） */
function normalizeToolArgsForKey(args: string): string {
  const sortDeep = (v: unknown): unknown => {
    if (typeof v === 'string') return v.trim()
    if (Array.isArray(v)) return v.map(sortDeep)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortDeep((v as Record<string, unknown>)[k])
      }
      return out
    }
    return v
  }
  try {
    return JSON.stringify(sortDeep(JSON.parse(args)))
  } catch {
    return args.trim()
  }
}

/** 解析"JSON 对象数组"（≥ MIN_ROWS_FOR_STATS 个元素、元素均为对象）；否则 null */
function tryParseJsonObjectArray(content: string): JsonRow[] | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith('[')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!Array.isArray(parsed) || parsed.length < MIN_ROWS_FOR_STATS) return null
    if (!parsed.every((it) => it !== null && typeof it === 'object' && !Array.isArray(it))) return null
    return parsed as JsonRow[]
  } catch {
    return null
  }
}

/**
 * 均匀数组（同键集 + 纯标量值）→ CSV。键集或标量性不满足返回 null。
 * 数字用 String(v) 渲染，与 JSON 数字字面量逐字一致；null/undefined 渲染为空单元格。
 */
function tryEncodeCsv(items: JsonRow[]): { header: string; rows: string[] } | null {
  const keys = Object.keys(items[0] ?? {})
  if (keys.length === 0) return null
  const keySet = new Set(keys)
  for (const it of items) {
    const ks = Object.keys(it)
    if (ks.length !== keys.length) return null
    for (const k of ks) {
      if (!keySet.has(k)) return null
      const v = it[k]
      if (v !== null && typeof v === 'object') return null
    }
  }
  const esc = (raw: string): string => (/[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw)
  const cell = (v: unknown): string => (v === null || v === undefined ? '' : esc(typeof v === 'string' ? v : String(v)))
  return {
    header: keys.map(esc).join(','),
    rows: items.map((it) => keys.map((k) => cell(it[k])).join(',')),
  }
}

/** query 分词：ASCII 词 ≥2 字符；汉字串 2-4 字整用，>4 字切 2 字 shingle；上限 20 个 */
function tokenizeQuery(query: string | undefined): string[] {
  if (!query) return []
  const raw = query.match(/[\p{Script=Han}]+|[A-Za-z0-9_.\-%]{2,}/gu) ?? []
  const tokens: string[] = []
  for (const t of raw) {
    if (/^[\p{Script=Han}]+$/u.test(t)) {
      if (t.length < 2) continue
      if (t.length <= 4) tokens.push(t)
      else for (let i = 0; i + 2 <= t.length; i += 2) tokens.push(t.slice(i, i + 2))
    } else {
      tokens.push(t.toLowerCase())
    }
  }
  return Array.from(new Set(tokens)).slice(0, 20)
}

interface RowSelection {
  keep: boolean[]
  droppedCount: number
  droppedIdx: number[]
}

/**
 * 行级选择。硬保留（错误 / 锚点 / query 命中）不受预算约束；
 * 软保留（罕见值 3 > 罕见字段 2 > 首尾位置 1）在超预算时按层级从低到高、
 * 位置行从靠中间的先丢；首行 / 末行视作硬保留。
 */
function selectRows(
  rows: string[],
  objs: JsonRow[] | null,
  opts: { bodyBudget: number; query?: string },
): RowSelection {
  const n = rows.length
  const hard = new Array<boolean>(n).fill(false)
  const softTier = new Array<number>(n).fill(0)

  // 规则 1/2：错误行、锚点行硬保留；首行 / 末行为最小位置锚点，同样硬保留
  hard[0] = true
  hard[n - 1] = true
  for (let i = 0; i < n; i++) {
    if (ERROR_KEYWORD_REGEX.test(rows[i]) || rows[i].includes(ANCHOR_HINT)) hard[i] = true
  }

  // 规则 3：query 关键词命中（命中面过宽 → 规则失效）
  const tokens = tokenizeQuery(opts.query)
  if (tokens.length > 0) {
    const hits: number[] = []
    for (let i = 0; i < n; i++) {
      const lower = rows[i].toLowerCase()
      if (tokens.some((t) => lower.includes(t))) hits.push(i)
    }
    if (hits.length > 0 && hits.length / n <= QUERY_BROAD_HIT_RATIO) {
      for (const i of hits) hard[i] = true
    }
  }

  // 规则 4/5：字段统计（仅 JSON 对象行可用）
  if (objs) {
    const presence = new Map<string, number>()
    const valueCounts = new Map<string, Map<string, number> | null>()
    for (const it of objs) {
      for (const [k, v] of Object.entries(it)) {
        presence.set(k, (presence.get(k) ?? 0) + 1)
        if (v !== null && typeof v === 'object') {
          valueCounts.set(k, null) // 非标量字段不做取值分布
          continue
        }
        let counts = valueCounts.get(k)
        if (counts === null) continue
        if (!counts) {
          counts = new Map()
          valueCounts.set(k, counts)
        }
        const sv = String(v)
        counts.set(sv, (counts.get(sv) ?? 0) + 1)
      }
    }
    const cardinalityCap = Math.min(HIGH_CARDINALITY_ABS, Math.floor(n * HIGH_CARDINALITY_RATIO))
    const rareFieldKeys = new Set<string>()
    const rareValuesByField = new Map<string, Set<string>>()
    for (const [k, count] of presence) {
      if (count / n < RARE_FIELD_RATIO) rareFieldKeys.add(k)
      const counts = valueCounts.get(k)
      // 罕见值分析：常见字段（出现率 ≥50%）且非高基数
      if (!counts || count < n * 0.5 || counts.size > cardinalityCap) continue
      const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      let cumulative = 0
      const rare = new Set<string>()
      let covered = false
      for (const [value, c] of sorted) {
        if (covered) {
          rare.add(value)
        } else {
          cumulative += c
          if (cumulative >= count * PARETO_COVERAGE) covered = true
        }
      }
      if (rare.size > 0) rareValuesByField.set(k, rare)
    }
    for (let i = 0; i < n; i++) {
      const it = objs[i]
      for (const k of Object.keys(it)) {
        if (rareFieldKeys.has(k)) softTier[i] = Math.max(softTier[i], 2)
        const rare = rareValuesByField.get(k)
        const v = it[k]
        if (rare && (v === null || typeof v !== 'object') && rare.has(String(v))) {
          softTier[i] = Math.max(softTier[i], 3)
        }
      }
    }
  }

  // 规则 6：首 30% / 尾 15% 位置锚点
  const headCount = Math.ceil(n * HEAD_RATIO)
  const tailCount = Math.ceil(n * TAIL_RATIO)
  for (let i = 0; i < headCount; i++) softTier[i] = Math.max(softTier[i], 1)
  for (let i = n - tailCount; i < n; i++) softTier[i] = Math.max(softTier[i], 1)

  const keep = hard.map((h, i) => h || softTier[i] > 0)

  // 软预算：超预算时按 (层级升序, 位置行深者先丢 / 罕见行居中者先丢) 逐个丢弃
  let total = 0
  for (let i = 0; i < n; i++) if (keep[i]) total += rows[i].length + 1
  if (total > opts.bodyBudget) {
    const droppable: number[] = []
    for (let i = 0; i < n; i++) if (keep[i] && !hard[i]) droppable.push(i)
    const depth = (i: number): number => Math.min(i, n - 1 - i) // 距最近边缘的深度
    droppable.sort((a, b) => {
      if (softTier[a] !== softTier[b]) return softTier[a] - softTier[b]
      if (softTier[a] === 1) return depth(b) - depth(a) // 位置行：靠中间（深）的先丢
      return Math.abs(a - (n - 1) / 2) - Math.abs(b - (n - 1) / 2) // 其余：居中的先丢
    })
    for (const i of droppable) {
      if (total <= opts.bodyBudget) break
      keep[i] = false
      total -= rows[i].length + 1
    }
  }

  const droppedIdx: number[] = []
  for (let i = 0; i < n; i++) if (!keep[i]) droppedIdx.push(i)
  return { keep, droppedCount: droppedIdx.length, droppedIdx }
}

/** 按保留结果组装正文：保留行原样、连续丢弃段折叠为间隙行、末尾追加统计聚合行 */
function assembleBody(
  rows: string[],
  objs: JsonRow[] | null,
  selection: RowSelection,
  csvHeader: string | null,
): string {
  const lines: string[] = []
  if (csvHeader) lines.push(csvHeader)
  let i = 0
  while (i < rows.length) {
    if (selection.keep[i]) {
      lines.push(rows[i])
      i++
      continue
    }
    let j = i
    while (j < rows.length && !selection.keep[j]) j++
    lines.push(`[…略 ${j - i} 行]`)
    i = j
  }
  if (selection.droppedCount > 0) {
    lines.push(buildStatsLine(selection.droppedIdx, objs))
  }
  return lines.join('\n')
}

/** 统计聚合行："共略 N 行：字段 X 取值分布 值×次数…"（最多 2 个字段、每字段 top5 + 其余） */
function buildStatsLine(droppedIdx: number[], objs: JsonRow[] | null): string {
  const base = `[统计] 共略 ${droppedIdx.length} 行`
  if (!objs) return base
  // 选分布字段：全体行上 2 ≤ 基数 ≤ 8 的标量字段，按基数升序取前 2
  const counts = new Map<string, Map<string, number>>()
  for (const it of objs) {
    for (const [k, v] of Object.entries(it)) {
      if (v !== null && typeof v === 'object') continue
      const m = counts.get(k) ?? new Map<string, number>()
      m.set(String(v), (m.get(String(v)) ?? 0) + 1)
      counts.set(k, m)
    }
  }
  const fields = Array.from(counts.entries())
    .filter(([, m]) => m.size >= 2 && m.size <= 8)
    .sort((a, b) => a[1].size - b[1].size || (a[0] < b[0] ? -1 : 1))
    .slice(0, 2)
    .map(([k]) => k)
  if (fields.length === 0) return base

  const parts: string[] = []
  for (const field of fields) {
    const dist = new Map<string, number>()
    for (const i of droppedIdx) {
      const v = objs[i]?.[field]
      if (v === undefined || (v !== null && typeof v === 'object')) continue
      const sv = String(v)
      dist.set(sv, (dist.get(sv) ?? 0) + 1)
    }
    if (dist.size === 0) continue
    const sorted = Array.from(dist.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    const top = sorted.slice(0, 5).map(([v, c]) => `${v}×${c}`)
    const rest = sorted.slice(5).reduce((acc, [, c]) => acc + c, 0)
    parts.push(`字段 ${field} 取值分布 ${top.join('、')}${rest > 0 ? `、其余×${rest}` : ''}`)
  }
  return parts.length > 0 ? `${base}：${parts.join('；')}` : base
}

/**
 * 锚点保底：原文中的 `[来源: ...]` 若未逐字出现在压缩正文中，追加回填行。
 * 正常路径下锚点行已被硬保留，此处只是最后一道不变量防线（A1 溯源闭集依赖）。
 */
function appendMissingAnchors(original: string, body: string): string {
  const anchors = Array.from(new Set(original.match(RAW_ANCHOR_REGEX) ?? []))
  const missing = anchors.filter((a) => !body.includes(a))
  if (missing.length === 0) return body
  return `${body}\n[来源锚点保留] ${missing.join(' ')}`
}

/** 兜底：首 55% + 尾 20% 预算的盲截断（headroom 头尾式），锚点回填 + CCR marker */
function blindTruncate(
  content: string,
  maxChars: number,
  retrievalPath: string | undefined,
  originalLength: number,
): CompressToolResultOutcome {
  const budget = Math.max(400, maxChars)
  const headLen = Math.max(200, Math.floor(budget * 0.55))
  const tailLen = Math.max(100, Math.floor(budget * 0.2))
  const head = content.slice(0, headLen)
  const tail = content.slice(-tailLen)
  let body = `${head}\n[…已截断中段…]\n${tail}`
  body = appendMissingAnchors(content, body)
  const marker = buildCompressionMarker(originalLength, body.length, retrievalPath, 'blind')
  const out = `${marker}\n${body}`
  if (out.length >= originalLength) return { content, compressed: false, originalLength }
  return { content: out, compressed: true, originalLength, method: 'blind' }
}
