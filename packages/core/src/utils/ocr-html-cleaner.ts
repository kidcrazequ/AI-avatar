/**
 * OCR HTML → Markdown 清洗器
 *
 * 将 Qwen VL OCR 返回的 HTML 格式转换为干净的 Markdown 纯文本，
 * 消除 HTML 标签噪音，提升知识检索精度。
 *
 * @author zhi.qu
 * @date 2026-04-02
 */

/**
 * 通用的噪音模式（页码、分隔线等，适用于所有文档）。
 * 厂商特定的模式通过 cleanOcrHtml / cleanPdfFullText 的 extraPatterns 参数传入。
 */
const COMMON_NOISE_PATTERNS: RegExp[] = [
  /^\s*\d+\s*\/\s*\d+\s*$/gm,           // "12 / 42" 页码
  /^--\s*\d+\s+of\s+\d+\s*--$/gm,       // "-- 12 of 42 --"
]

/** 远景能源默认噪音模式（向后兼容，不传 extraPatterns 时使用） */
const ENVISION_OCR_NOISE: RegExp[] = [
  /©远景能源有限公司/g,
  /Envision/gi,
  /^远景能源\s*ENS-L\d+.*用户手册\s*$/gm, // 页眉
]

const ENVISION_PDF_NOISE: RegExp[] = [
  /^©远景能源有限公司\s*\d+\s*\/\s*\d+\s*$/gm,        // "©远景能源有限公司 12 / 42"
  /^远景能源\s+ENS-L\d+\s+工商业储能一体机用户手册$/gm, // 页眉
  /^©远景能源有限公司$/gm,                               // 独立页脚
  /^Envision$/gm,                                       // 独立品牌名
]

/**
 * 将 HTML 表格转换为 Markdown 表格
 *
 * 输入：<table><tbody><tr><td>A</td><td>B</td></tr>...</tbody></table>
 * 输出：| A | B |\n|---|---|\n...
 */
function htmlTableToMarkdown(tableHtml: string): string {
  const rows: string[][] = []
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let trMatch: RegExpExecArray | null

  while ((trMatch = trRegex.exec(tableHtml)) !== null) {
    const cells: string[] = []
    const tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
    let tdMatch: RegExpExecArray | null
    while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
      cells.push(tdMatch[1].replace(/<[^>]+>/g, '').trim())
    }
    if (cells.length > 0) rows.push(cells)
  }

  if (rows.length === 0) return ''

  const maxCols = Math.max(...rows.map(r => r.length))
  const normalized = rows.map(r => {
    while (r.length < maxCols) r.push('')
    return r
  })

  const lines: string[] = []
  lines.push('| ' + normalized[0].join(' | ') + ' |')
  lines.push('| ' + normalized[0].map(() => '---').join(' | ') + ' |')
  for (let i = 1; i < normalized.length; i++) {
    lines.push('| ' + normalized[i].join(' | ') + ' |')
  }

  return lines.join('\n')
}

/** OCR HTML 和 PDF 全文的最大处理长度（512KB），超出截断防止主线程阻塞 */
const MAX_CLEAN_LENGTH = 512 * 1024

/**
 * 清洗 OCR HTML 为 Markdown 纯文本
 *
 * 处理规则：
 * - <h1~h6> → Markdown 标题（#~######）
 * - <table>  → Markdown 表格
 * - <li>     → 列表项（- item）
 * - <p>      → 段落文本
 * - <img>    → 移除（无实际图片数据）
 * - 页眉/页脚噪音 → 移除
 */
