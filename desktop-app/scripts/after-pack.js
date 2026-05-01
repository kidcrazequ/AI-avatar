/**
 * electron-builder afterPack 钩子
 * - macOS 交叉编译 Windows 时，用 prebuild-install 下载 win32 版 better_sqlite3.node 替换
 * - 清除 macOS quarantine 属性防止 7zip 权限错误
 * @author zhi.qu
 * @date 2026-04-03
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

exports.default = async function afterPack(context) {
  const targetPlatform = context.electronPlatformName // 'win32' | 'darwin' | 'linux'

  // --- 交叉编译：替换 better-sqlite3 原生模块 ---
  if (process.platform === 'darwin' && targetPlatform !== 'darwin') {
    const betterSqliteDir = path.join(
      context.appOutDir,
      'resources/app.asar.unpacked/node_modules/better-sqlite3'
    )
    if (fs.existsSync(betterSqliteDir)) {
      const electronVersion = context.packager.config.electronVersion
        || require(path.join(context.packager.projectDir, 'node_modules/electron/package.json')).version
      console.log(`  • afterPack: 为 ${targetPlatform} 下载 better-sqlite3 prebuild (electron ${electronVersion})`)
      try {
        execSync(
          `npx prebuild-install -r electron -t ${electronVersion} --platform ${targetPlatform} --arch x64`,
          { cwd: betterSqliteDir, stdio: 'inherit' }
        )
        // 验证替换结果
        const nodeFile = path.join(betterSqliteDir, 'build/Release/better_sqlite3.node')
        const fileInfo = execSync(`file "${nodeFile}"`).toString()
        console.log(`  • afterPack: ${fileInfo.trim()}`)
      } catch (e) {
        console.error(`  • afterPack: better-sqlite3 prebuild 下载失败:`, e.message)
        throw e
      }
    }
  }

  // --- macOS quarantine 清理 ---
  if (process.platform === 'darwin') {
    try {
      execSync(`xattr -cr "${context.appOutDir}" 2>/dev/null`, { stdio: 'ignore' })
      execSync(`chmod -R u+rw "${context.appOutDir}" 2>/dev/null`, { stdio: 'ignore' })
    } catch {}
  }
}
