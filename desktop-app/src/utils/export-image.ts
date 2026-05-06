/**
 * export-image.ts — 图像导出共用工具：SVG → PNG dataURL、dataURL → Blob。
 *
 * 由 Mermaid / Infographic 渲染器复用。ECharts 走自己的 instance.getDataURL
 * 不需要这里的 svgElementToPngDataUrl。
 *
 * 拆到独立文件而不是和组件放在一起的原因：
 *   1. 让 RendererToolbar 保持纯组件文件（满足 react-refresh/only-export-components）
 *   2. 工具函数无 React 依赖，更易单测
 *
 * @author zhi.qu
 * @date 2026-05-05
 */

/**
 * 把 dataURL 转成 Blob。
 * 不用 fetch(dataUrl).then(r=>r.blob())：项目编码规范禁止裸 fetch，
 * 而 dataURL 没有真正的网络请求，用 fetchWithTimeout 包装也不合语义。
 * 手动解析 base64 / urlencoded 部分，零依赖且符合规范。
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(',')
  if (commaIdx < 0) {
    throw new Error('非法 dataURL：缺少逗号分隔符')
  }
  const header = dataUrl.slice(0, commaIdx)
  const encoded = dataUrl.slice(commaIdx + 1)
  const mimeMatch = /data:([^;]+)/.exec(header)
  const mime = mimeMatch?.[1] ?? 'application/octet-stream'
  const isBase64 = header.includes(';base64')
  const raw = isBase64 ? atob(encoded) : decodeURIComponent(encoded)

  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime })
}

/**
 * 把 SVG 节点序列化成 base64 data URL，用于 Image.src。
 *
 * 选用 data URL 而非 Blob URL 的原因：
 *   Electron 渲染进程默认通过 file:// 协议加载 index.html，Blob URL 被 Chromium
 *   视为跨域资源；即使 Image 加载成功，drawImage 后 canvas 会被标记为 tainted，
 *   toDataURL 抛 "Tainted canvases may not be exported"。
 *   data URL 在 Chromium 里始终为 same-origin，不会污染 canvas。
 *
 * 处理：
 *   - 补齐 xmlns / xmlns:xlink 命名空间（XMLSerializer 偶发吞 xmlns，独立加载会报错）
 *   - 写显式 width/height 属性，保证 Image 解码后 naturalWidth/Height 非零
 *   - encodeURIComponent + unescape 兼容多字节字符（btoa 对 latin1 之外抛错）；
 *     对所有 UTF-8 SVG 内容（含中文 / emoji 等）都能稳定 base64 编码
 */
function svgElementToDataUrl(svgEl: SVGElement, width: number, height: number): string {
  const cloned = svgEl.cloneNode(true) as SVGElement
  if (!cloned.getAttribute('xmlns')) cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  if (!cloned.getAttribute('xmlns:xlink')) cloned.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
  cloned.setAttribute('width', String(width))
  cloned.setAttribute('height', String(height))

  const svgStr = new XMLSerializer().serializeToString(cloned)
  const svgBase64 = btoa(unescape(encodeURIComponent(svgStr)))
  return `data:image/svg+xml;base64,${svgBase64}`
}

/**
 * Chromium 单 canvas 像素上限保守值。
 * 实际上限随版本/平台而异（从 4096×4096 到 16384×16384 不等），超限时 toDataURL
 * 静默返回空字符串，导致下载文件 0 字节。8192 是大多数实测安全的上界。
 */
const MAX_CANVAS_DIMENSION = 8192

/**
 * 优先取 SVG 的内禀尺寸（viewBox），bbox/width/height 属性作为兜底。
 *
 * 为什么不直接用 getBoundingClientRect：
 *   mermaid 输出 `width="100%"`，DOM 渲染尺寸取决于父容器；在气泡里 ≈ 500-700px，
 *   导出 PNG = 500 × 2 = 1000px，放大查看就糊。viewBox 是 mermaid 计算出的真实
 *   图形空间（通常 1500-3000px），用它作为基准导出，PNG 会清晰得多。
 */
