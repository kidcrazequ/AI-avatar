const esbuild = require('esbuild')
const path = require('path')

// 编译 Electron 主进程和 preload 脚本
esbuild.build({
  entryPoints: [
    path.join(__dirname, 'electron/main.ts'),
    path.join(__dirname, 'electron/preload.ts'),
    path.join(__dirname, 'electron/soul-loader.ts'),
  ],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outdir: path.join(__dirname, 'dist-electron'),
  external: ['electron', 'better-sqlite3'],
  format: 'cjs',
  sourcemap: true,
}).then(() => {
  console.log('✅ Electron 主进程编译完成')
}).catch((error) => {
  console.error('❌ 编译失败:', error)
  process.exit(1)
})