export function cleanOcrHtml(html: string, extraPatterns?: RegExp[]): string {
  if (!html || !html.includes('<')) return html

  // 超大输入截断，防止多轮全局正则阻塞主线程
  let text = html.length > MAX_CLEAN_LENGTH
    ? html.slice(0, MAX_CLEAN_LENGTH) + '\n[内容过长，已截断]'
    : html

  // 去除 code fence 包裹
  text = text.replace(/^```html\s*/i, '').replace(/```\s*$/, '')

  // 去除 <html><body> 包裹
  text = text.replace(/<\/?html[^>]*>/gi, '')
  text = text.replace(/<\/?body[^>]*>/gi, '')

  // 表格 → Markdown 表格（在剥离其他标签之前处理）
  text = text.replace(/<div[^>]*class="table"[^>]*>([\s\S]*?)<\/div>/gi, (_m, inner) => {
    return '\n' + htmlTableToMarkdown(inner) + '\n'
  })
  text = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner) => {
    return '\n' + htmlTableToMarkdown(`<table>${inner}</table>`) + '\n'
  })

  // 标题 → Markdown 标题
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, c) => `\n# ${c.trim()}\n`)
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, c) => `\n## ${c.trim()}\n`)
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, c) => `\n### ${c.trim()}\n`)
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_m, c) => `\n#### ${c.trim()}\n`)
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_m, c) => `\n##### ${c.trim()}\n`)
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_m, c) => `\n###### ${c.trim()}\n`)

  // 列表 → Markdown 列表
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, c) => `- ${c.replace(/<[^>]+>/g, '').trim()}\n`)
  text = text.replace(/<\/?[uo]l[^>]*>/gi, '\n')

  // 段落 → 换行文本
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, c) => {
    const clean = c.replace(/<[^>]+>/g, '').trim()
    return clean ? `${clean}\n` : ''
  })

  // 图片占位 → 移除（OCR 中的 <img> 无实际数据）
  text = text.replace(/<div[^>]*class="image"[^>]*>[\s\S]*?<\/div>/gi, '')
  text = text.replace(/<img[^>]*\/?>/gi, '')

  // 剥离所有剩余 HTML 标签
  text = text.replace(/<[^>]+>/g, '')

  // 去除页眉页脚噪音（通用 + 厂商特定）
  const noisePatterns = [...COMMON_NOISE_PATTERNS, ...(extraPatterns ?? ENVISION_OCR_NOISE)]
  for (const pattern of noisePatterns) {
    text = text.replace(pattern, '')
  }

  // HTML 实体解码
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

  // 清理多余空行（保留最多两个连续换行）
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.trim()

  return text
}

/**
 * 清洗 PDF 全文提取的原始文本
 *
 * 移除 pdf-parse 提取中夹带的页眉、页脚、页码等噪音。
 * 不改变内容结构，仅去噪。
 */
export function cleanPdfFullText(rawText: string, extraPatterns?: RegExp[]): string {
  // 超大输入截断
  let text = rawText.length > MAX_CLEAN_LENGTH
    ? rawText.slice(0, MAX_CLEAN_LENGTH) + '\n[内容过长，已截断]'
    : rawText

  const noisePatterns = [...COMMON_NOISE_PATTERNS, ...(extraPatterns ?? ENVISION_PDF_NOISE)]
  for (const pattern of noisePatterns) {
    text = text.replace(pattern, '')
  }

  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/**
 * 清理 LLM 输出中的代码围栏包裹和尾部元信息
 *
 * @author zhi.qu
 * @date 2026-04-02
 */
export function cleanLlmOutput(text: string): string {
  let cleaned = text

  // 去除 ```markdown ... ``` 包裹
  cleaned = cleaned.replace(/^```(?:markdown)?\s*\n?/i, '')
  cleaned = cleaned.replace(/\n?```\s*$/, '')

  // 去除开头的 LLM 工作流程自述（凡以"根据"开头、一直到第一个 --- 分隔线之前的段落）
  // 覆盖常见变体：根据「xxx技能」规范/要求/流程、根据知识库约束、根据用户指令 等
  cleaned = cleaned.replace(
    /^根据[\s\S]*?\n---\n/,
    ''
  )

  // 去除尾部的行动建议、签名等（如"小堵 敬上"、"文档图片识别技能执行完毕"、"下一步行动建议"）
  // 注：允许 --- 后跟任意前缀空格/emoji，再出现关键文本
  cleaned = cleaned.replace(
    /\n+---\s*\n+(?:###?\s*(?:下一步|行动建议)|如需(?:我|基于)|小堵\s*敬上|\s*[✅☑]?\s*文档图片识别技能执行完毕)[\s\S]*$/,
    ''
  )

  // 去除尾部 LLM 自评（如 "> 以上文档..." "---\n> 整理完成" 等）
  cleaned = cleaned.replace(/\n+---\s*\n+>\s*(?:以上|整理|本文档|注：).+$/s, '')

  // 去除残留的 Vision 插入注释标记
  cleaned = cleaned.replace(/<!--\s*以下为第\d+页图片中提取的结构化数据.*?-->\n?/g, '')

  // 先替换有语义的 emoji 为文字（必须在广泛删除之前，否则会被先删掉）
  cleaned = cleaned.replace(/⚠️?/g, '注意')
  cleaned = cleaned.replace(/ℹ️?/g, '说明')

  // 再删除装饰性 emoji
  cleaned = cleaned.replace(/✅/g, '')
  cleaned = cleaned.replace(/❌/g, '')
  cleaned = cleaned.replace(/⚡/g, '')
  cleaned = cleaned.replace(/🔧/g, '')

  // 最后广泛去除剩余 emoji
  cleaned = cleaned.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}]/gu, '')

  return cleaned.trim()
}

