const esbuild = require('esbuild')
const path = require('path')
const fs = require('fs')

/**
 * 将 @soul/core 解析到仓库内 TypeScript 源码，避免依赖 packages/core/dist 是否已 build。
 * dist 未更新时会出现 AvatarManager 缺少 saveAvatarImage 等运行时错误。
 */
const soulCoreEntry = path.join(__dirname, '..', 'packages', 'core', 'src', 'index.ts')
const soulCoreSrcPlugin = {
  name: 'resolve-soul-core-src',
  setup(build) {
    build.onResolve({ filter: /^@soul\/core$/ }, () => ({ path: soulCoreEntry }))
  },
}

// 编译 Electron 主进程和 preload 脚本
esbuild.build({
  entryPoints: [
    path.join(__dirname, 'electron/main.ts'),
    path.join(__dirname, 'electron/preload.ts'),
    // L3 复刻：WebContentsView 专用 preload（注入 window.claude / inspector / tweaks）
    path.join(__dirname, 'electron/preview/preview-preload.ts'),
  ],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outdir: path.join(__dirname, 'dist-electron'),
  // jsdom 在 XMLHttpRequest 内通过 require.resolve('./xhr-sync-worker.js') 在运行时按 cwd 寻址；
  // 一旦被 esbuild 内联进 bundle，路径基准会丢失，运行时报 ENOENT。统一标 external，让主进程从
  // node_modules 里直接 require。同理把会做动态 require 的二进制/原生模块全部 external。
  external: ['electron', 'better-sqlite3', 'jsdom', '@octokit/rest', 'pptxgenjs', 'pdf-parse', 'nodejieba', '@vscode/ripgrep', 'archiver'],
  format: 'cjs',
  sourcemap: true,
  plugins: [soulCoreSrcPlugin],
}).then(() => {
  // pdf-parse v2 内部通过 import("./pdf.worker.mjs") 动态加载 pdfjs worker。
  // 在 Windows 打包后 asar 内 import() 加载 .mjs 有兼容性问题。
  // 解决方案：把 worker 预构建为 CJS，主进程启动时通过 require() 加载并
  // 挂到 globalThis.pdfjsWorker，pdfjs-dist 检测到后直接使用，跳过 import()。
  return esbuild.build({
    entryPoints: [path.join(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.mjs')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile: path.join(__dirname, 'dist-electron/pdf-worker.cjs'),
    format: 'cjs',
  })
}).then(() => {
  console.log('✅ pdf-worker.cjs 已构建（CJS 格式，绕过 asar import() 兼容问题）')

  // #16: Excel 解析 worker —— 大 xlsx 的 XLSX.readFile + sheet_to_json 是同步 CPU 密集操作，
  // 放在主进程会冻结事件循环且超时无法中断。搬到 worker_threads 后主进程可 worker.terminate()
  // 强杀卡死解析。单独打成 CJS（xlsx 纯 JS 一并 bundle），主进程 new Worker(...cjs)。
  return esbuild.build({
    entryPoints: [path.join(__dirname, 'electron/workers/excel-parse.worker.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile: path.join(__dirname, 'dist-electron/excel-parse-worker.cjs'),
    format: 'cjs',
    plugins: [soulCoreSrcPlugin],
  })
}).then(() => {
  console.log('✅ excel-parse-worker.cjs 已构建（worker_threads，避免大 xlsx 冻结主进程）')

  // node-unrar-js 的 WASM 文件需要拷贝到输出目录（esbuild 无法打包 .wasm 二进制）
  const unrarWasm = path.join(__dirname, 'node_modules/node-unrar-js/dist/js/unrar.wasm')
  const unrarDest = path.join(__dirname, 'dist-electron/unrar.wasm')
  if (fs.existsSync(unrarWasm)) {
    fs.copyFileSync(unrarWasm, unrarDest)
    console.log('✅ unrar.wasm 已拷贝')
  }

  console.log('✅ Electron 主进程编译完成')
}).catch((error) => {
  console.error('❌ 编译失败:', error)
  process.exit(1)
})
