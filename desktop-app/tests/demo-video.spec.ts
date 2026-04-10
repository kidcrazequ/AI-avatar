/**
 * 桌面端演示视频录制脚本
 *
 * 使用 Playwright 模拟真实用户操作，通过顺序截图 + ffmpeg 合成演示视频。
 *
 * 使用方式：
 *   1. npm run build          # 先构建应用
 *   2. npm run demo:video     # 运行演示录制
 *   3. 视频输出到 test-output/demo-videos/demo.mp4
 *
 * @author zhi.qu
 * @date 2026-04-02
 */
import { test, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'

const FRAMES_DIR = path.join(__dirname, '../test-output/demo-videos/frames')
const OUTPUT_VIDEO = path.join(__dirname, '../test-output/demo-videos/demo.mp4')
const FPS = 4

let electronApp: ElectronApplication
let page: Page
let frameIndex = 0

/** 截取一帧 */
async function captureFrame() {
  try {
    const framePath = path.join(FRAMES_DIR, `frame_${String(frameIndex).padStart(5, '0')}.png`)
    await page.screenshot({ path: framePath, timeout: 3000 })
    frameIndex++
  } catch {
    // 页面转换中，跳过
  }
}

/** 持续截帧 + 等待（替代 waitForTimeout，同时采集帧）*/
async function captureAndWait(ms: number) {
  const frames = Math.max(1, Math.floor(ms / (1000 / FPS)))
  const interval = ms / frames
  for (let i = 0; i < frames; i++) {
    await captureFrame()
    await page.waitForTimeout(interval)
  }
}

/** 使用 ffmpeg 将截图序列合成 mp4 视频 */
function encodeVideo() {
  console.log(`\n🎬 合成视频: ${frameIndex} 帧 @ ${FPS}fps → ${OUTPUT_VIDEO}`)
  try {
    execSync(
      `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame_%05d.png" ` +
      `-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black" ` +
      `-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p "${OUTPUT_VIDEO}"`,
      { stdio: 'inherit' }
    )
    console.log(`✅ 视频已生成: ${OUTPUT_VIDEO}`)
  } catch (e) {
    console.error('❌ ffmpeg 合成失败:', (e as Error).message)
  }
}

/** 模拟真实用户逐字输入（每个字符后截帧） */
async function typeSlowly(text: string, delayMs = 80) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: delayMs })
    if (frameIndex % 2 === 0) await captureFrame()
  }
}

/** 鼠标移到元素上，增强视觉引导 */
async function hoverElement(selector: string) {
  const el = page.locator(selector).first()
  if (await el.isVisible().catch(() => false)) {
    await el.scrollIntoViewIfNeeded().catch(() => {})
    await el.hover({ force: true, timeout: 3000 }).catch(() => {})
    await captureAndWait(500)
  }
}

/** 关闭当前打开的面板 */
async function closePanel() {
  const closeBtn = page.locator('button[aria-label="关闭"]').first()
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click({ force: true })
    await captureAndWait(800)
  }
}

test.describe.configure({ mode: 'serial' })

