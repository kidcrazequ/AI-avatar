/**
 * HTML → PPTX 真正可编辑导出器。
 *
 * 输入：一个完整的 HTML 文档（含若干 .slide 容器）。
 * 输出：可在 PowerPoint / Keynote / WPS 中再次编辑的 .pptx 文件。
 *
 * 工作原理：
 *   1. jsdom 把 HTML 解析成 DOM
 *   2. 找出所有 page selector 命中的元素当作"幻灯片"
 *   3. 每张幻灯片：
 *      - 提取 background-color / background-image / 全屏 <img> 作为 slide.background
 *      - 提取 h1/h2/h3 → 标题文本框
 *      - 提取 p/li     → 正文文本框（保留行级结构）
 *      - 提取 img      → 嵌入图片（base64 / 本地路径都支持）
 *      - 提取 border / border-radius / box-shadow → pptxgenjs line / rectRadius / shadow
 *   4. pptxgenjs 写入 .pptx
 *
 * 与 screenshot 模式的关系：
 *   - 本文件实现"editable"模式（解析文本/图片/边框/阴影为 PPT shape）
 *   - "screenshot"模式由 PreviewManager 在 BrowserWindow 中按 slide 截图，
 *     再由本文件 addImage 兜底写入。两种模式接口一致。
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import fs from 'fs'
import path from 'path'
import { JSDOM } from 'jsdom'
import PptxGenJS from 'pptxgenjs'

/** 单页 PPTX 默认尺寸：16:9 widescreen，单位英寸 */
const DEFAULT_SLIDE_WIDTH = 13.333
const DEFAULT_SLIDE_HEIGHT = 7.5

/** 命中"一页幻灯片"的 CSS 选择器候选列表，按优先级匹配 */
const DEFAULT_PAGE_SELECTORS = [
  '.slide',
  '.pptx-slide',
  'section.slide',
  '[data-slide]',
  'section[data-page]',
]

export interface HtmlToPptxOptions {
  /** 完整 HTML 文档字符串 */
  htmlContent: string
  /** 输出 PPTX 绝对路径 */
  outputPath: string
  /** 自定义页选择器（可选，默认尝试 .slide / .pptx-slide / section.slide / [data-slide]） */
  pageSelector?: string
  /** 幻灯片宽度（英寸，默认 13.333） */
  slideWidth?: number
  /** 幻灯片高度（英寸，默认 7.5） */
  slideHeight?: number
  /**
   * 截图模式：每页幻灯片改为整图填充。
   * 调用方需先在 BrowserWindow 中渲染 HTML、按 slide 截图，
   * 然后把 dataURL 列表传进来；本函数按顺序写图。
   */
  slideScreenshots?: string[]
  /**
   * 资源根目录（用于解析 img 的相对路径）。
   * 默认是 outputPath 所在目录的父目录。
   */
  resourceBaseDir?: string
}

export interface HtmlToPptxResult {
  outputPath: string
  slideCount: number
  /** 实际命中的 page selector，便于调用方提示用户 */
  selectorUsed: string
  /** 写入过程中遇到的非致命警告（如：图片加载失败、字体缺失等） */
  warnings: string[]
}

/** 把 CSS color 字符串归一为 PPTX 接受的 6 位 hex（不含 #）；解析失败回退默认值 */
function normalizeColor(input: string | undefined | null, fallback: string): string {
  if (!input) return fallback
  const trimmed = input.trim().toLowerCase()
  if (trimmed.startsWith('#')) {
    if (trimmed.length === 7) return trimmed.slice(1).toUpperCase()
    if (trimmed.length === 4) {
      // #abc → AABBCC
      return (trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3]).toUpperCase()
    }
  }
  const rgb = trimmed.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgb) {
    const toHex = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0')
    return (toHex(rgb[1]) + toHex(rgb[2]) + toHex(rgb[3])).toUpperCase()
  }
  return fallback
}

/**
 * 从 CSS color 串里抽出 alpha 通道（0..1），抽不到返回 1。
 * 用于 box-shadow rgba 的透明度映射。
 */
