/**
 * Infographic DSL 输出验证 + 自动修正器（#C 方案）。
 *
 * 流程：
 *   1. sendMessage 流式完成后，扫描 displayText 中的所有 ```infographic 代码块
 *   2. 启发式规则检测明显错构造（YAML / JS / compare-swot 字段错等）
 *   3. 若发现错误，返回 errors 让 chatStore 决定是否触发自动 follow-up
 *
 * 设计原则：
 *   - 完全前端、零网络、无 LLM 依赖 — 启发式 regex 覆盖 90% 错误
 *   - 严格只检测"明显错"，避免误判合法 DSL（误报代价 = 多调一次 LLM）
 *   - 与 coerceInfographicDsl 区别：coerce 是"渲染时实时修补"，validator 是
 *     "事后判断 + 触发重写"。两者互补：自动修补能做的 (compare-swot body)
 *     validator 不报错；coerce 救不了的（用了 metadata: / 整体 YAML）validator 报错。
 *
 * @author zhi.qu
 * @date 2026-05-20
 */

export interface InfographicBlock {
  /** ```infographic 代码块的原始 raw（不含围栏） */
  raw: string
  /** 在原文 displayText 中的起止索引（含围栏，便于上层替换） */
  fenceStart: number
  fenceEnd: number
}

export interface ValidationError {
  kind:
    | 'missing-first-line'
    | 'yaml-style-frontmatter'
    | 'js-object-style'
    | 'colon-key-value'
    | 'tab-indent'
    | 'compare-swot-flat-fields'
    | 'unknown-data-field'
  message: string
}

/** 从 markdown 文本提取所有 ```infographic 块（按出现顺序）。 */
export function extractInfographicBlocks(text: string): InfographicBlock[] {
  const blocks: InfographicBlock[] = []
  const re = /```infographic\s*\n([\s\S]*?)\n```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    blocks.push({
      raw: m[1],
      fenceStart: m.index,
      fenceEnd: m.index + m[0].length,
    })
  }
  return blocks
}

/**
 * 启发式校验：检测明显错构造。
 *
 * 不报错的情况（认为可能合法）：
 *   - coerceCompareSwotBody 能修复的形式（虽然 LLM 错了，但前端会自动改对）
 *   - 边角小问题（前端 renderer 自带的 ErrorBoundary 能兜底）
 *
 * 报错的情况（自动追问值得）：
 *   - 整体 YAML / JS / 缺首行（renderer 拿不到合法 DSL，红框无内容）
 */
