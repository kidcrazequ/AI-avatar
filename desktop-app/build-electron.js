const esbuild = require('esbuild')
const path = require('path')
const fs = require('fs')

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
}).then(() => {
  // pdf-parse 依赖 pdfjs-dist 的 worker 文件，需拷贝到输出目录
  const workerSrc = path.join(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.mjs')
  const workerDest = path.join(__dirname, 'dist-electron/pdf.worker.mjs')
  if (fs.existsSync(workerSrc)) {
    fs.copyFileSync(workerSrc, workerDest)
    console.log('✅ pdf.worker.mjs 已拷贝')
  }
  console.log('✅ Electron 主进程编译完成')
}).catch((error) => {
  console.error('❌ 编译失败:', error)
  process.exit(1)
})