function extractAlpha(input: string | undefined | null): number {
  if (!input) return 1
  const m = input.trim().toLowerCase().match(/^rgba?\([^)]*,\s*([\d.]+)\s*\)$/)
  if (!m) return 1
  const a = parseFloat(m[1])
  return Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1
}

/** 把 px / em 转为 PPT pt（粗略）：默认 1px = 0.75pt */
function pxToPt(input: string | undefined | null, fallback: number): number {
  if (!input) return fallback
  const m = input.trim().match(/^([\d.]+)(px|pt|em|rem)?$/i)
  if (!m) return fallback
  const v = parseFloat(m[1])
  const unit = (m[2] || 'px').toLowerCase()
  switch (unit) {
    case 'pt': return v
    case 'px': return Math.round(v * 0.75)
    case 'em':
    case 'rem': return Math.round(v * 12) // 假设 base 16px → 12pt
    default: return fallback
  }
}

/**
 * 从 px 字符串解析为数字像素值，解析失败返回 fallback。
 * 与 pxToPt 不同：这里返回的是原始像素，给 box-shadow / border 计算偏移用。
 */
function parsePxNumber(input: string | undefined | null, fallback: number): number {
  if (!input) return fallback
  const m = input.trim().match(/^([-\d.]+)(px)?$/i)
  if (!m) return fallback
  const v = parseFloat(m[1])
  return Number.isFinite(v) ? v : fallback
}

/** 把 dataURL / 本地路径 / http(s) 引用统一返回 pptxgenjs 接受的 path 字段值 */
function resolveImageRef(rawSrc: string, resourceBaseDir: string, warnings: string[]): { data?: string; path?: string } | null {
  if (!rawSrc) return null
  if (rawSrc.startsWith('data:')) {
    return { data: rawSrc }
  }
  if (rawSrc.startsWith('http://') || rawSrc.startsWith('https://')) {
    return { path: rawSrc }
  }
  // 相对路径 / 绝对路径
  const abs = path.isAbsolute(rawSrc) ? rawSrc : path.resolve(resourceBaseDir, rawSrc)
  if (!fs.existsSync(abs)) {
    warnings.push(`图片不存在，跳过: ${rawSrc}`)
    return null
  }
  // 转 dataURL，避免 PPT 里残留 file:// 路径在不同电脑打不开
  const buf = fs.readFileSync(abs)
  const ext = path.extname(abs).toLowerCase().replace('.', '') || 'png'
  const mime = ext === 'jpg' ? 'jpeg' : ext
  return { data: `data:image/${mime};base64,${buf.toString('base64')}` }
}

/** 找命中的 page selector（按候选列表匹配第一个有内容的） */
function pickPageSelector(doc: Document, custom?: string): { sel: string; nodes: Element[] } {
  if (custom) {
    const nodes = Array.from(doc.querySelectorAll(custom))
    return { sel: custom, nodes }
  }
  for (const sel of DEFAULT_PAGE_SELECTORS) {
    const nodes = Array.from(doc.querySelectorAll(sel))
    if (nodes.length > 0) return { sel, nodes }
  }
  // 兜底：把 body 当成单页
  const body = doc.body
  return { sel: 'body', nodes: body ? [body] : [] }
}

/**
 * 给 block 渲染附加的容器外观样式。
 * 字段全部可选；命中即透传到 pptxgenjs，否则保持默认。
 */
interface BoxStyle {
  fillColorHex?: string
  borderColorHex?: string
  borderWidthPt?: number
  borderDash?: 'solid' | 'dash' | 'dashDot'
  /** pptxgenjs rectRadius 接受 0..1（短边的比例） */
  borderRadiusFraction?: number
  /** pptxgenjs shadow 选项；type 固定 'outer' / 'inner' */
  shadow?: {
    type: 'outer' | 'inner'
    blur: number
    offset: number
    angle: number
    colorHex: string
    opacity: number
  }
}

/**
 * 提取一页幻灯片可被结构化的元素：标题、段落、列表项、图片。
 * 顺序按文档流，尽量保持源 HTML 的视觉结构。
 */
interface SlideBlock {
  kind: 'title' | 'subtitle' | 'paragraph' | 'list' | 'image'
  text?: string
  items?: string[]
  imageSrc?: string
  fontSizePt: number
  colorHex: string
  bold?: boolean
  /** 文本/图片块上额外的容器样式（border/shadow/radius/fill） */
  box?: BoxStyle
}

