import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import pkg from './package.json'

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // @soul/core/browser 直读 TS 源码（2026-07-06 事故根治）：
      // 之前走 optimizeDeps 预打包 dist/browser.js（CJS），有两类必然故障：
      //   ① file: 链接包重建 dist 后 vite 缓存不失效 → 渲染层用旧代码；
      //   ② esbuild 对 tsc 的 defineProperty getter 重导出识别失败 → 所有
      //      命名导出变 undefined，发消息在 normalizeIntentLocal() 处静默炸。
      // 直读源码 = 原生 ESM 命名导出 + 免预打包 + core 源码改动即时 HMR，
      // 与 electron 侧 build-electron.js 的 soulCoreSrcPlugin 同一策略。
      // 浏览器入口闭包已验证零外部依赖、零 Node 内置（见 browser.ts 头注）。
      { find: /^@soul\/core\/browser$/, replacement: path.resolve(__dirname, '../packages/core/src/browser.ts') },
      // @antv/infographic 的间接依赖（postcss / source-map-js / linkedom 等）会 import
      // Node 内置模块。Vite 默认 externalize 这些模块，运行时访问属性会狂刷
      // "Module has been externalized for browser compatibility" 警告（一次渲染 12+ 条）。
      // 这里把所有 Node-only 模块重定向到自己的浏览器 stub，提供 noop 实现，
      // 消除 console 噪音。stub 见 src/shims/empty-node-module.ts。
      //
      // 仅 exact match（用 RegExp `^path$` 而不是字符串 'path'），避免误匹配
      // npm 包里类似 'my-package/path/utils' 这种路径。
      { find: /^path$/, replacement: path.resolve(__dirname, './src/shims/empty-node-module.ts') },
      { find: /^fs$/, replacement: path.resolve(__dirname, './src/shims/empty-node-module.ts') },
      { find: /^url$/, replacement: path.resolve(__dirname, './src/shims/empty-node-module.ts') },
      { find: /^source-map-js$/, replacement: path.resolve(__dirname, './src/shims/empty-node-module.ts') },
    ],
  },
  server: {
    fs: {
      // @soul/core/browser 别名指向仓库根下的 ../packages/core/src，
      // dev server 需要允许访问 desktop-app 之外的这部分源码
      allow: [path.resolve(__dirname, '..')],
    },
  },
  // 注意：默认入口 @soul/core 含 fs/path/process 等 Node-only 代码，
  // 渲染进程必须用 /browser 子入口（上方 alias 已定向到其 TS 源码，
  // 不再走 optimizeDeps 预打包——CJS 互操作与链接包缓存脱节均不复存在）。
})
