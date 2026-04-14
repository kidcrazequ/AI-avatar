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
  ],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outdir: path.join(__dirname, 'dist-electron'),
  external: ['electron', 'better-sqlite3'],
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