/**
 * 解析单个 element 的 box 样式（border / box-shadow / background / border-radius）。
 *
 * 设计选择：
 *   - 只读 inline style，避免依赖 CSS stylesheet（jsdom 默认不解析外部 CSS）
 *   - 同时兼容 border 缩写写法（"1px solid #000"）和分项写法（border-width / border-color / border-style）
 *   - box-shadow 只解析最常见的 4 段格式："offsetX offsetY blur color"，复杂语法忽略
 *
 * @returns BoxStyle；所有字段都可能 undefined
 */
function extractBoxStyle(el: Element): BoxStyle {
  const style = (el as HTMLElement).style
  if (!style) return {}
  const out: BoxStyle = {}

  // 1) background-color → fillColorHex
  const bg = style.backgroundColor
  if (bg && bg !== 'transparent') {
    const hex = normalizeColor(bg, '')
    if (hex) out.fillColorHex = hex
  }

  // 2) border 缩写 / 分项
  let borderColor = style.borderColor || ''
  let borderWidth = style.borderWidth || ''
  let borderStyle = style.borderStyle || ''
  const borderShorthand = (style as unknown as { border?: string }).border || ''
  if (borderShorthand && (!borderColor || !borderWidth || !borderStyle)) {
    // "1px solid #000" / "2px dashed red"
    const parts = borderShorthand.trim().split(/\s+/)
    for (const p of parts) {
      if (/^\d/.test(p) && !borderWidth) borderWidth = p
      else if (/^(solid|dashed|dotted|double|none)$/i.test(p) && !borderStyle) borderStyle = p
      else if (!borderColor) borderColor = p
    }
  }
  if (borderStyle && borderStyle.toLowerCase() !== 'none' && borderWidth) {
    out.borderWidthPt = pxToPt(borderWidth, 1)
    out.borderColorHex = normalizeColor(borderColor, '333333')
    const bs = borderStyle.toLowerCase()
    if (bs === 'dashed') out.borderDash = 'dash'
    else if (bs === 'dotted') out.borderDash = 'dashDot'
    else out.borderDash = 'solid'
  }

  // 3) border-radius → rectRadius (0..1)
  const radius = style.borderRadius || ''
  if (radius) {
    const m = radius.trim().match(/^([\d.]+)(px|%)?$/)
    if (m) {
      const v = parseFloat(m[1])
      const unit = (m[2] || 'px').toLowerCase()
      if (unit === '%') {
        // 50% 视为最大圆角
        out.borderRadiusFraction = Math.max(0, Math.min(1, v / 100))
      } else {
        // 估算：以 100px 短边为基准，pptxgenjs rectRadius 是相对比例
        out.borderRadiusFraction = Math.max(0, Math.min(0.5, v / 100))
      }
    }
  }

  // 4) box-shadow：只解析 "ox oy blur color" 这种最常见的 4 段格式
  // 也兼容 "ox oy blur spread color" 的 5 段格式（spread 直接忽略）
  const shadow = (style as unknown as { boxShadow?: string }).boxShadow || ''
  if (shadow && shadow.toLowerCase() !== 'none') {
    // 把 rgba(...) 里的逗号先替换掉，避免 split 拆碎
    const normalized = shadow.replace(/rgba?\([^)]+\)/g, (s) => s.replace(/\s*,\s*/g, '|'))
    const tokens = normalized.trim().split(/\s+/).map((t) => t.replace(/\|/g, ','))
    if (tokens.length >= 3) {
      const ox = parsePxNumber(tokens[0], 0)
      const oy = parsePxNumber(tokens[1], 4)
      const blur = parsePxNumber(tokens[2], 6)
      const colorPart = tokens[tokens.length - 1] || 'rgba(0,0,0,0.2)'
      const colorHex = normalizeColor(colorPart, '000000')
      const opacity = extractAlpha(colorPart)
      // pptxgenjs shadow.angle 是从 12 点方向顺时针的角度
      // ox=0 oy=正 → angle=90（向下），ox=正 oy=0 → angle=0（向右）；这里用 atan2 推
      const angleRad = Math.atan2(oy, ox === 0 ? 0.0001 : ox)
      const angleDeg = ((angleRad * 180) / Math.PI + 360) % 360
      const offset = Math.round(Math.sqrt(ox * ox + oy * oy))
      out.shadow = {
        type: 'outer',
        blur: Math.round(blur),
        offset: offset || 4,
        angle: Math.round(angleDeg) || 90,
        colorHex,
        opacity,
      }
    }
  }

  return out
}

