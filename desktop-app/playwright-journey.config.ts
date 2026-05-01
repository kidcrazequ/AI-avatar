/**
 * Playwright 用户旅程专用配置
 *
 * 场景：小堵-工商储专家 从零创建到首次对话
 * 运行：npm run journey:xiaodu
 *
 * @author zhi.qu
 * @date 2026-04-03
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'user-journey-xiaodu.spec.ts',
  /** 总超时 10 分钟（含 AI 生成 + PDF LLM 处理） */
  timeout: 600000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    video: {
      mode: 'on',
      size: { width: 1200, height: 800 },
    },
    trace: 'off',
    screenshot: 'off',
  },
})
