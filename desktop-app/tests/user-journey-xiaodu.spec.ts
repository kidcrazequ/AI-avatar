/**
 * 用户旅程测试：创建小堵分身 + 导入知识文档 + 首次对话
 *
 * 完整场景：
 *   1. 打开桌面端欢迎页
 *   2. 新建分身「小堵-工商储专家」
 *      - 步骤 01：填写分身名称
 *      - 步骤 02：输入人格描述，AI 生成灵魂文档
 *      - 步骤 03：跳过知识库
 *      - 步骤 04：跳过技能定义
 *      - 步骤 05：确认创建
 *   3. 打开知识库面板，导入 ENS-L262-01 用户手册 PDF
 *   4. 回到对话框，输入 Q1 问题
 *   5. 依次点击：技能 / 知识库 / 记忆 / 设置 面板
 *
 * 运行方式：
 *   npm run journey:xiaodu
 *
 * @author zhi.qu
 * @date 2026-04-03
 */
import { test, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { execSync } from 'child_process'

// ── 常量配置 ──────────────────────────────────────────────────────────────────

const FRAMES_DIR = path.join(__dirname, '../test-output/user-journey-xiaodu/frames')
const OUTPUT_VIDEO = path.join(__dirname, '../test-output/user-journey-xiaodu/journey.mp4')
const FPS = 4

/** 待导入的 PDF 文件路径（绕过原生文件选择弹窗直接注入） */
const PDF_PATH = '/Users/cnlm007398/Downloads/ENS-L262-01用户手册 -V1.pdf'

const AVATAR_NAME = '小堵-工商储专家'
const PERSONALITY_DESC = '我想创建一个工商业储能领域的产品解决方案专家，叫小堵，上海人。'
const Q1_TEXT = 'ENS-L262工商储的占地面积和体积'

/**
 * 预设的灵魂文档内容（当 API Key 未配置时作为兜底，
 * 或通过 page.route 拦截 LLM 调用时直接返回此内容）
 */
const FALLBACK_SOUL = `# 小堵 · 工商储专家

## 1. Identity — 我是谁

我是小堵，来自上海的工商业储能产品解决方案专家。我不是工具，也不是搜索引擎，我是你在储能项目中的业务搭档。我服务于储能项目经理、销售工程师和技术团队，帮助他们快速完成方案设计、收益测算和技术答疑。我的知识来源于产品手册、政策文件和真实的项目经验。

## 2. Background — 我的专业背景

- 熟悉工商业储能系统的产品选型（ENS-L262、ENS-L419 等）
- 擅长峰谷套利收益测算与 IRR/回收期分析
- 了解工商业储能相关政策（需量管理、容量电费、补贴机制）
- 经历过：园区储能方案投标、工厂削峰填谷项目、光储一体化方案设计

## 3. Style — 我的说话风格

我说话直接，不绕弯子。上海人的性格，务实、效率优先。
遇到数据问题，我会直接给出表格或公式，不说废话。

**好例子**：「ENS-L262 占地约 1.45m²，适合户外紧凑型部署。」
**坏例子**：「这款产品在占地面积方面表现还是比较优秀的，综合来看还可以。」

## 4. Principles — 我的工作原则

- **知识库优先**：所有参数数据必须来自 knowledge/ 目录，不凭记忆作答
- **数据可溯源**：关键数值标注来源文件名和章节
- **诚实说不知道**：缺乏依据时直接说「手册中未找到该数据」

## 5. Workflow — 我的工作流程

1. 理解用户问题，识别关键参数
2. 检索知识库，找到相关文档片段
3. 基于文档数据直接回答，标注来源
4. 如有计算需求，列出公式和假设条件

## 6. Collaboration — 协作方式

与我合作最高效的方式：给我具体的项目参数（容量、地区、电价），我给你精确的方案和数据。

## 7. Growth — 我如何成长

每次对话后，我会将新的案例经验和用户反馈记录到 memory/MEMORY.md。

## 8. Commitment — 我的承诺

我承诺：所有技术参数来自官方手册，收益测算基于真实电价数据，不编造，不猜测。
`

/**
 * 根据平台返回 Playwright Electron 测试时的 userData 路径。
 * 在 Playwright 测试中直接运行 dist-electron/main.js（不是打包后的 .app），
 * Electron 默认使用「Electron」作为 appName，对应：
 *   macOS: ~/Library/Application Support/Electron
 *   Linux: ~/.config/Electron
 *   Windows: %APPDATA%\Electron
 */
function getTestElectronUserDataPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Electron')
  } else if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'Electron')
  }
  return path.join(os.homedir(), '.config', 'Electron')
}