test.describe('小堵桌面端 - 产品演示录制', () => {

  test.beforeAll(async () => {
    if (fs.existsSync(FRAMES_DIR)) {
      fs.rmSync(FRAMES_DIR, { recursive: true })
    }
    fs.mkdirSync(FRAMES_DIR, { recursive: true })

    console.log('\n🚀 启动 Electron 应用...')
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../dist-electron/main.js')],
      timeout: 30000,
    })

    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1920, 1080)
      win.center()
    })

    await page.waitForTimeout(1500)
    console.log('✅ 应用已启动（窗口: 1920x1080）')
    console.log('📹 开始录制...\n')
  })

  test.afterAll(async () => {
    // 结尾多截几帧
    await captureAndWait(3000)

    console.log(`\n📹 录制结束，共 ${frameIndex} 帧`)
    await electronApp.close()

    encodeVideo()

    // 清理帧文件
    if (fs.existsSync(FRAMES_DIR)) {
      fs.rmSync(FRAMES_DIR, { recursive: true })
    }
  })

  // ── 场景 1：应用启动 & 欢迎页 ──
  test('场景 1：应用启动 - 展示欢迎页', async () => {
    await captureAndWait(3000)
  })

  // ── 场景 2：选择分身并创建新对话 ──
  test('场景 2：创建新对话', async () => {
    // 先选择第一个分身（欢迎页 → 进入主界面）
    const avatarBtns = page.locator('.animate-fade-in button:has(.w-10)')
    if (await avatarBtns.count() > 0) {
      await avatarBtns.first().click()
      await captureAndWait(1500)
    } else {
      // 无分身时通过 API 创建一个，然后刷新页面
      await page.evaluate(async () => {
        await window.electronAPI.createAvatar('demo-test-avatar', '# Demo 分身\n\n录制演示用。', [], [])
      })
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await captureAndWait(1500)
      const newBtns = page.locator('.animate-fade-in button:has(.w-10)')
      if (await newBtns.count() > 0) {
        await newBtns.first().click()
        await captureAndWait(1500)
      }
    }

    await hoverElement('button:has-text("NEW CHAT")')
    await page.click('button:has-text("NEW CHAT")')
    await captureAndWait(2000)
  })

  // ── 场景 3：聊天界面 & 输入 ──
  test('场景 3：聊天界面 - 快捷问题和输入', async () => {
    await captureAndWait(2000)

    const quickBtn = page.locator('button:has-text("帮我做一个储能项目收益测算")')
    if (await quickBtn.isVisible().catch(() => false)) {
      await hoverElement('button:has-text("帮我做一个储能项目收益测算")')
      await captureAndWait(1500)
    }

    const textarea = page.locator('textarea').first()
    if (await textarea.isVisible()) {
      await textarea.click()
      await typeSlowly('请帮我设计一个 500kWh 工商业储能方案', 60)
      await captureAndWait(2500)
      await textarea.clear()
      await captureAndWait(500)
    }
  })

  // ── 场景 4：设置面板 ──
  test('场景 4：设置面板 - 多模型配置', async () => {
    await hoverElement('button[aria-label="设置"]')
    await page.click('button[aria-label="设置"]')
    await captureAndWait(2500)

    const settingsScroll = page.locator('.overflow-y-auto').first()
    if (await settingsScroll.isVisible().catch(() => false)) {
      await settingsScroll.evaluate(el => el.scrollBy(0, 250))
      await captureAndWait(1500)
      await settingsScroll.evaluate(el => el.scrollBy(0, 250))
      await captureAndWait(1500)
    }

    await closePanel()
    await captureAndWait(800)
  })

  // ── 场景 5：知识库面板 ──
  test('场景 5：知识库 - 文件树浏览', async () => {
    await hoverElement('button[aria-label="知识库"]')
    await page.click('button[aria-label="知识库"]')
    await captureAndWait(2500)

    const treeItems = page.locator('.cursor-pointer').filter({ hasText: /\.md|\.txt|knowledge/ })
    if (await treeItems.count() > 0) {
      await treeItems.first().click({ force: true })
      await captureAndWait(2000)
    }

    const searchInput = page.locator('input[placeholder*="搜索"], input[placeholder*="search"]')
    if (await searchInput.count() > 0) {
      await searchInput.first().click({ force: true })
      await page.keyboard.type('储能', { delay: 120 })
      await captureAndWait(2000)
      await searchInput.first().clear()
    }

    await closePanel()
    await captureAndWait(800)
  })

  // ── 场景 6：技能面板 ──
  test('场景 6：技能管理 - 查看与切换', async () => {
    await hoverElement('button[aria-label="技能"]')
    await page.click('button[aria-label="技能"]')
    await captureAndWait(2500)

    const skillItem = page.locator('.cursor-pointer, button').filter({ hasText: /\.md/ }).first()
    if (await skillItem.isVisible().catch(() => false)) {
      await skillItem.click({ force: true })
      await captureAndWait(2000)
    }

    await closePanel()
    await captureAndWait(800)
  })

  // ── 场景 7：测试中心 ──
  test('场景 7：测试中心 - 质量保障', async () => {
    await hoverElement('button[aria-label="测试"]')
    await page.click('button[aria-label="测试"]')
    await captureAndWait(2500)

    const checkboxes = page.locator('input[type="checkbox"]')
    const count = await checkboxes.count()
    for (let i = 0; i < Math.min(count, 3); i++) {
      await checkboxes.nth(i).click({ force: true }).catch(() => {})
      await captureAndWait(600)
    }
    await captureAndWait(1500)

    const runBtn = page.locator('button:has-text("运行")')
    if (await runBtn.isVisible().catch(() => false)) {
      await hoverElement('button:has-text("运行")')
      await captureAndWait(1500)
    }

    await closePanel()
    await captureAndWait(800)
  })

  // ── 场景 8：记忆面板 ──
  test('场景 8：长期记忆 - 持续学习', async () => {
    await hoverElement('button[aria-label="记忆"]')
    await page.click('button[aria-label="记忆"]')
    await captureAndWait(2500)

    await closePanel()
    await captureAndWait(800)
  })

  // ── 场景 9：分身选择器 ──
  test('场景 9：分身选择器 - 多专家切换', async () => {
    const avatarBtn = page.locator('button[aria-haspopup="listbox"]').first()
    if (await avatarBtn.isVisible().catch(() => false)) {
      await avatarBtn.hover({ force: true }).catch(() => {})
      await captureAndWait(1000)

      await avatarBtn.click({ force: true }).catch(() => {})
      await captureAndWait(2500)

      await page.click('body', { position: { x: 10, y: 10 }, force: true }).catch(() => {})
      await captureAndWait(1000)
    } else {
      await captureAndWait(2000)
    }
  })

  // ── 场景 10：多会话管理 ──
  test('场景 10：多会话管理', async () => {
    await page.click('button:has-text("NEW CHAT")')
    await captureAndWait(1500)

    const textarea = page.locator('textarea').first()
    if (await textarea.isVisible()) {
      await textarea.click()
      await typeSlowly('广东省最新工商业储能补贴政策是什么？', 60)
      await captureAndWait(2000)
      await textarea.clear()
    }

    await captureAndWait(1500)
  })

  // ── 场景 11：结尾 ──
  test('场景 11：最终展示', async () => {
    const textarea = page.locator('textarea').first()
    if (await textarea.isVisible()) {
      await textarea.click()
      await typeSlowly('小堵 AI 分身系统，随时准备为您服务', 80)
      await captureAndWait(3000)
    }
  })
})