/**
 * 去除 DOCX 提取文本中的目录段落
 *
 * DOCX 的目录区域包含 "第X章 标题\t页码" 格式的行，
 * 会干扰章节识别。本函数检测并移除这些目录行。
 *
 * @author zhi.qu
 * @date 2026-04-02
 */
export function stripDocxToc(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let inToc = false
  let tocLineCount = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // 目录行特征：章节标题 + tab/多空格 + 页码数字
    const isTocEntry = /^(?:第[一二三四五六七八九十\d]+章|[\d]+\.[\d.]*)\s+.+[\t ]{2,}\d+\s*$/.test(trimmed)
      || /^[一二三四五六七八九十]{1,2}[、.]\s*.+[\t ]{2,}\d+\s*$/.test(trimmed)
      || /^目\s*录\s*$/.test(trimmed)

    if (isTocEntry) {
      if (!inToc) inToc = true
      tocLineCount++
      continue
    }

    // 连续3行以上目录行后的空行也跳过
    if (inToc && trimmed === '' && tocLineCount >= 3) {
      continue
    }

    // 遇到非目录行，退出目录模式
    if (inToc && trimmed !== '') {
      inToc = false
      tocLineCount = 0
    }

    result.push(line)
  }

  return result.join('\n')
}

/**
 * 将 Vision 分析结果插入原文中语义最匹配的章节之后
 *
 * 策略：
 * 1. 根据 perPageChars 定位每页在全文中的字符范围
 * 2. 在当前页及前一页范围内扫描所有章节标题（数字编号型，如 "3.3.1 内部设备布局"）
 * 3. 从 Vision 内容提取关键词，与候选标题做交叉匹配
 * 4. 匹配到则插入该标题对应章节体的末尾；未匹配到则退回页末插入
 *
 * 这样 Vision 图片数据（如组件位置表）会归属到引用该图片的章节（如 3.3.1），
 * 而不是被机械地追加到页末、跑到下一个章节里。
 *
 * @author zhi.qu
 * @date 2026-04-03
 */