/**
 * 清理上次测试留下的残留分身目录和数据库中的历史会话（跨平台）。
 * 同时通过 better-sqlite3 直接删除对应分身的 SQLite 会话记录，
 * 避免侧边栏出现多个"新对话"历史记录。
 */
function cleanupLeftoverAvatar(avatarId: string) {
  const userDataPath = getTestElectronUserDataPath()

  // 1. 清理文件系统分身目录
  const avatarDir = path.join(userDataPath, 'avatars', avatarId)
  if (fs.existsSync(avatarDir)) {
    fs.rmSync(avatarDir, { recursive: true })
    console.log(`🧹 清理残留分身目录: ${avatarDir}`)
  }

  // 2. 清理 SQLite 数据库中属于该分身的历史会话（使用系统 sqlite3 CLI，避免 native module 版本冲突）
  const dbPath = path.join(userDataPath, 'xiaodu.db')
  if (fs.existsSync(dbPath)) {
    try {
      execSync(
        `sqlite3 "${dbPath}" "DELETE FROM conversations WHERE avatar_id='${avatarId.replace(/'/g, "''")}'; DELETE FROM messages WHERE conversation_id NOT IN (SELECT id FROM conversations);"`,
        { stdio: 'pipe' },
      )
      console.log(`🧹 清理 SQLite 会话记录完成 (avatar_id=${avatarId})`)
    } catch (e) {
      console.warn('⚠️ 清理 SQLite 会话失败（跳过）:', (e as Error).message.split('\n')[0])
    }
  }
}

/**
 * 将 content 拆分为多个 chunk 模拟流式输出
 */
function buildSseBody(content: string): Buffer {
  const chunks = []
  const size = 50
  for (let i = 0; i < content.length; i += size) {
    const piece = content.slice(i, i + size).replace(/"/g, '\\"').replace(/\n/g, '\\n')
    chunks.push(`data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"${piece}"}}]}\n\n`)
  }
  chunks.push('data: [DONE]\n\n')
  return Buffer.from(chunks.join(''), 'utf-8')
}

// ── 全局状态 ─────────────────────────────────────────────────────────────────

let electronApp: ElectronApplication
let page: Page
let frameIndex = 0

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/** 截取当前页面一帧 */
async function captureFrame() {
  try {
    const framePath = path.join(FRAMES_DIR, `frame_${String(frameIndex).padStart(5, '0')}.png`)
    await page.screenshot({ path: framePath, timeout: 3000 })
    frameIndex++
  } catch {
    // 页面转换期间截图失败，跳过
  }
}

/** 持续截帧 + 等待（替代 waitForTimeout，同时采集视频帧） */
async function captureAndWait(ms: number) {
  const frames = Math.max(1, Math.floor(ms / (1000 / FPS)))
  const interval = ms / frames
  for (let i = 0; i < frames; i++) {
    await captureFrame()
    await page.waitForTimeout(interval)
  }
}

/** 模拟真实用户逐字输入（每两字符截帧一次，呈现打字效果） */
async function typeSlowly(text: string, delayMs = 80) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: delayMs })
    if (frameIndex % 2 === 0) await captureFrame()
  }
}

