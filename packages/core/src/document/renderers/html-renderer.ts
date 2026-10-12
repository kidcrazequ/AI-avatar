/**
 * 文档生成 IR → HTML 渲染器
 *
 * 设计目标：把统一的 DocumentIR 渲染为完整的 HTML 文档，供：
 *   1. Electron 主进程 BrowserWindow + printToPDF 转 PDF
 *   2. 离线导出 / 预览 / 调试
 *
 * 安全约束：
 *   - 所有用户/LLM 来源文本必须经 escapeHtml 转义（防 XSS / 标签注入）
 *   - 不渲染原始 HTML / inline JS（IR schema 也不允许）
 *
 * 样式注入顺序（后者覆盖前者）：
 *   1. 内置基础样式（minimal reset + Noto Sans CJK 字体声明 + callout/cite/table 默认色）
 *   2. 分身模板 CSS（loadTemplateCss）或调用方传入的 inlineCss
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import type {
  DocumentBlock,
  DocumentIR,
  TableCellValue,
} from '../ir-schema'
import { loadTemplateCss } from './template-loader'

export interface RenderHtmlOptions {
  /** 分身根目录绝对路径，用于加载 document-templates/<name>.css */
  avatarRoot?: string
  /** 模板名，默认 'default' */
  templateName?: string
  /** 直接传入 CSS（追加在模板 CSS 之后），调试 / 自定义场景使用 */
  inlineCss?: string
}

/**
 * 渲染 IR 为完整 HTML 文档（含 <!DOCTYPE> + <head> + <body>）。
 *
 * 屏幕预览态额外渲染顶部 / 底部 chrome（页眉、页脚），数据源优先级：
 *   - 页眉：`metadata.headerText` ?? `metadata.organization`（兜底品牌名）
 *   - 页脚：`metadata.footerText`
 *
 * 都缺失时不输出对应 div（避免空 chrome 占视口空间）。
 * 打印态（PDF 渲染走 Chromium printToPDF）通过 `@media print` 隐藏屏幕 chrome，
 * 让分身模板里的 `@page @top-center / @bottom-center` 规则继续生效，无重复。
 */
export function renderHtml(ir: DocumentIR, options: RenderHtmlOptions = {}): string {
  const title = ir.metadata.title || '未命名文档'
  const author = typeof ir.metadata.author === 'string' ? ir.metadata.author : ''
  const date = typeof ir.metadata.date === 'string' ? ir.metadata.date : ''
  const baseCss = buildBaseCss()
  const templateCss = options.avatarRoot
    ? loadTemplateCss(options.avatarRoot, options.templateName ?? 'default')
    : ''
  const extraCss = options.inlineCss ?? ''
  const body = ir.blocks.map(renderBlockToHtml).join('\n')
  const previewChrome = buildPreviewChrome(ir.metadata)

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `  <title>${escapeHtml(title)}</title>`,
    author ? `  <meta name="author" content="${escapeHtml(author)}" />` : '',
    date ? `  <meta name="date" content="${escapeHtml(date)}" />` : '',
    '  <style>',
    baseCss,
    templateCss,
    extraCss,
    '  </style>',
    '</head>',
    '<body>',
    previewChrome.header,
    '  <article class="document">',
    titleBlockHtml(title, author, date),
    body,
    '  </article>',
    previewChrome.footer,
    '</body>',
    '</html>',
  ].filter(Boolean).join('\n')
}

/**
 * 构造屏幕预览态的页眉/页脚 HTML 片段。
 *
 * @param metadata 文档元数据，支持 headerText / footerText / organization 三个字段
 * @returns        `{ header, footer }`，缺失时对应字段为空串（filter(Boolean) 时被跳过）
 */
function buildPreviewChrome(metadata: DocumentIR['metadata']): { header: string; footer: string } {
  const headerSource =
    typeof metadata.headerText === 'string' && metadata.headerText.trim()
      ? metadata.headerText.trim()
      : typeof metadata.organization === 'string' && metadata.organization.trim()
        ? metadata.organization.trim()
        : ''
  const footerSource =
    typeof metadata.footerText === 'string' && metadata.footerText.trim()
      ? metadata.footerText.trim()
      : ''

  const header = headerSource
    ? `  <div class="preview-page-header" role="presentation">${escapeHtml(headerSource)}</div>`
    : ''
  const footer = footerSource
    ? `  <div class="preview-page-footer" role="presentation">${escapeHtml(footerSource)}</div>`
    : ''
  return { header, footer }
}

// ─── 块渲染 ───────────────────────────────────────────────────────────────────

