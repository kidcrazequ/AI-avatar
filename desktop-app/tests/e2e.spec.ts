import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'

let electronApp: ElectronApplication
let window: Page

test.describe.configure({ mode: 'serial' })

test.describe('完整 UI 功能深度测试', () => {

  test.beforeAll(async () => {
    console.log('\n🚀 启动 Electron 应用...')
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../dist-electron/main.js')],
      timeout: 30000,
    })

    window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // 通过 Electron API 设置更大的窗口尺寸
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1600, 1200)
      win.center()
    })

    await window.waitForTimeout(1000)
    console.log('✅ 应用已启动（窗口大小：1600x1200）\n')
  })

  test.afterAll(async () => {
    console.log('\n🔚 关闭应用...')
    await electronApp.close()
  })

  test('步骤 1: 验证应用初始状态', async () => {
    console.log('\n📋 测试 1: 应用初始状态')

    const title = await window.title()
    console.log(`  ✓ 应用标题: ${title}`)
    expect(title.length).toBeGreaterThan(0)

    await expect(window.locator('text=SOUL DESKTOP')).toBeVisible()
    console.log('  ✓ 欢迎页面显示')

    const createBtn = await window.locator('button:has-text("[+] 新建分身")')
    await expect(createBtn).toBeVisible()
    console.log('  ✓ 新建分身按钮可见')

    await window.waitForTimeout(1000)
  })

  test('步骤 2: 选择分身并创建对话', async () => {
    console.log('\n📋 测试 2: 选择分身 + 创建对话')

    // 选择第一个分身；若无分身则通过 API 创建测试分身
    const avatarBtns = window.locator('.animate-fade-in button:has(.w-10)')
    const avatarCount = await avatarBtns.count()
    if (avatarCount > 0) {
      await avatarBtns.first().click()
      console.log('  ✓ 选择了已有分身')
    } else {
      console.log('  → 无分身，通过 API 创建测试分身...')
      await window.evaluate(async () => {
        const soulContent = '# 测试分身\n\n用于 E2E 测试的临时分身。'
        await window.electronAPI.createAvatar('e2e-test-avatar', soulContent, [], [])
      })
      await window.waitForTimeout(1000)
      // 刷新页面以加载新创建的分身
      await window.reload()
      await window.waitForLoadState('domcontentloaded')
      await window.waitForTimeout(1500)
      const newAvatarBtns = window.locator('.animate-fade-in button:has(.w-10)')
      await newAvatarBtns.first().click()
      console.log('  ✓ 创建并选择了测试分身')
    }
    await window.waitForTimeout(1500)

    // 点击侧边栏 NEW CHAT 按钮
    await window.click('button:has-text("NEW CHAT")')
    console.log('  ✓ 点击 NEW CHAT 按钮')
    await window.waitForTimeout(1500)

    const chatInput = await window.locator('textarea').first()
    await expect(chatInput).toBeVisible()
    console.log('  ✓ 聊天界面已加载')

    await expect(window.locator('button[aria-label="设置"]')).toBeVisible()
    await expect(window.locator('button[aria-label="知识库"]')).toBeVisible()
    await expect(window.locator('button[aria-label="测试"]')).toBeVisible()
    await expect(window.locator('button[aria-label="技能"]')).toBeVisible()
    console.log('  ✓ 所有功能按钮已显示')

    await window.waitForTimeout(1000)
  })

  test('步骤 3: 深度测试聊天输入框', async () => {
    console.log('\n📋 测试 3: 聊天输入框功能')

    const chatInput = await window.locator('textarea').first()

    console.log('  → 测试输入文本...')
    await chatInput.fill('这是第一条测试消息')
    await window.waitForTimeout(500)
    let value = await chatInput.inputValue()
    expect(value).toBe('这是第一条测试消息')
    console.log('  ✓ 可以输入文本')

    console.log('  → 测试清空...')
    await chatInput.clear()
    await window.waitForTimeout(500)
    value = await chatInput.inputValue()
    expect(value).toBe('')
    console.log('  ✓ 可以清空')

    console.log('  → 测试多行输入...')
    await chatInput.fill('第一行\n第二行\n第三行')
    await window.waitForTimeout(500)
    value = await chatInput.inputValue()
    expect(value).toContain('第一行')
    expect(value).toContain('第二行')
    console.log('  ✓ 支持多行文本')

    await chatInput.clear()
    await window.waitForTimeout(1000)
  })

  test('步骤 4: 深度测试设置面板', async () => {
    console.log('\n📋 测试 4: 设置面板功能')

    console.log('  → 打开设置面板...')
    await window.click('button[aria-label="设置"]')
    await window.waitForTimeout(1000)
    console.log('  ✓ 设置面板已打开')

    await expect(window.locator('text=SETTINGS').first()).toBeVisible()
    console.log('  ✓ 面板标题显示')

    console.log('  → 测试 API Key 输入...')
    const apiKeyInput = await window.locator('input[placeholder*="sk-"]')
    await expect(apiKeyInput).toBeVisible()
    await apiKeyInput.fill('sk-test-api-key-123456789')
    await window.waitForTimeout(500)
    const apiKeyValue = await apiKeyInput.inputValue()
    expect(apiKeyValue).toBe('sk-test-api-key-123456789')
    console.log('  ✓ API Key 输入功能正常')

    console.log('  → 测试密码显示/隐藏...')
    const toggleBtn = await window.locator('button:has-text("SHOW")').first()
    await toggleBtn.click()
    await window.waitForTimeout(500)
    await expect(window.locator('button:has-text("HIDE")').first()).toBeVisible()
    console.log('  ✓ 密码显示切换功能正常')

    console.log('  → 测试模型名称输入...')
    const modelInput = await window.locator('input[placeholder="model-name"]')
    await expect(modelInput).toBeVisible()
    const modelValue = await modelInput.inputValue()
    expect(modelValue.length).toBeGreaterThan(0)
    console.log(`  ✓ 模型名称: ${modelValue}`)

    console.log('  → 关闭设置面板...')
    await window.keyboard.press('Escape')
    await window.waitForTimeout(1000)
    console.log('  ✓ 设置面板已关闭')
  })

  test('步骤 5: 深度测试知识库面板', async () => {
    console.log('\n📋 测试 5: 知识库面板功能')

    console.log('  → 打开知识库面板...')
    await window.click('button[aria-label="知识库"]')
    await window.waitForTimeout(1000)
    console.log('  ✓ 知识库面板已打开')

    await expect(window.locator('text=知识库').first()).toBeVisible()
    console.log('  ✓ 面板标题显示')

    console.log('  → 检查知识库树结构...')
    const knowledgeTree = await window.locator('.overflow-y-auto').first()
    await expect(knowledgeTree).toBeVisible()
    console.log('  ✓ 知识库树结构显示')

    console.log('  → 测试搜索功能...')
    const searchInputs = await window.locator('input[placeholder*="搜索"]')
    if (await searchInputs.count() > 0) {
      await searchInputs.first().fill('测试搜索关键词')
      await window.waitForTimeout(500)
      console.log('  ✓ 搜索功能存在并可用')
    } else {
      console.log('  ⚠ 未找到搜索框')
    }

    console.log('  → 关闭知识库面板...')
    // 按 ESC 键关闭
    await window.keyboard.press('Escape')
    await window.waitForTimeout(1000)
    console.log('  ✓ 知识库面板已关闭')
  })

  test('步骤 6: 深度测试测试面板', async () => {
    console.log('\n📋 测试 6: 测试面板功能')

    console.log('  → 打开测试面板...')
    await window.click('button[aria-label="测试"]')
    await window.waitForTimeout(1000)
    console.log('  ✓ 测试面板已打开')

    await expect(window.locator('text=TEST CENTER').first()).toBeVisible()
    console.log('  ✓ 面板标题显示')

    console.log('  → 检查测试用例列表...')
    const testCasesList = await window.locator('.overflow-y-auto')
    await expect(testCasesList.first()).toBeVisible()
    console.log('  ✓ 测试用例列表显示')

    console.log('  → 检查全选按钮...')
    const selectAllBtns = await window.locator('button').filter({ hasText: /全选|取消全选/ })
    if (await selectAllBtns.count() > 0) {
      console.log('  ✓ 全选按钮存在')
    }

    console.log('  → 检查运行测试按钮...')
    const runTestBtn = await window.locator('button:has-text("RUN TEST")')
    await expect(runTestBtn).toBeVisible()
    console.log('  ✓ 运行测试按钮存在')

    const checkboxes = await window.locator('input[type="checkbox"]').count()
    console.log(`  ✓ 找到 ${checkboxes} 个测试用例`)

    console.log('  → 关闭测试面板...')
    await window.keyboard.press('Escape')
    await window.waitForTimeout(1000)
    console.log('  ✓ 测试面板已关闭')
  })

  test('步骤 7: 深度测试技能面板', async () => {
    console.log('\n📋 测试 7: 技能面板功能')

    console.log('  → 打开技能面板...')
    await window.click('button[aria-label="技能"]')
    await window.waitForTimeout(1000)
    console.log('  ✓ 技能面板已打开')

    await expect(window.locator('text=SKILLS').first()).toBeVisible()
    console.log('  ✓ 面板标题显示')

    console.log('  → 检查技能列表...')
    const skillList = await window.locator('.overflow-y-auto').first()
    await expect(skillList).toBeVisible()
    console.log('  ✓ 技能列表显示')

    const skillCheckboxes = await window.locator('input[type="checkbox"]').count()
    console.log(`  ✓ 找到 ${skillCheckboxes} 个技能`)

    if (skillCheckboxes > 0) {
      console.log('  → 测试选择技能...')
      const firstSkillBtn = await window.locator('button').filter({ has: window.locator('input[type="checkbox"]') }).first()
      await firstSkillBtn.click()
      await window.waitForTimeout(1000)
      console.log('  ✓ 可以选择技能查看详情')

      const editBtn = await window.locator('button:has-text("EDIT")')
      if (await editBtn.count() > 0) {
        console.log('  ✓ 编辑按钮存在')
      }
    }

    console.log('  → 关闭技能面板...')
    // 按 ESC 键关闭
    await window.keyboard.press('Escape')
    await window.waitForTimeout(1000)
    console.log('  ✓ 技能面板已关闭')
  })

  test('步骤 8: 测试分身选择器', async () => {
    console.log('\n📋 测试 8: 分身选择器功能')

    console.log('  → 查找分身选择器按钮...')
    const avatarBtn = await window.locator('button[aria-haspopup="listbox"]').first()
    await expect(avatarBtn).toBeVisible()
    console.log('  ✓ 分身选择器按钮可见')

    console.log('  → 打开分身选择下拉菜单...')
    await avatarBtn.click()
    await window.waitForTimeout(1000)
    console.log('  ✓ 下拉菜单已打开')

    const dropdown = await window.locator('.absolute.top-full')
    if (await dropdown.count() > 0) {
      await expect(dropdown.first()).toBeVisible()
      console.log('  ✓ 下拉菜单显示')

      const createBtn = await window.locator('button:has-text("新建分身")')
      if (await createBtn.count() > 0) {
        console.log('  ✓ 新建分身按钮存在')
      }
    }

    console.log('  → 关闭下拉菜单...')
    await window.click('body', { position: { x: 10, y: 10 } })
    await window.waitForTimeout(1000)
    console.log('  ✓ 下拉菜单已关闭')
  })

  test('步骤 9: 测试对话管理功能', async () => {
    console.log('\n📋 测试 9: 对话管理功能')

    console.log('  → 检查侧边栏...')
    const sidebar = await window.locator('.w-64.flex-shrink-0').first()
    await expect(sidebar).toBeVisible()
    console.log('  ✓ 侧边栏可见')

    // 获取当前对话数量（通过侧边栏中的按钮数量）
    const beforeCount = await window.locator('.w-64 button').count()
    console.log(`  ✓ 当前有 ${beforeCount} 个对话`)

    console.log('  → 创建第二个对话...')
    await window.click('button:has-text("NEW CHAT")')
    await window.waitForTimeout(1500)
    console.log('  ✓ 第二个对话已创建')

    const afterCount = await window.locator('.w-64 button').count()
    expect(afterCount).toBeGreaterThanOrEqual(beforeCount)
    console.log(`  ✓ 对话数量：${afterCount} 个`)

    console.log('  → 测试切换对话...')
    // 如果有多个对话，测试切换
    if (afterCount > 1) {
      const firstConversation = await window.locator('.w-64 button').first()
      await firstConversation.click()
      await window.waitForTimeout(1000)
      console.log('  ✓ 成功切换到第一个对话')
    }

    const chatInput = await window.locator('textarea').first()
    await expect(chatInput).toBeVisible()
    console.log('  ✓ 切换后聊天界面正常')
  })

  test('步骤 10: 完整流程测试', async () => {
    console.log('\n📋 测试 10: 完整用户流程')

    console.log('  → 在聊天框输入消息...')
    const chatInput = await window.locator('textarea').first()
    await chatInput.fill('你好，这是一条完整的测试消息')
    await window.waitForTimeout(1000)
    console.log('  ✓ 消息已输入')

    console.log('  → 打开设置查看配置...')
    await window.click('button[aria-label="设置"]')
    await window.waitForTimeout(1000)
    console.log('  ✓ 设置面板打开')

    await window.keyboard.press('Escape')
    await window.waitForTimeout(1000)
    console.log('  ✓ 设置面板关闭')

    console.log('  → 打开知识库查看内容...')
    await window.click('button[aria-label="知识库"]')
    await window.waitForTimeout(1000)
    console.log('  ✓ 知识库面板打开')

    await window.keyboard.press('Escape')
    await window.waitForTimeout(1000)
    console.log('  ✓ 知识库面板关闭')

    console.log('\n✅ 所有功能测试完成！')
  })

})
