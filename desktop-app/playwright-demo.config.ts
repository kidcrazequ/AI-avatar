/**
 * Playwright 演示视频专用配置
 * 
 * 与正式测试配置分离，专门用于录制产品演示视频。
 * 使用方式：npx playwright test --config=playwright-demo.config.ts
 * 
 * @author zhi.qu
 * @date 2026-04-02
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'demo-video.spec.ts',
  timeout: 180000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
  ],
  use: {
    video: {
      mode: 'on',
      size: { width: 1920, height: 1080 },
    },
    trace: 'off',
    screenshot: 'off',
  },
})