/**
 * 解析 slide 容器的背景：返回写入 pptxgenjs slide.background 的对象，
 * 同时返回"已被消费的 DOM 元素"——用来在 extractBlocks 时跳过避免重复。
 *
 * 优先级：
 *   1. inline background-image: url(...)
 *   2. 容器内首个全屏 <img>（width/height 是 100% 或 100v* 或 cover）
 *   3. inline background-color
 *   4. 兜底白色
 */
function resolveSlideBackground(
  slideEl: Element,
  resourceBaseDir: string,
  warnings: string[],
): { background: { color?: string; data?: string; path?: string }; consumed?: Element } {
  const style = (slideEl as HTMLElement).style

  // 1) background-image
  const bgImage = style?.backgroundImage || ''
  const m = bgImage.match(/url\((['"]?)(.+?)\1\)/)
  if (m) {
    const ref = resolveImageRef(m[2], resourceBaseDir, warnings)
    if (ref) return { background: ref }
  }

  // 2) 首个全屏 img
  const firstImg = slideEl.querySelector(':scope > img, :scope > picture > img')
  if (firstImg) {
    const imgStyle = (firstImg as HTMLElement).style
    const w = (imgStyle?.width || '').toLowerCase()
    const h = (imgStyle?.height || '').toLowerCase()
    const objectFit = (imgStyle as unknown as { objectFit?: string })?.objectFit?.toLowerCase() || ''
    const isFullScreen =
      (w === '100%' || w === '100vw') && (h === '100%' || h === '100vh') ||
      objectFit === 'cover' || objectFit === 'contain'
    if (isFullScreen) {
      const src = firstImg.getAttribute('src')
      if (src) {
        const ref = resolveImageRef(src, resourceBaseDir, warnings)
        if (ref) return { background: ref, consumed: firstImg }
      }
    }
  }

  // 3) background-color
  const bgColor = normalizeColor(style?.backgroundColor, '')
  if (bgColor) return { background: { color: bgColor } }

  // 4) 兜底
  return { background: { color: 'FFFFFF' } }
}

function extractBlocks(slide: Element, dom: JSDOM, skip?: Element): SlideBlock[] {
  const blocks: SlideBlock[] = []
  const win = dom.window as unknown as { getComputedStyle?: (e: Element) => CSSStyleDeclaration }
  const getStyle = (e: Element): Partial<CSSStyleDeclaration> => {
    try {
      const cs = win.getComputedStyle?.(e)
      // jsdom getComputedStyle 不解析 CSS 文件，但 inline style 能读出来
      if (cs) return cs
    } catch {}
    return (e as HTMLElement).style as unknown as CSSStyleDeclaration
  }

  // 递归遍历但只在叶子文本节点收集（避免把整段重复写出）
  const visited = new WeakSet<Element>()
  const walk = (node: Element): void => {
    if (visited.has(node)) return
    visited.add(node)
    if (skip && (node === skip || skip.contains(node))) return

    const tag = node.tagName.toLowerCase()
    const style = getStyle(node)
    const colorHex = normalizeColor(style.color, '111111')
    const text = (node.textContent || '').trim()
    const box = extractBoxStyle(node)

    if (tag === 'h1' || tag === 'h2') {
      if (text) {
        blocks.push({
          kind: 'title',
          text,
          fontSizePt: pxToPt(style.fontSize, tag === 'h1' ? 36 : 28),
          colorHex,
          bold: true,
          box,
        })
      }
      return
    }
    if (tag === 'h3' || tag === 'h4') {
      if (text) {
        blocks.push({
          kind: 'subtitle',
          text,
          fontSizePt: pxToPt(style.fontSize, 22),
          colorHex,
          bold: true,
          box,
        })
      }
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.querySelectorAll(':scope > li'))
        .map((li) => (li.textContent || '').trim())
        .filter(Boolean)
      if (items.length > 0) {
        blocks.push({
          kind: 'list',
          items,
          fontSizePt: pxToPt(style.fontSize, 16),
          colorHex,
          box,
        })
      }
      return
    }
    if (tag === 'p' || tag === 'blockquote') {
      if (text) {
        blocks.push({
          kind: 'paragraph',
          text,
          fontSizePt: pxToPt(style.fontSize, 16),
          colorHex,
          box,
        })
      }
      return
    }
    if (tag === 'img') {
      const src = node.getAttribute('src')
      if (src) {
        blocks.push({
          kind: 'image',
          imageSrc: src,
          fontSizePt: 0,
          colorHex,
          box,
        })
      }
      return
    }
    // 其它容器：递归子节点
    for (const child of Array.from(node.children)) {
      walk(child as Element)
    }
  }

  walk(slide)
  return blocks
}

/**
 * 把 BoxStyle 透传到 pptxgenjs addText/addImage 的 options。
 * 只附加命中的字段，避免覆盖默认。
 */
function applyBoxToOptions(box: BoxStyle | undefined, target: Record<string, unknown>): void {
  if (!box) return
  if (box.fillColorHex) target.fill = { color: box.fillColorHex }
  if (box.borderColorHex && box.borderWidthPt) {
    target.line = {
      color: box.borderColorHex,
      width: box.borderWidthPt,
      dashType: box.borderDash || 'solid',
    }
  }
  if (typeof box.borderRadiusFraction === 'number' && box.borderRadiusFraction > 0) {
    target.rectRadius = box.borderRadiusFraction
    // 圆角矩形必须用 ROUNDED_RECTANGLE shape；addText 通过 shape 指定
    target.shape = 'roundRect'
  }
  if (box.shadow) {
    target.shadow = {
      type: box.shadow.type,
      blur: box.shadow.blur,
      offset: box.shadow.offset,
      angle: box.shadow.angle,
      color: box.shadow.colorHex,
      opacity: box.shadow.opacity,
    }
  }
}

/**
 * 仅供单测使用的内部 helper 暴露。
 * 生产代码请使用 htmlToPptx 入口。
 */
export const __test = {
  normalizeColor,
  extractAlpha,
  pxToPt,
  parsePxNumber,
  extractBoxStyle,
  resolveSlideBackground,
  applyBoxToOptions,
}

/**
 * 把 HTML 转成 PPTX。返回写入路径与统计。
 */
export async function htmlToPptx(options: HtmlToPptxOptions): Promise<HtmlToPptxResult> {
  const slideW = options.slideWidth ?? DEFAULT_SLIDE_WIDTH
  const slideH = options.slideHeight ?? DEFAULT_SLIDE_HEIGHT
  const warnings: string[] = []

  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_WIDE' // 16:9，pptxgenjs 内置 13.333×7.5，与默认一致
  pres.defineLayout({ name: 'SOUL_CUSTOM', width: slideW, height: slideH })
  pres.layout = 'SOUL_CUSTOM'

  // 截图模式：直接每张图占一页
  if (options.slideScreenshots && options.slideScreenshots.length > 0) {
    for (const dataUrl of options.slideScreenshots) {
      const slide = pres.addSlide()
      slide.background = { color: 'FFFFFF' }
      slide.addImage({
        data: dataUrl,
        x: 0,
        y: 0,
        w: slideW,
        h: slideH,
        sizing: { type: 'contain', w: slideW, h: slideH },
      })
    }
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true })
    await pres.writeFile({ fileName: options.outputPath })
    return {
      outputPath: options.outputPath,
      slideCount: options.slideScreenshots.length,
      selectorUsed: '__screenshot_mode__',
      warnings,
    }
  }

  const dom = new JSDOM(options.htmlContent, { runScripts: 'outside-only' })
  const doc = dom.window.document
  const { sel, nodes } = pickPageSelector(doc, options.pageSelector)
  const slideNodes = nodes.length > 0 ? nodes : [doc.body || doc.documentElement]

  const resourceBaseDir = options.resourceBaseDir ?? path.dirname(options.outputPath)

  for (const slideEl of slideNodes) {
    const slide = pres.addSlide()

    // === 背景：colour / image / 全屏 img ===
    const { background, consumed } = resolveSlideBackground(slideEl, resourceBaseDir, warnings)
    slide.background = background

    const blocks = extractBlocks(slideEl, dom, consumed)

    // 简单纵向布局：标题在顶部，正文/列表向下流，图片放底部
    let cursorY = 0.4 // 英寸
    const leftMargin = 0.5
    const rightMargin = 0.5
    const contentW = slideW - leftMargin - rightMargin

    const images: SlideBlock[] = []

    for (const block of blocks) {
      if (block.kind === 'image') {
        images.push(block)
        continue
      }
      if (block.kind === 'title') {
        const h = Math.max(0.6, block.fontSizePt / 56)
        const opts: Record<string, unknown> = {
          x: leftMargin, y: cursorY, w: contentW, h,
          fontSize: block.fontSizePt,
          color: block.colorHex,
          bold: !!block.bold,
          fontFace: 'Calibri',
          valign: 'middle',
        }
        applyBoxToOptions(block.box, opts)
        slide.addText(block.text || '', opts as Parameters<typeof slide.addText>[1])
        cursorY += h + 0.15
      } else if (block.kind === 'subtitle') {
        const h = 0.5
        const opts: Record<string, unknown> = {
          x: leftMargin, y: cursorY, w: contentW, h,
          fontSize: block.fontSizePt,
          color: block.colorHex,
          bold: !!block.bold,
          fontFace: 'Calibri',
        }
        applyBoxToOptions(block.box, opts)
        slide.addText(block.text || '', opts as Parameters<typeof slide.addText>[1])
        cursorY += h + 0.1
      } else if (block.kind === 'paragraph') {
        const text = block.text || ''
        // 估算行高：每 80 字符占一行
        const lines = Math.max(1, Math.ceil(text.length / 80))
        const h = Math.min(slideH - cursorY - 0.5, lines * 0.32)
        const opts: Record<string, unknown> = {
          x: leftMargin, y: cursorY, w: contentW, h,
          fontSize: block.fontSizePt,
          color: block.colorHex,
          fontFace: 'Calibri',
          valign: 'top',
        }
        applyBoxToOptions(block.box, opts)
        slide.addText(text, opts as Parameters<typeof slide.addText>[1])
        cursorY += h + 0.1
      } else if (block.kind === 'list') {
        const items = block.items ?? []
        const h = Math.min(slideH - cursorY - 0.5, items.length * 0.36)
        const opts: Record<string, unknown> = {
          x: leftMargin, y: cursorY, w: contentW, h,
          fontSize: block.fontSizePt,
          color: block.colorHex,
          fontFace: 'Calibri',
          valign: 'top',
        }
        applyBoxToOptions(block.box, opts)
        slide.addText(
          items.map((t) => ({ text: t, options: { bullet: true } })),
          opts as Parameters<typeof slide.addText>[1],
        )
        cursorY += h + 0.15
      }
      if (cursorY >= slideH - 0.6) break
    }

    // 图片：放底部居中区域
    if (images.length > 0) {
      const remainH = slideH - cursorY - 0.3
      const imgH = Math.max(1.5, Math.min(3.5, remainH))
      const each = contentW / images.length
      images.forEach((img, idx) => {
        const ref = resolveImageRef(img.imageSrc || '', resourceBaseDir, warnings)
        if (!ref) return
        const opts: Record<string, unknown> = {
          ...ref,
          x: leftMargin + idx * each + 0.1,
          y: cursorY + 0.1,
          w: each - 0.2,
          h: imgH - 0.2,
          sizing: { type: 'contain', w: each - 0.2, h: imgH - 0.2 },
        }
        applyBoxToOptions(img.box, opts)
        slide.addImage(opts as Parameters<typeof slide.addImage>[0])
      })
    }
  }

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true })
  await pres.writeFile({ fileName: options.outputPath })
  return {
    outputPath: options.outputPath,
    slideCount: slideNodes.length,
    selectorUsed: sel,
    warnings,
  }
}
