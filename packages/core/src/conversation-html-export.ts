/**
 * 会话导出为「自包含、可分享」的单文件 HTML（借鉴 Pi Coding Agent 的 export-to-HTML）。
 *
 * 现状（如实说明）：导出此前仅 markdown，PDF 分支直接 throw。本模块在**主进程纯函数**里
 * 把会话 markdown 渲染成内联样式的 HTML —— 不开离屏 BrowserWindow、不引新依赖。
 *
 * 保真度边界（诚实）：渲染常见 markdown 子集（标题/粗斜体/行内码/围栏代码/列表/表格/
 * 引用/分隔线/链接），并做 XSS 转义。chart/mermaid 等需要 JS 运行时的块按"带标签的
 * 代码块"原样呈现，不渲染成图（那需要离屏 React + echarts，属更重的后续）。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

/** 允许的链接协议（防 javascript: 等注入；内容已转义，这里基于转义后的串判断 scheme）。 */
const SAFE_URL_RE = /^(https?:|mailto:|#|\/)/i

/** HTML 实体转义（XSS 安全的基础）。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 行内 markdown 渲染。入参为**已转义**文本；处理行内码/链接/粗体/斜体。 */
function renderInline(escaped: string): string {
  // 按反引号切分：奇数段是行内码（原样包 <code>），偶数段才套粗斜体/链接，互不串扰、无占位符冲突
  return escaped
    .split('`')
    .map((seg, idx) => {
      if (idx % 2 === 1) return `<code>${seg}</code>`
      let out = seg.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
        const u = url.trim()
        if (!SAFE_URL_RE.test(u)) return text // 非白名单协议：丢链接保留文字
        return `<a href="${u}" target="_blank" rel="noopener noreferrer">${text}</a>`
      })
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      out = out.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
      return out
    })
    .join('')
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')
}

function renderTableRow(line: string, cell: 'td' | 'th'): string {
  const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
  const tds = cells.map((c) => `<${cell}>${renderInline(escapeHtml(c.trim()))}</${cell}>`).join('')
  return `<tr>${tds}</tr>`
}

/** 把一段 markdown 渲染成 HTML（常见子集，XSS 安全）。 */
export function markdownToSafeHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let i = 0
  let para: string[] = []

  const flushPara = (): void => {
    if (para.length === 0) return
    html.push(`<p>${para.map((l) => renderInline(escapeHtml(l))).join('<br>')}</p>`)
    para = []
  }

  while (i < lines.length) {
    const line = lines[i]

    // 围栏代码块
    const fence = line.match(/^```(\w+)?\s*$/)
    if (fence) {
      flushPara()
      const code: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i])
        i++
      }
      i++ // 跳过结尾 ```
      const label = fence[1] ? `<div class="code-lang">${escapeHtml(fence[1])}</div>` : ''
      html.push(`${label}<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushPara()
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`)
      i++
      continue
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara()
      html.push('<hr>')
      i++
      continue
    }

    // 表格：当前行含 |，下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara()
      const rows = [`<thead>${renderTableRow(line, 'th')}</thead>`]
      i += 2
      const body: string[] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        body.push(renderTableRow(lines[i], 'td'))
        i++
      }
      rows.push(`<tbody>${body.join('')}</tbody>`)
      html.push(`<table>${rows.join('')}</table>`)
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      flushPara()
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      html.push(`<blockquote>${quote.map((l) => renderInline(escapeHtml(l))).join('<br>')}</blockquote>`)
      continue
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(escapeHtml(lines[i].replace(/^\s*[-*+]\s+/, '')))}</li>`)
        i++
      }
      html.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(escapeHtml(lines[i].replace(/^\s*\d+\.\s+/, '')))}</li>`)
        i++
      }
      html.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    // 空行 → 段落分隔
    if (line.trim() === '') {
      flushPara()
      i++
      continue
    }

    // 普通段落行
    para.push(line)
    i++
  }
  flushPara()
  return html.join('\n')
}

export interface ConversationHtmlMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

export interface ConversationHtmlInput {
  readonly title: string
  /** 导出时间（人读串）；由调用方传入，保持纯函数可测。 */
  readonly exportedAt: string
  readonly messages: readonly ConversationHtmlMessage[]
}

const PAGE_CSS = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    max-width: 820px; margin: 0 auto; padding: 32px 20px; line-height: 1.7; color: #1a1a1a; background: #fff; }
  h1.conv-title { font-size: 22px; margin-bottom: 4px; }
  .conv-meta { color: #888; font-size: 13px; margin-bottom: 24px; }
  .msg { margin: 18px 0; padding: 14px 16px; border-radius: 10px; }
  .msg.user { background: #eef4ff; }
  .msg.assistant { background: #f6f6f4; }
  .msg .role { font-weight: 600; font-size: 13px; color: #555; margin-bottom: 6px; }
  .msg p { margin: 8px 0; }
  pre { background: #1e1e1e; color: #e6e6e6; padding: 12px; border-radius: 8px; overflow-x: auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 90%; }
  :not(pre) > code { background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 4px; }
  .code-lang { font-size: 11px; color: #888; margin-bottom: -6px; }
  table { border-collapse: collapse; margin: 10px 0; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
  th { background: rgba(0,0,0,0.04); }
  blockquote { border-left: 3px solid #bbb; margin: 8px 0; padding-left: 12px; color: #555; }
  a { color: #2563eb; }
  hr { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
`.trim()

/**
 * 拼装完整的自包含 HTML（内联 CSS，无外部资源依赖，开箱即可在浏览器打开/分享）。
 */
export function buildConversationHtml(input: ConversationHtmlInput): string {
  const body = input.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const roleLabel = m.role === 'user' ? '你' : '专家'
      return `<div class="msg ${m.role}"><div class="role">${roleLabel}</div>${markdownToSafeHtml(m.content)}</div>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<h1 class="conv-title">${escapeHtml(input.title)}</h1>
<div class="conv-meta">导出时间：${escapeHtml(input.exportedAt)}</div>
${body}
</body>
</html>
`
}
