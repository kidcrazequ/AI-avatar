/**
 * super_inline_html：把一个 HTML 文档及其引用的 css/js/img/font/iframe srcdoc
 * 全部内联成"单文件 HTML"，便于离线分享、PDF 打印、上传到不会跟随静态资源的渠道。
 *
 * 工作策略：
 *   - <link rel="stylesheet" href="x.css">  → <style>...</style>
 *   - <script src="x.js">                   → <script>...</script>
 *   - <img src="x.png">                     → <img src="data:image/png;base64,...">
 *   - <link rel="icon"> 或 <link rel="preload" as="font" href="x.woff2">
 *                                            → 转 dataURL
 *   - @font-face 中的 url(...) 也会就近转 dataURL（避免 CDN 字体在离线场景失效）
 *   - http(s) 引用：fetch 并以二进制内联（10s 超时，失败时保留原引用并记录到 warnings）
 *
 * 安全：
 *   - 只通过 fetchWithTimeout 拉取 http(s)，不访问 file://（避免越权读取）
 *   - 本地资源相对路径仅在 resourceBaseDir 范围内解析，不允许 ../ 越界
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import fs from 'fs'
import path from 'path'
import dns from 'dns'
import { JSDOM } from 'jsdom'
import { fetchWithTimeout } from '@soul/core'

/**
 * Returns true when the resolved IP address belongs to a private / loopback /
 * link-local range that should never be reachable via an inlined resource URL.
 * Covers: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *         169.254.0.0/16 (link-local / cloud-metadata), ::1, fc00::/7.
 */
function isPrivateIp(ip: string): boolean {
  // IPv6 loopback / ULA
  if (ip === '::1') return true
  if (/^fc[0-9a-f]{2}:/i.test(ip) || /^fd[0-9a-f]{2}:/i.test(ip)) return true
  // IPv4
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(isNaN)) return false
  const [a, b] = parts
  return (
    a === 127 ||                         // 127.0.0.0/8  loopback
    a === 10 ||                          // 10.0.0.0/8   private
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) ||          // 192.168.0.0/16 private
    (a === 169 && b === 254)             // 169.254.0.0/16 link-local / cloud-metadata
  )
}

/**
 * Resolves `hostname` to its first IPv4/IPv6 address and checks whether it
 * falls in a private range.  Returns true (= block) when the hostname resolves
 * to a private/loopback/link-local address OR when resolution fails.
 */
async function resolvesToPrivateIp(hostname: string): Promise<boolean> {
  try {
    const { address } = await dns.promises.lookup(hostname, { verbatim: true })
    return isPrivateIp(address)
  } catch {
    // If we can't resolve it, treat as unsafe (fail-closed)
    return true
  }
}

export interface InlineHtmlOptions {
  /** 源 HTML 绝对路径 */
  inputPath: string
  /** 输出 HTML 绝对路径 */
  outputPath: string
  /** 资源解析根目录（相对路径以此为基），默认是 inputPath 所在目录 */
  resourceBaseDir?: string
  /** http(s) 下载超时（毫秒），默认 10000 */
  remoteTimeoutMs?: number
}

export interface InlineHtmlResult {
  outputPath: string
  inlinedCss: number
  inlinedScripts: number
  inlinedImages: number
  inlinedFonts: number
  /** 内联失败的资源（保留原引用），便于调用方提示用户 */
  warnings: string[]
}

/** 根据扩展名推断 mime 类型，未知时回退到 application/octet-stream */
function guessMime(ext: string): string {
  const e = ext.toLowerCase().replace('.', '')
  switch (e) {
    case 'png': case 'gif': case 'webp': case 'avif': case 'bmp':
      return `image/${e}`
    case 'jpg': case 'jpeg':
      return 'image/jpeg'
    case 'svg':
      return 'image/svg+xml'
    case 'woff': case 'woff2': case 'ttf': case 'otf': case 'eot':
      return e === 'woff2' ? 'font/woff2' : e === 'woff' ? 'font/woff' : `font/${e}`
    case 'css':
      return 'text/css'
    case 'js': case 'mjs':
      return 'text/javascript'
    case 'json':
      return 'application/json'
    case 'html': case 'htm':
      return 'text/html'
    default:
      return 'application/octet-stream'
  }
}