function renderBlockToHtml(block: DocumentBlock): string {
  switch (block.type) {
    case 'heading': {
      const tag = `h${block.level}`
      return `<${tag}>${renderInlineMarkdown(block.text)}</${tag}>`
    }
    case 'paragraph': {
      // 段落内的换行渲染为 <br>，更符合人类直觉（IR 段落允许多行）
      const html = renderInlineMarkdown(block.text).replace(/\n/g, '<br />')
      return `<p>${html}</p>`
    }
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul'
      const items = block.items.map(it => `  <li>${renderInlineMarkdown(it)}</li>`).join('\n')
      return `<${tag}>\n${items}\n</${tag}>`
    }
    case 'table':
      return renderTableHtml(block.headers, block.rows)
    case 'code': {
      const langClass = block.language ? ` class="language-${escapeHtmlAttr(block.language)}"` : ''
      return `<pre><code${langClass}>${escapeHtml(block.code)}</code></pre>`
    }
    case 'callout':
      return `<aside class="callout callout-${block.level}">${renderInlineMarkdown(block.text).replace(/\n/g, '<br />')}</aside>`
    case 'cite': {
      const pageAttr = block.page !== undefined ? ` data-page="${block.page}"` : ''
      return `<blockquote class="cite" data-source="${escapeHtmlAttr(block.source)}"${pageAttr}>${renderInlineMarkdown(block.text).replace(/\n/g, '<br />')}<footer class="cite-source">来源：${escapeHtml(block.source)}${block.page !== undefined ? `，第 ${block.page} 页` : ''}</footer></blockquote>`
    }
    case 'image': {
      const safeSrc = sanitizeUrl(block.src)
      const altAttr = block.alt ? ` alt="${escapeHtmlAttr(block.alt)}"` : ' alt=""'
      const captionHtml = block.caption
        ? `<figcaption>${escapeHtml(block.caption)}</figcaption>`
        : ''
      // safeSrc 为空时仍渲染 <figure> 但 img 无 src 不加载，避免静默丢失内容
      const srcAttr = safeSrc ? ` src="${escapeHtmlAttr(safeSrc)}"` : ''
      return `<figure><img${srcAttr}${altAttr} />${captionHtml}</figure>`
    }
    case 'divider':
      return '<hr />'
    default: {
      // TS exhaustiveness check：未来 DocumentBlock 加新 type 但忘了在此处理，编译期会报错
      const _never: never = block
      throw new Error(`未覆盖的 block.type: ${(_never as { type: string }).type}`)
    }
  }
}

function renderTableHtml(headers: string[], rows: TableCellValue[][]): string {
  const headLine = `    <tr>${headers.map(h => `<th>${renderInlineMarkdown(h)}</th>`).join('')}</tr>`
  const bodyLines = rows
    .map(row => `    <tr>${row.map(c => `<td>${renderInlineMarkdown(formatCell(c))}</td>`).join('')}</tr>`)
    .join('\n')
  return [
    '<table>',
    '  <thead>',
    headLine,
    '  </thead>',
    '  <tbody>',
    bodyLines,
    '  </tbody>',
    '</table>',
  ].join('\n')
}

function formatCell(cell: TableCellValue): string {
  if (cell === null) return ''
  if (typeof cell === 'number') return String(cell)
  return cell
}

/**
 * 渲染安全的行内 Markdown 子集。
 *
 * 只支持文档报告里高频且低风险的语法：
 * - `**加粗**` → `<strong>加粗</strong>`
 * - `` `代码` `` → `<code>代码</code>`
 *
 * 安全策略：先对文本片段做 HTML 转义，再替换 Markdown 标记；不支持原始 HTML。
 */
