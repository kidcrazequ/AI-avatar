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
  // 将 @soul/core/browser (CommonJS) 预构建为 ESM，确保命名导出可用。
  // 注意：默认入口 @soul/core 含 fs/path/process 等 Node-only 代码，
  //      渲染进程必须改用 /browser 子入口，参见 packages/core/src/browser.ts。
  optimizeDeps: {
    include: ['@soul/core/browser'],
  },
})