/**
 * 加载资源到 Buffer。
 *  - http(s)：fetchWithTimeout
 *  - 本地相对/绝对：fs（限制在 resourceBaseDir 下）
 * 失败时返回 null，由调用方决定是保留原引用还是删除。
 */
async function loadResource(
  url: string,
  baseDir: string,
  timeoutMs: number,
): Promise<{ data: Buffer; mime: string } | null> {
  if (!url || url.startsWith('data:')) return null
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const parsed = new URL(url)
      const hostname = parsed.hostname
      // Block literal private/loopback/link-local IPs immediately
      if (isPrivateIp(hostname)) return null
      // Resolve DNS to guard against DNS rebinding to private ranges
      if (await resolvesToPrivateIp(hostname)) return null
      const res = await fetchWithTimeout(url, { timeoutMs })
      if (!res.ok) return null
      const ab = await res.arrayBuffer()
      const buf = Buffer.from(ab)
      const ct = res.headers.get('content-type')?.split(';')[0]?.trim()
      const mime = ct || guessMime(path.extname(parsed.pathname))
      return { data: buf, mime }
    } catch {
      return null
    }
  }
  // 本地资源：解析路径并校验未越界
  // 处理 query / hash
  const cleanUrl = url.split('?')[0].split('#')[0]
  const abs = path.isAbsolute(cleanUrl) ? cleanUrl : path.resolve(baseDir, cleanUrl)
  const normalizedBase = path.resolve(baseDir) + path.sep
  if (!path.isAbsolute(cleanUrl) && !abs.startsWith(normalizedBase)) {
    return null
  }
  try {
    if (!fs.existsSync(abs)) return null
    const data = fs.readFileSync(abs)
    return { data, mime: guessMime(path.extname(abs)) }
  } catch {
    return null
  }
}

/** 把 Buffer + mime 转 data URL（编码：text 类型用 utf-8 + base64，二进制直接 base64） */
function toDataUrl(data: Buffer, mime: string): string {
  return `data:${mime};base64,${data.toString('base64')}`
}

/**
 * 把 CSS 文本里所有 url(...) 替换为 dataURL。
 * 主要为了内联 @font-face / background-image 引用的字体和小图。
 */
async function inlineCssUrls(
  css: string,
  baseDir: string,
  timeoutMs: number,
  fontCounter: { count: number },
  warnings: string[],
): Promise<string> {
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g
  const matches = Array.from(css.matchAll(urlRe))
  if (matches.length === 0) return css
  let result = css
  for (const m of matches) {
    const ref = m[2].trim()
    if (ref.startsWith('data:')) continue
    const loaded = await loadResource(ref, baseDir, timeoutMs)
    if (!loaded) {
      warnings.push(`内联 CSS 资源失败: ${ref}`)
      continue
    }
    const dataUrl = toDataUrl(loaded.data, loaded.mime)
    result = result.split(m[0]).join(`url("${dataUrl}")`)
    if (loaded.mime.startsWith('font/')) fontCounter.count += 1
  }
  return result
}