function renderInlineMarkdown(input: string): string {
  let output = ''
  let lastIndex = 0
  const codeRegex = /`([^`\n]+)`/g
  let match: RegExpExecArray | null

  while ((match = codeRegex.exec(input)) !== null) {
    output += renderStrongMarkdown(escapeHtml(input.slice(lastIndex, match.index)))
    output += `<code>${escapeHtml(match[1])}</code>`
    lastIndex = codeRegex.lastIndex
  }

  output += renderStrongMarkdown(escapeHtml(input.slice(lastIndex)))
  return output
}

function renderStrongMarkdown(escapedText: string): string {
  return escapedText.replace(/\*\*([^\n]+?)\*\*/g, (_full, content: string) => {
    if (content.trim().length === 0) return `**${content}**`
    return `<strong>${content}</strong>`
  })
}

function titleBlockHtml(title: string, author: string, date: string): string {
  if (!title && !author && !date) return ''
  const meta: string[] = []
  if (author) meta.push(`<span class="meta-author">${escapeHtml(author)}</span>`)
  if (date) meta.push(`<span class="meta-date">${escapeHtml(date)}</span>`)
  const metaHtml = meta.length > 0 ? `<div class="title-meta">${meta.join(' · ')}</div>` : ''
  return [
    '<header class="document-header">',
    `  <h1 class="document-title">${escapeHtml(title)}</h1>`,
    `  ${metaHtml}`,
    '</header>',
  ].join('\n')
}

// ─── 安全：HTML 转义 + URL 白名单 ─────────────────────────────────────────────

/**
 * 转义文本节点中的 HTML 特殊字符。
 * 输入永远是 LLM/用户文本，不允许传入预先含 HTML 的字符串。
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 用于 HTML 属性值的转义（与 escapeHtml 一致，单独命名提高可读性） */
function escapeHtmlAttr(input: string): string {
  return escapeHtml(input)
}

/**
 * URL 白名单校验——仅允许安全协议的 URL 嵌入 HTML。
 *
 * 允许：
 *   - https:// / http://（外部资源）
 *   - 相对路径（不含 : 的字符串，如 ./images/foo.png）
 *   - data:image/*（base64 内嵌图片，PDF 离线渲染场景需要）
 *
 * 拒绝（返回空字符串使 <img> 无 src 不加载）：
 *   - javascript: / vbscript: / data:text/html 等脚本注入向量
 *   - file:// （防止泄漏本地文件路径到 PDF 渲染的 BrowserWindow）
 */
export function sanitizeUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''

  // 协议提取：取第一个 : 之前的内容做小写比较
  const colonIdx = trimmed.indexOf(':')
  if (colonIdx === -1) {
    // 无协议 = 相对路径，安全
    return trimmed
  }

  const protocol = trimmed.slice(0, colonIdx).toLowerCase()

  if (protocol === 'https' || protocol === 'http') {
    return trimmed
  }

  // data:image/* 白名单（base64 图片，PDF 离线渲染需要）
  if (protocol === 'data' && /^data:image\//i.test(trimmed)) {
    return trimmed
  }

  // 其它一律拒绝：javascript: / vbscript: / file: / data:text/html 等
  return ''
}

// ─── 内置基础样式 ─────────────────────────────────────────────────────────────

function buildBaseCss(): string {
  // 注意：不依赖外部字体文件，按平台优先级声明系统中文字体；不声明 @import 避免离线失败
  return `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Noto Sans CJK SC", "Helvetica Neue", Arial, sans-serif;
    font-size: 12pt;
    line-height: 1.7;
    color: #1f2328;
    background: #ffffff;
  }
  .document { max-width: 800px; margin: 24px auto; padding: 0 32px; }
  .document-header { margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #d0d7de; }
  .document-title { font-size: 24pt; margin: 0 0 6px 0; }
  .title-meta { color: #57606a; font-size: 11pt; }
  h1 { font-size: 22pt; margin: 32px 0 12px; }
  h2 { font-size: 18pt; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #eaeef2; }
  h3 { font-size: 15pt; margin: 22px 0 8px; }
  h4 { font-size: 13pt; margin: 18px 0 6px; }
  h5, h6 { font-size: 12pt; margin: 14px 0 4px; }
  p { margin: 8px 0; }
  ul, ol { margin: 8px 0; padding-left: 24px; }
  li { margin: 2px 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; font-weight: 600; }
  pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 10.5pt; }
  pre code { font-family: "SF Mono", Consolas, "Courier New", monospace; }
  hr { border: none; border-top: 1px solid #d0d7de; margin: 20px 0; }
  figure { margin: 16px 0; text-align: center; }
  figure img { max-width: 100%; height: auto; }
  figcaption { color: #57606a; font-size: 10.5pt; margin-top: 4px; }
  .callout { border-left: 4px solid #888; padding: 10px 14px; margin: 12px 0; border-radius: 4px; background: #f6f8fa; }
  .callout-info { border-left-color: #0969da; background: #ddf4ff; }
  .callout-warning { border-left-color: #bf8700; background: #fff8c5; }
  .callout-success { border-left-color: #1a7f37; background: #dafbe1; }
  .callout-danger { border-left-color: #d1242f; background: #ffebe9; }
  blockquote.cite { border-left: 4px solid #8250df; padding: 10px 14px; margin: 12px 0; background: #f3eefe; border-radius: 4px; }
  blockquote.cite .cite-source { display: block; margin-top: 6px; color: #57606a; font-size: 10.5pt; font-style: italic; }
  @page { size: A4; margin: 18mm; }

  /*
   * 屏幕预览页眉/页脚：固定到视口顶/底，半透明白底 + 模糊背景，让长文档滚动时仍能看到品牌信息。
   * 仅在屏幕态生效；PDF（Chromium printToPDF）走分身模板里的 @page 规则，避免重复。
   */
  @media screen {
    body { padding-top: 56px; padding-bottom: 48px; }
    .preview-page-header,
    .preview-page-footer {
      position: fixed;
      left: 0;
      right: 0;
      z-index: 10;
      padding: 10px 24px;
      font-size: 10.5pt;
      color: #57606a;
      background: rgba(255, 255, 255, 0.85);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      pointer-events: none;
      text-align: center;
    }
    .preview-page-header {
      top: 0;
      border-bottom: 1px solid #d0d7de;
    }
    .preview-page-footer {
      bottom: 0;
      border-top: 1px solid #d0d7de;
    }
  }

  /*
   * 打印 / PDF 输出态：屏蔽屏幕预览的 chrome，让 @page 规则统治页眉页脚。
   */
  @media print {
    .preview-page-header,
    .preview-page-footer { display: none !important; }
    body { padding-top: 0; padding-bottom: 0; }
  }
  `
}