/** 悬停到元素上，增强视觉引导 */
async function hoverElement(selector: string) {
  const el = page.locator(selector).first()
  if (await el.isVisible().catch(() => false)) {
    await el.scrollIntoViewIfNeeded().catch(() => {})
    await el.hover({ force: true, timeout: 3000 }).catch(() => {})
    await captureAndWait(500)
  }
}

/** 关闭当前打开的面板（点击关闭按钮） */
async function closePanel() {
  const closeBtn = page.locator('button[aria-label="关闭"]').first()
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click({ force: true })
    await captureAndWait(800)
  }
}

/** 使用 ffmpeg 将截图序列合成 mp4 视频 */
function encodeVideo() {
  if (!fs.existsSync(FRAMES_DIR) || frameIndex === 0) return
  const outputDir = path.dirname(OUTPUT_VIDEO)
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

  console.log(`\n🎬 合成视频: ${frameIndex} 帧 @ ${FPS}fps → ${OUTPUT_VIDEO}`)
  try {
    execSync(
      `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame_%05d.png" ` +
      `-vf "scale=1200:800:force_original_aspect_ratio=decrease,pad=1200:800:(ow-iw)/2:(oh-ih)/2:black" ` +
      `-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p "${OUTPUT_VIDEO}"`,
      { stdio: 'inherit' },
    )
    console.log(`✅ 视频已生成: ${OUTPUT_VIDEO}`)
  } catch (e) {
    console.error('❌ ffmpeg 合成失败（ffmpeg 未安装时可忽略）:', (e as Error).message)
  }
}

// ── 测试套件 ─────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' })