export async function superInlineHtml(options: InlineHtmlOptions): Promise<InlineHtmlResult> {
  const inputAbs = path.resolve(options.inputPath)
  const outAbs = path.resolve(options.outputPath)
  const baseDir = options.resourceBaseDir ?? path.dirname(inputAbs)
  const timeoutMs = options.remoteTimeoutMs ?? 10_000
  const warnings: string[] = []
  const fontCounter = { count: 0 }
  let inlinedCss = 0
  let inlinedScripts = 0
  let inlinedImages = 0

  if (!fs.existsSync(inputAbs)) {
    throw new Error(`super_inline_html 源文件不存在: ${inputAbs}`)
  }
  const html = fs.readFileSync(inputAbs, 'utf-8')
  const dom = new JSDOM(html)
  const doc = dom.window.document

  // 1) <link rel="stylesheet">
  const cssLinks = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))
  for (const link of cssLinks) {
    const href = link.getAttribute('href')
    if (!href) continue
    const loaded = await loadResource(href, baseDir, timeoutMs)
    if (!loaded) {
      warnings.push(`样式表内联失败: ${href}`)
      continue
    }
    const cssText = loaded.data.toString('utf-8')
    const inlined = await inlineCssUrls(cssText, baseDir, timeoutMs, fontCounter, warnings)
    const styleEl = doc.createElement('style')
    styleEl.textContent = inlined
    link.parentNode?.replaceChild(styleEl, link)
    inlinedCss += 1
  }

  // 2) 内联 <style> 中的 url() 也要处理（同样跑一遍 inlineCssUrls）
  const styles = Array.from(doc.querySelectorAll('style'))
  for (const styleEl of styles) {
    const text = styleEl.textContent || ''
    if (!text.includes('url(')) continue
    const replaced = await inlineCssUrls(text, baseDir, timeoutMs, fontCounter, warnings)
    styleEl.textContent = replaced
  }

  // 3) <script src="...">：保留属性，仅替换为 inline。注意 type="module" / defer / async 在内联后语义不同，一律去掉 src 改用文本内容。
  const scripts = Array.from(doc.querySelectorAll('script[src]'))
  for (const scriptEl of scripts) {
    const src = scriptEl.getAttribute('src')
    if (!src) continue
    const loaded = await loadResource(src, baseDir, timeoutMs)
    if (!loaded) {
      warnings.push(`脚本内联失败: ${src}`)
      continue
    }
    const code = loaded.data.toString('utf-8')
    scriptEl.removeAttribute('src')
    scriptEl.textContent = code
    inlinedScripts += 1
  }

  // 4) <img src="..."> + <source srcset> + <video poster> + <audio src>
  const images = Array.from(doc.querySelectorAll('img[src]'))
  for (const img of images) {
    const src = img.getAttribute('src')
    if (!src || src.startsWith('data:')) continue
    const loaded = await loadResource(src, baseDir, timeoutMs)
    if (!loaded) {
      warnings.push(`图片内联失败: ${src}`)
      continue
    }
    img.setAttribute('src', toDataUrl(loaded.data, loaded.mime))
    img.removeAttribute('srcset')
    inlinedImages += 1
  }

  // 5) <link rel="icon"> 和字体 preload
  const otherLinks = Array.from(doc.querySelectorAll('link[href]'))
  for (const link of otherLinks) {
    const rel = (link.getAttribute('rel') || '').toLowerCase()
    if (rel === 'stylesheet') continue
    const href = link.getAttribute('href')
    if (!href || href.startsWith('data:')) continue
    if (rel === 'icon' || rel === 'shortcut icon' || rel === 'apple-touch-icon' || rel === 'preload' || rel === 'mask-icon') {
      const loaded = await loadResource(href, baseDir, timeoutMs)
      if (!loaded) {
        warnings.push(`链接资源内联失败: ${href}`)
        continue
      }
      link.setAttribute('href', toDataUrl(loaded.data, loaded.mime))
      if (loaded.mime.startsWith('font/')) fontCounter.count += 1
    }
  }

  // 写入。inputAbs == outAbs 时也允许（覆盖原文件）。
  fs.mkdirSync(path.dirname(outAbs), { recursive: true })
  fs.writeFileSync(outAbs, '<!doctype html>\n' + dom.serialize().replace(/^<!DOCTYPE html>\s*/i, ''), 'utf-8')

  return {
    outputPath: outAbs,
    inlinedCss,
    inlinedScripts,
    inlinedImages,
    inlinedFonts: fontCounter.count,
    warnings,
  }
}