function getIntrinsicSize(svgEl: SVGElement): { width: number; height: number } {
  // 1. viewBox：最可靠（mermaid / infographic 都设置了）
  const svgRoot = svgEl as SVGSVGElement
  const viewBox = svgRoot.viewBox?.baseVal
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    return { width: Math.ceil(viewBox.width), height: Math.ceil(viewBox.height) }
  }

  // 2. 显式 width/height 属性（仅当是像素值，跳过 100% 这种比例值）
  const widthAttr = svgEl.getAttribute('width')
  const heightAttr = svgEl.getAttribute('height')
  const widthNum = widthAttr && !widthAttr.includes('%') ? parseFloat(widthAttr) : NaN
  const heightNum = heightAttr && !heightAttr.includes('%') ? parseFloat(heightAttr) : NaN
  if (Number.isFinite(widthNum) && Number.isFinite(heightNum) && widthNum > 0 && heightNum > 0) {
    return { width: Math.ceil(widthNum), height: Math.ceil(heightNum) }
  }

  // 3. 兜底：DOM 渲染后的实际尺寸（可能偏小，但至少不是 0）
  const bbox = svgEl.getBoundingClientRect()
  return { width: Math.ceil(bbox.width), height: Math.ceil(bbox.height) }
}

/**
 * SVG 节点 → PNG dataURL。
 *
 * 流程：XMLSerializer → data:image/svg+xml;base64,... → new Image() → canvas.drawImage → toDataURL('image/png')
 *
 * 关键点：
 *   - 用 base64 data URL（不是 Blob URL）：在 Electron file:// 加载下 Blob URL
 *     会被 Chromium 视为跨域，污染 canvas 让 toDataURL 抛 "Tainted canvases" 错
 *   - Image.crossOrigin = 'anonymous'：显式把图标记为 CORS-clean，双保险
 *   - 优先以 SVG viewBox 内禀尺寸为基准导出（清晰），不依赖 DOM 渲染缩放
 *   - 自动收敛 pixelRatio：当 viewBox 很大时（复杂流程图），强行 ×2 会让 canvas
 *     超过 Chromium 单 canvas 上限（≈ 8192px 边长），toDataURL 静默返回空字符串
 *   - 含 <foreignObject>（HTML 节点）时 Chromium drawImage 可能丢内容；这是
 *     已知限制，无法在浏览器侧解决。绝大多数 mermaid 图不含 foreignObject
 *   - 给个非透明底色（默认 px.bg），防止 PNG 在浅色背景下文字看不清
 */
export async function svgElementToPngDataUrl(
  svgEl: SVGElement,
  pixelRatio = 2,
  background = '#0A0A0F',
): Promise<string> {
  const { width, height } = getIntrinsicSize(svgEl)
  if (width === 0 || height === 0) {
    throw new Error('SVG 尺寸为 0，无法导出（可能未渲染完成）')
  }

  // 收敛 pixelRatio，避免超 canvas 上限导致空 PNG
  const longestSide = Math.max(width, height)
  const safeRatio = Math.min(pixelRatio, MAX_CANVAS_DIMENSION / longestSide)
  const finalRatio = Math.max(1, safeRatio) // 最低 1x 保证有内容

  const svgDataUrl = svgElementToDataUrl(svgEl, width, height)

  const image = new Image()
  // 显式 crossOrigin='anonymous' 防止 canvas 被污染（Electron file:// 下尤其重要）
  image.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = (e) => reject(new Error(`SVG 图像加载失败: ${String(e)}`))
    image.src = svgDataUrl
  })

  // onload 触发 ≠ 解码成功；显式校验
  if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0) {
    throw new Error('SVG 图像解码失败（naturalWidth/Height 为 0）')
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(width * finalRatio)
  canvas.height = Math.floor(height * finalRatio)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas getContext 失败')
  ctx.scale(finalRatio, finalRatio)
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)

  const dataUrl = canvas.toDataURL('image/png')
  // toDataURL 在 canvas 超限时会返回 'data:,' 这种空字符串
  if (!dataUrl || dataUrl.length < 'data:image/png;base64,'.length + 100) {
    throw new Error(
      `PNG 编码失败（输出过短，可能 canvas 超过浏览器上限：${canvas.width}x${canvas.height}）`,
    )
  }
  return dataUrl
}
