/**
 * 知识库 .md 文件 frontmatter 解析、增强、合并工具。
 *
 * 纯函数，不依赖 Node 内建模块，可在主进程和渲染进程共用。
 *
 * @author zhi.qu
 * @date 2026-05-02
 */

// ─── 类型 ─────────────────────────────────────────────────────────────────────

export interface FrontmatterParseResult {
  meta: Record<string, unknown>
  body: string
}

// ─── 解析 ─────────────────────────────────────────────────────────────────────

/**
 * 解析 YAML frontmatter（key: value + 简单数组）。
 *
 * @example
 * const { meta, body } = parseFrontmatterCore('---\nsource: excel\n---\nHello')
 * // meta = { source: 'excel' }, body = 'Hello'
 */
export function parseFrontmatterCore(src: string): FrontmatterParseResult {
  if (!src.startsWith('---\n') && !src.startsWith('---\r\n')) {
    return { meta: {}, body: src }
  }
  const endMatch = src.match(/\n---\r?\n/)
  if (!endMatch || endMatch.index === undefined) {
    return { meta: {}, body: src }
  }
  const fmText = src.slice(4, endMatch.index)
  const body = src.slice(endMatch.index + endMatch[0].length)
  const meta: Record<string, unknown> = {}
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const raw = m[2].trim()
    if (raw === 'true') meta[key] = true
    else if (raw === 'false') meta[key] = false
    else if (raw.startsWith('[') && raw.endsWith(']')) {
      meta[key] = raw.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      meta[key] = raw.replace(/^["']|["']$/g, '')
    }
  }
  return { meta, body }
}

// ─── 字段增强 ──────────────────────────────────────────────────────────────────

const CATEGORY_RULES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /FMEA|DFMEA|PFMEA/i, label: '失效分析' },
  { pattern: /SOP|作业指导|装配说明|安装指导/i, label: '操作规程' },
  { pattern: /用户手册|操作手册|产品手册/, label: '用户手册' },
  { pattern: /技术规范|技术协议|规格书/, label: '技术规格' },
  { pattern: /检验指导|检验标准|检测报告|测试报告|试验报告/, label: '质量检测' },
  { pattern: /仿真报告/, label: '仿真分析' },
  { pattern: /流程图|拓扑图|接线图/, label: '图纸' },
  { pattern: /问题记录|整改清单|反馈/, label: '问题跟踪' },
  { pattern: /包装方案/, label: '包装物流' },
]

/**
 * 行业术语表，用于从正文中提取中文关键词。
 * 按分身领域可扩展，当前为工商业储能领域。
 */
const INDUSTRY_TERMS: readonly string[] = [
  '储能', '电芯', '模组', 'BMS', 'PCS', 'EMS', '液冷', '柜体',
  '检验', 'DFMEA', 'PPAP', '逆变器', '变压器', '电池', '充放电',
  '并网', '离网', '消防', '温控', '绝缘', '接地', '短路',
  '过流', '过压', '欠压', 'SOC', 'SOH', 'CAN', 'RS485',
  '电池包', '热管理', '电池簇', '汇流柜', '配电柜', '变流器',
]

/** 已知文档类型后缀，用于文件名中文分词拆分 */
const DOC_TYPE_SUFFIXES: readonly string[] = [
  '技术规范书', '技术协议书', '作业指导书', '技术规范', '规格书',
  '操作手册', '用户手册', '产品手册', '安装指导', '使用说明',
  '检验报告', '测试报告', '仿真报告', '设计说明', '整改报告',
  '技术方案', '解决方案', '包装方案',
]

/**
 * 从文件名和正文中规则化提取增强 frontmatter 字段（不做 LLM 摘要）。
 *
 * 返回的对象只包含成功提取的字段，调用方用 `mergeFrontmatter` 合入已有 meta。
 */
export function extractFrontmatterFields(
  fileName: string,
  bodyText: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}

  const nameNoExt = fileName.replace(/\.[^.]+$/, '')

  // title：清洗文件名噪声 → 人类可读标题
  const title = nameNoExt
    .replace(/_\(\d+\)_?/g, '')        // 去下载去重后缀 _(1)
    .replace(/_\d+_(?=\.|$)/g, '')     // 去 _1_ / _2_ 尾部噪声
    .replace(/__+/g, '_')              // 折叠连续下划线
    .replace(/^_|_$/g, '')             // 去首尾下划线
    .trim()
  if (title && title !== nameNoExt) fields.title = title

  // model：ENS-Lxxx 产品型号
  const corpus = nameNoExt + ' ' + bodyText.slice(0, 2000)
  const modelMatch = corpus.match(/ENS-L\d+(?:-\d+)?/i)
  if (modelMatch) fields.model = modelMatch[0].toUpperCase()

  // version：_vN / _VN.M / Rev_X
  const verMatch = nameNoExt.match(/[_-][vV](\d+(?:[._]\d+)*)/)
    || nameNoExt.match(/Rev[_-]?([A-Za-z0-9]+)/i)
  if (verMatch) fields.version = verMatch[0].replace(/^[_-]/, '')

  // category：按文件名 + 正文前 500 字匹配规则
  const catCorpus = nameNoExt + ' ' + bodyText.slice(0, 500)
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(catCorpus)) {
      fields.category = rule.label
      break
    }
  }

  // keywords：产品编码 + 标题 + 行业术语 + 表格首列 + 文件名分词，取前 8 个
  const kws = extractKeywords(bodyText, nameNoExt, 8)
  if (kws.length > 0) fields.keywords = kws

  // summary：首段有意义文本，含多级 fallback 策略
  const summary = extractSummary(bodyText, nameNoExt)
  if (summary) fields.summary = summary

  return fields
}

