/**
 * Soul Embed widget Vite 构建配置。
 *
 * - IIFE 单文件输出（lib mode + formats: ['iife']）
 * - 入口 src/main.ts，产出 dist/soul-embed.js（不带 hash，方便 widget-server 静态托管）
 * - process.env.NODE_ENV 强制 production，避免 preact 走开发分支
 * - @preact/preset-vite 让 .tsx 自动用 h(...) 编译（jsxImportSource: 'preact'）
 * - 不暴露全局 SoulEmbed 给 window（IIFE 自执行注册 customElement，name 仅为 lib mode 必填项）
 *
 * @author zhi.qu
 * @date 2026-05-09
 */
import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [preact()],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    target: 'es2018',
    minify: 'esbuild',
    cssCodeSplit: false,
    sourcemap: false,
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/main.ts'),
      name: 'SoulEmbed',
      formats: ['iife'],
      fileName: () => 'soul-embed.js',
    },
    rollupOptions: {
      output: {
        // 单文件 IIFE，不切分
        inlineDynamicImports: true,
        // 不留 vendor 提示
        extend: false,
      },
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
})
