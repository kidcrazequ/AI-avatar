/**
 * 极简 markdown → HTML 渲染（不依赖任何第三方库）。
 *
 * 支持范围（明确不扩展，避免 bundle 膨胀）：
 *   - 段落（双换行分段）
 *   - 行内 code：`xxx`
 *   - 代码块：```lang\n...\n```
 *   - 链接：[text](https://url)（仅允许 http/https，避免 javascript: XSS）
 *
 * 安全性：
 *   - 所有原始文本先 escapeHtml，再做后续语法替换；
 *     这样即便用户输入 <script> 也只会变成 &lt;script&gt;
 *   - 链接 URL 二次校验协议
 *   - 输出 HTML 由调用方用 dangerouslySetInnerHTML 注入（已转义所以安全）
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

/** HTML 实体转义：阻断所有标签注入。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 简单白名单：只允许 http(s) 链接 + 站内相对路径，过滤 javascript: / data: 等。 */
function safeUrl(rawUrl: string): string | null {
  const u = rawUrl.trim()
  if (u.length === 0) return null
  if (u.startsWith('http://') || u.startsWith('https://')) return u
  if (u.startsWith('/') || u.startsWith('./') || u.startsWith('../')) return u
  return null
}

/**
 * 把已转义的段落正文中行内 code 与 markdown 链接转成 HTML。
 *
 * 顺序很重要：先处理行内 code（避免链接里的反引号干扰），再处理链接。
 */
function renderInline(escaped: string): string {
  // 行内 code：`xxx` → <code>xxx</code>
  let out = escaped.replace(/`([^`\n]+?)`/g, (_m, body: string) => `<code>${body}</code>`)
  // 链接：[text](url) —— text 已 escape；url 仅 http(s)
  out = out.replace(/\[([^\]\n]+?)\]\(([^)\s]+?)\)/g, (m, text: string, rawUrl: string) => {
    const safe = safeUrl(rawUrl)
    if (!safe) return m
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${text}</a>`
  })
  return out
}

/**
 * 主入口：把 markdown 文本渲染为 HTML 字符串。
 *
 * 算法：
 *   1. 先用 ```lang\n...\n``` 切出代码块占位
 *   2. 余下文本按 \n\n 分段
 *   3. 每段 escapeHtml + renderInline + 包 <p>，单段内 \n 转成 <br>
 *   4. 还原代码块占位为 <pre><code>...</code></pre>
 */
export function renderMarkdown(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return ''

  // 1. 抽取代码块（带语言标记）
  const blocks: string[] = []
  const placeholderPrefix = '\u0000__SOUL_CODE_BLOCK_'
  const placeholderSuffix = '__\u0000'
  let withoutBlocks = input.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang: string, body: string) => {
    const idx = blocks.length
    blocks.push(`<pre><code>${escapeHtml(body)}</code></pre>`)
    return `${placeholderPrefix}${idx}${placeholderSuffix}`
  })

  // 2. 段落切分
  const paragraphs = withoutBlocks.split(/\n{2,}/)
  const htmlParts: string[] = []
  for (const raw of paragraphs) {
    const trimmed = raw.replace(/^\n+|\n+$/g, '')
    if (trimmed.length === 0) continue
    // 段落整段是占位符 → 直接还原（避免被包 <p>）
    if (trimmed.startsWith(placeholderPrefix) && trimmed.endsWith(placeholderSuffix)) {
      htmlParts.push(trimmed)
      continue
    }
    const escaped = escapeHtml(trimmed).replace(/\n/g, '<br/>')
    const inline = renderInline(escaped)
    htmlParts.push(`<p>${inline}</p>`)
  }
  withoutBlocks = htmlParts.join('')

  // 3. 还原代码块占位
  withoutBlocks = withoutBlocks.replace(
    new RegExp(`${placeholderPrefix.replace(/\u0000/g, '\\u0000')}(\\d+)${placeholderSuffix.replace(/\u0000/g, '\\u0000')}`, 'g'),
    (_m, idxStr: string) => blocks[Number(idxStr)] ?? '',
  )

  return withoutBlocks
}