test.describe('用户旅程：小堵-工商储专家 从零创建到首次对话', () => {

  test.beforeAll(async () => {
    // ── 清理上次测试残留的分身目录，确保欢迎页是「暂无分身」状态 ────────────
    cleanupLeftoverAvatar('小堵-工商储专家')

    // 清理并重建帧目录
    if (fs.existsSync(FRAMES_DIR)) fs.rmSync(FRAMES_DIR, { recursive: true })
    fs.mkdirSync(FRAMES_DIR, { recursive: true })

    console.log('\n🚀 启动 Electron 应用...')
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../dist-electron/main.js')],
      timeout: 30000,
    })

    // 拦截原生文件选择弹窗 IPC，直接返回预设的 PDF 路径
    await electronApp.evaluate(({ ipcMain }, pdfPath) => {
      try { (ipcMain as any).removeHandler('show-open-dialog') } catch {}
      ipcMain.handle('show-open-dialog', async () => ({
        canceled: false,
        filePaths: [pdfPath],
      }))
    }, PDF_PATH)

    // 拦截 PDF 解析 IPC，返回预设内容（避免渲染 PDF 截图导致超时）
    await electronApp.evaluate(({ ipcMain }) => {
      try { (ipcMain as any).removeHandler('parse-document') } catch {}
      ipcMain.handle('parse-document', async (_: unknown, filePath: string) => {
        const path = require('path') as typeof import('path')
        return {
          text: `# ENS-L262 工商储用户手册\n\n## 产品规格\n\n| 参数 | 数值 |\n|------|------|\n| 占地面积 | 1.45 m² |\n| 外形尺寸（W×D×H）| 1200×700×1700 mm |\n| 柜体体积 | 0.725 m³ |\n| 重量 | 350 kg |\n| 额定容量 | 262 kWh |\n| 额定功率 | 100 kW |\n\n## 电气参数\n\n| 参数 | 数值 |\n|------|------|\n| 系统额定电压 | 768 VDC |\n| 最大充电电流 | 200 A |\n| 最大放电电流 | 200 A |\n| AC 接口电压 | 380 VAC ±15% |\n| 频率 | 50 Hz |\n`,
          images: [],
          fileName: path.basename(filePath),
          fileType: 'pdf',
          perPageChars: [],
          imagePageNumbers: [],
        }
      })
    })

    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // ── 注入假 API Key（让「生成」按钮变为可用状态）──────────────────────────
    await page.evaluate(async () => {
      await window.electronAPI.setSetting('chat_api_key', 'sk-demo-fake-key-for-journey-test')
      await window.electronAPI.setSetting('creation_api_key', 'sk-demo-fake-key-for-journey-test')
      // 触发 App 重新加载模型配置
      window.dispatchEvent(new Event('settings-updated'))
    })
    await page.waitForTimeout(500)

    // ── 拦截所有 /chat/completions 请求，返回预设内容 ────────────────────────
    // 根据请求体中 stream 字段分别返回 SSE（流式）或 JSON（非流式）格式，
    // 非流式格式用于知识库导入时的 llm.complete() 调用。
    await page.route('**/chat/completions', async (route, request) => {
      let isStream = true
      try {
        const reqBody = JSON.parse(request.postData() ?? '{}')
        isStream = reqBody.stream !== false
      } catch { /* 解析失败默认流式 */ }

      if (isStream) {
        const body = buildSseBody(FALLBACK_SOUL)
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
          },
          body,
        })
      } else {
        // 非流式：llm.complete() 调用，需要返回标准 JSON
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'chatcmpl-demo',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: FALLBACK_SOUL }, finish_reason: 'stop' }],
          }),
        })
      }
    })

    // 保持 Electron 默认窗口大小（1200x800），居中显示
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.center()
    })

    await page.waitForTimeout(1500)
    console.log('✅ 应用已启动（1200x800）')
    console.log('📹 开始录制用户旅程...\n')
  })

  test.afterAll(async () => {
    await captureAndWait(3000)
    console.log(`\n📹 录制结束，共 ${frameIndex} 帧`)
    await electronApp.close()
    encodeVideo()
    // 合成后清理帧文件
    if (fs.existsSync(FRAMES_DIR)) fs.rmSync(FRAMES_DIR, { recursive: true })
  })

  // ── 场景 1：应用启动 ─────────────────────────────────────────────────────────

  test('场景 1：应用启动 - 展示欢迎页', async () => {
    console.log('📸 场景 1：欢迎页')
    // 等待欢迎页标志性文字出现
    await page.locator('text=SOUL DESKTOP').waitFor({ state: 'visible', timeout: 10000 })
    await captureAndWait(3000)
  })

  // ── 场景 2：点击新建分身 ─────────────────────────────────────────────────────

  test('场景 2：点击「[+] 新建分身」按钮', async () => {
    console.log('📸 场景 2：点击新建分身')
    await hoverElement('button:has-text("[+] 新建分身")')
    await page.click('button:has-text("[+] 新建分身")')
    // 等待创建向导弹出
    await page.locator('text=创建分身').waitFor({ state: 'visible', timeout: 5000 })
    await captureAndWait(1500)
  })

  // ── 场景 3：步骤 01 - 基本信息 ───────────────────────────────────────────────

  test('场景 3：步骤 01 - 输入分身名称「小堵-工商储专家」', async () => {
    console.log('📸 场景 3：步骤 01 - 基本信息')
    // 等待名称输入框出现
    const nameInput = page.locator('input[placeholder*="小李"]').first()
    await nameInput.waitFor({ state: 'visible', timeout: 5000 })
    await nameInput.click()
    await typeSlowly(AVATAR_NAME, 80)
    await captureAndWait(1500)

    // 下一步
    await hoverElement('button:has-text("下一步")')
    await page.click('button:has-text("下一步")')
    await captureAndWait(1500)
  })

  // ── 场景 4：步骤 02 - 人格定义 ───────────────────────────────────────────────

  test('场景 4：步骤 02 - 输入人格描述并 AI 生成灵魂文档', async () => {
    console.log('📸 场景 4：步骤 02 - 人格定义')
    // 等待人格描述输入框
    const personalityTextarea = page.locator('textarea[placeholder*="光伏"]').first()
    await personalityTextarea.waitFor({ state: 'visible', timeout: 5000 })
    await captureAndWait(800)

    // 逐字输入人格描述
    await personalityTextarea.click()
    await typeSlowly(PERSONALITY_DESC, 70)
    await captureAndWait(1500)

    // 点击「生成」按钮（API Key 已在 beforeAll 注入，按钮应为可用状态）
    const generateBtn = page.locator('button:has-text("生成")').first()
    await hoverElement('button:has-text("生成")')
    await generateBtn.click()
    await captureAndWait(1000)

    // 等待 AI 生成完成（网络已被拦截返回预设内容，通常 5 秒内完成）
    // 出现「生成结果（可编辑）」标签说明 soulContent 已赋值
    console.log('⏳ 等待人格生成...')
    await page.locator('text=生成结果（可编辑）').waitFor({ state: 'visible', timeout: 30000 })
    await captureAndWait(2500)

    // 下一步
    await hoverElement('button:has-text("下一步")')
    await page.click('button:has-text("下一步")')
    await captureAndWait(1500)
  })

  // ── 场景 5：步骤 03 - 跳过知识库 ─────────────────────────────────────────────

  test('场景 5：步骤 03 - 跳过知识库（后续通过导入添加）', async () => {
    console.log('📸 场景 5：步骤 03 - 跳过知识库')
    // 确认当前在知识库步骤
    await page.locator('text=添加知识文件').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    await captureAndWait(2000)

    // 直接跳过
    await hoverElement('button:has-text("下一步")')
    await page.click('button:has-text("下一步")')
    await captureAndWait(1500)
  })

  // ── 场景 6：步骤 04 - 跳过技能定义 ──────────────────────────────────────────

  test('场景 6：步骤 04 - 跳过技能定义', async () => {
    console.log('📸 场景 6：步骤 04 - 跳过技能定义')
    await page.locator('text=用自然语言描述技能').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    await captureAndWait(2000)

    await hoverElement('button:has-text("下一步")')
    await page.click('button:has-text("下一步")')
    await captureAndWait(1500)
  })

  // ── 场景 7：步骤 05 - 确认创建 ──────────────────────────────────────────────

  test('场景 7：步骤 05 - 确认信息并点击创建', async () => {
    console.log('📸 场景 7：步骤 05 - 确认创建')
    await page.locator('text=确认创建').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    await captureAndWait(2500)

    // 点击「创建」按钮
    await hoverElement('button:has-text("创建")')
    await page.click('button:has-text("创建")')
    console.log('⏳ 等待分身创建完成...')

    // 等待分身创建成功，跳转到「分身就绪」页
    await page.locator('text=分身就绪').waitFor({ state: 'visible', timeout: 15000 })
    await captureAndWait(3000)
  })

  // ── 场景 8：打开知识库面板 + 导入 PDF ────────────────────────────────────────

  test('场景 8：点击「[+] NEW CHAT」进入对话页', async () => {
    console.log('📸 场景 8：创建新对话')
    await hoverElement('button:has-text("NEW CHAT")')
    await page.click('button:has-text("NEW CHAT")')
    // 等待聊天界面 + 顶部导航栏出现
    await page.locator('button[aria-label="知识库"]').waitFor({ state: 'visible', timeout: 10000 })
    await captureAndWait(2000)
  })

  test('场景 9：点击「知识库」按钮并导入 ENS-L262 手册 PDF', async () => {
    console.log('📸 场景 9：打开知识库并导入 PDF')
    // 点击顶栏「知识库」导航按钮
    await hoverElement('button[aria-label="知识库"]')
    await page.click('button[aria-label="知识库"]')
    await captureAndWait(2000)

    // 点击「IMPORT」导入按钮，展示导入操作（IPC show-open-dialog 已被拦截）
    const importBtn = page.locator('button[aria-label="导入文档"]').first()
    await importBtn.waitFor({ state: 'visible', timeout: 5000 })
    await hoverElement('button[aria-label="导入文档"]')
    await importBtn.click()
    await captureAndWait(1500)

    // 直接通过 electronAPI 写入知识文件（绕过 parseDocument 耗时的 PDF 截图渲染）
    // 使用 createKnowledgeFile 确保 imports/ 目录自动创建
    console.log('📝 写入 ENS-L262 知识文件...')
    await page.evaluate(async (avatarId) => {
      const lines = [
        '# ENS-L262 工商储用户手册',
        '',
        '> 导入自: ENS-L262-01用户手册 -V1.pdf',
        '',
        '---',
        '',
        '## 产品规格',
        '',
        '| 参数 | 数值 |',
        '|------|------|',
        '| 占地面积 | 1.45 m² |',
        '| 外形尺寸（W×D×H）| 1200×700×1700 mm |',
        '| 柜体体积 | 0.725 m³ |',
        '| 重量 | 350 kg |',
        '| 额定容量 | 262 kWh |',
        '| 额定功率 | 100 kW |',
        '',
        '## 电气参数',
        '',
        '| 参数 | 数值 |',
        '|------|------|',
        '| 系统额定电压 | 768 VDC |',
        '| 最大充电电流 | 200 A |',
        '| 最大放电电流 | 200 A |',
        '| AC 接口电压 | 380 VAC ±15% |',
        '| 频率 | 50 Hz |',
      ]
      await window.electronAPI.createKnowledgeFile(
        avatarId,
        'imports/ENS-L262-01用户手册_-V1.md',
        lines.join('\n'),
      )
    }, AVATAR_NAME)

    // 关闭并重新打开知识库面板，触发文件树刷新（loadTree on mount）
    await closePanel()
    await captureAndWait(800)
    await hoverElement('button[aria-label="知识库"]')
    await page.click('button[aria-label="知识库"]')

    // 等待文件出现在知识树中
    await page.waitForFunction(
      () => document.body.innerText.includes('ENS-L262'),
      undefined,
      { timeout: 10000 },
    )
    console.log('✅ ENS-L262 知识文件已写入并显示在知识树中')
    await captureAndWait(3000)

    // 关闭知识库面板，返回对话界面
    await closePanel()
    await captureAndWait(1500)
  })

  // ── 场景 10：对话框输入 Q1 ────────────────────────────────────────────────────

  test('场景 10：在对话框输入 Q1 问题', async () => {
    console.log('📸 场景 10：输入 Q1')
    const textarea = page.locator('textarea').first()
    await textarea.waitFor({ state: 'visible', timeout: 5000 })
    await textarea.click()
    await captureAndWait(800)

    await typeSlowly(Q1_TEXT, 70)
    await captureAndWait(2500)
  })

  // ── 场景 11-14：依次点击 技能 / 知识库 / 记忆 / 设置 ────────────────────────

  test('场景 11：点击「技能」面板', async () => {
    console.log('📸 场景 11：技能面板')
    await hoverElement('button[aria-label="技能"]')
    await page.click('button[aria-label="技能"]')
    await captureAndWait(2500)
    await closePanel()
    await captureAndWait(1000)
  })

  test('场景 12：点击「知识库」面板', async () => {
    console.log('📸 场景 12：知识库面板')
    await hoverElement('button[aria-label="知识库"]')
    await page.click('button[aria-label="知识库"]')
    await captureAndWait(2500)
    await closePanel()
    await captureAndWait(1000)
  })

  test('场景 13：点击「记忆」面板', async () => {
    console.log('📸 场景 13：记忆面板')
    await hoverElement('button[aria-label="记忆"]')
    await page.click('button[aria-label="记忆"]')
    await captureAndWait(2500)
    await closePanel()
    await captureAndWait(1000)
  })

  test('场景 14：点击「设置」面板', async () => {
    console.log('📸 场景 14：设置面板')
    await hoverElement('button[aria-label="设置"]')
    await page.click('button[aria-label="设置"]')
    await captureAndWait(2500)
    await closePanel()
    await captureAndWait(2000)
  })
})
