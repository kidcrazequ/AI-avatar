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
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // 将 @soul/core/browser (CommonJS) 预构建为 ESM，确保命名导出可用。
  // 注意：默认入口 @soul/core 含 fs/path/process 等 Node-only 代码，
  //      渲染进程必须改用 /browser 子入口，参见 packages/core/src/browser.ts。
  optimizeDeps: {
    include: ['@soul/core/browser'],
  },
})