/**
 * 从正文 + 文件名中提取关键词，5 个来源按优先级依次尝试：
 *   1. 产品编码正则（英文大写编码）
 *   2. Markdown 标题
 *   3. 中文行业术语（INDUSTRY_TERMS 配置表）
 *   4. 表格首列高频值
 *   5. 文件名中文片段分词
 */
function extractKeywords(
  bodyText: string,
  nameNoExt: string,
  maxCount: number,
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  const push = (kw: string) => {
    const key = kw.toLowerCase()
    if (seen.has(key) || kw.length < 2) return
    seen.add(key)
    result.push(kw)
  }
  const isFull = () => result.length >= maxCount

  // 来源 1：产品编码（ENS-xxx / DPX-xxx / FF_xx 等）
  for (const m of bodyText.slice(0, 3000).matchAll(/\b([A-Z]{2,5}-[A-Z0-9][-A-Z0-9_]{2,})\b/gi)) {
    push(m[1].toUpperCase())
    if (isFull()) return result
  }

  // 来源 2：markdown 标题（2-25 字短标题更有关键词价值）
  for (const m of bodyText.matchAll(/^#{1,3}\s+(.{2,25})$/gm)) {
    const heading = m[1].trim().replace(/[*_`]/g, '')
    push(heading)
    if (isFull()) return result
  }

  // 来源 3：中文行业术语（从正文前 3000 字匹配 INDUSTRY_TERMS）
  const termCorpus = bodyText.slice(0, 3000)
  for (const term of INDUSTRY_TERMS) {
    if (termCorpus.includes(term)) {
      push(term)
      if (isFull()) return result
    }
  }

  // 来源 4：表格首列高频值（频次 ≥ 2，长度 ≤ 10 字）
  for (const kw of extractTableFirstColKeywords(bodyText)) {
    push(kw)
    if (isFull()) return result
  }

  // 来源 5：文件名中文片段分词（去除数字/版本号/日期）
  for (const kw of extractChineseSegmentsFromName(nameNoExt)) {
    push(kw)
    if (isFull()) return result
  }

  return result
}

/**
 * 扫描 markdown 表格首列，返回出现频次 ≥ 2 且长度 ≤ 10 的非空值（按频次降序）。
 */
function extractTableFirstColKeywords(bodyText: string): string[] {
  const freq = new Map<string, number>()
  for (const line of bodyText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    if (/^\|[\s:-]+\|/.test(trimmed)) continue
    const cols = trimmed.split('|').filter(Boolean)
    if (cols.length === 0) continue
    const val = cols[0].trim()
    if (val.length < 2 || val.length > 10) continue
    if (/^\d+$/.test(val) || /^[-—_=]+$/.test(val)) continue
    freq.set(val, (freq.get(val) ?? 0) + 1)
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([val]) => val)
}

/**
 * 从文件名提取中文片段关键词。
 * 去除数字、英文单位（kWh/Ah/V）、版本号、日期后，按非中文字符分割，
 * 超长片段尝试按 DOC_TYPE_SUFFIXES 拆分。
 */
function extractChineseSegmentsFromName(nameNoExt: string): string[] {
  const cleaned = nameNoExt
    .replace(/\d+[kK][wW][hH]/g, '')
    .replace(/\d+[aA][hH]/g, '')
    .replace(/\d+[vV]\b/g, '')
    .replace(/[vV]\d+(\.\d+)*/g, '')
    .replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, '')
    .replace(/\d+/g, '')
    .replace(/[a-zA-Z]+/g, '')
    .replace(/[_\-.()[\]{}【】（）《》]/g, '')

  const segments = cleaned.split(/[^\u4e00-\u9fff]+/).filter(s => s.length >= 2)
  const result: string[] = []

  for (const seg of segments) {
    if (seg.length <= 8) {
      result.push(seg)
      continue
    }
    let split = false
    for (const suffix of DOC_TYPE_SUFFIXES) {
      if (seg.endsWith(suffix) && seg.length > suffix.length) {
        const prefix = seg.slice(0, -suffix.length)
        if (prefix.length >= 2) result.push(prefix)
        result.push(suffix)
        split = true
        break
      }
    }
    if (!split) {
      result.push(seg.slice(0, 10))
    }
  }

  return result.filter(s => s.length >= 2 && s.length <= 10)
}

/**
 * 提取正文首段有意义文本作为 summary（≤ 200 字）。
 *
 * 主逻辑扫描前 50 行找段落文本；失败后依次尝试 4 级 fallback：
 *   a. 第一个 markdown 标题
 *   b. "> 导入自 …" 行
 *   c. 表格首行前 3 列拼接
 *   d. 文件名清洗生成描述
 */
function extractSummary(bodyText: string, nameNoExt: string): string {
  const lines = bodyText.split('\n')
  const truncate = (s: string) => (s.length > 200 ? s.slice(0, 200) + '…' : s)

  // 主逻辑：扫描前 50 行，找首段有意义段落文本
  for (const line of lines.slice(0, 50)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    if (trimmed.startsWith('|') || trimmed.startsWith('---')) continue
    if (trimmed.startsWith('>') && trimmed.length < 20) continue
    if (trimmed.startsWith('<!--')) continue

    const clean = trimmed.replace(/[*_`]/g, '').trim()
    if (clean.length < 5) continue
    return truncate(clean)
  }

  // fallback a：取第一个 markdown 标题
  const headingMatch = bodyText.match(/^#{1,3}\s+(.+)$/m)
  if (headingMatch) {
    const heading = headingMatch[1].trim().replace(/[*_`]/g, '')
    if (heading.length >= 3) return truncate(heading)
  }

  // fallback b：取 "> 导入自" 行的信息
  const importMatch = bodyText.match(/^>\s*导入自\s*(.+)$/m)
  if (importMatch) {
    const info = importMatch[1].trim()
    if (info.length >= 3) return truncate(`导入自 ${info}`)
  }

  // fallback c：取表格首行（非分隔行）前 3 列拼接
  for (const line of lines.slice(0, 50)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    if (/^\|[\s:-]+\|/.test(trimmed)) continue
    const cols = trimmed.split('|').filter(Boolean).map(c => c.trim()).filter(Boolean)
    if (cols.length === 0) continue
    const joined = cols.slice(0, 3).join(' | ')
    if (joined.length >= 3) return truncate(joined)
  }

  // fallback d：从文件名清洗生成描述
  if (nameNoExt) {
    const desc = nameNoExt
      .replace(/_\(\d+\)_?/g, '')
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (desc.length >= 3) return truncate(desc)
  }

  return ''
}

// ─── 合并 ─────────────────────────────────────────────────────────────────────

/**
 * 合并旧 frontmatter 与新字段：旧用户字段保留，新系统字段覆盖。
 *
 * @example
 * mergeFrontmatter(
 *   { source: 'excel', raw_file: '_raw/foo.xlsx', my_note: '手工备注' },
 *   { source: 'enhanced', title: 'foo', keywords: ['A', 'B'] },
 * )
 * // → { source: 'enhanced', raw_file: '_raw/foo.xlsx', my_note: '手工备注', title: 'foo', keywords: ['A', 'B'] }
 */
export function mergeFrontmatter(
  oldMeta: Record<string, unknown>,
  newMeta: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...oldMeta, ...newMeta }
  for (const key of Object.keys(merged)) {
    if (merged[key] === null || merged[key] === undefined || merged[key] === '') {
      delete merged[key]
    }
  }
  return merged
}

// ─── 序列化 ────────────────────────────────────────────────────────────────────

/** 字段输出顺序（系统字段在前，增强字段在后） */
const FIELD_ORDER = [
  'rag_only', 'source', 'raw_file', 'excel_json', 'sheets',
  'title', 'model', 'version', 'category', 'keywords', 'summary',
]

/**
 * 将 meta 对象序列化为 YAML frontmatter 块（含首尾 `---`）。
 *
 * @example
 * buildFrontmatterBlock({ source: 'excel', title: 'Foo' })
 * // → '---\nsource: excel\ntitle: Foo\n---'
 */
export function buildFrontmatterBlock(meta: Record<string, unknown>): string {
  const lines = ['---']
  const keys = Object.keys(meta)

  const ordered = [
    ...FIELD_ORDER.filter(k => keys.includes(k)),
    ...keys.filter(k => !FIELD_ORDER.includes(k)),
  ]

  for (const key of ordered) {
    const value = meta[key]
    if (value === null || value === undefined || value === '') continue
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(v => `"${String(v).replace(/"/g, '\\"')}"`).join(', ')}]`)
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value}`)
    } else {
      lines.push(`${key}: ${String(value)}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}
