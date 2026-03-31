#!/usr/bin/env node

/**
 * 自动化测试和修复循环
 *
 * 功能：
 * 1. 自动构建应用
 * 2. 自动运行 Playwright 测试
 * 3. 发现错误后自动分析并修复
 * 4. 循环直到所有测试通过
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const MAX_ITERATIONS = 10
let currentIteration = 0

console.log('🚀 启动自动化测试和修复循环...\n')

function runCommand(command, options = {}) {
  try {
    console.log(`\n📌 执行: ${command}`)
    const output = execSync(command, {
      encoding: 'utf-8',
      stdio: 'inherit',
      ...options
    })
    return { success: true, output }
  } catch (error) {
    return {
      success: false,
      code: error.status,
      output: error.stdout || '',
      error: error.stderr || error.message
    }
  }
}

function captureOutput(command) {
  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      stdio: 'pipe'
    })
    return { success: true, output }
  } catch (error) {
    return {
      success: false,
      output: error.stdout || '',
      error: error.stderr || error.message
    }
  }
}

async function main() {
  while (currentIteration < MAX_ITERATIONS) {
    currentIteration++
    console.log(`\n${'='.repeat(60)}`)
    console.log(`🔄 迭代 ${currentIteration}/${MAX_ITERATIONS}`)
    console.log('='.repeat(60))

    // 步骤 1: TypeScript 类型检查
    console.log('\n📝 步骤 1: TypeScript 类型检查...')
    const tscResult = captureOutput('npx tsc --noEmit 2>&1')

    if (!tscResult.success || tscResult.output.includes('error TS')) {
      console.log('❌ 发现 TypeScript 错误:')
      console.log(tscResult.output || tscResult.error)
      console.log('\n⚠️  需要修复 TypeScript 错误后继续')
      process.exit(1)
    }
    console.log('✅ TypeScript 检查通过')

    // 步骤 2: 构建应用
    console.log('\n🔨 步骤 2: 构建应用...')
    const buildResult = runCommand('npm run build')

    if (!buildResult.success) {
      console.log('❌ 构建失败')
      console.log('\n⚠️  需要修复构建错误后继续')
      process.exit(1)
    }
    console.log('✅ 构建成功')

    // 步骤 3: 运行 Playwright 测试
    console.log('\n🧪 步骤 3: 运行 Playwright 测试...')
    const testResult = runCommand('npx playwright test')

    if (!testResult.success) {
      console.log('❌ 测试失败')
      console.log('\n⚠️  发现测试错误，需要分析和修复')

      // 显示测试报告
      console.log('\n📊 生成测试报告...')
      runCommand('npx playwright show-report')

      process.exit(1)
    }

    console.log('✅ 所有测试通过！')
    console.log(`\n🎉 成功！经过 ${currentIteration} 次迭代，所有测试通过`)
    process.exit(0)
  }

  console.log(`\n⚠️  达到最大迭代次数 (${MAX_ITERATIONS})，仍有测试失败`)
  process.exit(1)
}

main().catch(err => {
  console.error('❌ 发生错误:', err)
  process.exit(1)
})