export function validateInfographicBlock(raw: string): { ok: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = []
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, errors: [{ kind: 'missing-first-line', message: '代码块为空' }] }

  const lines = trimmed.split('\n')
  const firstLine = lines[0].trim()

  // 1. 首行必须 `infographic <template>` 风格（其它都报错）
  if (!/^infographic\s+[a-z][a-z0-9-]+/i.test(firstLine)) {
    if (/^template\s*:/i.test(firstLine)) {
      errors.push({ kind: 'yaml-style-frontmatter', message: '首行使用 YAML 风格 `template: xxx`，应改为 `infographic <模板名>`' })
    } else if (/^@?[a-z@][\w/-]*\s*\{|^\{/i.test(firstLine) || /^(const|let|var|export)\s/i.test(firstLine)) {
      errors.push({ kind: 'js-object-style', message: '首行使用 JS / JSON 对象风格，应改为 `infographic <模板名>` 后接 DSL body' })
    } else {
      errors.push({ kind: 'missing-first-line', message: `首行不符合 \`infographic <模板名>\` 格式（当前："${firstLine.slice(0, 60)}"）` })
    }
  }

  // 2. 整体 YAML 化（含 `xxx:` 且不是合法 hex / URL 子串）
  const yamlKeyLines = lines.filter(l => /^\s*[a-z][a-z0-9_-]+\s*:\s*\S/i.test(l) && !/^\s*#/.test(l)).length
  if (yamlKeyLines >= 2) {
    errors.push({ kind: 'colon-key-value', message: `检测到 ${yamlKeyLines} 行 \`key: value\` 冒号语法，应改为空格分隔（DSL 不使用冒号 key-value）` })
  }

  // 3. tab 缩进
  if (lines.some(l => /^\t/.test(l))) {
    errors.push({ kind: 'tab-indent', message: '检测到 tab 缩进，必须用 2 空格' })
  }

  // 4. compare-swot 模板：检查 compares 数据完整性。
  //    @antv/infographic 的 compare-swot 模板每块只支持 1 段 `text`（plain-text 渲染）。
  //    LLM 也常输出 `items` 数组——coerceCompareSwotItemsCount 会自动转 text。
  //    所以 validator 接受**任一形式**（text 或 非空 items），仅在两者都缺失或为空时报错。
  if (/^infographic\s+compare-swot\b/im.test(trimmed)) {
    const comparesIdx = trimmed.search(/^\s*compares\s*$/im)
    if (comparesIdx < 0) {
      errors.push({ kind: 'unknown-data-field', message: 'compare-swot 模板必须含 `compares` 段' })
    } else {
      const afterCompares = trimmed.slice(comparesIdx)
      const hasLabelArray = /^\s*-\s+label\s+\S/m.test(afterCompares)
      const hasFlatSwotFields = /^\s+(strengths|weaknesses|opportunities|threats)\s*$/m.test(afterCompares)
      if (!hasLabelArray && hasFlatSwotFields) {
        errors.push({ kind: 'compare-swot-flat-fields', message: 'compare-swot 的 compares 用了平铺 strengths/weaknesses/... 字段，应改为 `- label 优势 / text 一段文字` 的数组结构' })
      } else if (!hasLabelArray) {
        errors.push({ kind: 'compare-swot-flat-fields', message: 'compare-swot 的 compares 必须是 `- label xxx` 的数组，至少 4 项（优势/劣势/机会/威胁）' })
      }
      if (hasLabelArray) {
        // compare-swot 真正期望 `children` 数组（每个 child 有 label）。
        // coerceCompareSwotToChildren 会把 text / items / desc 转为 children，所以这三种 + children 都接受。
        const labelChunks = splitByLabelBlocks(afterCompares)
        for (const chunk of labelChunks) {
          const labelName = (chunk.split('\n')[0].match(/^\s*-\s+label\s+(.+?)\s*$/)?.[1] ?? '').slice(0, 30) || '?'
          // 任一存在即视为合法（coerce 会规范化为 children）
          const hasTextField = /^\s+(?:text|desc|description|content)\s+\S/im.test(chunk)
          const hasChildrenField = /^\s*children\s*$/m.test(chunk)
          const hasItemsField = /^\s*items\s*$/m.test(chunk)
          if (hasTextField || hasChildrenField || hasItemsField) continue
          errors.push({ kind: 'unknown-data-field', message: `compare-swot 的 \`- label ${labelName}\` 缺内容（应有 \`children\` 数组、\`items\` 数组或 \`text\` 字段任一）` })
        }
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

/**
 * 把 `afterCompares` 文本切分成多个**顶层** - label 块。
 *
 * 关键修复（2026-05-21）：之前用 `^\s*-\s+label\s+` 匹配 ANY label 行，
 * 把嵌套 children 里的子 label 也当成了新块，触发 N 条"缺 content 字段"
 * 假阳性，迫使 chatStore 跑无谓的「revalidate 自动重问」一轮——用户报告
 * "为啥已经正常渲染还多一次"。修复：以**第一个 label 的缩进**为锚，
 * 同缩进 = 顶层新块，深缩进 = 当前块的嵌套内容。
 *
 *   compares
 *     - label 优势          <- baseIndent=4，开新块
 *       children
 *         - label 子项 A    <- indent=8，归到"优势"块内，不开新块
 *     - label 劣势          <- indent=4，开新块
 */
function splitByLabelBlocks(afterCompares: string): string[] {
  const lines = afterCompares.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let inBlock = false
  let baseIndent = -1
  for (const line of lines) {
    const labelMatch = line.match(/^(\s*)-\s+label\s+/)
    if (labelMatch) {
      const indent = labelMatch[1].length
      if (baseIndent === -1) baseIndent = indent
      if (indent === baseIndent) {
        // 顶层 label = 新块
        if (inBlock && current.length > 0) blocks.push(current.join('\n'))
        current = [line]
        inBlock = true
        continue
      }
      // 嵌套 label（更深缩进）= 仍属当前块的子节点
    }
    if (inBlock) current.push(line)
  }
  if (inBlock && current.length > 0) blocks.push(current.join('\n'))
  return blocks
}

/**
 * 构造给 LLM 的修正 prompt（拼接到 user 消息）。
 *
 * 提示心智：
 *   - 明确说"上次输出错了"（避免 LLM 以为是新需求）
 *   - 列出错误清单
 *   - 给出原 DSL 让 LLM 对照
 *   - 要求"只输出修正后的代码块，不要解释"（控制 token + 便于解析回填）
 */
export function buildRevalidatePrompt(raw: string, errors: ValidationError[]): string {
  const errLines = errors.map((e, i) => `${i + 1}. ${e.message}`).join('\n')
  return [
    '上一次输出的 ```infographic``` 代码块格式有误，前端无法渲染。',
    '',
    '具体错误：',
    errLines,
    '',
    '原 DSL：',
    '```infographic',
    raw,
    '```',
    '',
    '请按 draw-infographic skill 的标准 DSL 格式重写。要求：',
    '- 首行必须是 `infographic <模板名>`（参考 skill 文档的模板列表）',
    '- 2 空格缩进，key 和 value 之间用**空格**而非冒号',
    '- 数据字段按模板**精确名称**决定：',
    '  - `compare-swot` 每块用 `text 一段文字`（**不是 items 数组**！letter-card 自动生成 S/W/O/T 字母，label 里不要手动加字母后缀）',
    '  - 想要"每块多条 bullet"用 `compare-hierarchy-row-letter-card-rounded-rect-node` 模板（这种才用 items 数组）',
    '  - `list-*` 用 lists；`sequence-*` 用 sequences；`hierarchy-*` 用 root + children',
    '- **只输出修正后的 ```infographic``` 代码块本身，不要解释、不要寒暄、不要 markdown 标题**',
  ].join('\n')
}