export function mergeVisionIntoText(
  rawText: string,
  visionResults: Array<{ pageNum: number; content: string }>,
  perPageChars: Array<{ num: number; chars: number }>
): string {
  if (visionResults.length === 0) return rawText

  // 计算每页的起始字符偏移
  const pageOffsets = new Map<number, number>()
  let offset = 0
  for (const page of perPageChars) {
    pageOffsets.set(page.num, offset)
    offset += page.chars
  }

  // 按页码从大到小排序，从后往前插入避免偏移错位
  const sorted = [...visionResults]
    .filter(v => v.content.trim().length > 10)
    .sort((a, b) => b.pageNum - a.pageNum)

  let result = rawText
  for (const v of sorted) {
    const pageOffset = pageOffsets.get(v.pageNum)
    if (pageOffset === undefined) continue

    const nextPageOffset = pageOffsets.get(v.pageNum + 1) ?? result.length
    const insertPos = Math.min(nextPageOffset, result.length)

    // 扫描范围：前一页开始 → 当前页结束（图可能跨页，标题在上一页底部）
    const scanStart = pageOffsets.get(v.pageNum - 1) ?? pageOffset
    const scanEnd = insertPos
    const scanRegion = result.slice(scanStart, scanEnd)

    // 提取 Vision 内容的 CJK 关键词（用于匹配章节标题）
    const visionKeywords = extractVisionKeywords(v.content)

    // 在扫描范围内查找所有带编号的章节标题
    const headingPattern = /^[ \t]*(?:\d+\.)+\d*\s+(.+)$/gm
    const candidates: Array<{ title: string; matchEnd: number; score: number }> = []
    let headingMatch: RegExpExecArray | null
    while ((headingMatch = headingPattern.exec(scanRegion)) !== null) {
      const title = headingMatch[1].trim()
      const score = computeTitleScore(title, visionKeywords)
      if (score > 0) {
        candidates.push({ title, matchEnd: scanStart + headingMatch.index + headingMatch[0].length, score })
      }
    }

    let pos: number
    if (candidates.length > 0) {
      // 选得分最高的标题；同分取最后一个（离图片最近）
      candidates.sort((a, b) => b.score - a.score || b.matchEnd - a.matchEnd)
      const best = candidates[0]

      // 找到该标题所属章节体的末尾（下一个同级或更高级标题之前）
      const afterTitle = best.matchEnd
      const nextHeadingInResult = result.slice(afterTitle, scanEnd)
        .search(/^[ \t]*(?:\d+\.)+\d*\s+/m)
      pos = nextHeadingInResult >= 0
        ? afterTitle + nextHeadingInResult
        : scanEnd

      // 在换行符处插入
      const nlPos = result.lastIndexOf('\n', pos)
      if (nlPos >= afterTitle) pos = nlPos
    } else {
      // 退回页末插入
      pos = result.lastIndexOf('\n', insertPos)
      if (pos < pageOffset) pos = insertPos
    }

    const visionBlock = `\n\n<!-- 以下为第${v.pageNum}页图片中提取的结构化数据 -->\n${v.content}\n`
    result = result.slice(0, pos) + visionBlock + result.slice(pos)
  }

  return result
}

/**
 * 从 Vision 输出中提取用于标题匹配的 CJK 关键词
 * 取前 300 字符，提取所有 >= 2 字的 CJK 词
 */
function extractVisionKeywords(visionContent: string): string[] {
  const sample = visionContent.slice(0, 300)
  const cjkTokens = sample.match(/[\u4e00-\u9fa5]{2,}/g) || []
  const keywords = new Set<string>()
  for (const token of cjkTokens) {
    keywords.add(token)
    if (token.length >= 4) {
      for (let i = 0; i < token.length - 1; i++) {
        keywords.add(token.slice(i, i + 2))
      }
    }
  }
  return [...keywords]
}

/**
 * 计算章节标题与 Vision 关键词的匹配得分
 * 标题中每个被命中的 2 字词 +1
 */
function computeTitleScore(title: string, visionKeywords: string[]): number {
  let score = 0
  for (const kw of visionKeywords) {
    if (title.includes(kw)) score++
  }
  return score
}

/**
 * 后处理数值校验：检测 LLM 输出中原文不存在的数值
 *
 * 提取 LLM 输出中的所有带单位数值（如 180N·m、50mm²、-20℃ 等），
 * 与原始文本进行比对。如果数值在原文中不存在，标记为疑似编造。
 *
 * @returns 疑似编造的数值列表
 * @author zhi.qu
 * @date 2026-04-02
 */
export function detectFabricatedNumbers(
  llmOutput: string,
  originalText: string
): string[] {
  // 提取带单位的技术数值（重点关注有工程意义的数字）
  const numberPattern = /(?:[-+]?\d+(?:\.\d+)?)\s*(?:mm²?|mm|m²|m³|cm|kW[h]?|kWh|MW|V|A[h]?|Ah|℃|°C|%|Ω|N·?m|ppm|kg|MPa|kPa|Hz|s|min|kN)/g

  const llmNumbers = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = numberPattern.exec(llmOutput)) !== null) {
    llmNumbers.add(match[0].replace(/\s+/g, ''))
  }

  const fabricated: string[] = []
  const normalizedOriginal = originalText.replace(/\s+/g, '')
  for (const num of llmNumbers) {
    const valueMatch = num.match(/[-+]?\d+(?:\.\d+)?/)
    if (!valueMatch) continue
    const value = valueMatch[0]

    if (parseFloat(value) < 5 && !num.includes('℃') && !num.includes('Ω')) continue

    const normalizedNum = num.replace(/\s+/g, '')
    const existsExact = normalizedOriginal.includes(normalizedNum)
    const existsValue = originalText.includes(value)

    if (!existsExact && !existsValue) {
      fabricated.push(num)
    }
  }

  return fabricated
}
