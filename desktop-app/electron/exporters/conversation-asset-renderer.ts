/**
 * 会话导出：chart / mermaid 离屏渲染成 SVG（借鉴 Pi export-to-HTML；F8 进阶）。
 *
 * 复用 document-pdf-renderer 的隐藏 BrowserWindow 套路：起一个离屏窗口，inline 引入
 * echarts + mermaid（都用 **SVG renderer**，不依赖 GPU/canvas，规避离屏无 GPU 的坑），
 * 把每个 chart/mermaid 源码渲成 SVG，回收 { key: svg } 映射给导出侧替换。
 *
 * 安全降级（关键）：任何失败（lib 解析不到 / 渲染异常 / 超时 / 窗口创建失败）都只返回
 * 部分或空 Map —— 导出侧据此回退为代码块，**永不破坏导出**。echarts SVG 文本经库转义、
 * mermaid 用 securityLevel:'strict'，注入 SVG 的 XSS 面被压到最低。
 *
 * @author zhi.qu
 * @date 2026-06-02
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { BrowserWindow } from 'electron'
import type { Logger } from '../logger'

export interface RenderableAssetBlock {
  kind: 'chart' | 'mermaid'
  code: string
}

export interface RenderAssetsOptions {
  timeoutMs?: number
  logger?: Pick<Logger, 'activity' | 'error'>
}

/** key 约定与导出侧 resolveAsset 一致：`${kind}:${code}`。 */
export function assetKey(kind: 'chart' | 'mermaid', code: string): string {
  return `${kind}:${code}`
}

const RENDER_TIMEOUT_MS = 20_000

/** 动态拼 specifier 让 esbuild 不静态跟随（echarts/mermaid 不进主包，只在离屏页 file:// 引入）。 */
function resolveLibPath(pkg: string, rel: string): string | null {
  try {
    return require.resolve([pkg, ...rel.split('/')].join('/'))
  } catch {
    return null
  }
}

/**
 * 把 chart/mermaid 块离屏渲染成 SVG。返回 key→svg 映射；渲不出的块不进 Map（导出侧回退代码块）。
 */
export async function renderConversationAssets(
  blocks: RenderableAssetBlock[],
  options: RenderAssetsOptions = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (blocks.length === 0) return out

  const echartsPath = resolveLibPath('echarts', 'dist/echarts.min.js')
  const mermaidPath = resolveLibPath('mermaid', 'dist/mermaid.min.js')
  if (!echartsPath && !mermaidPath) {
    options.logger?.activity?.('conversation-asset-render', '未解析到 echarts/mermaid，全部回退代码块')
    return out
  }

  // 去重：相同 (kind, code) 只渲一次
  const uniq = new Map<string, RenderableAssetBlock>()
  for (const b of blocks) uniq.set(assetKey(b.kind, b.code), b)
  const payload = [...uniq.entries()].map(([key, b]) => ({ key, kind: b.kind, code: b.code }))

  // 内嵌进 <script> 的 JSON 必须转义 </ ，否则 chart/mermaid 源码里出现 </script> 会截断脚本块、
  // 导致渲染页 JS 报错、__ASSETS_RESULT__ 永不就绪、白等到超时（标准的 HTML-嵌-JSON 防护）。
  const payloadJson = JSON.stringify(payload).replace(/<\//g, '<\\/')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-asset-render-'))
  const htmlPath = path.join(tmpDir, 'render.html')
  const scripts = [
    echartsPath ? `<script src="file://${echartsPath}"></script>` : '',
    mermaidPath ? `<script src="file://${mermaidPath}"></script>` : '',
  ].join('\n')
  // 渲染脚本在离屏页内执行：echarts 用 svg renderer，mermaid 用 strict；逐块 try/catch，单块失败不拖累其它。
  const html = `<!doctype html><html><head><meta charset="utf-8">${scripts}</head>
<body><div id="stage" style="position:absolute;left:-9999px;top:0"></div><script>
(async function(){
  var blocks = ${payloadJson};
  var out = {};
  var stage = document.getElementById('stage');
  if (window.mermaid) { try { window.mermaid.initialize({ startOnLoad:false, securityLevel:'strict' }); } catch(e){} }
  for (var i=0;i<blocks.length;i++){
    var b = blocks[i];
    try {
      if (b.kind==='chart' && window.echarts) {
        var div = document.createElement('div');
        div.style.width='640px'; div.style.height='400px';
        stage.appendChild(div);
        var opt = JSON.parse(b.code);
        var c = window.echarts.init(div, null, { renderer:'svg' });
        c.setOption(opt);
        var svg = div.querySelector('svg');
        if (svg) out[b.key] = svg.outerHTML;
        c.dispose();
      } else if (b.kind==='mermaid' && window.mermaid) {
        var r = await window.mermaid.render('soul-mmd-'+i, b.code);
        if (r && r.svg) out[b.key] = r.svg;
      }
    } catch(e) { /* 单块失败 → 不进 out → 导出侧回退代码块 */ }
  }
  window.__ASSETS_RESULT__ = JSON.stringify(out);
})();
</script></body></html>`
  fs.writeFileSync(htmlPath, html, 'utf-8')

  let win: BrowserWindow | null = null
  const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS
  try {
    win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      // 对齐 document-pdf-renderer 的安全档位：sandbox + contextIsolation 全开。页面只跑本地受控
      // 渲染脚本、不需要 Node；executeJavaScript 默认在主世界执行，仍能读到页面设的 __ASSETS_RESULT__。
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
    })
    await win.loadFile(htmlPath)
    const start = Date.now()
    let resultJson: string | null = null
    while (Date.now() - start < timeoutMs) {
      resultJson = (await win.webContents.executeJavaScript('window.__ASSETS_RESULT__ || null')) as string | null
      if (resultJson) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (resultJson) {
      const parsed = JSON.parse(resultJson) as Record<string, string>
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v.length > 0) out.set(k, v)
      }
    } else {
      options.logger?.activity?.('conversation-asset-render', `渲染超时（${timeoutMs}ms），全部回退代码块`)
    }
  } catch (err) {
    options.logger?.error?.('conversation-asset-render', err instanceof Error ? err : new Error(String(err)))
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  }
  return out
}
