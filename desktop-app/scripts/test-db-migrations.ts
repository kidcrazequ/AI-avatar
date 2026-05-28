/**
 * 跑 electron/database-*.test.ts —— better-sqlite3 ABI 必须与当前 Node 匹配。
 *
 * 平时 better-sqlite3 是为 Electron rebuild 过的（dist:mac 等命令 +
 * postinstall = electron-builder install-app-deps）。直接用 system Node 跑
 * 测试会因 ABI 不匹配整体 skip（参见 database-fresh-install.test.ts 的
 * skipReason 兜底）。
 *
 * 本脚本三步：
 *   1. npm rebuild better-sqlite3 --build-from-source → Node ABI
 *   2. 跑所有 electron/database-*.test.ts
 *   3. 无论成功失败都 rebuild 回 Electron ABI（postinstall），不污染 dev 环境
 *
 * @author zhi.qu
 * @date 2026-05-28
 */

import { spawnSync, type SpawnSyncReturns } from 'child_process'
import fs from 'fs'
import path from 'path'
import process from 'process'

function run(cmd: string, args: string[], stdio: 'inherit' | 'pipe' = 'inherit'): SpawnSyncReturns<Buffer> {
  console.warn(`\n[test:db-migrations] $ ${cmd} ${args.join(' ')}`)
  return spawnSync(cmd, args, { stdio, shell: process.platform === 'win32' })
}

function ensureCwd(): void {
  // 脚本必须在 desktop-app 根目录下跑（rebuild 操作 node_modules）
  if (!fs.existsSync(path.join(process.cwd(), 'package.json'))) {
    console.error('[test:db-migrations] 请在 desktop-app 根目录下执行')
    process.exit(2)
  }
}

function listDbTestFiles(): string[] {
  const dir = path.join(process.cwd(), 'electron')
  return fs.readdirSync(dir)
    .filter((f) => /^database-.*\.test\.ts$/.test(f))
    .map((f) => path.join('electron', f))
}

ensureCwd()

// Step 1: rebuild for Node ABI
const rebuildNode = run('npm', ['rebuild', 'better-sqlite3', '--build-from-source'])
if (rebuildNode.status !== 0) {
  console.error('[test:db-migrations] rebuild for Node 失败；通常是缺 Python / C++ 工具链')
  process.exit(rebuildNode.status ?? 1)
}

// Step 2: run all DB migration tests
const testFiles = listDbTestFiles()
if (testFiles.length === 0) {
  console.error('[test:db-migrations] 未找到任何 electron/database-*.test.ts')
  process.exit(2)
}
console.warn(`[test:db-migrations] 跑 ${testFiles.length} 个 DB 测试：${testFiles.join(', ')}`)
const testRun = run('npx', ['--yes', 'tsx', '--test', ...testFiles])
const testExitCode = testRun.status ?? 1

// Step 3: 无论测试成败，恢复 Electron ABI；否则 dev/prod 加载 better-sqlite3 会报错
console.warn('\n[test:db-migrations] 恢复 better-sqlite3 到 Electron ABI（postinstall）...')
const restore = run('npm', ['run', 'postinstall', '--silent'])
if (restore.status !== 0) {
  console.error('[test:db-migrations] 恢复 Electron ABI 失败；手动跑 `npm run postinstall` 修复 dev 环境')
  // 测试结果优先返回，但提醒用户
}

process.exit(testExitCode)
