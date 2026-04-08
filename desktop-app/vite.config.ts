import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // 将 @soul/core (CommonJS) 预构建为 ESM，确保命名导出可用
  optimizeDeps: {
    include: ['@soul/core'],
  },
})
